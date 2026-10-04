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

test("the three tools are built from the read tool's schema and refuse other agents", async () => {
  const { draft, added, str } = fakeDraft()
  const calls: string[] = []
  const ids = installTools(draft, {
    plan: async (goal) => { calls.push(`plan:${goal}`); return "planned" },
    run: async (job) => { calls.push(`run:${job}`); return "ran" },
    status: async () => { throw new Error("boom") },
  })
  assert.deepEqual(ids, [...TOOL_IDS])
  assert.deepEqual(added[0]!.input, { mapped: { goal: str } })
  const exec = (i: number) => added[i]!.execute as (a: Record<string, unknown>, c: object) => Promise<{ content: string }>
  assert.deepEqual(await exec(0)({ goal: "add a flag" }, { agent: "dictator" }), { content: "planned" })
  assert.deepEqual(await exec(1)({ job: "job-1" }, { agent: "build" }), { content: "Only the dictator agent may use this tool." })
  assert.deepEqual(await exec(2)({ job: "" }, { agent: "dictator" }), { content: "failed: boom" })
  assert.deepEqual(calls, ["plan:add a flag"])
  assert.throws(() => installTools({ get: () => undefined, add: () => {} }, { plan: async () => "", run: async () => "", status: async () => "" }))
})

test("the plan text lists acceptance points and tasks", () => {
  const job = newJob("job-1", "add a flag")
  job.acceptance = [{ id: "A1", text: "flag works", verify: "npm test" }]
  job.tasks = [{ id: "T1", title: "add flag", description: "", role: "code", acceptance: ["A1"], dependsOn: [], files: ["cli.js"], wave: 0, status: "pending", attempts: 0, stages: [], signatures: [] }]
  const text = planText(job)
  assert.match(text, /- A1: flag works \(check: npm test\)/)
  assert.match(text, /- T1 \[code\] add flag\n  files: cli.js\n  covers: A1/)
})
