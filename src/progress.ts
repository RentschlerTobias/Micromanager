// The micromanager's jobs as the TUI shows them (src/tui.tsx): which jobs belong to the session on screen, and each
// one as a short line above the prompt and a task list in the sidebar. Plain data, so it is tested without a TUI.
//
// The user, 2026-10-19: printing the todos into the chat is hard to follow, and the workers of a planned job could
// not be found in the TUI (the host drops parentID on the plugin's session.create). The job file already is the todo
// list, with every task's status and worker sessions; this reads it.

import { detail, ICON } from "./board.ts"
import type { Job, Task, TaskStatus } from "./state.ts"
import { DIR, LEGACY_DIR } from "./store.ts"

const ENDED: readonly Job["phase"][] = ["done", "stopped", "failed"]
const RUNNING: readonly TaskStatus[] = ["running", "gating", "reviewing", "fixing"]
const DONE: readonly TaskStatus[] = ["merged", "passed"]
const FAILED: readonly TaskStatus[] = ["escalated", "cancelled", "blocked"]

export interface TaskRow {
  readonly id: string
  readonly icon: string
  readonly title: string
  readonly status: TaskStatus
  readonly detail: string
  readonly session?: string // the newest session that worked on it: where "open" goes
}

export interface JobView {
  readonly id: string
  readonly phase: Job["phase"]
  readonly facilitator?: string
  readonly done: number
  readonly running: number
  readonly failed: number
  readonly total: number
  readonly rows: readonly TaskRow[]
}

// The project a session works in: a worker's worktree lies inside the project, under .micromanager/worktrees/ (or the
// directory's old name, in a project from before the rename).
export function projectOf(directory: string): string {
  const at = [DIR, LEGACY_DIR].map((dir) => directory.indexOf(`/${dir}/`)).find((i) => i !== -1)
  return at === undefined ? directory : directory.slice(0, at)
}

const worksOn = (task: Task, sessionID: string) => task.session === sessionID || (task.sessions ?? []).includes(sessionID)

// The jobs of the session on screen: the ones it runs as the micromanager, or the one its worker works for. Running
// jobs first; an ended job only while it is the newest of the session, so its result stays in view.
export function jobsFor(jobs: readonly Job[], sessionID: string): Job[] {
  const own = jobs
    .filter((j) => j.facilitator === sessionID || j.tasks.some((t) => worksOn(t, sessionID)))
    .sort((a, b) => b.updated.localeCompare(a.updated))
  const open = own.filter((j) => !ENDED.includes(j.phase))
  return open.length ? open : own.slice(0, 1)
}

export function view(job: Job, now = Date.now()): JobView {
  const live = job.tasks.filter((t) => !t.undone)
  return {
    id: job.id,
    phase: job.phase,
    facilitator: job.facilitator,
    done: live.filter((t) => DONE.includes(t.status)).length,
    running: live.filter((t) => RUNNING.includes(t.status)).length,
    failed: live.filter((t) => FAILED.includes(t.status)).length,
    total: live.length,
    rows: live.map((t) => ({
      id: t.id,
      icon: ICON[t.status],
      title: t.title,
      status: t.status,
      detail: detail(t, now),
      session: t.sessions?.at(-1) ?? t.session,
    })),
  }
}

// The line above the prompt: "job-… · 7/19 ✔ · 3 ▶ · 1 ✖ · execute".
export function summaryLine(v: JobView): string {
  const parts = [`${v.done}/${v.total} ✔`, ...(v.running ? [`${v.running} ▶`] : []), ...(v.failed ? [`${v.failed} ✖`] : [])]
  return `${v.id} · ${parts.join(" · ")} · ${v.phase}`
}

// The choices of /tasks: back to the micromanager from a worker, then every task with a session to open.
export function taskChoices(views: readonly JobView[], sessionID: string): { title: string; value: string; description?: string; category: string }[] {
  const out: { title: string; value: string; description?: string; category: string }[] = []
  for (const v of views) {
    if (v.facilitator && v.facilitator !== sessionID) out.push({ title: "↑ the micromanager", value: v.facilitator, category: v.id })
    for (const r of v.rows) {
      out.push({ title: `${r.icon} ${r.id} ${r.title}`, value: r.session ?? "", description: r.session ? r.detail || r.status : `${r.status}, no session yet`, category: v.id })
    }
  }
  return out
}

const DETAIL = 60 // a given-up task's reason can be a whole check command; the sidebar shows its start

export interface TodoLine {
  readonly text: string
  readonly detail?: string // what a running or stopped task does or why it stopped; open and done ones have none
  readonly muted?: boolean
}

// The sidebar's todo list, short enough for a job of forty tasks: what runs and what stopped first, then the next few
// open tasks, and the done ones as a count (live: the full list of 42 pushed everything else out of the sidebar).
export function todoLines(v: JobView, open = 6): TodoLine[] {
  const by = (statuses: readonly TaskStatus[]) => v.rows.filter((r) => statuses.includes(r.status))
  const cut = (text: string) => (text.length > DETAIL ? `${text.slice(0, DETAIL - 1)}…` : text)
  const line = (r: TaskRow, detail = true): TodoLine => ({ text: `${r.icon} ${r.id} ${r.title}`, ...(detail && r.detail ? { detail: cut(r.detail) } : {}) })
  const waiting = v.rows.filter((r) => !RUNNING.includes(r.status) && !FAILED.includes(r.status) && !DONE.includes(r.status))
  const done = by(DONE)
  return [
    ...by(RUNNING).map((r) => line(r)),
    ...by(FAILED).map((r) => line(r)),
    ...waiting.slice(0, open).map((r) => line(r, false)),
    ...(waiting.length > open ? [{ text: `  … ${waiting.length - open} more open`, muted: true }] : []),
    ...(done.length ? [{ text: `✔ ${done.length} done`, muted: true }] : []),
  ]
}
