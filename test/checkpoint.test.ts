import assert from "node:assert/strict"
import { test } from "node:test"

import { signalFor, verdict } from "../src/checkpoint.ts"
import { Watchdog, type Progress } from "../src/watchdog.ts"

const p = (over: Partial<Progress> = {}): Progress => ({ steps: 60, calls: 70, writes: 4, callsSinceWrite: 5, filesRead: 12, recent: [], recentFailures: 0, ...over })
const n = (x: number) => ({ type: "noul" as const, noul: x })

test("a checkpoint lets a progressing task go on, gives a stuck one another approach, hands an unclear one back", () => {
  assert.equal(verdict({ making_progress: n(0.8) }, p()), "continue")
  assert.equal(verdict({ making_progress: n(0.45), wrong_approach: n(0.7) }, p()), "continue", "unsure: go on, cutting costs the work done")
  assert.equal(verdict({ making_progress: n(0.2), wrong_approach: n(0.3), task_unclear: n(0.2) }, p()), "continue", "no clear reason to cut")
  assert.equal(verdict({ making_progress: n(0.2), wrong_approach: n(0.7), task_unclear: n(0.3) }, p()), "fresh")
  assert.equal(verdict({ making_progress: n(0.2), wrong_approach: n(0.3), task_unclear: n(0.8) }, p()), "handback")
  assert.equal(signalFor("continue", p()), undefined)
  assert.equal(signalFor("fresh", p())?.kind, "checkpoint")
  assert.match(signalFor("handback", p({ callsSinceWrite: 44 }))!.detail, /44 calls since the last one; back to the micromanager|44 calls since the last one/)
})

test("without an answer, only a long stretch without writes and with failures gets a fresh try", () => {
  assert.equal(verdict({}, p()), "continue")
  assert.equal(verdict({}, p({ callsSinceWrite: 45, recentFailures: 4 })), "fresh")
})

test("the watchdog counts writes and failures and says when a checkpoint is due", () => {
  const w = new Watchdog()
  w.watch("s", { maxSteps: 1000, sameCall: 999, readRepeat: 999, noNewFiles: 999, monologue: 999 })
  w.onTool("s", "read", { path: "a" })
  w.onTool("s", "edit", { path: "a" })
  w.onTool("s", "shell", { command: "npm test" }, true)
  const pr = w.progress("s")!
  assert.deepEqual([pr.writes, pr.callsSinceWrite, pr.recentFailures], [1, 1, 1])
  const turn = [{ role: "assistant", content: [{ type: "tool-call" }] }]
  for (let i = 0; i < 59; i++) w.onTurn("s", turn)
  assert.equal(w.checkpointDue("s"), false)
  w.onTurn("s", turn)
  assert.equal(w.checkpointDue("s"), true)
})
