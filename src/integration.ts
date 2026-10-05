// The job's own branch and worktree (design.md §11): workers change files there, never in the user's checkout.
// The worktree lives inside the project, under .jev-dictator/worktrees/, so workers stay inside the project
// directory (no external_directory ask) and git ignores it through .git/info/exclude.

import { execFile } from "node:child_process"
import { join } from "node:path"

import { DIR } from "./store.ts"

export interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut?: boolean
}

export type Exec = (command: string, args: readonly string[], options: { cwd: string; timeoutMs?: number }) => Promise<Run>

// Never throws: a failing command is a result. Gates run with a low priority, so a test suite does not take the
// whole machine.
export const exec: Exec = (command, args, options) =>
  new Promise((resolve) => {
    execFile(command, [...args], { cwd: options.cwd, timeout: options.timeoutMs ?? 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
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
  readonly worktree: string
  readonly base: string // the commit the branch started from
}

export class IntegrationError extends Error {}

export async function prepareIntegration(project: string, jobId: string, run: Exec = exec): Promise<Integration> {
  const inside = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: project })
  if (inside.code !== 0 || inside.stdout.trim() !== "true") throw new IntegrationError(`${project} is not a git repository`)
  const head = await run("git", ["rev-parse", "HEAD"], { cwd: project })
  if (head.code !== 0) throw new IntegrationError("the repository has no commit to start from")
  const branch = `jev/${jobId}`
  const worktree = join(project, DIR, "worktrees", jobId)
  const added = await run("git", ["worktree", "add", "-q", "-b", branch, worktree, "HEAD"], { cwd: project })
  if (added.code !== 0) throw new IntegrationError(`git worktree add failed: ${added.stderr.trim()}`)
  return { branch, worktree, base: head.stdout.trim() }
}

// Files the worker changed in the worktree since the last commit, untracked ones included.
export async function changedFiles(worktree: string, run: Exec = exec): Promise<string[]> {
  const status = await run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: worktree })
  return status.stdout.split("\n").filter(Boolean).map((line) => line.slice(3).trim())
}

// Commits a passed task on the job's branch. Returns the commit, or undefined when nothing changed.
export async function commitTask(worktree: string, subject: string, body: string, run: Exec = exec): Promise<string | undefined> {
  if ((await changedFiles(worktree, run)).length === 0) return undefined
  await run("git", ["add", "-A"], { cwd: worktree })
  const commit = await run("git", ["-c", "user.name=jev-dictator", "-c", "user.email=jev-dictator@localhost", "commit", "-q", "-m", subject, "-m", body], { cwd: worktree })
  if (commit.code !== 0) throw new IntegrationError(`git commit failed: ${commit.stderr.trim()}`)
  return (await run("git", ["rev-parse", "--short", "HEAD"], { cwd: worktree })).stdout.trim()
}

export interface GateResult {
  readonly command: string
  readonly passed: boolean
  readonly code: number
  readonly output: string // the tail, enough for the worker to fix it
}

// Runs each check in the worktree at low priority; a check passes on exit code 0.
export async function runGate(worktree: string, commands: readonly string[], run: Exec = exec, timeoutMs = 300_000): Promise<GateResult[]> {
  const out: GateResult[] = []
  for (const command of commands) {
    const r = await run("nice", ["-n", "15", "sh", "-c", command], { cwd: worktree, timeoutMs })
    const text = `${r.stdout}\n${r.stderr}`.trim()
    out.push({ command, passed: r.code === 0 && !r.timedOut, code: r.code, output: (r.timedOut ? "[timed out]\n" : "") + text.slice(-3000) })
  }
  return out
}

// The worker's change against the last commit, new files included, for a reviewer that has no git.
export async function workingDiff(worktree: string, run: Exec = exec): Promise<string> {
  await run("git", ["add", "-A", "-N"], { cwd: worktree })
  return (await run("git", ["diff", "HEAD"], { cwd: worktree })).stdout
}

// Content hashes of files, to see whether frozen tests were changed; a missing file hashes to "".
export async function hashFiles(worktree: string, files: readonly string[], run: Exec = exec): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const f of files) out.set(f, (await run("git", ["hash-object", "--", f], { cwd: worktree })).stdout.trim())
  return out
}

// Undoes a worker's changes to the given files: tracked ones back to the last commit, new ones removed.
export async function revertFiles(worktree: string, files: readonly string[], run: Exec = exec): Promise<void> {
  for (const f of files) {
    const restored = await run("git", ["checkout", "-q", "HEAD", "--", f], { cwd: worktree })
    if (restored.code !== 0) await run("git", ["clean", "-q", "-f", "--", f], { cwd: worktree })
  }
}

// --- Phase F: parallel writers and the merge train (design.md §11) ------------------------------------------

export interface TaskWorktree {
  readonly branch: string
  readonly worktree: string
}

// A task of a parallel batch works in its own worktree, on a branch off the job's branch at its current commit.
// "jev/<job>--<task>", since "jev/<job>/<task>" cannot sit next to the branch "jev/<job>" in git's refs.
export async function prepareTaskWorktree(project: string, jobId: string, taskId: string, from: string, run: Exec = exec): Promise<TaskWorktree> {
  const branch = `jev/${jobId}--${taskId}`
  const worktree = join(project, DIR, "worktrees", `${jobId}--${taskId}`)
  await removeTaskWorktree(project, { branch, worktree }, run) // a leftover of an interrupted run
  const added = await run("git", ["worktree", "add", "-q", "-b", branch, worktree, from], { cwd: project })
  if (added.code !== 0) throw new IntegrationError(`git worktree add failed: ${added.stderr.trim()}`)
  return { branch, worktree }
}

export async function removeTaskWorktree(project: string, w: TaskWorktree, run: Exec = exec): Promise<void> {
  await run("git", ["worktree", "remove", "--force", w.worktree], { cwd: project })
  await run("git", ["branch", "-D", w.branch], { cwd: project })
}

export type TrainStep = { readonly ok: true; readonly moved: boolean } | { readonly ok: false; readonly conflict: string }

// The first half of a merge train step: the task's branch is rebased onto the job's branch when that moved on since
// the task started. moved tells the caller to run the task's checks again before the fast-forward.
export async function rebaseTask(w: TaskWorktree, integrationBranch: string, run: Exec = exec): Promise<TrainStep> {
  const base = (await run("git", ["merge-base", "HEAD", integrationBranch], { cwd: w.worktree })).stdout.trim()
  const tip = (await run("git", ["rev-parse", integrationBranch], { cwd: w.worktree })).stdout.trim()
  if (base === tip) return { ok: true, moved: false }
  const rebased = await run("git", ["-c", "user.name=jev-dictator", "-c", "user.email=jev-dictator@localhost", "rebase", "-q", integrationBranch], { cwd: w.worktree })
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
