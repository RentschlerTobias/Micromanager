import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { CHILD_PREFIX, DelegationError, Native, parseDelegation } from "../src/native.ts"
import { loadJob } from "../src/store.ts"

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "jd-native-"))
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args])
  git("init", "-q")
  writeFileSync(join(dir, "README.md"), "demo\n")
  git("add", "-A")
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
  return dir
}

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args]).toString().trim()
const MODEL = "opencode-go/glm-5.3-flash"

// What OpenCode's subagent tool sends as the child's first prompt.
const child = (brief: string) => `${CHILD_PREFIX}\n${brief}`

test("the Files and Checks lines are read off the prompt", () => {
  const d = parseDelegation("Add a --verbose flag to cli.js.\nKeep the help text.\n\nFiles: cli.js, test/cli.test.js\nChecks:\nnpm test\n- node --test test/cli.test.js")
  assert.equal(d.body, "Add a --verbose flag to cli.js.\nKeep the help text.")
  assert.equal(d.files, "cli.js, test/cli.test.js")
  assert.deepEqual(d.checks, ["npm test", "node --test test/cli.test.js"])
  assert.deepEqual(parseDelegation("Checks: test -f a.js\nFiles: a.js").checks, ["test -f a.js"])
  assert.deepEqual(parseDelegation("Where is the router?"), { body: "Where is the router?", files: "", checks: [] })
})

test("a writer works in its own worktree; failing checks go back to it, passing ones merge", async () => {
  const project = repo()
  const native = new Native()
  const d = await native.delegate(project, "ses_mm", { agent: "coder", description: "add add.js", prompt: "Create add.js.\nFiles: add.js\nChecks: grep -q add add.js" }, MODEL)
  assert.equal(d.task.id, "T1")
  assert.equal(d.task.status, "running")
  assert.match(d.prompt, /^\[jev-micromanager\] task T1 · job job-\S+ · role code · model opencode-go\/glm-5.3-flash\n\nCreate add.js\./)
  assert.match(d.prompt, /Files you may change: add\.js/)
  assert.match(d.prompt, /Checks the plugin runs when you finish: grep -q add add\.js/)
  assert.match(d.prompt, /call finish_task/)
  assert.doesNotMatch(d.prompt, /^Files:/m)

  assert.equal(native.claim("ses_w1", d.prompt), undefined, "only a child's first prompt claims")
  const claimed = native.claim("ses_w1", child(d.prompt))!
  assert.equal(claimed.dir, join(project, ".jev-micromanager", "worktrees", `${d.job.id}--T1`))
  assert.equal(claimed.parent, "ses_mm")
  assert.equal(git(claimed.dir, "branch", "--show-current"), `jev/${d.job.id}--T1`)
  assert.equal(native.claim("ses_w2", child(d.prompt)), undefined, "a task is claimed once")
  assert.ok(native.isWriter("ses_w1"))

  writeFileSync(join(claimed.dir, "add.js"), "export const sum = 1\n")
  const red = await native.finish("ses_w1", "wrote add.js")
  assert.match(red.text, /The checks fail in your directory\. Fix them, then call finish_task again:\n\$ grep -q add add\.js \(exit 1\)/)
  assert.equal(red.note, undefined)

  writeFileSync(join(claimed.dir, "add.js"), "export const add = (a, b) => a + b\n")
  const green = await native.finish("ses_w1", "wrote add.js")
  assert.match(green.text, new RegExp(`^Merged into jev/${d.job.id} as [0-9a-f]+; checks passed: grep -q add add\\.js\\. Now end with your short report\\.$`))
  assert.match(green.note!, /^\[jev-micromanager\] T1 add add\.js: merged into jev\/\S+ \([0-9a-f]+\); checks passed/)
  assert.equal(green.parent, "ses_mm")
  assert.equal(readFileSync(join(d.job.integrationWorktree!, "add.js"), "utf8"), "export const add = (a, b) => a + b\n")
  assert.ok(!existsSync(join(project, "add.js")), "the user's checkout is untouched")

  // The worker's run ends: its worktree goes, the task stays merged.
  const end = await native.ended("ses_w1")
  assert.deepEqual(end, { note: undefined, parent: "ses_mm" })
  assert.ok(!existsSync(claimed.dir))
  const saved = loadJob(project, d.job.id)!
  assert.equal(saved.tasks[0]!.status, "merged")
  assert.equal(saved.tasks[0]!.session, "ses_w1")
  assert.deepEqual(saved.tasks[0]!.stages.map((s) => `${s.stage}:${s.result}`), ["delegate:pass", "gate:fail", "gate:pass", "merge:pass"])
})

test("two writers run side by side; the second is rebased onto the first and checked again", async () => {
  const project = repo()
  const native = new Native()
  // Both calls of one message arrive at once, before the session branch exists.
  const [a, b] = await Promise.all([
    native.delegate(project, "ses_mm", { agent: "coder", description: "a", prompt: "Write a.js.\nFiles: a.js\nChecks: test -f a.js" }, MODEL),
    native.delegate(project, "ses_mm", { agent: "writer", description: "b", prompt: "Write b.md.\nFiles: b.md\nChecks: test -f b.md" }, MODEL),
  ])
  assert.equal(a.job.id, b.job.id, "one job per micromanager session")
  assert.match(b.prompt, /Other workers change other files at the same time \(not yours\): T1 a/)
  const da = native.claim("ses_a", child(a.prompt))!.dir
  const db = native.claim("ses_b", child(b.prompt))!.dir
  assert.notEqual(da, db)
  writeFileSync(join(da, "a.js"), "a\n")
  writeFileSync(join(db, "b.md"), "b\n")
  const [ra, rb] = await Promise.all([native.finish("ses_a", "a"), native.finish("ses_b", "b")])
  assert.match(ra.text, /^Merged/)
  assert.match(rb.text, /^Merged/)
  const tip = a.job.integrationWorktree!
  assert.ok(existsSync(join(tip, "a.js")) && existsSync(join(tip, "b.md")))
  // The rebased one names its commit as merged, not the one it made before the rebase.
  assert.ok([ra, rb].some((r) => r.note!.includes(`(${git(tip, "rev-parse", "--short", "HEAD")})`)))
  assert.equal(git(tip, "log", "--format=%s", "-3"), "T2: b\nT1: a\ninit")
})

test("a conflict on the merge train goes back to the worker, its change kept", async () => {
  const project = repo()
  const native = new Native()
  const a = await native.delegate(project, "ses_mm", { agent: "coder", description: "a", prompt: "x\nFiles: README.md\nChecks: true" }, MODEL)
  const b = await native.delegate(project, "ses_mm", { agent: "coder", description: "b", prompt: "y\nFiles: README.md\nChecks: true" }, MODEL)
  const da = native.claim("ses_a", child(a.prompt))!.dir
  const db = native.claim("ses_b", child(b.prompt))!.dir
  writeFileSync(join(da, "README.md"), "from a\n")
  writeFileSync(join(db, "README.md"), "from b\n")
  assert.match((await native.finish("ses_a", "a")).text, /^Merged/)
  const r = await native.finish("ses_b", "b")
  assert.match(r.text, /^Your commit does not apply on top of jev\/\S+, which other tasks moved on meanwhile \(conflict in README\.md\)\. Run git rebase/)
  assert.equal(loadJob(project, b.job.id)!.tasks[1]!.status, "escalated")
  assert.equal(git(db, "log", "--format=%s", "-1"), "T2: b", "the worker's commit stays in its worktree")
  // The worker resolves it and finishes again.
  execFileSync("git", ["-C", db, "reset", "-q", "--hard", `jev/${b.job.id}`])
  writeFileSync(join(db, "README.md"), "from a\nfrom b\n")
  assert.match((await native.finish("ses_b", "b, rebased")).text, /^Merged/)
  assert.equal(readFileSync(join(a.job.integrationWorktree!, "README.md"), "utf8"), "from a\nfrom b\n")
})

test("a reader works on the session branch and ends with its findings", async () => {
  const project = repo()
  const native = new Native({ graphs: { get: async () => undefined } })
  const d = await native.delegate(project, "ses_mm", { agent: "explorer", description: "find the router", prompt: "Where is the router?" }, MODEL)
  assert.match(d.prompt, /Change no files\./)
  assert.doesNotMatch(d.prompt, /finish_task/)
  const claimed = native.claim("ses_r", child(d.prompt))!
  assert.equal(claimed.dir, d.job.integrationWorktree)
  assert.ok(native.isWorker("ses_r") && !native.isWriter("ses_r"))
  assert.match((await native.finish("ses_r", "")).text, /^You only read/)
  assert.deepEqual(await native.ended("ses_r"), { note: undefined, parent: "ses_mm" })
  assert.equal(loadJob(project, d.job.id)!.tasks[0]!.status, "passed")
})

test("an explorer's brief points it at the code graph of its directory; other readers get none", async () => {
  const project = repo()
  const asked: string[] = []
  const native = new Native({ graphs: { get: async (dir) => (asked.push(dir), { commit: "abc1234" }) } })
  const d = await native.delegate(project, "ses_mm", { agent: "explorer", description: "map it", prompt: "How do the modules hang together?" }, MODEL)
  assert.deepEqual(asked, [d.job.integrationWorktree])
  assert.match(d.prompt, /How do the modules hang together\?\n\nA code graph of this directory \(commit abc1234\) is ready\./)
  assert.match(d.prompt, /ask the code_graph tool first/)
  const p = await native.delegate(project, "ses_mm", { agent: "planner", description: "plan it", prompt: "Plan the split." }, MODEL)
  assert.doesNotMatch(p.prompt, /code_graph/)
  assert.equal(asked.length, 1)

  native.claim("ses_x", child(d.prompt))
  native.claim("ses_p", child(p.prompt))
  assert.ok(native.hasGraph("ses_x"))
  assert.ok(!native.hasGraph("ses_p"), "a planner has no graph tool")
  assert.equal(await native.askGraph("ses_p", "explain", "main", ""), "This session has no code graph.")
  assert.match(await native.askGraph("ses_x", "teleport", "main", ""), /^Unknown action "teleport"/)
})

test("without a graph the explorer's brief has no graph lines", async () => {
  const project = repo()
  const native = new Native({ graphs: { get: async () => undefined } })
  const d = await native.delegate(project, "ses_mm", { agent: "explorer", description: "find it", prompt: "Where is the router?" }, MODEL)
  assert.doesNotMatch(d.prompt, /code_graph/)
  assert.match(d.prompt, /Where is the router\?\n\nChange no files\./)
  native.claim("ses_x", child(d.prompt))
  assert.ok(!native.hasGraph("ses_x"))
})

test("what is not a valid delegation is refused with a reason", async () => {
  const project = repo()
  const native = new Native()
  const refused = async (agent: string, prompt: string) => {
    const err = await native.delegate(project, "ses_mm", { agent, description: "x", prompt }, MODEL).then(() => undefined, (e: unknown) => e)
    assert.ok(err instanceof DelegationError, `${agent}: ${prompt}`)
    return err.message
  }
  assert.match(await refused("general", "do it"), /use one of the role agents/)
  assert.match(await refused("coder", "Change it.\nChecks: npm test"), /a coder changes files; end the prompt with a line "Files:/)
  assert.match(await refused("explorer", "Look.\nFiles: a.js"), /explorer only reads/)
  assert.match(await refused("coder", "Change it.\nFiles: a.js\nChecks: Run the tests and make sure they pass."), /checks must be shell commands/)
  assert.match(await refused("coder", "Change it.\nFiles: /etc/passwd\nChecks: true"), /inside the project/)
})

test("a call that failed before its worker started drops the task and its worktree", async () => {
  const project = repo()
  const native = new Native()
  const d = await native.delegate(project, "ses_mm", { agent: "coder", description: "a", prompt: "x\nFiles: a.js\nChecks: true" }, MODEL)
  const dir = d.task.worktree!
  assert.ok(existsSync(dir))
  await native.abandon(d.prompt)
  assert.ok(!existsSync(dir))
  assert.equal(loadJob(project, d.job.id)!.tasks[0]!.status, "cancelled")
  assert.equal(native.claim("ses_late", child(d.prompt)), undefined)
})

test("a writer that ends without finishing is reported; continued, it finishes in the same worktree", async () => {
  const project = repo()
  const native = new Native()
  const d = await native.delegate(project, "ses_mm", { agent: "coder", description: "a", prompt: "x\nFiles: a.js\nChecks: test -f a.js" }, MODEL)
  const dir = native.claim("ses_w", child(d.prompt))!.dir
  const end = await native.ended("ses_w", "loop: the same edit 5 times")
  assert.match(end!.note!, /^\[jev-micromanager\] T1 a: its worker ended \(loop: the same edit 5 times\) without passing finish_task, so nothing was checked or merged; its change is still in \S+\. Continue it with the subagent tool and sessionID ses_w/)
  assert.ok(existsSync(dir))
  assert.equal((await native.resume("ses_w"))!.id, "T1")
  writeFileSync(join(dir, "a.js"), "a\n")
  assert.match((await native.finish("ses_w", "a")).text, /^Merged/)
})

test("a merged writer continued by its session gets a new task in a fresh worktree at the same place", async () => {
  const project = repo()
  const native = new Native()
  const d = await native.delegate(project, "ses_mm", { agent: "coder", description: "a", prompt: "x\nFiles: a.js\nChecks: test -f a.js" }, MODEL)
  const dir = native.claim("ses_w", child(d.prompt))!.dir
  writeFileSync(join(dir, "a.js"), "a\n")
  await native.finish("ses_w", "a")
  await native.ended("ses_w")
  assert.ok(!existsSync(dir))
  const next = (await native.resume("ses_w"))!
  assert.equal(next.id, "T2")
  assert.equal(next.title, "a (continued)")
  assert.ok(existsSync(join(dir, "a.js")), "the fresh worktree starts from the session branch, with T1's change")
  writeFileSync(join(dir, "a.js"), "a2\n")
  assert.match((await native.finish("ses_w", "a2")).text, /^Merged/)
  assert.deepEqual(native.running("ses_mm"), [])
  assert.deepEqual(loadJob(project, d.job.id)!.tasks.map((t) => `${t.id}:${t.status}`), ["T1:merged", "T2:merged"])
})
