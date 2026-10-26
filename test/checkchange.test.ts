import assert from "node:assert/strict"
import { test } from "node:test"

import { ChangeRequests, changeForm, changeNote, changeResult, MAX_CHANGES, normalTarget, readChange, route, validateRequest, type ChangeRequest } from "../src/checkchange.ts"

const request = (extra: Partial<ChangeRequest> = {}): ChangeRequest => ({
  kind: "check_bug",
  target: "test -f src/wrong.js",
  problem: "the check names a file that is not in the task",
  evidence: "test -f src/wrong.js exits 1; the task's file is a.js, nothing mentions src/",
  proposal: "test -f a.js",
  sessionID: "ses_w",
  parent: "ses_mm",
  task: "T1 add a.js",
  taskId: "T1",
  project: "/p",
  jobId: "job-1",
  ...extra,
})

test("a request needs evidence; a task asks twice at most; a refused target stays refused in any wording", () => {
  assert.equal(validateRequest(request(), 0, []), undefined)
  assert.match(validateRequest(request({ evidence: "too hard" }), 0, [])!, /^evidence: quote the output/)
  assert.match(validateRequest(request({ kind: "nope" as never }), 0, [])!, /^kind is one of/)
  assert.match(validateRequest(request({ proposal: " " }), 0, [])!, /^proposal:/)
  assert.match(validateRequest(request(), MAX_CHANGES, [])!, /asked for 2 changes already/)
  assert.match(validateRequest(request({ target: "  TEST -f   src/wrong.js " }), 0, [normalTarget("test -f src/wrong.js")])!, /was refused for this job already/)
  assert.equal(normalTarget("./Test/A.test.js"), "test/a.test.js")
})

test("who decides depends on what the change touches", () => {
  assert.equal(route("check_bug"), "micromanager")
  assert.equal(route("test_contradicts_spec"), "reviewer")
  assert.equal(route("spec_incomplete"), "user")
  assert.equal(route("contract"), "user")
  const p = { ...request(), id: "K3", at: 0 }
  assert.match(changeNote(p, "micromanager"), /^\[micromanager\] K3: worker T1 add a\.js asks to change test -f src\/wrong\.js \(check_bug\)\.\nProblem: .*\nEvidence: .*\nProposed: test -f a\.js\nThe worker waits for the decision\.\nDecide it with decide_change \(\{ id: "K3"/)
  assert.match(changeNote(p, "reviewer", "opencode-go/glm-5.3-flash"), /start a reviewer .*another model family than the worker's opencode-go\/glm-5\.3-flash/)
  assert.match(changeNote({ ...p, kind: "spec_incomplete" }, "user"), /Only the user decides this: .*\n\{"questions":\[\{"header":"Change K3"/)
  assert.match(changeResult(p, { accepted: true, by: "micromanager", note: "typo" }, 'the check "x" is "y" now'), /^K3 is accepted \(typo\): the check "x" is "y" now\. Run the checks again/)
  assert.match(changeResult(p, { accepted: false, by: "user" }), /^K3 is refused: .* stays as it is for this job\. Do not ask again/)
  assert.match(changeResult(p, { accepted: false, by: "timeout" }), /was not decided in time/)
})

test("the user's form answers a change; typed text is no answer", () => {
  const form = changeForm({ ...request({ kind: "contract" }), id: "K2", at: 0 })
  assert.equal(form[0]!.header, "Change K2")
  assert.match(form[0]!.question, /the fitness contract/)
  assert.deepEqual(readChange("Change K2", ["Accept the change"]), { id: "K2", accepted: true })
  assert.deepEqual(readChange("Change K2", ["Refuse"]), { id: "K2", accepted: false })
  assert.deepEqual(readChange("Change K2", ["yes please"]), { id: "K2", said: "yes please" })
  assert.equal(readChange("Grant G1", ["Refuse"]), undefined)
})

test("a request waits for its decision; one nobody decides, or whose worker ended, is refused", async () => {
  const journal: Record<string, unknown>[] = []
  const changes = new ChangeRequests((e) => journal.push(e), 50)
  const a = changes.open(request())
  assert.equal(a.pending.id, "K1")
  assert.equal(changes.get("k1")!.target, "test -f src/wrong.js")
  assert.equal(changes.answer("K1", { accepted: true, by: "micromanager" })!.id, "K1")
  assert.deepEqual(await a.answer, { accepted: true, by: "micromanager" })
  assert.equal(changes.answer("K1", { accepted: false, by: "user" }), undefined, "decided once")
  const b = changes.open(request())
  assert.deepEqual(await b.answer, { accepted: false, by: "timeout" })
  const c = changes.open(request({ sessionID: "ses_gone" }))
  assert.equal(changes.drop(["ses_gone"]).length, 1)
  assert.equal((await c.answer).accepted, false)
  assert.deepEqual(journal.map((e) => e.event), ["asked", "answered", "asked", "timeout", "asked", "answered"])
})
