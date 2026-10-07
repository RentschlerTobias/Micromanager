import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { FINISH_ID, installFinishTool, installTools, planText, TOOL_IDS, type ToolDraft } from "../src/tools.ts"
import { newJob } from "../src/state.ts"
import type { Signal } from "../src/watchdog.ts"

function fakeDraft() {
  const added: Record<string, unknown>[] = []
  const str = { kind: "string" }
  const draft: ToolDraft = {
    get: (id) => (id === "read" ? { input: { fields: { path: str }, mapFields: (f) => ({ mapped: f() }) } } : undefined),
    add: (tool) => added.push(tool),
  }
  return { draft, added, str }
}

const ok = async () => "ok"
// The user's own checkout, the directory the stand-in host below reports: what a worker must never be able to write.
const PROJECT = "/home/t1dde/Fun/Projects/Repos/jev-micromanager"
const noop = { tasks: ok, plan: ok, questions: ok, run: ok, status: ok, stop: ok, steer: ok, stopTask: ok, merge: ok, discard: ok, access: ok }
const byId = (added: Record<string, unknown>[], id: string) => {
  const tool = added.find((t) => t.id === id)!
  return { input: tool.input, run: tool.execute as (a: Record<string, unknown>, c: object) => Promise<{ content: string }> }
}

test("the tools are built from the read tool's schema and refuse other agents", async () => {
  const { draft, added, str } = fakeDraft()
  const calls: string[] = []
  const ids = installTools(draft, {
    ...noop,
    tasks: async (id) => { calls.push(`tasks:${id}`); return "T1 running" },
    plan: async (goal) => { calls.push(`plan:${goal}`); return "planned" },
    questions: async (job, tree) => { calls.push(`questions:${job}:${tree}`); return "asked" },
    status: async () => { throw new Error("boom") },
    stop: async (job) => { calls.push(`stop:${job}`); return "stopping" },
  })
  assert.deepEqual(ids, [...TOOL_IDS])
  assert.deepEqual(byId(added, "plan_job").input, { mapped: { goal: str } })
  const dict = { agent: "micromanager" }
  assert.deepEqual(await byId(added, "list_tasks").run({ id: "T1" }, dict), { content: "T1 running" })
  assert.deepEqual(await byId(added, "plan_job").run({ goal: "add a flag" }, dict), { content: "planned" })
  assert.deepEqual(await byId(added, "plan_questions").run({ job: "job-1", tree: "[]" }, dict), { content: "asked" })
  assert.deepEqual(await byId(added, "run_job").run({ job: "job-1", note: "" }, { agent: "build" }), { content: "Only the micromanager agent may use this tool." })
  assert.deepEqual(await byId(added, "job_status").run({ job: "" }, dict), { content: "failed: boom" })
  assert.deepEqual(await byId(added, "list_tasks").run({ id: "x" }, {}), { content: "Only the micromanager agent may use this tool." })
  assert.deepEqual(await byId(added, "stop_job").run({ job: "" }, dict), { content: "stopping" })
  assert.deepEqual(calls, ["tasks:T1", "plan:add a flag", "questions:job-1:[]", "stop:"])
  assert.throws(() => installTools({ get: () => undefined, add: () => {} }, noop))
})

test("every control a run lacked is installed, and only the micromanager may call it", async () => {
  const { draft, added, str } = fakeDraft()
  const calls: string[] = []
  const ids = installTools(draft, {
    ...noop,
    steer: async (id, text) => { calls.push(`steer:${id}:${text}`); return "noted" },
    stopTask: async (id) => { calls.push(`stopTask:${id}`); return "cancelled" },
    merge: async (job, ack) => { calls.push(`merge:${job}:${ack}`); return "merged" },
    discard: async (job, ack) => { calls.push(`discard:${job}:${ack}`); return "deleted" },
    access: async (path, why) => { calls.push(`access:${path}:${why}`); return "vouched" },
  }, "micromanager", (id) => id === "ses_worker")
  // The five controls a live run could not do: the merge had to be typed by hand at the shell.
  for (const id of ["steer_task", "stop_task", "merge_job", "discard_job", "request_access"]) assert.ok(ids.includes(id as typeof TOOL_IDS[number]), id)
  assert.deepEqual(byId(added, "steer_task").input, { mapped: { id: str, text: str } })
  assert.deepEqual(byId(added, "merge_job").input, { mapped: { job: str, ack: str } })
  assert.deepEqual(byId(added, "request_access").input, { mapped: { path: str, why: str } })
  const dict = { agent: "micromanager" }
  assert.deepEqual(await byId(added, "steer_task").run({ id: "T1", text: "skip the docs" }, dict), { content: "noted" })
  assert.deepEqual(await byId(added, "stop_task").run({ id: "T1" }, dict), { content: "cancelled" })
  assert.deepEqual(await byId(added, "merge_job").run({ job: "job-1", ack: "do it" }, dict), { content: "merged" })
  assert.deepEqual(await byId(added, "discard_job").run({ job: "job-1", ack: "" }, dict), { content: "deleted" })
  assert.deepEqual(await byId(added, "request_access").run({ path: "/home/t1dde/Repos/oc-voice", why: "to read it" }, dict), { content: "vouched" })
  // Every other agent is refused, and so is a session the runner started posing as the micromanager.
  for (const [id, args] of [["steer_task", { id: "T1", text: "x" }], ["stop_task", { id: "T1" }], ["merge_job", { job: "j", ack: "" }], ["discard_job", { job: "j", ack: "" }], ["request_access", { path: "/x", why: "y" }]] as const) {
    assert.deepEqual(await byId(added, id).run(args, { agent: "coder" }), { content: "Only the micromanager agent may use this tool." }, id)
    assert.deepEqual(await byId(added, id).run(args, { agent: "micromanager", sessionID: "ses_worker" }), { content: "Only the micromanager agent may use this tool." }, id)
  }
  assert.deepEqual(calls, ["steer:T1:skip the docs", "stopTask:T1", "merge:job-1:do it", "discard:job-1:", "access:/home/t1dde/Repos/oc-voice:to read it"])
})

test("finish_task is for the micromanager's writers only", async () => {
  const { draft, added, str } = fakeDraft()
  const summaries: string[] = []
  installFinishTool(draft, async (summary, ctx) => { summaries.push(`${ctx.sessionID}:${summary}`); return "merged" }, (id) => id === "ses_writer")
  assert.deepEqual(byId(added, FINISH_ID).input, { mapped: { summary: str } })
  const run = byId(added, FINISH_ID).run
  assert.deepEqual(await run({ summary: "added x" }, { agent: "coder", sessionID: "ses_writer" }), { content: "merged" })
  assert.deepEqual(await run({ summary: "added x" }, { agent: "micromanager", sessionID: "ses_user" }), { content: "Only a worker that changes files for the micromanager may use this tool." })
  assert.deepEqual(summaries, ["ses_writer:added x"])
  assert.ok(!(TOOL_IDS as readonly string[]).includes(FINISH_ID), "the micromanager's tool list does not carry it")
})

test("a session the runner started is refused even as the micromanager agent", async () => {
  const { draft, added } = fakeDraft()
  const ran: string[] = []
  installTools(draft, { ...noop, run: async (job) => { ran.push(job); return "ran" } }, "micromanager", (id) => id === "ses_worker")
  const run = byId(added, "run_job").run
  assert.deepEqual(await run({ job: "job-1" }, { agent: "micromanager", sessionID: "ses_worker" }), { content: "Only the micromanager agent may use this tool." })
  assert.deepEqual(await run({ job: "job-1" }, { agent: "micromanager", sessionID: "ses_user" }), { content: "ran" })
  assert.deepEqual(ran, ["job-1"])
})

test("the plan text lists acceptance points and tasks", () => {
  const job = newJob("job-1", "add a flag")
  job.acceptance = [{ id: "A1", text: "flag works", verify: "npm test" }]
  job.tasks = [{ id: "T1", title: "add flag", description: "", role: "code", acceptance: ["A1"], dependsOn: [], files: ["cli.js"], wave: 0, status: "pending", attempts: 0, stages: [], signatures: [] }]
  const text = planText(job)
  assert.match(text, /- A1: flag works \(check: npm test\)/)
  assert.match(text, /- T1 \[code\] add flag\n  files: cli.js\n  covers: A1/)
})

test("a nudge from the watchdog is recorded and nothing else; a stop and a bare signal both interrupt", async () => {
  const { applySignal } = await import("../src/plugin.ts")
  const run = (signal: Signal) => {
    const stops = new Map<string, Signal>()
    const unwatched: string[] = []
    const interrupted: string[] = []
    const recorded: Record<string, unknown>[] = []
    const deps = { stops, record: (e: Record<string, unknown>) => { recorded.push(e) }, unwatch: (id: string) => { unwatched.push(id) }, interrupt: (id: string) => { interrupted.push(id) } }
    const what = applySignal("ses_1", signal, deps)
    return { what, stops, unwatched, interrupted, recorded }
  }
  const nudge = run({ kind: "read_loop", severity: "nudge", detail: "read a.ts 3x in a row" })
  assert.equal(nudge.what, "nudged")
  assert.deepEqual(nudge.interrupted, [], "a nudge must not cut a healthy session")
  assert.deepEqual(nudge.unwatched, [], "and it keeps its watchdog state")
  assert.deepEqual([...nudge.stops], [], "and it is not a stop")
  assert.deepEqual(nudge.recorded, [{ kind: "watchdog", sessionID: "ses_1", signal: "read_loop", severity: "nudge", detail: "read a.ts 3x in a row" }])
  // The absent field keeps what every signal had before the field existed: a stop.
  for (const signal of [{ kind: "steps" as const, detail: "over the limit" }, { kind: "steps" as const, severity: "stop" as const, detail: "over the limit" }]) {
    const stopped = run(signal)
    assert.equal(stopped.what, "stopped", JSON.stringify(signal))
    assert.deepEqual(stopped.interrupted, ["ses_1"])
    assert.deepEqual(stopped.unwatched, ["ses_1"])
    assert.equal(stopped.stops.get("ses_1"), signal)
    assert.equal(stopped.recorded[0]?.severity, undefined)
  }
  // A nudge does not consume the stop that follows it: a session may still be stopped later.
  const stops = new Map<string, Signal>()
  const interrupted: string[] = []
  const deps = { stops, record: () => {}, unwatch: () => {}, interrupt: (id: string) => { interrupted.push(id) } }
  applySignal("ses_1", { kind: "monologue", severity: "nudge", detail: "3 replies" }, deps)
  assert.equal(applySignal("ses_1", { kind: "steps", detail: "over" }, deps), "stopped")
  assert.deepEqual(interrupted, ["ses_1"])
  assert.equal(applySignal("ses_1", { kind: "steps", detail: "over" }, deps), "already", "a stop is not repeated")
})

test("a reader may read outside the project only in a directory its task names", async () => {
  const { namedInTask } = await import("../src/plugin.ts")
  const task = "T2 Map oc-voice fluency: read /home/t1dde/Fun/Projects/Repos/oc-voice/voice/loop.py and the README in /home/t1dde/Fun/Projects/Repos/oc-voice"
  assert.equal(namedInTask(task, ["/home/t1dde/Fun/Projects/Repos/oc-voice/*"]), true)
  assert.equal(namedInTask(task, ["/home/t1dde/Fun/Projects/Repos/oc-voice/voice/*"]), true)
  assert.equal(namedInTask(task, ["/home/t1dde/.ssh/*"]), false)
  assert.equal(namedInTask(task, ["/home/t1dde/Fun/Projects/Repos/oc-voice-secrets/*"]), false)
  assert.equal(namedInTask("no paths here", ["/home/t1dde/x/*"]), false)
  assert.equal(namedInTask("read /home/t1dde/Repos/a/src/main.py", ["/home/t1dde/Repos/a/src/*"]), true, "a named file opens its directory")
})

// --- the behaviour behind the new controls (src/plugin.ts) ------------------------------------------------

const task = (over: Partial<import("../src/state.ts").Task> = {}): import("../src/state.ts").Task =>
  ({ id: "T1", title: "add a flag", description: "", role: "code", acceptance: [], dependsOn: [], files: ["cli.ts"], wave: 0, status: "running", attempts: 1, stages: [], signatures: [], ...over })

const job = (over: Partial<import("../src/state.ts").Job> = {}): import("../src/state.ts").Job => {
  const j = newJob("job-1", "add a flag")
  j.tasks = [task()]
  return Object.assign(j, over)
}

// A repository with a job branch and its worktree, exactly as the plugin leaves one behind: the plugin's own directory
// is kept out of git through the repository's local exclude file (src/store.ts excludeFromGit), so it does not show up
// as uncommitted work in the user's checkout.
function repo(): { project: string; branch: string } {
  const project = mkdtempSync(join(tmpdir(), "jd-merge-"))
  const git = (...args: string[]) => execFileSync("git", ["-C", project, ...args], { encoding: "utf8" })
  git("init", "-q")
  writeFileSync(join(project, "a.txt"), "a\n")
  git("add", "-A")
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
  const branch = "jev/job-1"
  const wt = join(project, ".jev-micromanager", "worktrees", "job-1")
  git("worktree", "add", "-q", "-b", branch, wt, "HEAD")
  writeFileSync(join(wt, "b.txt"), "b\n")
  execFileSync("git", ["-C", wt, "add", "-A"])
  execFileSync("git", ["-C", wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "T1: add a flag"])
  writeFileSync(join(project, ".git", "info", "exclude"), ".jev-micromanager/\n")
  return { project, branch }
}

const head = (dir: string) => execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim()
const log = (dir: string) => execFileSync("git", ["-C", dir, "log", "--oneline", "-1"], { encoding: "utf8" }).trim()

test("steer_task on a running worker notes it; on a finished one it says how to continue it", async () => {
  const { steerTask } = await import("../src/plugin.ts")
  const running = steerTask(task({ session: "ses_live" }), "ses_live", true, "skip the docs, test only")
  assert.match(running.note ?? "", /skip the docs, test only/)
  assert.match(running.text, /next turn/)
  // The finished case is the one the live run hit: the note must not pretend to steer a session that is gone, and the
  // session id is what gets it back.
  const ended = steerTask(task({ status: "cancelled", session: "ses_dead", worktree: "/wt/T1" }), "ses_dead", false, "finish it")
  assert.equal(ended.note, undefined)
  assert.match(ended.text, /not running any more/)
  assert.match(ended.text, /subagent tool and sessionID ses_dead/)
  assert.match(ended.text, /\/wt\/T1/)
  assert.match(steerTask(task({ session: "ses_live" }), "ses_live", true, "  ").text, /needs text/)
  assert.match(steerTask(task(), undefined, false, "x").text, /no worker session/)
})

test("stop_task keeps the worktree and says where the work is", async () => {
  const { stopTaskAnswer } = await import("../src/plugin.ts")
  const text = stopTaskAnswer(task({ worktree: "/wt/T1", branch: "jev/job-1--T1", session: "ses_live" }), "job-1", "ses_live", ["T2 add docs"])
  assert.match(text, /cancelled/)
  assert.match(text, /\/wt\/T1/, "the worktree's path is named")
  assert.match(text, /jev\/job-1--T1/)
  assert.match(text, /T2 add docs/, "the rest of the job is named")
  assert.doesNotMatch(text, /\b(deleted|removed|discarded)\b/i, "stopping a task never removes what it wrote")
  assert.match(stopTaskAnswer(task({ worktree: undefined, branch: undefined }), "job-1", undefined, []), /no worktree of its own/)
  assert.match(stopTaskAnswer(task({ worktree: "/wt/T1" }), "job-1", "ses_live", []), /the last open task of job job-1/)
})

test("merge_job refuses a checkout with uncommitted changes and writes nothing", async () => {
  const { mergeJobInto } = await import("../src/plugin.ts")
  const { project, branch } = repo()
  const j = job({ integrationBranch: branch, tasks: [task({ status: "merged" })] })
  writeFileSync(join(project, "dirty.txt"), "mine\n")
  const before = head(project)
  const out = await mergeJobInto(project, j, "")
  assert.equal(out.wrote, false)
  assert.match(out.text, /^Not merged: the checkout has uncommitted changes/)
  assert.match(out.text, /dirty\.txt/)
  assert.equal(head(project), before, "HEAD did not move")
  assert.match(log(project), /init/, "no commit of the job's work landed")
  assert.equal(existsSync(join(project, "dirty.txt")), true, "the untracked file is untouched")
})

test("merge_job refuses a non-fast-forward and leaves the checkout exactly as it was", async () => {
  const { mergeJobInto } = await import("../src/plugin.ts")
  const { project, branch } = repo()
  // The user commits on their own branch, so the job branch can no longer be fast-forwarded.
  writeFileSync(join(project, "a.txt"), "a\nmine\n")
  execFileSync("git", ["-C", project, "add", "-A"])
  execFileSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "user work"])
  const j = job({ integrationBranch: branch, tasks: [task({ status: "merged" })] })
  const before = head(project)
  const out = await mergeJobInto(project, j, "yes, the user said go")
  assert.equal(out.wrote, false)
  assert.match(out.text, /^Not merged: .*cannot be fast-forwarded/)
  assert.match(out.text, /exactly as it was/)
  assert.equal(head(project), before, "HEAD did not move")
  assert.equal(existsSync(join(project, ".jev-micromanager", "worktrees", "job-1", "b.txt")), true, "the job's work is still there")
})

test("merge_job shows what would land, refuses unfinished work without the user's words, and fast-forwards with them", async () => {
  const { mergeJobInto } = await import("../src/plugin.ts")
  const { project, branch } = repo()
  const j = job({ integrationBranch: branch })
  const before = head(project)
  const shown = await mergeJobInto(project, j, "")
  assert.equal(shown.wrote, false)
  assert.match(shown.text, /would land in the checkout/)
  assert.match(shown.text, /T1: add a flag/)
  assert.match(shown.text, /T1 add a flag: running/, "the unfinished task is named")
  assert.equal(head(project), before, "nothing was written without the acknowledgement")
  const merged = await mergeJobInto(project, j, "the user said: the rest is not needed")
  assert.equal(merged.wrote, true)
  assert.match(merged.text, /Merged jev\/job-1 into the checkout \(fast-forward\)/)
  assert.equal(existsSync(join(project, "b.txt")), true, "the job's file is in the checkout")
  assert.match(merged.text, /discard_job gives them back to git/)
  // A branch the checkout already has: nothing to do, and still nothing written.
  assert.match((await mergeJobInto(project, j, "")).text, /nothing the checkout does not have already/)
})

test("discard_job lists what it would delete, and deletes nothing without the user's words", async () => {
  const { discardJob } = await import("../src/plugin.ts")
  const { project, branch } = repo()
  const wt = join(project, ".jev-micromanager", "worktrees", "job-1")
  const j = job({ integrationBranch: branch, integrationWorktree: wt })
  const out = await discardJob(project, j, "")
  assert.equal(out.wrote, false)
  assert.match(out.text, /would delete exactly this/)
  assert.match(out.text, new RegExp(wt.replace(/\//g, "\\/")))
  assert.match(out.text, new RegExp(branch.replace(/\//g, "\\/")))
  assert.match(out.text, /your checkout is not touched/)
  assert.match(out.text, /Nothing was deleted/)
  assert.equal(existsSync(wt), true, "the worktree is still registered")
  assert.equal(existsSync(join(project, "a.txt")), true, "the checkout's file is untouched")
  assert.match((await discardJob(project, job(), "")).text, /no worktree and no branch left/)
})

test("discard_job removes the worktree and the branch, and never the checkout", async () => {
  const { discardJob } = await import("../src/plugin.ts")
  const { project, branch } = repo()
  const wt = join(project, ".jev-micromanager", "worktrees", "job-1")
  const out = await discardJob(project, job({ integrationBranch: branch, integrationWorktree: wt }), "the user said: throw it away")
  assert.equal(out.wrote, true)
  assert.match(out.text, /Deleted:/)
  assert.equal(existsSync(wt), false, "the worktree is gone")
  assert.equal(existsSync(join(project, "a.txt")), true, "the checkout's file is still there")
  assert.match(execFileSync("git", ["-C", project, "status", "--porcelain"], { encoding: "utf8" }), /^$/m)
  const branches = execFileSync("git", ["-C", project, "branch", "--list", branch], { encoding: "utf8" })
  assert.doesNotMatch(branches, new RegExp(branch.replace(/\//g, "\\/")), "the branch is gone")
  assert.match(out.text, /The checkout and every file in it were not touched/)
})

// The plugin's sweep at a job load: what reconcileJob does with the sessions the plugin can see, and what it reports
// for worktrees and branches that outlived their task. The live-run defect: a worker that died without handing off
// left its task at `running`, so the board said the job was running days after it ended.
test("a job load sweeps a stale task to a terminal state and reports the leftovers, once", async () => {
  const { reconcileJob } = await import("../src/store.ts")
  const live = new Set(["ses_live"])
  const j = job({ tasks: [task({ id: "T1", session: "ses_dead" }), task({ id: "T2", session: "ses_live" }), task({ id: "T3", status: "merged", worktree: "/wt/T3", branch: "jev/job-1--T3" })] })
  const { job: next, result } = reconcileJob(j, { aliveSessions: live })
  assert.deepEqual(result.changes.map((c) => [c.taskId, c.from, c.to]), [["T1", "running", "cancelled"]])
  assert.equal(next.tasks.find((t) => t.id === "T2")?.status, "running", "a live worker is never touched")
  assert.equal(next.tasks.find((t) => t.id === "T1")?.attempts, 2)
  assert.deepEqual(result.orphans.map((o) => o.worktree), ["/wt/T3"], "a leftover worktree is reported, not deleted")
  assert.equal(j.tasks[0]?.status, "running", "the job the caller still holds is not changed")
  // Sweeping the swept job changes nothing: the reconciliation is idempotent, so a load cannot drift.
  assert.deepEqual(reconcileJob(next, { aliveSessions: live }).result.changes, [])
})

test("request_access asks the user about a refused path rather than answering for them, and vouches for an ordinary one", async () => {
  const { vouchAccess, vouchText } = await import("../src/plugin.ts")
  const j = job()
  const PROJECT = "/home/t1dde/Fun/Projects/Repos/jev-micromanager"
  // ~/.ssh is layer 1 of decide.ts: no layer may pass it, and a vouch from the orchestrator is not a layer above that.
  // What changed is not the rule but who answers it: the tool used to refuse, which meant the one place built to ask
  // the user was the one place that never did. It now puts the question to them, with the path and the reason.
  const denied = vouchAccess(PROJECT, j, "~/.ssh/id_rsa", "the deploy needs the key to run the tests")
  assert.equal(denied.vouched, false, "a vouch still cannot open a refused path")
  assert.match(denied.text, /only you can open it/)
  assert.match(denied.text, /Path: ~\/\.ssh\/id_rsa/)
  assert.match(denied.text, /the deploy needs the key to run the tests/, "the reason the worker gave travels with it")
  assert.match(denied.text, /the user's keys in ~\/\.ssh/, "and what the rule protects, so the user can answer")
  assert.match(denied.text, /Answer "yes".*Answer "no"/s)
  assert.equal(vouchText(j), undefined, "nothing was recorded: the user has not answered yet")
  assert.equal(vouchAccess(PROJECT, j, "~/.aws/credentials", "read the credentials").vouched, false)
  assert.equal(vouchAccess(PROJECT, j, "/etc/hosts", "check the hosts file").vouched, false)
  assert.equal(vouchAccess(PROJECT, j, "~", "the whole home directory").vouched, false)
  // A path no layer refuses, outside the project: the vouch is recorded and travels as the task the decision path reads.
  const ok = vouchAccess(PROJECT, j, "/home/t1dde/Fun/Projects/Repos/oc-voice", "T2 must read that repository's voice/loop.py")
  assert.equal(ok.vouched, true)
  assert.match(vouchText(j) ?? "", /oc-voice/)
  assert.match(vouchText(j) ?? "", /loop\.py/, "the reason travels with the vouch")
  // Inside the project, and in the job's own worktrees, there is nothing to vouch for.
  assert.match(vouchAccess("/proj", j, "/proj/src", "read it").text, /inside the project/)
  assert.match(vouchAccess("/proj", j, "/proj/.jev-micromanager/worktrees/job-1", "its worktree").text, /inside the project/)
  assert.match(vouchAccess("/proj", j, "", "x").text, /needs path/)
  assert.match(vouchAccess("/proj", j, "/somewhere", "  ").text, /needs why/)
  assert.match(vouchAccess("/proj", undefined, "/somewhere", "x").text, /No job of this session/)
})

// The plugin loaded against a stand-in OpenCode host, so the things an operator has to check after a restart are
// checked here: the setup record that says the plugin is loaded and what it thinks it is doing, and the backstop that
// stops an unisolated delegation from writing. The journal is the only channel that persists on this host (logger()
// in src/plugin.ts explains why), so the test reads the journal rather than any log.
//
// XDG_STATE_HOME is redirected for the whole test, not just the setup call: the plugin records from the hooks long
// after setup has returned, and a test that let those records land in the operator's real journal would be worse than
// no test at all.
async function loadedPlugin(t: { after(fn: () => void): void }, sessions: Record<string, Record<string, unknown>>) {
  const { mkdtempSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { readJournal } = await import("../src/journal.ts")
  const plugin = (await import("../src/plugin.ts")).default
  const hooks: Record<string, ((arg: never) => Promise<void>)[]> = {}
  const noop = async () => undefined
  const draft = { list: () => [], get: () => undefined, namespace: () => {}, add: () => {}, update: () => {}, remove: () => {} }
  const take = (n: string) => hooks[n]?.[0] as ((arg: never) => Promise<void>) | undefined
  const ctx = {
    location: { directory: PROJECT },
    app: {}, // the real context carries no log method on this host, which is the point
    agent: { transform: async (cb: (d: unknown) => void) => cb(draft) },
    tool: { hook: async (n: string, cb: (a: never) => Promise<void>) => { (hooks[n] ??= []).push(cb) }, transform: async (cb: (d: unknown) => void) => cb(draft) },
    permission: { hook: async (n: string, cb: (a: never) => Promise<void>) => { (hooks[`perm:${n}`] ??= []).push(cb) } },
    session: {
      hook: async (n: string, cb: (a: never) => Promise<void>) => { (hooks[`sess:${n}`] ??= []).push(cb) },
      get: async ({ sessionID }: { sessionID: string }) => sessions[sessionID],
      synthetic: noop, move: noop, create: noop, prompt: noop, wait: noop, context: noop, interrupt: noop,
    },
  }
  const before = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = mkdtempSync(`${tmpdir()}/jev-setup-`)
  // The stand-in host has no built-in read tool, so setup reports that it installed nothing. That is the expected
  // answer here, and it proves the logger's stderr fallback is live, but it is noise in a test run: the journal is
  // what these tests read.
  const stderr = console.error
  console.error = () => {}
  t.after(() => {
    console.error = stderr
    if (before === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = before
  })
  await plugin.setup(ctx as never)
  const journal = () => readJournal(`${process.env.XDG_STATE_HOME}/jev-micromanager/decisions.jsonl`)
  const evaluate = take("perm:evaluate")!
  const run = async (sessionID: string, agent: string, action: string) => {
    const e = { sessionID, agent, action, resources: ["x"], effect: "allow", message: undefined as string | undefined }
    await evaluate(e as never)
    return e
  }
  return { journal, run, evaluate, delegationHook: take("execute.before")! }
}

test("the plugin says it is loaded, and what it thinks it is doing", async (t) => {
  const { journal } = await loadedPlugin(t, {})
  const setup = journal().find((e) => e.kind === "plugin")!
  assert.equal(setup.version, "0.1.0", "the version comes from package.json, so it cannot drift from the manifest")
  assert.equal(setup.directory, PROJECT)
  assert.equal(setup.repository, PROJECT, "the repository root this project sits in")
  assert.equal(setup.rel, "", "the project's offset inside it")
  assert.equal(setup.micromanager, "micromanager")
  // The tool names the delegation hook recognises: an operator can read off the journal what it is looking at.
  assert.deepEqual(setup.delegationTools, ["subagent"])
  assert.ok(Array.isArray(setup.delegationAgents) && setup.delegationAgents.includes("coder"))
  assert.equal(journal()[0]?.kind, "plugin", "it is the first thing written, before any job or delegation exists")
})

test("a child of a micromanager session that no worktree got is denied its writes and written down", async (t) => {
  const micro = { agent: "micromanager", location: { directory: PROJECT } }
  const { journal, run } = await loadedPlugin(t, {
    ses_micro: micro,
    // The live run's shape: a child of the micromanager session with no task, no worktree and no claim.
    ses_child: { parentID: "ses_micro", agent: "coder", location: { directory: PROJECT } },
    // And the case that must not regress: a role agent the user picked by hand, in their own checkout.
    ses_user: { agent: "build", location: { directory: PROJECT } },
    ses_byhand: { parentID: "ses_user", agent: "coder", location: { directory: PROJECT } },
  })
  const denied = await run("ses_child", "coder", "shell")
  assert.equal(denied.effect, "deny")
  assert.match(denied.message ?? "", /never put you in a worktree/)
  assert.match(denied.message ?? "", /STATUS: NEEDS_CONTEXT/)
  const entry = journal().find((e) => e.kind === "isolation-denied")!
  assert.equal(entry.sessionID, "ses_child")
  assert.equal(entry.parent, "ses_micro")
  assert.equal(entry.directory, PROJECT)
  assert.equal(entry.action, "shell")
  assert.match(String(entry.reason), /isolation did not engage/)
  assert.match(String(entry.reason), /not a claimed worker/, "greppable, and it says which rule fired")
  // A read cannot damage the checkout, and a role agent picked by hand is not a delegated child: both keep working.
  assert.equal((await run("ses_child", "coder", "read")).effect, "allow")
  assert.equal((await run("ses_byhand", "coder", "shell")).effect, "allow")
  assert.equal((await run("ses_user", "build", "shell")).effect, "allow")
  assert.equal(journal().filter((e) => e.kind === "isolation-denied").length, 1, "one alarm per session, not one per tool call")
})

test("a delegation the hook cannot route is written down, and one that merely says subagent is not touched", async (t) => {
  const { journal, delegationHook } = await loadedPlugin(t, { ses_micro: { agent: "micromanager" } })
  // A built-in agent, aimed by an agent the plugin does not own: left exactly as its caller wrote it, and recorded,
  // because a delegation that reaches neither the routing nor a refusal is how a live run wrote into the checkout.
  const builtIn = { tool: "subagent", agent: "build", sessionID: "ses_micro", input: { agent: "explore", prompt: "look around" } }
  await delegationHook(builtIn as never)
  assert.deepEqual(builtIn.input, { agent: "explore", prompt: "look around" }, "the call is not touched")
  const entry = journal().find((e) => e.kind === "delegation-unrecognised")!
  assert.equal(entry.tool, "subagent")
  assert.equal(entry.requested, "explore")
  assert.equal(entry.agent, "build")
  assert.match(String(entry.reason), /not a role agent of this plugin/)
  // A call that merely mentions a subagent is not a delegation: nothing is recorded and nothing is hijacked.
  const mentions = { tool: "shell", agent: "build", sessionID: "ses_micro", input: { command: "grep -rn subagent src/" } }
  await delegationHook(mentions as never)
  assert.equal(mentions.input.command, "grep -rn subagent src/")
  assert.equal(journal().filter((e) => e.kind === "delegation-unrecognised").length, 1)
})

// The live defect the pairing exists for (2026-10-07): a `shell` record read "allowed" at 10:30:42 and the
// external_directory records over the same path read "denied" at 10:30:44 and 10:30:51 — one command, three lines,
// and no field to say they belonged together. opencode's evaluate payload carries the call under `source`
// ({type:"tool", messageID, id}, read in the bundled server), so the record keeps it.
test("a permission record names the tool call it belongs to", async (t) => {
  // The user's preset answers the ask before any model: this test is about pairing, and no Jev key is wanted here.
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const config = mkdtempSync(`${tmpdir()}/jev-config-`)
  mkdirSync(`${config}/opencode`, { recursive: true })
  writeFileSync(`${config}/opencode/jev-micromanager.jsonc`, JSON.stringify({ decisions: { "N13.shell": "fixed:allow" } }))
  const before = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = config
  t.after(() => { if (before === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = before })
  const { journal, evaluate } = await loadedPlugin(t, {})
  const asked = { sessionID: "ses_mm", agent: "micromanager", action: "shell", resources: ["git -C . log --oneline"], effect: "ask", message: undefined as string | undefined, source: { type: "tool", messageID: "msg_01", id: "call_01" } }
  await evaluate(asked as never)
  assert.equal(asked.effect, "allow", "the preset answered it")
  const entry = journal().find((e) => e.kind === "permission" && e.sessionID === "ses_mm")!
  assert.equal(entry.verdict, "allow")
  const source = entry.source as { type: string; messageID?: string; id?: string }
  assert.equal(source.id, "call_01", "the call id the two legs share")
  assert.equal(source.messageID, "msg_01")
  // An ask without a call context records nothing it never had: the field is dropped rather than invented.
  const bare = { sessionID: "ses_mm2", agent: "micromanager", action: "shell", resources: ["ls"], effect: "ask", message: undefined as string | undefined }
  await evaluate(bare as never)
  const bareEntry = journal().find((e) => e.kind === "permission" && e.sessionID === "ses_mm2")!
  assert.ok(bareEntry.source === undefined, "no call id, no invented one")
})

// Both orders the live run showed are paired: the command that ran first, and the refusal that came first. Each
// path rings once per session — the alarm that repeats every tool call is the one nobody reads.
test("a refused path and the call that ran anyway land in one permission-not-enforced record", async () => {
  const { legPairs } = await import("../src/plugin.ts")
  const lines: Record<string, unknown>[] = []
  const loud: unknown[] = []
  const legs = legPairs((e) => lines.push(e), (_level, message) => { loud.push(message) })
  // The command ran, the refusal came after: the pairing says what ran and under which call it was asked.
  legs.allowed("ses_w", "shell", ["git -C /home/u/.config/omarchy status --short"], 1000, { type: "tool", messageID: "msg_a", id: "call_a" })
  legs.refused("ses_w", ["/home/u/.config/*"], "a hard-denied path (~/.config/opencode/auth.json)", { type: "tool", messageID: "msg_b", id: "call_b" })
  const ranFirst = lines[0]!
  assert.equal(ranFirst.kind, "permission-not-enforced")
  assert.equal(ranFirst.sessionID, "ses_w")
  assert.equal(ranFirst.action, "shell")
  assert.match(String(ranFirst.refusal), /hard-denied/)
  const allowedSource = ranFirst.allowedSource as { messageID?: string; id?: string }
  const deniedSource = ranFirst.deniedSource as { messageID?: string; id?: string }
  assert.equal(allowedSource.messageID, "msg_a", "both legs' ids, whatever itself was denied")
  assert.equal(deniedSource.messageID, "msg_b")
  assert.match(String(loud[0]), /permission not enforced/, "fail loud, like the isolation backstop")
  // The refusal came first, the command ran after: the same record, the other way round.
  legs.refused("ses_v", ["/etc/*"], "always the user: /etc", { type: "tool", messageID: "msg_c", id: "call_c" })
  legs.allowed("ses_v", "shell", ["cat /etc/hosts"], 2000, { type: "tool", messageID: "msg_d", id: "call_d" })
  const refusedFirst = lines[1]!
  assert.match(String(refusedFirst.command), /cat \/etc\/hosts/)
  // A path that has already rung once stays silent the second time it is hit in the same session.
  legs.allowed("ses_v", "shell", ["cat /etc/hosts"], 3000, undefined)
  legs.refused("ses_v", ["/etc/*"], "always the user: /etc", undefined)
  assert.equal(lines.length, 2, "one alarm per path and session")
  // An ask without ids is still paired, on the path in the command text, and records no invented ids.
  legs.refused("ses_n", ["/etc/*"], "always the user: /etc", undefined)
  legs.allowed("ses_n", "shell", ["ls /etc/hosts"], 4000, undefined)
  const bare = lines[2]!
  assert.equal(bare.kind, "permission-not-enforced")
  assert.ok(!("deniedSource" in bare) && !("allowedSource" in bare), "no id was carried, so none is claimed")
})
