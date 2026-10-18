// Polls GitHub Actions across the owner's repos and reports finished runs to Telegram.
// Secrets: GITHUB_TOKEN, BOT_TOKEN, CHAT_ID. KV binding: STATE. Optional secret: TRIGGER_KEY.

const GH = "https://api.github.com";
const TG_LIMIT = 49_000_000; // Bot API uploads are capped at 50 MB
const MAX_FILES = 3;
const HOT_DAYS = 3; // repos pushed this recently are checked on every run
const RESERVE = 18; // subrequests kept for repo pages and notifications
const REPORT = new Set(["success", "failure", "timed_out"]);

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },

  async fetch(request, env) {
    const key = new URL(request.url).searchParams.get("key");
    if (!env.TRIGGER_KEY || key !== env.TRIGGER_KEY) return new Response("ok");
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

async function tick(env) {
  const limit = Number(env.SUBREQUEST_LIMIT) || 48;
  env = Object.create(env, { budget: { value: { left: limit } } });
  const state = JSON.parse((await env.STATE.get("state")) || "null") || {
    since: new Date().toISOString(), // the first run reports nothing older than itself
    seen: [],
  };
  const since = Date.parse(state.since);
  const seen = new Set(state.seen);

  const all = await listRepos(env);
  const slots = Math.min(200, Math.max(10, limit - RESERVE));
  const hotCutoff = Date.now() - HOT_DAYS * 86400e3;
  const hot = all.filter((r) => Date.parse(r.pushed_at) > hotCutoff).slice(0, Math.ceil(slots / 2));
  const cold = all.filter((r) => !hot.includes(r));
  // Cold repos are visited in rotation so every repo is covered over time.
  const coldCount = Math.min(cold.length, Math.floor(slots / 2) + (Math.ceil(slots / 2) - hot.length));
  const start = cold.length ? (state.cursor || 0) % cold.length : 0;
  const picked = Array.from({ length: coldCount }, (_, i) => cold[(start + i) % cold.length]);
  state.cursor = cold.length ? (start + coldCount) % cold.length : 0;
  const repos = [...hot, ...picked];

  const fresh = [];
  await Promise.all(
    repos.map(async (repo) => {
      try {
        const d = await gh(env, `/repos/${repo.full_name}/actions/runs?status=completed&per_page=10`);
        for (const run of d.workflow_runs) {
          if (
            REPORT.has(run.conclusion) &&
            !seen.has(run.id) &&
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

  fresh.sort((a, b) => Date.parse(a.run.updated_at) - Date.parse(b.run.updated_at));
  const sent = [];
  for (const item of fresh) {
    if (env.budget.left < 6) break; // the rest waits for the next run
    try {
      await notify(env, item);
      seen.add(item.run.id);
      sent.push(`${item.repo}#${item.run.run_number}`);
    } catch (e) {
      console.log(e.message);
    }
  }

  state.seen = [...seen].slice(-300);
  await env.STATE.put("state", JSON.stringify(state));
  return { total: all.length, checked: repos.length, found: fresh.length, sent };
}

async function notify(env, { repo, run }) {
  const ok = run.conclusion === "success";
  const title = (run.head_commit?.message || "").split("\n")[0].slice(0, 100);
  const text =
    `${ok ? "✅" : "❌"} ${repo}\n` +
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
