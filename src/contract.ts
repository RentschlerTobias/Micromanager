// The fitness contract (design.md §25): what "better" means for a task that has no fixed end state ("make the search
// faster", "make meshing more reliable"), settled before a worker spends anything on it. A build task is done when its
// checks pass; an optimization task is never done that way, so it needs a number with a direction, a baseline to
// compare with, and guards against raising the number without improving the goal.
//
// The contract is the same for every domain and every search method: a single worker, a trial (the best score wins
// among the green attempts), and later lanes or an evolver. Its evaluator is one shell command that prints one line
//   MM_SCORE {"valid":true,"scores":{"p50_ms":12.3},"cases":{"passed":7,"total":8},"category":"…"}
// and anything else -- a non-zero exit, a timeout, no such line, "valid":false, a score the contract names missing --
// makes the result invalid, which scores below everything (the hard constraints).

import { createHash } from "node:crypto"
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

import { journalPath } from "./journal.ts"
import { checkProblem, checkSafetyProblem } from "./plan.ts"
import type { Run } from "./integration.ts"

// The contract travels with the job's JSON; state.ts owns the interfaces, the fields are declared here (as
// integration.ts does) so the contract's types stay in one file.
declare module "./state.ts" {
  interface Job {
    contracts?: Contract[]
  }
  interface Task {
    contract?: { id: string; version: number } // the contract its work is measured against
    score?: Measured & { corpus: "visible" | "heldout"; at: string } // its last valid measurement
    graded?: { passed: number; total: number } // what its checks' own MM_SCORE lines counted, at its last gate
    // A trial attempt measured against a contract whose checks passed: committed, kept in its worktree, and waiting for
    // the trial to be decided by score (src/native.ts settle) instead of merging first.
    held?: boolean
    settleBy?: string // on a trial's first attempt: when the trial is decided at the latest
  }
}

export type Direction = "min" | "max"

export interface Score {
  readonly name: string
  readonly direction: Direction
  // A relative band inside which two values count as equal (0.05: 5 %): a timing measured twice is never the same
  // number, and without a band "the best wins" picks noise.
  readonly noise?: number
}

// A value that must not get worse than the baseline by more than tolerance (relative; absolute when the baseline is
// 0). It is how a contract closes a loophole: "faster, but the element count stays within 20 %".
export interface Guard {
  readonly name: string
  readonly direction: Direction // which way is better
  readonly tolerance: number
  readonly origin: "user" | "draft" | "redteam"
}

export interface Corpus {
  readonly visible: readonly string[] // project paths the evaluator measures on, which workers may read
  readonly heldOut?: { readonly hash: string; readonly cases: number } // kept outside the project (P4); never its content
}

export interface Measured {
  readonly valid: boolean
  readonly values: Readonly<Record<string, number>>
  readonly cases?: { readonly passed: number; readonly total: number }
  readonly category?: string // the evaluator's own word for what went wrong, coarse enough to show a worker
  readonly error?: string // why the result is invalid
}

export interface Contract {
  readonly id: string // "C1", per job
  version: number
  status: "draft" | "frozen"
  goal: string
  evaluator: string // a shell command, run in the worker's directory
  timeoutMs: number
  repeats: number // runs per measurement; the median counts
  scores: Score[] // the first is the primary score, the others break ties inside its noise band
  guards: Guard[]
  corpus: Corpus
  baseline?: { values: Record<string, number>; heldOut?: Record<string, number>; at: string; commit?: string }
  stop: { target?: Record<string, number>; plateau?: number; evaluations?: number; seconds?: number }
  costPerEval?: number // seconds per run, measured with the baseline
  used?: { evaluations: number; seconds: number }
  history: { version: number; change: string; at: string }[]
}

// A line that starts like one but holds no JSON object is a broken result, not output to skip.
const LINE = /^MM_SCORE\s+(.*)$/

// The last MM_SCORE line of a run's output, read as a measurement. Undefined when there is none: for an ordinary check
// that means nothing was graded, for an evaluator that the result is invalid.
export function parseScoreLines(stdout: string): Measured | undefined {
  const line = stdout.split("\n").map((l) => l.trim()).filter((l) => LINE.test(l)).at(-1)
  if (!line) return undefined
  let o: Record<string, unknown>
  try {
    o = JSON.parse(line.match(LINE)![1]!) as Record<string, unknown>
  } catch {
    return { valid: false, values: {}, error: "the MM_SCORE line is no JSON object" }
  }
  const values: Record<string, number> = {}
  for (const [k, v] of Object.entries((o.scores ?? {}) as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) values[k] = v
  const c = o.cases as { passed?: unknown; total?: unknown } | undefined
  const cases = c && typeof c.passed === "number" && typeof c.total === "number" && c.total > 0 ? { passed: c.passed, total: c.total } : undefined
  return {
    valid: o.valid !== false,
    values,
    ...(cases ? { cases } : {}),
    ...(typeof o.category === "string" && o.category ? { category: o.category.slice(0, 80) } : {}),
  }
}

// One evaluator run as a measurement: the hard constraints first, then the line itself.
export function measuredOf(contract: Contract, run: Run): Measured {
  if (run.timedOut) return { valid: false, values: {}, error: `the evaluator timed out after ${Math.round(contract.timeoutMs / 1000)}s` }
  const m = parseScoreLines(run.stdout)
  if (run.code !== 0) return { valid: false, values: m?.values ?? {}, ...(m?.category ? { category: m.category } : {}), error: `the evaluator exited ${run.code}: ${`${run.stderr}`.trim().slice(-300) || "no output"}` }
  if (!m) return { valid: false, values: {}, error: "the evaluator printed no MM_SCORE line" }
  if (!m.valid) return { ...m, error: m.error ?? `the evaluator reported the result invalid${m.category ? ` (${m.category})` : ""}` }
  const missing = contract.scores.map((s) => s.name).filter((n) => !(n in m.values))
  if (missing.length) return { ...m, valid: false, error: `the MM_SCORE line lacks ${missing.join(", ")}` }
  return m
}

// Repeated runs as one measurement: any invalid run makes it invalid (a crash that happens once in three is a crash),
// and each value is the median of its runs.
export function median(runs: readonly Measured[]): Measured {
  const bad = runs.find((r) => !r.valid)
  if (bad || !runs.length) return bad ?? { valid: false, values: {}, error: "nothing was measured" }
  const mid = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b)
    return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2
  }
  const values: Record<string, number> = {}
  for (const k of Object.keys(runs[0]!.values)) {
    const xs = runs.map((r) => r.values[k]).filter((v): v is number => v !== undefined)
    if (xs.length === runs.length) values[k] = mid(xs)
  }
  const last = runs.at(-1)!
  return { valid: true, values, ...(last.cases ? { cases: last.cases } : {}), ...(last.category ? { category: last.category } : {}) }
}

// How much worse b is than a for a value with this direction, relative to a (absolute when a is 0); negative: better.
function worse(direction: Direction, a: number, b: number): number {
  const d = direction === "min" ? b - a : a - b
  return a === 0 ? d : d / Math.abs(a)
}

// The guards a measurement breaks against the baseline. Without a baseline there is nothing to compare with.
export function guardViolations(c: Contract, m: Measured): string[] {
  if (!c.baseline) return []
  return c.guards.flatMap((g) => {
    const base = c.baseline!.values[g.name]
    const now = m.values[g.name]
    if (base === undefined) return []
    if (now === undefined) return [`${g.name} was not measured`]
    const by = worse(g.direction, base, now)
    return by > g.tolerance ? [`${g.name} is ${fmt(now)}, worse than the baseline ${fmt(base)} by more than ${Math.round(g.tolerance * 100)} %`] : []
  })
}

// Which of two measurements is better under the contract: > 0 when a is, < 0 when b is, 0 when they count as equal.
// An invalid result loses to any valid one; the scores decide in their order, each inside its noise band.
export function better(c: Contract, a: Measured, b: Measured): number {
  if (a.valid !== b.valid) return a.valid ? 1 : -1
  if (!a.valid) return 0
  for (const s of c.scores) {
    const x = a.values[s.name]
    const y = b.values[s.name]
    if (x === undefined || y === undefined) continue
    const scale = Math.max(Math.abs(x), Math.abs(y))
    if (scale === 0 || Math.abs(x - y) / scale <= (s.noise ?? 0)) continue
    return (s.direction === "min" ? y - x : x - y) > 0 ? 1 : -1
  }
  return 0
}

// The primary score's improvement over the baseline, signed so that better is positive: the reward the outcome log
// keeps for the router. 0 for an invalid result; undefined without a baseline to compare with.
export function reward(c: Contract, m: Measured): number | undefined {
  if (!m.valid) return 0
  const s = c.scores[0]
  const base = s && c.baseline?.values[s.name]
  const now = s && m.values[s.name]
  if (base === undefined || now === undefined) return undefined
  return Math.round(-worse(s.direction, base, now) * 1e4) / 1e4
}

// What a worker may hear of a held-out measurement: how many cases passed, or the category, never values per case.
export function coarse(m: Measured): string {
  if (m.cases) return `${m.cases.passed}/${m.cases.total} passed`
  if (!m.valid) return `invalid${m.category ? ` (${m.category})` : ""}`
  return "valid"
}

// A measurement in one line, next to the baseline: what a stage, a note and a worker see.
export function describe(c: Contract, m: Measured): string {
  if (!m.valid) return m.error ?? "invalid"
  return c.scores
    .map((s) => {
      const v = m.values[s.name]
      const base = c.baseline?.values[s.name]
      return v === undefined ? "" : `${s.name} ${fmt(v)}${base !== undefined ? ` (baseline ${fmt(base)})` : ""}`
    })
    .filter(Boolean)
    .join(", ")
}

function fmt(n: number): string {
  return Math.abs(n) >= 100 || Number.isInteger(n) ? String(Math.round(n * 100) / 100) : n.toPrecision(3)
}

// The held-out cases of a contract (design.md §25, P4): outside the project and every worktree, in the plugin's state
// directory, which the sandbox keeps from every worker. Only the evaluator sees them, through MM_CORPUS_DIR, and a
// worker only hears how many passed.
export function heldOutRoot(): string {
  return join(dirname(journalPath()), "heldout")
}

export function heldOutDir(project: string, jobId: string, contractId: string): string {
  return join(heldOutRoot(), createHash("sha256").update(resolve(project)).digest("hex").slice(0, 12), jobId, contractId)
}

// Copies the held-out cases from a directory outside the project into the contract's held-out directory: their hash
// and count go into the contract, never their content. Returns why not instead when the directory will not do: it
// has to exist, hold files, and lie outside the project, because anything inside it is in every worker's checkout.
export function keepHeldOut(from: string, project: string, to: string): { heldOut?: { hash: string; cases: number }; problem?: string } {
  if (!isAbsolute(from)) return { problem: "corpus.heldOutFrom must be an absolute path" }
  const rel = relative(resolve(project), resolve(from))
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return { problem: "corpus.heldOutFrom must lie outside the project: anything inside it reaches every worker" }
  if (!existsSync(from) || !statSync(from).isDirectory()) return { problem: `corpus.heldOutFrom ${from} is no directory` }
  const files = (readdirSync(from, { recursive: true }) as string[]).filter((f) => statSync(join(from, f)).isFile()).sort()
  if (!files.length) return { problem: `corpus.heldOutFrom ${from} holds no files` }
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true })
  const hash = createHash("sha256")
  for (const f of files) hash.update(f).update("\0").update(readFileSync(join(from, f)))
  return { heldOut: { hash: hash.digest("hex").slice(0, 16), cases: files.length } }
}

// Whether a measurement reaches the contract's target on every score it names.
export function reached(c: Contract, m: Measured | undefined): boolean {
  const target = c.stop.target
  if (!m?.valid || !target || !Object.keys(target).length) return false
  return Object.entries(target).every(([name, goal]) => {
    const v = m.values[name]
    const s = c.scores.find((x) => x.name === name) ?? c.guards.find((x) => x.name === name)
    return v !== undefined && s !== undefined && (s.direction === "min" ? v <= goal : v >= goal)
  })
}

// The parts that define what is measured; a change to any of them is a new version.
export function contractHash(c: Contract): string {
  const { goal, evaluator, scores, guards, corpus, stop, repeats } = c
  return createHash("sha256").update(JSON.stringify({ goal, evaluator, scores, guards, corpus, stop, repeats })).digest("hex").slice(0, 16)
}

const DIRECTIONS = new Set(["min", "max"])
const NAME = /^[A-Za-z_][\w.-]{0,47}$/

// A contract from the micromanager's JSON, validated; the id, version and status are the caller's. errors is empty when
// it is usable. The evaluator goes through the same rules as a check: it is a model-written string handed to `sh -c`.
export function parseContract(json: string): { contract?: Omit<Contract, "id" | "version" | "status" | "history">; heldOutFrom?: string; errors: string[] } {
  let o: Record<string, unknown>
  try {
    o = JSON.parse(json) as Record<string, unknown>
  } catch (err) {
    return { errors: [`the contract is no JSON object: ${err instanceof Error ? err.message : String(err)}`] }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { errors: ["the contract is no JSON object"] }
  const errors: string[] = []
  const goal = typeof o.goal === "string" ? o.goal.trim() : ""
  if (!goal) errors.push("goal: say in words what the work is for")
  const evaluator = typeof o.evaluator === "string" ? o.evaluator.trim() : ""
  if (!evaluator) errors.push('evaluator: a shell command that prints a line MM_SCORE {"scores":{...}}')
  else {
    const why = checkProblem(evaluator) ?? checkSafetyProblem(evaluator)
    if (why) errors.push(`evaluator: ${why}`)
  }
  const scores: Score[] = []
  for (const [i, s] of (Array.isArray(o.scores) ? o.scores : []).entries()) {
    const x = (s ?? {}) as Record<string, unknown>
    if (typeof x.name !== "string" || !NAME.test(x.name) || !DIRECTIONS.has(String(x.direction))) {
      errors.push(`scores[${i}]: needs a name (letters, digits, _ . -) and a direction "min" or "max"`)
      continue
    }
    const noise = typeof x.noise === "number" && x.noise >= 0 && x.noise < 1 ? x.noise : undefined
    scores.push({ name: x.name, direction: x.direction as Direction, ...(noise !== undefined ? { noise } : {}) })
  }
  if (!scores.length) errors.push("scores: at least one, the first is the one that decides")
  if (new Set(scores.map((s) => s.name)).size !== scores.length) errors.push("scores: a name is given twice")
  const guards: Guard[] = []
  for (const [i, g] of (Array.isArray(o.guards) ? o.guards : []).entries()) {
    const x = (g ?? {}) as Record<string, unknown>
    const tolerance = typeof x.tolerance === "number" && x.tolerance >= 0 ? x.tolerance : undefined
    if (typeof x.name !== "string" || !NAME.test(x.name) || !DIRECTIONS.has(String(x.direction)) || tolerance === undefined) {
      errors.push(`guards[${i}]: needs a name, a direction "min" or "max" (which way is better) and a tolerance >= 0 (0.2: 20 % worse than the baseline at most)`)
      continue
    }
    guards.push({ name: x.name, direction: x.direction as Direction, tolerance, origin: x.origin === "redteam" || x.origin === "draft" ? x.origin : "user" })
  }
  const c = (o.corpus ?? {}) as Record<string, unknown>
  const visible = (Array.isArray(c.visible) ? c.visible : []).map(String).map((p) => p.trim()).filter(Boolean)
  const outside = visible.filter((p) => p.startsWith("/") || p.split("/").includes(".."))
  if (outside.length) errors.push(`corpus.visible: project paths only, not ${outside.join(", ")}`)
  const st = (o.stop ?? {}) as Record<string, unknown>
  const num = (v: unknown, min = 0) => (typeof v === "number" && Number.isFinite(v) && v > min ? v : undefined)
  const target: Record<string, number> = {}
  for (const [k, v] of Object.entries((st.target ?? {}) as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) target[k] = v
  const stop = {
    ...(Object.keys(target).length ? { target } : {}),
    ...(num(st.plateau) ? { plateau: Math.round(num(st.plateau)!) } : {}),
    ...(num(st.evaluations) ? { evaluations: Math.round(num(st.evaluations)!) } : {}),
    ...(num(st.seconds) ? { seconds: num(st.seconds)! } : {}),
  }
  const repeats = Math.min(10, Math.max(1, Math.round(num(o.repeats) ?? 1)))
  const timeoutMs = Math.min(3_600_000, Math.max(1000, Math.round((num(o.timeoutSeconds) ?? 300) * 1000)))
  const heldOutFrom = typeof c.heldOutFrom === "string" && c.heldOutFrom.trim() ? c.heldOutFrom.trim() : undefined
  if (errors.length) return { errors }
  return { contract: { goal, evaluator, timeoutMs, repeats, scores, guards, corpus: { visible }, stop }, ...(heldOutFrom ? { heldOutFrom } : {}), errors }
}

// What a writer measured against a contract is told about it.
export function contractBrief(c: Contract): string {
  const scores = c.scores.map((s) => `${s.name} (${s.direction === "min" ? "lower" : "higher"} is better${c.baseline?.values[s.name] !== undefined ? `, today ${fmt(c.baseline.values[s.name]!)}` : ""})`)
  const guards = c.guards.map((g) => `${g.name} may not get ${g.direction === "min" ? "higher" : "lower"} than today by more than ${Math.round(g.tolerance * 100)} %`)
  return [
    `Your work is measured against fitness contract ${c.id} (version ${c.version}): ${c.goal}`,
    `When your checks pass, the plugin runs its evaluator, \`${c.evaluator}\`, ${c.repeats > 1 ? `${c.repeats} times (the median counts)` : "once"}. Scores, the first decides: ${scores.join("; ")}.`,
    guards.length ? `Guards: ${guards.join("; ")}.` : "",
    "An invalid result (a crash, a timeout, a wrong output) or a broken guard counts as a failing check. Improve the goal itself: a change that only raises the number is what the guards are there to catch.",
  ].filter(Boolean).join("\n")
}
