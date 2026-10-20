import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { isStarted, lastOptions, loadControl, optionsOf, saveLastOptions, updateControl } from "../src/control.ts"
import { accessForm, answersOf, askForm, formInput, readForm, startForm } from "../src/forms.ts"
import { newJob, type Task } from "../src/state.ts"

test("the start form asks the options and the go, and its answer is read on the plugin's labels", () => {
  const form = startForm("job-1", 5, 2, { auto: true, parallel: false, review: false })
  assert.equal(form.length, 2)
  assert.equal(form[0]!.multiple, true)
  assert.match(form[0]!.options[0]!.description, /on last time/)
  assert.doesNotMatch(form[0]!.options[1]!.description, /on last time/)
  assert.match(form[1]!.question, /5 todos, 2 can start now/)
  assert.ok(form.every((q) => q.header.length <= 30), "headers fit the question tool")
  assert.deepEqual(JSON.parse(formInput(form)).questions.length, 2)

  // As the question tool hands it back (spike, 2026-10-20).
  const result = { output: { answers: [["Auto-continue", "Parallel"], ["Start (Recommended)"]] }, metadata: { answers: [["Auto-continue", "Parallel"], ["Start (Recommended)"]] } }
  assert.deepEqual(readForm(form, answersOf(result)!), { kind: "start", decision: "start", options: { auto: true, parallel: true, review: false } })
  assert.deepEqual(readForm(form, [[], ["Cancel"]]), { kind: "start", decision: "cancel", options: { auto: false, parallel: false, review: false } })
  const typed = readForm(form, [["Parallel"], ["first drop T3"]])
  assert.deepEqual(typed, { kind: "start", said: "first drop T3", options: { auto: false, parallel: true, review: false } }, "a typed answer is no Start")
})

test("access and request forms: only the plugin's labels count as a yes", () => {
  const access = accessForm("/home/u/.ssh", "read the deploy key", "the user's keys")
  assert.deepEqual(readForm(access, [["Open it"]]), { kind: "access", open: true, question: access[0]!.question })
  assert.equal((readForm(access, [["yes please"]]) as { open?: boolean }).open, undefined)
  assert.match(access[0]!.question, /\/home\/u\/\.ssh/)
  const ask = askForm("A3", "T2 tests", "shell: uv run pytest", "Jev was not sure.")
  assert.deepEqual(readForm(ask, [["Allow for this job"]]), { kind: "ask", id: "A3", decision: "job" })
  assert.equal(readForm([{ header: "Something else", question: "?", options: [] }], [["x"]]), undefined, "not one of the plugin's forms")
  assert.equal(answersOf({ output: "text" }), undefined)
})

const task = (id: string, status: Task["status"]): Task => ({ id, title: id, description: "", role: "code", acceptance: [], dependsOn: [], files: [], wave: 0, status, attempts: 0, stages: [], signatures: [] })

test("a job's control: started by the form or by having run before; options fall back to the last choice", () => {
  const project = mkdtempSync(join(tmpdir(), "mm-control-"))
  const fresh = { ...newJob("job-1", "g"), rolling: true, tasks: [task("T1", "pending")] }
  assert.equal(isStarted(fresh, loadControl(project, "job-1")), false, "a plan of open todos waits for Start")
  assert.equal(isStarted({ ...fresh, tasks: [task("T1", "merged"), task("T2", "pending")] }, {}), true, "a job from before the form")
  assert.equal(isStarted({ ...fresh, native: true }, {}), true, "a planned job started with run_job")
  updateControl(project, "job-1", { started: true, auto: false })
  updateControl(project, "job-1", { parallel: false })
  assert.deepEqual(loadControl(project, "job-1"), { started: true, auto: false, parallel: false }, "each update merges")
  assert.equal(isStarted(fresh, { started: true, stopped: true }), false, "STOP holds a started job")
  saveLastOptions(project, { auto: false, parallel: true, review: true })
  assert.deepEqual(lastOptions(project), { auto: false, parallel: true, review: true })
  assert.deepEqual(optionsOf({ auto: true }, lastOptions(project)), { auto: true, parallel: true, review: true })
})
