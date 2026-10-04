import assert from "node:assert/strict"
import { test } from "node:test"

import { applySplits, parsePlan, type Plan } from "../src/plan.ts"

const fence = (o: unknown) => "```json\n" + JSON.stringify(o) + "\n```"
const base = parsePlan(fence({
  acceptance: [{ id: "A1", text: "parser" }, { id: "A2", text: "cli" }, { id: "A3", text: "docs" }],
  tasks: [
    { id: "T1", title: "parser and cli", role: "code", acceptance: ["A1", "A2"], dependsOn: [], files: ["parse.js", "cli.js"] },
    { id: "T2", title: "docs", role: "write", acceptance: ["A3"], dependsOn: ["T1"], files: ["README.md"] },
  ],
})).plan as Plan

const split = (kids: unknown[], acceptance: unknown[] = []) => applySplits(base, fence({ acceptance, splits: { T1: kids } }), ["T1"])

test("children replace their parent, and the tasks that waited for it wait for its last children", () => {
  const r = split([
    { id: "T1.1", title: "parser", role: "code", acceptance: ["A1"], dependsOn: [], files: ["parse.js"] },
    { id: "T1.2", title: "cli", role: "code", acceptance: ["A2", "A4"], dependsOn: ["T1.1"], files: ["cli.js"] },
  ], [{ id: "A4", text: "cli --help works", verify: "node cli.js --help" }])
  assert.equal(r.errors, undefined, String(r.errors))
  assert.deepEqual(r.plan!.tasks.map((t) => [t.id, t.parent ?? "", t.dependsOn.join()]), [["T1.1", "T1", ""], ["T1.2", "T1", "T1.1"], ["T2", "", "T1.2"]])
  assert.ok(r.plan!.acceptance.some((a) => a.id === "A4"))
})

test("a split is rejected when it leaves the parent's scope, drops a point, has one part, or only adds coordination", () => {
  const ok = { id: "T1.1", title: "parser", role: "code", acceptance: ["A1"], dependsOn: [], files: ["parse.js"] }
  assert.match(String(split([ok, { ...ok, id: "T1.2", acceptance: ["A2"], files: ["other.js"] }]).errors), /changes files outside T1's/)
  assert.match(String(split([ok, { ...ok, id: "T1.2", acceptance: ["A1"] }]).errors), /no part covers A2/)
  assert.match(String(split([{ ...ok, acceptance: ["A1", "A2"] }]).errors), /at least two tasks/)
  assert.match(String(split([{ ...ok, acceptance: ["A1", "A2"] }, { ...ok, id: "T1.2", acceptance: ["A1", "A2"] }]).errors), /only adds coordination/)
  assert.match(String(split([ok, { ...ok, id: "X2", acceptance: ["A2"], files: ["cli.js"] }]).errors), /must be named T1.<n>/)
  assert.match(String(applySplits(base, fence({ splits: { T2: [] } }), ["T1"]).errors), /not one of the tasks to split/)
  assert.match(String(applySplits(base, "nope", ["T1"]).errors), /no JSON/)
})
