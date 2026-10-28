// The job's own branch and worktree (design.md §11): workers change files there, never in the user's checkout.
// The worktree lives inside the project, under .jev-micromanager/worktrees/, so workers stay inside the project
// directory (no external_directory ask) and git ignores it through .git/info/exclude.

import { execFile } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"

import { measuredOf, median, parseScoreLines, type Contract, type Measured } from "./contract.ts"
import { stateDir } from "./store.ts"
import type { Job, Task } from "./state.ts"

// Git always materialises a worktree of the REPOSITORY ROOT, never of the directory the plugin asked from. A project
// that is a subdirectory of the repository (a monorepo package) therefore has to carry its offset into every worktree,
// or the worker is moved to the root, several levels above its own files, and its checks run against the wrong tree.
// state.ts owns these interfaces; the two fields are declared here so the offset travels with the job's JSON and
// survives a restart.
declare module "./state.ts" {
  interface Job {
    integrationRel?: string // the project directory's path inside the repository root; "" when the project IS the root
    integrationBase?: string // the commit the job's branch started from
    integrationDirty?: string // uncommitted paths in the user's tree when the worktree was made, "" when it was clean
  }
  interface Task {
    worktreeRel?: string // the same offset for the task's own worktree
  }
}

export interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut?: boolean
}

// env: added to the plugin's own environment, for an evaluator told which corpus to measure on.
export type Exec = (command: string, args: readonly string[], options: { cwd: string; timeoutMs?: number; env?: Readonly<Record<string, string>> }) => Promise<Run>

// Never throws: a failing command is a result. Gates run with a low priority, so a test suite does not take the
// whole machine.
export const exec: Exec = (command, args, options) =>
  new Promise((resolve) => {
    const env = options.env ? { ...process.env, ...options.env } : undefined
    execFile(command, [...args], { cwd: options.cwd, timeout: options.timeoutMs ?? 120_000, maxBuffer: 8 * 1024 * 1024, ...(env ? { env } : {}) }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null
      resolve({
        code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr) || (e && typeof e.code !== "number" ? e.message : ""),
        timedOut: Boolean(e?.killed),
      })
    })
  })

export interface Integration {
  readonly branch: string
  readonly worktree: string // the git worktree root: the repository root, not the project
  readonly base: string // the commit the branch started from
  readonly rel: string // the project directory's path inside the repository root; "" when the project IS the root
  readonly dirty: boolean // the user's working tree has changes no worker will see
  readonly dirtySummary: string // the first few of those paths
}

export class IntegrationError extends Error {}

// The project directory's path inside the repository root, as git reports it. Empty when the project is the root, which
// is the common case and the one where a worktree and the project coincide. An offset that climbs out of the root would
// point a worker at the user's checkout, so it is refused.
export function projectRel(topLevel: string, project: string): string {
  const rel = relative(resolve(topLevel), resolve(project)).split(sep).join("/")
  if (rel === "") return ""
  if (rel === ".." || rel.startsWith("../") || rel.includes("/../") || rel.startsWith("/")) {
    throw new IntegrationError(`${project} is not inside the repository ${topLevel}`)
  }
  return rel
}

// The project's offset inside its repository, as git reports it from the project. Empty when git cannot answer, which
// keeps the plugin behaving as before (the worktree root stands in for the project) instead of refusing to start.
export async function repoRel(project: string, run: Exec = exec): Promise<string> {
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: project })
  return top.code === 0 && top.stdout.trim() ? projectRel(top.stdout.trim(), project) : ""
}

// Where a worker works and where its checks run: the project directory inside a worktree of the repository root. The
// worktree argument is the git worktree root, because that is what git commands need; this is what tools and paths in a
// task's Files and Checks lines resolve against.
export function taskDir(worktree: string, rel: string): string {
  if (rel === "") return resolve(worktree)
  if (rel.startsWith("/") || rel.split("/").includes("..")) throw new IntegrationError(`a project offset may not leave the worktree: ${rel}`)
  return resolve(worktree, ...rel.split("/").filter((p) => p && p !== "."))
}

// git only checks out paths that exist in the commit, so a project directory with no tracked files (a new slide deck,
// a folder the user will fill later) is missing from a fresh worktree. OpenCode refuses to move a session into a
// missing directory, so the worker's first prompt would never be stored: create it before anyone is moved there.
function materializeTaskDir(worktree: string, rel: string): string {
  const dir = taskDir(worktree, rel)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    throw new IntegrationError(`could not create the project directory ${dir} in the worktree: ${why}`)
  }
  return dir
}

// Uncommitted changes in the user's working tree, which no worktree carries: a task that depends on them can never
// pass its checks, so the caller reports it rather than letting a worker discover it.
export async function dirtyPaths(project: string, run: Exec = exec): Promise<{ dirty: boolean; paths: string[]; summary: string }> {
  const status = await run("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: project })
  const records = status.stdout.split("\0").filter(Boolean)
  const paths: string[] = []
  for (let i = 0; i < records.length; i++) {
    paths.push(records[i]!.slice(3))
    // A rename has its source path as a second NUL-separated record. Both matter for an overlap check.
    if (records[i]![0] === "R" || records[i]![0] === "C") paths.push(records[++i] ?? "")
  }
  const clean = paths.map((path) => path.replace(/\/$/, "")).filter(Boolean)
  return { dirty: clean.length > 0, paths: clean, summary: clean.slice(0, 5).join(", ") + (clean.length > 5 ? `, +${clean.length - 5} more` : "") }
}

// A writer starts from HEAD. Uncommitted versions of files it may change cannot reach it, so starting would either lose
// those edits or end in a merge the user has to untangle. Find that before creating a task or worktree.
export function dirtyDeclared(files: readonly string[], projectRel: string, dirty: readonly string[]): string[] {
  const root = projectRel.split(sep).filter(Boolean)
  const declared = files.map((file) => [...root, ...file.split("/").filter(Boolean)].join("/"))
  return dirty.filter((path) => declared.some((file) => path === file || path.startsWith(`${file}/`) || file.startsWith(`${path}/`)))
}

export async function prepareIntegration(project: string, jobId: string, run: Exec = exec): Promise<Integration> {
  const inside = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: project })
  if (inside.code !== 0 || inside.stdout.trim() !== "true") throw new IntegrationError(`${project} is not a git repository`)
  // The worktree is a checkout of the root, so the offset between the two decides where a worker works and checks run.
  const rel = await repoRel(project, run)
  const head = await run("git", ["rev-parse", "HEAD"], { cwd: project })
  if (head.code !== 0) throw new IntegrationError("the repository has no commit to start from")
  // Before the worktree exists: its own checkout must not be counted as the user's uncommitted work.
  const { dirty, summary } = await dirtyPaths(project, run)
  const branch = `jev/${jobId}`
  const worktree = join(project, stateDir(project), "worktrees", jobId)
  const added = await run("git", ["worktree", "add", "-q", "-b", branch, worktree, "HEAD"], { cwd: project })
  if (added.code !== 0) throw new IntegrationError(`git worktree add failed: ${added.stderr.trim()}`)
  materializeTaskDir(worktree, rel)
  return { branch, worktree, base: head.stdout.trim(), rel, dirty, dirtySummary: summary }
}

// Files the worker changed in the worktree since the last commit, untracked ones included.
// The paths come back relative to the project directory inside the worktree, the basis every caller compares them on:
// task.files and a task's Checks line are project-relative. git always reports from the repository root, so with a
// non-empty rel the offset is resolved away; a change outside the project comes back as a "../" path, which cannot
// match a declared file (which is what it is: outside).
export async function changedFiles(worktree: string, run: Exec = exec, rel = ""): Promise<string[]> {
  const status = await run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: worktree })
  const project = taskDir(worktree, rel)
  return status.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((path) => relative(project, resolve(worktree, path)).split(sep).join("/"))
}

// Commits a passed task on the job's branch. Returns the commit, or undefined when nothing changed.
// The identity is the user's own, as git resolves it: the task's commits belong to them, not to the plugin.
export async function commitTask(worktree: string, subject: string, body: string, run: Exec = exec): Promise<string | undefined> {
  if ((await changedFiles(worktree, run)).length === 0) return undefined
  await run("git", ["add", "-A"], { cwd: worktree })
  const commit = await run("git", ["commit", "-q", "-m", subject, "-m", body], { cwd: worktree })
  if (commit.code !== 0) throw new IntegrationError(`git commit failed: ${commit.stderr.trim()}`)
  return (await run("git", ["rev-parse", "--short", "HEAD"], { cwd: worktree })).stdout.trim()
}

export interface GateResult {
  readonly command: string
  readonly passed: boolean
  readonly code: number
  readonly output: string // the tail, enough for the worker to fix it
  // The check's own MM_SCORE line (src/contract.ts), read before the output is cut: an ordinary check may say how many
  // of its cases passed, which grades a build task without deciding it; pass or fail is still its exit code.
  readonly score?: Measured
}

// Runs each check in the task's directory at low priority; a check passes on exit code 0.
// worktree is the git worktree root; dir is where the worker's own paths resolve, which is the project directory inside
// the worktree. Without it a check names a file of the project and the shell looks for it in the wrong tree.
export interface Cancelled {
  readonly cancelled?: () => boolean
}

// cancel: checked between checks, not inside one. A single check is bounded by its own timeout (300s by default),
// because there is nothing to interrupt a shell with once it started; but without this a job with five checks could
// not be stopped until all five ran, and stop_job looked broken for as long as the first one took.
export async function runGate(worktree: string, commands: readonly string[], run: Exec = exec, timeoutMs = 300_000, dir?: string, cancel: Cancelled = {}): Promise<GateResult[]> {
  const cwd = dir ?? worktree
  const out: GateResult[] = []
  for (const command of commands) {
    if (cancel.cancelled?.()) {
      out.push({ command, passed: false, code: -1, output: "not run: the job was stopped" })
      continue
    }
    const r = await run("nice", ["-n", "15", "sh", "-c", command], { cwd, timeoutMs })
    const text = `${r.stdout}\n${r.stderr}`.trim()
    const score = parseScoreLines(r.stdout)
    out.push({ command, passed: r.code === 0 && !r.timedOut, code: r.code, output: (r.timedOut ? "[timed out]\n" : "") + text.slice(-3000), ...(score ? { score } : {}) })
  }
  return out
}

// The cases the checks' MM_SCORE lines counted together; undefined when none of them graded anything.
export function gradedOf(results: readonly GateResult[]): { passed: number; total: number } | undefined {
  const cases = results.map((r) => r.score?.cases).filter((c): c is NonNullable<typeof c> => Boolean(c))
  return cases.length ? { passed: cases.reduce((s, c) => s + c.passed, 0), total: cases.reduce((s, c) => s + c.total, 0) } : undefined
}

// A contract's evaluator in the worker's directory, repeated as the contract says; the median of the runs is the
// measurement, and seconds what all runs took (the contract's cost per evaluation, for its stop rule). The evaluator
// is told which corpus it measures on; the held-out corpus (P4) comes with its directory.
export async function runEvaluator(dir: string, contract: Contract, corpus: "visible" | "heldout" = "visible", run: Exec = exec, corpusDir?: string): Promise<{ measured: Measured; seconds: number }> {
  const started = Date.now()
  const runs: Measured[] = []
  for (let i = 0; i < contract.repeats; i++) {
    const env = { MM_CORPUS: corpus, MM_REPEAT: String(i + 1), ...(corpusDir ? { MM_CORPUS_DIR: corpusDir } : {}) }
    const m = measuredOf(contract, await run("nice", ["-n", "15", "sh", "-c", contract.evaluator], { cwd: dir, timeoutMs: contract.timeoutMs, env }))
    runs.push(m)
    if (!m.valid) break // one invalid run makes the measurement invalid; the others would only cost time
  }
  return { measured: median(runs), seconds: Math.round((Date.now() - started) / 100) / 10 }
}

// The worker's change against the last commit, new files included, for a reviewer that has no git.
export async function workingDiff(worktree: string, run: Exec = exec): Promise<string> {
  await run("git", ["add", "-A", "-N"], { cwd: worktree })
  return (await run("git", ["diff", "HEAD"], { cwd: worktree })).stdout
}

// Content hashes of files, to see whether frozen tests were changed; a missing file hashes to "".
// dir: the project directory inside the worktree, because the paths are project-relative (changedFiles).
export async function hashFiles(worktree: string, files: readonly string[], run: Exec = exec, dir = worktree): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const f of files) out.set(f, (await run("git", ["hash-object", "--", f], { cwd: dir })).stdout.trim())
  return out
}

// The frozen files whose content is no longer what it was when they were frozen (changed, deleted or, for one that did
// not exist, created). dir: the project directory inside the worktree, as for hashFiles.
export async function frozenChanged(worktree: string, frozen: ReadonlyMap<string, string>, run: Exec = exec, dir = worktree): Promise<string[]> {
  if (frozen.size === 0) return []
  const now = await hashFiles(worktree, [...frozen.keys()], run, dir)
  return [...frozen].filter(([f, h]) => now.get(f) !== h).map(([f]) => f)
}

// Frozen tests must not change: a changed or deleted one fails the gate like a failing check. The runner freezes the
// tests its red stage wrote (P3); a native writer the tests its checks name and its contract's files.
export async function frozenCheck(worktree: string, frozen: ReadonlyMap<string, string>, run: Exec = exec, dir = worktree, why = "changed after the red stage"): Promise<GateResult[]> {
  if (frozen.size === 0) return []
  const changed = await frozenChanged(worktree, frozen, run, dir)
  return [{ command: "frozen tests unchanged", passed: changed.length === 0, code: changed.length ? 1 : 0, output: changed.length ? `${why}: ${changed.join(", ")}; restore them and change the code instead` : "" }]
}

// Undoes a worker's changes to the given files: tracked ones back to the last commit, new ones removed.
// dir: the project directory inside the worktree, because the paths are project-relative (changedFiles). git resolves a
// pathspec against the directory it runs in, so resolving the wrong one would silently touch a file of the same name.
export async function revertFiles(worktree: string, files: readonly string[], run: Exec = exec, dir = worktree): Promise<void> {
  for (const f of files) {
    const restored = await run("git", ["checkout", "-q", "HEAD", "--", f], { cwd: dir })
    if (restored.code !== 0) await run("git", ["clean", "-q", "-f", "--", f], { cwd: dir })
  }
}

// --- Phase F: parallel writers and the merge train (design.md §11) ------------------------------------------

export interface TaskWorktree {
  readonly branch: string
  readonly worktree: string // the git worktree root: what git commands need
  readonly dir: string // where the worker works and its checks run: the project directory inside the worktree
  readonly rel: string
  readonly dirty: boolean
  readonly dirtySummary: string
}

// A task of a parallel batch works in its own worktree, on a branch off the job's branch at its current commit.
// "jev/<job>--<task>", since "jev/<job>/<task>" cannot sit next to the branch "jev/<job>" in git's refs. at: another
// place for it (a continued worker keeps its session's directory). rel: the project's offset inside the worktree.
export async function prepareTaskWorktree(project: string, jobId: string, taskId: string, from: string, run: Exec = exec, at?: string, rel = ""): Promise<TaskWorktree> {
  const branch = `jev/${jobId}--${taskId}`
  const worktree = at ?? join(project, stateDir(project), "worktrees", `${jobId}--${taskId}`)
  await removeTaskWorktree(project, { branch, worktree }, run) // a leftover of an interrupted run
  // Before the checkout exists, so the plugin never reports its own worktree as the user's uncommitted work.
  const { dirty, summary } = await dirtyPaths(project, run)
  const added = await run("git", ["worktree", "add", "-q", "-b", branch, worktree, from], { cwd: project })
  if (added.code !== 0) throw new IntegrationError(`git worktree add failed: ${added.stderr.trim()}`)
  const dir = materializeTaskDir(worktree, rel)
  return { branch, worktree, dir, rel, dirty, dirtySummary: summary }
}

// Only the worktree root and the branch: a worktree can be removed by name alone, and callers that hold no project
// offset (a removal after a merge) must not have to invent one.
export async function removeTaskWorktree(project: string, w: Pick<TaskWorktree, "branch" | "worktree">, run: Exec = exec): Promise<void> {
  await run("git", ["worktree", "remove", "--force", w.worktree], { cwd: project })
  await run("git", ["branch", "-D", w.branch], { cwd: project })
}

export type TrainStep = { readonly ok: true; readonly moved: boolean } | { readonly ok: false; readonly conflict: string }

// The first half of a merge train step: the task's branch is rebased onto the job's branch when that moved on since
// the task started. moved tells the caller to run the task's checks again before the fast-forward.
export async function rebaseTask(w: Pick<TaskWorktree, "worktree">, integrationBranch: string, run: Exec = exec): Promise<TrainStep> {
  const base = (await run("git", ["merge-base", "HEAD", integrationBranch], { cwd: w.worktree })).stdout.trim()
  const tip = (await run("git", ["rev-parse", integrationBranch], { cwd: w.worktree })).stdout.trim()
  if (base === tip) return { ok: true, moved: false }
  const rebased = await run("git", ["rebase", "-q", integrationBranch], { cwd: w.worktree })
  if (rebased.code === 0) return { ok: true, moved: true }
  const files = (await run("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: w.worktree })).stdout.trim().split("\n").filter(Boolean)
  await run("git", ["rebase", "--abort"], { cwd: w.worktree })
  return { ok: false, conflict: files.length ? `conflict in ${files.join(", ")}` : rebased.stderr.trim().slice(-500) }
}

// The second half: the job's branch moves forward to the task's commits; nothing else is ever merged into it.
export async function fastForward(integrationWorktree: string, taskBranch: string, run: Exec = exec): Promise<TrainStep> {
  const ff = await run("git", ["merge", "-q", "--ff-only", taskBranch], { cwd: integrationWorktree })
  return ff.code === 0 ? { ok: true, moved: false } : { ok: false, conflict: ff.stderr.trim().slice(-500) }
}
