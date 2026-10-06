import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { matchShortcut, resolvePolicy, validatePolicies } from "../src/policy.ts"
import { newJob } from "../src/state.ts"
import { excludeFromGit, jobId, listJobs, loadJob, reconcileJob, saveJob, saveNote } from "../src/store.ts"

test("jobs round-trip through their file, newest first", () => {
  const project = mkdtempSync(join(tmpdir(), "jd-store-"))
  const a = newJob("job-a", "first", new Date("2026-10-04T10:00:00Z"))
  const b = newJob("job-b", "second", new Date("2026-10-04T11:00:00Z"))
  saveJob(project, a)
  saveJob(project, b)
  assert.equal(loadJob(project, "job-a")?.goal, "first")
  assert.equal(loadJob(project, "nope"), undefined)
  assert.deepEqual(listJobs(project).map((j) => j.id), ["job-b", "job-a"])
  assert.match(readFileSync(saveNote(project, "job-a", "T1", "report"), "utf8"), /report/)
})

test("the state directory is excluded from git once, and only in a repository", () => {
  const project = mkdtempSync(join(tmpdir(), "jd-git-"))
  try {
    assert.equal(excludeFromGit(project), false)
    execFileSync("git", ["init", "-q", project])
    assert.equal(excludeFromGit(project), true)
    assert.equal(excludeFromGit(project), true)
    const lines = readFileSync(join(project, ".git", "info", "exclude"), "utf8").split("\n")
    assert.equal(lines.filter((l) => l === ".jev-micromanager/").length, 1)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

// The real run: the project was a subdirectory of a monorepo, so <project>/.git did not exist and nothing was written.
test("the exclude file of the repository is found when the project is a subdirectory of it", () => {
  const root = mkdtempSync(join(tmpdir(), "jd-mono-"))
  try {
    execFileSync("git", ["init", "-q", root])
    const project = join(root, "packages", "app")
    mkdirSync(project, { recursive: true })
    assert.equal(excludeFromGit(project), true)
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf8")
    assert.match(exclude, /^\.jev-micromanager\/$/m)
    assert.match(exclude, /^\.opencode\/memory\/$/m)
    assert.equal(excludeFromGit(project), true, "idempotent")
    const lines = readFileSync(join(root, ".git", "info", "exclude"), "utf8").split("\n")
    assert.equal(lines.filter((l) => l === ".jev-micromanager/").length, 1)
    assert.equal(lines.filter((l) => l === ".opencode/memory/").length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// A worktree checkout keeps its exclude file in the main repository's .git, outside the worktree.
test("the exclude file of a worktree checkout is the main repository's", () => {
  const root = mkdtempSync(join(tmpdir(), "jd-wt-"))
  try {
    execFileSync("git", ["init", "-q", root])
    writeFileSync(join(root, "a.txt"), "a")
    execFileSync("git", ["-C", root, "add", "-A"])
    execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"])
    const wt = join(root, "wt")
    execFileSync("git", ["-C", root, "worktree", "add", "-q", wt])
    assert.equal(excludeFromGit(wt), true)
    assert.match(readFileSync(join(root, ".git", "info", "exclude"), "utf8"), /^\.jev-micromanager\/$/m)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a corrupt job file is skipped and the good ones are still listed", () => {
  const project = mkdtempSync(join(tmpdir(), "jd-corrupt-"))
  try {
    saveJob(project, newJob("job-a", "first", new Date("2026-10-04T10:00:00Z")))
    writeFileSync(join(project, ".jev-micromanager", "jobs", "job-broken.json"), "{ half a fi")
    assert.deepEqual(listJobs(project).map((j) => j.id), ["job-a"])
    assert.equal(loadJob(project, "job-broken"), undefined)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

const reconciled = () => {
  const job = newJob("j1", "goal", new Date("2026-10-04T10:00:00Z"))
  job.tasks = [{ id: "T1", title: "t", description: "", role: "code", acceptance: [], dependsOn: [], files: [], wave: 0, status: "running", attempts: 1, stages: [], signatures: [] }]
  return job
}

test("a running task whose session is gone becomes terminal, counts an attempt and says why", () => {
  const job = reconciled()
  job.tasks[0]!.session = "ses_gone"
  const { job: next, result } = reconcileJob(job, { aliveSessions: new Set(["ses_live"]), existingPaths: new Set() }, new Date("2026-10-04T12:00:00Z"))
  const [task] = next.tasks
  assert.equal(task.status, "cancelled")
  assert.equal(task.attempts, 2)
  assert.deepEqual(task.stages.map((s) => [s.stage, s.result]), [["reconcile", "fail"]])
  assert.match(task.stages[0]?.at ?? "", /^2026-10-04T12:00:00\.000Z$/)
  assert.deepEqual(result.changes.map((c) => [c.taskId, c.from, c.to]), [["T1", "running", "cancelled"]])
  assert.match(result.changes[0]?.reason ?? "", /ses_gone ended without handing off/)
})

test("a running task with no session is told apart from one whose worker died", () => {
  const job = reconciled()
  const { result } = reconcileJob(job, { aliveSessions: new Set(["ses_live"]) })
  assert.match(result.changes[0]?.reason ?? "", /no worker session was ever started/)
})

test("a running task with a live session is left alone", () => {
  const job = reconciled()
  job.tasks[0]!.session = "ses_live"
  const { job: next, result } = reconcileJob(job, { aliveSessions: new Set(["ses_live"]) })
  assert.equal(next.tasks[0]!.status, "running")
  assert.equal(next.tasks[0]!.attempts, 1)
  assert.deepEqual(result.changes, [])
  assert.deepEqual(next.tasks[0]!.stages, [])
})

test("without the session list a task with a session is left alone, one without is still stale", () => {
  const job = reconciled()
  job.tasks[0]!.session = "ses_maybe"
  assert.deepEqual(reconcileJob(job).result.changes, [], "nobody said the session is dead")
  const noSession = reconciled()
  assert.deepEqual(reconcileJob(noSession).result.changes.map((c) => c.taskId), ["T1"], "running without a worker was never live")
})

test("the merged task's worktree is reported as an orphan, a deleted one is not", () => {
  const job = newJob("j1", "goal")
  job.tasks = [
    { id: "T1", title: "a", description: "", role: "code", acceptance: [], dependsOn: [], files: [], wave: 0, status: "merged", attempts: 1, stages: [], signatures: [], worktree: "/wt/a", branch: "job/a" },
    { id: "T2", title: "b", description: "", role: "code", acceptance: [], dependsOn: [], files: [], wave: 0, status: "merged", attempts: 1, stages: [], signatures: [], worktree: "/wt/b", branch: "job/b" },
  ]
  const { result } = reconcileJob(job, { existingPaths: new Set(["/wt/a"]) })
  assert.deepEqual(result.orphans, [{ taskId: "T1", worktree: "/wt/a", branch: "job/a" }])
  assert.deepEqual(reconcileJob(job).result.orphans.map((o) => o.taskId), ["T1", "T2"])
})

test("reconciling does not change the job it was given and stamps a new updated", () => {
  const job = reconciled()
  job.tasks[0]!.session = "ses_gone"
  const before = structuredClone(job)
  const { job: next } = reconcileJob(job, { aliveSessions: new Set() })
  assert.deepEqual(job, before)
  assert.equal(job.updated, "2026-10-04T10:00:00.000Z")
  assert.equal(next.updated !== job.updated, true)
  assert.equal(next.tasks[0]!.status, "cancelled", "the copy is swept")
  assert.equal(job.tasks[0]!.status, "running", "the job it was given is not")
})

test("a job file with an unknown status is swept without throwing", () => {
  const job = reconciled()
  const legacy = { ...job, tasks: [{ ...job.tasks[0]!, status: "working" }] } as unknown as typeof job
  const weird = { ...job, tasks: [{}, null, 7] } as unknown as typeof job
  for (const bad of [legacy, weird]) {
    const { job: next, result } = reconcileJob(bad, { aliveSessions: new Set() })
    assert.deepEqual(result.changes, [])
    assert.deepEqual(result.orphans, [])
    assert.equal(typeof next.updated, "string")
  }
})

test("job ids sort by time", () => {
  assert.match(jobId(new Date("2026-10-04T14:30:05Z")), /^job-20261004-143005-[0-9a-f]{1,4}$/)
})

test("the most specific level wins, a node key covers its questions", () => {
  const policies = {
    global: { N6: "rule", "N5.model": "fixed:opencode-go/glm-5.3-flash" },
    job: { "N6.pipeline": "fixed:P1" },
    task: { "N5.model": "ask" },
  }
  assert.deepEqual(resolvePolicy("N6.pipeline", policies), { policy: { kind: "fixed", value: "P1" }, level: "job", key: "N6.pipeline" })
  assert.deepEqual(resolvePolicy("N6.review", policies).policy, { kind: "rule" })
  assert.deepEqual(resolvePolicy("N5.model", policies).policy, { kind: "ask" })
  assert.deepEqual(resolvePolicy("N1.mode", policies), { policy: { kind: "auto" } })
})

test("guards ignore presets above the single decision", () => {
  const policies = { global: { G0: "fixed:no" }, job: { "G0.harmful": "fixed:no" }, decision: { "G0.harmful": "fixed:no" } }
  assert.equal(resolvePolicy("G0.harmful", policies).level, "decision")
  assert.deepEqual(resolvePolicy("G0.injection", { global: { G0: "fixed:no" } }), { policy: { kind: "auto" } })
})

test("config policies are validated", () => {
  assert.deepEqual(validatePolicies({ "N6.pipeline": "fixed:P2", N5: "ask" }), [])
  assert.equal(validatePolicies({ "N6.pipeline": "sometimes", n6: "ask" }).length, 2)
})

test("chat shortcuts become pins", () => {
  assert.deepEqual(matchShortcut("always local"), { level: "job", key: "G0.locality", value: "fixed:local" })
  assert.deepEqual(matchShortcut("T3 use llamaswap/oss-u"), { level: "task", taskId: "T3", key: "N5.model", value: "fixed:llamaswap/oss-u" })
  assert.deepEqual(matchShortcut("Skip review for T2."), { level: "task", taskId: "T2", key: "N6.review", value: "fixed:skip" })
  assert.deepEqual(matchShortcut("pipeline p1"), { level: "job", key: "N6.pipeline", value: "fixed:P1" })
  assert.equal(matchShortcut("please always run locally if you can"), undefined)
})

test("the config's decisions are read and checked", async () => {
  const { parseDecisions } = await import("../src/config.ts")
  assert.deepEqual(parseDecisions('{ // presets\n "decisions": { "N6.pipeline": "fixed:P1" } }'), { "N6.pipeline": "fixed:P1" })
  assert.deepEqual(parseDecisions("{}"), {})
  assert.throws(() => parseDecisions('{ "decisions": { "N6.pipeline": "maybe" } }'))
})
