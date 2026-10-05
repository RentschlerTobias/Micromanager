import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { matchShortcut, resolvePolicy, validatePolicies } from "../src/policy.ts"
import { newJob } from "../src/state.ts"
import { excludeFromGit, jobId, listJobs, loadJob, saveJob, saveNote } from "../src/store.ts"

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
  assert.equal(excludeFromGit(project), false)
  execFileSync("git", ["init", "-q", project])
  assert.equal(excludeFromGit(project), true)
  assert.equal(excludeFromGit(project), true)
  const lines = readFileSync(join(project, ".git", "info", "exclude"), "utf8").split("\n")
  assert.equal(lines.filter((l) => l === ".jev-micromanager/").length, 1)
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
