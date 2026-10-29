// Polls GitHub Actions across the owner's repos and reports finished runs to Telegram.
// Also announces builds that start. /start and /status list the builds running right now.
// It also watches Render deploys when RENDER_API_KEY is set (started / live / failed / canceled).
// Secrets: GITHUB_TOKEN, BOT_TOKEN, CHAT_ID, TRIGGER_KEY, RENDER_API_KEY (optional). KV binding: STATE.
// Optional variable RENDER_SERVICES: comma separated Render service names or ids (default: all).
// Optional variable START_AFTER_MIN: announce a start only once the build has run that long.

const GH = "https://api.github.com";
const TG_LIMIT = 49_000_000; // Bot API uploads are capped at 50 MB
const MAX_FILES = 3;
const HOT_DAYS = 3; // repos pushed this recently are checked on every run
const RESERVE = 18; // subrequests a cron run keeps for notifications
const STATUS_RESERVE = 2; // /status only needs the final reply
const MAX_SCAN = 70; // repos per cron run, so GitHub's 5000 requests/hour is never reached
const QUIET_AFTER = 10 * 60e3; // a repo without builds is skipped once its last push is this old
const RUNS_PER_REPO = 5;
const REQ_TIMEOUT = 10_000; // ms: a hanging API call must never freeze the whole run
const STATUS_DEADLINE = 25_000; // ms: /status always answers before Cloudflare cuts the worker (30 s)
const MAX_LISTED = 15;
const REPORT = new Set(["success", "failure", "timed_out", "cancelled", "startup_failure"]);
const LIVE = new Set(["in_progress", "queued", "waiting", "requested", "pending"]);

// The "/" menu in Telegram. Registered once automatically (see ensureCommands); bump the version to re-register.
const CMDS_VERSION = "2";
const COMMANDS = [
  { command: "status", description: "Faol build va deploy'lar" },
  { command: "builds", description: "Faqat GitHub build'lar" },
  { command: "deploys", description: "Render: oxirgi deploy'lar" },
  { command: "logs", description: "Render deploy logi: /logs servis [app]" },
  { command: "help", description: "Buyruqlar ro'yxati" },
  { command: "start", description: "Botni ishga tushirish" },
];
const HELP = [
  "Buyruqlar:",
  ...COMMANDS.filter((c) => c.command !== "start").map((c) => `/${c.command} — ${c.description}`),
  "",
  "/logs mybot — mybot'ning oxirgi deploy build logi",
  "/logs mybot app — shu servisning ish (runtime) logi",
  "",
  "Build yoki deploy tugasa, o'zim xabar yuboraman.",
].join("\n");

const RD = "https://api.render.com/v1";
const RENDER_MAX = 8; // Render services checked per run (each one costs a subrequest)
const SERVICES_TTL = 30 * 60e3; // the service list is cached in KV this long
const R_LIVE = new Set(["created", "build_in_progress", "update_in_progress", "pre_deploy_in_progress"]);
const R_DONE = {
  live: ["✅", "deploy bo'ldi (live)"],
  build_failed: ["❌", "build yiqildi"],
  update_failed: ["❌", "deploy yiqildi (ishga tushmadi)"],
  pre_deploy_failed: ["❌", "pre-deploy yiqildi"],
  canceled: ["🚫", "bekor qilindi"],
};

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const secret = env.TRIGGER_KEY;

    // Telegram webhook: only accepts calls carrying the secret token set in /setup.
    if (request.method === "POST" && url.pathname === "/telegram") {
      if (!secret || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json().catch(() => null);
      ctx.waitUntil(onUpdate(env, update));
      return new Response("ok");
    }

    // ParadoksGram error reports from the apps (see handleReport). Separate from the build watcher below.
    if (request.method === "POST" && url.pathname === "/report") {
      return handleReport(request, env);
    }

    if (!secret || url.searchParams.get("key") !== secret) return new Response("ok");

    // One-time: registers the webhook so the bot can hear /start and /status.
    if (url.pathname === "/setup") {
      const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: `${url.origin}/telegram`,
          secret_token: secret,
          allowed_updates: ["message"],
        }),
      });
      await env.STATE.delete("cmds"); // the next cron run registers the "/" menu again
      return new Response(await r.text(), { headers: { "content-type": "application/json" } });
    }

    return new Response(JSON.stringify(await tick(env)), {
      headers: { "content-type": "application/json" },
    });
  },
};

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "gh-build-notifier",
  };
}

// The free plan allows 50 subrequests per run, so every call is counted.
function withBudget(env) {
  const limit = Number(env.SUBREQUEST_LIMIT) || 48;
  return Object.create(env, { budget: { value: { left: limit, limit } } });
}

function spend(env) {
  if (env.budget.left <= 0) throw new Error("Subrequest budget spent");
  env.budget.left--;
}

async function gh(env, path) {
  spend(env);
  const r = await fetch(GH + path, { headers: ghHeaders(env), signal: AbortSignal.timeout(REQ_TIMEOUT) });
  if (!r.ok) {
    const err = new Error(`GitHub ${r.status} for ${path.split("?")[0]}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

async function tg(env, method, body) {
  spend(env);
  const isForm = body instanceof FormData;
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: isForm ? {} : { "content-type": "application/json" },
    body: isForm ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(isForm ? 60_000 : REQ_TIMEOUT),
  });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || r.status}`);
}

async function listRepos(env) {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const part = await gh(
      env,
      `/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100&page=${page}`,
    );
    all.push(...part);
    if (part.length < 100) break;
  }
  return all.filter((r) => !r.archived);
}

// A re-run keeps the run id but bumps the attempt, so both go into the key.
const runKey = (run) => `${run.id}.${run.run_attempt || 1}`;

// notify=true: cron run, reports finished runs and saves state.
// notify=false: read-only look at what is running (used by /start and /status).
async function scan(env, notify) {
  const now = Date.now();
  const stored = JSON.parse((await env.STATE.get("state")) || "null");
  const state = stored || { since: new Date(now).toISOString(), seen: [], active: {} };
  state.active ||= {};
  state.idle ||= {};
  const since = Date.parse(state.since); // the first run reports nothing older than itself
  const seen = new Set(state.seen);

  const all = await listRepos(env);
  const byName = new Map(all.map((r) => [r.full_name, r]));
  // Repos that never had a build are skipped (until pushed again), so the 50-call budget
  // of the free plan goes to repos that really run builds.
  const quiet = (r) => state.idle[r.full_name] === r.pushed_at && now - Date.parse(r.pushed_at) > QUIET_AFTER;
  const spare = env.budget.left - (notify ? RESERVE : STATUS_RESERVE);
  const slots = Math.max(5, Math.min(notify ? MAX_SCAN : 200, spare));

  // Repos with a known running build are always rechecked, so its end is caught fast.
  const pinned = [...new Set(Object.values(state.active).map((a) => a.repo))]
    .map((name) => byName.get(name))
    .filter(Boolean)
    .slice(0, slots);
  const rest = all.filter((r) => !pinned.includes(r));
  const room = slots - pinned.length;
  const busy = rest.filter((r) => !quiet(r));
  const idle = rest.filter(quiet);
  const hotCutoff = now - HOT_DAYS * 86400e3;
  const hot = busy.filter((r) => Date.parse(r.pushed_at) > hotCutoff).slice(0, Math.ceil(room / 2));
  const coldBusy = busy.filter((r) => !hot.includes(r));
  // What does not fit rotates with the clock, so no cursor has to be stored (KV writes are limited).
  const take = (list, n) => {
    if (n <= 0) return [];
    if (list.length <= n) return list;
    const start = (Math.floor(now / 60e3) * n) % list.length;
    return Array.from({ length: n }, (_, i) => list[(start + i) % list.length]);
  };
  const busyPick = take(coldBusy, room - hot.length);
  const idlePick = take(idle, room - hot.length - busyPick.length);
  const missed = coldBusy.length - busyPick.length; // repos that did not fit this time
  const repos = [...pinned, ...hot, ...busyPick, ...idlePick];

  const idleNow = {};
  for (const [name, pushed] of Object.entries(state.idle)) if (byName.has(name)) idleNow[name] = pushed;

  const fresh = [];
  const running = {};
  const checked = new Set();
  await Promise.all(
    repos.map(async (repo) => {
      try {
        const d = await gh(env, `/repos/${repo.full_name}/actions/runs?per_page=${RUNS_PER_REPO}`);
        checked.add(repo.full_name);
        if (d.total_count === 0) idleNow[repo.full_name] = repo.pushed_at;
        else delete idleNow[repo.full_name];
        for (const run of d.workflow_runs) {
          if (LIVE.has(run.status)) {
            running[run.id] = {
              repo: repo.full_name,
              name: run.name,
              n: run.run_number,
              branch: run.head_branch,
              sha: (run.head_sha || "").slice(0, 7),
              title: (run.head_commit?.message || "").split("\n")[0].slice(0, 100),
              status: run.status,
              url: run.html_url,
              started: run.run_started_at || run.created_at,
            };
          } else if (
            run.status === "completed" &&
            REPORT.has(run.conclusion) &&
            !seen.has(runKey(run)) &&
            Date.parse(run.updated_at) > since
          ) {
            fresh.push({ repo: repo.full_name, run });
          }
        }
      } catch (e) {
        if (e.status === 404) idleNow[repo.full_name] = repo.pushed_at; // no Actions access
        console.log(e.message);
      }
    }),
  );

  // Rechecked repos get fresh data; the others keep what was known (unless it is stale).
  const active = {};
  for (const [id, a] of Object.entries(state.active)) {
    if (!checked.has(a.repo) && byName.has(a.repo) && Date.parse(a.started) > now - 2 * 86400e3) {
      active[id] = a;
    }
  }
  for (const [id, a] of Object.entries(running)) {
    active[id] = { ...a, announced: Boolean(state.active[id]?.announced) };
  }

  if (!notify) {
    return { active: Object.values(active), checked: repos.length, total: all.length, missed };
  }

  fresh.sort((a, b) => Date.parse(a.run.updated_at) - Date.parse(b.run.updated_at));
  const sent = [];
  for (const item of fresh) {
    if (env.budget.left < 6) break; // the rest waits for the next run
    try {
      await notify_(env, item);
      seen.add(runKey(item.run));
      sent.push(`${item.repo}#${item.run.run_number}`);
    } catch (e) {
      console.log(e.message);
    }
  }

  // Builds that have started since the Worker began watching are announced once.
  const minAge = (Number(env.START_AFTER_MIN) || 0) * 60e3;
  for (const a of Object.values(active)) {
    if (a.announced || a.status !== "in_progress") continue;
    if (!(Date.parse(a.started) > since) || now - Date.parse(a.started) < minAge) continue;
    if (env.budget.left < 6) break;
    try {
      await tg(env, "sendMessage", {
        chat_id: env.CHAT_ID,
        text:
          `🚀 ${a.repo}\n${a.name} #${a.n} boshlandi\n${a.branch} · ${a.sha}` +
          (a.title ? `\n${a.title}` : "") +
          `\n${a.url}`,
        disable_web_page_preview: true,
      });
      a.announced = true;
    } catch (e) {
      console.log(e.message);
    }
  }

  // Write only when something changed: the free plan allows 1000 KV writes a day.
  const sig = (o) =>
    Object.entries(o)
      .map(([id, a]) => id + (a.announced ? "!" : ""))
      .sort()
      .join();
  const idleSig = (o) => Object.entries(o).map(([k, v]) => `${k}@${v}`).sort().join();
  const changed = sig(state.active) !== sig(active) || idleSig(state.idle) !== idleSig(idleNow);
  if (!stored || sent.length || changed) {
    state.seen = [...seen].slice(-300);
    state.active = active;
    state.idle = idleNow;
    delete state.cursor;
    await env.STATE.put("state", JSON.stringify(state));
  }
  return {
    total: all.length,
    checked: repos.length,
    missed,
    running: Object.keys(active).length,
    found: fresh.length,
    sent,
  };
}

async function rd(env, path) {
  spend(env);
  const r = await fetch(RD + path, {
    headers: { Authorization: `Bearer ${env.RENDER_API_KEY}`, Accept: "application/json" },
    signal: AbortSignal.timeout(REQ_TIMEOUT),
  });
  if (!r.ok) {
    const err = new Error(`Render ${r.status} for ${path.split("?")[0]}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

async function renderServices(env, rs, now) {
  if (rs.services && now - (rs.servicesAt || 0) < SERVICES_TTL) return rs.services;
  const only = (env.RENDER_SERVICES || "").split(",").map((x) => x.trim()).filter(Boolean);
  const list = await rd(env, "/services?limit=100");
  let services = list
    .map((x) => x.service)
    .filter((x) => x && x.suspended !== "suspended")
    .map((x) => ({ id: x.id, name: x.name, url: x.dashboardUrl || "", owner: x.ownerId || "" }));
  if (only.length) services = services.filter((x) => only.includes(x.id) || only.includes(x.name));
  rs.services = services;
  rs.servicesAt = now;
  rs.dirty = true;
  return services;
}

// Same idea as scan(): notify=true reports finished deploys (cron), notify=false only looks (/status).
// Render state lives under its own KV key, so it never overwrites the GitHub state.
async function renderScan(env, notify) {
  if (!env.RENDER_API_KEY) return { active: [], total: 0, skipped: true };
  const now = Date.now();
  const stored = JSON.parse((await env.STATE.get("render")) || "null");
  const rs = stored || { since: new Date(now).toISOString(), seen: [], active: {}, services: null, servicesAt: 0 };
  rs.active ||= {};
  // /status only reads what the cron run already saved: no Render API calls, so it is instant.
  if (!notify) return { active: Object.values(rs.active), total: rs.services?.length || 0 };
  const since = Date.parse(rs.since); // the first run reports nothing older than itself
  const seen = new Set(rs.seen);

  let services;
  try {
    services = await renderServices(env, rs, now);
  } catch (e) {
    console.log(e.message);
    services = rs.services || [];
  }

  const cap = Math.max(1, Math.min(RENDER_MAX, env.budget.left - (notify ? RESERVE : STATUS_RESERVE) - 4));
  const pinIds = new Set(Object.values(rs.active).map((a) => a.serviceId));
  const pinned = services.filter((x) => pinIds.has(x.id)).slice(0, cap);
  const rest = services.filter((x) => !pinIds.has(x.id));
  const room = cap - pinned.length;
  const start = rest.length ? (Math.floor(now / 60e3) * Math.max(room, 1)) % rest.length : 0;
  const picked = rest.length <= room ? rest : Array.from({ length: room }, (_, i) => rest[(start + i) % rest.length]);
  const targets = [...pinned, ...picked];

  const fresh = [];
  const running = {};
  const checked = new Set();
  await Promise.all(
    targets.map(async (svc) => {
      try {
        const list = await rd(env, `/services/${svc.id}/deploys?limit=3`);
        checked.add(svc.id);
        for (const { deploy: d } of list) {
          if (!d) continue;
          const link = (svc.url ? `${svc.url}/deploys/${d.id}` : "https://dashboard.render.com");
          const info = {
            serviceId: svc.id,
            name: svc.name,
            status: d.status,
            sha: (d.commit?.id || "").slice(0, 7),
            title: (d.commit?.message || "").split("\n")[0].slice(0, 100),
            url: link,
            started: d.createdAt,
          };
          if (R_LIVE.has(d.status)) {
            running[d.id] = info;
          } else if (R_DONE[d.status] && !seen.has(d.id) && Date.parse(d.finishedAt || d.updatedAt) > since) {
            fresh.push({ id: d.id, finished: d.finishedAt || d.updatedAt, ...info });
          }
        }
      } catch (e) {
        console.log(e.message);
      }
    }),
  );

  const active = {};
  const names = new Set(services.map((x) => x.id));
  for (const [id, a] of Object.entries(rs.active)) {
    if (!checked.has(a.serviceId) && names.has(a.serviceId) && Date.parse(a.started) > now - 2 * 86400e3) active[id] = a;
  }
  for (const [id, a] of Object.entries(running)) active[id] = { ...a, announced: Boolean(rs.active[id]?.announced) };

  if (!notify) return { active: Object.values(active), total: services.length };

  fresh.sort((a, b) => Date.parse(a.finished) - Date.parse(b.finished));
  const sent = [];
  for (const d of fresh) {
    if (env.budget.left < 6) break;
    const [icon, label] = R_DONE[d.status];
    try {
      await tg(env, "sendMessage", {
        chat_id: env.CHAT_ID,
        text: `${icon} Render · ${d.name}\n${label}` + (d.sha ? `\n${d.sha}` : "") + (d.title ? ` · ${d.title}` : "") + `\n${d.url}`,
        disable_web_page_preview: true,
      });
      seen.add(d.id);
      sent.push(`${d.name}:${d.id}`);
    } catch (e) {
      console.log(e.message);
    }
  }

  const minAge = (Number(env.START_AFTER_MIN) || 0) * 60e3;
  for (const a of Object.values(active)) {
    if (a.announced || !(Date.parse(a.started) > since) || now - Date.parse(a.started) < minAge) continue;
    if (env.budget.left < 6) break;
    try {
      await tg(env, "sendMessage", {
        chat_id: env.CHAT_ID,
        text: `🚀 Render · ${a.name}\ndeploy boshlandi (${a.status})` + (a.sha ? `\n${a.sha}` : "") + (a.title ? ` · ${a.title}` : "") + `\n${a.url}`,
        disable_web_page_preview: true,
      });
      a.announced = true;
    } catch (e) {
      console.log(e.message);
    }
  }

  const sig = (o) => Object.entries(o).map(([id, a]) => id + (a.announced ? "!" : "")).sort().join();
  if (!stored || sent.length || rs.dirty || sig(rs.active) !== sig(active)) {
    delete rs.dirty;
    rs.seen = [...seen].slice(-300);
    rs.active = active;
    await env.STATE.put("render", JSON.stringify(rs));
  }
  return { total: services.length, checked: targets.length, running: Object.keys(active).length, sent };
}

async function ensureCommands(env) {
  if ((await env.STATE.get("cmds")) === CMDS_VERSION) return;
  const id = /^-?\d+$/.test(String(env.CHAT_ID)) ? Number(env.CHAT_ID) : env.CHAT_ID;
  await tg(env, "setMyCommands", { commands: COMMANDS, scope: { type: "chat", chat_id: id } });
  await env.STATE.put("cmds", CMDS_VERSION);
}

// /deploys: the newest deploy of every Render service, fetched live.
async function renderLatest(env) {
  if (!env.RENDER_API_KEY) return "Render kuzatuvi o'chiq: RENDER_API_KEY secret qo'yilmagan.";
  const rs = JSON.parse((await env.STATE.get("render")) || "null") || {};
  const services = (await renderServices(env, rs, Date.now())).slice(0, RENDER_MAX);
  if (!services.length) return "Render'da servis topilmadi.";
  const rows = await Promise.all(
    services.map(async (svc) => {
      try {
        const d = (await rd(env, `/services/${svc.id}/deploys?limit=1`))[0]?.deploy;
        if (!d) return `• ${svc.name}: hali deploy yo'q`;
        const icon = R_DONE[d.status]?.[0] || (R_LIVE.has(d.status) ? "🔄" : "•");
        const msg = (d.commit?.message || "").split("\n")[0].slice(0, 60);
        return `${icon} ${svc.name} · ${d.status} · ${ago(d.finishedAt || d.createdAt)} oldin${msg ? `\n${msg}` : ""}`;
      } catch (e) {
        return `⚠️ ${svc.name}: ${e.message}`;
      }
    }),
  );
  return `Render, oxirgi deploy'lar:\n\n${rows.join("\n\n")}\n\nLog uchun: /logs servis_nomi`;
}

const LOG_CHARS = 3400; // Telegram messages hold 4096 characters
const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// /logs [servis] [build|app]: build log of the newest deploy (default) or the recent runtime log.
async function renderLogs(env, args) {
  if (!env.RENDER_API_KEY) return { text: "Render kuzatuvi o'chiq: RENDER_API_KEY secret qo'yilmagan." };
  const type = args.some((a) => a.toLowerCase() === "app") ? "app" : "build";
  const name = args.filter((a) => !["app", "build"].includes(a.toLowerCase())).join(" ").toLowerCase();

  const rs = JSON.parse((await env.STATE.get("render")) || "null") || {};
  if (rs.services?.some((x) => !x.owner)) rs.servicesAt = 0; // list saved before owner ids were kept
  const services = await renderServices(env, rs, Date.now());
  const names = services.map((x) => x.name).join(", ");
  if (!services.length) return { text: "Render'da servis topilmadi." };

  let svc;
  if (name) {
    svc = services.find((x) => x.name.toLowerCase() === name || x.id === name) || services.find((x) => x.name.toLowerCase().includes(name));
    if (!svc) return { text: `"${name}" nomli servis topilmadi.\nBor servislar: ${names}` };
  } else if (services.length === 1) {
    svc = services[0];
  } else {
    return { text: `Qaysi servis? Masalan: /logs ${services[0].name}\nBor servislar: ${names}` };
  }

  const d = (await rd(env, `/services/${svc.id}/deploys?limit=1`))[0]?.deploy;
  if (type === "build" && !d) return { text: `${svc.name}: hali deploy yo'q.` };
  let owner = svc.owner;
  if (!owner) owner = (await rd(env, "/owners?limit=1"))[0]?.owner?.id;

  const q = new URLSearchParams({ ownerId: owner, resource: svc.id, type, direction: "backward", limit: "100" });
  if (type === "build") {
    const end = d.finishedAt || d.updatedAt || new Date().toISOString();
    q.set("startTime", new Date(Date.parse(d.createdAt) - 60e3).toISOString());
    q.set("endTime", new Date(Date.parse(end) + 60e3).toISOString());
  }
  const logs = ((await rd(env, `/logs?${q}`)).logs || []).reverse();

  const clean = (m) => String(m).replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
  let lines = logs.map((l) => `${(l.timestamp || "").slice(11, 19)} ${clean(l.message)}`);
  let body = esc(lines.join("\n")); // escape first: the 4096 limit counts the escaped text
  const cut = body.length > LOG_CHARS;
  if (cut) body = body.slice(-LOG_CHARS).replace(/^[^\n]*\n/, ""); // keep the END: that is where errors are

  const status = d ? `${R_DONE[d.status]?.[0] || (R_LIVE.has(d.status) ? "🔄" : "•")} ${d.status} · ${ago(d.finishedAt || d.createdAt)} oldin` : "";
  const head = type === "build" ? `📜 ${svc.name} · build logi\n${status}` : `📜 ${svc.name} · ish logi (oxirgi soat)`;
  const note = cut ? "\n(oxirgi qismi ko'rsatildi)" : "";
  if (!lines.length) return { text: `${head}\n\nBu oraliqda log topilmadi.${type === "build" ? "\nEski deploy loglari Render'da saqlanmagan bo'lishi mumkin." : ""}` };
  return { text: `${esc(head)}${note}\n<pre>${body}</pre>`, html: true };
}

async function tick(env) {
  env = withBudget(env);
  await ensureCommands(env).catch((e) => console.log("commands:", e.message));
  // Render goes first and is capped, so a Render problem never stops the GitHub scan.
  let render;
  try {
    render = await renderScan(env, true);
  } catch (e) {
    console.log(e.message);
    render = { error: e.message };
  }
  const github = await scan(env, true);
  return { ...github, render };
}

async function onUpdate(env, update) {
  const msg = update?.message;
  // Only the owner's chat gets answers: repo names are private.
  if (!msg?.text || String(msg.chat?.id) !== String(env.CHAT_ID)) return;
  const cmd = msg.text.trim().split(/[\s@]/)[0].toLowerCase();
  if (!["/start", "/status", "/builds", "/deploys", "/logs", "/help"].includes(cmd)) return;
  const args = msg.text.trim().split(/\s+/).slice(1);

  env = withBudget(env);
  try {
    if (cmd === "/help") {
      await tg(env, "sendMessage", { chat_id: env.CHAT_ID, text: HELP });
      return;
    }
    await tg(env, "sendMessage", {
      chat_id: env.CHAT_ID,
      text: cmd === "/start" ? "👋 Salom! Build'larni tekshiryapman..." : "🔍 Tekshiryapman...",
    });
    const work = async () => {
      if (cmd === "/logs") {
        const { text, html } = await renderLogs(env, args);
        await tg(env, "sendMessage", { chat_id: env.CHAT_ID, text, ...(html ? { parse_mode: "HTML" } : {}), disable_web_page_preview: true });
        return;
      }
      if (cmd === "/deploys") {
        const text = await renderLatest(env);
        await tg(env, "sendMessage", { chat_id: env.CHAT_ID, text, disable_web_page_preview: true });
        return;
      }
      const onlyBuilds = cmd === "/builds";
      const render = onlyBuilds
        ? { active: [] }
        : await renderScan(env, false).catch((e) => {
            console.log(e.message);
            return { active: [] };
          });
      const { active, total, missed } = await scan(env, false);
      await tg(env, "sendMessage", {
        chat_id: env.CHAT_ID,
        text: statusText(active, total, missed, render.active, onlyBuilds ? "😴 Hozir faol build yo'q." : undefined),
        disable_web_page_preview: true,
      });
    };
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Vaqt tugadi: GitHub javob bermayapti yoki tekshiruv juda uzoq cho'zildi")), STATUS_DEADLINE);
    });
    try {
      await Promise.race([work(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.log(e.message);
    await tg(env, "sendMessage", { chat_id: env.CHAT_ID, text: `⚠️ ${e.message}` }).catch(() => {});
  }
}

function ago(iso) {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 60 ? `${m} daq` : `${Math.floor(m / 60)} soat ${m % 60} daq`;
}

function statusText(active, total, missed, renderActive = [], none = "😴 Hozir faol build va deploy yo'q.") {
  const scope =
    missed === 0
      ? `✅ Hammasi ko'rib chiqildi (${total} ta repo)`
      : `⚠️ ${total} ta repo'dan ${total - missed} tasi ko'rib chiqildi, qolgan ${missed} tasi har daqiqada navbat bilan tekshiriladi`;
  if (!active.length && !renderActive.length) return `${none}\n${scope}`;
  const list = [...active].sort((a, b) => Date.parse(a.started) - Date.parse(b.started));
  const lines = list
    .slice(0, MAX_LISTED)
    .map(
      (a) =>
        `${a.status === "in_progress" ? "🔄" : "⏳"} ${a.repo}\n` +
        `${a.name} #${a.n} · ${a.branch} · ${ago(a.started)}\n${a.url}`,
    );
  const more = list.length > MAX_LISTED ? `\n\n+${list.length - MAX_LISTED} ta yana` : "";
  const parts = [];
  if (list.length) parts.push(`Faol build'lar (${list.length}):\n\n${lines.join("\n\n")}${more}`);
  if (renderActive.length) {
    const rl = renderActive.map(
      (a) => `${a.status === "created" ? "⏳" : "🔄"} Render · ${a.name}\n${a.status} · ${ago(a.started)}\n${a.url}`,
    );
    parts.push(`Render deploy'lar (${rl.length}):\n\n${rl.join("\n\n")}`);
  }
  return `${parts.join("\n\n")}\n\nTugashi bilan xabar beraman.\n${scope}`;
}

async function notify_(env, { repo, run }) {
  const ok = run.conclusion === "success";
  const title = (run.head_commit?.message || "").split("\n")[0].slice(0, 100);
  const text =
    `${ok ? "✅" : run.conclusion === "cancelled" ? "🚫" : "❌"} ${repo}\n` +
    `${run.name} #${run.run_number}: ${run.conclusion}\n` +
    `${run.head_branch} · ${run.head_sha.slice(0, 7)}` +
    (title ? `\n${title}` : "") +
    `\n${run.html_url}`;

  if (ok) {
    try {
      if (await sendArtifacts(env, repo, run, text)) return;
    } catch (e) {
      console.log(e.message);
    }
  }
  await tg(env, "sendMessage", {
    chat_id: env.CHAT_ID,
    text,
    disable_web_page_preview: true,
  });
}

async function sendArtifacts(env, repo, run, caption) {
  const { artifacts } = await gh(env, `/repos/${repo}/actions/runs/${run.id}/artifacts`);
  const live = artifacts.filter((a) => !a.expired);
  const fit = live.filter((a) => a.size_in_bytes < TG_LIMIT).slice(0, MAX_FILES);
  if (!fit.length) return false;
  const skipped = live.length - fit.length;

  for (const [i, a] of fit.entries()) {
    const file = await download(env, a.archive_download_url);
    const form = new FormData();
    form.set("chat_id", env.CHAT_ID);
    form.set(
      "caption",
      i === 0
        ? caption + (skipped ? `\n(+${skipped} ta katta fayl: ${run.html_url}#artifacts)` : "")
        : a.name,
    );
    form.set("document", file, `${a.name}.zip`);
    await tg(env, "sendDocument", form);
  }
  return true;
}

// The signed blob URL must be fetched without the GitHub token.
async function download(env, url) {
  spend(env);
  const r1 = await fetch(url, { headers: ghHeaders(env), redirect: "manual" });
  const location = r1.headers.get("location");
  if (!location) throw new Error(`Artifact redirect missing (${r1.status})`);
  spend(env);
  const r2 = await fetch(location);
  if (!r2.ok) throw new Error(`Artifact download ${r2.status}`);
  return r2.blob();
}

// ---------------------------------------------------------------------------------------------
// Error reports sent by the ParadoksGram apps (Android / Windows): POST /report, multipart/form-data
//   name, contact, message  - short text fields shown in the Telegram message
//   user                    - account data the user agreed to send (id, username, phone), optional
//   files                   - the log file
// Optional secret REPORT_KEY: when set, requests must carry the header X-Report-Key.
// The Telegram message goes to CHAT_ID. Each IP may send REPORT_PER_HOUR (default 6) reports per hour.
// This route uses neither GITHUB_TOKEN nor the build watcher state.
// ---------------------------------------------------------------------------------------------
const REPORT_MAX_BYTES = 1_500_000;
const REPORT_PER_HOUR = 6;

const reportEsc = (t = "") => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function reportJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function reportTg(env, method, form) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await r.json().catch(() => ({}));
  return r.ok && data.ok === true;
}

async function handleReport(request, env) {
  try {
    if (!env.BOT_TOKEN || !env.CHAT_ID) return reportJson({ ok: false, error: "not configured" }, 500);
    if (env.REPORT_KEY && request.headers.get("X-Report-Key") !== env.REPORT_KEY) {
      return reportJson({ ok: false, error: "forbidden" }, 403);
    }
    const len = Number(request.headers.get("content-length") || 0);
    if (len > REPORT_MAX_BYTES) return reportJson({ ok: false, error: "too large" }, 413);

    // Rate limit per IP, kept in KV for an hour. A KV hiccup must never block a report.
    const ip = request.headers.get("CF-Connecting-IP") || "-";
    const limit = Number(env.REPORT_PER_HOUR) || REPORT_PER_HOUR;
    if (env.STATE && ip !== "-") {
      const key = `rl:${ip}:${Math.floor(Date.now() / 3_600_000)}`;
      try {
        const used = Number(await env.STATE.get(key)) || 0;
        if (used >= limit) return reportJson({ ok: false, error: "rate limit" }, 429);
        await env.STATE.put(key, String(used + 1), { expirationTtl: 3700 });
      } catch {}
    }

    let form;
    try {
      form = await request.formData();
    } catch {
      return reportJson({ ok: false, error: "multipart/form-data expected" }, 400);
    }
    const field = (n, max) => (form.get(n) || "").toString().trim().slice(0, max);
    const name = field("name", 100);
    const contact = field("contact", 150);
    const message = field("message", 2600);
    const user = field("user", 500);
    const file = form.getAll("files").find((f) => f && typeof f === "object" && f.size > 0);
    if (!message && !file) return reportJson({ ok: false, error: "empty" }, 400);

    const cf = request.cf || {};
    const place = [cf.city, cf.region, cf.country || request.headers.get("CF-IPCountry")].filter(Boolean).join(", ") || "-";
    const isp = cf.asOrganization ? `${cf.asOrganization}${cf.asn ? ` (AS${cf.asn})` : ""}` : "-";

    const text =
      `🛠 <b>Xato hisoboti</b> — ${reportEsc(name) || "ParadoksGram"}\n` +
      `🕒 ${reportEsc(contact) || "-"}\n` +
      `🌍 Server ko'rgan joy: ${reportEsc(place)}\n` +
      `📡 Provayder: ${reportEsc(isp)}\n` +
      (user ? `\n👤 <b>Akkaunt (foydalanuvchi ruxsati bilan):</b>\n${reportEsc(user)}\n` : "") +
      (message ? `\n<pre>${reportEsc(message)}</pre>` : "");

    const fd = new FormData();
    fd.append("chat_id", env.CHAT_ID);
    fd.append("text", text.slice(0, 4000));
    fd.append("parse_mode", "HTML");
    fd.append("disable_web_page_preview", "true");
    if (!(await reportTg(env, "sendMessage", fd))) return reportJson({ ok: false, error: "telegram" }, 502);

    if (file) {
      const doc = new FormData();
      doc.append("chat_id", env.CHAT_ID);
      doc.append("document", file, file.name || "log.txt");
      doc.append("caption", `📎 ${file.name || "log.txt"}`.slice(0, 200));
      if (!(await reportTg(env, "sendDocument", doc))) return reportJson({ ok: false, error: "telegram file" }, 502);
    }
    return reportJson({ ok: true });
  } catch {
    return reportJson({ ok: false, error: "server" }, 500);
  }
}
