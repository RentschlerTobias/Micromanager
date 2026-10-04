// jev-dictator flow: how the plugin routes a sub-agent call and how it decides a permission request.
//
// Two lanes, like the oc-voice flow page: the decision chart is static (it mirrors src/routing.ts and
// src/decide.ts); the highlight and the detail panel come from the decision journal
// (${XDG_STATE_HOME:-~/.local/state}/jev-dictator/decisions.jsonl), one JSON object per line.
"use strict";

const SVG_NS = "http://www.w3.org/2000/svg";
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// --- the chart ------------------------------------------------------------------------------------------
// id: {t: title, s: subtitle, x, y, cat, e: explanation}. x/y are box centers; W x H is the box size.
const NODES = {
  // model routing (src/routing.ts, src/hooks.ts)
  subagent: { t: "Subagent call", s: "the dictator delegates", x: 100, y: 110, cat: "entry",
    e: "The dictator calls the built-in subagent tool for a sub-task. The plugin rewrites the call in place before it runs." },
  role: { t: "A known role?", s: "dictator-explore …", x: 340, y: 110, cat: "route",
    e: "Only the ten role agents (dictator-*) are routed. A built-in agent such as explore or general is left exactly as asked." },
  left: { t: "Left as asked", s: "a built-in agent", x: 820, y: 30, cat: "entry",
    e: "Not one of the dictator's roles: the model and the prompt stay untouched, and nothing is recorded." },
  needs: { t: "Images needed?", s: "a guess from the prompt", x: 580, y: 110, cat: "route",
    e: "Phase 1 guesses the need from keywords (screenshot, png, …). From Phase 2 Jev answers whether the sub-task needs image input." },
  review: { t: "Review?", s: "another family than the worker", x: 820, y: 220, cat: "route",
    e: "A reviewer never checks the work of its own model family: qwen reviews GLM/DeepSeek, GLM reviews Qwen." },
  model: { t: "Model chosen", s: "vision · other family · first", x: 1060, y: 110, cat: "route",
    e: "The role's first model, the vision model for image input, or — for a review — the first model of another family than the worker's." },
  worker: { t: "Worker runs", s: "foreground session", x: 1300, y: 110, cat: "entry",
    e: "The sub-agent session runs on the chosen model with the role's rights and the prompt carrying a [jev-dictator] header." },

  // permission decision (src/decide.ts, src/plugin.ts)
  ask: { t: "Permission ask", s: "effect = ask · our agents", x: 100, y: 430, cat: "entry",
    e: "OpenCode asks before a tool call. Only the dictator and its role agents are handled here; every other agent's ask is left to OpenCode." },
  hard: { t: "Hard rule?", s: "git push · sudo · .env · install", x: 340, y: 430, cat: "guard",
    e: "Rules Jev can never override: a destructive or irreversible command, installing software into the system, a .env file, or access outside the project. Always the user." },
  deletes: { t: "Deletes files?", s: "what git says about the paths", x: 580, y: 430, cat: "check",
    e: "An rm -r/-f inside the project: the plugin asks git and the file system what the deleted paths are (exists, tracked, ignored)." },
  tracked: { t: "Tracked or unknown?", s: "version control → user", x: 820, y: 300, cat: "check",
    e: "A deleted path that is under version control — or in a folder that is no git repository — is the user's call. Ignored caches stay Jev's." },
  jev: { t: "Jev answers", s: "answer · needs_user · risk", x: 1060, y: 430, cat: "jev",
    e: "One Jev request gets the agent, its role, the action, the resources, the sub-task and (for a delete) the path facts. It returns a choice, needs_user, risk and path_relevance with probabilities." },
  floors: { t: "Safe and sure?", s: "needs_user · risk · confidence", x: 1300, y: 430, cat: "floor",
    e: "needs_user ≥ 0.5, risk ≥ 1.5, path_relevance ≥ 0.5, or a confidence below the class floor (read 0.80, write 0.85): the user decides. Otherwise Jev's choice stands." },
  allow: { t: "Allow", s: "Jev's choice stands", x: 1540, y: 300, cat: "allow",
    e: "Jev allowed it with enough confidence for the risk class; the permission is granted without asking the user." },
  deny: { t: "Deny", s: "Jev's choice stands", x: 1540, y: 430, cat: "deny",
    e: "Jev denied it with enough confidence for the risk class; the call is blocked and the agent is told no." },
  user: { t: "User decides", s: "question passes through", x: 1540, y: 620, cat: "user",
    e: "The question or permission request goes to the TUI unchanged — with Jev's suggestion and its confidence appended when there is one." },
};

// [from, to, label, route] with route: undefined = curve, "down" = straight down, {lane: y} = along a free
// lane between the boxes and into the target's left edge.
const EDGES = [
  ["subagent", "role"], ["role", "left", "built-in"], ["role", "needs", "role"],
  ["needs", "review", "no images"], ["needs", "model", "images"], ["review", "model", "first · other"],
  ["model", "worker"],
  ["ask", "hard"],
  ["hard", "user", "hard rule", { lane: 640 }], ["hard", "deletes", "no"],
  ["deletes", "user", "no directory", { lane: 615 }], ["deletes", "tracked", "yes"], ["deletes", "jev", "no"],
  ["tracked", "user", "tracked / unknown", { lane: 565 }], ["tracked", "jev", "ignored"],
  ["jev", "user", "no key · error · unanswered", { lane: 515 }], ["jev", "floors"],
  ["floors", "user", "a floor"], ["floors", "allow", "allow"], ["floors", "deny", "deny"],
];
// Lane headers. [text, x, y]; routing sits above the first lane, permission above the second.
const STAGES = [
  [["INPUT", 100, -25], ["ROLE", 340, -25], ["NEEDS", 580, -25], ["REVIEW", 820, -25], ["MODEL", 1060, -25], ["RUN", 1300, -25],
   ["ASK", 100, 378], ["GUARD", 340, 378], ["PATHS", 580, 378], ["JEV", 1060, 378], ["FLOORS", 1300, 378], ["VERDICT", 1540, 378]],
];
const W = 170, H = 50;
const CAT_VAR = { entry: "--c-entry", route: "--c-route", guard: "--c-guard", check: "--c-check",
                  jev: "--c-jev", floor: "--c-floor", allow: "--c-allow", deny: "--c-deny", user: "--c-user" };
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

function normalize(raw) {
  const kind = raw.kind ?? (raw.role && raw.model ? "routing" : "permission");
  return { ...raw, kind, ts: raw.ts ?? raw.time };
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

// Reconstructs the walk decide() took from the recorded reason (the journal keeps verdict + reason + scores).
function permissionPath(e) {
  const dels = (e.resources ?? []).some(isDelete);
  const head = dels ? ["ask", "hard", "deletes", "tracked"] : ["ask", "hard", "deletes"];
  const r = String(e.reason ?? "");
  if (r.startsWith("always the user")) return ["ask", "hard", "user"];
  if (/project directory is unknown/.test(r)) return ["ask", "hard", "deletes", "user"];
  if (/^deletes /.test(r)) return [...head, "user"];
  const p = [...head, "jev"];
  if (/^no Jev key|^Jev failed:|^Jev unreachable:|left a question unanswered/.test(r)) return [...p, "user"];
  p.push("floors");
  if (/user must decide|deleted paths matter|too risky|unsure/.test(r)) return [...p, "user"];
  return [...p, e.verdict === "deny" ? "deny" : "allow"];
}

function pathOf(e) { return e.kind === "routing" ? routingPath(e) : permissionPath(e); }

function edgesOf(path) {
  const on = new Set();
  for (let i = 0; i + 1 < path.length; i++) on.add(`${path[i]}>${path[i + 1]}`);
  return on;
}

// [label, category] of a decision, for the list and the detail chip.
function label(e) {
  if (e.kind === "routing") return [`${e.role} → ${short(e.model)}`, "route"];
  return [String(e.verdict ?? "?"), e.verdict === "allow" ? "allow" : e.verdict === "deny" ? "deny" : "user"];
}

const said = (e) => e.kind === "routing"
  ? `${e.requested ?? e.role}: ${(e.prompt ?? "").replace("[jev-dictator]", "").trim()}`
  : `${e.agent ?? "?"} · ${e.action ?? "?"}`;

// What a decision touched, for "Used" and for filtering.
function usesOf(e) {
  if (e.kind === "routing") return [short(e.model), `role:${e.role}`];
  return [e.agent, `action:${e.action}`, `verdict:${e.verdict}`];
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
  $("count").textContent = `${items.length} decision${items.length === 1 ? "" : "s"}`;
  $("filter").hidden = !filter;
  if (filter) $("filter").textContent = `✕ ${filter.label}`;
  const box = $("entries");
  box.innerHTML = items.length ? "" : '<p class="empty" style="padding:10px">No data. Open decisions.jsonl above.</p>';
  for (const e of items) {
    const [text, cat] = label(e);
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
  for (const e of all()) for (const id of new Set(pathOf(e))) counts[id] = (counts[id] ?? 0) + 1;
  for (const [id, c] of Object.entries(countEls)) c.textContent = counts[id] ? `${counts[id]}×` : "";
}

function highlight(e) {
  const path = e ? pathOf(e) : [];
  const on = e ? edgesOf(path) : new Set();
  for (const [id, g] of Object.entries(nodeEls)) {
    g.classList.toggle("on", path.includes(id));
    g.classList.toggle("dim", !!e && !path.includes(id));
    g.querySelector("rect").style.stroke = path.includes(id) ? css(CAT_VAR[NODES[id].cat]) : "";
    subEls[id].textContent = NODES[id].s;
  }
  for (const [k, edge] of Object.entries(edgeEls)) edge.classList.toggle("on", on.has(k));
  if (!e) return;
  const write = (id, text) => { if (subEls[id]) subEls[id].textContent = truncate(text, 26); };
  if (e.kind === "routing") {
    write("role", e.requested ?? e.role);
    write("needs", /image/i.test(String(e.reason)) ? "images" : "no images");
    write("review", /another family/i.test(String(e.reason)) ? "another family" : "passes through");
    write("model", short(e.model));
    write("worker", short(e.model));
  } else {
    write("ask", `${e.agent} · ${e.action}`);
    if (/always the user/.test(String(e.reason))) write("hard", String(e.reason).replace("always the user: ", ""));
    if (/^deletes/.test(String(e.reason))) write("tracked", String(e.reason));
    write("jev", String(e.reason ?? "").replace(/^Jev: /, ""));
    if (path.includes("floors")) write("floors", String(e.reason ?? "").replace(/^Jev: /, ""));
    write(String(e.verdict), e.verdict === "user" ? "the user was asked" : "Jev's choice stands");
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
  if (e.kind === "routing") {
    parts.push(step(++n, "entry", "Delegated", `<div class="big">${esc(truncate((e.prompt ?? "").replace("[jev-dictator]", "").trim(), 400))}</div>
      <div class="kv">${esc(e.agent ?? "dictator")} → ${esc(e.requested ?? e.role)}</div>`));
    parts.push(step(++n, "route", "Routed", `<div>role <b>${esc(e.role)}</b> → ${chip(short(e.model), "route")}</div>
      <div class="kv">${esc(e.reason ?? "")}</div>`));
  } else {
    parts.push(step(++n, "entry", `Asked by ${e.agent === "dictator" ? "the dictator" : esc(e.agent)}`,
      `<div class="big">${esc(e.action)}</div>
       <div class="kv">${esc((e.resources ?? []).join(" | "))}</div>
       ${e.task ? `<div class="kv">sub-task: ${esc(truncate(e.task, 300))}</div>` : ""}
       ${e.directory ? `<div class="kv">project: ${esc(e.directory)}</div>` : ""}`));
    const guards = [];
    if (/always the user/.test(String(e.reason))) guards.push(`hard rule — ${esc(String(e.reason).replace("always the user: ", ""))}`);
    if (/^deletes/.test(String(e.reason))) guards.push(`git says: ${esc(String(e.reason))}`);
    if (/no Jev key|Jev failed|Jev unreachable/.test(String(e.reason))) guards.push("Jev unavailable → the user");
    if (guards.length) parts.push(step(++n, "guard", "Before Jev", `<div class="kv">${guards.join("<br>")}</div>`));
    parts.push(step(++n, "jev", "Jev's read", `<div class="big">${esc(String(e.reason ?? "").replace(/^Jev: /, ""))}</div>
      <div class="meters">
        ${meter("confidence", e.confidence, 1, e.confidence != null && e.confidence < 0.85)}
        ${meter("risk", e.risk, 2, e.risk != null && e.risk >= 1.5)}
        ${meter("needs_user", e.needsUser, 1, e.needsUser != null && e.needsUser >= 0.5)}
        ${e.probability == null ? "" : `<div class="meter">P(${esc(String(e.verdict))}) ${f2(e.probability)}</div>`}
        <div class="meter">Jev time ${ms(e.latencyMs)}</div>
      </div>`));
    parts.push(step(++n, cat, "Verdict", `<div>${chip(text, cat, true)}</div>
      <div class="kv">${esc(e.reason ?? "")}</div>`));
  }
  $("detail").innerHTML = `<ol class="steps">${parts.join("")}</ol>`;
}

function renderUsage() {
  const groups = {
    "Permissions by verdict": { cat: "user", rows: {}, key: (name) => `verdict:${name}` },
    "Routed to": { cat: "route", rows: {}, key: (name) => name },
    "Agents": { cat: "entry", rows: {}, key: (name) => name },
  };
  for (const e of all()) {
    if (e.kind === "routing") {
      const model = short(e.model);
      groups["Routed to"].rows[model] = (groups["Routed to"].rows[model] ?? 0) + 1;
    } else {
      const verdict = e.verdict ?? "?";
      groups["Permissions by verdict"].rows[verdict] = (groups["Permissions by verdict"].rows[verdict] ?? 0) + 1;
      const agent = e.agent ?? "?";
      groups["Agents"].rows[agent] = (groups["Agents"].rows[agent] ?? 0) + 1;
    }
  }
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
  const count = all().filter((e) => pathOf(e).includes(id)).length;
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
  const first = visible()[0];
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
