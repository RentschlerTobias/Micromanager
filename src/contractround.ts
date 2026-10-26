// The contract round (design.md §25, P5): how a fitness contract is worked out before any writer is measured against
// it. A draft contract says what one model thinks "better" means; the round makes it the user's:
// 1. draft: a reader reads the code, the tests and the data and writes the contract as JSON (the contract tool
//    measures its baseline);
// 2. prefs: the user picks what decides, which guards stay and how far they may give, and the target, in a form;
// 3. redteam: a writer of another model family tries to raise the score WITHOUT improving the goal, in its own
//    worktree, never merged; every loophole it reports can become a guard;
// 4. loopholes: the user picks the loopholes to close, in a form;
// 5. baseline: today's code measured again, three times on both corpora, and shown with its spread: "does this measure
//    what I mean?";
// 6. frozen: the evaluator and the visible corpus are hashed (a worker cannot change them), and writers may be
//    measured against it from now on.
// The micromanager drives it with contract_round and the forms; the plugin keeps the state on the contract.

import { formInput, type Question } from "./forms.ts"
import type { Contract, Direction, Guard, Measured } from "./contract.ts"

export type RoundStep = "prefs" | "redteam" | "loopholes" | "baseline" | "frozen"

export interface Loophole {
  readonly what: string
  readonly guard?: Guard // the guard that closes it, when the red team could name one
}

export interface Round {
  step: RoundStep
  loopholes: Loophole[]
  redteam?: string // the red team's task id
}

declare module "./contract.ts" {
  interface Contract {
    round?: Round
  }
}

declare module "./state.ts" {
  interface Task {
    redteam?: string // the contract this writer tries to game, for its round; never merged
  }
}

// What the drafter is asked: a contract as the contract tool takes it, from what the project has.
export function draftPrompt(goal: string): string {
  return [
    `Work out a fitness contract for this goal: ${goal}`,
    "Read the code, the tests, the benchmarks and the data the project has, then write what \"better\" means as JSON, in a ```json fence at the end of your answer:",
    '{"goal": what the work is for; "evaluator": one shell command, run in the project directory, that prints a line MM_SCORE {"scores": {"<name>": <number>, …}, "cases": {"passed": n, "total": m}} and exits 0 (a crash, a timeout or a wrong output must make it exit non-zero); "scores": [{"name", "direction": "min"|"max", "noise": the relative spread two runs of the same code show}] (the first decides); "guards": [{"name", "direction", "tolerance": 0.05}] (values that must not get worse: correctness counts, sizes, memory; each one a way to raise the score without improving the goal that it closes); "corpus": {"visible": [the project paths it measures on]}; "repeats": 3 for timings, 1 otherwise; "timeoutSeconds"; "stop": {"evaluations": n}}',
    "If the project has no command that measures this yet, say so plainly and describe the script that would (its path, what it runs, what it prints): a writer makes it first. Do not invent numbers.",
    "Name what you are unsure about: which inputs matter, which thresholds are good enough. The user decides those next.",
  ].join("\n")
}

// What the red team is told: game the number, report how.
export function redteamPrompt(c: Contract): string {
  return [
    `You are the red team of fitness contract ${c.id}: ${c.goal}`,
    `Try to raise its score without improving the goal itself: special-case the inputs it measures, skip the work when it is measured, cache what it reads, weaken what it checks, change what it counts. The plugin measures your change with \`${c.evaluator}\` when your checks pass; your work is never merged.`,
    "End your report with one line per way you found, whether it worked or not:",
    "LOOPHOLE: what you did and what the score did | guard: <a measured value> <min|max> <tolerance> (the guard that would catch it, if a value the evaluator prints already shows it; leave out the part after | if none does)",
  ].join("\n")
}

// The red team's LOOPHOLE lines, with the guard each one names when it names one the contract can measure.
export function parseLoopholes(report: string): Loophole[] {
  return [...report.matchAll(/^\s*\**LOOPHOLE\**\s*:\**\s*(.+)$/gim)]
    .map((m) => m[1]!.split("|").map((p) => p.trim()))
    .filter(([what]) => what && !/^(none|nothing|-)$/i.test(what))
    .slice(0, 8)
    .map(([what, guard]) => {
      const g = guard?.match(/^guard:\s*([A-Za-z_][\w.-]*)\s+(min|max)\s+([\d.]+)\s*%?$/i)
      if (!g) return { what: what! }
      const tolerance = Number(g[3]) > 1 ? Number(g[3]) / 100 : Number(g[3])
      return { what: what!, guard: { name: g[1]!, direction: g[2]!.toLowerCase() as Direction, tolerance, origin: "redteam" as const } }
    })
}

const KEEP = { none: "No target: run to the budget" } as const
const BASELINE = { plausible: "Plausible: freeze it", again: "Measure again", change: "Change the contract" } as const
const TOLERANCE: Record<string, number> = { "Not at all (0 %)": 0, "A little (5 %)": 0.05, "Some (20 %)": 0.2 }
const TARGETS: Record<string, number> = { "10 % better": 0.1, "25 % better": 0.25, "50 % better": 0.5 }

export const roundHeader = (c: Pick<Contract, "id">, part: "preferences" | "decides" | "guards" | "target" | "red team" | "loopholes" | "baseline") => `${c.id} ${part}`

// The user's preferences: what decides, which guards stay and how far they may give, the target, and whether a red
// team tries the contract first.
export function prefsForm(c: Contract): Question[] {
  const form: Question[] = [{
    header: roundHeader(c, "decides"),
    question: `Contract ${c.id} (${c.goal.slice(0, 120)}): which score decides? Today: ${c.scores.map((s) => `${s.name} ${c.baseline?.values[s.name] ?? "?"} (${s.direction === "min" ? "lower" : "higher"} is better)`).join(", ")}.`,
    options: c.scores.map((s, i) => ({ label: s.name, description: `${s.direction === "min" ? "Lower" : "Higher"} is better${i === 0 ? " (the draft's choice)" : ""}` })),
  }]
  if (c.guards.length) {
    form.push({
      header: roundHeader(c, "guards"),
      question: "Which of these must not get worse? Each closes a way to raise the score without improving the goal. Tick the ones to keep; none ticked keeps none.",
      multiple: true,
      options: c.guards.map((g) => ({ label: g.name, description: `${g.direction === "min" ? "lower" : "higher"} is better; today ${c.baseline?.values[g.name] ?? "?"}` })),
    })
  }
  form.push(
    {
      header: roundHeader(c, "preferences"),
      question: "How much may a guard get worse than today?",
      options: Object.keys(TOLERANCE).map((label) => ({ label, description: label.startsWith("Not") ? "Any change for the worse fails" : "Room for noise and small trade-offs" })),
    },
    {
      header: roundHeader(c, "target"),
      question: `When is it good enough? The work stops early once the deciding score is this much better than today${c.stop.evaluations ? `, and after ${c.stop.evaluations} evaluations in any case` : ""}.`,
      options: [...Object.keys(TARGETS).map((label) => ({ label, description: "Than today's value of the deciding score" })), { label: KEEP.none, description: "Keep improving until the budget or the stop rule ends it" }],
    },
    {
      header: roundHeader(c, "red team"),
      question: "Should a red team try to game the score first (a worker on another model, about one task's cost)?",
      options: [{ label: "Yes, red team first", description: "Each loophole it finds can become a guard" }, { label: "No, skip it", description: "Go straight to the baseline check" }],
    },
  )
  return form
}

export interface Prefs {
  readonly decides?: string
  readonly guards?: readonly string[] // undefined: the question was not asked
  readonly tolerance?: number
  readonly target?: number | null // null: no target
  readonly redteam: boolean
  readonly said?: string // text the user typed instead of a label
}

const clean = (a: string) => a.trim().replace(/\s*\(recommended\)\s*$/i, "")

// The answers to the preferences form; typed text in place of a target or a tolerance is read as a number where it is
// one ("15", "15 %").
export function readPrefs(c: Contract, questions: readonly Partial<Question>[], answers: readonly (readonly string[])[]): Prefs {
  const of = (part: Parameters<typeof roundHeader>[1]) => {
    const i = questions.findIndex((q) => q.header === roundHeader(c, part))
    return i >= 0 ? (answers[i] ?? []).map(clean) : undefined
  }
  const pct = (s: string) => {
    const m = s.match(/^(\d+(?:\.\d+)?)\s*%?$/)
    return m ? Number(m[1]) / 100 : undefined
  }
  const decides = of("decides")?.find((a) => c.scores.some((s) => s.name === a))
  const guards = of("guards")?.filter((a) => c.guards.some((g) => g.name === a))
  const tol = of("preferences")?.[0]
  const tolerance = tol === undefined ? undefined : TOLERANCE[tol] ?? pct(tol)
  const tg = of("target")?.[0]
  const target = tg === undefined ? undefined : tg === KEEP.none ? null : TARGETS[tg] ?? pct(tg) ?? undefined
  const said = [...(of("decides") ?? []), ...(of("target") ?? [])].find((a) => a && !c.scores.some((s) => s.name === a) && TARGETS[a] === undefined && a !== KEEP.none && pct(a) === undefined)
  return { ...(decides ? { decides } : {}), ...(guards ? { guards } : {}), ...(tolerance !== undefined ? { tolerance } : {}), ...(target !== undefined ? { target } : {}), redteam: !(of("red team") ?? []).some((a) => a.startsWith("No")), ...(said ? { said } : {}) }
}

// The preferences, applied: the deciding score first, the guards the user kept with their tolerance, and the target
// as a value of the deciding score.
export function applyPrefs(c: Contract, p: Prefs): void {
  if (p.decides) c.scores = [...c.scores.filter((s) => s.name === p.decides), ...c.scores.filter((s) => s.name !== p.decides)]
  if (p.guards) c.guards = c.guards.filter((g) => p.guards!.includes(g.name))
  if (p.tolerance !== undefined) c.guards = c.guards.map((g) => ({ ...g, tolerance: p.tolerance! }))
  const first = c.scores[0]!
  const base = c.baseline?.values[first.name]
  if (p.target === null) c.stop = { ...c.stop, target: undefined }
  else if (p.target !== undefined && base !== undefined) {
    const goal = first.direction === "min" ? base * (1 - p.target) : base * (1 + p.target)
    c.stop = { ...c.stop, target: { [first.name]: Math.round(goal * 1000) / 1000 } }
  }
}

// The loopholes the red team found, for the user to close.
export function loopholeForm(c: Contract): Question[] {
  return [{
    header: roundHeader(c, "loopholes"),
    question: `The red team of contract ${c.id} found these ways to raise the score without improving the goal. Tick the ones to close (a guard is added where it named one; the others are noted for the corpus):`,
    multiple: true,
    options: (c.round?.loopholes ?? []).map((l, i) => ({ label: `L${i + 1}`, description: `${l.what.slice(0, 160)}${l.guard ? ` (guard: ${l.guard.name} ${l.guard.direction} ${Math.round(l.guard.tolerance * 100)} %)` : ""}` })),
  }]
}

export function readLoopholes(answers: readonly string[]): number[] {
  return answers.map(clean).flatMap((a) => (/^L\d+$/.test(a) ? [Number(a.slice(1)) - 1] : []))
}

// The baseline as the user sees it before the freeze: each score's median and spread over the runs, on both corpora.
export function baselineForm(c: Contract, runs: { visible: readonly Measured[]; heldOut: readonly Measured[] }, seconds: number): Question[] {
  const spread = (ms: readonly Measured[], name: string) => {
    const xs = ms.filter((m) => m.valid).map((m) => m.values[name]).filter((v): v is number => v !== undefined)
    if (!xs.length) return "no valid run"
    const lo = Math.min(...xs)
    const hi = Math.max(...xs)
    return lo === hi ? `${lo}` : `${lo} to ${hi}`
  }
  const values = c.scores.map((s) => `${s.name}: ${spread(runs.visible, s.name)}${runs.heldOut.length ? `, held-out ${spread(runs.heldOut, s.name)}` : ""}`).join("; ")
  return [{
    header: roundHeader(c, "baseline"),
    question: `Today's code under contract ${c.id}, ${runs.visible.length} runs (${seconds}s in all): ${values}. Does this measure what you mean?`,
    options: [
      { label: BASELINE.plausible, description: "The evaluator and its corpus are frozen; writers are measured against it from now on" },
      { label: BASELINE.again, description: "Run the baseline again" },
      { label: BASELINE.change, description: "Say what is wrong; the contract comes back as a new draft" },
    ],
  }]
}

export function readBaseline(answers: readonly string[]): { decision?: "plausible" | "again" | "change"; said?: string } {
  for (const a of answers.map(clean)) {
    const k = (Object.keys(BASELINE) as (keyof typeof BASELINE)[]).find((x) => BASELINE[x].toLowerCase() === a.toLowerCase())
    if (k) return { decision: k }
  }
  const said = answers.find((a) => a.trim())
  return said ? { said: said.trim() } : {}
}

// Which contract and which of its forms a submitted form is, from its headers; undefined for any other form.
export function roundFormOf(questions: readonly Partial<Question>[]): { id: string; part: "prefs" | "loopholes" | "baseline" } | undefined {
  for (const q of questions) {
    const m = q.header?.match(/^(C\d+) (decides|guards|preferences|target|red team|loopholes|baseline)$/)
    if (!m) continue
    return { id: m[1]!, part: m[2] === "loopholes" ? "loopholes" : m[2] === "baseline" ? "baseline" : "prefs" }
  }
  return undefined
}

// The instruction that puts a form to the user.
export function askWith(form: readonly Question[], what: string): string {
  return `${what} Ask the user with the question tool, with exactly this input (a form; its answer reaches the plugin by itself), then end your turn:\n${formInput(form)}`
}
