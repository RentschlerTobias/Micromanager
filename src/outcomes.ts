// What every writer attempt cost and whether its checks passed, one JSON line per worker end: the data a router can
// learn from later (phase 2 of the trials plan: a small local model that picks tier, n and families, trained on
// success minus cost, with tasks compared inside their class). Until then it answers one question for src/trials.ts:
// does this class of task mostly fail on a single worker?
// ${XDG_STATE_HOME:-~/.local/state}/micromanager/outcomes.jsonl

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"

import { contractHash, reward } from "./contract.ts"
import { journalPath } from "./journal.ts"
import { family } from "./roles.ts"
import { tierFor } from "./registry.ts"
import type { Job, Task } from "./state.ts"

export function outcomesPath(): string {
  return join(dirname(journalPath()), "outcomes.jsonl")
}

export type Gate = "pass" | "fail" | "unverified" | "none"

export interface Outcome {
  readonly time: string
  readonly project: string
  readonly job: string
  readonly task: string
  readonly trial?: string // the trial's first attempt; absent for a task in no trial
  readonly n: number // attempts of its trial; 1 without one
  readonly role: string
  readonly model?: string
  readonly family?: string
  readonly difficulty?: number
  readonly cls: string // the task class (role, tier, size) that baselines are taken in
  readonly files: number
  readonly checks: readonly string[]
  readonly brief: string // the task text, cut
  readonly briefHash: string
  readonly gate: Gate // the last gate result
  readonly fixRounds: number
  readonly merged: boolean
  readonly end: "merged" | "sibling_won" | "blocked" | "unfinished" | "cancelled"
  readonly seconds?: number // from its delegation to its end
  readonly tokens?: number
  readonly cost?: number
  // A task measured against a fitness contract (src/contract.ts): which version, what it measured last, and the reward,
  // the primary score's improvement over the baseline (positive is better, 0 for an invalid result). The hash tells
  // two versions of "better" apart, which a router must not mix.
  readonly contract?: { readonly id: string; readonly version: number; readonly hash: string }
  readonly score?: { readonly valid: boolean; readonly values: Readonly<Record<string, number>> }
  readonly reward?: number
  readonly graded?: number // the share of cases its checks' own MM_SCORE lines passed, at its last gate
}

// The class a task is compared in: what a router could know before it starts.
export function classOf(role: string, difficulty: number | undefined, files: number): string {
  return `${role}:${difficulty === undefined ? "unknown" : tierFor(difficulty)}:${files <= 1 ? "1" : files <= 3 ? "2-3" : "4+"}`
}

// The row for a writer task whose worker ended. usage: the session's tokens and cost, when the caller could read them.
export function outcomeOf(project: string, job: Job, task: Task, usage?: { tokens: number; cost: number }, now = new Date()): Outcome {
  const gates = task.stages.filter((s) => s.stage === "gate")
  const last = gates.at(-1)
  const gate: Gate = !last ? "none" : last.result === "pass" ? "pass" : /changed no file/.test(last.evidence ?? "") ? "unverified" : "fail"
  const won = task.stages.some((s) => s.stage === "trial" && s.result === "pass" && /won by/.test(s.evidence ?? ""))
  const end: Outcome["end"] = task.status === "merged" ? "merged" : task.status === "cancelled" ? (won ? "sibling_won" : "cancelled") : task.status === "blocked" ? "blocked" : "unfinished"
  const started = task.stages.find((s) => s.stage === "delegate")?.at
  const verify = job.acceptance.filter((a) => task.acceptance.includes(a.id)).map((a) => a.verify).filter((v): v is string => Boolean(v))
  const contract = task.contract && job.contracts?.find((c) => c.id === task.contract!.id)
  const r = contract && task.score ? reward(contract, task.score) : undefined
  return {
    time: now.toISOString(),
    project,
    job: job.id,
    task: task.id,
    ...(task.trial ? { trial: task.trial.of } : {}),
    n: task.trial?.n ?? 1,
    role: task.role,
    ...(task.model ? { model: task.model, family: family(task.model) } : {}),
    ...(task.difficulty !== undefined ? { difficulty: task.difficulty } : {}),
    cls: classOf(task.role, task.difficulty, task.files.length),
    files: task.files.length,
    checks: verify,
    brief: task.description.slice(0, 2000),
    briefHash: createHash("sha256").update(task.description).digest("hex").slice(0, 16),
    gate,
    // A failed fitness measurement is a fix round as much as a failing check (src/native.ts finish).
    fixRounds: task.stages.filter((s) => (s.stage === "gate" || s.stage === "fitness") && s.result === "fail").length,
    merged: task.status === "merged",
    end,
    ...(started ? { seconds: Math.round((now.getTime() - Date.parse(started)) / 1000) } : {}),
    ...(usage ? { tokens: usage.tokens, cost: usage.cost } : {}),
    ...(contract ? { contract: { id: contract.id, version: task.contract!.version, hash: contractHash(contract) } } : {}),
    ...(task.score ? { score: { valid: task.score.valid, values: task.score.values } } : {}),
    ...(r !== undefined ? { reward: r } : {}),
    ...(task.graded ? { graded: Math.round((task.graded.passed / task.graded.total) * 1000) / 1000 } : {}),
  }
}

export function recordOutcome(row: Outcome, path = outcomesPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(row) + "\n")
  } catch {
    // the log must never break a worker's end
  }
}

export function readOutcomes(path = outcomesPath()): Outcome[] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return []
    try {
      return [JSON.parse(line) as Outcome]
    } catch {
      return []
    }
  })
}

// Whether tasks of this class mostly fail on a single worker: of its last `window` single attempts (no trial), at least
// `min` ended, and fewer than half merged. A class that won trials after failed attempts counts too: a trial where
// some attempt failed and one won says one worker alone would likely have failed.
export function needsTrials(rows: readonly Outcome[], cls: string, window = 20, min = 4): boolean {
  const mine = rows.filter((r) => r.cls === cls && r.end !== "cancelled")
  const singles = mine.filter((r) => r.n === 1).slice(-window)
  const trials = groupTrials(mine.filter((r) => r.n > 1)).slice(-window)
  const tries = singles.length + trials.reduce((s, t) => s + t.attempts.filter((a) => a.end !== "sibling_won").length, 0)
  if (tries < min) return false
  const passed = singles.filter((r) => r.merged).length + trials.filter((t) => t.k > 0).length
  return passed / tries < 0.5
}

export interface TrialRow {
  readonly key: string // "<job>/<trial or task>"
  readonly cls: string
  readonly n: number
  readonly k: number // attempts whose checks passed
  readonly attempts: readonly Outcome[]
}

function groupTrials(rows: readonly Outcome[]): TrialRow[] {
  const by = new Map<string, Outcome[]>()
  for (const r of rows) {
    const k = `${r.job}/${r.trial ?? r.task}`
    by.set(k, [...(by.get(k) ?? []), r])
  }
  return [...by.entries()].map(([key, attempts]) => ({ key, cls: attempts[0]!.cls, n: attempts[0]!.n, k: attempts.filter((a) => a.gate === "pass").length, attempts }))
}

// export-dataset --target router: one row per task (a trial's attempts joined), with what a router sees before the
// start, what it chose, and what came of it. Censored attempts (stopped because a sibling won) are kept as such.
export function routerRows(rows: readonly Outcome[]): Record<string, unknown>[] {
  return groupTrials(rows).map((t) => {
    const first = t.attempts[0]!
    return {
      key: t.key,
      cls: t.cls,
      features: { role: first.role, difficulty: first.difficulty, files: first.files, checks: first.checks, brief: first.brief },
      allocation: { n: t.n, models: t.attempts.map((a) => a.model) },
      outcome: {
        k: t.k,
        merged: t.attempts.some((a) => a.merged),
        censored: t.attempts.filter((a) => a.end === "sibling_won").length,
        tokens: t.attempts.reduce((s, a) => s + (a.tokens ?? 0), 0),
        cost: Math.round(t.attempts.reduce((s, a) => s + (a.cost ?? 0), 0) * 1e6) / 1e6,
        seconds: Math.max(0, ...t.attempts.map((a) => a.seconds ?? 0)),
        ...(t.attempts.some((a) => a.reward !== undefined) ? { reward: Math.max(...t.attempts.map((a) => a.reward ?? 0)) } : {}),
      },
    }
  })
}
