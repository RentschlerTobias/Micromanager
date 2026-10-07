// The integration layer is exercised here with a fake Exec: a real repository would not answer `git rev-parse
// --show-toplevel` with a top level above the project on demand, and the whole point of the fix is which paths the
// plugin asks git about and in which directory it runs a check.

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  changedFiles, dirtyPaths, hashFiles, IntegrationError, prepareIntegration, prepareTaskWorktree, projectRel,
  revertFiles, runGate, taskDir, type Exec, type Run,
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

const TOP = "/repo"
const PROJECT = "/repo/a/b/c"
const JOB = "job-1"

function answers(topLevel: string, status = ""): Record<string, string> {
  return {
    "git rev-parse --is-inside-work-tree": "true\n",
    "git rev-parse --show-toplevel": `${topLevel}\n`,
    "git rev-parse HEAD": "abc1234def\n",
    "git status --porcelain": status,
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
    ["git", ["status", "--porcelain"]],
    ["git", ["worktree", "add", "-q", "-b", `jev/${JOB}`, `${TOP}/${DIR}/worktrees/${JOB}`, "HEAD"]],
  ])
  assert.ok(calls.every((c) => c.cwd === TOP), "every call runs in the project")
  assert.deepEqual(taskDir(i.worktree, i.rel), i.worktree)
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
  // git is still told to add the worktree at the root, and to remove it there too.
  const add = calls.find((c) => c.args[0] === "worktree" && c.args[1] === "add")!
  assert.deepEqual([...add.args], ["worktree", "add", "-q", "-b", `jev/${JOB}--T1`, w.worktree, `jev/${JOB}`])
  assert.deepEqual([...calls.find((c) => c.args[1] === "remove")!.args.slice(0, 3)], ["worktree", "remove", "--force"])

  const root = await prepareTaskWorktree(PROJECT, JOB, "T2", `jev/${JOB}`, run, undefined, "")
  assert.equal(root.dir, root.worktree, "no offset: the project is the root, as before")
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
  assert.deepEqual(clean, { dirty: false, summary: "" })

  const status = " M a/b/c/references.bib\n?? a/b/c/notes.md\n M other/x.txt\n"
  const { run, calls } = fakeGit(answers(TOP, status), PROJECT)
  const dirty = await dirtyPaths(PROJECT, run)
  assert.equal(dirty.dirty, true)
  assert.match(dirty.summary, /a\/b\/c\/references\.bib/)
  assert.match(dirty.summary, /a\/b\/c\/notes\.md/)
  assert.deepEqual(calls.map((c) => c.cwd), [PROJECT])

  const i = await prepareIntegration(PROJECT, JOB, run)
  assert.equal(i.dirty, true, "a task that needs an uncommitted file can never pass in a worktree")
  assert.match(i.dirtySummary, /a\/b\/c\/references\.bib/)

  const many = Array.from({ length: 8 }, (_, n) => `?? a/b/c/f${n}.txt`).join("\n")
  assert.match((await dirtyPaths(PROJECT, fakeGit(answers(TOP, many), PROJECT).run)).summary, /\+3 more/, "a short summary, not the whole tree")
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
