// Where jobs live: <project>/.jev-micromanager/jobs/<id>.json, one file per job, written atomically.
//
// Inside the project, so workers can read their notes without an external_directory ask; kept out of git through
// the repository's own .git/info/exclude, which is local and needs no .gitignore change (design.md §8.2).

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"

import type { Job } from "./state.ts"

export {
  reconcileJob,
  RECONCILE_STAGE,
  type Orphan,
  type Reconciled,
  type ReconcileOptions,
  type ReconcileResult,
} from "./state.ts"

export const DIR = ".micromanager"
// The directory's name before 2026-10-19. A project that has it keeps using it: its jobs, notes and git worktrees live
// there, and moving a worktree under a running worker would pull the directory out from under it.
export const LEGACY_DIR = ".jev-micromanager"

// The project's state directory: the old one while the project has it and not the new one.
export function stateDir(project: string): string {
  return existsSync(join(project, LEGACY_DIR)) && !existsSync(join(project, DIR)) ? LEGACY_DIR : DIR
}

export function jobsDir(project: string): string {
  return join(project, stateDir(project), "jobs")
}

export function notesDir(project: string, jobId: string): string {
  return join(project, stateDir(project), "notes", jobId)
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

// The git directory that holds the shared state of the repository: <project>/.git for a plain checkout, the main
// repository's .git for a worktree. Git answers relative to the cwd it ran in, so a relative answer is resolved
// against the project. Anything git cannot answer (no repository, git missing, timeout) means "not a repository".
function gitCommonDir(project: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: project,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    if (!out) return undefined
    return isAbsolute(out) ? out : join(project, out)
  } catch {
    return undefined
  }
}

// Adds .jev-micromanager/ to the repository's local exclude file once; a directory that is no git repository is left alone.
// The job state and the project memory (.opencode/memory/, opencode-agent-memory's place) stay out of git.
//
// The exclude file belongs to the repository, not to the project: a project is often a subdirectory of a monorepo, where
// <project>/.git does not exist at all, and a worktree checkout keeps it outside the project as well. Asking git is the
// only way to find it; guessing left a real run with `?? .jev-micromanager/` in git status and nothing said so.
export function excludeFromGit(project: string): boolean {
  const common = gitCommonDir(project)
  if (!common) return false
  // atomicWrite creates the directory: a bare or hand-made repo can lack .git/info entirely.
  const exclude = join(common, "info", "exclude")
  const before = existsSync(exclude) ? readFileSync(exclude, "utf8") : ""
  // The backlog and the contracts are the user's to commit (design.md §25); everything else in the state directory
  // stays out. A bare "<dir>/" line from before would hide them, and git cannot re-include a file below an excluded
  // directory, so that line is replaced rather than added to. "**/": a pattern with a slash in it is anchored at the
  // repository root, and the project is often a subdirectory of it.
  const dir = stateDir(project)
  const lines = before.split("\n").filter((line) => line.trim() !== `${dir}/` && line.trim() !== dir)
  while (lines.length && lines.at(-1) === "") lines.pop()
  for (const entry of [`**/${dir}/*`, `!**/${dir}/backlog/`, `!**/${dir}/contracts/`, ".opencode/memory/"]) {
    if (!lines.some((line) => line.trim() === entry || line.trim() === entry.replace(/\/$/, ""))) lines.push(entry)
  }
  const after = `${lines.join("\n")}\n`
  if (after !== before) atomicWrite(exclude, after)
  return true
}

// Whether a file in the backlog would be ignored by git all the same: a .gitignore of the project's own that names the
// whole state directory beats the exclude file's re-include. The caller says so once instead of letting drafts vanish.
export function backlogIgnored(project: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", join(stateDir(project), "backlog", "x.md")], { cwd: project, timeout: 3000, stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

export function saveJob(project: string, job: Job): string {
  const path = join(jobsDir(project), `${job.id}.json`)
  atomicWrite(path, JSON.stringify(job, null, 2) + "\n")
  return path
}

// A truncated or half-written file is a job the user cannot see, not a reason to make every other job invisible too.
export function loadJob(project: string, id: string): Job | undefined {
  const path = join(jobsDir(project), `${id}.json`)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Job
  } catch {
    return undefined
  }
}

// Every job of the project, newest first.
export function listJobs(project: string): Job[] {
  const dir = jobsDir(project)
  if (!existsSync(dir)) return []
  const jobs: Job[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue
    const job = loadJob(project, file.slice(0, -".json".length))
    if (job !== undefined) jobs.push(job)
  }
  // a job file without a created stamp is old data, not a crash: it sorts last.
  return jobs.sort((a, b) => String(b.created ?? "").localeCompare(String(a.created ?? "")))
}

// A job's fitness contract, next to the job and readable on its own (src/contract.ts): what "better" means is a
// decision worth reviewing, and its versions are the history of that decision.
export function saveContract(project: string, jobId: string, contract: { id: string; version: number }): string {
  const path = join(project, stateDir(project), "contracts", jobId, `${contract.id}.json`)
  atomicWrite(path, JSON.stringify(contract, null, 2) + "\n")
  return path
}

export function saveNote(project: string, jobId: string, taskId: string, text: string): string {
  const path = join(notesDir(project, jobId), `${taskId}.md`)
  atomicWrite(path, text)
  return path
}

// A job id that sorts by time and stays unique within a second: job-2026-10-04-143005-a1b2.
export function jobId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)
  return `job-${stamp}-${Math.random().toString(16).slice(2, 6)}`
}
