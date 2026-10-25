import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { parseTrials } from "../src/config.ts"
import { classOf, needsTrials, outcomeOf, readOutcomes, recordOutcome, routerRows, type Outcome } from "../src/outcomes.ts"
import { newJob, stage, type Task } from "../src/state.ts"
import { DEEP, trialSize } from "../src/trials.ts"

test("a writer task runs as a trial when it is hard, does failed work over, or its class mostly fails alone", () => {
  const base = { retry: false, setting: 3, parallel: 3 }
  assert.equal(trialSize({ ...base, difficulty: 0.5 }), 1)
  assert.equal(trialSize({ ...base, difficulty: DEEP }), 3)
  assert.equal(trialSize({ ...base, difficulty: undefined, retry: true }), 3)
  assert.equal(trialSize({ ...base, difficulty: 0.2, learned: true }), 3)
  assert.equal(trialSize({ ...base, difficulty: 1, parallel: 2 }), 2, "a trial fits into the job's parallel tasks")
  assert.equal(trialSize({ ...base, difficulty: 1, setting: 1 }), 1, "trials: 1 turns trials off")
  assert.equal(trialSize({ ...base, difficulty: 1, parallel: 1 }), 1)
  assert.equal(trialSize({ ...base, difficulty: 1, setting: 9, parallel: 6 }), 4, "at most 4 attempts")
})

const task = (id: string, extra: Partial<Task>): Task => ({ id, title: id, description: `do ${id}`, role: "code", acceptance: ["A1"], dependsOn: [], files: ["a.js"], wave: 0, status: "running", attempts: 0, stages: [], signatures: [], ...extra })

test("an outcome row says what the router could know before, what it chose, and what came of it", () => {
  const job = newJob("job-1", "goal")
  job.acceptance = [{ id: "A1", text: "a", verify: "npm test" }]
  const t = new Date("2026-10-25T10:00:00Z")
  const won = task("T2", { status: "merged", model: "opencode-go/kimi-k3", difficulty: 0.8, trial: { of: "T1", n: 3 } })
  stage(won, "delegate", "pass", "", t)
  stage(won, "gate", "fail", "npm test", t)
  stage(won, "gate", "pass", "npm test", t)
  const row = outcomeOf("/p", job, won, { tokens: 1200, cost: 0.02 }, new Date("2026-10-25T10:05:00Z"))
  assert.deepEqual(
    { trial: row.trial, n: row.n, family: row.family, cls: row.cls, gate: row.gate, fixRounds: row.fixRounds, end: row.end, seconds: row.seconds, checks: row.checks, cost: row.cost },
    { trial: "T1", n: 3, family: "kimi", cls: "code:deep:1", gate: "pass", fixRounds: 1, end: "merged", seconds: 300, checks: ["npm test"], cost: 0.02 },
  )
  const lost = task("T1", { status: "cancelled", replacedBy: "T2", trial: { of: "T1", n: 3 } })
  stage(lost, "trial", "pass", "won by T2")
  assert.equal(outcomeOf("/p", job, lost).end, "sibling_won")
  assert.equal(outcomeOf("/p", job, lost).gate, "none")
  assert.equal(classOf("code", undefined, 5), "code:unknown:4+")
})

const row = (o: Partial<Outcome>): Outcome => ({ time: "", project: "/p", job: "job-1", task: "T1", n: 1, role: "code", cls: "code:agent:1", files: 1, checks: [], brief: "", briefHash: "", gate: "pass", fixRounds: 0, merged: true, end: "merged", ...o })

test("a class needs trials when most single workers fail it, or when its trials were won only after failed attempts", () => {
  assert.equal(needsTrials([row({}), row({ merged: false, end: "blocked", gate: "fail" })], "code:agent:1"), false, "too few to say")
  const failing = [1, 2, 3, 4].map((i) => row({ task: `T${i}`, merged: i === 1, end: i === 1 ? "merged" : "blocked", gate: i === 1 ? "pass" : "fail" }))
  assert.equal(needsTrials(failing, "code:agent:1"), true)
  assert.equal(needsTrials(failing, "code:deep:1"), false, "another class")
  assert.equal(needsTrials([1, 2, 3, 4].map((i) => row({ task: `T${i}` })), "code:agent:1"), false)
})

test("the router rows join a trial's attempts and keep the stopped ones as censored", () => {
  const rows = [
    row({ task: "T1", trial: "T1", n: 3, model: "a/x", gate: "fail", merged: false, end: "blocked", tokens: 10, cost: 0.1 }),
    row({ task: "T2", trial: "T1", n: 3, model: "b/y", tokens: 20, cost: 0.2 }),
    row({ task: "T3", trial: "T1", n: 3, model: "c/z", gate: "none", merged: false, end: "sibling_won", tokens: 5 }),
    row({ task: "T4" }),
  ]
  const out = routerRows(rows)
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], {
    key: "job-1/T1",
    cls: "code:agent:1",
    features: { role: "code", difficulty: undefined, files: 1, checks: [], brief: "" },
    allocation: { n: 3, models: ["a/x", "b/y", "c/z"] },
    outcome: { k: 1, merged: true, censored: 1, tokens: 35, cost: 0.3, seconds: 0 },
  })
  const path = join(mkdtempSync(join(tmpdir(), "mm-outcomes-")), "outcomes.jsonl")
  for (const r of rows) recordOutcome(r, path)
  assert.deepEqual(readOutcomes(path), rows)
})

test("the trials setting: 3 by default, 1 turns trials off, at most 4", () => {
  assert.equal(parseTrials("{}"), 3)
  assert.equal(parseTrials('{ "trials": 1 }'), 1)
  assert.equal(parseTrials('{ "trials": 7 } // more than the cap'), 4)
  assert.throws(() => parseTrials('{ "trials": 0 }'), /whole number from 1/)
})
