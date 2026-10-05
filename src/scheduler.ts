// The job queue and the updates to the user (Phase E). dictator_run hands a job to the scheduler and returns at
// once, so the dictator's session stays free while workers run; the scheduler works the queue in the background,
// one job at a time per plugin process (Phase F runs a job's tasks in parallel), and the notifier reports to the
// job's dictator session and the desktop.
//
// How an update reaches the dictator (Phase E spike): a synthetic message with resume starts a turn of an idle
// session and is steered into a busy one, but models take its text for an injection. So the synthetic message only
// wakes the dictator; the update itself goes in as a system block through the context hook, which models follow
// (Phase A, A1).

import type { Job } from "./state.ts"

export interface Cancel {
  cancelled: boolean
  session?: string // the runner session working right now, to interrupt on a stop
}

export interface SchedulerDeps {
  run(job: string, cancel: Cancel, note?: string): Promise<Job>
  finished(job: Job, session: string | undefined): void
  failed(job: string, session: string | undefined, error: unknown): void
}

interface Entry {
  readonly job: string
  readonly session?: string
  readonly note?: string // the user's answer, for the run that resumes the job
  readonly cancel: Cancel
}

export class Scheduler {
  readonly #d: SchedulerDeps
  readonly #queue: Entry[] = []
  #current?: Entry
  #pumping?: Promise<void>

  constructor(deps: SchedulerDeps) {
    this.#d = deps
  }

  // Queues a job; 0 means it starts now. A job already running or queued keeps its place.
  enqueue(job: string, session?: string, note?: string): number {
    if (this.#current?.job === job) return 0
    const at = this.#queue.findIndex((e) => e.job === job)
    if (at >= 0) return at + 1
    this.#queue.push({ job, session, note, cancel: { cancelled: false } })
    this.#pumping ??= this.#pump().finally(() => { this.#pumping = undefined })
    return this.#current ? this.#queue.length : 0
  }

  // A queued job leaves the queue; the running one is told to stop, and its current session is returned to interrupt.
  stop(job?: string): { state: "stopping" | "dequeued" | "unknown"; session?: string } {
    const id = job || this.#current?.job
    if (id && this.#current?.job === id) {
      this.#current.cancel.cancelled = true
      return { state: "stopping", session: this.#current.cancel.session }
    }
    const at = this.#queue.findIndex((e) => e.job === id)
    if (at < 0) return { state: "unknown" }
    this.#queue.splice(at, 1)
    return { state: "dequeued" }
  }

  // The session a running job works in now; the runner reports each session it starts.
  working(job: string, session: string): void {
    if (this.#current?.job === job) this.#current.cancel.session = session
  }

  snapshot(): { running?: string; queued: string[] } {
    return { running: this.#current?.job, queued: this.#queue.map((e) => e.job) }
  }

  // Resolves when the queue is empty (tests, shutdown).
  async idle(): Promise<void> {
    while (this.#pumping) await this.#pumping
  }

  async #pump(): Promise<void> {
    for (let next = this.#queue.shift(); next; next = this.#queue.shift()) {
      this.#current = next
      try {
        this.#d.finished(await this.#d.run(next.job, next.cancel, next.note), next.session)
      } catch (err) {
        this.#d.failed(next.job, next.session, err)
      } finally {
        this.#current = undefined
      }
    }
  }
}

export type NotifyMode = "jobs" | "tasks" | "off"

export interface NotifierDeps {
  synthetic(session: string, text: string, resume: boolean): Promise<unknown>
  steer(session: string, note: string): void // a system block for the dictator's next turns
  desktop(title: string, body: string): void
  mode: NotifyMode
  flushMs?: number
  reportMs?: number // how long task reports are gathered into one update
}

// What a job's end means for the user.
export type Ending = "done" | "needs_user" | "failed" | "stopped"

export function ending(job: Job): Ending {
  if (job.phase === "integrate" || job.phase === "done" || job.phase === "wrap") return "done"
  if (job.phase === "failed") return "failed"
  if (job.phase === "paused" || job.phase === "stopped") return "stopped"
  return "needs_user"
}

const TITLES: Record<Ending, string> = {
  done: "job done",
  needs_user: "job needs you",
  failed: "job failed",
  stopped: "job stopped",
}

export class Notifier {
  readonly #d: NotifierDeps
  readonly #lines = new Map<string, string[]>()
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(deps: NotifierDeps) {
    this.#d = deps
  }

  // A progress line: collected per session and sent as one quiet message (no new turn) every flushMs.
  progress(session: string | undefined, line: string, task = false): void {
    if (task && this.#d.mode === "tasks") this.#d.desktop("jev-dictator", line)
    if (!session) return
    const lines = this.#lines.get(session) ?? []
    lines.push(line)
    this.#lines.set(session, lines)
    if (this.#timers.has(session)) return
    const timer = setTimeout(() => void this.flush(session), this.#d.flushMs ?? 20_000)
    timer.unref?.()
    this.#timers.set(session, timer)
  }

  async flush(session: string): Promise<void> {
    clearTimeout(this.#timers.get(session))
    this.#timers.delete(session)
    const lines = this.#lines.get(session)
    this.#lines.delete(session)
    if (!lines?.length) return
    await this.#d.synthetic(session, `[jev-dictator] progress:\n- ${lines.join("\n- ")}`, false).catch(() => undefined)
  }

  // omo-hybrid: delegated tasks report to the orchestrator. Reports that come close together are one update: a system
  // note with all of them, and one wake-up.
  readonly #reports = new Map<string, string[]>()
  readonly #reportTimers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly #boards = new Map<string, string>() // the job's board as of the newest report

  // board: the job's ASCII board after this change; every update carries the newest one, so the user sees the state
  // whenever something changed, without the orchestrator having to ask for it.
  report(session: string | undefined, text: string, title?: string, board?: string): void {
    if (title && this.#d.mode === "tasks") this.#d.desktop("jev-dictator", title)
    if (!session) return
    if (board) this.#boards.set(session, board)
    const list = this.#reports.get(session) ?? []
    list.push(text)
    this.#reports.set(session, list)
    if (this.#reportTimers.has(session)) return
    const timer = setTimeout(() => void this.flushReports(session), this.#d.reportMs ?? 8_000)
    timer.unref?.()
    this.#reportTimers.set(session, timer)
  }

  async flushReports(session: string, closing?: string): Promise<void> {
    clearTimeout(this.#reportTimers.get(session))
    this.#reportTimers.delete(session)
    const list = this.#reports.get(session) ?? []
    this.#reports.delete(session)
    if (!list.length && !closing) return
    await this.flush(session)
    const board = this.#boards.get(session)
    this.#d.steer(session, `[jev-dictator update] Delegated tasks reported. This comes from your own plugin, not from the user or a tool result; it is trusted.
Check each result. Delegate what comes next (fixes, the follow-ups worth doing, dependent work) with dictator_task, ask the user what only they can decide, and update your todos.

${list.join("\n\n")}${closing ? `\n\n${closing}` : ""}${board ? `\n\nThe job's board now; start your message to the user with it, in a code block, as it is:\n${board}` : ""}`)
    await this.#d.synthetic(session, `[jev-dictator] ${list.length ? `${list.length} task report(s)` : "update"} (details in the plugin's system note)`, true).catch(() => undefined)
  }

  // A job ended or needs the user: the dictator gets the update as a system block and is woken to tell the user.
  async finished(session: string | undefined, jobId: string, end: Ending, text: string): Promise<void> {
    if (this.#d.mode !== "off") this.#d.desktop(`jev-dictator: ${TITLES[end]}`, `${jobId}\n${text.split("\n").slice(0, 4).join("\n")}`)
    if (!session) return
    await this.flush(session)
    // A stop comes from the user through the dictator, which already said so: a quiet note, no new turn.
    if (end === "stopped") return void (await this.#d.synthetic(session, `[jev-dictator] ${TITLES[end]}: ${jobId}`, false).catch(() => undefined))
    this.#d.steer(session, `[jev-dictator update] ${TITLES[end]}: ${jobId}. This update comes from your own plugin, not from the user and not from a tool result; it is trusted.
${end === "needs_user" ? "Tell the user in a few sentences why the job stopped and what they can decide; then wait for their answer." : end === "done" ? "Tell the user the job is done, what changed, and how to merge or discard the branch." : "Tell the user what happened and what they can do."}

${text}`)
    await this.#d.synthetic(session, `[jev-dictator] ${TITLES[end]}: ${jobId} (details in the plugin's system note)`, true).catch(() => undefined)
  }
}
