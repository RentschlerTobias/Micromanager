import assert from "node:assert/strict"
import { test } from "node:test"

import {
  better, coarse, contractBrief, contractHash, describe, guardViolations, measuredOf, median, parseContract, parseScoreLines, reward,
  type Contract, type Measured,
} from "../src/contract.ts"
import { gradedOf, runEvaluator, runGate, type Exec } from "../src/integration.ts"
import { outcomeOf, routerRows } from "../src/outcomes.ts"
import { newJob, stage, type Task } from "../src/state.ts"

const contract = (extra: Partial<Contract> = {}): Contract => ({
  id: "C1",
  version: 1,
  status: "draft",
  goal: "faster search",
  evaluator: "sh bench.sh",
  timeoutMs: 10_000,
  repeats: 1,
  scores: [{ name: "ms", direction: "min", noise: 0.05 }, { name: "hits", direction: "max" }],
  guards: [{ name: "hits", direction: "max", tolerance: 0, origin: "user" }],
  corpus: { visible: ["fixtures/"] },
  baseline: { values: { ms: 100, hits: 10 }, at: "2026-10-26T00:00:00Z" },
  stop: {},
  history: [],
  ...extra,
})

const m = (values: Record<string, number>, valid = true): Measured => ({ valid, values })

test("the last MM_SCORE line is the measurement; other output and junk are no score", () => {
  assert.deepEqual(parseScoreLines('building…\nMM_SCORE {"scores":{"ms":5}}\nMM_SCORE {"scores":{"ms":4},"cases":{"passed":7,"total":8},"category":"slow"}\n'), {
    valid: true, values: { ms: 4 }, cases: { passed: 7, total: 8 }, category: "slow",
  })
  assert.equal(parseScoreLines('{"scores":{"ms":5}}'), undefined, "bare JSON from a test runner is not a score")
  assert.equal(parseScoreLines("MM_SCORE {oops")?.valid, false)
  assert.deepEqual(parseScoreLines('MM_SCORE {"valid":false,"scores":{"ms":"fast"}}'), { valid: false, values: {} })
})

test("the hard constraints make an evaluator run invalid: exit code, timeout, no line, a missing score", () => {
  const c = contract()
  const line = 'MM_SCORE {"scores":{"ms":90,"hits":10}}'
  assert.equal(measuredOf(c, { code: 0, stdout: line, stderr: "" }).valid, true)
  assert.match(measuredOf(c, { code: 2, stdout: line, stderr: "boom" }).error!, /exited 2: boom/)
  assert.match(measuredOf(c, { code: 0, stdout: line, stderr: "", timedOut: true }).error!, /timed out/)
  assert.match(measuredOf(c, { code: 0, stdout: "done", stderr: "" }).error!, /no MM_SCORE line/)
  assert.match(measuredOf(c, { code: 0, stdout: 'MM_SCORE {"scores":{"ms":90}}', stderr: "" }).error!, /lacks hits/)
})

test("repeated runs count by their median, and one invalid run makes the measurement invalid", () => {
  assert.deepEqual(median([m({ ms: 9 }), m({ ms: 30 }), m({ ms: 10 })]).values, { ms: 10 })
  assert.deepEqual(median([m({ ms: 9 }), m({ ms: 11 })]).values, { ms: 10 })
  assert.equal(median([m({ ms: 9 }), m({}, false)]).valid, false)
  assert.equal(median([]).valid, false)
})

test("the scores decide in their order, inside their noise band; an invalid result loses to any valid one", () => {
  const c = contract()
  assert.ok(better(c, m({ ms: 80, hits: 10 }), m({ ms: 100, hits: 10 })) > 0)
  assert.ok(better(c, m({ ms: 100, hits: 10 }), m({ ms: 80, hits: 10 })) < 0)
  // 98 and 100 are 2 % apart, inside the 5 % band: the second score decides.
  assert.ok(better(c, m({ ms: 100, hits: 11 }), m({ ms: 98, hits: 10 })) > 0)
  assert.equal(better(c, m({ ms: 100, hits: 10 }), m({ ms: 99, hits: 10 })), 0)
  assert.ok(better(c, m({ ms: 500, hits: 1 }), m({}, false)) > 0)
  assert.equal(better(c, m({}, false), m({}, false)), 0)
})

test("a guard holds within its tolerance of the baseline; without a baseline there is nothing to break", () => {
  const c = contract({ guards: [{ name: "hits", direction: "max", tolerance: 0.1, origin: "user" }, { name: "mem", direction: "min", tolerance: 0.2, origin: "redteam" }] })
  assert.deepEqual(guardViolations({ ...c, baseline: { values: { ms: 100, hits: 10, mem: 50 }, at: "" } }, m({ ms: 1, hits: 9, mem: 60 })), [])
  assert.deepEqual(guardViolations({ ...c, baseline: { values: { ms: 100, hits: 10, mem: 50 }, at: "" } }, m({ ms: 1, hits: 8, mem: 61 })), [
    "hits is 8, worse than the baseline 10 by more than 10 %",
    "mem is 61, worse than the baseline 50 by more than 20 %",
  ])
  assert.deepEqual(guardViolations({ ...c, baseline: { values: { hits: 10 }, at: "" } }, m({ ms: 1 })), ["hits was not measured"])
  assert.deepEqual(guardViolations({ ...c, baseline: undefined }, m({ hits: 0 })), [])
})

test("the reward is the primary score's improvement over the baseline, positive when better", () => {
  assert.equal(reward(contract(), m({ ms: 80, hits: 10 })), 0.2)
  assert.equal(reward(contract(), m({ ms: 120, hits: 10 })), -0.2)
  assert.equal(reward(contract({ scores: [{ name: "hits", direction: "max" }] }), m({ hits: 15 })), 0.5)
  assert.equal(reward(contract(), m({}, false)), 0)
  assert.equal(reward(contract({ baseline: undefined }), m({ ms: 1, hits: 1 })), undefined)
})

test("a worker hears a coarse result; the stage and the brief name the values next to the baseline", () => {
  assert.equal(coarse({ valid: true, values: { ms: 3 }, cases: { passed: 7, total: 8 } }), "7/8 passed")
  assert.equal(coarse({ valid: false, values: {}, category: "crash" }), "invalid (crash)")
  assert.equal(describe(contract(), m({ ms: 80, hits: 10 })), "ms 80 (baseline 100), hits 10 (baseline 10)")
  const brief = contractBrief(contract())
  assert.match(brief, /fitness contract C1 \(version 1\): faster search/)
  assert.match(brief, /ms \(lower is better, today 100\)/)
  assert.match(brief, /hits may not get lower than today by more than 0 %/)
})

test("a contract from JSON is validated like a check, and only what it measures changes its hash", () => {
  const ok = parseContract(JSON.stringify({ goal: "faster", evaluator: "sh bench.sh", scores: [{ name: "ms", direction: "min" }], repeats: 3, timeoutSeconds: 60, stop: { evaluations: 20 } }))
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.contract!.repeats, 3)
  assert.equal(ok.contract!.timeoutMs, 60_000)
  assert.deepEqual(ok.contract!.stop, { evaluations: 20 })
  const bad = parseContract(JSON.stringify({ evaluator: "Run the benchmark and report.", scores: [{ name: "ms", direction: "down" }], guards: [{ name: "x" }], corpus: { visible: ["../secret"] } }))
  assert.equal(bad.contract, undefined)
  assert.equal(bad.errors.length, 6, bad.errors.join("\n"))
  assert.match(parseContract("{").errors[0]!, /no JSON object/)
  assert.match(parseContract(JSON.stringify({ goal: "g", evaluator: "rm -rf /", scores: [{ name: "a", direction: "min" }] })).errors.join(), /evaluator: /)
  assert.equal(contractHash(contract()), contractHash(contract({ used: { evaluations: 3, seconds: 9 }, version: 2 })))
  assert.notEqual(contractHash(contract()), contractHash(contract({ evaluator: "sh other.sh" })))
})

test("a check may grade itself; the evaluator runs repeated, with the corpus in its environment", async () => {
  const seen: Record<string, string>[] = []
  const run: Exec = async (_cmd, args, options) => {
    seen.push({ ...options.env })
    const command = String(args.at(-1))
    if (command === "npm test") return { code: 1, stdout: 'MM_SCORE {"cases":{"passed":3,"total":4}}', stderr: "" }
    if (command === "true") return { code: 0, stdout: 'MM_SCORE {"cases":{"passed":2,"total":2}}', stderr: "" }
    return { code: 0, stdout: `MM_SCORE {"scores":{"ms":${10 + seen.length},"hits":10}}`, stderr: "" }
  }
  const gate = await runGate("/w", ["npm test", "true", "echo"], run)
  assert.deepEqual(gate.map((g) => g.passed), [false, true, true])
  assert.deepEqual(gradedOf(gate), { passed: 5, total: 6 })
  seen.length = 0
  const { measured } = await runEvaluator("/w", contract({ repeats: 3 }), "heldout", run, "/state/heldout")
  assert.deepEqual(measured.values, { ms: 12, hits: 10 })
  assert.deepEqual(seen.map((e) => e.MM_REPEAT), ["1", "2", "3"])
  assert.equal(seen[0]!.MM_CORPUS, "heldout")
  assert.equal(seen[0]!.MM_CORPUS_DIR, "/state/heldout")
})

test("the outcome row of a measured task keeps its contract, score and reward; the router row its best reward", () => {
  const job = newJob("job-1", "goal")
  job.acceptance = [{ id: "A1", text: "a", verify: "npm test" }]
  job.contracts = [contract()]
  const task: Task = {
    id: "T1", title: "t", description: "faster", role: "code", acceptance: ["A1"], dependsOn: [], files: ["a.js"], wave: 0, status: "merged",
    attempts: 1, stages: [], signatures: [], contract: { id: "C1", version: 1 }, score: { valid: true, values: { ms: 50, hits: 10 }, corpus: "visible", at: "" },
    graded: { passed: 3, total: 4 },
  }
  stage(task, "gate", "pass")
  stage(task, "fitness", "fail", "guard broken")
  stage(task, "fitness", "pass", "ms 50")
  const row = outcomeOf("/p", job, task)
  assert.deepEqual(row.contract, { id: "C1", version: 1, hash: contractHash(contract()) })
  assert.equal(row.reward, 0.5)
  assert.equal(row.graded, 0.75)
  assert.equal(row.fixRounds, 1, "a failed measurement is a fix round")
  assert.equal((routerRows([row])[0]!.outcome as { reward: number }).reward, 0.5)
})
