import assert from "node:assert/strict"
import { test } from "node:test"

import { elapsed, jobsFor, projectOf, shortModel, sidebarCounts, sidebarGroups, summaryLine, taskChoices, view } from "../src/progress.ts"
import { newJob, type Job, type Task } from "../src/state.ts"

const task = (id: string, status: Task["status"], extra: Partial<Task> = {}): Task => ({
  id, title: `task ${id}`, description: "", role: "code", acceptance: [], dependsOn: [], files: [], wave: 0, status, attempts: 0, stages: [], signatures: [], ...extra,
})

const job = (id: string, extra: Partial<Job> = {}): Job => ({ ...newJob(id, "goal"), facilitator: "ses_micro", phase: "execute", ...extra })

test("a worker's worktree belongs to the project it lies in", () => {
  assert.equal(projectOf("/home/u/tutorials/.jev-micromanager/worktrees/job-1--T3/reinforcementLearning"), "/home/u/tutorials")
  assert.equal(projectOf("/home/u/tutorials/.micromanager/worktrees/job-1--T3"), "/home/u/tutorials")
  assert.equal(projectOf("/home/u/tutorials"), "/home/u/tutorials")
})

test("the micromanager sees its running jobs; a worker sees the job it works for", () => {
  const planned = job("job-1", { updated: "2026-10-19T10:00:00Z", tasks: [task("T1", "running", { session: "ses_t1", sessions: ["ses_old", "ses_t1"] })] })
  const ended = job("job-0", { phase: "done", updated: "2026-10-18T10:00:00Z" })
  const other = job("job-2", { facilitator: "ses_other" })
  assert.deepEqual(jobsFor([ended, planned, other], "ses_micro").map((j) => j.id), ["job-1"])
  assert.deepEqual(jobsFor([ended, planned, other], "ses_old").map((j) => j.id), ["job-1"], "an earlier session of the task too")
  assert.deepEqual(jobsFor([ended], "ses_micro").map((j) => j.id), ["job-0"], "with nothing running, the newest result stays in view")
  assert.deepEqual(jobsFor([planned], "ses_user"), [])
})

test("the progress line and the todo rows count what is done, running and given up", () => {
  const v = view(job("job-1", {
    tasks: [
      task("T1", "merged"),
      task("T2", "running", { sessions: ["ses_a", "ses_b"], stages: [{ stage: "gate", result: "fail", at: new Date().toISOString() }] }),
      task("T3", "escalated", { escalation: { kind: "too_hard", detail: "loop" } }),
      task("T4", "pending", { dependsOn: ["T2"] }),
      task("T5", "merged", { undone: "c1" }),
    ],
  }))
  assert.equal(summaryLine(v), "job-1 · 1/4 ✔ · 1 ▶ · 1 ✖ · execute")
  assert.deepEqual(v.rows.map((r) => `${r.icon} ${r.id}`), ["✔ T1", "▶ T2", "✖ T3", "· T4"])
  assert.equal(v.rows[1]!.session, "ses_b", "the newest session of a task is the one to open")
  assert.match(v.rows[1]!.detail, /^gate/)
  assert.equal(v.rows[3]!.detail, "after T2")
})

test("/tasks offers the way back to the micromanager from a worker, and each task's session", () => {
  const v = view(job("job-1", { tasks: [task("T1", "merged", { session: "ses_t1" }), task("T2", "pending")] }))
  const fromWorker = taskChoices([v], "ses_t1")
  assert.deepEqual(fromWorker[0], { title: "↑ the micromanager", value: "ses_micro", category: "job-1" })
  assert.deepEqual(fromWorker.slice(1).map((c) => [c.title, c.value]), [["✔ T1 task T1", "ses_t1"], ["· T2 task T2", ""]])
  assert.equal(fromWorker[2]!.description, "pending, no session yet")
  assert.equal(taskChoices([v], "ses_micro")[0]!.title, "✔ T1 task T1", "no way back from the micromanager itself")
})

test("the sidebar groups the job as a checklist: waiting, running, failed, next, done, each in plan order", () => {
  const now = Date.parse("2026-10-19T12:00:00Z")
  const tasks = [
    task("T1", "merged"),
    task("T2", "escalated", { escalation: { kind: "too_hard", detail: "loop" } }),
    task("T3", "running", { model: "opencode-go/glm-5.3-flash", session: "ses_t3", stages: [{ stage: "delegate", result: "pass", at: "2026-10-19T11:56:00Z" }, { stage: "gate", result: "fail", at: "2026-10-19T11:59:00Z" }] }),
    task("T4", "running", { model: "opencode-go/mimo-v2.6-pro", session: "ses_t4" }),
    task("T5", "pending", { dependsOn: ["T3"] }),
    task("T6", "pending"),
    task("T7", "pending"),
    task("T8", "pending"),
    task("T9", "merged"),
  ]
  const groups = sidebarGroups(view(job("job-1", { tasks }), now), new Map([["ses_t4", "shell"]]), now)
  assert.deepEqual(groups.map((g) => [g.name, g.count, g.lines.map((l) => `${l.id}${l.detail ? ` ${l.detail}` : ""}`)]), [
    ["WAITING FOR YOU", 1, ["T4 shell"]],
    ["RUNNING", 1, ["T3 glm 4m"]],
    ["FAILED", 1, ["T2"]],
    ["NEXT", 4, ["T6", "T7", "T8"]], // the startable ones; T5 waits for T3
    ["DONE", 2, ["T1", "T9"]],
  ])
  assert.deepEqual(sidebarCounts(groups).map((c) => c.text), ["[✓]2", "[▸]1", "[!]1", "[✗]1", "[ ]4"])
  const quiet = sidebarGroups(view(job("job-1", { tasks: [task("T1", "merged")] })))
  assert.deepEqual(quiet.map((g) => g.name), ["DONE"], "an empty group is left out")
})

test("a running task shows its model's family and how long it runs", () => {
  assert.equal(shortModel("opencode-go/deepseek-v4.1-flash"), "deeps")
  assert.equal(shortModel("opencode-go/gemini-4-argon-contributor"), "gemin")
  assert.equal(shortModel(undefined), "")
  const now = Date.parse("2026-10-19T12:00:00Z")
  assert.equal(elapsed("2026-10-19T11:59:51Z", now), "9s")
  assert.equal(elapsed("2026-10-19T11:56:00Z", now), "4m")
  assert.equal(elapsed("2026-10-19T10:48:00Z", now), "1.2h")
  assert.equal(elapsed(undefined, now), "")
})
