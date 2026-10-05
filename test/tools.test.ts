import assert from "node:assert/strict"
import { test } from "node:test"

import { installTools, planText, TOOL_IDS, type ToolDraft } from "../src/tools.ts"
import { newJob } from "../src/state.ts"

function fakeDraft() {
  const added: Record<string, unknown>[] = []
  const str = { kind: "string" }
  const draft: ToolDraft = {
    get: (id) => (id === "read" ? { input: { fields: { path: str }, mapFields: (f) => ({ mapped: f() }) } } : undefined),
    add: (tool) => added.push(tool),
  }
  return { draft, added, str }
}

const ok = async () => "ok"
const noop = { task: ok, tasks: ok, answer: ok, plan: ok, questions: ok, run: ok, status: ok, stop: ok }
const byId = (added: Record<string, unknown>[], id: string) => {
  const tool = added.find((t) => t.id === id)!
  return { input: tool.input, run: tool.execute as (a: Record<string, unknown>, c: object) => Promise<{ content: string }> }
}

test("the tools are built from the read tool's schema and refuse other agents", async () => {
  const { draft, added, str } = fakeDraft()
  const calls: string[] = []
  const ids = installTools(draft, {
    ...noop,
    task: async (input) => { calls.push(`task:${input.title}:${input.files}:${input.checks}`); return "T1 delegated" },
    plan: async (goal) => { calls.push(`plan:${goal}`); return "planned" },
    questions: async (job, tree) => { calls.push(`questions:${job}:${tree}`); return "asked" },
    status: async () => { throw new Error("boom") },
    stop: async (job) => { calls.push(`stop:${job}`); return "stopping" },
  })
  assert.deepEqual(ids, [...TOOL_IDS])
  assert.deepEqual(byId(added, "plan_job").input, { mapped: { goal: str } })
  assert.deepEqual(byId(added, "delegate_task").input, { mapped: { title: str, prompt: str, files: str, depends: str, priority: str, checks: str } })
  const dict = { agent: "micromanager" }
  assert.deepEqual(await byId(added, "delegate_task").run({ title: "add x", prompt: "p", files: "a.js", depends: "", priority: "", checks: "npm test" }, dict), { content: "T1 delegated" })
  assert.deepEqual(await byId(added, "plan_job").run({ goal: "add a flag" }, dict), { content: "planned" })
  assert.deepEqual(await byId(added, "plan_questions").run({ job: "job-1", tree: "[]" }, dict), { content: "asked" })
  assert.deepEqual(await byId(added, "run_job").run({ job: "job-1", note: "" }, { agent: "build" }), { content: "Only the micromanager agent may use this tool." })
  assert.deepEqual(await byId(added, "job_status").run({ job: "" }, dict), { content: "failed: boom" })
  assert.deepEqual(await byId(added, "delegate_task").run({ title: "x" }, {}), { content: "Only the micromanager agent may use this tool." })
  assert.deepEqual(await byId(added, "stop_job").run({ job: "" }, dict), { content: "stopping" })
  assert.deepEqual(calls, ["task:add x:a.js:npm test", "plan:add a flag", "questions:job-1:[]", "stop:"])
  assert.throws(() => installTools({ get: () => undefined, add: () => {} }, noop))
})

test("a session the runner started is refused even as the micromanager agent", async () => {
  const { draft, added } = fakeDraft()
  const ran: string[] = []
  installTools(draft, { ...noop, run: async (job) => { ran.push(job); return "ran" } }, "micromanager", (id) => id === "ses_worker")
  const run = byId(added, "run_job").run
  assert.deepEqual(await run({ job: "job-1" }, { agent: "micromanager", sessionID: "ses_worker" }), { content: "Only the micromanager agent may use this tool." })
  assert.deepEqual(await run({ job: "job-1" }, { agent: "micromanager", sessionID: "ses_user" }), { content: "ran" })
  assert.deepEqual(ran, ["job-1"])
})

test("the plan text lists acceptance points and tasks", () => {
  const job = newJob("job-1", "add a flag")
  job.acceptance = [{ id: "A1", text: "flag works", verify: "npm test" }]
  job.tasks = [{ id: "T1", title: "add flag", description: "", role: "code", acceptance: ["A1"], dependsOn: [], files: ["cli.js"], wave: 0, status: "pending", attempts: 0, stages: [], signatures: [] }]
  const text = planText(job)
  assert.match(text, /- A1: flag works \(check: npm test\)/)
  assert.match(text, /- T1 \[code\] add flag\n  files: cli.js\n  covers: A1/)
})

test("a reader may read outside the project only in a directory its task names", async () => {
  const { namedInTask } = await import("../src/plugin.ts")
  const task = "T2 Map oc-voice fluency: read /home/t1dde/Fun/Projects/Repos/oc-voice/voice/loop.py and the README in /home/t1dde/Fun/Projects/Repos/oc-voice"
  assert.equal(namedInTask(task, ["/home/t1dde/Fun/Projects/Repos/oc-voice/*"]), true)
  assert.equal(namedInTask(task, ["/home/t1dde/Fun/Projects/Repos/oc-voice/voice/*"]), true)
  assert.equal(namedInTask(task, ["/home/t1dde/.ssh/*"]), false)
  assert.equal(namedInTask(task, ["/home/t1dde/Fun/Projects/Repos/oc-voice-secrets/*"]), false)
  assert.equal(namedInTask("no paths here", ["/home/t1dde/x/*"]), false)
  assert.equal(namedInTask("read /home/t1dde/Repos/a/src/main.py", ["/home/t1dde/Repos/a/src/*"]), true, "a named file opens its directory")
})
