#!/usr/bin/env node
// Bridge Ordna -> Herdr -> Claude Code. No external dependencies.
import { spawnSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = join(ROOT, "projects.json");
const LOCKS = join(ROOT, ".ordna", "run");
const CORE = process.env.ORDNA_CORE ||
  join(process.env.APPDATA ?? "", "npm/node_modules/@frehilm/ordna-cli/node_modules/@frehilm/ordna-core/dist/index.js");
// Task repository: env ORDNA_TASKS_ROOT, else "tasksRoot" in projects.json, else this repo (single-repo mode).
const TASKS_ROOT = resolve(process.env.ORDNA_TASKS_ROOT || (existsSync(REGISTRY) && JSON.parse(readFileSync(REGISTRY, "utf8")).tasksRoot) || ROOT);
const core = await import(pathToFileURL(CORE).href);
const ctx = core.createContext(TASKS_ROOT);
const STATES = { review: "review", blocked: "blocked", "in-progress": "in-progress" };

// ---------- helpers ----------
const fail = (m) => { throw new Error(m); };
const today = () => new Date().toISOString().slice(0, 10);
const stamp = () => new Date().toISOString().slice(0, 16) + "Z";

function exec(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  return r;
}
// herdr: JSON on stdout (ok) or stderr (error). Returns .result or throws.
function herdr(...args) {
  const r = exec("herdr", args);
  let j; try { j = JSON.parse(r.stdout || r.stderr); } catch { /* not json */ }
  if (r.status !== 0 || j?.error) fail(`herdr ${args.slice(0, 2).join(" ")}: ${j?.error?.message ?? (r.stderr || r.stdout).trim()}`);
  return j?.result ?? {};
}
const herdrTry = (...a) => { try { return herdr(...a); } catch { return null; } };
// Repos inside WSL (\\wsl.localhost\<distro>\...): Windows git.exe rejects them (dubious ownership), so use WSL's git.
const wslOf = (p) => { const m = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(.*)$/i.exec(p); return m && { distro: m[1], linux: m[2].replace(/\\/g, "/") || "/" }; };
const git = (cwd, ...a) => {
  const w = wslOf(cwd);
  return w ? exec("wsl.exe", ["-d", w.distro, "-e", "git", "-C", w.linux, ...a]) : exec("git", ["-C", cwd, ...a]);
};
const isRepo = (p) => existsSync(p) && git(p, "rev-parse", "--git-dir").status === 0;

const loadRegistry = () => existsSync(REGISTRY) ? JSON.parse(readFileSync(REGISTRY, "utf8")) : { projects: {} };
function project(id) {
  const p = loadRegistry().projects?.[id] ?? fail(`project '${id}' is not registered (projects.json)`);
  return { name: id, agent: "claude", isolation: "worktree", instructions: "", agentArgs: [], trustRepository: false, ...p, id };
}

const agentName = (id) => `ordna-${id.toLowerCase()}`;
const agentOf = (name) => herdrTry("agent", "get", name)?.agent ?? null;

async function loadTask(id) {
  return (await core.getTask(id, ctx)) ?? fail(`task '${id}' not found`);
}
function taskProject(t) {
  const hits = t.tags.filter((x) => loadRegistry().projects?.[x]);
  if (hits.length !== 1) fail(`task ${t.id}: exactly one registered project tag is required (found: ${hits.join(",") || "none"})`);
  return project(hits[0]);
}

// Updates status / metadata / Progress and rewrites the task file (never auto-commits).
async function patch(id, { status, assignee, meta, log }) {
  const t = await loadTask(id);
  if (status) t.status = status;
  if (assignee !== undefined) t.assignee = assignee;
  Object.assign(t.extra_frontmatter, meta ?? {});
  if (log) {
    const heading = ctx.config.schema === "backlog" ? "Implementation Notes" : "Progress";
    let s = t.sections.find((x) => x.heading === heading);
    if (!s) t.sections.push((s = { heading, level: 2, content: "" }));
    s.content = `${s.content.trimEnd()}\n- ${stamp()} ${log}`.trimStart() + "\n";
  }
  t.updated_at = today();
  writeFileSync(t.filePath, core.serializeTask(t, ctx.config.schema));
  return t;
}

function lock(id) {
  mkdirSync(LOCKS, { recursive: true });
  const f = join(LOCKS, `${id}.lock`);
  try { writeFileSync(f, String(process.pid), { flag: "wx" }); }
  catch { fail(`task ${id}: a start is already in progress (lock ${f})`); }
  return () => { try { unlinkSync(f); } catch { /* already removed */ } };
}

const headOf = (dir, ref = "HEAD") => { const r = git(dir, "rev-parse", "--short", ref); return r.status === 0 ? r.stdout.trim() : null; };

const PROMPT_MARKER = "has been assigned to you";
// Plan mode: tag 'plan' on the task (editable in the Ordna UI) or --plan/--normal on 'start'. Stored as mode in the task frontmatter.
const PLAN_TAG = "plan";
const PLAN_ARGS = ["--permission-mode", "plan"];
function buildPrompt(t, p, root) {
  const cli = `node "${join(ROOT, "bin", "ordna-herdr.mjs")}"`;
  // Task content only: no frontmatter, no Progress log.
  const body = t.sections.filter((x) => !/^(Progress|Implementation Notes)$/.test(x.heading))
    .map((x) => `${"#".repeat(x.level)} ${x.heading}\n${x.content.trim()}`).join("\n\n");
  return [
    `Ordna task ${t.id} of project "${p.name}" ${PROMPT_MARKER}. Work ONLY in this directory (${root}).`,
    p.instructions && `Project instructions:\n${p.instructions}`,
    `--- TASK ---\n# ${t.id} ${t.title}\n\n${body}\n--- END TASK ---`,
    t.extra_frontmatter?.mode === "plan" && `Plan mode: do not edit files. Present a plan and wait for the user's approval before implementing.`,
    `Rules: no push, merge or deletion; do not touch other repositories; no credentials in files or logs. Commit only on the current branch.`,
    `When you are done AND have verified your work, run:\n  ${cli} report ${t.id} review --note "<short summary>"`,
    `If you need information or are blocked, run:\n  ${cli} report ${t.id} blocked --note "<what you need>"`,
    `Never move the task to done: the user approves it.`,
  ].filter(Boolean).join("\n\n");
}

// safe.directory: only the exact path of a worktree created by the bridge, and only with trustWorktrees:true on the project.
// Same format as existing entries: %(prefix)/ + //wsl.localhost/...
const WT_ENTRY = /\.worktrees\/[^/]+$/;
const safeDirs = () => exec("git", ["config", "--global", "--get-all", "safe.directory"]).stdout.split(/\r?\n/).filter(Boolean);
function trustWorktree(p, path) {
  const val = `%(prefix)/${path}`;
  if (safeDirs().includes(val)) return;
  if (!p.trustWorktrees) return console.error(`note: Windows git does not trust ${path} (the agent will not be able to use git). To allow it:\n  git config --global --add safe.directory '${val}'\nor set "trustWorktrees": true on the project.`);
  const r = exec("git", ["config", "--global", "--add", "safe.directory", val]);
  if (r.status !== 0) fail(`safe.directory: ${r.stderr.trim()}`);
}

// Removes from safe.directory ONLY the *.worktrees/<id> entries (created by the bridge) whose worktree no longer exists.
function cmdGc() {
  let n = 0;
  for (const val of safeDirs().filter((v) => WT_ENTRY.test(v))) {
    if (existsSync(val.replace(/^%\(prefix\)\//, ""))) continue;
    exec("git", ["config", "--global", "--fixed-value", "--unset", "safe.directory", val]);
    console.log(`removed entry: ${val}`); n++;
  }
  console.log(n ? `${n} entries removed` : "no orphaned entries");
}

// Opens the workspace/pane for a run. Returns { workspace, pane, path, branch }.
function openWorkspace(p, t, { reopenPath } = {}) {
  const label = `${t.id} ${p.name}`;
  const trust = p.trustRepository ? ["--trust-repository"] : [];
  const w = wslOf(p.path);
  if (w) { // WSL repo: Herdr would use git.exe (rejected). Create the worktree with WSL git, Herdr only opens the workspace.
    let path = reopenPath, branch = `ordna/${t.id}`;
    if (!path) {
      if (p.isolation !== "worktree") fail("WSL repos support only isolation=worktree");
      const wt = `${w.linux.replace(/\/$/, "")}.worktrees/${t.id}`; // next to the repo, outside its tree
      const r = git(p.path, "worktree", "add", "-b", branch, wt, p.baseRef ?? "HEAD");
      if (r.status !== 0) fail(`git worktree add (WSL): ${(r.stderr || r.stdout).trim()}`);
      path = `//wsl.localhost/${w.distro}${wt}`;
    } else branch = git(path, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim() || branch;
    trustWorktree(p, path);
    const r = herdr("workspace", "create", "--cwd", path, "--label", label, "--no-focus");
    return { workspace: r.workspace.workspace_id, pane: r.root_pane.pane_id, path, branch };
  }
  if (reopenPath) {
    // With Herdr layouts the root pane of a reopened workspace may not be a shell: split a new one.
    const r = herdr("worktree", "open", "--cwd", p.path, "--path", reopenPath, "--label", label, "--no-focus", ...trust);
    const sh = herdr("pane", "split", r.root_pane.pane_id, "--direction", "down", "--cwd", reopenPath, "--no-focus");
    return { workspace: r.workspace.workspace_id, pane: sh.pane.pane_id, path: reopenPath, branch: r.worktree?.branch };
  }
  if (p.isolation === "worktree") {
    const r = herdr("worktree", "create", "--cwd", p.path, "--branch", `ordna/${t.id}`, "--base", p.baseRef ?? "HEAD", "--label", label, "--no-focus", ...trust);
    return { workspace: r.workspace.workspace_id, pane: r.root_pane.pane_id, path: r.worktree.path, branch: r.worktree.branch };
  }
  if (git(p.path, "status", "--porcelain").stdout.trim())
    fail(`repository ${p.path} has local changes: isolation=none refused (use worktree or clean it up)`);
  const r = herdr("workspace", "create", "--cwd", p.path, "--label", label, "--no-focus");
  return { workspace: r.workspace.workspace_id, pane: r.root_pane.pane_id, path: p.path, branch: git(p.path, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim() };
}

// A freshly created pane may not have its shell ready yet: retry for ~15s.
async function startAgent(name, p, pane, claudeArgs) {
  for (let i = 0; ; i++) {
    try { return herdr("agent", "start", name, "--kind", p.agent, "--pane", pane, "--", ...claudeArgs, ...p.agentArgs); }
    catch (e) {
      if (i >= 7 || !/not an available shell/.test(e.message)) throw e;
      await new Promise((ok) => setTimeout(ok, 2000));
    }
  }
}

// ---------- commands ----------
async function cmdStart(id, { plan } = {}) {
  const t = await loadTask(id);
  plan ??= (t.tags ?? []).includes(PLAN_TAG);
  const p = taskProject(t);
  if (!isRepo(p.path)) fail(`repository missing or not a git repo: ${p.path}`);
  const name = agentName(id);
  if (agentOf(name)) fail(`task ${id}: agent '${name}' is already running (use 'show' or 'resume')`);
  if (t.status === "done") fail(`task ${id} is already done`);
  const unlock = lock(id);
  try {
    const session = randomUUID();
    let ws;
    try {
      ws = openWorkspace(p, t);
      await startAgent(name, p, ws.pane, ["--session-id", session, ...(plan ? PLAN_ARGS : [])]);
    } catch (e) {
      // Startup dialog (e.g. folder trust): the agent stays alive, the prompt is sent by 'resume' after manual approval.
      const waiting = ws && /blocked during startup/.test(e.message);
      const msg = waiting ? `agent waiting for input in pane ${ws.pane} (startup dialog): approve it, then run 'ordna-herdr resume ${id}'` : `start failed: ${e.message}`;
      await patch(id, { status: "blocked", meta: { project: p.id, result: msg, ...(ws && { herdr_workspace: ws.workspace, herdr_pane: ws.pane, worktree: ws.path, branch: ws.branch }), ...(waiting && { herdr_agent: name, claude_session: session, mode: plan ? "plan" : "normal", prompt_sent: false }) }, log: msg });
      throw new Error(msg);
    }
    await patch(id, {
      status: "in-progress", assignee: "claude",
      meta: { project: p.id, herdr_agent: name, herdr_workspace: ws.workspace, herdr_pane: ws.pane, branch: ws.branch, worktree: ws.path, claude_session: session, mode: plan ? "plan" : "normal", commit: headOf(ws.path), run_started_at: new Date().toISOString(), result: null, prompt_sent: false },
      log: `started in ${name}${plan ? " (plan mode)" : ""} (workspace ${ws.workspace}, branch ${ws.branch})`,
    });
    await deliverPrompt(id, p, name, ws.path);
    console.log(`${id} -> ${name} (${ws.workspace}/${ws.pane}) branch ${ws.branch}`);
  } finally { unlock(); }
}

async function deliverPrompt(id, p, name, path) {
  try {
    // Right after startup Claude's TUI may drop the paste or lose the Enter: verify the agent really starts working.
    const text = buildPrompt(await loadTask(id), p, path);
    const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const started = () => ["working", "done"].includes(agentOf(name)?.agent_status);
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) {
      await sleep(3000);
      herdr("agent", "prompt", name, text);
      await sleep(4000);
      ok = started();
      if (!ok && JSON.stringify(herdr("agent", "read", name, "--source", "recent-unwrapped", "--lines", "60")).match(new RegExp(`Pasted text|${PROMPT_MARKER}`))) {
        herdr("agent", "send-keys", name, "enter"); // text is there but was not submitted
        await sleep(3000);
        ok = started();
      }
    }
    if (!ok) fail("prompt not picked up by the agent after 3 attempts");
    await patch(id, { status: "in-progress", meta: { prompt_sent: true, result: null, commit: headOf(path) }, log: "prompt sent" });
  } catch (e) {
    await patch(id, { status: "blocked", meta: { result: `prompt failed: ${e.message}` }, log: `prompt failed: ${e.message}` });
    throw e;
  }
}

async function cmdResume(id) {
  const t = await loadTask(id);
  const m = t.extra_frontmatter;
  const name = m.herdr_agent ?? fail(`task ${id}: no run recorded`);
  const live = agentOf(name);
  if (live && m.prompt_sent === false) {
    if (live.agent_status === "blocked") fail(`agent '${name}' is still waiting for input in pane ${live.pane_id}: approve the dialog, then retry`);
    herdr("agent", "wait", name, "--timeout", "60000");
    await deliverPrompt(id, taskProject(t), name, m.worktree);
    return console.log(`${id}: prompt delivered to ${name}`);
  }
  if (live) { herdr("agent", "focus", name); return console.log(`${id}: agent already running (${live.agent_status}), focused ${name}`); }
  const p = taskProject(t);
  const unlock = lock(id);
  try {
    let ws = { workspace: m.herdr_workspace, pane: m.herdr_pane && herdrTry("pane", "get", m.herdr_pane) ? m.herdr_pane : null };
    if (!ws.pane) {
      if (!m.worktree || !existsSync(m.worktree)) fail(`task ${id}: worktree/pane no longer available (${m.worktree ?? "n/a"})`);
      ws = openWorkspace(p, t, { reopenPath: m.worktree });
    }
    await startAgent(name, p, ws.pane, ["--resume", m.claude_session, ...(m.mode === "plan" ? PLAN_ARGS : [])]);
    await patch(id, { status: "in-progress", meta: { herdr_workspace: ws.workspace, herdr_pane: ws.pane }, log: `resumed (claude session ${m.claude_session})` });
    console.log(`${id}: resumed in ${name}`);
  } finally { unlock(); }
}

async function cmdStop(id) {
  const m = (await loadTask(id)).extra_frontmatter;
  const name = m.herdr_agent ?? fail(`task ${id}: no run recorded`);
  if (!agentOf(name)) fail(`agent '${name}' is not running`);
  herdr("agent", "send-keys", name, "esc");
  await patch(id, { status: "blocked", meta: { result: "interrupted by user" }, log: "interrupted by user (esc sent)" });
  console.log(`${id}: interrupt sent to ${name}`);
}

async function cmdReport(id, state, flags) {
  const status = STATES[state] ?? fail(`invalid state '${state}' (review|blocked|in-progress)`);
  const m = (await loadTask(id)).extra_frontmatter;
  const dir = m.worktree && existsSync(m.worktree) ? m.worktree : null;
  const meta = { ...(flags.note && { result: flags.note }), ...(flags.pr && { pr: flags.pr }), ...(dir && { commit: headOf(dir) }) };
  await patch(id, { status, meta, log: `report ${state}${flags.note ? `: ${flags.note}` : ""}` });
  console.log(`${id} -> ${status}`);
}

async function cmdStatus(id) {
  const tasks = id ? [await loadTask(id)] : (await core.listTasks(ctx)).filter((t) => t.extra_frontmatter.herdr_agent);
  if (!tasks.length) return console.log("no runs recorded");
  for (const t of tasks) {
    const m = t.extra_frontmatter;
    const live = m.herdr_agent ? agentOf(m.herdr_agent) : null;
    console.log(`${t.id}  ${t.status.padEnd(11)} agent=${m.herdr_agent ?? "-"} (${live?.agent_status ?? "not running"}) ws=${m.herdr_workspace ?? "-"} branch=${m.branch ?? "-"} commit=${m.commit ?? "-"} pr=${m.pr ?? "-"}${m.result ? `\n      result: ${m.result}` : ""}`);
  }
}

async function cmdShow(id) {
  await cmdStatus(id);
  const name = (await loadTask(id)).extra_frontmatter.herdr_agent;
  if (name && agentOf(name)) herdr("agent", "focus", name);
}

async function cmdSync() {
  let n = 0;
  for (const t of await core.listTasks(ctx)) {
    const m = t.extra_frontmatter;
    if (!m.herdr_agent || !["in-progress", "blocked"].includes(t.status)) continue;
    const live = agentOf(m.herdr_agent);
    const dir = m.worktree && existsSync(m.worktree) ? m.worktree : null;
    const commit = dir ? headOf(dir) : m.commit;
    let status = t.status, log;
    if (!live && t.status === "in-progress") { status = "blocked"; log = "session ended without a report"; }
    else if (live?.agent_status === "blocked" && t.status !== "blocked") { status = "blocked"; log = "agent waiting for input (herdr: blocked)"; }
    if (status !== t.status || commit !== m.commit) {
      await patch(t.id, { status, meta: { commit, ...(log && { result: log }) }, log });
      console.log(`${t.id}: ${t.status} -> ${status}${log ? ` (${log})` : ""}`); n++;
    }
  }
  console.log(n ? `${n} tasks updated` : "already in sync");
}

function cmdProject(sub, rest) {
  const reg = loadRegistry(); reg.projects ??= {};
  if (sub === "list") {
    for (const [id, p] of Object.entries(reg.projects))
      console.log(`${id.padEnd(14)} ${isRepo(p.path) ? "ok     " : "MISSING"} ${p.isolation ?? "worktree"} ${p.agent ?? "claude"} ${p.path}`);
    return;
  }
  if (sub !== "add") fail("usage: project add <id> <path> [--name N] [--isolation worktree|none] [--instructions T] [--base-ref R] [--trust-worktrees] | project list");
  const { values, positionals: [id, path] } = parseArgs({ args: rest, allowPositionals: true, options: { name: { type: "string" }, isolation: { type: "string" }, instructions: { type: "string" }, "base-ref": { type: "string" }, "trust-worktrees": { type: "boolean" } } });
  if (!id || !path) fail("usage: project add <id> <path>");
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) fail("project id: letters, digits, - and _ only");
  const abs = resolve(path).replace(/\\/g, "/");
  if (!isRepo(abs)) fail(`${abs} is not a git repository`);
  if (reg.projects[id]) fail(`project '${id}' is already registered`);
  if (values.isolation && !["worktree", "none"].includes(values.isolation)) fail("isolation: worktree|none");
  reg.projects[id] = { name: values.name ?? id, path: abs, agent: "claude", isolation: values.isolation ?? "worktree", ...(values.instructions && { instructions: values.instructions }), ...(values["base-ref"] && { baseRef: values["base-ref"] }), ...(values["trust-worktrees"] && { trustWorktrees: true }) };
  writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + "\n");
  console.log(`registered '${id}' -> ${abs}\nuse it with: ordna-herdr create "title" -P ${id}`);
}

// Registered project containing the cwd (also when cwd is a worktree of the repo).
function projectFromCwd() {
  const r = git(process.cwd(), "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (r.status !== 0) return null;
  const norm = (s) => resolve(s).replace(/\\/g, "/").toLowerCase();
  const w = wslOf(process.cwd());
  const common = r.stdout.trim().replace(/[\\/]\.git$/, "");
  const root = norm(w ? `//wsl.localhost/${w.distro}${common}` : common);
  return Object.entries(loadRegistry().projects ?? {}).find(([, p]) => norm(p.path) === root)?.[0] ?? null;
}

async function cmdCreate(rest) {
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    project: { type: "string", short: "P" }, priority: { type: "string", short: "p" }, tag: { type: "string", short: "t", multiple: true } } });
  const title = positionals.join(" ").trim() || fail("usage: create <title...> [-P project] [-p high|medium|low] [-t tag...]");
  const proj = values.project ?? projectFromCwd() ?? fail("project not detected from the current directory: use -P <project> (see 'project list')");
  project(proj); // validates that it is registered
  if (values.priority && !["high", "medium", "low"].includes(values.priority)) fail("priority: high|medium|low");
  const t = await core.createTask({ title, tags: [...new Set([proj, ...(values.tag ?? [])])], priority: values.priority ?? null }, ctx);
  console.log(`${t.id} created (project ${proj}): ${t.filePath}`);
}

// Ordna TUI with the native agent hook (key g) pointing at a local listener that lives only while the board is open.
async function cmdBoard() {
  const token = randomBytes(16).toString("hex");
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.headers["x-token"] !== token) { res.writeHead(403).end(); return; }
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const id = JSON.parse(body)?.task?.id ?? fail("missing task");
        res.writeHead(202).end("accepted");
        cmdStart(id).catch(() => { /* error already recorded in the task (blocked) */ });
      } catch (e) { res.writeHead(400).end(String(e.message)); }
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const env = { ...process.env, ORDNA_AGENT_HOOK_URL: `http://127.0.0.1:${server.address().port}/agent`, ORDNA_AGENT_HOOK_LABEL: "Claude", ORDNA_AGENT_HOOK_HEADERS: JSON.stringify({ "X-Token": token }) };
  // ordna-cli/dist/bin/ordna.js, found from ordna-core/dist: no shell (avoids the deprecation warning).
  const bin = resolve(dirname(CORE), "../../../../dist/bin/ordna.js");
  const child = existsSync(bin)
    ? spawn(process.execPath, [bin, "board"], { cwd: TASKS_ROOT, env, stdio: "inherit" })
    : spawn("ordna", ["board"], { cwd: TASKS_ROOT, env, stdio: "inherit", shell: true });
  child.on("exit", (c) => { server.close(); process.exit(c ?? 0); });
}

const HELP = `ordna-herdr <command>
  board                         Ordna TUI; 'g' on a task hands it to Claude through Herdr
  create <title...> [-P project] [-p prio] [-t tag...]   create a task in the central repo (project from the current directory)
  start <id> [--plan|--normal]  start the task (Claude plan mode if the task has tag 'plan', or with --plan)
  show <id>                     status + focus the Herdr session
  status [id]                   run status
  resume <id>                   resume an interrupted task
  stop <id>                     interrupt the agent (esc)
  sync                          reconcile Ordna statuses with Herdr
  report <id> <review|blocked|in-progress> [--note T] [--pr URL]
  project add <id> <path> [--name N] [--isolation worktree|none] [--instructions T] [--base-ref R] [--trust-worktrees]
  project list
  gc                            remove orphaned WSL worktree entries from git safe.directory`;

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd && cmd !== "project" && cmd !== "gc" && !existsSync(join(TASKS_ROOT, ".ordna", "config.yaml")))
    fail(`task repository not found at ${TASKS_ROOT} (no .ordna/config.yaml): run 'ordna init' there and set "tasksRoot" in projects.json`);
  const arg = () => rest[0] ?? fail(`usage: ordna-herdr ${cmd} <id>`);
  switch (cmd) {
    case "board": await cmdBoard(); break;
    case "start": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { plan: { type: "boolean" }, normal: { type: "boolean" } } });
      if (values.plan && values.normal) fail("--plan and --normal are mutually exclusive");
      await cmdStart(positionals[0] ?? fail("usage: ordna-herdr start <id> [--plan|--normal]"), { plan: values.plan ? true : values.normal ? false : undefined }); break;
    }
    case "show": await cmdShow(arg()); break;
    case "status": await cmdStatus(rest[0]); break;
    case "resume": await cmdResume(arg()); break;
    case "stop": await cmdStop(arg()); break;
    case "sync": await cmdSync(); break;
    case "report": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { note: { type: "string" }, pr: { type: "string" } } });
      await cmdReport(positionals[0] ?? fail("usage: report <id> <state>"), positionals[1], values); break;
    }
    case "project": cmdProject(rest[0], rest.slice(1)); break;
    case "create": await cmdCreate(rest); break;
    case "gc": cmdGc(); break;
    default: console.log(HELP); process.exitCode = cmd ? 1 : 0;
  }
} catch (e) { console.error(`error: ${e.message}`); process.exitCode = 1; }
