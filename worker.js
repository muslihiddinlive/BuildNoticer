// Polls GitHub Actions across the owner's repos and reports finished runs to Telegram.
// Also announces builds that start. /start and /status list the builds running right now.
// Secrets: GITHUB_TOKEN, BOT_TOKEN, CHAT_ID, TRIGGER_KEY. KV binding: STATE.
// Optional variable START_AFTER_MIN: announce a start only once the build has run that long.

const GH = "https://api.github.com";
const TG_LIMIT = 49_000_000; // Bot API uploads are capped at 50 MB
const MAX_FILES = 3;
const HOT_DAYS = 3; // repos pushed this recently are checked on every run
const RESERVE = 18; // subrequests kept for repo pages and notifications
const RUNS_PER_REPO = 5;
const MAX_LISTED = 15;
const REPORT = new Set(["success", "failure", "timed_out", "cancelled", "startup_failure"]);
const LIVE = new Set(["in_progress", "queued", "waiting", "requested", "pending"]);

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
  const r = await fetch(GH + path, { headers: ghHeaders(env) });
  if (!r.ok) throw new Error(`GitHub ${r.status} for ${path.split("?")[0]}`);
  return r.json();
}

async function tg(env, method, body) {
  spend(env);
  const isForm = body instanceof FormData;
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: isForm ? {} : { "content-type": "application/json" },
    body: isForm ? body : JSON.stringify(body),
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
  const limit = env.budget.limit;
  const now = Date.now();
  const stored = JSON.parse((await env.STATE.get("state")) || "null");
  const state = stored || { since: new Date(now).toISOString(), seen: [], active: {} };
  state.active ||= {};
  const since = Date.parse(state.since); // the first run reports nothing older than itself
  const seen = new Set(state.seen);

  const all = await listRepos(env);
  const byName = new Map(all.map((r) => [r.full_name, r]));
  const slots = Math.min(200, Math.max(10, limit - RESERVE));

  // Repos with a known running build are always rechecked, so its end is caught fast.
  const pinned = [...new Set(Object.values(state.active).map((a) => a.repo))]
    .map((name) => byName.get(name))
    .filter(Boolean)
    .slice(0, slots);
  const rest = all.filter((r) => !pinned.includes(r));
  const room = slots - pinned.length;
  const hotCutoff = now - HOT_DAYS * 86400e3;
  const hot = rest.filter((r) => Date.parse(r.pushed_at) > hotCutoff).slice(0, Math.ceil(room / 2));
  const cold = rest.filter((r) => !hot.includes(r));
  const coldCount = Math.min(cold.length, room - hot.length);
  // Cold repos rotate with the clock, so no cursor has to be stored (KV writes are limited).
  const start = cold.length ? (Math.floor(now / 60e3) * coldCount) % cold.length : 0;
  const picked = Array.from({ length: coldCount }, (_, i) => cold[(start + i) % cold.length]);
  const repos = [...pinned, ...hot, ...picked];

  const fresh = [];
  const running = {};
  const checked = new Set();
  await Promise.all(
    repos.map(async (repo) => {
      try {
        const d = await gh(env, `/repos/${repo.full_name}/actions/runs?per_page=${RUNS_PER_REPO}`);
        checked.add(repo.full_name);
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
    return { active: Object.values(active), checked: repos.length, total: all.length };
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
  const changed = sig(state.active) !== sig(active);
  if (!stored || sent.length || changed) {
    state.seen = [...seen].slice(-300);
    state.active = active;
    delete state.cursor;
    await env.STATE.put("state", JSON.stringify(state));
  }
  return {
    total: all.length,
    checked: repos.length,
    running: Object.keys(active).length,
    found: fresh.length,
    sent,
  };
}

function tick(env) {
  return scan(withBudget(env), true);
}

async function onUpdate(env, update) {
  const msg = update?.message;
  // Only the owner's chat gets answers: repo names are private.
  if (!msg?.text || String(msg.chat?.id) !== String(env.CHAT_ID)) return;
  const cmd = msg.text.trim().split(/[\s@]/)[0].toLowerCase();
  if (cmd !== "/start" && cmd !== "/status") return;

  env = withBudget(env);
  try {
    await tg(env, "sendMessage", {
      chat_id: env.CHAT_ID,
      text: cmd === "/start" ? "👋 Salom! Build'larni tekshiryapman..." : "🔍 Tekshiryapman...",
    });
    const { active, checked, total } = await scan(env, false);
    await tg(env, "sendMessage", {
      chat_id: env.CHAT_ID,
      text: statusText(active, checked, total),
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.log(e.message);
    await tg(env, "sendMessage", { chat_id: env.CHAT_ID, text: `⚠️ ${e.message}` }).catch(() => {});
  }
}

function ago(iso) {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 60 ? `${m} daq` : `${Math.floor(m / 60)} soat ${m % 60} daq`;
}

function statusText(active, checked, total) {
  const scope = `(${total} ta repo'dan ${checked} tasi tekshirildi)`;
  if (!active.length) return `😴 Hozir faol build yo'q.\n${scope}`;
  const list = [...active].sort((a, b) => Date.parse(a.started) - Date.parse(b.started));
  const lines = list
    .slice(0, MAX_LISTED)
    .map(
      (a) =>
        `${a.status === "in_progress" ? "🔄" : "⏳"} ${a.repo}\n` +
        `${a.name} #${a.n} · ${a.branch} · ${ago(a.started)}\n${a.url}`,
    );
  const more = list.length > MAX_LISTED ? `\n\n+${list.length - MAX_LISTED} ta yana` : "";
  return `Faol build'lar (${list.length}):\n\n${lines.join("\n\n")}${more}\n\nTugashi bilan xabar beraman.\n${scope}`;
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
