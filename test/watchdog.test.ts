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
  assert.deepEqual(d.onTool("s", "read", { path: ".jev-micromanager" }), { kind: "read_loop", severity: "nudge", detail: "read .jev-micromanager 3x in a row with no write in between" })
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
  const nudged = handoffNote({ kind: "read_loop", severity: "nudge", detail: "read a.ts 3x in a row" }, [])
  assert.match(nudged, /drew a nudge from the loop watchdog, not a stop: read a.ts 3x in a row/)
})

test("three identical reads far apart in a session are not a read loop; three close together are", () => {
  const d = w({ sameCall: 99, restartLength: 99 })
  const read = () => d.onTool("s", "read", { path: "config.json" })
  for (let i = 0; i < 3; i++) {
    assert.equal(read(), undefined, `read ${i + 1}`)
    // 30 calls of other work in between: reading the same config file again is what a worker does
    for (let j = 0; j < 30; j++) d.onTool("s", "grep", { pattern: `needle${i}-${j}` })
  }
  const close = w({ sameCall: 99 })
  assert.equal(close.onTool("s", "read", { path: "config.json" }), undefined)
  assert.equal(close.onTool("s", "read", { path: "config.json" }), undefined)
  assert.equal(close.onTool("s", "read", { path: "config.json" })?.kind, "read_loop")
})

test("any progress clears the read count, a `git commit` through the shell included", () => {
  const d = w({ sameCall: 99 })
  const read = () => d.onTool("s", "read", { path: "a.ts", offset: 0 })
  read()
  assert.equal(d.onTool("s", "shell", { command: "git commit -m 'wip'" }), undefined)
  read()
  assert.equal(read(), undefined, "two reads since the commit")
  assert.equal(read()?.kind, "read_loop")
  assert.equal(d.progress("s")?.writes, 1, "the shell commit counts as a write like the edit tools do")
  const added = w({ sameCall: 99 })
  added.onTool("s", "read", { path: "b.ts" })
  added.onTool("s", "shell", { command: "git add b.ts" })
  assert.equal(added.onTool("s", "read", { path: "b.ts" }), undefined)
})

test("a command that works is progress: verifying repeatedly is not a stall", () => {
  // Live test, 2026-10-07: a worker was stopped after "8 calls in a row without a new file or a search" while it
  // was eight calls into reading a source file, before it had written anything. SameCall is the signature that
  // catches a stuck *command*; counting calls as well stopped workers that were simply verifying their work.
  const w = new Watchdog()
  w.watch("s")
  for (let n = 0; n < 40; n++) {
    assert.equal(w.onTool("s", "shell", { command: `npm test -- --run ${n}` }), undefined, `call ${n + 1}`)
  }
  // The same command over and over is still caught, by the signature meant for it.
  const loop = new Watchdog()
  loop.watch("l")
  assert.equal(loop.onTool("l", "shell", { command: "npm test" }), undefined)
  assert.equal(loop.onTool("l", "shell", { command: "npm test" }), undefined)
  assert.equal(loop.onTool("l", "shell", { command: "npm test" })?.kind, "same_call")

  // The check after each edit is the work: an edit in between resets the count (live run, 2026-10-25).
  const verifying = new Watchdog()
  verifying.watch("v")
  for (let n = 0; n < 5; n++) {
    assert.equal(verifying.onTool("v", "edit", { path: "slug.js", oldString: `a${n}`, newString: `a${n + 1}` }), undefined)
    assert.equal(verifying.onTool("v", "shell", { command: "node check.js" }), undefined, `check ${n + 1}`)
  }
  // the same edit over and over is still a loop
  const editing = new Watchdog()
  editing.watch("e")
  for (let n = 0; n < 2; n++) editing.onTool("e", "edit", { path: "a.js", oldString: "x", newString: "y" })
  assert.equal(editing.onTool("e", "edit", { path: "a.js", oldString: "x", newString: "y" })?.kind, "same_call")

  // A command that keeps failing is the case sameCall cannot see: the text differs, nothing works.
  const failing = new Watchdog()
  failing.watch("f", { noNewFiles: 6 })
  for (let n = 0; n < 5; n++) assert.equal(failing.onTool("f", "shell", { command: `step-${n}` }, true), undefined)
  assert.equal(failing.onTool("f", "shell", { command: "step-5" }, true)?.kind, "no_new_files")

  // execute is how a worker acts in code mode: it opens no path, so it must count as progress.
  const code = new Watchdog()
  code.watch("c")
  for (let n = 0; n < 30; n++) assert.equal(code.onTool("c", "execute", { code: `step ${n}` }), undefined)

  // code_graph is a search over the syntax tree; it opens no path either.
  const graph = new Watchdog()
  graph.watch("g")
  for (let n = 0; n < 30; n++) assert.equal(graph.onTool("g", "code_graph", { symbol: `sym${n}` }), undefined)
})

test("re-reading one file to work through it is a reader doing its job", () => {
  // An explorer never writes and often re-opens what it read; a low bar on "new file" stops it on ordinary work.
  const w = new Watchdog()
  w.watch("s")
  for (let n = 0; n < 12; n++) {
    assert.equal(w.onTool("s", "read", { path: "/repo/src/deep/file.ts", offset: n * 100 }), undefined, `part ${n + 1}`)
  }
  // A genuinely quiet session -- re-reading and nothing else -- is still caught, at the higher bar. It takes 16
  // calls: the first opened a new path, so the run starts after it.
  const quiet = new Watchdog()
  quiet.watch("q")
  // The first call opened a new path, so the run starts after it: 16 further re-reads reach the bar.
  for (let n = 0; n < 16; n++) assert.equal(quiet.onTool("q", "read", { path: "/repo/src/deep/file.ts", offset: n * 100 }), undefined, `part ${n}`)
  assert.equal(quiet.onTool("q", "read", { path: "/repo/src/deep/file.ts", offset: 1600 })?.kind, "no_new_files")

  // A reader may opt out entirely: the check is about writing progress, which a reader never does.
  const off = new Watchdog()
  off.watch("o", { noNewFiles: 0 })
  for (let n = 0; n < 100; n++) assert.equal(off.onTool("o", "read", { path: "/repo/src/deep/file.ts", offset: n }), undefined)
})

test("searching is progress: a run of greps is no stall, a run of the same re-read is", () => {
  const searching = w({ sameCall: 99 })
  for (let i = 0; i < 30; i++) assert.equal(searching.onTool("s", "grep", { pattern: `p${i}` }), undefined, `grep ${i}`)
  // restartLength: a long run of identical calls is caught as a start-over instead, which is a better description.
  const d = w({ sameCall: 99, readRepeat: 99, restartLength: 99, noNewFiles: 8 })
  d.onTool("s", "read", { path: "a.ts" })
  for (let i = 0; i < 7; i++) assert.equal(d.onTool("s", "read", { path: "a.ts" }), undefined, `read ${i}`)
  assert.equal(d.onTool("s", "read", { path: "a.ts" })?.kind, "no_new_files")
  assert.equal(w({ sameCall: 99 }).onTool("s", "glob", { pattern: "**/*.ts" }), undefined)
  assert.equal(d.onTool("s", "grep", { pattern: "x" }), undefined, "a search resets the run")
})

test("a read loop and a monologue nudge; the tight loops still stop; untouched kinds carry no severity", () => {
  const d = w({ sameCall: 99 })
  d.onTool("s", "read", { path: "a.ts" })
  d.onTool("s", "read", { path: "a.ts" })
  assert.equal(d.onTool("s", "read", { path: "a.ts" })?.severity, "nudge")
  const talk = (text: string, tool = false) => ({ role: "assistant", content: [{ type: "text", text }, ...(tool ? [{ type: "tool-call" }] : [])] })
  assert.equal(d.onTurn("s", [talk("a", true), talk("b"), talk("c"), talk("d")])?.severity, "nudge")
  const same = w()
  same.onTool("s", "shell", { command: "npm test" })
  same.onTool("s", "shell", { command: "npm test" })
  assert.equal(same.onTool("s", "shell", { command: "npm test" })?.severity, "stop")
  // Re-reading one path and nothing else is the quiet run this signature is for. The bar is noNewFiles (16 by
  // default), and it counts calls rather than the eight the old threshold used.
  const files = w({ sameCall: 99, readRepeat: 99, restartLength: 99 })
  files.onTool("s", "read", { path: "a.ts" })
  for (let i = 0; i < 15; i++) files.onTool("s", "read", { path: "a.ts" })
  assert.equal(files.onTool("s", "read", { path: "a.ts" })?.severity, "stop")
  // a kind this change did not touch keeps the old shape: no severity field at all, so every caller behaves as before
  const steps = w({ maxSteps: 0 })
  const signal = steps.onTurn("s", [])
  assert.equal(signal?.kind, "steps")
  assert.equal("severity" in (signal as object), false)
  const restart = w({ sameCall: 99, restartLength: 2 })
  restart.onTool("s", "read", { path: "a.ts" })
  restart.onTool("s", "glob", { pattern: "*" })
  restart.onTool("s", "edit", { path: "x.ts" })
  let again
  restart.onTool("s", "read", { path: "a.ts" })
  again = restart.onTool("s", "glob", { pattern: "*" }) ?? again
  assert.equal(again?.kind, "restart")
  assert.equal("severity" in (again as object), false)
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
