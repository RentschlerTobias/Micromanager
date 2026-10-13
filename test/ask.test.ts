import assert from "node:assert/strict"
import { test } from "node:test"

import { askAnswer, askKey, askNote, Asks, type AskRequest } from "../src/ask.ts"

const REQ: AskRequest = {
  sessionID: "ses_w",
  parent: "ses_mm",
  task: "T2 Render the deck",
  agent: "coder",
  action: "shell",
  resources: ["chromium --headless --screenshot=/tmp/shot.png http://localhost:8123"],
  reason: "Jev unsure (0.60 < 0.85 for write)",
  hard: false,
}

function replies() {
  const got: string[] = []
  return { got, reply: async (decision: string, message?: string) => { got.push(message ? `${decision}: ${message}` : decision) } }
}

test("a paused request is let go once by the micromanager, and asked again next time", async () => {
  const journal: Record<string, unknown>[] = []
  const asks = new Asks((e) => journal.push(e))
  const r = replies()
  const ask = asks.open(REQ, r.reply)
  assert.equal(ask.id, "A1")
  assert.ok(asks.waiting("ses_w"))
  assert.equal(asks.oldest("ses_mm")?.id, "A1")
  assert.match((await asks.answer("A1", "once", "micromanager")).text, /^A1 allowed once \(the micromanager\)/)
  assert.deepEqual(r.got, ["once"])
  assert.equal(asks.waiting("ses_w"), false)
  assert.equal(asks.standing("ses_mm", REQ.action, REQ.resources), undefined, "once is once")
  assert.deepEqual(journal.map((e) => e.event), ["opened", "answered"])
})

test("allowed for the job, the same request runs without asking; refused, it is refused without asking", async () => {
  const asks = new Asks()
  await asks.answer(asks.open(REQ, replies().reply).id, "job", "user")
  assert.equal(asks.standing("ses_mm", REQ.action, REQ.resources), "allow")
  assert.equal(asks.standing("ses_other", REQ.action, REQ.resources), undefined, "only in that micromanager's job")
  const other = { ...REQ, resources: ["pkill -f http.server"] }
  const r = replies()
  await asks.answer(asks.open(other, r.reply).id, "refuse", "micromanager", "not your server")
  assert.equal(asks.standing("ses_mm", other.action, other.resources), "deny")
  assert.match(r.got[0]!, /^reject: Refused by the micromanager: not your server\./)
})

test("a hard rule opens only on the user's word", async () => {
  const asks = new Asks()
  const r = replies()
  const ask = asks.open({ ...REQ, resources: ["git push origin HEAD"], reason: "always the user: a destructive or irreversible command", hard: true }, r.reply)
  assert.match((await asks.answer(ask.id, "once", "micromanager")).text, /only the user can allow it/)
  assert.deepEqual(r.got, [], "still paused")
  assert.match((await asks.answer(ask.id, "once", "user")).text, /allowed once \(the user\)/)
  assert.deepEqual(r.got, ["once"])
})

test("nobody answering refuses it after the timeout, with the old carry-on message, and remembers nothing", async () => {
  const asks = new Asks(() => {}, 20)
  const r = replies()
  asks.open(REQ, r.reply)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.match(r.got[0]!, /^reject: This is refused, not queued: nobody answered in time/)
  assert.equal(asks.waiting("ses_w"), false)
  assert.equal(asks.standing("ses_mm", REQ.action, REQ.resources), undefined, "a timeout is no one's decision")
})

test("a refusal fails every paused request of the session, as OpenCode does", async () => {
  const asks = new Asks()
  const a = asks.open(REQ, replies().reply)
  const b = asks.open({ ...REQ, resources: ["npm run e2e"] }, replies().reply)
  await asks.answer(a.id, "refuse", "user")
  assert.equal(asks.get(b.id), undefined)
  assert.match((await asks.answer(b.id, "once", "user")).text, /no request A2 waiting/)
})

test("the user's answer is read in English and German, and nothing else is an answer", () => {
  for (const t of ["yes", "Ja", "ok.", "allow once"]) assert.equal(askAnswer(t), "once", t)
  for (const t of ["yes always", "ja immer", "Always!"]) assert.equal(askAnswer(t), "job", t)
  for (const t of ["no", "Nein", "refuse"]) assert.equal(askAnswer(t), "refuse", t)
  for (const t of ["yes, but only the first one", "what does it do?", ""]) assert.equal(askAnswer(t), undefined, t)
  assert.equal(askKey("shell", ["npm  test "]), askKey("shell", ["npm test"]), "whitespace does not make another request")
})

test("the note says what is asked, why, who decides and what happens without an answer", () => {
  const asks = new Asks()
  const soft = askNote(asks.open(REQ, replies().reply))
  assert.match(soft, /A1: worker T2 Render the deck \(coder, session ses_w\) is paused/)
  assert.match(soft, /Request: shell: chromium --headless/)
  assert.match(soft, /Jev unsure/)
  assert.match(soft, /answer_permission with id A1/)
  assert.match(soft, /refused in 10 minutes/)
  const hard = askNote(asks.open({ ...REQ, hard: true, reason: "always the user: a destructive or irreversible command" }, replies().reply))
  assert.match(hard, /only the user can allow it/)
  assert.doesNotMatch(hard, /call answer_permission with id/)
})

test("the requests of a worker that ended are dropped, and only those", async () => {
  const journal: Record<string, unknown>[] = []
  const asks = new Asks((e) => journal.push(e))
  const worker = replies()
  const helper = replies()
  const other = replies()
  asks.open(REQ, worker.reply)
  asks.open({ ...REQ, sessionID: "ses_helper" }, helper.reply)
  const kept = asks.open({ ...REQ, sessionID: "ses_other" }, other.reply)
  const dropped = await asks.drop(["ses_w", "ses_helper"], "the worker that asked it has ended")
  assert.deepEqual(dropped.map((a) => a.id), ["A1", "A2"])
  assert.deepEqual(worker.got, ["reject: This request is void: the worker that asked it has ended."])
  assert.equal(helper.got.length, 1)
  assert.deepEqual(other.got, [], "another worker's request still waits")
  assert.equal(asks.oldest("ses_mm")?.id, kept.id)
  assert.equal(asks.standing("ses_mm", REQ.action, REQ.resources), undefined, "a dropped request is nobody's decision")
  assert.deepEqual(journal.filter((e) => e.event === "dropped").map((e) => e.id), ["A1", "A2"])
})
