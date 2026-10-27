import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { parseTrialDeadline, parseTrialGrace, parseTrialPick, parseTrials } from "../src/config.ts"
import { parseDelegation } from "../src/native.ts"
import { classOf, needsTrials, outcomeOf, readOutcomes, recordOutcome, routerRows, type Outcome } from "../src/outcomes.ts"
import { newJob, stage, type Task } from "../src/state.ts"
import { DEEP, DEFAULT_GRACE, DEFAULT_PICK, graceMs, idleAttempt, parseReview, pickFor, pickOf, rankQuality, ranked, reviewPrompt, standing, trialSize } from "../src/trials.ts"

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
  const picked = routerRows([
    row({ task: "T1", trial: "T1", n: 2, model: "a/x", merged: false, end: "lost_on_pick", tokens: 1 }),
    row({ task: "T2", trial: "T1", n: 2, model: "b/y", chosenBy: "user", tokens: 1 }),
  ])[0]!.outcome as Record<string, unknown>
  assert.deepEqual([picked.censored, picked.winner, picked.chosenBy, picked.lost], [0, "b/y", "user", ["a/x"]])
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
  assert.equal(parseTrialDeadline("{}"), 20)
  assert.equal(parseTrialDeadline('{ "trialDeadline": 5 }'), 5)
  assert.throws(() => parseTrialDeadline('{ "trialDeadline": 0 }'), /minutes above 0/)
  assert.equal(parseTrials("{}"), 3)
  assert.equal(parseTrials('{ "trials": 1 }'), 1)
  assert.equal(parseTrials('{ "trials": 7 } // more than the cap'), 4)
  assert.throws(() => parseTrials('{ "trials": 0 }'), /whole number from 1/)
})

test("a trial decided by score holds its passed attempts apart from the live and the failed ones, best first", () => {
  const job = newJob("job-1", "goal")
  const c = { id: "C1", version: 1, status: "draft" as const, goal: "g", evaluator: "sh b.sh", timeoutMs: 1000, repeats: 1, scores: [{ name: "ms", direction: "min" as const }], guards: [], corpus: { visible: [] }, stop: {}, history: [] }
  const t = (id: string, extra: Partial<Task>) => task(id, { trial: { of: "T1", n: 4 }, ...extra })
  job.tasks = [
    t("T1", { status: "passed", held: true, score: { valid: true, values: { ms: 80 }, corpus: "visible", at: "" } }),
    t("T2", { status: "passed", held: true, score: { valid: true, values: { ms: 60 }, corpus: "visible", at: "" } }),
    t("T3", { status: "running" }),
    t("T4", { status: "blocked" }),
  ]
  const now = standing(job, job.tasks[0]!)
  assert.deepEqual([now.held, now.live, now.failed].map((ts) => ts.map((x) => x.id)), [["T1", "T2"], ["T3"], ["T4"]])
  assert.deepEqual(ranked(c, now.held).map((x) => x.id), ["T2", "T1"])
})

test("who decides a trial: the Pick line, else the role's setting, else best; a contract always by score", () => {
  assert.equal(pickFor("visual"), "user")
  assert.equal(pickFor("code"), "best")
  assert.equal(pickFor("code", { "*": "first" }), "first")
  assert.equal(pickFor("visual", DEFAULT_PICK, "best"), "best")
  const t = { trial: { of: "T1", n: 2, pick: "user" } } as unknown as Task
  assert.equal(pickOf(t), "user")
  assert.equal(pickOf({ ...t, contract: { id: "C1", version: 1 } } as Task), "contract")
  assert.equal(pickOf({ trial: { of: "T1", n: 2 } } as unknown as Task), "first", "a trial from before picks stays first")
  assert.equal(parseDelegation("Do it.\nPick: me\nFiles: a\nChecks: true").pick, "user")
  assert.equal(parseDelegation("Pick: BEST").pick, "best")
  assert.equal(parseDelegation("Pick: whoever").pick, undefined)
})

test("the grace window is a share of the first attempt's time, capped; an idle attempt is one going nowhere", () => {
  assert.equal(graceMs({ factor: 0.5, minMs: 0, maxMs: 600_000 }, 240_000), 120_000)
  assert.equal(graceMs({ factor: 0.5, minMs: 0, maxMs: 600_000 }, 3_600_000), 600_000)
  assert.equal(graceMs(DEFAULT_GRACE, 12_000), 120_000, "a fast first pass still leaves the others two minutes")
  assert.equal(graceMs({ factor: 0, minMs: 120_000, maxMs: 600_000 }, 240_000), 0)
  assert.ok(idleAttempt({ calls: 30, writes: 0, callsSinceWrite: 30, recentFailures: 0 }))
  assert.ok(idleAttempt({ calls: 60, writes: 3, callsSinceWrite: 26, recentFailures: 0 }))
  assert.ok(idleAttempt({ calls: 20, writes: 2, callsSinceWrite: 3, recentFailures: 9 }))
  assert.ok(!idleAttempt({ calls: 40, writes: 4, callsSinceWrite: 5, recentFailures: 2 }))
  assert.ok(!idleAttempt(undefined))
})

test("quality: more cases passed first; on a tie the review, then cost, then size", async () => {
  const t = (id: string) => ({ id } as Task)
  const [a, b] = [t("T1"), t("T2")]
  let r = await rankQuality([{ task: a, graded: 0.5, size: 10 }, { task: b, graded: 0.875, size: 90 }])
  assert.deepEqual(r.order.map((x) => x.id), ["T2", "T1"])
  assert.match(r.how, /more cases passed \(88% against 50%\)/)
  let asked = 0
  const review = async () => (asked++, { better: "B" as const, why: "handles the empty input" })
  r = await rankQuality([{ task: a, graded: 1, cost: 0.01, size: 10 }, { task: b, graded: 1, cost: 0.02, size: 40 }], review)
  assert.deepEqual(r.order.map((x) => x.id), ["T2", "T1"])
  assert.match(r.how, /on review: handles the empty input/)
  assert.equal(asked, 1)
  r = await rankQuality([{ task: a, cost: 0.03, size: 10 }, { task: b, cost: 0.01, size: 40 }], async () => ({ better: "equal", why: "" }))
  assert.deepEqual(r.order.map((x) => x.id), ["T2", "T1"])
  assert.match(r.how, /the review found them equal; cheaper/)
  r = await rankQuality([{ task: a, size: 50 }, { task: b, size: 12 }])
  assert.match(r.how, /tied on the checks; smaller change \(12 against 50 lines\)/)
  r = await rankQuality([{ task: a, size: 1 }])
  assert.equal(r.how, "the only attempt that passed")
})

test("the review answers in one line of JSON; anything else is no verdict", () => {
  assert.deepEqual(parseReview('Sure.\n{"better": "A", "why": "simpler"}'), { better: "A", why: "simpler" })
  assert.equal(parseReview('{"better": "C"}'), undefined)
  assert.equal(parseReview("A is better"), undefined)
  assert.match(reviewPrompt("Add a flag", "diff a", "diff b"), /Change A:\ndiff a\n\nChange B:\ndiff b/)
})

test("settings: trialPick by agent or role id, trialGrace in minutes", () => {
  assert.deepEqual(parseTrialPick("{}"), DEFAULT_PICK)
  assert.deepEqual(parseTrialPick('{ "trialPick": { "coder": "first", "*": "user" } }'), { visual: "user", code: "first", "*": "user" })
  assert.throws(() => parseTrialPick('{ "trialPick": { "coder": "fast" } }'), /trialPick must be/)
  assert.throws(() => parseTrialPick('{ "trialPick": { "nobody": "best" } }'), /unknown agent/)
  assert.deepEqual(parseTrialGrace('{ "trialGrace": { "maxMinutes": 3 } }'), { factor: 0.5, minMs: 120_000, maxMs: 180_000 })
  assert.deepEqual(parseTrialGrace("{}"), DEFAULT_GRACE)
  assert.throws(() => parseTrialGrace('{ "trialGrace": { "factor": -1 } }'), /trialGrace must be/)
})
