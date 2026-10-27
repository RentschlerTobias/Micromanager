import assert from "node:assert/strict"
import { test } from "node:test"

import { Accountant, chargeTask, limitsOf, overBudget, overNote, sessionUsage, wrapUpNote } from "../src/budget.ts"
import { newJob } from "../src/state.ts"

const assistant = (input: number, output: number, cost: number) => ({ type: "assistant", tokens: { input, output }, cost })

test("a session's usage: tokens, cost and requests of its assistant messages", () => {
  assert.deepEqual(sessionUsage([{ type: "user" }, assistant(100, 20, 0.01), assistant(300, 50, 0.02)]), { tokens: 470, cost: 0.03, requests: 2 })
  assert.deepEqual(sessionUsage(undefined), { tokens: 0, cost: 0, requests: 0 })
})

test("the accountant charges a job only what each session used since its last count", () => {
  const job = newJob("job-1", "goal")
  const a = new Accountant()
  a.charge(job, "ses_w", { tokens: 100, cost: 0.1, requests: 1 })
  a.charge(job, "ses_w", { tokens: 250, cost: 0.2, requests: 2 })
  a.charge(job, "ses_mm", { tokens: 40, cost: 0, requests: 1 })
  const d = a.charge(job, "ses_w", { tokens: 250, cost: 0.2, requests: 2 })
  assert.deepEqual(d, { tokens: 0, cost: 0, requests: 0 }, "nothing new, nothing charged")
  assert.deepEqual([job.counters.tokens, job.counters.requests, +job.counters.cost!.toFixed(2)], [290, 3, 0.2])
})

test("a job's limits are its own where it has them, else the config's; nothing is over without a limit", () => {
  const job = newJob("job-1", "goal")
  job.counters.tokens = 5000
  job.counters.cost = 2
  assert.equal(overBudget(job, limitsOf(job, {})), undefined, "no limits by default")
  assert.match(overBudget(job, limitsOf(job, { cost: 1.5 }))!, /cost budget of 1.5 used up \(2\.00\)/)
  job.budget.costMax = 5
  assert.equal(overBudget(job, limitsOf(job, { cost: 1.5 })), undefined, "the job's own limit wins")
  assert.match(overBudget(job, limitsOf(job, { tokens: 4000 }))!, /token budget of 4000 used up/)
})

test("the notes: the micromanager asks the user, running workers wrap up and keep their work", () => {
  const job = newJob("job-1", "goal")
  assert.match(overNote(job, "cost budget of 1 used up (1.20)", ["T3", "T4"]), /No new worker starts .* The running workers \(T3, T4\) are asked to wrap up/)
  assert.match(wrapUpNote("x"), /call finish_task; if not, stop and end with a short report/)
})

test("a task's usage adds up what its sessions were charged", () => {
  const t = { id: "T1" } as Parameters<typeof chargeTask>[0]
  chargeTask(t, { tokens: 100, cost: 0.01, requests: 1 })
  chargeTask(t, { tokens: 50, cost: 0.005, requests: 2 })
  assert.deepEqual(t.usage, { tokens: 150, cost: 0.015, requests: 3 })
})

test("the first checkpoint interval comes from the class's merged tasks, else the difficulty; the next from Jev's confidence", async () => {
  const { firstInterval, nextInterval } = await import("../src/checkpoint.ts")
  const { learnedSteps } = await import("../src/outcomes.ts")
  assert.equal(firstInterval(undefined), 60)
  assert.equal(firstInterval(0.2), 40)
  assert.equal(firstInterval(0.9), 90)
  assert.equal(firstInterval(0.9, 47), 47)
  assert.equal(firstInterval(0.9, 5), 30, "never below twice the minimum")
  assert.equal(firstInterval(0.1, 900), 180)
  assert.equal(nextInterval(60, 0.9), 90)
  assert.equal(nextInterval(60, 0.4), 30)
  assert.equal(nextInterval(60, 0.6), 60)
  assert.equal(nextInterval(20, 0.1), 15)
  assert.equal(nextInterval(150, 0.95), 180)
  assert.equal(nextInterval(60), 60)
  const row = (steps: number, merged = true, cls = "code:moderate:1") => ({ cls, merged, steps }) as never
  assert.equal(learnedSteps([row(10), row(20), row(30), row(40)], "code:moderate:1"), undefined, "too few to say")
  assert.equal(learnedSteps([row(10), row(20), row(30), row(40), row(50), row(99, false), row(5, true, "other")], "code:moderate:1"), 40)
})
