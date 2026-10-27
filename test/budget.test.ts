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
