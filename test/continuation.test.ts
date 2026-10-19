import assert from "node:assert/strict"
import { test } from "node:test"

import { nextStep, plannedLine, startable } from "../src/continuation.ts"
import { newJob, type Job, type Task } from "../src/state.ts"

const task = (id: string, status: Task["status"], extra: Partial<Task> = {}): Task => ({
  id, title: `task ${id}`, description: "", role: "code", acceptance: [], dependsOn: [], files: [], wave: 0, status, attempts: 0, stages: [], signatures: [], ...extra,
})
const job = (tasks: Task[], extra: Partial<Job> = {}): Job => ({ ...newJob("job-1", "goal"), phase: "execute", native: true, integrationBranch: "jev/job-1", tasks, ...extra })

test("the tasks whose dependencies are merged start, by priority, up to the parallel limit", () => {
  const j = job([
    task("T1", "merged"),
    task("T2", "pending", { dependsOn: ["T1"] }),
    task("T3", "pending", { dependsOn: ["T2"] }),
    task("T4", "pending", { priority: 1 }),
    task("T5", "running"),
    task("T6", "pending", { role: "write" }),
  ])
  assert.deepEqual(startable(j).map((t) => t.id), ["T4", "T2", "T6"])
  const step = nextStep(j, 3)!
  assert.equal(step.kind, "start")
  assert.deepEqual(step.kind === "start" && step.tasks.map((t) => t.id), ["T4", "T2"], "one of three slots is taken by T5")
  assert.match(step.text, /- agent coder, description "T4 task T4", prompt "Task: T4 · job-1"/)
  assert.match(step.text, /Still running: T5/)
  assert.equal(plannedLine("T4", "job-1"), "Task: T4 · job-1")
})

test("while workers run and nothing else can start, there is nothing to say", () => {
  assert.equal(nextStep(job([task("T1", "running"), task("T2", "pending", { dependsOn: ["T1"] })]), 3), undefined)
  assert.equal(nextStep(job([task("T1", "pending")]), 1)?.kind, "start")
  assert.equal(nextStep(job([task("T1", "running"), task("T2", "pending")]), 1), undefined, "the one slot is taken")
})

test("a job whose tasks are all merged is done; a cancelled task nobody needs does not hold it up", () => {
  const done = nextStep(job([task("T1", "merged"), task("T2", "merged")]), 3)!
  assert.equal(done.kind, "done")
  assert.match(done.text, /2 of 2 tasks merged on jev\/job-1\. Tell the user/)
  const without = nextStep(job([task("T1", "merged"), task("T2", "cancelled")]), 3)!
  assert.equal(without.kind, "done")
  assert.match(without.text, /1 of 2 tasks merged .*the rest were cancelled/)
})

test("a job that cannot go on names the stopped tasks and what waits on them", () => {
  const step = nextStep(job([
    task("T1", "merged"),
    task("T2", "escalated", { escalation: { kind: "too_hard", detail: "loop watchdog" }, session: "ses_t2" }),
    task("T3", "cancelled"),
    task("T4", "pending", { dependsOn: ["T2", "T3"] }),
  ]), 3)!
  assert.equal(step.kind, "stuck")
  assert.match(step.text, /- T2 task T2: escalated \(loop watchdog\), session ses_t2/)
  assert.match(step.text, /- T3 task T3: cancelled/, "a cancelled task that T4 needs is part of the problem")
  assert.match(step.text, /Waiting on those: T4 \(after T2, T3\)/)
  assert.match(step.text, /Task: T… · job-1/)
})

test("only a planned job on native workers that runs goes on by itself", () => {
  const tasks = [task("T1", "pending")]
  assert.equal(nextStep(job(tasks, { native: false }), 3), undefined, "the runner's job, or a rolling one")
  assert.equal(nextStep(job(tasks, { phase: "paused" }), 3), undefined, "stop_job paused it")
})
