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

export const DIR = ".jev-micromanager"

export function jobsDir(project: string): string {
  return join(project, DIR, "jobs")
}

export function notesDir(project: string, jobId: string): string {
  return join(project, DIR, "notes", jobId)
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
  let current = existsSync(exclude) ? readFileSync(exclude, "utf8") : ""
  for (const entry of [`${DIR}/`, ".opencode/memory/"]) {
    if (current.split("\n").some((line) => line.trim() === entry || line.trim() === entry.slice(0, -1))) continue
    current = `${current}${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`
    atomicWrite(exclude, current)
  }
  return true
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
