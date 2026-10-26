import assert from "node:assert/strict"
import { test } from "node:test"

import type { Contract } from "../src/contract.ts"
import { applyPrefs, baselineForm, draftPrompt, loopholeForm, parseLoopholes, prefsForm, readBaseline, readLoopholes, readPrefs, redteamPrompt, roundFormOf } from "../src/contractround.ts"

const draft = (): Contract => ({
  id: "C1", version: 1, status: "draft", goal: "faster search", evaluator: "sh bench.sh", timeoutMs: 1000, repeats: 1,
  scores: [{ name: "hits", direction: "max" }, { name: "ms", direction: "min" }],
  guards: [{ name: "hits", direction: "max", tolerance: 0, origin: "draft" }, { name: "mem", direction: "min", tolerance: 0.2, origin: "draft" }],
  corpus: { visible: [] }, baseline: { values: { ms: 100, hits: 10, mem: 50 }, at: "" }, stop: { evaluations: 20 }, history: [],
})

test("the preferences form asks what decides, which guards stay, how far they give, the target and the red team", () => {
  const c = draft()
  const form = prefsForm(c)
  assert.deepEqual(form.map((q) => q.header), ["C1 decides", "C1 guards", "C1 preferences", "C1 target", "C1 red team"])
  assert.match(form[0]!.question, /Today: hits 10 \(higher is better\), ms 100 \(lower is better\)/)
  assert.equal(form[1]!.multiple, true)
  assert.deepEqual(roundFormOf(form), { id: "C1", part: "prefs" })
  const prefs = readPrefs(c, form, [["ms"], ["hits"], ["A little (5 %)"], ["25 % better (Recommended)"], ["Yes, red team first"]])
  assert.deepEqual(prefs, { decides: "ms", guards: ["hits"], tolerance: 0.05, target: 0.25, redteam: true })
  applyPrefs(c, prefs)
  assert.deepEqual(c.scores.map((s) => s.name), ["ms", "hits"])
  assert.deepEqual(c.guards, [{ name: "hits", direction: "max", tolerance: 0.05, origin: "draft" }])
  assert.deepEqual(c.stop, { evaluations: 20, target: { ms: 75 } })
  // Typed answers: a number is a target or a tolerance; anything else is kept as what the user said.
  assert.deepEqual(readPrefs(c, form, [[], [], ["10"], ["15 %"], ["No, skip it"]]), { guards: [], tolerance: 0.1, target: 0.15, redteam: false })
  assert.equal(readPrefs(c, form, [["whatever is fastest"], [], [], [], []]).said, "whatever is fastest")
  applyPrefs(c, { target: null, redteam: false })
  assert.equal(c.stop.target, undefined)
})

test("the red team reports loopholes, with the guard that would catch each where it can name one", () => {
  assert.match(draftPrompt("faster search"), /^Work out a fitness contract for this goal: faster search/)
  assert.match(redteamPrompt(draft()), /You are the red team of fitness contract C1: faster search/)
  const found = parseLoopholes("STATUS: DONE\nLOOPHOLE: returned cached hits for the corpus files | guard: mem min 10 %\n**LOOPHOLE:** skipped the index when MM_CORPUS is set\nLOOPHOLE: none")
  assert.deepEqual(found, [
    { what: "returned cached hits for the corpus files", guard: { name: "mem", direction: "min", tolerance: 0.1, origin: "redteam" } },
    { what: "skipped the index when MM_CORPUS is set" },
  ])
  const c = { ...draft(), round: { step: "loopholes" as const, loopholes: found } }
  const form = loopholeForm(c)
  assert.equal(form[0]!.header, "C1 loopholes")
  assert.deepEqual(form[0]!.options.map((o) => o.label), ["L1", "L2"])
  assert.match(form[0]!.options[0]!.description, /\(guard: mem min 10 %\)$/)
  assert.deepEqual(readLoopholes(["L2", "L1", "something"]), [1, 0])
  assert.deepEqual(roundFormOf(form), { id: "C1", part: "loopholes" })
})

test("the baseline form shows each score's spread over the runs, and the answer is read by its label", () => {
  const form = baselineForm(draft(), { visible: [{ valid: true, values: { hits: 10, ms: 98 } }, { valid: true, values: { hits: 10, ms: 103 } }, { valid: false, values: {} }], heldOut: [{ valid: true, values: { hits: 4, ms: 50 } }] }, 2.5)
  assert.match(form[0]!.question, /3 runs \(2\.5s in all\): hits: 10, held-out 4; ms: 98 to 103, held-out 50\./)
  assert.deepEqual(readBaseline(["Plausible: freeze it"]), { decision: "plausible" })
  assert.deepEqual(readBaseline(["Measure again"]), { decision: "again" })
  assert.deepEqual(readBaseline(["the corpus is too small"]), { said: "the corpus is too small" })
  assert.deepEqual(roundFormOf(form), { id: "C1", part: "baseline" })
  assert.equal(roundFormOf([{ header: "Grant G1" }]), undefined)
})
