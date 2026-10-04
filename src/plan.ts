// The planner subagent's plan: parsed from its final message, validated by code, turned into tasks
// (design.md §7). The planner writes; code decides whether the plan is usable.

import { roleById } from "./roles.ts"
import type { Acceptance, Job, Task } from "./state.ts"

export interface PlannedTask {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly role: string
  readonly acceptance: readonly string[]
  readonly dependsOn: readonly string[]
  readonly files: readonly string[]
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
  const acceptance: Acceptance[] = []
  if (!Array.isArray(raw.acceptance) || raw.acceptance.length === 0) errors.push("acceptance: a non-empty list is required")
  for (const [i, a] of (Array.isArray(raw.acceptance) ? raw.acceptance : []).entries()) {
    const item = a as { id?: unknown; text?: unknown; verify?: unknown }
    if (typeof item.id !== "string" || !ID.test(item.id) || typeof item.text !== "string" || !item.text.trim()) {
      errors.push(`acceptance[${i}]: needs an id and a text`)
      continue
    }
    acceptance.push({ id: item.id, text: item.text, verify: typeof item.verify === "string" && item.verify.trim() ? item.verify : undefined })
  }
  const tasks: PlannedTask[] = []
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) errors.push("tasks: a non-empty list is required")
  for (const [i, t] of (Array.isArray(raw.tasks) ? raw.tasks : []).entries()) {
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
    })
  }
  errors.push(...checkGraph(acceptance, tasks))
  return errors.length > 0 ? { errors } : { plan: { acceptance, tasks } }
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
    "files": ["paths this task may change; empty for read-only roles"]
  }]
}
Rules: split the job into tasks as small as possible, each a vertical slice that can be verified on its own;
every acceptance point is covered by a task; a task that changes files lists them; no dependency cycles.`
