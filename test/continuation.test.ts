import assert from "node:assert/strict"
import { test } from "node:test"

import { autoStep, nextStep, plannedLine, startable } from "../src/continuation.ts"
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

test("auto-continue wakes with what can start, pauses when nothing moves or only the user can decide, ends when done", () => {
  const delegated = (id: string, status: Task["status"], extra: Partial<Task> = {}) => task(id, status, { stages: [{ stage: "delegate", result: "pass", at: "2026-10-20T10:00:00Z" }], ...extra })
  const j = job([delegated("T1", "merged"), task("T2", "pending", { dependsOn: ["T1"] }), task("T3", "pending"), task("T4", "pending", { dependsOn: ["T2"] })], { rolling: true, native: false })
  assert.equal(autoStep(j, 1, true), undefined, "a running worker's report wakes it anyway")
  const wake = autoStep(j, 0, true)!
  assert.equal(wake.kind, "wake")
  assert.match(wake.text, /these todos now, in one message/)
  assert.match(wake.text, /Task: T2 · job-1[\s\S]*Task: T3 · job-1/)
  const one = autoStep(j, 0, false)!
  assert.ok(one.kind === "wake" && !one.text.includes("T3"), "Parallel off: one at a time")
  // The same state again: no progress since the last wake. Twice in a row pauses.
  const again = autoStep(j, 0, true, { seen: (wake as { seen: string }).seen, wakes: 0 })!
  assert.equal(again.kind === "wake" && again.wakes, 1)
  const stuck = autoStep(j, 0, true, { seen: (wake as { seen: string }).seen, wakes: 1 })!
  assert.deepEqual([stuck.kind, stuck.kind === "pause" && stuck.pause], ["pause", "no progress"])
  assert.match(stuck.text, /question tool/)
  // Only failed or stopped work left: the user decides.
  const blocked = job([delegated("T1", "escalated"), task("T2", "pending", { dependsOn: ["T1"] })], { rolling: true })
  assert.deepEqual([autoStep(blocked, 0, true)!.kind, (autoStep(blocked, 0, true) as { pause?: string }).pause], ["pause", "waits for you"])
  const ended = job([delegated("T1", "running", { stages: [{ stage: "delegate", result: "pass", at: "x" }, { stage: "end", result: "fail", at: "y" }] })], { rolling: true })
  assert.match(autoStep(ended, 0, true)!.text, /its worker ended unfinished/)
  // Everything in: the summary, and auto-continue ends.
  assert.equal(autoStep(job([delegated("T1", "merged"), task("T2", "cancelled")], { rolling: true }), 0, true)!.kind, "done")
})
