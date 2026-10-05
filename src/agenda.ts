// The agenda: what could happen next, built from the job state alone (design.md §8). The decision model picks
// among these proposals; without it, or below its floor, the first one wins (the tutor's Agenda.next).

import { allDone, DEFAULT_PRIORITY, readyTasks, type Job, type Task } from "./state.ts"

export type Action = "answer_blocked" | "fix" | "gate" | "review" | "dispatch" | "replan" | "verify" | "ask_user" | "wrap"

export interface Proposal {
  readonly action: Action
  readonly taskId?: string
  readonly label: string // short English text, also used as the option's meaning for the decision model
}

// Order is priority: unblock work first, then finish what is running, then start new work.
// A stalled job replans before it starts more work on the plan that stalled.
const ORDER: readonly Action[] = ["answer_blocked", "fix", "gate", "review", "replan", "dispatch", "verify", "ask_user", "wrap"]

// Ready tasks: priority first, then in-progress parent, then fewer dependencies, then id (Task Master's order).
export function orderReady(job: Job, tasks: readonly Task[]): Task[] {
  const active = new Set(job.tasks.filter((t) => t.status === "running" || t.status === "passed").map((t) => t.parent).filter(Boolean))
  return [...tasks].sort((a, b) =>
    (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY) ||
    Number(active.has(b.parent)) - Number(active.has(a.parent)) ||
    a.dependsOn.length - b.dependsOn.length ||
    a.id.localeCompare(b.id, undefined, { numeric: true }),
  )
}

export function buildAgenda(job: Job, stallLimit = 3): Proposal[] {
  if (job.phase !== "execute") return []
  const out: Proposal[] = []
  for (const t of job.tasks) {
    if (t.status === "blocked") out.push({ action: "answer_blocked", taskId: t.id, label: `answer the question of blocked task ${t.id}` })
    if (t.status === "fixing") out.push({ action: "fix", taskId: t.id, label: `fix task ${t.id} after a failed check` })
    if (t.status === "gating") out.push({ action: "gate", taskId: t.id, label: `run the checks of task ${t.id}` })
    if (t.status === "reviewing") out.push({ action: "review", taskId: t.id, label: `review task ${t.id}` })
  }
  const running = job.tasks.some((t) => t.status === "running")
  for (const t of orderReady(job, readyTasks(job))) {
    out.push({ action: "dispatch", taskId: t.id, label: `start task ${t.id}: ${t.title}` })
  }
  const replansLeft = job.counters.replans < job.budget.replansMax
  if (job.counters.stalls >= stallLimit && replansLeft) out.push({ action: "replan", label: "the job is stalled: rewrite the plan" })
  if (allDone(job)) out.push({ action: "verify", label: "every task is done: verify the whole job" })
  const stuck = !running && out.length === 0 && job.tasks.some((t) => t.status === "escalated" || t.status === "cancelled")
  // Nothing can go on past an escalated task: a replan first while one is left, then the user.
  if (stuck && replansLeft && job.tasks.some((t) => t.status === "escalated")) out.push({ action: "replan", label: "escalated tasks block the rest: rewrite the plan" })
  else if (stuck) out.push({ action: "ask_user", label: "nothing can proceed: ask the user" })
  if (out.length === 0 && !running) out.push({ action: "wrap", label: "nothing left to do: wrap up" })
  return out.sort((a, b) => ORDER.indexOf(a.action) - ORDER.indexOf(b.action))
}

// The rules fallback: the highest-priority proposal.
export function nextProposal(agenda: readonly Proposal[]): Proposal | undefined {
  return agenda[0]
}
