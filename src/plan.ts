// The planner subagent's plan: parsed from its final message, validated by code, turned into tasks
// (design.md §7). The planner writes; code decides whether the plan is usable.

import { roleById } from "./roles.ts"
import { DEFAULT_PRIORITY, isDone, type Acceptance, type FollowUp, type Job, type Task } from "./state.ts"

export interface PlannedTask {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly role: string
  readonly acceptance: readonly string[]
  readonly dependsOn: readonly string[]
  readonly files: readonly string[]
  readonly parent?: string // the task it was split from (N4)
  readonly priority?: number // 1 (first) .. 5 (last)
}

export interface Plan {
  readonly acceptance: readonly Acceptance[]
  readonly tasks: readonly PlannedTask[]
}

export type Parsed = { readonly plan: Plan; readonly errors?: undefined } | { readonly plan?: undefined; readonly errors: string[] }

// Roles that change files must declare what they write, so parallel safety and review have a scope.
const WRITERS = new Set(["code", "test", "visual", "write", "debug"])
const ID = /^[A-Za-z][\w.-]{0,31}$/

// The JSON object in the message: the last ```json fence, else the outermost {...}.
export function extractJson(text: string): string | undefined {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "")
  const fenced = fences.reverse().find((f) => f.trim().startsWith("{"))
  if (fenced) return fenced
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  return start >= 0 && end > start ? text.slice(start, end + 1) : undefined
}

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined

export function parsePlan(text: string): Parsed {
  const json = extractJson(text)
  if (!json) return { errors: ["no JSON object found"] }
  let raw: { acceptance?: unknown; tasks?: unknown }
  try {
    raw = JSON.parse(json)
  } catch (err) {
    return { errors: [`invalid JSON: ${err instanceof Error ? err.message : String(err)}`] }
  }
  const errors: string[] = []
  if (!Array.isArray(raw.acceptance) || raw.acceptance.length === 0) errors.push("acceptance: a non-empty list is required")
  const acceptance = parseAcceptance(raw.acceptance, errors)
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) errors.push("tasks: a non-empty list is required")
  const tasks = parseTasks(raw.tasks, errors)
  errors.push(...checkGraph(acceptance, tasks))
  return errors.length > 0 ? { errors } : { plan: { acceptance, tasks } }
}

function parseTasks(raw: unknown, errors: string[]): PlannedTask[] {
  const tasks: PlannedTask[] = []
  for (const [i, t] of (Array.isArray(raw) ? raw : []).entries()) {
    const item = t as Record<string, unknown>
    const where = `tasks[${i}]${typeof item.id === "string" ? ` (${item.id})` : ""}`
    const acc = strings(item.acceptance ?? [])
    const deps = strings(item.dependsOn ?? [])
    const files = strings(item.files ?? [])
    if (typeof item.id !== "string" || !ID.test(item.id)) errors.push(`${where}: needs an id (letters, digits, . _ -)`)
    if (typeof item.title !== "string" || !item.title.trim()) errors.push(`${where}: needs a title`)
    if (typeof item.role !== "string" || !roleById(item.role)) errors.push(`${where}: unknown role ${JSON.stringify(item.role)}`)
    if (!acc || !deps || !files) errors.push(`${where}: acceptance, dependsOn and files must be lists of strings`)
    if (typeof item.id !== "string" || typeof item.title !== "string" || typeof item.role !== "string" || !acc || !deps || !files) continue
    tasks.push({
      id: item.id,
      title: item.title,
      description: typeof item.description === "string" ? item.description : "",
      role: item.role,
      acceptance: acc,
      dependsOn: deps,
      files,
      ...(typeof item.priority === "number" && item.priority >= 1 && item.priority <= 5 ? { priority: Math.round(item.priority) } : {}),
    })
  }
  return tasks
}

function parseAcceptance(raw: unknown, errors: string[]): Acceptance[] {
  const out: Acceptance[] = []
  for (const [i, a] of (Array.isArray(raw) ? raw : []).entries()) {
    const item = a as { id?: unknown; text?: unknown; verify?: unknown }
    if (typeof item.id !== "string" || !ID.test(item.id) || typeof item.text !== "string" || !item.text.trim()) {
      errors.push(`acceptance[${i}]: needs an id and a text`)
      continue
    }
    out.push({ id: item.id, text: item.text, verify: typeof item.verify === "string" && item.verify.trim() ? item.verify : undefined })
  }
  return out
}

function checkGraph(acceptance: readonly Acceptance[], tasks: readonly PlannedTask[]): string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  for (const t of tasks) {
    if (ids.has(t.id)) errors.push(`task ${t.id}: duplicate id`)
    ids.add(t.id)
  }
  const accIds = new Set(acceptance.map((a) => a.id))
  if (accIds.size !== acceptance.length) errors.push("acceptance: duplicate id")
  const covered = new Set<string>()
  for (const t of tasks) {
    for (const d of t.dependsOn) if (!ids.has(d)) errors.push(`task ${t.id}: depends on unknown task ${d}`)
    for (const a of t.acceptance) {
      if (!accIds.has(a)) errors.push(`task ${t.id}: unknown acceptance point ${a}`)
      covered.add(a)
    }
    if (t.acceptance.length === 0) errors.push(`task ${t.id}: needs at least one acceptance point`)
    if (WRITERS.has(t.role) && t.files.length === 0) errors.push(`task ${t.id}: role ${t.role} writes, so it must declare files`)
  }
  for (const a of acceptance) if (!covered.has(a.id)) errors.push(`acceptance ${a.id}: no task covers it`)
  const cycle = findCycle(tasks)
  if (cycle) errors.push(`dependency cycle: ${cycle.join(" -> ")}`)
  return errors
}

function findCycle(tasks: readonly PlannedTask[]): string[] | undefined {
  const deps = new Map(tasks.map((t) => [t.id, t.dependsOn]))
  const state = new Map<string, "visiting" | "done">()
  const path: string[] = []
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === "done") return undefined
    if (state.get(id) === "visiting") return [...path.slice(path.indexOf(id)), id]
    state.set(id, "visiting")
    path.push(id)
    for (const d of deps.get(id) ?? []) {
      if (!deps.has(d)) continue
      const found = visit(d)
      if (found) return found
    }
    path.pop()
    state.set(id, "done")
    return undefined
  }
  for (const t of tasks) {
    const found = visit(t.id)
    if (found) return found
  }
  return undefined
}

// Wave = length of the longest dependency chain below a task; tasks of one wave may run in parallel.
export function waves(tasks: readonly PlannedTask[]): Map<string, number> {
  const deps = new Map(tasks.map((t) => [t.id, t.dependsOn]))
  const memo = new Map<string, number>()
  const wave = (id: string): number => {
    const known = memo.get(id)
    if (known !== undefined) return known
    const w = Math.max(0, ...(deps.get(id) ?? []).map((d) => wave(d) + 1))
    memo.set(id, w)
    return w
  }
  return new Map(tasks.map((t) => [t.id, wave(t.id)]))
}

// Puts a validated plan into the job: acceptance points and pending tasks.
export function applyPlan(job: Job, plan: Plan): void {
  const w = waves(plan.tasks)
  job.acceptance = [...plan.acceptance]
  job.tasks = plan.tasks.map((t): Task => ({
    id: t.id,
    title: t.title,
    description: t.description,
    role: t.role,
    acceptance: [...t.acceptance],
    dependsOn: [...t.dependsOn],
    files: [...t.files],
    wave: w.get(t.id) ?? 0,
    ...(t.parent ? { parent: t.parent } : {}),
    priority: t.priority ?? DEFAULT_PRIORITY,
    origin: t.parent ? "split" : "plan",
    status: "pending",
    attempts: 0,
    stages: [],
    signatures: [],
  }))
}

// What the planner is told to return; kept next to the parser so both change together.
export const PLAN_FORMAT = `Answer with one JSON object in a \`\`\`json fence, nothing else after it:
{
  "acceptance": [{ "id": "A1", "text": "what must hold", "verify": "a shell command that exits 0 when it holds (optional)" }],
  "tasks": [{
    "id": "T1",
    "title": "short title",
    "description": "what to do, for a worker that knows nothing else",
    "role": "explore | research | plan | code | test | visual | write | debug | review | oracle",
    "acceptance": ["A1"],
    "dependsOn": [],
    "files": ["paths this task may change; empty for read-only roles"],
    "priority": 3
  }]
}
Rules: split the job into tasks as small as possible, each a vertical slice that can be verified on its own;
every acceptance point is covered by a task; a task that changes files lists them; no dependency cycles.
Priority is 1 (do first) to 5 (do last), 3 when nothing stands out; among ready tasks the lower number runs first.`

// --- N4: splitting tasks (design.md §7) -------------------------------------------------------------------

export const MAX_SPLIT_LEVEL = 2

export function splitFormat(ids: readonly string[]): string {
  return `Split these tasks into smaller ones: ${ids.join(", ")}.
Answer with one JSON object in a \`\`\`json fence, nothing else after it:
{
  "acceptance": [{ "id": "A7", "text": "...", "verify": "..." }],
  "splits": { "${ids[0] ?? "T1"}": [{ "id": "${ids[0] ?? "T1"}.1", "title": "...", "description": "...", "role": "...", "acceptance": ["A1"], "dependsOn": [], "files": ["..."] }] }
}
Rules: each split task becomes at least two tasks with ids "<task>.1", "<task>.2", …; each is a vertical slice with its
own acceptance point (reuse the task's points or add new ones under "acceptance"), changes only files of the task it
comes from, and may depend on its siblings and on the tasks the original depended on. Together they cover all of the
original's acceptance points. Do not split a task when the parts could only be checked together.`
}

// Puts the planner's splits into the plan: children replace their parent, tasks that waited for the parent wait for
// its last children. Code re-validates the whole graph.
export function applySplits(plan: Plan, text: string, asked: readonly string[]): Parsed {
  const json = extractJson(text)
  if (!json) return { errors: ["no JSON object found"] }
  let raw: { acceptance?: unknown; splits?: unknown }
  try {
    raw = JSON.parse(json)
  } catch (err) {
    return { errors: [`invalid JSON: ${err instanceof Error ? err.message : String(err)}`] }
  }
  const errors: string[] = []
  const added = parseAcceptance(raw.acceptance, errors)
  const splits = raw.splits && typeof raw.splits === "object" ? (raw.splits as Record<string, unknown>) : {}
  const children = new Map<string, PlannedTask[]>()
  for (const [parentId, list] of Object.entries(splits)) {
    const parent = plan.tasks.find((t) => t.id === parentId)
    if (!parent || !asked.includes(parentId)) {
      errors.push(`splits.${parentId}: not one of the tasks to split`)
      continue
    }
    const kidErrors: string[] = []
    const kids = parseTasks(list, kidErrors)
    errors.push(...kidErrors.map((e) => `splits.${parentId}: ${e}`))
    if (!Array.isArray(list) || list.length < 2) errors.push(`splits.${parentId}: a split needs at least two tasks`)
    for (const k of kids) {
      if (!k.id.startsWith(`${parentId}.`)) errors.push(`splits.${parentId}: ${k.id} must be named ${parentId}.<n>`)
      if (parent.files.length && k.files.some((f) => !parent.files.includes(f))) errors.push(`splits.${parentId}: ${k.id} changes files outside ${parentId}'s`)
    }
    const covered = new Set(kids.flatMap((k) => k.acceptance))
    for (const a of parent.acceptance) if (!covered.has(a)) errors.push(`splits.${parentId}: no part covers ${a}`)
    if (kids.length >= 2 && kids.every((k) => k.files.join() === kids[0]!.files.join() && k.acceptance.join() === kids[0]!.acceptance.join())) {
      errors.push(`splits.${parentId}: the parts share files and acceptance points, so the split only adds coordination`)
    }
    children.set(parentId, kids)
  }
  if (errors.length) return { errors }
  // The last children of a split: the ones no sibling depends on.
  const sinks = (id: string) => {
    const kids = children.get(id)!
    return kids.filter((k) => !kids.some((o) => o.dependsOn.includes(k.id))).map((k) => k.id)
  }
  const rewire = (deps: readonly string[]) => deps.flatMap((d) => (children.has(d) ? sinks(d) : [d]))
  const tasks = plan.tasks.flatMap((t) =>
    children.has(t.id)
      ? children.get(t.id)!.map((k) => ({ ...k, parent: t.id, dependsOn: [...new Set([...rewire(k.dependsOn), ...rewire(t.dependsOn)])] }))
      : [{ ...t, dependsOn: rewire(t.dependsOn) }],
  )
  const acceptance = [...plan.acceptance, ...added]
  const graph = checkGraph(acceptance, tasks)
  return graph.length ? { errors: graph } : { plan: { acceptance, tasks } }
}

// --- N7: a worker's follow-up becomes a task (design.md §8) --------------------------------------------------

// The task a follow-up becomes: a code task on the files it names, with its own acceptance point, after the task
// that found it. Code builds it (no planner call); N5 classifies it like any other task when it is dispatched.
// Returns the errors instead when the job's graph would break.
export function addDiscovered(job: Job, from: Task, item: FollowUp, priority: number): { task?: Task; errors?: string[] } {
  const n = job.tasks.filter((t) => t.id.startsWith(`${from.id}.d`)).length + 1
  const point = `A${Math.max(0, ...job.acceptance.map((a) => Number(a.id.match(/^A(\d+)$/)?.[1] ?? 0))) + 1}`
  const task: Task = {
    id: `${from.id}.d${n}`,
    title: item.what.slice(0, 120),
    description: `Found while doing ${from.id} (${from.title}): ${item.what}. Why: ${item.why}`,
    role: "code",
    acceptance: [point],
    dependsOn: [from.id],
    files: [...item.files],
    wave: from.wave + 1,
    status: "pending",
    attempts: 0,
    stages: [],
    signatures: [],
    priority,
    origin: "discovered",
  }
  const acceptance = [...job.acceptance, { id: point, text: item.what }]
  const errors = checkGraph(acceptance, [...job.tasks.map(asPlanned), asPlanned(task)])
  if (errors.length) return { errors }
  job.acceptance = acceptance
  job.tasks.push(task)
  return { task }
}

const asPlanned = (t: Task): PlannedTask => ({ id: t.id, title: t.title, description: t.description, role: t.role, acceptance: t.acceptance, dependsOn: t.dependsOn, files: t.files })

// --- replan (design.md §10.2, Magentic-One) -----------------------------------------------------------------

export function replanFormat(job: Job): string {
  const done = job.tasks.filter(isDone)
  const open = job.tasks.filter((t) => !isDone(t) && t.status !== "cancelled")
  return `The job is stalled. Rewrite the unfinished part of the plan.

Done (keep, do not repeat; new tasks may depend on them): ${done.map((t) => `${t.id} ${t.title}`).join("; ") || "none"}
Unfinished (these are replaced by your tasks):
${open.map((t) => `- ${t.id} [${t.role}] ${t.title} (${t.status}${t.stages.length ? `; last: ${t.stages.at(-1)!.stage} ${t.stages.at(-1)!.result}${t.stages.at(-1)!.evidence ? `: ${t.stages.at(-1)!.evidence!.slice(0, 200)}` : ""}` : ""})`).join("\n") || "- none"}
What went wrong so far: ${job.lessons.slice(-5).join("; ") || "nothing recorded"}
Acceptance points: ${job.acceptance.map((a) => `${a.id}: ${a.text}${a.verify ? ` (verify: ${a.verify})` : ""}`).join("; ")}

First find the root cause of the stall from the facts above; then plan around it, e.g. a smaller step, another
order, or a task that removes the obstacle. Use new task ids that are not used yet; you may add acceptance points with
new ids, and keep the verify commands of existing ones.
${PLAN_FORMAT.replace('"acceptance": [{', '"acceptance": [(only new points) {')}`
}

// Replaces the unfinished tasks with the planner's new ones; done tasks and their commits stay. The old unfinished
// tasks are cancelled, so their history stays in the job file.
export function applyReplan(job: Job, text: string): Parsed {
  const json = extractJson(text)
  if (!json) return { errors: ["no JSON object found"] }
  let raw: { acceptance?: unknown; tasks?: unknown }
  try {
    raw = JSON.parse(json)
  } catch (err) {
    return { errors: [`invalid JSON: ${err instanceof Error ? err.message : String(err)}`] }
  }
  const errors: string[] = []
  const added = parseAcceptance(raw.acceptance ?? [], errors).filter((a) => !job.acceptance.some((x) => x.id === a.id))
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) errors.push("tasks: a non-empty list is required")
  const fresh = parseTasks(raw.tasks, errors)
  const used = new Set(job.tasks.map((t) => t.id))
  for (const t of fresh) if (used.has(t.id)) errors.push(`task ${t.id}: id already used; pick a new one`)
  const done = job.tasks.filter(isDone).map(asPlanned)
  const acceptance = [...job.acceptance, ...added]
  errors.push(...checkGraph(acceptance, [...done, ...fresh]))
  return errors.length ? { errors } : { plan: { acceptance, tasks: fresh } }
}

// --- delegated tasks (omo-hybrid): the orchestrator adds one task at a time to its session's rolling job ---------

export interface Delegation {
  readonly title: string
  readonly prompt: string
  readonly files: readonly string[] // what the task may change; empty for a reader
  readonly dependsOn: readonly string[]
  readonly priority?: number
  readonly checks: readonly string[] // shell commands that exit 0 when the task is done
}

// The task a delegation becomes: a code task when it names files, an explore task when not (N5 may pick another role
// when it is dispatched); its checks are its acceptance point. Returns the errors instead when the graph would break.
export function addDelegated(job: Job, d: Delegation): { task?: Task; errors?: string[] } {
  const n = Math.max(0, ...job.tasks.map((t) => Number(t.id.match(/^T(\d+)$/)?.[1] ?? 0))) + 1
  const point = `A${Math.max(0, ...job.acceptance.map((a) => Number(a.id.match(/^A(\d+)$/)?.[1] ?? 0))) + 1}`
  const byId = new Map(job.tasks.map((t) => [t.id, t]))
  const task: Task = {
    id: `T${n}`,
    title: d.title.slice(0, 120),
    description: d.prompt,
    role: d.files.length ? "code" : "explore",
    acceptance: [point],
    dependsOn: [...d.dependsOn],
    files: [...d.files],
    wave: Math.max(-1, ...d.dependsOn.map((id) => byId.get(id)?.wave ?? 0)) + 1,
    status: "pending",
    attempts: 0,
    stages: [],
    signatures: [],
    priority: d.priority !== undefined && d.priority >= 1 && d.priority <= 5 ? Math.round(d.priority) : DEFAULT_PRIORITY,
    origin: "delegated",
  }
  const acceptance = [...job.acceptance, { id: point, text: d.title, ...(d.checks.length ? { verify: d.checks.join(" && ") } : {}) }]
  const errors = checkGraph(acceptance, [...job.tasks.map(asPlanned), asPlanned(task)])
  if (errors.length) return { errors }
  job.acceptance = acceptance
  job.tasks.push(task)
  return { task }
}
