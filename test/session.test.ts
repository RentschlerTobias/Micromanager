import assert from "node:assert/strict"
import { test } from "node:test"

import { DEFAULT_BACKENDS, Decider, type Asker } from "../src/backends.ts"
import { checkGuards, flagsWithoutUser, gateAnswer, gateQuestion } from "../src/gate.ts"
import type { Decision } from "../src/jev.ts"
import {
  addNodes, applyAnswer, applyShortcut, decisionsText, frontier, instruction, matchSessionShortcut, nextStep, parseTree,
  type DesignTree,
} from "../src/session.ts"

const DRAFT = [
  { id: "D1", question: "Is the export a CLI flag or a separate command?", kind: "decision", dependsOn: [], impact: "high" },
  { id: "D2", question: "How are fields with commas quoted?", kind: "decision", dependsOn: ["D1"], impact: "medium" },
  { id: "D3", question: "Should the header row be optional?", kind: "decision", dependsOn: [], impact: "low" },
  { id: "F1", question: "Does the project already have a CSV dependency?", kind: "fact", dependsOn: [], impact: "medium" },
]

const tree = (): DesignTree => parseTree(DRAFT).tree!

test("the draft is validated: ids, kinds, impact, unknown dependencies, cycles, size", () => {
  assert.ok(tree())
  const bad = parseTree([
    { id: "A", question: "First question?", impact: "high", dependsOn: ["B"] },
    { id: "B", question: "Second question?", impact: "high", dependsOn: ["A"] },
    { id: "C", question: "x", impact: "huge" },
  ]).errors!
  assert.ok(bad.some((e) => e.includes("needs the question text")) && bad.some((e) => e.includes("impact")), bad.join("\n"))
  assert.deepEqual(parseTree([{ id: "A", question: "First question?", impact: "high", dependsOn: ["Z"] }]).errors, ["A: depends on unknown Z"])
  assert.ok(parseTree([{ id: "A", question: "Q one?", impact: "high", dependsOn: ["B"] }, { id: "B", question: "Q two?", impact: "high", dependsOn: ["A"] }]).errors![0]!.includes("cycle"))
  assert.match(parseTree(Array.from({ length: 26 }, (_, i) => ({ id: `Q${i}`, question: "A question?", impact: "high" }))).errors![0]!, /at most 25/)
})

test("one question per turn: high impact first, dependents only after their prerequisite, low impact assumed", () => {
  const t = tree()
  const first = nextStep(t)
  assert.equal(first.kind === "ask" && first.node.id, "D1")
  assert.equal(t.nodes.find((n) => n.id === "D3")!.status, "assumed")
  assert.deepEqual(frontier(t).map((n) => n.id), ["D1"], "D2 waits for D1, F1 is a fact")
  assert.equal(applyAnswer(t, "a flag on report"), undefined)
  const second = nextStep(t)
  assert.equal(second.kind === "ask" && second.node.id, "D2")
  applyAnswer(t, "quote them with double quotes")
  assert.equal(nextStep(t).kind, "checkpoint")
  assert.deepEqual(decisionsText(t), [
    "Is the export a CLI flag or a separate command? -> a flag on report",
    "How are fields with commas quoted? -> quote them with double quotes",
    "Should the header row be optional? -> assumed: the planner decides, and says what it chose",
  ])
})

test("the decision model's pick wins when it is on the frontier", () => {
  const t = parseTree([...DRAFT, { id: "D4", question: "Which encoding is used?", kind: "decision", dependsOn: [], impact: "high" }]).tree!
  const step = nextStep(t, "D4")
  assert.equal(step.kind === "ask" && step.node.id, "D4")
  assert.match(step.kind === "ask" ? step.reason : "", /decision model/)
  const t2 = tree()
  assert.equal((nextStep(t2, "D2") as { node: { id: string } }).node.id, "D1", "D2 is not on the frontier yet")
})

test("reading the answer: stuck asks for an explanation, contradictions are named, new branches are added", () => {
  const t = tree()
  nextStep(t)
  assert.equal(applyAnswer(t, "no idea", { stuck: true })?.kind, "explain")
  assert.equal(t.nodes[0]!.status, "open", "not settled while stuck")
  assert.equal(applyAnswer(t, "a flag", { settles: true, newBranches: true })?.kind, "add_branches")
  assert.deepEqual(addNodes(t, [{ id: "D5", question: "What is the flag called?", kind: "decision", dependsOn: ["D1"], impact: "medium" }]), [])
  assert.equal(t.nodes.find((n) => n.id === "D1")!.status, "settled", "existing nodes keep their state")
  nextStep(t)
  const c = applyAnswer(t, "a separate command after all", { contradicts: true })
  assert.equal(c?.kind, "contradiction")
  assert.equal(applyAnswer(t, "huh", { settles: false })?.kind, "repitch")
})

test("shortcuts: skip assumes, back reopens, depth caps the questions, stop stops", () => {
  const t = tree()
  nextStep(t)
  assert.deepEqual(matchSessionShortcut("Decide it yourself."), { kind: "skip" })
  applyShortcut(t, { kind: "skip" })
  assert.equal(t.nodes[0]!.status, "assumed")
  const reopened = applyShortcut(t, matchSessionShortcut("go back to D1")!)
  assert.equal(reopened?.kind, "ask")
  assert.equal(t.nodes[0]!.status, "open")
  applyShortcut(t, matchSessionShortcut("light")!)
  t.asked = 5
  assert.equal(nextStep(t).kind, "checkpoint", "light caps at five questions")
  assert.equal(applyShortcut(t, matchSessionShortcut("stop")!)?.kind, "stopped")
  assert.equal(matchSessionShortcut("I think a flag is better"), undefined)
})

test("facts are never asked: decisions waiting on facts report the lookup", () => {
  const t = parseTree([
    { id: "F1", question: "Which CSV library is installed?", kind: "fact", dependsOn: [], impact: "high" },
    { id: "D1", question: "Should we keep that library?", kind: "decision", dependsOn: ["F1"], impact: "high" },
  ]).tree!
  assert.equal(nextStep(t).kind, "facts_pending")
})

test("the facilitator's instruction forbids options and recommendations", () => {
  const t = tree()
  const step = nextStep(t)
  const text = instruction(step, "job-1", t)
  assert.match(text, /Ask the user question D1 now/)
  assert.match(text, /Give no options, no examples of possible answers and no recommendation/)
  assert.match(instruction({ kind: "checkpoint" }, "job-1", t), /"confirm".*"discuss"/s)
})

const noul = (v: number) => ({ type: "noul" as const, noul: v })
function decider(answers: Decision["answers"] | Error) {
  const asker: Asker = { async ask() { if (answers instanceof Error) throw answers; return { answers, model: "gliner", latencyMs: 1 } } }
  return new Decider(DEFAULT_BACKENDS, { gliner: asker, rules: { async ask() { return { answers: {}, model: "rules", latencyMs: 0 } } } }, () => {})
}

test("the gate flags guards at the floor and asks the user; unchecked jobs stay local", async () => {
  const clean = await checkGuards(decider({ injection: noul(0.01), harmful: noul(0.02), refusal_likely: noul(0.1), sensitive: noul(0.2) }), "Add a flag")
  assert.deepEqual(flagsWithoutUser(clean), { gate: clean })
  const flagged = await checkGuards(decider({ injection: noul(0.01), harmful: noul(0.02), refusal_likely: noul(0.8), sensitive: noul(0.2) }), "scan my LAN")
  assert.deepEqual(flagged.flagged, ["refusal_likely"])
  assert.equal(flagsWithoutUser(flagged), "ask_user")
  assert.match(gateQuestion(flagged), /local uncensored model \(0\.80\)/)
  const down = await checkGuards(decider(new Error("down")), "x")
  assert.equal(down.checked, false)
  assert.deepEqual(flagsWithoutUser(down), { localOnly: true, gate: down })
  assert.equal(flagsWithoutUser(down, "user"), "ask_user")
  assert.deepEqual(gateAnswer('"use uncensored"'), { localOnly: true, uncensored: true })
  assert.deepEqual(gateAnswer("continue."), {})
  assert.equal(gateAnswer("maybe"), undefined)
})

test("the guard bench sweeps recall and false positives per guard", async () => {
  const { sweep } = await import("../src/bench.ts")
  const rows = [
    { yes: ["harmful"], p: { harmful: 0.9, injection: 0.1, refusal_likely: 0.2, sensitive: 0.1 } },
    { yes: [], p: { harmful: 0.6, injection: 0.1, refusal_likely: 0.2, sensitive: 0.1 } },
  ]
  const h = sweep(rows, [0.5, 0.7]).filter((s) => s.guard === "harmful")
  assert.deepEqual(h.map((s) => [s.floor, s.recall, s.fpr]), [[0.5, 1, 1], [0.7, 1, 0]])
})

test("a firm answer settles the question even when the reading also scores 'asks for options'", () => {
  const t = tree()
  nextStep(t)
  assert.equal(applyAnswer(t, "transliterate to ASCII", { settles: true, asksOptions: true }), undefined)
  assert.equal(t.nodes[0]!.status, "settled")
})
