// The micromanager's jobs as the TUI shows them (src/tui.tsx): which jobs belong to the session on screen, and each
// one as a short line above the prompt and a task list in the sidebar. Plain data, so it is tested without a TUI.
//
// The user, 2026-10-19: printing the todos into the chat is hard to follow, and the workers of a planned job could
// not be found in the TUI (the host drops parentID on the plugin's session.create). The job file already is the todo
// list, with every task's status and worker sessions; this reads it.

import { detail, ICON } from "./board.ts"
import { startable } from "./continuation.ts"
import { family } from "./roles.ts"
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
  readonly model?: string
  readonly since?: string // when its current run started (ISO), for a running task
  readonly startable: boolean // open, and every task it depends on is merged
}

export interface JobView {
  readonly id: string
  readonly title: string // the job's goal, as the sidebar heads it
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

// When a running task's current run started: its last start (delegate or classify), else its last stage.
function startedAt(task: Task): string | undefined {
  const starts = task.stages.filter((s) => s.stage === "delegate" || s.stage === "classify")
  return (starts.at(-1) ?? task.stages.at(-1))?.at
}

export function view(job: Job, now = Date.now()): JobView {
  const live = job.tasks.filter((t) => !t.undone)
  const ready = new Set(startable(job).map((t) => t.id))
  return {
    id: job.id,
    title: job.rolling ? "Delegated tasks" : job.goal.split("\n")[0]!, // a rolling job's goal names the session id
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
      ...(t.model ? { model: t.model } : {}),
      ...(RUNNING.includes(t.status) && startedAt(t) ? { since: startedAt(t) } : {}),
      startable: ready.has(t.id),
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

// The sidebar: the job as a checklist, grouped by what needs attention (the user, 2026-10-19: what runs, what is done
// and what is open has to be clear at a glance). Groups in a fixed order, each in plan order; an empty group is left
// out. "Waiting" is a task whose worker waits for the user (a permission or a question), read by the TUI.
export type Mark = "waiting" | "running" | "failed" | "open" | "done"

export const BOX: Record<Mark, string> = { waiting: "[!]", running: "[▸]", failed: "[✗]", open: "[ ]", done: "[✓]" }

export interface SidebarLine {
  readonly mark: Mark
  readonly id: string
  readonly title: string
  readonly detail?: string // running: "glm 4m"; waiting: what it asks
  readonly session?: string
}

export interface SidebarGroup {
  readonly mark: Mark
  readonly name: string
  readonly count: number // tasks in this state
  readonly lines: readonly SidebarLine[] // the ones shown: all, except NEXT (the first few) and DONE (folded)
}

const NEXT = 3

// "4m", "9s", "1.2h": how long a task has been running.
export function elapsed(since: string | undefined, now = Date.now()): string {
  if (!since) return ""
  const s = Math.max(0, Math.round((now - Date.parse(since)) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${(s / 3600).toFixed(1)}h`
}

// A model as the sidebar names it: its family, at most five letters ("glm", "mimo", "deeps", "gemin").
export function shortModel(model: string | undefined): string {
  return model ? family(model).slice(0, 5) : ""
}

export function markOf(row: TaskRow, waiting: ReadonlySet<string>): Mark {
  if (DONE.includes(row.status)) return "done"
  if (FAILED.includes(row.status)) return "failed"
  if (RUNNING.includes(row.status)) return row.session && waiting.has(row.session) ? "waiting" : "running"
  return "open"
}

// waiting: the worker sessions that wait for the user, and what they ask ("shell", "a question").
export function sidebarGroups(v: JobView, waiting: ReadonlyMap<string, string> = new Map(), now = Date.now()): SidebarGroup[] {
  const asking = new Set(waiting.keys())
  const line = (r: TaskRow, mark: Mark): SidebarLine => {
    const detail = mark === "running" ? `${shortModel(r.model)} ${elapsed(r.since, now)}`.trim() : mark === "waiting" ? waiting.get(r.session!) : undefined
    return { mark, id: r.id, title: r.title, ...(detail ? { detail } : {}), ...(r.session ? { session: r.session } : {}) }
  }
  const of = (mark: Mark) => v.rows.filter((r) => markOf(r, asking) === mark)
  const open = of("open")
  const next = [...open.filter((r) => r.startable), ...open.filter((r) => !r.startable)].slice(0, NEXT)
  const groups: SidebarGroup[] = [
    { mark: "waiting", name: "WAITING FOR YOU", count: of("waiting").length, lines: of("waiting").map((r) => line(r, "waiting")) },
    { mark: "running", name: "RUNNING", count: of("running").length, lines: of("running").map((r) => line(r, "running")) },
    { mark: "failed", name: "FAILED", count: of("failed").length, lines: of("failed").map((r) => line(r, "failed")) },
    { mark: "open", name: "NEXT", count: open.length, lines: open.filter((r) => next.includes(r)).map((r) => line(r, "open")) },
    { mark: "done", name: "DONE", count: of("done").length, lines: of("done").map((r) => line(r, "done")) },
  ]
  return groups.filter((g) => g.count > 0)
}

// The counts under the job's name: "[✓]8 [▸]3 [!]1 [✗]2 [ ]28".
export function sidebarCounts(groups: readonly SidebarGroup[]): { mark: Mark; text: string }[] {
  const order: Mark[] = ["done", "running", "waiting", "failed", "open"]
  return order.flatMap((mark) => {
    const g = groups.find((x) => x.mark === mark)
    return g ? [{ mark, text: `${BOX[mark]}${g.count}` }] : []
  })
}
