// N5 + N5b: one decision request per task classifies it and sets its profile (design.md §8.1). Code combines the
// isolated answers: the role matrix is the upper bound, a profile only narrows it, and a contradiction is cut
// back to the matrix at the cost of confidence.

import type { Asked } from "./backends.ts"
import { CHOICE_FLOOR, CLASSIFY, NOUL_FLOOR, roleChoice, RISKS, skillQuestion, type Risk } from "./catalog.ts"
import type { Question } from "./jev.ts"
import { recallQuestions, recalled } from "./memory.ts"
import { resolvePolicy, type Policies } from "./policy.ts"
import { ROLES, roleById, type Role, type Rule } from "./roles.ts"
import type { Acceptance, Task } from "./state.ts"

export type PermProfile = "strict" | "normal" | "trusted"
export type BudgetTier = "S" | "M" | "L"
export type ToolGroup = "shell" | "web"

// Profiles deny tool groups, never single tools: in Phase A a worker without read read the file through grep.
export const TOOL_GROUPS: Record<ToolGroup, readonly string[]> = {
  shell: ["shell"],
  web: ["webfetch", "websearch"],
}

// What a role is for: these groups are never narrowed away from it.
const ROLE_NEEDS: Partial<Record<string, readonly ToolGroup[]>> = { test: ["shell"], review: ["shell"], research: ["web"] }

// Roles that change files; a task with declared files needs one of them, a task without files must not get one. The
// gitmaster is deliberately not one: it edits no declared file, works in the checkout, and is never picked by the
// classifier (see classifyQuestions) — the plugin names it when a job is finished.
export const WRITERS = new Set(["code", "test", "visual", "write", "debug"])

export interface Skill {
  readonly name: string
  readonly description: string
  readonly roles: readonly string[] // the roles that may load it
}

export interface Profile {
  readonly role: string
  readonly roleReason: string
  readonly difficulty: number // 0..1, picks the model tier
  readonly risk: Risk
  readonly testOracle: boolean
  readonly testFirst: boolean
  readonly bugFix: boolean
  readonly approachUncertain: boolean
  readonly bugUnknownCause: boolean
  readonly vision: boolean // routed to a model with image input
  readonly tools: Readonly<Record<ToolGroup, number | undefined>> // the decision model's yes per group; undefined: not asked
  readonly skills: readonly string[]
  readonly perm: PermProfile
  readonly budget: BudgetTier
  readonly injection: boolean
  readonly confidence: number // the weakest choice confidence, lowered by contradictions; 1 without a model
  readonly source: "model" | "rules"
  readonly decision?: string // journal id
  readonly recall?: readonly string[] // the project memory entries N5 picked for this task's brief
  confirmed?: boolean // the user saw it (policy "ask")
}

// The questions for one task: the fixed set, the role choice, and one noul per skill the planner's role may load.
export function classifyQuestions(task: Task, skills: readonly Skill[], memory: readonly string[] = []): Record<string, Question> {
  // The gitmaster is not offered: it is not a role a task can be classified into. The plugin names it when a job is
  // finished and the user agreed to the merge, and it works in the checkout, so a classifier that picked it for an
  // ordinary task would put that task in the user's checkout.
  const roles = Object.fromEntries(ROLES.filter((r) => r.id !== "gitmaster").map((r) => [r.id, r.description]))
  const allowed = skills.filter((s) => s.roles.includes(task.role))
  return {
    role: roleChoice(roles),
    ...CLASSIFY,
    ...Object.fromEntries(allowed.map((s) => [`skill.${s.name}`, skillQuestion(s.name, s.description)])),
    ...recallQuestions(memory),
  }
}

// The task alone, not the job (Phase D: a new function in a job that also fixed a bug was classified as a bug fix).
// Probe on that case: is_bug_fix 0.91 with the goal, 0.84 with it as background, 0.08 without it, while the bug fix
// task itself stays at 0.94. The planner writes each task's description for a worker that knows nothing else.
export function classifyState(_goal: string, task: Task, acceptance: readonly Acceptance[]): Record<string, unknown> {
  return {
    task: { id: task.id, title: task.title, description: task.description, files: task.files, plannerRole: task.role },
    acceptance: acceptance.map((a) => `${a.text}${a.verify ? ` (checked with: ${a.verify})` : ""}`),
  }
}

// A role can use an action unless it denies it outright with no exception (review denies shell but allows test
// runners and linters, so it can run the tests).
const canUse = (role: Role, action: string) =>
  !role.rules.some((r) => r.action === action && r.resource === "*" && r.effect === "deny") ||
  role.rules.some((r) => r.action === action && r.resource !== "*" && r.effect !== "deny")

// The first role in the same write class that may use the group, for a task whose role cannot do what it needs.
function roleThatCan(group: ToolGroup, writer: boolean): Role | undefined {
  const order = writer ? ["code", "test", "debug", "visual"] : ["review", "research", "explore"]
  return order.map((id) => roleById(id)!).find((r) => TOOL_GROUPS[group].every((a) => canUse(r, a)))
}

const MAX_SKILLS = 3

export function combine(task: Task, acceptance: readonly Acceptance[], asked: Asked | undefined, policies: Policies, skills: readonly Skill[] = [], memory: readonly string[] = []): Profile {
  const a = asked?.decision.answers ?? {}
  const noul = (q: string) => (a[q]?.type === "noul" ? (a[q] as { noul: number }).noul : undefined)
  const yes = (q: string) => (noul(q) ?? 0) >= NOUL_FLOOR
  const choice = (q: string) => (a[q]?.type === "choice" ? (a[q] as { choice: string; confidence: number }) : undefined)
  const fixed = (key: string) => {
    const p = resolvePolicy(`N5.${key}`, policies).policy
    return p.kind === "fixed" ? p.value : undefined
  }
  let confidence = 1
  const take = <T extends string>(q: string, allowed: readonly string[], fallback: T): T => {
    const c = choice(q)
    if (!c || c.confidence < CHOICE_FLOOR || !allowed.includes(c.choice)) return fallback
    confidence = Math.min(confidence, c.confidence)
    return c.choice as T
  }

  // Role: the planner's, unless the model is sure of another in the same write class, or the user pinned one.
  const writer = task.files.length > 0
  let role = task.role
  let roleReason = "the planner's role"
  const pinnedRole = fixed("role")
  const modelRole = choice("role")
  if (pinnedRole && roleById(pinnedRole)) [role, roleReason] = [pinnedRole, "preset"]
  else if (modelRole && modelRole.choice !== role && modelRole.confidence >= CHOICE_FLOOR && WRITERS.has(modelRole.choice) === writer) {
    ;[role, roleReason] = [modelRole.choice, `the decision model (${modelRole.confidence.toFixed(2)}) over the planner's ${task.role}`]
    confidence = Math.min(confidence, modelRole.confidence)
  }

  // A task that needs a group its role denies gets a role that has it (live test: "run the tests" went to oracle,
  // which has no shell, and the worker could only read). Without a model answer, a verify command means shell.
  const tools: Record<ToolGroup, number | undefined> = { shell: noul("tool.shell"), web: noul("tool.web") }
  let penalty = 1 // each contradiction cut back to the matrix
  const needsShell = tools.shell !== undefined ? tools.shell >= NOUL_FLOOR : !writer && acceptance.some((x) => x.verify) && /\b(run|test|build|lint)/i.test(`${task.title} ${task.description}`)
  for (const [group, needed] of [["shell", needsShell], ["web", tools.web !== undefined && tools.web >= NOUL_FLOOR]] as const) {
    const current = roleById(role)!
    if (!needed || TOOL_GROUPS[group].every((x) => canUse(current, x))) continue
    const other = pinnedRole ? undefined : roleThatCan(group, writer)
    if (other) [role, roleReason] = [other.id, `${current.id} has no ${group}, the task needs it`]
    penalty *= 0.8
  }

  const score = a.difficulty?.type === "score" ? a.difficulty.score : undefined
  const pinnedDifficulty = Number(fixed("difficulty"))
  const difficulty = Number.isFinite(pinnedDifficulty) && fixed("difficulty") !== undefined ? Math.max(0, Math.min(1, pinnedDifficulty)) : score !== undefined ? Math.max(0, Math.min(4, score)) / 4 : 0.5
  const risk = (fixed("risk") as Risk | undefined) ?? take<Risk>("risk", Object.keys(RISKS), "internal")
  const perm = (fixed("perm_profile") as PermProfile | undefined) ?? take<PermProfile>("perm_profile", ["strict", "normal", "trusted"], "strict")
  const budget = (fixed("budget_tier") as BudgetTier | undefined) ?? take<BudgetTier>("budget_tier", ["S", "M", "L"], "M")
  const picked = skills
    .filter((s) => s.roles.includes(role))
    .map((s) => ({ name: s.name, p: noul(`skill.${s.name}`) ?? 0 }))
    .filter((s) => s.p >= NOUL_FLOOR)
    .sort((x, y) => y.p - x.p)
    .slice(0, MAX_SKILLS)
    .map((s) => s.name)
  return {
    role,
    roleReason,
    difficulty,
    risk,
    testOracle: noul("has_test_oracle") !== undefined ? yes("has_test_oracle") : acceptance.some((x) => x.verify),
    testFirst: yes("test_first_possible"),
    bugFix: yes("is_bug_fix"),
    approachUncertain: yes("approach_uncertain"),
    bugUnknownCause: yes("bug_unknown_cause"),
    vision: yes("needs_vision"),
    tools,
    skills: picked,
    perm,
    budget,
    injection: yes("injection"),
    confidence: confidence * penalty,
    source: asked && Object.keys(a).length > 0 ? "model" : "rules",
    decision: asked?.id,
    recall: recalled(memory, a as never, NOUL_FLOOR),
  }
}

// The worker session's own permission rules (Phase A, A5): groups the task does not need are denied, by how strict
// the profile is. They are appended to the role's rules, so they can only take rights away.
export function narrowing(profile: Profile): Rule[] {
  if (profile.perm === "trusted") return []
  const below = profile.perm === "strict" ? NOUL_FLOOR : 0.2
  const keep = new Set(ROLE_NEEDS[profile.role] ?? [])
  const out: Rule[] = []
  for (const group of Object.keys(TOOL_GROUPS) as ToolGroup[]) {
    const p = profile.tools[group]
    if (p === undefined || p >= below || keep.has(group)) continue
    for (const action of TOOL_GROUPS[group]) out.push({ action, resource: "*", effect: "deny" })
  }
  return out
}

// One line for the plan, the journal and the user.
export function profileText(p: Profile): string {
  const groups = (Object.keys(p.tools) as ToolGroup[]).filter((g) => p.tools[g] !== undefined).map((g) => `${g} ${p.tools[g]!.toFixed(2)}`)
  return [
    `role ${p.role}${p.roleReason === "the planner's role" ? "" : ` (${p.roleReason})`}`,
    `difficulty ${p.difficulty.toFixed(2)}`,
    `risk ${p.risk}`,
    p.testOracle ? "test oracle" : "no test oracle",
    p.testFirst ? "test first possible" : undefined,
    p.bugFix ? "bug fix" : undefined,
    p.approachUncertain ? "approach uncertain" : undefined,
    p.vision ? "needs vision" : undefined,
    `${p.perm} rights${groups.length ? ` (${groups.join(", ")})` : ""}`,
    `budget ${p.budget}`,
    p.skills.length ? `skills ${p.skills.join(", ")}` : undefined,
    p.source === "rules" ? "rules only" : undefined,
  ].filter(Boolean).join(" · ")
}
