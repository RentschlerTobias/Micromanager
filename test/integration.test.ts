// The integration layer is exercised here with a fake Exec: a real repository would not answer `git rev-parse
// --show-toplevel` with a top level above the project on demand, and the whole point of the fix is which paths the
// plugin asks git about and in which directory it runs a check.

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"

import {
  changedFiles, commitTask, dirtyDeclared, dirtyPaths, hashFiles, IntegrationError, prepareIntegration, prepareTaskWorktree,
  projectRel, rebaseTask, revertFiles, runGate, taskDir, type Exec, type Run,
} from "../src/integration.ts"
import { DIR } from "../src/store.ts"

interface Call {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
}

// A git that answers the questions the integration asks, and records how it was asked.
function fakeGit(answers: Record<string, string>, cwd = "/p") {
  const calls: Call[] = []
  const run: Exec = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd })
    const out = answers[[command, ...args].join(" ")]
    if (out === undefined) return ok("")
    return ok(out)
  }
  const ok = (stdout: string): Run => ({ code: 0, stdout, stderr: "" })
  return { run, calls }
}

// A real directory: preparing a worktree now creates the project directory inside it, as git does not check out empty
// or untracked-only folders.
const ROOT = mkdtempSync(join(tmpdir(), "micromanager-integration-"))
after(() => rmSync(ROOT, { recursive: true, force: true }))
const TOP = join(ROOT, "repo")
const PROJECT = join(TOP, "a/b/c")
const JOB = "job-1"

function answers(topLevel: string, status = ""): Record<string, string> {
  return {
    "git rev-parse --is-inside-work-tree": "true\n",
    "git rev-parse --show-toplevel": `${topLevel}\n`,
    "git rev-parse HEAD": "abc1234def\n",
    "git status --porcelain -z --untracked-files=all": status.replace(/\n/g, "\0"),
    [`git worktree add -q -b jev/${JOB} ${PROJECT}/${DIR}/worktrees/${JOB} HEAD`]: "",
  }
}

test("a project that is the repository root keeps everything as it was", async () => {
  const { run, calls } = fakeGit(answers(TOP))
  const i = await prepareIntegration(TOP, JOB, run)
  assert.equal(i.rel, "", "no offset: the worktree and the project are the same directory")
  assert.equal(i.branch, `jev/${JOB}`)
  assert.equal(i.base, "abc1234def")
  assert.equal(i.worktree, `${TOP}/${DIR}/worktrees/${JOB}`)
  assert.equal(i.dirty, false)
  assert.equal(i.dirtySummary, "")
  // The git calls themselves are unchanged for the common case.
  assert.deepEqual(calls.map((c) => [c.command, [...c.args]]), [
    ["git", ["rev-parse", "--is-inside-work-tree"]],
    ["git", ["rev-parse", "--show-toplevel"]],
    ["git", ["rev-parse", "HEAD"]],
    ["git", ["status", "--porcelain", "-z", "--untracked-files=all"]],
    ["git", ["worktree", "add", "-q", "-b", `jev/${JOB}`, `${TOP}/${DIR}/worktrees/${JOB}`, "HEAD"]],
  ])
  assert.ok(calls.every((c) => c.cwd === TOP), "every call runs in the project")
  assert.deepEqual(taskDir(i.worktree, i.rel), i.worktree)
  assert.ok(existsSync(i.worktree), "the checkout root exists even before anything is written")
})

test("a project below the repository root records the offset git reports, asked for in the project", async () => {
  const { run, calls } = fakeGit(answers(TOP))
  const i = await prepareIntegration(PROJECT, JOB, run)
  assert.equal(i.rel, "a/b/c", "the project directory's path inside the repository root")
  const top = calls.find((c) => c.args.join(" ") === "rev-parse --show-toplevel")
  assert.deepEqual([top!.command, top!.cwd], ["git", PROJECT], "git is asked from the project, not from the root")
  // The worktree is still registered at the worktree root, which is what git materialises and what git commands need.
  assert.equal(i.worktree, `${PROJECT}/${DIR}/worktrees/${JOB}`)
  assert.deepEqual(calls.at(-1)!.args, ["worktree", "add", "-q", "-b", `jev/${JOB}`, i.worktree, "HEAD"])
  assert.equal(taskDir(i.worktree, i.rel), `${i.worktree}/a/b/c`, "the worker works three levels down")
  assert.ok(existsSync(`${i.worktree}/a/b/c`), "the offset directory exists even when the commit has no files there")
})

test("an offset that leaves the repository or the worktree is refused", () => {
  assert.equal(projectRel(TOP, PROJECT), "a/b/c")
  assert.equal(projectRel(TOP, TOP), "")
  assert.throws(() => projectRel(PROJECT, TOP), IntegrationError, "the project is above the top level")
  assert.equal(taskDir("/wt", ""), "/wt")
  assert.equal(taskDir("/wt/", ""), "/wt", "a trailing slash on the worktree is harmless")
  assert.equal(taskDir("/wt", "a/b"), "/wt/a/b")
  assert.equal(taskDir("/wt", "./a/./b"), "/wt/a/b")
  assert.throws(() => taskDir("/wt", "../elsewhere"), IntegrationError)
  assert.throws(() => taskDir("/wt", "a/../../elsewhere"), IntegrationError)
  assert.throws(() => taskDir("/wt", "/etc"), IntegrationError, "an absolute offset is not an offset")
})

test("a task worktree gives the git root and the directory to work in", async () => {
  const { run, calls } = fakeGit(answers(TOP), PROJECT)
  const w = await prepareTaskWorktree(PROJECT, JOB, "T1", `jev/${JOB}`, run, undefined, "a/b/c")
  assert.equal(w.worktree, `${PROJECT}/${DIR}/worktrees/${JOB}--T1`, "the git worktree root")
  assert.equal(w.dir, `${w.worktree}/a/b/c`, "where the worker and its checks run")
  assert.equal(w.rel, "a/b/c")
  assert.ok(existsSync(w.dir), "the worker's directory is created inside the fresh worktree")
  // git is still told to add the worktree at the root, and to remove it there too.
  const add = calls.find((c) => c.args[0] === "worktree" && c.args[1] === "add")!
  assert.deepEqual([...add.args], ["worktree", "add", "-q", "-b", `jev/${JOB}--T1`, w.worktree, `jev/${JOB}`])
  assert.deepEqual([...calls.find((c) => c.args[1] === "remove")!.args.slice(0, 3)], ["worktree", "remove", "--force"])

  const root = await prepareTaskWorktree(PROJECT, JOB, "T2", `jev/${JOB}`, run, undefined, "")
  assert.equal(root.dir, root.worktree, "no offset: the project is the root, as before")
  assert.ok(existsSync(root.dir), "the checkout root exists")
})

test("the gate runs a check in the directory it is given, and in the worktree root without one", async () => {
  const seen: Call[] = []
  const record: Exec = async (command, args, options) => {
    seen.push({ command, args, cwd: options.cwd })
    return { code: 0, stdout: "", stderr: "" }
  }
  const [r] = await runGate("/wt", ["grep -c '^@' references.bib"], record, undefined, "/wt/a/b/c")
  assert.deepEqual(seen.map((c) => [c.command, c.cwd]), [["nice", "/wt/a/b/c"]], "the check runs where the worker's files are")
  assert.deepEqual([...seen[0]!.args], ["-n", "15", "sh", "-c", "grep -c '^@' references.bib"])
  assert.equal(r!.passed, true)

  await runGate("/wt", ["true"], record)
  assert.deepEqual(seen.at(-1), { command: "nice", args: ["-n", "15", "sh", "-c", "true"], cwd: "/wt" }, "without a directory it falls back to the worktree root")
})

test("an uncommitted working tree is reported, and a clean one is not", async () => {
  const clean = await dirtyPaths(PROJECT, fakeGit(answers(TOP, ""), PROJECT).run)
  assert.deepEqual(clean, { dirty: false, paths: [], summary: "" })

  const status = " M a/b/c/references.bib\n?? a/b/c/notes.md\n M other/x.txt\n"
  const { run, calls } = fakeGit(answers(TOP, status), PROJECT)
  const dirty = await dirtyPaths(PROJECT, run)
  assert.equal(dirty.dirty, true)
  assert.match(dirty.summary, /a\/b\/c\/references\.bib/)
  assert.match(dirty.summary, /a\/b\/c\/notes\.md/)
  assert.deepEqual(calls.map((c) => c.cwd), [PROJECT])
  assert.deepEqual(dirtyDeclared(["references.bib", "notes.md"], "a/b/c", dirty.paths), ["a/b/c/references.bib", "a/b/c/notes.md"], "a declared file's current version cannot reach the worker")
  assert.deepEqual(dirtyDeclared(["notes.md"], "", dirty.paths), [], "without the project offset a project file does not match the repository path")
  assert.deepEqual(dirtyDeclared(["other/y.txt"], "", ["other/x.txt"]), [], "an unrelated dirty path does not block a clean task")

  const i = await prepareIntegration(PROJECT, JOB, run)
  assert.equal(i.dirty, true, "a task that needs an uncommitted file can never pass in a worktree")
  assert.match(i.dirtySummary, /a\/b\/c\/references\.bib/)

  const renamed = await dirtyPaths(PROJECT, fakeGit(answers(TOP, "R  a/b/c/new.ts\0a/b/c/old.ts"), PROJECT).run)
  assert.deepEqual(renamed.paths, ["a/b/c/new.ts", "a/b/c/old.ts"], "both sides of a rename matter")

  const many = Array.from({ length: 8 }, (_, n) => `?? a/b/c/f${n}.txt`).join("\n")
  assert.match((await dirtyPaths(PROJECT, fakeGit(answers(TOP, many), PROJECT).run)).summary, /\+3 more/, "a short summary, not the whole tree")
})

test("a stopped job does not start the next check", async () => {
  // runGate bounded a single check by its own timeout but never looked at the cancel signal between checks, so a job
  // with five checks kept running all of them and stop_job looked broken for as long as the first one took.
  const seen: Call[] = []
  let stop = false
  const record: Exec = async (command, args, options) => {
    seen.push({ command, args: [...args], cwd: options.cwd })
    stop = true // the user stops the job while the first check runs
    return { code: 0, stdout: "", stderr: "" }
  }
  const [first, second] = await runGate("/wt", ["npm test", "npm run build"], record, undefined, "/wt", {
    cancelled: () => stop,
  })
  assert.equal(first!.passed, true)
  assert.equal(second!.passed, false, "the gate reports the check as failed, so the caller cannot read it as a pass")
  assert.equal(second!.output, "not run: the job was stopped")
  assert.equal(second!.code, -1)
  assert.deepEqual(seen.map((c) => c.cwd), ["/wt"], "the second check never started")

  // Not cancelled: a failing check is a real exit code, not the not-run marker.
  const failing: Exec = async (_c, a) => (a.join(" ").includes("build") ? { code: 2, stdout: "", stderr: "boom" } : { code: 0, stdout: "", stderr: "" })
  const all = await runGate("/wt", ["npm test", "npm run build"], failing, undefined, "/wt", { cancelled: () => false })
  assert.deepEqual(all.map((r) => [r.passed, r.code]), [[true, 0], [false, 2]])
})

test("changed files are project-relative, the basis task.files is on", async () => {
  // git reports from the repository root; task.files and a Checks line are project-relative. Without the offset
  // resolved away, every change in a subdirectory project looks like it happened outside its declared files.
  const status = " M a/b/c/references.bib\n?? a/b/c/notes.md\n M a/b/c/deep/dir/fig.png\n M other/x.txt\n"
  // changedFiles asks for `git status --porcelain --untracked-files=all`; answers() keys on the short form, so build it.
  const porcelain = (lines: string): Record<string, string> => ({
    ...answers(TOP, ""),
    "git status --porcelain --untracked-files=all": lines,
  })

  const plain = await changedFiles("/wt", fakeGit(porcelain(status), "/wt").run, "")
  assert.deepEqual(plain, ["a/b/c/references.bib", "a/b/c/notes.md", "a/b/c/deep/dir/fig.png", "other/x.txt"])

  const offset = await changedFiles("/wt", fakeGit(porcelain(status), "/wt").run, "a/b/c")
  assert.deepEqual(
    offset.slice(0, 3),
    ["references.bib", "notes.md", "deep/dir/fig.png"],
    "inside the project: relative to the project, so a declared file matches",
  )
  assert.equal(offset.at(-1), "../../../other/x.txt", "outside the project: an escape that climbs to the root, so it cannot match a declared file")
  assert.ok(offset.at(-1)!.startsWith(".."), "an outside change is never reported as an inside one")
})

// A real repository for the tests that need git's own identity resolution. The identity is the repository's, as a
// user's checkout has it, never passed on the command line.
function realRepo(prefix = "micromanager-commit-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args])
  git("init", "-q")
  git("config", "user.name", "t")
  git("config", "user.email", "t@t")
  return dir
}

// The identity-related environment, saved and put back: a test must not leak a missing or a made-up identity.
const IDENTITY_ENV = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const
function withoutIdentity(setup: () => void): () => void {
  const saved = IDENTITY_ENV.map((key) => [key, process.env[key]] as const)
  for (const key of IDENTITY_ENV) delete process.env[key]
  setup()
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test("commitTask authors and commits as the repository's identity, with subject and body unchanged", async () => {
  const dir = realRepo()
  try {
    writeFileSync(join(dir, "a.txt"), "a\n")
    const sha = await commitTask(dir, "T1: add a", "Job: job-1\nWorker: role")
    assert.ok(sha, "a commit is returned")
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trimEnd()
    assert.equal(git("log", "-1", "--format=%an <%ae>"), "t <t@t>")
    assert.equal(git("log", "-1", "--format=%cn <%ce>"), "t <t@t>")
    assert.equal(git("log", "-1", "--format=%s"), "T1: add a")
    assert.equal(git("log", "-1", "--format=%b"), "Job: job-1\nWorker: role")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("commitTask fails with git's own message when no identity is configured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "micromanager-noidentity-"))
  execFileSync("git", ["init", "-q", dir])
  const restore = withoutIdentity(() => {
    process.env.GIT_CONFIG_GLOBAL = "/dev/null"
    process.env.GIT_CONFIG_NOSYSTEM = "1"
  })
  try {
    writeFileSync(join(dir, "a.txt"), "a\n")
    await assert.rejects(
      commitTask(dir, "T1: add a", "Job: job-1"),
      (err: unknown) => err instanceof IntegrationError && /git commit failed/.test((err as Error).message),
      "no fallback identity: the commit fails as git's does",
    )
  } finally {
    restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("rebaseTask rewrites with the configured committer and keeps the original author", async () => {
  const dir = realRepo()
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim()
    writeFileSync(join(dir, "base.txt"), "base\n")
    git("add", "-A")
    git("commit", "-qm", "base")
    git("branch", "jev/job-1")
    git("checkout", "-q", "-b", "jev/job-1--T1")
    // The task's commit has another author than the identity the rebase runs as.
    git("config", "user.name", "Original")
    git("config", "user.email", "o@o")
    writeFileSync(join(dir, "t.txt"), "task\n")
    git("add", "-A")
    git("commit", "-qm", "T1: task")
    // The integration branch moves on, committed by the user's identity.
    git("config", "user.name", "t")
    git("config", "user.email", "t@t")
    git("checkout", "-q", "jev/job-1")
    writeFileSync(join(dir, "i.txt"), "integration\n")
    git("add", "-A")
    git("commit", "-qm", "T2: integration")
    git("checkout", "-q", "jev/job-1--T1")

    assert.deepEqual(await rebaseTask({ worktree: dir }, "jev/job-1"), { ok: true, moved: true })
    assert.equal(git("log", "-1", "--format=%s"), "T1: task")
    assert.equal(git("log", "-1", "--format=%an <%ae>"), "Original <o@o>", "the author is the one who wrote the change")
    assert.equal(git("log", "-1", "--format=%cn <%ce>"), "t <t@t>", "the committer is the user's configured identity")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("revertFiles and hashFiles act in the directory the paths are relative to", async () => {
  // Both are fed changedFiles output. A same-named file at the worktree root must not be the one that gets touched.
  const seen: Call[] = []
  const record: Exec = async (command, args, options) => {
    seen.push({ command, args: [...args], cwd: options.cwd })
    return { code: 0, stdout: "deadbeef\n", stderr: "" }
  }

  await hashFiles("/wt", ["references.bib"], record, "/wt/a/b/c")
  assert.deepEqual(seen.at(-1), { command: "git", args: ["hash-object", "--", "references.bib"], cwd: "/wt/a/b/c" })

  await revertFiles("/wt", ["references.bib"], record, "/wt/a/b/c")
  const restore = seen.find((c) => c.args.includes("checkout"))!
  assert.equal(restore.cwd, "/wt/a/b/c", "git resolves a pathspec against its own directory: the wrong one touches a different file")
  assert.deepEqual(restore.args, ["checkout", "-q", "HEAD", "--", "references.bib"])

  const fallback = await hashFiles("/wt", ["references.bib"], record)
  assert.equal(seen.at(-1)!.cwd, "/wt", "without a directory it keeps the worktree root, as before")
})
