// A job's budget on native workers: what its sessions used, counted per session from what the provider reported, and
// whether a limit is used up (design.md §10.2). The runner checked its budget before every start; native jobs had
// counters that nothing filled, so a trial or a long loop could spend without end.
//
// Limits are none unless the config sets them (the user's choice, 2026-10-05: a job cut at a limit wastes its work),
// and a used-up budget cuts nothing: no new worker starts and no worker is continued, the running ones are asked to
// wrap up, and the micromanager asks the user. Raising "budget" in micromanager.jsonc takes effect at the next check.

import { usage } from "./brief.ts"
import type { Budget } from "./config.ts"
import type { Job } from "./state.ts"

export interface Used {
  readonly tokens: number
  readonly cost: number
  readonly requests: number
}

// A session's usage so far, from its messages (ctx.session.context): tokens and cost of its assistant messages.
export function sessionUsage(messages: unknown): Used {
  const requests = Array.isArray(messages) ? (messages as { type?: string }[]).filter((m) => m.type === "assistant").length : 0
  return { ...usage(messages), requests }
}

// What each session had used when it was last counted, so a job is charged only what is new.
export class Accountant {
  readonly #seen = new Map<string, Used>()

  // Adds what the session used since its last count to the job's counters; returns that difference.
  charge(job: Job, sessionID: string, now: Used): Used {
    const before = this.#seen.get(sessionID) ?? { tokens: 0, cost: 0, requests: 0 }
    this.#seen.set(sessionID, now)
    const delta = { tokens: Math.max(0, now.tokens - before.tokens), cost: Math.max(0, now.cost - before.cost), requests: Math.max(0, now.requests - before.requests) }
    const c = job.counters
    c.tokens = (c.tokens ?? 0) + delta.tokens
    c.cost = (c.cost ?? 0) + delta.cost
    c.requests = (c.requests ?? 0) + delta.requests
    return delta
  }
}

// The limits that hold for a job: its own where it has them, else the config's.
export function limitsOf(job: Job, config: Budget = {}): Budget {
  const b = job.budget
  return { tokens: b.tokensMax ?? config.tokens, requests: b.requestsMax ?? config.requests, cost: b.costMax ?? config.cost }
}

// The first limit the job has used up, as a reason; undefined while every limit holds.
export function overBudget(job: Job, limits: Budget = limitsOf(job)): string | undefined {
  const c = job.counters
  if (limits.tokens && (c.tokens ?? 0) >= limits.tokens) return `token budget of ${limits.tokens} used up (${c.tokens})`
  if (limits.requests && (c.requests ?? 0) >= limits.requests) return `request budget of ${limits.requests} used up (${c.requests})`
  if (limits.cost && (c.cost ?? 0) >= limits.cost) return `cost budget of ${limits.cost} used up (${(c.cost ?? 0).toFixed(2)})`
  return undefined
}

// The micromanager's note when a job's budget is used up.
export function overNote(job: Job, why: string, running: readonly string[]): string {
  return `[micromanager] Job ${job.id} used its budget: ${why}. No new worker starts and none is continued until the user raises the budget ("budget" in ~/.config/opencode/micromanager.jsonc; it holds from the next check on).${running.length ? ` The running workers (${running.join(", ")}) are asked to wrap up; their work stays in their worktrees.` : ""} Tell the user in two sentences and ask whether to raise it.`
}

// The note a running worker gets at its next turn when the job's budget is used up.
export function wrapUpNote(why: string): string {
  return `[micromanager] The job's budget is used up (${why}). Wrap up now: if your change is done, call finish_task; if not, stop and end with a short report of what is done and what is left. Your work stays in your worktree. This note comes from your own plugin; it is trusted.`
}
