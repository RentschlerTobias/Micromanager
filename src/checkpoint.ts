// A task checkpoint (the user's idea, 2026-10-05): instead of a budget that cuts a task, every CHECKPOINT_STEPS steps
// Jev reviews the task's progress from facts the watchdog has (writes, calls since the last write, failures, the last
// calls). The worker goes on while it makes progress; otherwise it gets a fresh session with another approach, or goes
// back to the micromanager with the reason.

import { CHECKPOINT, NOUL_FLOOR } from "./catalog.ts"
import type { Decider } from "./backends.ts"
import type { Answer } from "./jev.ts"
import type { Progress, Signal } from "./watchdog.ts"

export type Verdict = "continue" | "fresh" | "handback"

// Without an answer: a session that has not changed a file for 40 calls and keeps failing gets a fresh try; anything
// else goes on (the watchdog's signatures still stop real loops).
export function verdict(answers: Readonly<Record<string, Answer>>, p: Progress): Verdict {
  const noul = (q: string) => (answers[q]?.type === "noul" ? (answers[q] as { noul: number }).noul : undefined)
  const progressing = noul("making_progress")
  if (progressing === undefined) return p.callsSinceWrite >= 40 && p.recentFailures >= 3 ? "fresh" : "continue"
  // Cutting costs the work done, so only clear signs cut: progress clearly low, and a clear reason. A cloud Jev probe
  // put a task that kept editing and testing at 0.50, a stuck one at 0.20 (another approach 0.69).
  if (progressing >= STUCK_BELOW) return "continue"
  if ((noul("task_unclear") ?? 0) >= NOUL_FLOOR) return "handback"
  if ((noul("wrong_approach") ?? 0) >= NOUL_FLOOR) return "fresh"
  return "continue"
}

const STUCK_BELOW = 0.35

export function signalFor(v: Verdict, p: Progress): Signal | undefined {
  if (v === "continue") return undefined
  const facts = `${p.steps} steps, ${p.writes} writes, ${p.callsSinceWrite} calls since the last one, ${p.recentFailures} of the last 12 calls failed`
  return v === "fresh"
    ? { kind: "checkpoint", detail: `task checkpoint: no progress (${facts}); another approach` }
    : { kind: "handback", detail: `task checkpoint: the task looks unclear or blocked (${facts}); back to the micromanager` }
}

export async function review(decider: Decider, task: string, p: Progress): Promise<{ verdict: Verdict; decision?: string; confidence?: number }> {
  const asked = await decider.ask("N16", { task: task.slice(0, 1500), progress: p }, CHECKPOINT).catch(() => undefined)
  const answers = asked?.decision.answers ?? {}
  const progressing = answers.making_progress?.type === "noul" ? (answers.making_progress as { noul: number }).noul : undefined
  return { verdict: verdict(answers, p), decision: asked?.id, ...(progressing !== undefined ? { confidence: progressing } : {}) }
}

// --- the adaptive interval (decided by the user after the Ralph spike, design.md §24) --------------------------------

export const MIN_INTERVAL = 15
export const MAX_INTERVAL = 180

// The first interval of a worker: about the steps merged tasks of its class needed (the outcome log's 75th
// percentile), so a review comes when a task like it would usually be done; without such data, from N5's difficulty.
export function firstInterval(difficulty?: number, learned?: number): number {
  if (learned !== undefined) return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL * 2, Math.round(learned)))
  if (difficulty === undefined) return 60
  return difficulty < 0.34 ? 40 : difficulty < 0.67 ? 60 : 90
}

// The next interval after a review that let the worker go on: longer when Jev is sure it makes progress, shorter when
// it barely let it (a stall is caught sooner), the same in between.
export function nextInterval(prev: number, confidence?: number): number {
  if (confidence === undefined) return prev
  if (confidence >= 0.8) return Math.min(MAX_INTERVAL, Math.round(prev * 1.5))
  if (confidence < 0.5) return Math.max(MIN_INTERVAL, Math.round(prev * 0.5))
  return prev
}
