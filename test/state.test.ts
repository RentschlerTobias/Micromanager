import assert from "node:assert/strict"
import { test } from "node:test"

import { buildAgenda, nextProposal } from "../src/agenda.ts"
import { applyPlan, extractJson, parsePlan, waves, type PlannedTask } from "../src/plan.ts"
import { allDone, canMoveTask, moveJob, moveTask, newJob, parallelSafe, promoteReady, StateError, type Task } from "../src/state.ts"

const plan = (tasks: object[], acceptance: object[] = [{ id: "A1", text: "works", verify: "npm test" }]) =>
  "Here is the plan:\n```json\n" + JSON.stringify({ acceptance, tasks }) + "\n```"

const t = (id: string, extra: object = {}) => ({ id, title: `task ${id}`, description: "", role: "code", acceptance: ["A1"], dependsOn: [], files: [`src/${id}.ts`], ...extra })

test("the job FSM refuses illegal jumps and returns from pause to where it was", () => {
  const job = newJob("j1", "goal")
  moveJob(job, "triage")
  assert.throws(() => moveJob(job, "execute"), StateError)
  moveJob(job, "plan")
  moveJob(job, "paused")
  assert.equal(job.resumePhase, "plan")
  moveJob(job, "plan")
  assert.equal(job.phase, "plan")
  moveJob(job, "stopped")
  assert.throws(() => moveJob(job, "plan"), StateError)
})

test("the task FSM: blocked and cancelled from anywhere, nothing after merged", () => {
  const task = { status: "running" } as Task
  moveTask(task, "blocked")
  moveTask(task, "running")
  moveTask(task, "gating")
  assert.throws(() => moveTask(task, "merged"), StateError)
  moveTask(task, "passed")
  moveTask(task, "merged")
  assert.throws(() => moveTask(task, "cancelled"), StateError)
})

// The state a sweep moves a stale running task to: reachable from every live task and final, so the job can finish.
test("a running task can be cancelled, which is where a sweep puts a worker that never handed off", () => {
  const task = { status: "running" } as Task
  assert.ok(canMoveTask(task.status, "cancelled"))
  moveTask(task, "cancelled")
  assert.throws(() => moveTask(task, "running"), StateError)
})

test("a plan is parsed from the last json fence and turned into pending tasks with waves", () => {
  const parsed = parsePlan(plan([t("T1"), t("T2", { dependsOn: ["T1"] }), t("T3", { role: "explore", files: [] })]))
  assert.ok(parsed.plan, String(parsed.errors))
  const job = newJob("j1", "goal")
  applyPlan(job, parsed.plan)
  assert.deepEqual(job.tasks.map((x) => [x.id, x.wave, x.status]), [["T1", 0, "pending"], ["T2", 1, "pending"], ["T3", 0, "pending"]])
  assert.equal(job.acceptance[0]?.verify, "npm test")
})

test("plan validation names every problem", () => {
  const parsed = parsePlan(plan(
    [t("T1", { dependsOn: ["T2"] }), t("T2", { dependsOn: ["T1"] }), t("T3", { role: "wizard" }), t("T4", { files: [] }), t("T5", { acceptance: ["A9"] })],
    [{ id: "A1", text: "x" }, { id: "A2", text: "nobody covers this" }],
  ))
  const errors = parsed.errors ?? []
  assert.ok(errors.some((e) => e.includes("cycle")), errors.join("\n"))
  assert.ok(errors.some((e) => e.includes("unknown role")))
  assert.ok(errors.some((e) => e.includes("T4") && e.includes("declare files")))
  assert.ok(errors.some((e) => e.includes("unknown acceptance point A9")))
  assert.ok(errors.some((e) => e.includes("A2") && e.includes("no task covers")))
  assert.deepEqual(parsePlan("no json here").errors, ["no JSON object found"])
})

test("extractJson falls back to the outermost braces", () => {
  assert.equal(extractJson('text {"a": {"b": 1}} more'), '{"a": {"b": 1}}')
})

test("waves follow the longest dependency chain", () => {
  const w = waves([t("A"), t("B", { dependsOn: ["A"] }), t("C", { dependsOn: ["A", "B"] })] as PlannedTask[])
  assert.deepEqual([...w.entries()], [["A", 0], ["B", 1], ["C", 2]])
})

test("tasks become ready only when their dependencies passed; parallel safety by files", () => {
  const job = newJob("j1", "goal")
  applyPlan(job, parsePlan(plan([t("T1"), t("T2", { dependsOn: ["T1"] }), t("T3", { files: ["src/T1.ts"] })])).plan!)
  assert.deepEqual(promoteReady(job).map((x) => x.id), ["T1", "T3"])
  const [t1, t2, t3] = job.tasks as [Task, Task, Task]
  assert.equal(parallelSafe(t1, t3), false)
  assert.equal(parallelSafe(t1, t2), true)
  for (const s of ["planned", "running", "gating", "passed"] as const) moveTask(t1, s)
  assert.deepEqual(promoteReady(job).map((x) => x.id), ["T2"])
})

test("the agenda puts unfinished work before new work and wraps at the end", () => {
  const job = newJob("j1", "goal")
  applyPlan(job, parsePlan(plan([t("T1"), t("T2", { dependsOn: ["T1"] })])).plan!)
  assert.deepEqual(buildAgenda(job), [], "no agenda outside execute")
  job.phase = "execute"
  assert.deepEqual(buildAgenda(job).map((p) => `${p.action}:${p.taskId}`), ["dispatch:T1"])
  const [t1, t2] = job.tasks as [Task, Task]
  for (const s of ["ready", "planned", "running", "gating"] as const) moveTask(t1, s)
  assert.equal(nextProposal(buildAgenda(job))?.action, "gate")
  for (const s of ["passed", "merged"] as const) moveTask(t1, s)
  for (const s of ["ready", "planned", "running", "gating", "passed"] as const) moveTask(t2, s)
  assert.ok(allDone(job))
  assert.equal(nextProposal(buildAgenda(job))?.action, "verify")
})
