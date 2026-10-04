import assert from "node:assert/strict"
import { test } from "node:test"

import { DEFAULT_BACKENDS, Decider, label, type Asker, type BackendName } from "../src/backends.ts"
import { glinerRows, openJevRows, renderState, splitOf } from "../src/dataset.ts"
import { evaluate } from "../src/eval.ts"
import type { Decision, Question } from "../src/jev.ts"
import type { Entry } from "../src/journal.ts"

const QUESTIONS: Record<string, Question> = {
  role: { type: "choice", instructions: "Which role fits?", criteria: { code: "writes code", explore: "reads only" } },
  harmful: { type: "noul", instructions: "This task asks for help to hurt people." },
}

const fixed = (answers: Decision["answers"], calls: string[] = [], name = "x"): Asker => ({
  async ask(state) {
    calls.push(`${name}:${state}`)
    return { answers, model: name, latencyMs: 5 }
  },
})
const failing: Asker = { async ask() { throw new Error("down") } }

const jevAnswers: Decision["answers"] = {
  role: { type: "choice", choice: "code", confidence: 0.9, probabilities: { code: 0.9, explore: 0.1 } },
  harmful: { type: "noul", noul: 0.05 },
}

function decider(askers: Partial<Record<BackendName, Asker>>, shadow?: BackendName) {
  const entries: Entry[] = []
  const d = new Decider({ ...DEFAULT_BACKENDS, shadow }, { rules: { async ask() { return { answers: {}, model: "rules", latencyMs: 0 } } }, ...askers }, (e) => entries.push(e))
  return { d, entries }
}

test("each node uses its backend; G0 and local-only jobs never reach the cloud", () => {
  const { d } = decider({ typesafe: failing, gliner: failing })
  assert.equal(d.backendFor("N5"), "typesafe")
  assert.equal(d.backendFor("G0"), "gliner")
  assert.equal(d.backendFor("N5", true), "gliner")
  const { d: noGliner } = decider({ typesafe: failing })
  assert.equal(noGliner.backendFor("G0"), "rules", "rather rules than the cloud")
  assert.equal(noGliner.backendFor("N5", true), "rules")
})

test("a decision is journaled with its state object, questions and answers", async () => {
  const { d, entries } = decider({ typesafe: fixed(jevAnswers) })
  const asked = await d.ask("N5", { task: "Add a flag" }, QUESTIONS, { job: "job-1", task: "T1" })
  assert.equal(asked.backend, "typesafe")
  const e = entries[0]!
  assert.equal(e.kind, "decision")
  assert.equal(e.id, asked.id)
  assert.deepEqual(e.state, { task: "Add a flag" })
  assert.equal(e.task, "T1")
})

test("a failing backend falls back to rules and says why", async () => {
  const { d, entries } = decider({ typesafe: failing })
  const asked = await d.ask("N5", { task: "x" }, QUESTIONS)
  assert.equal(asked.backend, "rules")
  assert.equal(asked.error, "down")
  assert.deepEqual(asked.decision.answers, {})
  assert.equal(entries[0]!.backend, "rules")
})

test("shadow mode journals the second backend's answers, but never sends local-only work to the cloud", async () => {
  const calls: string[] = []
  const gl = fixed({ role: { type: "choice", choice: "explore", confidence: 0.7, probabilities: { code: 0.3, explore: 0.7 } } }, calls, "gliner")
  const { d, entries } = decider({ typesafe: fixed(jevAnswers, calls, "typesafe"), gliner: gl }, "gliner")
  await d.ask("N5", { task: "x" }, QUESTIONS)
  assert.equal((entries[0]!.shadow as { backend: string }).backend, "gliner")
  const { d: d2, entries: e2 } = decider({ typesafe: fixed(jevAnswers, calls, "typesafe"), gliner: gl }, "typesafe")
  await d2.ask("G0", { text: "secret" }, QUESTIONS)
  assert.equal(e2[0]!.backend, "gliner")
  assert.equal(e2[0]!.shadow, undefined, "the cloud shadow is skipped for G0")
})

async function journalWithLabels(): Promise<Entry[]> {
  const { d, entries } = decider({ typesafe: fixed(jevAnswers) })
  const a = await d.ask("N5", { task: "Add a --csv flag" }, QUESTIONS, { job: "job-1", task: "T1" })
  await d.ask("N5", { task: "Map the repo" }, QUESTIONS, { job: "job-1", task: "T2" })
  label(a.id, "role", "explore", "user_override", (e) => entries.push(e))
  return entries
}

test("Open-Jev rows: a label beats Jev's probabilities; groups decide the split", async () => {
  const rows = openJevRows(await journalWithLabels())
  assert.equal(rows.length, 4)
  const overridden = rows.find((r) => r.id && String(r.id).endsWith("/role") && r.group_id === "T1")!
  assert.deepEqual(overridden.target, [0, 1])
  assert.equal((overridden.metadata as { label_source: string }).label_source, "user_override")
  const soft = rows.find((r) => String(r.id).endsWith("/role") && r.group_id === "T2")!
  assert.deepEqual(soft.target, [0.9, 0.1])
  const noul = rows.find((r) => String(r.id).endsWith("/harmful"))!
  assert.deepEqual(noul.options, ["no", "yes"])
  assert.equal(splitOf("T1"), splitOf("T1"))
})

test("GLiNER rows carry hard labels in the oc-voice format; the state text puts the task first", async () => {
  const rows = glinerRows(await journalWithLabels())
  const first = rows[0] as { input: string; output: { classifications: { task: string; true_label: string; labels: object }[] } }
  assert.match(first.input, /^task: Add a --csv flag/)
  assert.equal(first.output.classifications[0]!.true_label, "explore")
  assert.equal(renderState({ other: 1, text: "hello" }), "text: hello\nother: 1")
})

test("the eval harness reports automatic and wrong rates per question", async () => {
  const entries = await journalWithLabels()
  const [role] = evaluate(entries, 0.8)
  assert.deepEqual({ key: role!.key, labeled: role!.labeled, automatic: role!.automatic, wrong: role!.wrong }, { key: "N5.role", labeled: 1, automatic: 1, wrong: 1 })
  assert.equal(evaluate(entries, 0.95)[0]!.automatic, 0)
})
