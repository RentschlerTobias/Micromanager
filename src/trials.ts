// Best-of-n trials (after Dr. Zero, arXiv 2601.07055: the pass rate of n rollouts as the difficulty signal).
//
// A hard writer task runs as n attempts at once, each a task of its own in its own worktree, on n different model
// families where the pool has them. The checks are the verifier: the first attempt whose checks pass and that merges
// cleanly wins, the others are stopped and done over by it (replacedBy, so whatever waits for the first attempt waits
// for the winner). How many of the n passed (k) is what the outcome log keeps for the router:
// - k = 0: the task is too big or too vague for one worker; the micromanager splits it, with what each attempt hit.
// - 0 < k < n: n was worth it; the task class gets trials from the start next time (src/outcomes.ts needsTrials).
//
// Native.delegate makes the first attempt; the micromanager starts the others when the plugin tells it to ("Attempt:
// T5 · job-…"), because only its subagent calls make children that OpenCode reports back to it.

import { HEADER } from "./hooks.ts"
import { roleById } from "./roles.ts"
import type { Job, Task } from "./state.ts"

// What the plugin found out about a writer delegation before it starts: N5's difficulty, and how many attempts.
export interface Assessment {
  readonly difficulty?: number // 0..1; undefined when no estimate could be made
  readonly trials: number // 1: no trial
  // The task asks to improve a measurable property with no fixed end state: it needs a fitness contract to start.
  readonly openEnded?: boolean
}

// The difficulty from which a task runs as a trial: N5's "hard" and "very hard" (tierFor's deep tier).
export const DEEP = 0.67
export const DEFAULT_TRIALS = 3
export const MAX_TRIALS = 4

// How many attempts a writer task gets. setting: the user's "trials" (1 turns trials off); parallel: tasks of the job at
// once, which a trial must fit into; retry: the task is started again after a failed attempt (Replaces:, or a planned
// task that ran before); learned: the outcome log says tasks of this class mostly fail on one worker.
export function trialSize(o: { difficulty?: number; retry: boolean; learned?: boolean; setting: number; parallel: number }): number {
  const n = Math.min(o.setting, o.parallel, MAX_TRIALS)
  if (n < 2) return 1
  return (o.difficulty !== undefined && o.difficulty >= DEEP) || o.retry || o.learned ? n : 1
}

// The attempts of the trial a task belongs to, the first one first; [] for a task in no trial.
export function attempts(job: Job, task: Task): Task[] {
  if (!task.trial) return []
  return job.tasks.filter((t) => t.trial?.of === task.trial!.of)
}

const LIVE = new Set<Task["status"]>(["running", "gating", "fixing", "reviewing", "passed"])

// Where a trial stands: the winner once one merged, the attempts still at work, and the ones that failed.
export function standing(job: Job, task: Task): { winner?: Task; live: Task[]; failed: Task[]; all: Task[] } {
  const all = attempts(job, task)
  const winner = all.find((t) => t.status === "merged")
  const live = all.filter((t) => LIVE.has(t.status) && t.stages.at(-1)?.stage !== "end")
  const failed = all.filter((t) => t !== winner && !live.includes(t) && t.status !== "cancelled")
  return { winner, live, failed, all }
}

// The prompt line that starts another attempt; native.ts parseDelegation reads it back.
export const attemptLine = (task: string, job: string) => `Attempt: ${task} · ${job}`

// What the micromanager reads after starting the first attempt: start the rest now, in one message.
export function fanOutText(job: Job, head: Task): string | undefined {
  if (!head.trial || head.trial.of !== head.id) return undefined
  const missing = head.trial.n - attempts(job, head).length
  if (missing <= 0) return undefined
  const agent = roleById(head.role)?.agent ?? head.role
  const why = head.difficulty !== undefined && head.difficulty >= DEEP ? `it is hard (difficulty ${head.difficulty.toFixed(2)})` : "an earlier attempt at this work failed"
  return [
    `${HEADER} ${head.id} runs as a trial of ${head.trial.n} attempts, because ${why}: each attempt works in its own worktree on another model, the first whose checks pass is merged, and the others are stopped.`,
    `Start the other ${missing} attempt${missing > 1 ? "s" : ""} now, in one message, with the subagent tool (background = true), each with agent ${agent}, description "${head.id} attempt", and only this prompt:`,
    attemptLine(head.id, job.id),
    "The plugin gives each the same task, files and checks. Do not wait for the first attempt, and do not start the task again yourself: the trial's result comes to you as a note.",
  ].join("\n")
}

// What the worker of an attempt is told on top of its task.
export function attemptBrief(task: Task): string {
  if (!task.trial) return ""
  const index = Number(task.title.match(/\(attempt (\d+)\//)?.[1] ?? 1)
  return `You are attempt ${index} of ${task.trial.n} at this task: other workers try the same task at the same time, each in its own worktree on another model. The first whose checks pass is merged and the others are stopped, so take the approach you think is most likely to pass, and do not wait for anyone.`
}

// Why each failed attempt failed, from its last failing stage: the brief for splitting the task.
export function failureDigest(failed: readonly Task[]): string {
  return failed
    .map((t) => {
      const last = [...t.stages].reverse().find((s) => s.result === "fail")
      return `- ${t.id} on ${t.model ?? "?"}: ${last ? `${last.stage}: ${(last.evidence ?? "").slice(0, 300)}` : t.summary?.slice(0, 300) ?? "no reason recorded"}`
    })
    .join("\n")
}

// The micromanager's note when every attempt of a trial failed (k = 0).
export function allFailedText(job: Job, head: Task, failed: readonly Task[]): string {
  return [
    `${HEADER} All ${failed.length} attempts at ${head.id} ${head.title.replace(/ \(attempt \d+\/\d+\)$/, "")} failed, on different models, so the task is too big or too unclear for one worker:`,
    failureDigest(failed),
    `Split it into smaller tasks that each can pass a check of their own (the todo tool, with "after" for their order and "replaces": ["${head.id}"]), using what the attempts hit above; or, if a check is what is wrong, correct it and start the task again. Ask the user if the goal itself is unclear.`,
  ].join("\n")
}

// The micromanager's note when an attempt fails while others still run: nothing to do yet.
export function attemptFailedText(task: Task, live: readonly Task[]): string {
  return `${HEADER} ${task.id} (${task.title}) failed, but ${live.map((t) => t.id).join(", ")} of its trial still ${live.length > 1 ? "run" : "runs"}: nothing to do, the trial's result comes as a note.`
}

// The micromanager's note when an attempt won.
export function wonText(job: Job, winner: Task, stopped: readonly Task[], failed: number, head?: string): string {
  return `${HEADER} ${winner.id} won the trial of ${head ?? winner.trial?.of ?? winner.id}: merged into ${job.integrationBranch}${failed ? ` after ${failed} other attempt${failed > 1 ? "s" : ""} failed` : ""}.${stopped.length ? ` Stopped: ${stopped.map((t) => t.id).join(", ")}; their work is not needed.` : ""}`
}
