// The micromanager's jobs as the TUI shows them (src/tui.tsx): which jobs belong to the session on screen, and each
// one as a short line above the prompt and a task list in the sidebar. Plain data, so it is tested without a TUI.
//
// The user, 2026-10-19: printing the todos into the chat is hard to follow, and the workers of a planned job could
// not be found in the TUI (the host drops parentID on the plugin's session.create). The job file already is the todo
// list, with every task's status and worker sessions; this reads it.

import { costText, detail, ICON } from "./board.ts"
import { settled, startable } from "./continuation.ts"
import { family } from "./roles.ts"
import type { Job, Task, TaskStatus } from "./state.ts"
import { DIR, LEGACY_DIR } from "./store.ts"

const ENDED: readonly Job["phase"][] = ["done", "stopped", "failed"]
const RUNNING: readonly TaskStatus[] = ["running", "gating", "reviewing", "fixing"]
const DONE: readonly TaskStatus[] = ["merged", "passed"]
const FAILED: readonly TaskStatus[] = ["escalated", "blocked"]
// Given up on purpose (stop_task, "Replaces:", a dropped todo): not a failure, and folded away in the sidebar.
const DROPPED: readonly TaskStatus[] = ["cancelled"]

export interface TaskRow {
  readonly id: string
  readonly icon: string
  readonly title: string
  readonly status: TaskStatus
  readonly detail: string
  readonly session?: string // the newest session that worked on it: where "open" goes
  readonly sessions?: readonly string[] // every session of the task, oldest first (the sidebar unfolds them)
  readonly model?: string
  readonly since?: string // when its current run started (ISO), for a running task
  readonly startable: boolean // open, and every task it depends on is merged
  readonly waitsFor: readonly string[] // the tasks it depends on that are not merged yet
  readonly stopped?: boolean // its worker ended without finishing (STOP, a crash, a restart); continuing it runs again
  readonly replacedBy?: string // the task that does it over ("T26", or "job-…/T17" in another job)
  readonly replacement?: TaskStatus // that task's status, when it is known
  readonly cost?: number // what its sessions cost so far (task.usage)
}

export interface JobView {
  readonly id: string
  readonly title: string // the job's goal, as the sidebar heads it
  readonly phase: Job["phase"]
  readonly facilitator?: string
  readonly isolation?: "none" // no git: writers change the folder directly, one at a time
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

// A task's status by its id: "T3" in the job itself, "job-…/T3" in another job the caller knows.
export type Resolve = (id: string) => TaskStatus | undefined

// The status of every task of the given jobs, by "job-…/T3", for replacements across jobs.
export function resolver(jobs: readonly Job[]): Resolve {
  const all = new Map<string, TaskStatus>(jobs.flatMap((j) => j.tasks.map((t): [string, TaskStatus] => [`${j.id}/${t.id}`, t.status])))
  return (id) => all.get(id)
}

// Every session a task ever had, oldest first, without duplicates: the sidebar unfolds them under the task
// (src/tui.tsx JobChecklist, src/switcher.ts taskSessions).
export function allSessions(t: Pick<Task, "session" | "sessions">): readonly string[] {
  return [...new Set([...(t.sessions ?? []), t.session].filter((id): id is string => !!id))]
}

export function view(job: Job, now = Date.now(), resolve: Resolve = () => undefined): JobView {
  const live = job.tasks.filter((t) => !t.undone)
  const ready = new Set(startable(job, resolve).map((t) => t.id))
  const byId = new Map(job.tasks.map((t) => [t.id, t]))
  const statusOf = (id: string) => (id.includes("/") ? resolve(id) : byId.get(id)?.status)
  // A task done over is counted through its replacement, and dropped work not at all.
  const replaced = (t: Task) => (t.replacedBy ? statusOf(t.replacedBy) : undefined)
  const counted = live.filter((t) => !(t.replacedBy && replaced(t) !== undefined) && !DROPPED.includes(t.status))
  const stopped = (t: Task) => RUNNING.includes(t.status) && t.stages.at(-1)?.stage === "end" && t.stages.at(-1)?.result === "fail"
  return {
    id: job.id,
    title: job.rolling ? "Delegated tasks" : job.goal.split("\n")[0]!, // a rolling job's goal names the session id
    phase: job.phase,
    facilitator: job.facilitator,
    ...(job.isolation ? { isolation: job.isolation } : {}),
    done: counted.filter((t) => DONE.includes(t.status)).length,
    running: counted.filter((t) => RUNNING.includes(t.status) && !stopped(t)).length,
    failed: counted.filter((t) => FAILED.includes(t.status)).length,
    total: counted.length,
    rows: live.map((t) => ({
      id: t.id,
      icon: ICON[t.status],
      title: t.title,
      status: t.status,
      detail: detail(t, now),
      session: t.sessions?.at(-1) ?? t.session,
      ...(allSessions(t).length ? { sessions: allSessions(t) } : {}),
      ...(t.model ? { model: t.model } : {}),
      ...(RUNNING.includes(t.status) && startedAt(t) ? { since: startedAt(t) } : {}),
      startable: ready.has(t.id),
      waitsFor: t.dependsOn.filter((id) => { const dep = byId.get(id); return !dep || !settled(job, dep, resolve) }),
      ...(stopped(t) ? { stopped: true } : {}),
      ...(t.replacedBy ? { replacedBy: t.replacedBy } : {}),
      ...(t.replacedBy && replaced(t) ? { replacement: replaced(t) } : {}),
      ...(t.usage?.cost ? { cost: t.usage.cost } : {}),
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
// out. "Waiting" is a task whose worker waits for the user (a permission or a question), read by the TUI. Open tasks
// are TODO when they can start and BLOCKED while a task they need is not merged.
export type Mark = "waiting" | "running" | "stopped" | "failed" | "dropped" | "open" | "done"

export const BOX: Record<Mark, string> = { waiting: "[!]", running: "[▸]", stopped: "[■]", failed: "[✗]", dropped: "[-]", open: "[ ]", done: "[✓]" }

export interface SidebarLine {
  readonly mark: Mark
  readonly id: string
  readonly title: string
  readonly detail?: string // running: "glm 4m"; waiting: what it asks
  readonly session?: string // the newest session that worked on it: where "open" goes
  // Every session of the task, oldest first, so the sidebar can unfold them (src/switcher.ts taskSessions).
  readonly sessions?: readonly string[]
}

export interface SidebarGroup {
  readonly key: "waiting" | "running" | "open" | "stopped" | "done" | "dropped" | "failed"
  readonly mark: Mark
  readonly name: string
  readonly count: number // tasks in this state
  readonly redone?: number // DONE: how many of them are tasks done over by another (not counted in the totals)
  readonly lines: readonly SidebarLine[] // the ones shown: all, except OPEN (the first few)
}

const SHOWN_OPEN = 8

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

// undefined: a task done over by one that has not finished yet; the replacement stands for it.
export function markOf(row: TaskRow, waiting: ReadonlySet<string>): Mark | undefined {
  if (DONE.includes(row.status)) return "done"
  if (row.replacedBy && row.replacement !== undefined) return DONE.includes(row.replacement) ? "done" : undefined
  if (FAILED.includes(row.status)) return "failed"
  if (DROPPED.includes(row.status)) return "dropped"
  if (RUNNING.includes(row.status)) return row.stopped ? "stopped" : row.session && waiting.has(row.session) ? "waiting" : "running"
  return "open"
}

// waiting: the worker sessions that wait for the user, and what they ask ("shell", "a question").
export function sidebarGroups(v: JobView, waiting: ReadonlyMap<string, string> = new Map(), now = Date.now()): SidebarGroup[] {
  const asking = new Set(waiting.keys())
  const line = (r: TaskRow, mark: Mark): SidebarLine => {
    // What it cost so far goes after a running or finished task's line: the job's total is in the header already.
    const cost = costText(r.cost)
    const detail = mark === "running" ? [shortModel(r.model), elapsed(r.since, now), cost].filter(Boolean).join(" ")
      : mark === "waiting" ? waiting.get(r.session!)
      : mark === "open" && !r.startable && r.waitsFor.length ? `⧗ ${r.waitsFor.join(" ")}`
      : mark === "done" && r.replacedBy && !DONE.includes(r.status) ? `↻ ${r.replacedBy.split("/").pop()}`
      : ["done", "stopped", "failed"].includes(mark) && cost ? cost
      : undefined
    return { mark, id: r.id, title: r.title, ...(detail ? { detail } : {}), ...(r.session ? { session: r.session } : {}), ...(r.sessions?.length ? { sessions: r.sessions } : {}) }
  }
  const of = (mark: Mark) => v.rows.filter((r) => markOf(r, asking) === mark)
  // Open tasks in one group: the ones that can start now, then those that wait for another task (their line says so).
  // The user, 2026-10-26: "blocked" was the wrong word for a task that is simply next.
  const open = [...of("open").filter((r) => r.startable), ...of("open").filter((r) => !r.startable)]
  const groups: SidebarGroup[] = [
    { key: "waiting", mark: "waiting", name: "WAITING FOR YOU", count: of("waiting").length, lines: of("waiting").map((r) => line(r, "waiting")) },
    { key: "running", mark: "running", name: "RUNNING", count: of("running").length, lines: of("running").map((r) => line(r, "running")) },
    { key: "open", mark: "open", name: "OPEN", count: open.length, lines: open.slice(0, SHOWN_OPEN).map((r) => line(r, "open")) },
    { key: "stopped", mark: "stopped", name: "STOPPED", count: of("stopped").length, lines: of("stopped").map((r) => line(r, "stopped")) },
    { key: "done", mark: "done", name: "DONE", count: of("done").length, redone: of("done").filter((r) => !DONE.includes(r.status)).length, lines: of("done").map((r) => line(r, "done")) },
    { key: "dropped", mark: "dropped", name: "DROPPED", count: of("dropped").length, lines: of("dropped").map((r) => line(r, "dropped")) },
    { key: "failed", mark: "failed", name: "FAILED", count: of("failed").length, lines: of("failed").map((r) => line(r, "failed")) },
  ]
  return groups.filter((g) => g.count > 0)
}

// The counts under the job's name: "[!]1 [▸]3 [ ]28 [✓]8 [✗]2", in the order the groups are drawn.
export function sidebarCounts(groups: readonly SidebarGroup[]): { mark: Mark; text: string }[] {
  const order: Mark[] = ["waiting", "running", "open", "stopped", "done", "failed"] // dropped work is not counted
  return order.flatMap((mark) => {
    const count = groups.filter((x) => x.mark === mark).reduce((n, g) => n + g.count - (g.redone ?? 0), 0)
    return count ? [{ mark, text: `${BOX[mark]}${count}` }] : []
  })
}

// The sidebar's jobs of one session: the newest job with tasks in full, every other one as a folded line (the user,
// 2026-10-20: a session with an old planned job and its own delegated tasks showed two FAILED groups).
export function sessionJobs(views: readonly JobView[]): { main?: JobView; others: JobView[] } {
  const shown = views.filter((v) => v.total > 0)
  return { main: shown[0], others: shown.slice(1) }
}

// A folded job's line: "older 8d1c · 9/41 · waits for you".
export function foldedLine(v: JobView): string {
  const state = v.phase === "ask_user" ? "waits for you" : v.running ? `${v.running} running` : v.phase
  return `older ${v.id.split("-").pop()} · ${v.done}/${v.total} · ${state}`
}
