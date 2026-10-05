import assert from "node:assert/strict"
import { test } from "node:test"

import { board } from "../src/board.ts"
import { newJob, type Task } from "../src/state.ts"

const task = (id: string, status: Task["status"], extra: Partial<Task> = {}): Task => ({
  id, title: `task ${id}`, description: "", role: "code", acceptance: [], dependsOn: [], files: [], wave: 0, status, attempts: 0, stages: [], signatures: [], ...extra,
})

test("the board shows each task's state, model and what it does or waits for", () => {
  const job = newJob("job-1", "goal")
  job.rolling = true
  job.integrationBranch = "jev/job-1"
  job.counters = { turns: 1, stalls: 0, replans: 0, tokens: 941_000, requests: 209, cost: 0.34 }
  job.tasks = [
    task("T1", "merged", { model: "opencode-go/deepseek-v4.1-flash", role: "explore" }),
    task("T2", "running", { model: "opencode-go/glm-5.3-flash", attempts: 1, stages: [{ stage: "gate", result: "fail", at: new Date(Date.now() - 90_000).toISOString() }] }),
    task("T3", "blocked", { summary: "which file?" }),
    task("T4", "pending", { dependsOn: ["T2"] }),
  ]
  const b = board(job, 110)
  assert.match(b, /session tasks · intake/)
  assert.match(b, /1\/4 done · tokens 941k · requests 209 · \$0\.34/)
  assert.match(b, /✔ T1 +merged +explore +deepseek/)
  assert.match(b, /▶ T2 +running +code +glm-5\.3 +task T2  ← gate · fix 1 · 1m/)
  assert.match(b, /⏸ T3 .*← waits: which file\?/)
  assert.match(b, /· T4 .*← after T2/)
})
