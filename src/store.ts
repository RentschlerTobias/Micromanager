// Where jobs live: <project>/.jev-dictator/jobs/<id>.json, one file per job, written atomically.
//
// Inside the project, so workers can read their notes without an external_directory ask; kept out of git through
// .git/info/exclude, which is local and needs no .gitignore change (design.md §8.2).

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import type { Job } from "./state.ts"

export const DIR = ".jev-dictator"

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

// Adds .jev-dictator/ to the repository's local exclude file once; a directory that is no git repository is left alone.
export function excludeFromGit(project: string): boolean {
  const exclude = join(project, ".git", "info", "exclude")
  if (!existsSync(join(project, ".git"))) return false
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : ""
  if (current.split("\n").some((line) => line.trim() === `${DIR}/` || line.trim() === DIR)) return true
  atomicWrite(exclude, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${DIR}/\n`)
  return true
}

export function saveJob(project: string, job: Job): string {
  const path = join(jobsDir(project), `${job.id}.json`)
  atomicWrite(path, JSON.stringify(job, null, 2) + "\n")
  return path
}

export function loadJob(project: string, id: string): Job | undefined {
  const path = join(jobsDir(project), `${id}.json`)
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, "utf8")) as Job
}

// Every job of the project, newest first.
export function listJobs(project: string): Job[] {
  const dir = jobsDir(project)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Job)
    .sort((a, b) => b.created.localeCompare(a.created))
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
