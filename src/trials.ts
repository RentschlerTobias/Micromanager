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

import { better, type Contract } from "./contract.ts"
import { HEADER } from "./hooks.ts"
import { roleById } from "./roles.ts"
import type { Job, Task } from "./state.ts"

// What the plugin found out about a writer delegation before it starts: N5's difficulty, and how many attempts.
export interface Assessment {
  readonly difficulty?: number // 0..1; undefined when no estimate could be made
  readonly trials: number // 1: no trial
  // The task asks to improve a measurable property with no fixed end state: it needs a fitness contract to start.
  readonly openEnded?: boolean
  // The task's gain lies in one function or block (N5's local_block): with a contract that measures fast, the evolver
  // is offered instead of a worker (src/evolver.ts).
  readonly localBlock?: boolean
}

// Who decides a trial (the user, 2026-10-27: the first attempt to pass won, so the fastest model won, not the best or
// the cheapest one):
// - first: the first attempt whose checks pass is merged and the others are stopped;
// - best: passed attempts are held; the others get a grace window, then the best by quality is merged;
// - contract: the best score against the task's fitness contract (src/contract.ts);
// - user: every attempt runs to its end and the user picks from a comparison (design drafts are a matter of taste).
export type Pick = "first" | "best" | "contract" | "user"

// Who decides by default, by role id; "*" for every other role.
export const DEFAULT_PICK: Readonly<Record<string, Pick>> = { visual: "user", "*": "best" }

// The pick for a new trial: the prompt's "Pick:" line, else the setting for its role.
export function pickFor(role: string, setting: Readonly<Record<string, Pick>> = DEFAULT_PICK, line?: Pick): Pick {
  return line ?? setting[role] ?? setting["*"] ?? "first"
}

// Who decides the trial a task belongs to: a contract always decides by score.
export function pickOf(task: Task): Pick {
  return task.contract ? "contract" : task.trial?.pick ?? "first"
}

// The grace window of a "best" trial: the other attempts get this share of the first passing one's time, at least
// minMs and at most maxMs. factor 0 decides at once, as "first" does. The floor exists because a share alone gave 6 s
// when the first attempt passed after 12 (live run, 2026-10-27): the slower attempt was stopped, and speed won again.
export interface Grace {
  readonly factor: number
  readonly minMs: number
  readonly maxMs: number
}

export const DEFAULT_GRACE: Grace = { factor: 0.5, minMs: 2 * 60_000, maxMs: 10 * 60_000 }

export function graceMs(g: Grace, elapsedMs: number): number {
  if (g.factor <= 0) return 0
  return Math.max(0, Math.min(Math.max(g.factor * elapsedMs, g.minMs), g.maxMs))
}

// What each attempt is told about how its trial is decided.
const HOW: Record<Pick, string> = {
  first: "The first whose checks pass is merged and the others are stopped, so take the approach you think is most likely to pass",
  best: "Of the attempts whose checks pass, the best is merged: by how many of the checks' cases pass, then a review of the changes, then cost and size. Once one passes, the others get a short grace window to finish. Aim for a correct, clean and small change, not only for passing",
  contract: "Of the attempts whose checks pass, the one with the best score is merged once all are done, so aim for the best result the contract can measure, not only for passing",
  user: "Every attempt runs to its end, and the user picks the one they like best from a comparison of all that pass. Make your own best version; do not hedge between styles",
}

// An attempt that is getting nowhere, by the watchdog's counts: it is stopped when a "best" trial's grace window opens
// rather than paid for until the window closes.
export function idleAttempt(p: { calls: number; writes: number; callsSinceWrite: number; recentFailures: number } | undefined): boolean {
  if (!p) return false
  return (p.writes === 0 && p.calls >= 20) || p.callsSinceWrite >= 25 || p.recentFailures >= 8
}

// What the quality ranking of a "best" trial knows about one passed attempt.
export interface Quality {
  readonly task: Task
  readonly graded?: number // share of the checks' MM_SCORE cases passed
  readonly cost?: number
  readonly size: number // lines added and removed
}

// A pairwise review's verdict on two attempts (src/plugin.ts asks a model of a third family).
export interface Review {
  readonly better: "A" | "B" | "equal"
  readonly why: string
}

const share = (q: Quality) => q.graded ?? -1
const money = (n: number | undefined) => `$${(n ?? 0).toFixed(4)}`

// The passed attempts best first, and why the first is first: the share of cases passed, then the review of the two
// best (when there is one), then cost, then size. review is asked only when the two best are tied on cases.
export async function rankQuality(held: readonly Quality[], review?: (a: Quality, b: Quality) => Promise<Review | undefined>): Promise<{ order: Task[]; how: string }> {
  const byCases = [...held].sort((a, b) => share(b) - share(a) || (a.cost ?? 0) - (b.cost ?? 0) || a.size - b.size)
  if (byCases.length < 2) return { order: byCases.map((q) => q.task), how: "the only attempt that passed" }
  const [a, b] = byCases as [Quality, Quality]
  if (share(a) > share(b)) return { order: byCases.map((q) => q.task), how: `more cases passed (${Math.round(share(a) * 100)}% against ${Math.round(share(b) * 100)}%)` }
  const verdict = review ? await review(a, b).catch(() => undefined) : undefined
  if (verdict && verdict.better !== "equal") {
    const first = verdict.better === "A" ? a : b
    return { order: [first.task, ...byCases.filter((q) => q !== first).map((q) => q.task)], how: `on review: ${verdict.why.slice(0, 200)}` }
  }
  const tied = verdict ? "the review found them equal" : "tied on the checks"
  if ((a.cost ?? 0) !== (b.cost ?? 0)) return { order: byCases.map((q) => q.task), how: `${tied}; cheaper (${money(a.cost)} against ${money(b.cost)})` }
  if (a.size !== b.size) return { order: byCases.map((q) => q.task), how: `${tied}; smaller change (${a.size} against ${b.size} lines)` }
  return { order: byCases.map((q) => q.task), how: `${tied}, at the same cost and size` }
}

// The pairwise review's prompt: the task, and the two changes as A and B.
export function reviewPrompt(task: string, a: string, b: string): string {
  return [
    "Two workers solved the same task, and both pass its checks. Judge which change is better: correct in the cases the checks may miss, simpler, easier to maintain, closer to what the task asked. Do not prefer the longer one.",
    "Answer with one line of JSON and nothing else: {\"better\": \"A\" | \"B\" | \"equal\", \"why\": \"one sentence\"}",
    "",
    "Task:",
    task.slice(0, 4000),
    "",
    "Change A:",
    a,
    "",
    "Change B:",
    b,
  ].join("\n")
}

// The review's answer, or undefined when it is not the JSON asked for.
export function parseReview(text: string): Review | undefined {
  const m = text.match(/\{[^{}]*"better"[^{}]*\}/)
  if (!m) return undefined
  try {
    const r = JSON.parse(m[0]) as { better?: unknown; why?: unknown }
    if (r.better !== "A" && r.better !== "B" && r.better !== "equal") return undefined
    return { better: r.better, why: typeof r.why === "string" ? r.why : "" }
  } catch {
    return undefined
  }
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

// Where a trial stands: the winner once one merged, the attempts still at work, the ones that passed and wait for the
// trial to be decided by score (held, src/contract.ts), and the ones that failed.
export function standing(job: Job, task: Task): { winner?: Task; live: Task[]; held: Task[]; failed: Task[]; all: Task[] } {
  const all = attempts(job, task)
  const winner = all.find((t) => t.status === "merged")
  const held = all.filter((t) => t.held && t.status === "passed")
  const live = all.filter((t) => !held.includes(t) && LIVE.has(t.status) && t.stages.at(-1)?.stage !== "end")
  const failed = all.filter((t) => t !== winner && !live.includes(t) && !held.includes(t) && t.status !== "cancelled")
  return { winner, live, held, failed, all }
}

// The held attempts best first, by the contract: the held-out score where there is one, else the visible one.
export function ranked(c: Contract, held: readonly Task[]): Task[] {
  const invalid = { valid: false, values: {} }
  return [...held].sort((a, b) => better(c, b.score ?? invalid, a.score ?? invalid))
}

// The prompt line that starts another attempt; native.ts parseDelegation reads it back.
export const attemptLine = (task: string, job: string) => `Attempt: ${task} · ${job}`

// How the micromanager hears that a trial is decided.
const DECIDED: Record<Pick, (head: Task) => string> = {
  first: () => "the first whose checks pass is merged, and the others are stopped",
  best: () => "and of those whose checks pass, the best by quality is merged after a short grace window for the others",
  contract: (head) => `and of those whose checks pass, the one with the best score against contract ${head.contract?.id ?? "?"} is merged once all are done`,
  user: () => "every attempt runs to its end, and the user picks one from a comparison of those that pass",
}

// What the micromanager reads after starting the first attempt: start the rest now, in one message.
export function fanOutText(job: Job, head: Task): string | undefined {
  if (!head.trial || head.trial.of !== head.id) return undefined
  const missing = head.trial.n - attempts(job, head).length
  if (missing <= 0) return undefined
  const agent = roleById(head.role)?.agent ?? head.role
  const why = head.difficulty !== undefined && head.difficulty >= DEEP ? `it is hard (difficulty ${head.difficulty.toFixed(2)})` : "an earlier attempt at this work failed"
  return [
    `${HEADER} ${head.id} runs as a trial of ${head.trial.n} attempts, because ${why}: each attempt works in its own worktree on another model, ${DECIDED[pickOf(head)](head)}.`,
    `Start the other ${missing} attempt${missing > 1 ? "s" : ""} now, in one message, with the subagent tool (background = true), each with agent ${agent}, description "${head.id} attempt", and only this prompt:`,
    attemptLine(head.id, job.id),
    "The plugin gives each the same task, files and checks. Do not wait for the first attempt, and do not start the task again yourself: the trial's result comes to you as a note.",
  ].join("\n")
}

// What the worker of an attempt is told on top of its task.
export function attemptBrief(task: Task): string {
  if (!task.trial) return ""
  const index = Number(task.title.match(/\(attempt (\d+)\//)?.[1] ?? 1)
  return `You are attempt ${index} of ${task.trial.n} at this task: other workers try the same task at the same time, each in its own worktree on another model. ${HOW[pickOf(task)]}, and do not wait for anyone.`
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

// The micromanager's note when an attempt won. score: how it won on score, for a trial decided by its contract.
export function wonText(job: Job, winner: Task, stopped: readonly Task[], failed: number, head?: string, score?: { beaten: readonly Task[]; how: string; by?: "score" | "quality" | "user" }): string {
  const label = { score: "with the best score", quality: "as the best attempt", user: "as the user's pick" }[score?.by ?? "score"]
  const by = score ? ` ${label} (${score.how})${score.beaten.length ? `, ahead of ${score.beaten.map((t) => t.id).join(", ")}` : ""}` : ""
  return `${HEADER} ${winner.id} won the trial of ${head ?? winner.trial?.of ?? winner.id}${by}: merged into ${job.integrationBranch}${failed ? ` after ${failed} other attempt${failed > 1 ? "s" : ""} failed` : ""}.${stopped.length ? ` Stopped: ${stopped.map((t) => t.id).join(", ")}; their work is not needed.` : ""}`
}
