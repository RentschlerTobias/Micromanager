// A job's switches: whether it was started, how it runs (auto-continue, parallel, review), whether the user stopped it,
// and why auto-continue pauses. Kept in .micromanager/control/<job>.json, apart from the job file: the TUI writes it
// (the sidebar toggles and STOP, src/tui.tsx) while the server owns the job file and saves it whenever a worker moves
// on, so one shared file would lose writes. The server reads it at every step, cached on mtime and size.
//
// The user, 2026-10-20: the options are asked once the plan stands, in the form that starts the job, shown in the
// sidebar and switched there; STOP halts everything at once.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { DEFAULT_OPTIONS, type JobOptions } from "./forms.ts"
import type { Job } from "./state.ts"
import { stateDir } from "./store.ts"

export interface Control extends Partial<JobOptions> {
  readonly started?: boolean // the user said Start in the start form (or the job predates the form)
  readonly stopped?: boolean // STOP: nothing starts and nothing is woken until the user starts it again
  readonly pause?: string // why auto-continue does not wake the micromanager now: "waits for you", "no progress"
  readonly wakes?: number // auto-continue wakes in a row without progress
  readonly seen?: string // the job's progress at the last wake ("done:started"), to tell a wake without progress
}

export function controlPath(project: string, jobId: string): string {
  return join(project, stateDir(project), "control", `${jobId}.json`)
}

// The options of the project's last started job: what the start form names as "on last time".
export function lastPath(project: string): string {
  return join(project, stateDir(project), "control", "last.json")
}

const cache = new Map<string, { stamp: string; value: unknown }>()

function readJson<T>(path: string, fallback: T): T {
  let stamp: string
  try {
    const st = statSync(path)
    stamp = `${st.mtimeMs}:${st.size}`
  } catch {
    return fallback
  }
  const hit = cache.get(path)
  if (hit?.stamp === stamp) return hit.value as T
  let value: T
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    value = fallback // a file being written right now: the next read gets it
  }
  cache.set(path, { stamp, value })
  return value
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

export function loadControl(project: string, jobId: string): Control {
  return readJson<Control>(controlPath(project, jobId), {})
}

// Merges the given fields into the job's control, so the TUI and the server each change only what they mean to.
export function updateControl(project: string, jobId: string, change: Partial<Control>): Control {
  const next = { ...loadControl(project, jobId), ...change }
  writeJson(controlPath(project, jobId), next)
  return next
}

export function lastOptions(project: string): JobOptions {
  return { ...DEFAULT_OPTIONS, ...readJson<Partial<JobOptions>>(lastPath(project), {}) }
}

export function saveLastOptions(project: string, options: JobOptions): void {
  writeJson(lastPath(project), options)
}

// Whether a job may start writers: the user started it, or it ran before the start form existed (a task beyond an
// open todo), or it is a planned job the user started with run_job.
export function isStarted(job: Job, control: Control): boolean {
  if (control.stopped) return false
  if (control.started !== undefined) return control.started
  return Boolean(job.native) || job.tasks.some((t) => !["pending", "ready", "planned"].includes(t.status))
}

// The job's options as they apply now: what the user chose, else what they chose last time.
export function optionsOf(control: Control, last: JobOptions = DEFAULT_OPTIONS): JobOptions {
  return { auto: control.auto ?? last.auto, parallel: control.parallel ?? last.parallel, review: control.review ?? last.review }
}
