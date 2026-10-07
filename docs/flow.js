// jev-micromanager flow: how the plugin routes a sub-agent call and how it decides a permission request.
//
// Two lanes, like the oc-voice flow page: the decision chart is static (it mirrors src/routing.ts and
// src/decide.ts); the highlight and the detail panel come from the decision journal
// (${XDG_STATE_HOME:-~/.local/state}/jev-micromanager/decisions.jsonl), one JSON object per line.
"use strict";

const SVG_NS = "http://www.w3.org/2000/svg";
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// --- the chart ------------------------------------------------------------------------------------------
// id: {t: title, s: subtitle, x, y, cat, e: explanation}. x/y are box centers; W x H is the box size.
const NODES = {
  // model routing (src/routing.ts, src/hooks.ts)
  subagent: { t: "Subagent call", s: "the micromanager delegates", x: 100, y: 110, cat: "entry",
    e: "The micromanager calls the built-in subagent tool for a sub-task. The plugin rewrites the call in place before it runs." },
  role: { t: "A known role?", s: "explorer …", x: 340, y: 110, cat: "route",
    e: "Only the ten role agents (explorer, coder, …) are routed. A built-in agent such as explore or general is left exactly as asked." },
  left: { t: "Left as asked", s: "a built-in agent", x: 820, y: 30, cat: "entry",
    e: "Not one of the micromanager's roles: the model and the prompt stay untouched, and nothing is recorded." },
  needs: { t: "Images needed?", s: "a guess from the prompt", x: 580, y: 110, cat: "route",
    e: "Phase 1 guesses the need from keywords (screenshot, png, …). From Phase 2 Jev answers whether the sub-task needs image input." },
  review: { t: "Review?", s: "another family than the worker", x: 820, y: 220, cat: "route",
    e: "A reviewer never checks the work of its own model family: qwen reviews GLM/DeepSeek, GLM reviews Qwen." },
  model: { t: "Model chosen", s: "vision · other family · first", x: 1060, y: 110, cat: "route",
    e: "The role's first model, the vision model for image input, or — for a review — the first model of another family than the worker's." },
  worker: { t: "Worker runs", s: "foreground session", x: 1300, y: 110, cat: "entry",
    e: "The sub-agent session runs on the chosen model with the role's rights and the prompt carrying a [jev-micromanager] header." },

  // permission decision (src/decide.ts, src/plugin.ts) — the order is decide()'s own, top to bottom.
  ask: { t: "Permission ask", s: "effect = ask · our agents", x: 100, y: 500, cat: "entry",
    e: "OpenCode asks before a tool call. Only the micromanager and its role agents are handled here; every other agent's ask is left to OpenCode." },
  hard: { t: "Hard rule?", s: "destructive · .env · install · sensitive root", x: 340, y: 500, cat: "guard",
    e: "Rules Jev can never override, checked first and never bypassed: a destructive or irreversible command, installing software into the system, a .env file, and — for a path outside the project — the roots that are refused at every layer (~/.ssh, ~/.aws, ~/.config, ~/.gnupg, /etc, /usr, the home directory itself, another job's worktree content). Always the user." },
  reading: { t: "Only reads, inside the worktree?", s: "no Jev asked at all", x: 820, y: 390, cat: "check",
    e: "A shell request whose every step only reads, with every path it names resolving inside the worker's worktree, is allowed outright — no Jev request. Reading cannot damage a throwaway checkout, and Jev's own confidence on these sits under the read floor, so asking only turned a worker's inspection into a denial (67 of 185 worker shell requests in the live run). A preset that sends this to the user still wins." },
  outside: { t: "Outside the project?", s: "three layers", x: 820, y: 620, cat: "check",
    e: "Layer by layer: a path inside this job's own worktrees is allowed mechanically; a read of a directory the task itself names is allowed; anything else is the user's, as it was before the layers existed." },
  jobarea: { t: "In the job's worktrees?", s: "mechanical allow", x: 1060, y: 580, cat: "allow",
    e: "Any path under .jev-micromanager/worktrees/ — this job's, and the integration worktree. Compared segment-wise, so a sibling directory sharing a name prefix is outside." },
  vouched: { t: "The task names it?", s: "a read only", x: 1300, y: 620, cat: "allow",
    e: "The task text names the path, a directory containing it, or a file in it, and the requesting agent is a reader. Vouching for a path is not vouching for a write, so a write outside the project still escalates." },
  deletes: { t: "Deletes files?", s: "what git says about the paths", x: 1060, y: 750, cat: "check",
    e: "An rm -r/-f inside the project: the plugin asks git and the file system what the deleted paths are (exists, tracked, ignored)." },
  tracked: { t: "Tracked or unknown?", s: "version control → user", x: 1300, y: 750, cat: "check",
    e: "A deleted path that is under version control — or in a folder that is no git repository — is the user's call. Ignored caches stay Jev's." },
  jev: { t: "Jev answers", s: "answer · needs_user · risk", x: 1540, y: 500, cat: "jev",
    e: "One Jev request gets the agent, its role, the action, the resources, the sub-task and (for a delete) the path facts. It returns a choice, needs_user, risk and path_relevance with probabilities." },
  floors: { t: "Safe and sure?", s: "needs_user · risk · confidence", x: 1780, y: 500, cat: "floor",
    e: "needs_user ≥ 0.5, risk ≥ 1.5, path_relevance ≥ 0.5, or a confidence below the class floor (read 0.80, write 0.85): the user decides. Otherwise Jev's choice stands." },
  allow: { t: "Allow", s: "granted, or Jev's choice", x: 2020, y: 420, cat: "allow",
    e: "Granted without asking: a read inside the worktree, a path in the job's own area, a task-vouched read, or Jev allowing it with enough confidence for the risk class." },
  deny: { t: "Deny", s: "Jev's choice stands", x: 2020, y: 500, cat: "deny",
    e: "Jev denied it with enough confidence for the risk class; the call is blocked and the agent is told no." },
  user: { t: "User decides", s: "question passes through", x: 2020, y: 660, cat: "user",
    e: "The question or permission request goes to the TUI unchanged — with Jev's suggestion and its confidence appended when there is one." },
};

// [from, to, label, route] with route: undefined = curve, "down" = straight down, {lane: y} = along a free
// lane between the boxes and into the target's left edge.
const EDGES = [
  ["subagent", "role"], ["role", "left", "built-in"], ["role", "needs", "role"],
  ["needs", "review", "no images"], ["needs", "model", "images"], ["review", "model", "first · other"],
  ["model", "worker"],
  ["ask", "hard"],
  ["hard", "user", "hard rule", { lane: 960 }], ["hard", "deny", "a runner session\u2019s own layers"],
  ["hard", "reading"], ["hard", "outside"], ["hard", "deletes"],
  ["reading", "allow", "only reads · in tree"],
  ["outside", "jobarea", "in the job area"], ["outside", "vouched", "a reader, task names it"],
  ["outside", "user", "otherwise", { lane: 900 }],
  ["jobarea", "allow"], ["vouched", "allow"],
  ["deletes", "user", "no directory", { lane: 850 }], ["deletes", "tracked", "yes"], ["deletes", "jev", "no"],
  ["tracked", "user", "tracked / unknown", { lane: 820 }], ["tracked", "jev", "ignored"],
  ["jev", "user", "no key · error · unanswered", { lane: 780 }], ["jev", "floors"],
  ["floors", "user", "a floor"], ["floors", "allow", "allow"], ["floors", "deny", "deny"],
];
// Lane headers. [text, x, y]; routing sits above the first lane, permission above the second.
const STAGES = [
  [["INPUT", 100, -25], ["ROLE", 340, -25], ["NEEDS", 580, -25], ["REVIEW", 820, -25], ["MODEL", 1060, -25], ["RUN", 1300, -25],
   ["ASK", 100, 448], ["GUARD", 340, 448], ["READS", 820, 338], ["OUTSIDE", 820, 568],
   ["PATHS", 1060, 698], ["JEV", 1540, 448], ["FLOORS", 1780, 448], ["VERDICT", 2020, 448]],
];
const W = 170, H = 50;
const CAT_VAR = { entry: "--c-entry", route: "--c-route", guard: "--c-guard", check: "--c-check",
                  jev: "--c-jev", floor: "--c-floor", allow: "--c-allow", deny: "--c-deny", user: "--c-user",
                  other: "--c-other" };
const pos = Object.fromEntries(Object.entries(NODES).map(([id, n]) => [id, { x: n.x, y: n.y }]));

function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
}

// Returns [path, label position].
function edgePath(a, b, route) {
  const p = pos[a], q = pos[b];
  const tx = q.x - W / 2;
  if (route === "down") return [`M${p.x},${p.y + H / 2} L${q.x},${q.y - H / 2}`, [p.x + 16, (p.y + q.y) / 2]];
  if (route && route.lane !== undefined) {
    const y = route.lane;
    const sx = p.x + W / 2, bend = sx + 16;
    return [`M${sx},${p.y} L${bend},${p.y} L${bend},${y} L${tx - 16},${y} L${tx - 16},${q.y} L${tx},${q.y}`,
            [bend + 34, y - 7]];
  }
  if (Math.abs(p.y - q.y) < 5) return [`M${p.x + W / 2},${p.y} L${tx},${q.y}`, [(p.x + q.x) / 2, p.y - 8]];
  const x1 = p.x + W / 2, mid = (x1 + tx) / 2;
  return [`M${x1},${p.y} C${mid},${p.y} ${mid},${q.y} ${tx},${q.y}`, [mid, (p.y + q.y) / 2 - 6]];
}

const chart = document.getElementById("chart");
const nodeEls = {}, edgeEls = {}, countEls = {}, subEls = {};

function drawChart() {
  const defs = el("defs", {}, chart);
  for (const id of ["arrow", "arrow-on"]) {
    const m = el("marker", { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 9, markerHeight: 9,
                             markerUnits: "userSpaceOnUse", orient: "auto-start-reverse" }, defs);
    el("path", { d: "M0,0 L10,5 L0,10 z" }, m);
  }
  for (const stage of STAGES) for (const [name, x, y] of stage) el("text", { x, y, class: "stage" }, chart).textContent = name;
  for (const [a, b, label, route] of EDGES) {
    const [d, [lx, ly]] = edgePath(a, b, route);
    edgeEls[`${a}>${b}`] = el("path", { d, class: "edge" }, chart);
    if (label) el("text", { x: lx, y: ly, class: "elabel" }, chart).textContent = label;
  }
  for (const [id, n] of Object.entries(NODES)) {
    const g = el("g", { class: "node" }, chart);
    const color = css(CAT_VAR[n.cat]);
    el("title", {}, g).textContent = n.e;
    el("rect", { x: n.x - W / 2, y: n.y - H / 2, width: W, height: H, rx: 12 }, g);
    el("rect", { x: n.x - W / 2 + 1, y: n.y - H / 2 + 8, width: 4, height: H - 16, rx: 2, class: "bar", fill: color }, g);
    el("text", { x: n.x, y: n.y - 9, class: "title" }, g).textContent = n.t;
    subEls[id] = el("text", { x: n.x, y: n.y + 10, class: "sub" }, g);
    subEls[id].textContent = n.s;
    countEls[id] = el("text", { x: n.x + W / 2 - 4, y: n.y - H / 2 - 8, class: "count", "text-anchor": "end" }, g);
    g.addEventListener("click", () => explainNode(id));
    nodeEls[id] = g;
  }
}

// --- journal entries ------------------------------------------------------------------------------------
// Permission entries: {kind:"permission", agent, action, resources, verdict, reason, confidence, …}.
// Routing entries:    {kind:"routing", role, requested, model, reason, prompt}.
let entries = [];
let seen = new Set();
let selected = null;
let filter = null; // {mode: "use" | "node", key, label}

const short = (model) => String(model ?? "").split("/").pop() ?? "";
const isDelete = (r) => /\brm\s+-[A-Za-z]*[rRf]/.test(String(r));

// The chart covers two lanes: how a delegation is routed, and how a permission request is decided. The journal
// carries more kinds than that (watchdog, checkpoint, the plugin's own startup record, …); they are kept, and they
// list without highlighting, because an operator loading the file wants to see that the journal is alive.
const UNCHARTED = new Set(["plugin", "watchdog", "checkpoint", "finish", "compaction", "memory", "graph",
                          "discovered", "delegation-unrecognised", "decision", "escalation"]);

function normalize(raw) {
  const kind = raw.kind ?? (raw.role && raw.model ? "routing" : "permission");
  const charted = kind === "routing" || kind === "permission";
  return { ...raw, kind, charted, ts: raw.ts ?? raw.time };
}
const keyOf = (e) => `${e.kind}|${e.ts}|${e.agent ?? ""}|${e.action ?? e.role ?? ""}|${e.resources?.join(",") ?? e.model ?? ""}`;

function add(raw) {
  const e = normalize(raw);
  const k = keyOf(e);
  if (seen.has(k)) return false;
  seen.add(k);
  entries.push(e);
  return true;
}

function routingPath(e) {
  const p = ["subagent"];
  if (!e.role) return [...p, "role", "left"];
  p.push("role");
  if (/image/i.test(String(e.reason ?? ""))) return [...p, "needs", "model", "worker"];
  return [...p, "needs", "review", "model", "worker"];
}

// Reconstructs the walk decide() took, from the recorded reason. The journal keeps verdict + reason + scores, and
// the reasons are the branches of decide() in order, so this mirrors src/decide.ts rather than guessing.
function permissionPath(e) {
  const r = String(e.reason ?? "");
  // hardRule() is first and is never bypassed.
  if (r.startsWith("always the user: a destructive") || r.startsWith("always the user: installs")) {
    return ["ask", "hard", "user"];
  }
  // readsOnlyInside(): allowed outright, Jev never asked.
  if (/^read-only command inside/.test(r)) return ["ask", "hard", "reading", "allow"];
  // externalVerdict(), decide.ts's own two allow layers.
  if (/^inside the job's own worktrees/.test(r)) return ["ask", "hard", "outside", "jobarea", "allow"];
  if (/^a read of a directory the task names/.test(r)) return ["ask", "hard", "outside", "vouched", "allow"];
  if (/^always the user: access outside/.test(r)) return ["ask", "hard", "outside", "user"];
  // The plugin's own layers for a session the runner started (plugin.ts's external_directory branch), which run
  // before decide() is consulted: the hard denials first, then a vouch from the task or from the micromanager.
  if (/^a hard-denied path/.test(r)) return ["ask", "hard", "deny"];
  if (/^a reader, in a directory its task/.test(r)) return ["ask", "hard", "outside", "vouched", "allow"];
  if (/^runner session outside its directory/.test(r)) return ["ask", "hard", "deny"];
  // Deleting inside the project: the path facts come before Jev.
  if (/^deletes files, and the project directory is unknown/.test(r)) return ["ask", "hard", "deletes", "user"];
  if (/^deletes /.test(r)) return ["ask", "hard", "deletes", "tracked", "user"];
  const dels = (e.resources ?? []).some(isDelete);
  const head = dels ? ["ask", "hard", "deletes", "tracked", "jev"] : ["ask", "hard", "deletes", "jev"];
  if (/^no Jev key|^Jev failed:|^Jev unreachable:|left a question unanswered/.test(r)) return [...head, "user"];
  if (/^preset by the user's policy/.test(r)) return [...head, e.verdict === "deny" ? "deny" : e.verdict === "allow" ? "allow" : "user"];
  if (/user must decide|deleted paths matter|too risky|unsure/.test(r)) return [...head, "floors", "user"];
  return [...head, "floors", e.verdict === "deny" ? "deny" : "allow"];
}

function pathOf(e) { return e.kind === "routing" ? routingPath(e) : permissionPath(e); }

function edgesOf(path) {
  const on = new Set();
  for (let i = 0; i + 1 < path.length; i++) on.add(`${path[i]}>${path[i + 1]}`);
  return on;
}

// [label, category] of a decision, for the list and the detail chip. The branches that decide a permission request
// without asking Jev get their own wording, because "allow" alone does not say why it was safe.
function label(e) {
  if (e.kind === "routing") return [`${e.role} → ${short(e.model)}`, "route"];
  const verdict = String(e.verdict ?? "?");
  const noJev = NO_JEV.find(([re]) => re.test(String(e.reason ?? "")));
  if (verdict === "allow" && noJev) return [`allow · ${noJev[1].toLowerCase()}`, "allow"];
  return [verdict, verdict === "allow" ? "allow" : verdict === "deny" ? "deny" : "user"];
}

const said = (e) => {
  if (e.kind === "routing") return `${e.requested ?? e.role}: ${(e.prompt ?? "").replace("[jev-micromanager]", "").trim()}`;
  if (!e.charted) return `${e.kind}${e.signal ? ` · ${e.signal}` : ""}${e.reason ? ` · ${e.reason}` : ""}`;
  return `${e.agent ?? "?"} · ${e.action ?? "?"}`;
};

// What a decision touched, for "Used" and for filtering.
function usesOf(e) {
  if (e.kind === "routing") return [short(e.model), `role:${e.role}`];
  if (!e.charted) return [e.kind];
  const noJev = NO_JEV.find(([re]) => re.test(String(e.reason ?? "")));
  return [e.agent, `action:${e.action}`, `verdict:${e.verdict}`, ...(noJev ? [`reason:${noJev[1]}`] : [])];
}

// --- rendering ------------------------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const clock = (ts) => ts ? new Date(ts).toLocaleTimeString([], { hour12: false }) : "–";
const ms = (v) => v == null ? "–" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
const pct = (v) => v == null ? "–" : `${Math.round(v * 100)}%`;
const f2 = (v) => v == null ? "–" : Number(v).toFixed(2);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const chip = (text, cat, fill = false) =>
  `<span class="chip${fill ? " fill" : ""}" style="${fill ? "background" : "color"}:var(${CAT_VAR[cat] ?? "--c-entry"})">${esc(text)}</span>`;

const all = () => [...entries].sort((a, b) => new Date(b.ts ?? 0) - new Date(a.ts ?? 0));

function visible() {
  const q = $("search").value.trim().toLowerCase();
  return all().filter((e) => {
    if (filter?.mode === "node" && !pathOf(e).includes(filter.key)) return false;
    if (filter?.mode === "use" && !usesOf(e).includes(filter.key)) return false;
    if (!q) return true;
    return [said(e), e.reason, e.model, e.role, e.action, ...(e.resources ?? [])].join(" ").toLowerCase().includes(q);
  });
}

function renderList() {
  const items = visible();
  const charted = items.filter((e) => e.charted).length;
  $("count").textContent = charted === items.length
    ? `${items.length} decision${items.length === 1 ? "" : "s"}`
    : `${charted} decision${charted === 1 ? "" : "s"}, ${items.length - charted} other`;
  $("filter").hidden = !filter;
  if (filter) $("filter").textContent = `✕ ${filter.label}`;
  const box = $("entries");
  box.innerHTML = items.length ? "" : '<p class="empty" style="padding:10px">No data. Open decisions.jsonl above.</p>';
  for (const e of items) {
    const [text, cat] = e.charted ? label(e) : [e.kind, "other"];
    const div = document.createElement("div");
    div.className = `entry${keyOf(e) === selected ? " sel" : ""}`;
    div.innerHTML = `<div class="said">${esc(said(e))}</div>
      <div class="meta"><span>${clock(e.ts)}</span>${chip(text, cat)}<span>${ms(e.latencyMs)}</span></div>`;
    div.onclick = () => select(keyOf(e));
    box.appendChild(div);
  }
  box.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
}

function renderCounts() {
  const counts = {};
  for (const e of all()) if (e.charted) for (const id of new Set(pathOf(e))) counts[id] = (counts[id] ?? 0) + 1;
  for (const [id, c] of Object.entries(countEls)) c.textContent = counts[id] ? `${counts[id]}×` : "";
}

// The four branches that grant a permission without asking Jev, with what each one is worth. They are the ones an
// operator will ask about, because "allow" without a reason is the least informative verdict the plugin records.
// Declared before the functions that read it: label(), usesOf(), renderDetail() and renderUsage() all need it.
const NO_JEV = [
  [/^read-only command inside/, "read only", "Only reads, inside the worktree",
   "Every step of the command reads, and every path it names resolves inside the worker's worktree. No Jev request was made — reading cannot damage a throwaway checkout."],
  [/^inside the job's own worktrees/, "job area", "Inside the job's own worktrees",
   "The path is under .jev-micromanager/worktrees/: this job's, or the integration worktree. Compared segment-wise."],
  [/^a read of a directory the task names/, "task names it", "A read the task itself names",
   "The task text names the path (or a directory containing it) and the asking agent is a reader. A write outside the project still escalates."],
  [/^preset by the user's policy/, "preset", "Preset by your policy",
   "A configured decision (decisions.N13.*) answers this kind of request without asking Jev."],
];

function highlight(e) {
  const path = e?.charted ? pathOf(e) : [];
  const on = path.length ? edgesOf(path) : new Set();
  for (const [id, g] of Object.entries(nodeEls)) {
    g.classList.toggle("on", path.includes(id));
    g.classList.toggle("dim", !!e && !path.includes(id));
    g.querySelector("rect").style.stroke = path.includes(id) ? css(CAT_VAR[NODES[id].cat]) : "";
    subEls[id].textContent = NODES[id].s;
  }
  for (const [k, edge] of Object.entries(edgeEls)) edge.classList.toggle("on", on.has(k));
  if (!e?.charted) return;
  const write = (id, text) => { if (subEls[id]) subEls[id].textContent = truncate(text, 26); };
  if (e.kind === "routing") {
    write("role", e.requested ?? e.role);
    write("needs", /image/i.test(String(e.reason)) ? "images" : "no images");
    write("review", /another family/i.test(String(e.reason)) ? "another family" : "passes through");
    write("model", short(e.model));
    write("worker", short(e.model));
  } else {
    const r = String(e.reason ?? "");
    write("ask", `${e.agent} · ${e.action}`);
    if (/^always the user: (a destructive|installs)/.test(r)) write("hard", r.replace("always the user: ", ""));
    if (/^inside the job's own worktrees/.test(r)) write("jobarea", r);
    if (/^a read of a directory the task names/.test(r)) write("vouched", "the task names it");
    if (/^read-only command inside/.test(r)) write("reading", "reads only, all paths in tree");
    if (/always the user: access outside/.test(r)) write("outside", "no layer covers it");
    if (/^deletes/.test(r)) write("tracked", r);
    write("jev", r.replace(/^Jev: /, ""));
    if (path.includes("floors")) write("floors", r.replace(/^Jev: /, ""));
    write(String(e.verdict), e.verdict === "user" ? "the user was asked" : "granted, or Jev's choice");
  }
}

function truncate(text, n) { const s = String(text ?? ""); return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

function pretty(v) {
  if (typeof v === "string") { try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } }
  return JSON.stringify(v ?? null, null, 2);
}

function step(n, cat, title, body) {
  return `<li class="step"><span class="dot" style="background:var(${CAT_VAR[cat] ?? "--c-entry"})">${n}</span>
    <h3>${esc(title)}</h3>${body}</li>`;
}

function meter(name, value, max, bad) {
  if (value == null) return "";
  return `<div class="meter">${esc(name)} ${f2(value)}
    <div class="track"><div class="fill" style="width:${Math.max(2, Math.min(100, (value / max) * 100))}%;
      background:var(${bad ? "--c-guard" : "--c-jev"})"></div></div></div>`;
}

function renderDetail(e) {
  const [text, cat] = label(e);
  $("entry-title").innerHTML = `${clock(e.ts)} ${chip(text, cat, true)}`;
  let n = 0;
  const parts = [];
  if (e.kind && !e.charted) {
    // Not a routing or permission decision. The chart has nothing to highlight, so say what the record is instead
    // of showing a decision that was never made.
    parts.push(step(++n, "other", `Journal record: ${esc(e.kind)}`, `<div class="kv">${esc(e.reason ?? e.signal ?? "")}</div>
      <div class="kv">${esc(pretty(Object.fromEntries(Object.entries(e).filter(([k]) => !["charted"].includes(k)))))}</div>`));
    $("detail").innerHTML = `<ol class="steps">${parts.join("")}</ol>`;
    return;
  }
  if (e.kind === "routing") {
    parts.push(step(++n, "entry", "Delegated", `<div class="big">${esc(truncate((e.prompt ?? "").replace("[jev-micromanager]", "").trim(), 400))}</div>
      <div class="kv">${esc(e.agent ?? "micromanager")} → ${esc(e.requested ?? e.role)}</div>`));
    parts.push(step(++n, "route", "Routed", `<div>role <b>${esc(e.role)}</b> → ${chip(short(e.model), "route")}</div>
      <div class="kv">${esc(e.reason ?? "")}</div>`));
  } else {
    parts.push(step(++n, "entry", `Asked by ${e.agent === "micromanager" ? "the micromanager" : esc(e.agent)}`,
      `<div class="big">${esc(e.action)}</div>
       <div class="kv">${esc((e.resources ?? []).join(" | "))}</div>
       ${e.task ? `<div class="kv">sub-task: ${esc(truncate(e.task, 300))}</div>` : ""}
       ${e.directory ? `<div class="kv">project: ${esc(e.directory)}</div>` : ""}`));
    const r = String(e.reason ?? "");
    const guards = [];
    if (/^always the user: (a destructive|installs)/.test(r)) guards.push(`hard rule — ${esc(r.replace("always the user: ", ""))}`);
    if (/always the user: access outside/.test(r)) guards.push("outside the project, and no layer covers it");
    if (/^deletes/.test(r)) guards.push(`git says: ${esc(r)}`);
    if (/no Jev key|Jev failed|Jev unreachable/.test(r)) guards.push("Jev unavailable → the user");
    if (guards.length) parts.push(step(++n, "guard", "Before Jev", `<div class="kv">${guards.join("<br>")}</div>`));
    // One of the branches that decide without Jev: Jev was never asked, so there are no scores to show.
    const noJev = NO_JEV.find(([re]) => re.test(r));
    if (noJev) {
      parts.push(step(++n, "allow", "Decided without Jev", `<div class="big">${esc(noJev[2])}</div>
        <div class="kv">${esc(noJev[3])}</div>`));
    } else {
      parts.push(step(++n, "jev", "Jev's read", `<div class="big">${esc(r.replace(/^Jev: /, ""))}</div>
        <div class="meters">
          ${meter("confidence", e.confidence, 1, e.confidence != null && e.confidence < 0.85)}
          ${meter("risk", e.risk, 2, e.risk != null && e.risk >= 1.5)}
          ${meter("needs_user", e.needsUser, 1, e.needsUser != null && e.needsUser >= 0.5)}
          ${e.probability == null ? "" : `<div class="meter">P(${esc(String(e.verdict))}) ${f2(e.probability)}</div>`}
          <div class="meter">Jev time ${ms(e.latencyMs)}</div>
        </div>`));
    }
    parts.push(step(++n, cat, "Verdict", `<div>${chip(text, cat, true)}</div>
      <div class="kv">${esc(e.reason ?? "")}</div>`));
  }
  $("detail").innerHTML = `<ol class="steps">${parts.join("")}</ol>`;
}

function renderUsage() {
  const groups = {
    "Permissions by verdict": { cat: "user", rows: {}, key: (name) => `verdict:${name}` },
    "Allowed without asking Jev": { cat: "allow", rows: {}, key: (name) => `reason:${name}` },
    "Routed to": { cat: "route", rows: {}, key: (name) => name },
    "Agents": { cat: "entry", rows: {}, key: (name) => name },
  };
  for (const e of all()) {
    if (!e.charted) continue; // the chart's two lanes; the rest is the journal, not a decision here
    if (e.kind === "routing") {
      const model = short(e.model);
      groups["Routed to"].rows[model] = (groups["Routed to"].rows[model] ?? 0) + 1;
    } else {
      const verdict = e.verdict ?? "?";
      groups["Permissions by verdict"].rows[verdict] = (groups["Permissions by verdict"].rows[verdict] ?? 0) + 1;
      const agent = e.agent ?? "?";
      groups["Agents"].rows[agent] = (groups["Agents"].rows[agent] ?? 0) + 1;
      // The branches that grant without asking: the interesting split inside "allow", and the reason the counts
      // moved when the read-only and external_directory layers landed.
      const noJev = NO_JEV.find(([re]) => re.test(String(e.reason ?? "")));
      if (noJev) groups["Allowed without asking Jev"].rows[noJev[1]] = (groups["Allowed without asking Jev"].rows[noJev[1]] ?? 0) + 1;
      else if (e.verdict === "allow") groups["Allowed without asking Jev"].rows["Jev allowed it"] = (groups["Allowed without asking Jev"].rows["Jev allowed it"] ?? 0) + 1;
    }
  }
  if (!groups["Allowed without asking Jev"].rows) delete groups["Allowed without asking Jev"];
  const max = Math.max(1, ...Object.values(groups).flatMap((g) => Object.values(g.rows)));
  let out = "";
  for (const [title, g] of Object.entries(groups)) {
    const items = Object.entries(g.rows).sort((a, b) => b[1] - a[1]);
    if (!items.length) continue;
    out += `<h3>${title} <span class="n">${items.reduce((a, [, c]) => a + c, 0)}×</span></h3>`;
    for (const [name, c] of items) {
      const key = g.key(name);
      out += `<div class="urow${filter?.key === key ? " sel" : ""}" data-use="${esc(key)}" data-label="${esc(name)}">
        <span class="name">${esc(name)}</span>
        <span class="track"><span class="fill" style="display:block;width:${(c / max) * 100}%;background:var(${CAT_VAR[g.cat]})"></span></span>
        <span class="n">${c}</span></div>`;
    }
  }
  $("usage").innerHTML = out || '<span class="empty">No decisions loaded.</span>';
  for (const row of $("usage").querySelectorAll(".urow")) {
    const use = row.dataset.use;
    row.onclick = () => setFilter(filter?.key === use ? null : { mode: "use", key: use, label: row.dataset.label });
  }
}

function explainNode(id) {
  const n = NODES[id];
  const count = all().filter((e) => e.charted && pathOf(e).includes(id)).length;
  $("explain").innerHTML = `${chip(n.t, n.cat, true)} ${esc(n.e)} <span class="filter">· ${count} decision${count === 1 ? "" : "s"} — show them</span>`;
  $("explain").querySelector(".filter").onclick = () => setFilter({ mode: "node", key: id, label: n.t });
}

function setFilter(f) {
  filter = f;
  renderUsage();
  const items = visible();
  if (items[0] && !items.some((e) => keyOf(e) === selected)) select(keyOf(items[0]));
  else renderList();
}

function select(key) {
  selected = key;
  const e = entries.find((x) => keyOf(x) === key);
  highlight(e);
  if (e) renderDetail(e);
  const items = visible(), i = items.findIndex((x) => keyOf(x) === key);
  $("prev").disabled = i <= 0;
  $("next").disabled = i < 0 || i >= items.length - 1;
  renderList();
}

function move(delta) {
  const items = visible(), i = items.findIndex((e) => keyOf(e) === selected);
  const next = items[Math.min(items.length - 1, Math.max(0, i + delta))];
  if (next) select(keyOf(next));
}

// --- data -----------------------------------------------------------------------------------------------
function loadText(text, source) {
  entries = [];
  seen = new Set();
  selected = null;
  filter = null;
  highlight(null);
  $("detail").innerHTML = '<span class="empty">No decision selected.</span>';
  let bad = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { add(JSON.parse(trimmed)); } catch { bad++; }
  }
  const pill = $("source");
  pill.textContent = `● ${source} · ${entries.length}`;
  pill.classList.add("on");
  pill.classList.toggle("bad", entries.length === 0);
  renderCounts();
  renderUsage();
  renderList();
  // ?reason=… selects the newest entry whose reason contains it. It makes a path shareable and checkable: a headless
  // screenshot of ?reason=read-only shows the read-only branch highlighted, which is the only way to verify that a
  // highlighted path is still the one the code takes.
  const want = new URLSearchParams(location.search).get("reason");
  const first = want ? visible().find((e) => String(e.reason ?? "").includes(want)) : visible()[0];
  if (first) select(keyOf(first));
  else highlight(null);
}

function openFile(file) {
  const reader = new FileReader();
  reader.onload = () => loadText(String(reader.result ?? ""), file.name);
  reader.readAsText(file);
}

drawChart();
highlight(null);
$("load").onclick = () => $("file").click();
$("file").onchange = () => { if ($("file").files[0]) openFile($("file").files[0]); };
$("toggle").onclick = () => $("layout").classList.toggle("collapsed");
$("search").oninput = () => renderList();
$("filter").onclick = () => setFilter(null);
$("prev").onclick = () => move(-1);
$("next").onclick = () => move(1);
document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) { if (e.key === "Escape") e.target.blur(); return; }
  if (e.key === "ArrowUp" || e.key === "k") { move(-1); e.preventDefault(); }
  else if (e.key === "ArrowDown" || e.key === "j") { move(1); e.preventDefault(); }
  else if (e.key === "h") $("layout").classList.toggle("collapsed");
  else if (e.key === "/") { $("search").focus(); e.preventDefault(); }
});
// Drag and drop anywhere on the page.
const drop = $("drop");
document.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("show"); });
document.addEventListener("dragleave", (e) => { if (e.relatedTarget === null) drop.classList.remove("show"); });
document.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("show");
  const file = e.dataTransfer?.files?.[0];
  if (file) openFile(file);
});
// When served over http(s) the journal next to the page is picked up automatically; under file:// this is
// blocked and the button or a drop is used instead.
fetch("decisions.jsonl").then((r) => r.ok ? r.text() : "").then((text) => {
  if (text.trim()) loadText(text, "decisions.jsonl");
}).catch(() => {});

// Exposed for the tests and for a headless screenshot of a specific path: there is no other way to drive the chart
// from outside the page, and checking a highlighted path by eye is exactly the kind of thing that silently rots.
Object.assign(window, { NODES, EDGES, pathOf, permissionPath, routingPath, label, NO_JEV, UNCHARTED,
                        get entries() { return entries }, select, keyOf });
