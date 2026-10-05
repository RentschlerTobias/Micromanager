// The guard bench (design.md §21): every case of bench/guard_cases.json through the G0 backend, then recall and
// false-positive rate per guard at a range of floors. A floor for a backend is set from this, never guessed.

import { readFileSync } from "node:fs"

import type { Decider } from "./backends.ts"
import { GUARDS } from "./catalog.ts"
import { n7Questions, n7State, triage, type N7Context, type Verdict } from "./followups.ts"
import type { FollowUp } from "./state.ts"

export interface Case {
  readonly text: string
  readonly yes: readonly string[]
}

export interface GuardScore {
  readonly guard: string
  readonly floor: number
  readonly recall: number // share of positives at or above the floor
  readonly fpr: number // share of negatives at or above the floor
  readonly positives: number
}

export function loadCases(path: string): Case[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { cases: Case[] }).cases
}

export async function scoreCases(decider: Decider, cases: readonly Case[]): Promise<{ text: string; yes: readonly string[]; p: Record<string, number> }[]> {
  const out = []
  for (const c of cases) {
    const asked = await decider.ask("G0", { text: c.text }, GUARDS, { localOnly: true })
    const p: Record<string, number> = {}
    for (const g of Object.keys(GUARDS)) {
      const a = asked.decision.answers[g]
      if (a?.type === "noul") p[g] = a.noul
    }
    out.push({ text: c.text, yes: c.yes, p })
  }
  return out
}

export function sweep(rows: readonly { yes: readonly string[]; p: Record<string, number> }[], floors = [0.3, 0.5, 0.7, 0.9]): GuardScore[] {
  return Object.keys(GUARDS).flatMap((guard) => {
    const scored = rows.filter((r) => r.p[guard] !== undefined)
    if (scored.length === 0) return [] // no answers for this guard: nothing to report, not 0 %
    const pos = scored.filter((r) => r.yes.includes(guard))
    const neg = scored.filter((r) => !r.yes.includes(guard))
    return floors.map((floor) => ({
      guard,
      floor,
      positives: pos.length,
      recall: pos.length ? pos.filter((r) => r.p[guard]! >= floor).length / pos.length : 0,
      fpr: neg.length ? neg.filter((r) => r.p[guard]! >= floor).length / neg.length : 0,
    }))
  })
}

export function formatSweep(scores: readonly GuardScore[]): string {
  if (scores.length === 0) return "no answers from the G0 backend: is the decision server running and fast enough?"
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(5)
  return ["guard           floor  recall   fpr", ...scores.map((s) => `${s.guard.padEnd(15)} ${s.floor.toFixed(1).padStart(5)} ${pct(s.recall)} ${pct(s.fpr)}`)].join("\n")
}

// Repeat-run check (Phase D: one goal scored 0.59, then 2e-8): the same cases scored twice, and per guard the largest
// change between the runs and how many cases crossed the floor.
export function drift(a: readonly { p: Record<string, number> }[], b: readonly { p: Record<string, number> }[], floor = 0.5): { guard: string; maxDelta: number; flips: number }[] {
  return Object.keys(GUARDS).flatMap((guard) => {
    const pairs = a.map((r, i) => [r.p[guard], b[i]?.p[guard]] as const).filter((x): x is readonly [number, number] => x[0] !== undefined && x[1] !== undefined)
    if (pairs.length === 0) return []
    return [{ guard, maxDelta: Math.max(...pairs.map(([x, y]) => Math.abs(x - y))), flips: pairs.filter(([x, y]) => (x >= floor) !== (y >= floor)).length }]
  })
}

export function formatDrift(rows: readonly { guard: string; maxDelta: number; flips: number }[]): string {
  return ["guard           max change  floor flips", ...rows.map((r) => `${r.guard.padEnd(15)} ${r.maxDelta.toFixed(3).padStart(10)} ${String(r.flips).padStart(12)}`)].join("\n")
}

// --- the N7 bench: a worker's follow-ups (bench/followup_cases.json) -----------------------------------------

export type Expect = "task" | "planned" | "user" | "later"

interface N7Job {
  readonly goal: string
  readonly acceptance: readonly string[]
  readonly tasks: readonly { id: string; title: string; files: readonly string[]; done: boolean }[]
}

export interface N7Case {
  readonly job: string
  readonly finder: string
  readonly followUp: FollowUp
  readonly expect: Expect
  readonly priority?: "high" | "normal" | "low"
}

export function loadN7(path: string): { jobs: Record<string, N7Job>; cases: N7Case[] } {
  return JSON.parse(readFileSync(path, "utf8")) as { jobs: Record<string, N7Job>; cases: N7Case[] }
}

export function n7Context(job: N7Job, finder: string): N7Context {
  const finderTask = job.tasks.find((t) => t.id === finder)!
  const others = job.tasks.filter((t) => t.id !== finder)
  return {
    goal: job.goal,
    acceptance: job.acceptance,
    task: `${finderTask.id} ${finderTask.title}`,
    otherTasks: others.map((t) => `${t.id} ${t.title}${t.done ? " (done)" : ""} (files: ${t.files.join(", ") || "none"})`),
    openFiles: new Set(others.filter((t) => !t.done).flatMap((t) => t.files)),
    doneFiles: new Set([...others.filter((t) => t.done), finderTask].flatMap((t) => t.files)),
  }
}

// What a verdict means for the expected answer: the user's call and out of scope both land on the "later" list.
export function outcome(v: Verdict): Expect {
  return v.kind === "task" ? "task" : v.kind === "planned" ? "planned" : v.reason === "user_should_decide" ? "user" : "later"
}

export interface N7Row {
  readonly expect: Expect
  readonly model?: Expect
  readonly rules: Expect
  readonly priority?: string
  readonly modelPriority?: { choice: string; confidence: number }
}

export async function scoreN7(decider: Decider, data: { jobs: Record<string, N7Job>; cases: readonly N7Case[] }): Promise<N7Row[]> {
  const rows: N7Row[] = []
  for (const c of data.cases) {
    const ctx = n7Context(data.jobs[c.job]!, c.finder)
    const items = [c.followUp]
    const asked = await decider.ask("N7", n7State(ctx, items), n7Questions(items))
    const answered = asked.backend !== "rules" && Object.keys(asked.decision.answers).length > 0
    const p = asked.decision.answers["priority.0"]
    rows.push({
      expect: c.expect,
      model: answered ? outcome(triage(asked.decision.answers, items, ctx)[0]!) : undefined,
      rules: outcome(triage({}, items, ctx)[0]!),
      priority: c.priority,
      modelPriority: p?.type === "choice" ? { choice: p.choice, confidence: p.confidence } : undefined,
    })
  }
  return rows
}

export function formatN7(rows: readonly N7Row[]): string {
  const classes: Expect[] = ["task", "planned", "user", "later"]
  const coarse = (e: Expect | undefined) => (e === "user" ? "later" : e)
  const line = (name: string, pick: (r: N7Row) => Expect | undefined) => {
    const per = classes.map((k) => {
      const of = rows.filter((r) => r.expect === k)
      return `${k} ${of.filter((r) => pick(r) === k).length}/${of.length}`
    })
    const exact = rows.filter((r) => pick(r) === r.expect).length
    const rough = rows.filter((r) => coarse(pick(r)) === coarse(r.expect)).length
    return `${name.padEnd(6)} exact ${exact}/${rows.length} · task/planned/later ${rough}/${rows.length} · ${per.join(" · ")}`
  }
  const prio = rows.filter((r) => r.priority && r.modelPriority)
  const prioLine = prio.length
    ? `priority: ${prio.filter((r) => r.modelPriority!.choice === r.priority).length}/${prio.length} right, confidence ${prio.map((r) => r.modelPriority!.confidence.toFixed(2)).join(" ")}`
    : "priority: no answers"
  const model = rows.some((r) => r.model) ? line("model", (r) => r.model) : "model  no answers (no Jev key, or the backend failed)"
  return [model, line("rules", (r) => r.rules), prioLine].join("\n")
}
