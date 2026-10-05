import assert from "node:assert/strict"
import { test } from "node:test"

import { handoffNote, Watchdog } from "../src/watchdog.ts"

const w = (limits = {}) => {
  const d = new Watchdog()
  d.watch("s", limits)
  return d
}

test("only watched sessions are judged", () => {
  const d = new Watchdog()
  assert.equal(d.onTool("other", "read", { path: "a" }), undefined)
  assert.equal(d.watching("other"), false)
})

test("the local planner's loop: the same directory read again and again", () => {
  const d = w()
  // what ornith-u did in the live test, shortened: read, glob, read the same path
  assert.equal(d.onTool("s", "read", { path: "README.md" }), undefined)
  assert.equal(d.onTool("s", "read", { path: ".jev-micromanager" }), undefined)
  assert.equal(d.onTool("s", "glob", { pattern: "**/*" }), undefined)
  assert.equal(d.onTool("s", "read", { path: ".jev-micromanager/" }), undefined)
  // ".jev-micromanager" and ".jev-micromanager/" are the same path: the third read is a loop
  assert.deepEqual(d.onTool("s", "read", { path: ".jev-micromanager" }), { kind: "read_loop", detail: "read .jev-micromanager 3x with no write in between" })
  const same = w({ readRepeat: 99 })
  for (let i = 0; i < 2; i++) same.onTool("s", "grep", { pattern: "TODO" })
  assert.equal(same.onTool("s", "grep", { pattern: "TODO" })?.kind, "same_call")
})

test("a re-read only counts until the file is written", () => {
  const d = w({ sameCall: 99 })
  d.onTool("s", "read", { path: "a.ts", offset: 1 })
  d.onTool("s", "read", { path: "a.ts", offset: 50 })
  d.onTool("s", "edit", { path: "a.ts" })
  d.onTool("s", "read", { path: "a.ts", offset: 1 })
  assert.equal(d.onTool("s", "read", { path: "a.ts", offset: 50 }), undefined)
  assert.equal(d.onTool("s", "read", { path: "a.ts", offset: 1 }), undefined, "the same part twice since the write")
  assert.equal(d.onTool("s", "read", { path: "a.ts", offset: 1 })?.kind, "read_loop")
})

test("reads without any new file, and a session that starts over", () => {
  const d = w({ sameCall: 99, readRepeat: 99, noNewFiles: 4 })
  for (const p of ["a", "b"]) d.onTool("s", "read", { path: p })
  let signal
  for (const p of ["a", "b", "a", "b"]) signal = d.onTool("s", "read", { path: p }) ?? signal
  assert.equal(signal?.kind, "no_new_files")
  const r = w({ sameCall: 99, readRepeat: 99, noNewFiles: 99, restartLength: 3 })
  const opening = [["glob", { pattern: "*" }], ["read", { path: "package.json" }], ["read", { path: "README.md" }]] as const
  for (const [t, i] of opening) r.onTool("s", t, i)
  r.onTool("s", "edit", { path: "x.js" })
  let restart
  for (const [t, i] of opening) restart = r.onTool("s", t, i) ?? restart
  assert.equal(restart?.kind, "restart")
})

test("turns: the step limit, a monologue, the same text again", () => {
  const steps = w({ maxSteps: 2 })
  steps.onTurn("s", [])
  steps.onTurn("s", [])
  assert.equal(steps.onTurn("s", [])?.kind, "steps")
  const talk = (text: string, tool = false) => ({ role: "assistant", content: [{ type: "text", text }, ...(tool ? [{ type: "tool-call" }] : [])] })
  const mono = w()
  assert.equal(mono.onTurn("s", [talk("a", true), talk("b"), talk("c"), talk("d")])?.kind, "monologue")
  const rep = w({ monologue: 99 })
  const long = "Let me look at the project structure first, then I will write the plan."
  assert.equal(rep.onTurn("s", [talk(long, true)]), undefined)
  assert.equal(rep.onTurn("s", [talk(long, true), talk("x", true), talk(long, true)])?.kind, "repeat_text")
})

test("the handoff note names the reason and the files already changed", () => {
  const note = handoffNote({ kind: "read_loop", detail: "read a.ts 3x with no write in between" }, ["a.ts"])
  assert.match(note, /stopped by the loop watchdog: read a.ts 3x/)
  assert.match(note, /Files already changed in this directory: a.ts/)
})

test("reading one long file in parts is no read loop; the same part three times is", () => {
  const w = new Watchdog()
  w.watch("s")
  for (const offset of [0, 100, 213, 380]) assert.equal(w.onTool("s", "read", { path: "/r/conversation.py", offset, limit: 120 }), undefined)
  w.watch("t", { sameCall: 99 })
  w.onTool("t", "read", { path: "/r/a.py", offset: 10, limit: 50 })
  w.onTool("t", "read", { path: "/r/a.py", offset: 10, limit: 50 })
  assert.equal(w.onTool("t", "read", { path: "/r/a.py", offset: 10, limit: 50 })?.kind, "read_loop")
})
