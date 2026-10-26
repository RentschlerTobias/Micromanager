// The job backlog (design.md §25, P6): jobs that wait, one Markdown file each in <project>/.micromanager/backlog/,
// committed with the project. A job's follow-ups that nobody started and a trial whose attempts all failed become
// drafts here when the job ends, so nothing found on the way is lost with the session; the user or the micromanager
// starts an item later with plan_job backlog:<slug>, or as todos.
//
// Items are jobs, never a job's internal tasks: those are short-lived and live in the job file. The format is the same
// for every backend: a YAML front matter (a small subset: scalars, lists of scalars, lists of one-level maps, and
// JSON values) and a Markdown body; the GitHub backend (P7) puts the same text into an issue.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { checkProblem } from "./plan.ts"
import { failureDigest } from "./trials.ts"
import { stateDir } from "./store.ts"
import type { Job, Later, Task } from "./state.ts"

export type ItemStatus = "draft" | "ready" | "running" | "done" | "dropped"
export type ItemKind = "build" | "fix" | "optimize"

export interface BacklogItem {
  readonly slug: string // the file name without .md
  title: string
  status: ItemStatus
  order: number // lower runs first; steps of 10 leave room
  kind: ItemKind
  origin: "user" | "later" | "trial-failed"
  from?: string // the job and task it came from: "job-…/T7"
  job?: string // the job that works on it, once started
  acceptance: { text: string; verify?: string }[]
  checks: string[]
  fitness?: Record<string, unknown> // a contract as the contract tool takes it (src/contract.ts)
  created: string
  body: string
}

const STATUSES = new Set<ItemStatus>(["draft", "ready", "running", "done", "dropped"])
const KINDS = new Set<ItemKind>(["build", "fix", "optimize"])

export function backlogDir(project: string): string {
  return join(project, stateDir(project), "backlog")
}

// --- the front matter -------------------------------------------------------------------------------------------

type Value = string | number | boolean | null | Value[] | { [k: string]: Value }

function scalar(text: string): Value {
  const t = text.trim()
  if (t === "" || t === "~" || t === "null") return null
  if (t === "true" || t === "false") return t === "true"
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  if (t.startsWith('"') || t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t) as Value
    } catch {
      return t
    }
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length > 1) return t.slice(1, -1).replace(/''/g, "'")
  return t.replace(/\s+#.*$/, "") // a comment after a plain value
}

// The subset of YAML the backlog writes, read back: "key: value", "key:" followed by "- item" lines, and an item that is
// a map of its own ("- text: …" with "verify: …" indented below it).
export function parseFrontMatter(text: string): Record<string, Value> {
  const out: Record<string, Value> = {}
  let list: Value[] | undefined
  let map: Record<string, Value> | undefined
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    if (indent === 0) {
      const m = line.match(/^([\w-]+):\s*(.*)$/)
      if (!m) continue
      list = undefined
      map = undefined
      if (m[2] === "") out[m[1]!] = list = []
      else out[m[1]!] = scalar(m[2]!)
      continue
    }
    if (!list) continue
    if (line.startsWith("- ")) {
      const item = line.slice(2)
      const kv = item.match(/^([\w-]+):\s+(.*)$|^([\w-]+):$/)
      if (kv && !item.startsWith('"')) {
        map = { [kv[1] ?? kv[3]!]: scalar(kv[2] ?? "") }
        list.push(map)
      } else {
        map = undefined
        list.push(scalar(item))
      }
    } else if (map) {
      const kv = line.match(/^([\w-]+):\s*(.*)$/)
      if (kv) map[kv[1]!] = scalar(kv[2]!)
    }
  }
  return out
}

// A string as the front matter writes it: plain when YAML reads it back as the same string, else JSON (a valid YAML
// double-quoted scalar).
function plain(s: string): string {
  return /^[\w][\w ./@+()-]*$/.test(s) && !/^(true|false|null|~|-?\d+(\.\d+)?)$/.test(s) && !/\s$/.test(s) ? s : JSON.stringify(s)
}

export function renderItem(item: BacklogItem): string {
  const lines = [
    "---",
    `title: ${plain(item.title)}`,
    `status: ${item.status}`,
    `order: ${item.order}`,
    `kind: ${item.kind}`,
    `origin: ${item.origin}`,
    ...(item.from ? [`from: ${plain(item.from)}`] : []),
    ...(item.job ? [`job: ${plain(item.job)}`] : []),
    `created: ${item.created}`,
  ]
  if (item.acceptance.length) {
    lines.push("acceptance:")
    for (const a of item.acceptance) lines.push(`  - text: ${plain(a.text)}`, ...(a.verify ? [`    verify: ${plain(a.verify)}`] : []))
  }
  if (item.checks.length) lines.push("checks:", ...item.checks.map((c) => `  - ${plain(c)}`))
  if (item.fitness) lines.push(`fitness: ${JSON.stringify(item.fitness)}`)
  lines.push("---", "", item.body.trim(), "")
  return lines.join("\n")
}

// An item from its file's text; errors name what is wrong instead.
export function parseItem(text: string, slug: string): { item?: BacklogItem; errors: string[] } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return { errors: [`${slug}: no front matter between --- lines`] }
  const f = parseFrontMatter(m[1]!)
  const errors: string[] = []
  const title = typeof f.title === "string" ? f.title.trim() : ""
  if (!title) errors.push(`${slug}: title is missing`)
  const status = STATUSES.has(f.status as ItemStatus) ? (f.status as ItemStatus) : f.status === undefined ? "draft" : undefined
  if (!status) errors.push(`${slug}: status must be one of ${[...STATUSES].join(", ")}`)
  const kind = KINDS.has(f.kind as ItemKind) ? (f.kind as ItemKind) : f.kind === undefined ? "build" : undefined
  if (!kind) errors.push(`${slug}: kind must be one of ${[...KINDS].join(", ")}`)
  const acceptance = (Array.isArray(f.acceptance) ? f.acceptance : []).flatMap((a) => {
    if (typeof a === "string") return [{ text: a }]
    if (a && typeof a === "object" && !Array.isArray(a) && typeof a.text === "string") return [{ text: a.text, ...(typeof a.verify === "string" && a.verify ? { verify: a.verify } : {}) }]
    return []
  })
  const checks = (Array.isArray(f.checks) ? f.checks : []).filter((c): c is string => typeof c === "string" && c.trim() !== "")
  const fitness = f.fitness && typeof f.fitness === "object" && !Array.isArray(f.fitness) ? (f.fitness as Record<string, unknown>) : undefined
  if (errors.length) return { errors }
  return {
    item: {
      slug,
      title,
      status: status!,
      order: typeof f.order === "number" ? f.order : 100,
      kind: kind!,
      origin: f.origin === "later" || f.origin === "trial-failed" ? f.origin : "user",
      ...(typeof f.from === "string" ? { from: f.from } : {}),
      ...(typeof f.job === "string" ? { job: f.job } : {}),
      acceptance,
      checks,
      ...(fitness ? { fitness } : {}),
      created: typeof f.created === "string" ? f.created : String(f.created ?? ""),
      body: m[2]!.trim(),
    },
    errors,
  }
}

// --- storage ----------------------------------------------------------------------------------------------------

// Where items live. Local files by default; the GitHub backend (P7) implements the same three calls.
export interface BacklogBackend {
  list(project: string): BacklogItem[]
  get(project: string, slug: string): BacklogItem | undefined
  save(project: string, item: BacklogItem): string // where it went
}

export const localBackend: BacklogBackend = {
  list(project) {
    const dir = backlogDir(project)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .flatMap((f) => parseItem(readFileSync(join(dir, f), "utf8"), f.slice(0, -3)).item ?? [])
      .sort(byTurn)
  },
  get(project, slug) {
    const path = join(backlogDir(project), `${slug}.md`)
    return existsSync(path) ? parseItem(readFileSync(path, "utf8"), slug).item : undefined
  },
  save(project, item) {
    const path = join(backlogDir(project), `${item.slug}.md`)
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, renderItem(item))
    renameSync(tmp, path)
    return path
  },
}

// What runs first: the open items before the closed ones, ready before draft, then by order, then the oldest.
const RANK: Record<ItemStatus, number> = { running: 0, ready: 1, draft: 2, done: 3, dropped: 4 }
export function byTurn(a: BacklogItem, b: BacklogItem): number {
  return RANK[a.status] - RANK[b.status] || a.order - b.order || a.created.localeCompare(b.created) || a.slug.localeCompare(b.slug)
}

// A file name from a title: lowercase words joined by dashes, at most six of them, unique among taken.
export function slugOf(title: string, taken: ReadonlySet<string>): string {
  const base = title.toLowerCase().replace(/[äöüß]/g, (c) => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" })[c]!).split(/[^a-z0-9]+/).filter(Boolean).slice(0, 6).join("-") || "item"
  let slug = base
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
  return slug
}

// --- drafts at a job's end --------------------------------------------------------------------------------------

function today(now: Date): string {
  return now.toISOString().slice(0, 10)
}

// A follow-up a worker reported that no task of its job took up.
export function draftFromLater(l: Later, job: Job, taken: ReadonlySet<string>, now = new Date()): BacklogItem {
  return {
    slug: slugOf(l.what, taken),
    title: l.what.slice(0, 120),
    status: "draft",
    order: 100,
    kind: /\b(fix|bug|broken|fails?|crash)/i.test(l.what) ? "fix" : "build",
    origin: "later",
    from: `${job.id}/${l.from}`,
    acceptance: [],
    checks: [],
    created: today(now),
    body: [`## Goal\n${l.what}`, l.why ? `## Why\n${l.why}` : "", l.files.length ? `## Files\n${l.files.join(", ")}` : "", `Found by ${l.from} of ${job.id} (${job.goal.split("\n")[0]!.slice(0, 120)}).`].filter(Boolean).join("\n\n"),
  }
}

// A task whose trial failed on every attempt (k = 0) and that nothing did over: too big or too unclear for one worker,
// so it comes back as a job of its own, with what each attempt hit.
export function draftFromTrial(job: Job, head: Task, failed: readonly Task[], checks: readonly string[], taken: ReadonlySet<string>, now = new Date()): BacklogItem {
  const title = head.title.replace(/ \(attempt \d+\/\d+\)$/, "")
  return {
    slug: slugOf(title, taken),
    title: title.slice(0, 120),
    status: "draft",
    order: 100,
    kind: head.contract ? "optimize" : "build",
    origin: "trial-failed",
    from: `${job.id}/${head.id}`,
    acceptance: [],
    checks: [...checks],
    created: today(now),
    body: [`## Goal\n${head.description}`, `## What the ${failed.length} attempts hit\n${failureDigest(failed)}`, "Split it into smaller tasks before it runs again."].join("\n\n"),
  }
}

// The goal plan_job plans from, for an item: its title, body, acceptance points and checks in words the planner reads.
export function goalOf(item: BacklogItem): string {
  return [
    item.title,
    item.body,
    item.acceptance.length ? `Acceptance:\n${item.acceptance.map((a) => `- ${a.text}${a.verify ? ` (checked with: ${a.verify})` : ""}`).join("\n")}` : "",
    item.checks.length ? `Checks: ${item.checks.join("; ")}` : "",
    item.fitness ? `Fitness contract to define first with the contract tool: ${JSON.stringify(item.fitness)}` : "",
    `(backlog item ${item.slug})`,
  ].filter(Boolean).join("\n\n")
}

// --- the backlog tool -------------------------------------------------------------------------------------------

// The micromanager's backlog tool: list, show, add or set an item. Returns its answer.
// add takes {"title", "kind", "goal", "acceptance": [{"text", "verify"}], "checks": [...], "fitness": {...}, "order",
// "status"}; set takes "status=ready" or "order=10".
export function backlogTool(project: string, action: string, slug: string, value: string, backend: BacklogBackend = localBackend, now = new Date()): string {
  const a = action.trim().toLowerCase()
  const items = backend.list(project)
  if (a === "" || a === "list") {
    const open = items.filter((i) => i.status !== "done" && i.status !== "dropped")
    const closed = items.length - open.length
    if (!items.length) return `The backlog of this project is empty (${relativeDir(project)}/).`
    return [
      `Backlog (${relativeDir(project)}/), in the order it runs:`,
      ...open.map((i) => `- ${i.slug} [${i.status}, ${i.kind}, order ${i.order}] ${i.title}${i.job ? ` (job ${i.job})` : ""}${i.origin !== "user" ? ` · from ${i.from ?? i.origin}` : ""}`),
      closed ? `${closed} done or dropped.` : "",
      "Start one with plan_job and the goal backlog:<slug>, or write its tasks as todos.",
    ].filter(Boolean).join("\n")
  }
  if (a === "show") {
    const item = backend.get(project, slug.trim())
    return item ? renderItem(item) : `There is no backlog item ${slug.trim()}.`
  }
  if (a === "add") {
    let o: Record<string, unknown>
    try {
      o = JSON.parse(value) as Record<string, unknown>
    } catch (err) {
      return `Not added: value is no JSON object (${err instanceof Error ? err.message : String(err)}).`
    }
    const title = typeof o.title === "string" ? o.title.trim() : ""
    if (!title) return "Not added: an item needs a title."
    const kind = KINDS.has(o.kind as ItemKind) ? (o.kind as ItemKind) : "build"
    const checks = (Array.isArray(o.checks) ? o.checks : []).map(String).map((c) => c.trim()).filter(Boolean)
    const bad = checks.map(checkProblem).find(Boolean)
    if (bad) return `Not added: ${bad}`
    const item: BacklogItem = {
      slug: slugOf(title, new Set(items.map((i) => i.slug))),
      title: title.slice(0, 120),
      status: o.status === "ready" ? "ready" : "draft",
      order: typeof o.order === "number" ? o.order : 100,
      kind,
      origin: "user",
      acceptance: (Array.isArray(o.acceptance) ? o.acceptance : []).flatMap((x) => {
        const p = (typeof x === "string" ? { text: x } : x) as { text?: unknown; verify?: unknown }
        return typeof p?.text === "string" && p.text.trim() ? [{ text: p.text.trim(), ...(typeof p.verify === "string" && p.verify.trim() ? { verify: p.verify.trim() } : {}) }] : []
      }),
      checks,
      ...(o.fitness && typeof o.fitness === "object" && !Array.isArray(o.fitness) ? { fitness: o.fitness as Record<string, unknown> } : {}),
      created: today(now),
      body: `## Goal\n${typeof o.goal === "string" && o.goal.trim() ? o.goal.trim() : title}`,
    }
    if (kind === "optimize" && !item.fitness) item.body += "\n\nNeeds a fitness contract before it can run: what is measured, which way is better, what must not get worse."
    return `Added ${item.slug} (${item.status}) to the backlog: ${backend.save(project, item)}.`
  }
  if (a === "set") {
    const item = backend.get(project, slug.trim())
    if (!item) return `There is no backlog item ${slug.trim()}.`
    const m = value.trim().match(/^(status|order)\s*=\s*(\S+)$/i)
    if (!m) return 'Not changed: value is "status=<draft|ready|running|done|dropped>" or "order=<number>".'
    if (m[1]!.toLowerCase() === "status") {
      if (!STATUSES.has(m[2] as ItemStatus)) return `Not changed: status is one of ${[...STATUSES].join(", ")}.`
      item.status = m[2] as ItemStatus
    } else {
      const n = Number(m[2])
      if (!Number.isFinite(n)) return "Not changed: order is a number."
      item.order = n
    }
    backend.save(project, item)
    return `${item.slug} is ${item.status}, order ${item.order}.`
  }
  return 'action is "list", "show", "add" or "set".'
}

function relativeDir(project: string): string {
  return join(stateDir(project), "backlog")
}
