import assert from "node:assert/strict"
import { test } from "node:test"

import { startable } from "../src/continuation.ts"
import { elapsed, foldedLine, jobsFor, projectOf, resolver, sessionJobs, shortModel, sidebarCounts, sidebarGroups, summaryLine, taskChoices, view } from "../src/progress.ts"
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
    ["TODO", 3, ["T6", "T7", "T8"]], // can start
    ["BLOCKED", 1, ["T5 ⧗ T3"]], // waits for T3, which runs
    ["FAILED", 1, ["T2"]],
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

test("a task done over moves to DONE once its replacement is in, and stands aside while it runs", () => {
  const names = (j: Job, resolve?: Parameters<typeof view>[2]) =>
    sidebarGroups(view(j, Date.now(), resolve)).map((g) => [g.name, g.lines.map((l) => `${l.id}${l.detail ? ` ${l.detail}` : ""}`)])
  const redone = job("job-1", { tasks: [
    task("T19", "cancelled", { replacedBy: "T26" }),
    task("T26", "merged", { replaces: ["T19"] }),
    task("T27", "cancelled"),
    task("T28", "escalated"),
  ] })
  assert.deepEqual(names(redone), [["FAILED", ["T28"]], ["DROPPED", ["T27"]], ["DONE", ["T19 ↻ T26", "T26"]]])
  assert.equal(summaryLine(view(redone)), "job-1 · 1/2 ✔ · 1 ✖ · execute", "the replacement counts, the replaced and dropped do not")
  assert.deepEqual(sidebarCounts(sidebarGroups(view(redone))).map((c) => c.text), ["[✓]1", "[✗]1"], "the counts agree")
  const running = job("job-1", { tasks: [task("T19", "escalated", { replacedBy: "T26" }), task("T26", "running")] })
  assert.deepEqual(names(running), [["RUNNING", ["T26"]]], "while the replacement runs, it stands for the failed one")
  // Across jobs: the old planned job's T18, done over by the session's own T17.
  const old = job("job-8d1c", { tasks: [task("T18", "cancelled", { replacedBy: "job-0e69/T17" })] })
  const own = job("job-0e69", { tasks: [task("T17", "merged", { replaces: ["job-8d1c/T18"] })] })
  assert.deepEqual(names(old, resolver([old, own])), [["DONE", ["T18 ↻ T17"]]])
  assert.deepEqual(names(old), [["DROPPED", ["T18"]]], "without the other job in view, a cancelled task is dropped")
  const waiting = job("job-8d1c", { tasks: [task("T18", "cancelled", { replacedBy: "job-0e69/T17" }), task("T20", "pending", { dependsOn: ["T18"] })] })
  assert.deepEqual(view(waiting, Date.now(), resolver([waiting, own])).rows[1]!.waitsFor, [], "a task done over in another job no longer blocks")
})

test("a task waiting for one that was done over can start once the replacement is merged", () => {
  const j = job("job-1", { tasks: [task("T1", "cancelled", { replacedBy: "T3" }), task("T2", "pending", { dependsOn: ["T1"] }), task("T3", "merged")] })
  assert.deepEqual(startable(j).map((t) => t.id), ["T2"])
  assert.deepEqual(view(j).rows.find((r) => r.id === "T2")!.waitsFor, [])
})

test("one checklist per session: the newest job with tasks in full, the others folded", () => {
  const empty = view(job("job-20261019-200109-eae5", { phase: "planning_session" }))
  const own = view(job("job-20261019-214132-0e69", { rolling: true, tasks: [task("T1", "merged"), task("T2", "running")] }))
  const old = view(job("job-20261018-194216-8d1c", { phase: "ask_user", tasks: [task("T1", "merged"), task("T2", "pending")] }))
  const { main, others } = sessionJobs([empty, own, old])
  assert.equal(main?.id, own.id)
  assert.deepEqual(others.map(foldedLine), ["older 8d1c · 1/2 · waits for you"])
})

test("a task whose worker ended unfinished shows as STOPPED, not as running", () => {
  const stopped = task("T5", "running", { session: "ses_5", stages: [{ stage: "delegate", result: "pass", at: "2026-10-20T10:00:00Z" }, { stage: "end", result: "fail", at: "2026-10-20T10:05:00Z" }] })
  const v = view(job("job-1", { tasks: [stopped, task("T6", "running")] }))
  assert.deepEqual(sidebarGroups(v).map((g) => [g.name, g.lines.map((l) => l.id)]), [["RUNNING", ["T6"]], ["STOPPED", ["T5"]]])
  assert.equal(v.running, 1)
  const resumed = { ...stopped, stages: [...stopped.stages, { stage: "resume", result: "pass" as const, at: "2026-10-20T10:06:00Z" }] }
  assert.deepEqual(sidebarGroups(view(job("job-1", { tasks: [resumed] }))).map((g) => g.name), ["RUNNING"], "continued, it runs again")
})
