import assert from "node:assert/strict"
import { test } from "node:test"

import { ending, Notifier, Scheduler, type Cancel } from "../src/scheduler.ts"
import { moveJob, newJob, type Job } from "../src/state.ts"

const jobIn = (id: string, ...phases: Job["phase"][]) => {
  const job = newJob(id, "goal")
  for (const p of phases) moveJob(job, p)
  return job
}

test("the scheduler runs queued jobs one after another and returns at once", async () => {
  const order: string[] = []
  const finished: string[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const s = new Scheduler({
    run: async (id) => {
      order.push(`start ${id}`)
      if (id === "a") await gate
      order.push(`end ${id}`)
      return jobIn(id, "triage", "plan", "plan_gate", "execute", "verify", "integrate")
    },
    finished: (job, session) => finished.push(`${job.id}@${session}`),
    failed: () => assert.fail("no failure expected"),
  })
  assert.equal(s.enqueue("a", "ses_1"), 0)
  assert.equal(s.enqueue("b", "ses_1"), 1)
  assert.equal(s.enqueue("a", "ses_1"), 0, "a running job keeps its place")
  assert.deepEqual(s.snapshot(), { running: "a", queued: ["b"] })
  release()
  await s.idle()
  assert.deepEqual(order, ["start a", "end a", "start b", "end b"])
  assert.deepEqual(finished, ["a@ses_1", "b@ses_1"])
  assert.deepEqual(s.snapshot(), { running: undefined, queued: [] })
})

test("stop cancels the running job and hands back its session; a waiting job leaves the queue", async () => {
  let cancel: Cancel | undefined
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const failed: string[] = []
  const s = new Scheduler({
    run: async (id, c) => {
      cancel = c
      await gate
      return jobIn(id, "triage", "plan", "plan_gate", "execute", "paused")
    },
    finished: () => {},
    failed: (id) => failed.push(id),
  })
  s.enqueue("a")
  s.enqueue("b")
  await Promise.resolve()
  s.working("a", "ses_worker")
  assert.deepEqual(s.stop("b"), { state: "dequeued" })
  assert.deepEqual(s.stop(), { state: "stopping", session: "ses_worker" })
  assert.equal(cancel?.cancelled, true)
  assert.deepEqual(s.stop("nope"), { state: "unknown" })
  release()
  await s.idle()
  assert.deepEqual(s.snapshot().queued, [])
})

test("a run that throws is reported as failed and the queue goes on", async () => {
  const failed: string[] = []
  const finished: string[] = []
  const s = new Scheduler({
    run: async (id) => { if (id === "a") throw new Error("boom"); return jobIn(id, "triage", "plan", "plan_gate", "execute", "ask_user") },
    finished: (job) => finished.push(job.id),
    failed: (id, _s, err) => failed.push(`${id}: ${(err as Error).message}`),
  })
  s.enqueue("a")
  s.enqueue("b")
  await s.idle()
  assert.deepEqual(failed, ["a: boom"])
  assert.deepEqual(finished, ["b"])
})

test("the notifier batches progress quietly and wakes the dictator with a trusted system note at the end", async () => {
  const sent: [string, string, boolean][] = []
  const notes: [string, string][] = []
  const desktop: string[] = []
  const n = new Notifier({
    mode: "jobs",
    flushMs: 10_000,
    synthetic: async (session, text, resume) => sent.push([session, text, resume]),
    steer: (session, note) => notes.push([session, note]),
    desktop: (title) => desktop.push(title),
  })
  n.progress("ses_1", "T1 passed", true)
  n.progress("ses_1", "T2 started")
  assert.equal(sent.length, 0, "progress waits for the flush")
  await n.finished("ses_1", "job-1", "needs_user", "job job-1: ask_user\nwhy: T2 needs the user")
  assert.deepEqual(sent.map(([, t, r]) => [t.split("\n")[0], r]), [["[jev-dictator] progress:", false], ["[jev-dictator] job needs you: job-1 (details in the plugin's system note)", true]])
  assert.match(sent[0]![1], /- T1 passed\n- T2 started/)
  assert.match(notes[0]![1], /comes from your own plugin[\s\S]*why: T2 needs the user/)
  assert.deepEqual(desktop, ["jev-dictator: job needs you"], "per-task desktop notes only in tasks mode")
})

test("tasks mode adds a desktop note per task; off sends none", async () => {
  const desktop: string[] = []
  const make = (mode: "tasks" | "off") => new Notifier({ mode, synthetic: async () => {}, steer: () => {}, desktop: (_t, body) => desktop.push(body), flushMs: 1 })
  make("tasks").progress(undefined, "T1 passed", true)
  await make("off").finished(undefined, "job-2", "done", "ok")
  assert.deepEqual(desktop, ["T1 passed"])
})

test("a job's ending is read from its phase", () => {
  assert.equal(ending(jobIn("a", "triage", "plan", "plan_gate", "execute", "verify", "integrate")), "done")
  assert.equal(ending(jobIn("b", "failed")), "failed")
  assert.equal(ending(jobIn("c", "triage", "plan", "plan_gate", "execute", "paused")), "stopped")
  assert.equal(ending(jobIn("d", "triage", "plan", "plan_gate", "execute", "ask_user")), "needs_user")
})
