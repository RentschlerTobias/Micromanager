// Native delegation: the micromanager starts workers with OpenCode's own subagent tool, in the background, and the
// plugin keeps each writer in its own git worktree (spike of 2026-10-05, docs/plan.md).
//
// - Before the micromanager's subagent call runs, delegate() turns it into a task of the session's job: the "Files:"
//   and "Checks:" lines at the end of its prompt are the task's write scope and checks, a writer gets its own
//   worktree off the session branch, a reader works in the session branch's worktree, and the prompt becomes the
//   worker's brief.
// - OpenCode creates the child in the micromanager's directory (a child always starts in its parent's), and the
//   plugin moves it in the child's first prompt hook (claim), before any tool runs.
// - The writer ends through finish_task: the plugin runs the checks in the worktree, commits, and merges through the
//   merge train; a failure goes back to the worker, which fixes it in the same turn loop. OpenCode then notifies the
//   micromanager with the worker's report, after the merge.
//
// Every plugin instance of one server shares this state (a moved worker is served by the instance of its worktree).

import { Graphs, graphBrief, queryGraph, type Graph } from "./graph.ts"
import { HEADER } from "./hooks.ts"
import {
  changedFiles, commitTask, exec as defaultExec, fastForward, prepareIntegration, prepareTaskWorktree, rebaseTask, removeTaskWorktree, repoRel, runGate, taskDir,
  type Exec, type GateResult,
} from "./integration.ts"
import { addDelegated, checkSetProblems, parseFiles } from "./plan.ts"
import { WRITERS } from "./profile.ts"
import { FIX_ROUNDS } from "./watchdog.ts"
import { ROLES, roleByAgent, type Role } from "./roles.ts"
import { moveTask, newJob, moveJob, stage, type Job, type Task } from "./state.ts"
import { excludeFromGit, jobId, listJobs, saveJob } from "./store.ts"
import { skillLine } from "./brief.ts"

// The first line OpenCode puts before a new subagent's prompt; how the prompt hook tells a child's first turn.
export const CHILD_PREFIX = "You are a subagent spawned by another session."

export class DelegationError extends Error {}

export interface Delegation {
  readonly body: string // the prompt without the Files, Checks and Replaces lines
  readonly files: string // as written, parsed by parseFiles
  readonly checks: string[]
  readonly replaces: string[] // tasks this one deliberately starts over ("Replaces: T5")
}

// The "Files:" and "Checks:" lines of a delegation, wherever they stand; the checks go on over the following lines
// until a blank line or another such line.
export function parseDelegation(prompt: string): Delegation {
  const body: string[] = []
  const checks: string[] = []
  const replaces: string[] = []
  let files = ""
  let inChecks = false
  for (const line of prompt.split("\n")) {
    const f = line.match(/^\s*files:\s*(.*)$/i)
    const c = line.match(/^\s*checks:\s*(.*)$/i)
    const r = line.match(/^\s*replaces:\s*(.*)$/i)
    if (r) {
      replaces.push(...r[1]!.split(/[\s,]+/).map((id) => id.trim().toUpperCase()).filter(Boolean))
      inChecks = false
    } else if (f) {
      files = f[1]!.trim()
      inChecks = false
    } else if (c) {
      inChecks = true
      if (c[1]!.trim()) checks.push(c[1]!.trim())
    } else if (inChecks && line.trim()) checks.push(line.trim().replace(/^[-*]\s+/, ""))
    else {
      inChecks = false
      body.push(line)
    }
  }
  return { body: body.join("\n").trim(), files, checks, replaces }
}

// How much two task texts are about the same thing: the share of their words they have in common (Jaccard over the
// words of three letters or more, without the filler). "Remove dashed pill on lanes slide" and "Delete dashed pill on
// lanes slide" share four of six: the same work, delegated twice in a live run (2026-10-07).
const FILLER = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "its", "are", "was", "not", "but", "you", "your"])
function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9äöüß]+/).filter((w) => w.length > 2 && !FILLER.has(w)))
}
export function similarity(a: string, b: string): number {
  const x = words(a)
  const y = words(b)
  if (x.size === 0 || y.size === 0) return 0
  let shared = 0
  for (const w of x) if (y.has(w)) shared++
  return shared / (x.size + y.size - shared)
}
const SAME_WORK = 0.5 // a writer on the same files with a title or brief this close is the same work
const SAME_QUESTION = 0.8 // a reader with a brief this close asks the same question
const LIVE = new Set(["running", "gating", "fixing"])
const UNFINISHED = new Set(["blocked", "escalated", "cancelled"])

interface Entry {
  readonly project: string
  readonly jobId: string
  taskId: string
  readonly parent: string // the micromanager session
  readonly writer: boolean
  dir: string // where the worker works: its own worktree (writer) or the session branch's (reader), at the project offset
  worktree: string // the git worktree root of dir: what git commands need
  rel: string // the project directory's offset inside worktree; "" when the project is the repository root
  branch?: string // a writer's task branch
  removed?: boolean // the writer's worktree was removed after its merge
  session?: string // the child session, once claimed
  checks: string[]
  graph?: boolean // an explorer with a code graph of its directory (the code_graph tool)
  ended?: boolean // its session ended; a writer that did not merge stays "running" until it is continued or swept
}

export interface NativeDeps {
  readonly exec?: Exec
  readonly installedSkills?: ReadonlySet<string>
  readonly graphs?: Pick<Graphs, "get"> // the code graph an explorer starts from
}

export interface Delegated {
  readonly task: Task
  readonly job: Job
  readonly prompt: string // the worker's brief
  readonly notes: readonly string[] // what the plugin logs at info level: the project offset, uncommitted state
}

export class Native {
  readonly #exec: Exec
  readonly #skills: ReadonlySet<string>
  readonly #graphs: Pick<Graphs, "get">
  readonly #entries = new Map<string, Entry>() // "<job>/<task>" -> entry
  readonly #bySession = new Map<string, string>() // child session -> its entry's key
  readonly #jobs = new Map<string, Job>() // "<project>\0<job>" -> the live job
  readonly #trains = new Map<string, Promise<unknown>>() // per job: one merge at a time
  readonly #waiting = new Set<string>() // child sessions whose end is awaited
  readonly #delegating = new Map<string, Promise<unknown>>() // per micromanager session: one delegation at a time

  constructor(deps: NativeDeps = {}) {
    this.#exec = deps.exec ?? defaultExec
    this.#skills = deps.installedSkills ?? new Set()
    this.#graphs = deps.graphs ?? new Graphs(this.#exec)
  }

  // The micromanager session's job: made at its first delegation, kept until the session ends.
  job(project: string, parent: string): Job {
    const live = [...this.#jobs.values()].find((j) => j.facilitator === parent && j.rolling && this.#jobs.get(key(project, j.id)) === j)
    if (live) return live
    const found = listJobs(project).find((j) => j.facilitator === parent && j.rolling && !["done", "stopped", "failed"].includes(j.phase))
    const job = found ?? newJob(jobId(), `the delegated tasks of micromanager session ${parent}`)
    if (!found) {
      for (const p of ["triage", "plan", "plan_gate", "execute"] as const) moveJob(job, p)
      job.rolling = true
      job.facilitator = parent
      saveJob(project, job)
    }
    this.#jobs.set(key(project, job.id), job)
    return job
  }

  // After a restart: the workers of the project's open jobs, rebuilt from the job files. Everything the plugin knew of
  // them lived in memory, so a worker continued after a restart (reboot, 2026-10-14) answered finish_task with "no
  // task", and the duplicate check could not see the change it had left in its worktree. Every session found here is
  // over, since the restart ended it; resume() makes it live again when the micromanager continues it. Returns the
  // adopted "<job>/<task>" keys.
  adopt(project: string): string[] {
    const adopted: string[] = []
    for (const job of listJobs(project)) {
      if (!job.rolling || !job.facilitator || ["done", "stopped", "failed"].includes(job.phase)) continue
      const known = this.#jobs.get(key(project, job.id))
      if (known) continue
      this.#jobs.set(key(project, job.id), job)
      for (const task of job.tasks) {
        const k = `${job.id}/${task.id}`
        if (!task.session || this.#entries.has(k)) continue
        const writer = WRITERS.has(task.role)
        const worktree = writer ? task.worktree : job.integrationWorktree
        const rel = (writer ? task.worktreeRel : job.integrationRel) ?? job.integrationRel ?? ""
        const verify = job.acceptance.filter((a) => task.acceptance.includes(a.id)).map((a) => a.verify).filter((v): v is string => Boolean(v))
        const entry: Entry = {
          project,
          jobId: job.id,
          taskId: task.id,
          parent: job.facilitator,
          writer,
          dir: worktree ? taskDir(worktree, rel) : project,
          worktree: worktree ?? job.integrationWorktree ?? project,
          rel,
          branch: writer ? task.branch : undefined,
          removed: writer && !task.worktree,
          session: task.session,
          checks: verify.flatMap((v) => v.split(" && ")).map((c) => c.trim()).filter(Boolean),
          ended: true,
        }
        this.#entries.set(k, entry)
        for (const s of new Set([task.session, ...(task.sessions ?? [])])) this.#bySession.set(s, k)
        adopted.push(k)
      }
    }
    return adopted
  }

  // A new subagent call of the micromanager: the task, its worktree and the worker's brief. Throws a
  // DelegationError the micromanager can act on when the call is not a valid delegation. Calls of one message come
  // at the same time; they go one after another (live test: two made the session branch at once, and one failed).
  delegate(project: string, parent: string, input: { agent: string; description: string; prompt: string }, model: string): Promise<Delegated> {
    const next = (this.#delegating.get(parent) ?? Promise.resolve()).then(() => this.#delegate(project, parent, input, model))
    this.#delegating.set(parent, next.catch(() => undefined))
    return next
  }

  async #delegate(project: string, parent: string, input: { agent: string; description: string; prompt: string }, model: string): Promise<Delegated> {
    const role = roleByAgent(input.agent)
    if (!role) throw new DelegationError(`Not started: use one of the role agents (${ROLES.map((r) => r.agent).join(", ")}), not ${input.agent || "none"}.`)
    const d = parseDelegation(input.prompt)
    const parsed = parseFiles(d.files, project)
    if (parsed.problem) throw new DelegationError(`Not started: ${parsed.problem}`)
    const writer = WRITERS.has(role.id)
    if (writer && !parsed.files.length) throw new DelegationError(`Not started: a ${role.agent} changes files; end the prompt with a line "Files: <the project paths it may change>" and a line "Checks: <shell command>".`)
    if (!writer && parsed.files.length) throw new DelegationError(`Not started: ${role.agent} only reads; leave out the Files line, or pick a role that writes.`)
    // Every check that will reach runGate is validated here, before the task or its worktree exist: a command that is
    // not one, one that is destructive, and a writer whose set cannot fail at all. A refused delegation must leave
    // nothing behind, and this runs before addDelegated and prepareTaskWorktree, so it does.
    const checks = checkSetProblems(d.checks, writer)
    if (checks) throw new DelegationError(`Not started: ${checks}`)
    if (!d.body) throw new DelegationError("Not started: the prompt has no task.")

    const job = this.job(project, parent)
    await this.#replace(project, job, d.replaces)
    const duplicate = this.#duplicate(job, role, input.description.trim(), d.body, parsed.files, d.replaces)
    if (duplicate) throw new DelegationError(duplicate)
    if (!job.integrationWorktree) {
      excludeFromGit(project)
      const integration = await prepareIntegration(project, job.id, this.#exec)
      job.integrationBranch = integration.branch
      job.integrationWorktree = integration.worktree
      // The offset and the uncommitted state are kept on the job: a worker session outlives this process, and a
      // project below the repository root (or a task that needs an uncommitted file) must not depend on this call.
      job.integrationRel = integration.rel
      job.integrationBase = integration.base
      job.integrationDirty = integration.dirty ? integration.dirtySummary : ""
    }
    // A job file written before the offset was tracked has none: git is asked once, so a job that predates this does
    // not keep sending its workers to the worktree root.
    const rel = job.integrationRel ?? (job.integrationWorktree ? await repoRel(project, this.#exec) : "")
    const added = addDelegated(job, { title: input.description.trim() || d.body.split("\n")[0]!, prompt: d.body, files: parsed.files, dependsOn: [], checks: d.checks })
    if (!added.task) throw new DelegationError(`Not started: ${added.errors!.join("; ")}`)
    const task = added.task
    task.role = role.id
    task.model = model
    for (const s of ["ready", "planned", "running"] as const) moveTask(task, s)
    stage(task, "delegate", "pass", `${role.agent} on ${model}`)
    const entry: Entry = { project, jobId: job.id, taskId: task.id, parent, writer, dir: taskDir(job.integrationWorktree!, rel), worktree: job.integrationWorktree!, rel, checks: d.checks }
    if (writer) {
      const w = await prepareTaskWorktree(project, job.id, task.id, job.integrationBranch!, this.#exec, undefined, rel)
      entry.dir = w.dir
      entry.worktree = w.worktree
      entry.branch = w.branch
      task.worktree = w.worktree
      task.worktreeRel = w.rel
      task.branch = w.branch
    }
    const graph = role.id === "explore" ? await this.#graphs.get(entry.dir) : undefined
    entry.graph = Boolean(graph)
    this.#entries.set(`${job.id}/${task.id}`, entry)
    saveJob(project, job)
    // A project below the repository root and an uncommitted working tree are both invisible from the inside: the
    // worktree holds the whole repository, and no worker can see what the user has not committed.
    const notes = [
      rel !== "" ? `job ${job.id}: the project is ${rel} inside the repository, so its worktrees hold the repository root; the task works in the project directory ${entry.dir}` : "",
      job.integrationDirty ? `job ${job.id}: starts from commit ${job.integrationBase?.slice(0, 7) ?? "HEAD"} on ${job.integrationBranch}, and the working tree has uncommitted paths no worker will see (${job.integrationDirty})` : "",
    ].filter(Boolean)
    return { task, job, prompt: this.#brief(job, task, role, model, d, entry, graph), notes }
  }

  // "Replaces: T5": the micromanager starts T5's work over on purpose. T5 is cancelled and its worktree, with whatever
  // change it held, goes; a task that still runs has to be stopped first, and a merged one has nothing to replace.
  async #replace(project: string, job: Job, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const task = job.tasks.find((t) => t.id === id)
      if (!task) throw new DelegationError(`Not started: there is no task ${id} to replace.`)
      const live = LIVE.has(task.status) && !this.#entries.get(`${job.id}/${id}`)?.ended
      if (live) throw new DelegationError(`Not started: ${id} still runs; stop it with stop_task first, then delegate again with "Replaces: ${id}".`)
      if (task.status === "merged") throw new DelegationError(`Not started: ${id} is merged, so there is nothing to replace; leave out "Replaces: ${id}" and say in the brief what to change on top of it.`)
      await this.discard(project, job, id, "replace", "started over by a new task")
    }
  }

  // A task given up for good: cancelled, and its worktree and branch gone, whatever change they held. For "Replaces:"
  // and for rewind_job, which must not leave a branch cut from a tip it took back (the merge train would replay it).
  async discard(project: string, job: Job, taskId: string, why: string, evidence: string): Promise<void> {
    const task = job.tasks.find((t) => t.id === taskId)
    if (!task) return
    const k = `${job.id}/${taskId}`
    const entry = this.#entries.get(k)
    if (task.status !== "cancelled" && task.status !== "merged") moveTask(task, "cancelled")
    stage(task, why, "pass", evidence)
    if (entry) {
      await this.#dropWorktree(entry, task)
      this.#entries.delete(k)
    } else if (task.worktree && task.branch) {
      await removeTaskWorktree(project, { worktree: task.worktree, branch: task.branch }, this.#exec)
      task.worktree = undefined
      task.branch = undefined
    }
    saveJob(project, job)
  }

  // The job as this process holds it, when it holds it: the copy the plugin's tools must change, because this one is
  // saved over the file every time a worker moves on.
  current(project: string, jobId: string): Job | undefined {
    return this.#jobs.get(key(project, jobId))
  }

  // The same work delegated a second time (live run, 2026-10-07: three tasks each removed the same pill from the same
  // slide, because the first two stopped before their merge and the micromanager started over instead of continuing).
  // A writer on files another writer of this job is changing, or left unfinished with its change still in its worktree,
  // and whose title or brief is about the same thing, is refused with what to do instead; a reader is refused when one
  // with nearly the same brief still runs. Returns the refusal, or undefined.
  #duplicate(job: Job, role: Role, title: string, body: string, files: readonly string[], replaced: readonly string[]): string | undefined {
    const writer = WRITERS.has(role.id)
    for (const task of job.tasks) {
      if (replaced.includes(task.id)) continue
      const entry = this.#entries.get(`${job.id}/${task.id}`)
      // A task whose worker has not started yet counts as running: two equal calls in one message come one after the
      // other, before either child exists.
      if (!entry || entry.writer !== writer) continue
      const session = entry.session ? `session ${entry.session}` : "its worker is starting"
      if (!writer) {
        if (LIVE.has(task.status) && !entry.ended && task.role === role.id && similarity(body, task.description) >= SAME_QUESTION) {
          return `Not started: ${task.id} "${task.title}" asks this already (${session}); its report comes to you when it ends.`
        }
        continue
      }
      const shared = files.filter((f) => task.files.includes(f))
      if (!shared.length) continue
      if (similarity(title, task.title) < SAME_WORK && similarity(body, task.description) < SAME_WORK) continue
      if (LIVE.has(task.status) && !entry.ended) {
        return `Not started: ${task.id} "${task.title}" is doing this already (it changes ${shared.join(", ")}; ${session}). Send it a note with steer_task, or wait for its report. To replace it, stop it with stop_task, then delegate again with a line "Replaces: ${task.id}".`
      }
      if ((UNFINISHED.has(task.status) || (LIVE.has(task.status) && entry.ended)) && !entry.removed && entry.session) {
        const last = task.stages[task.stages.length - 1]
        return `Not started: ${task.id} "${task.title}" did this work and stopped before its merge${last ? ` (${last.stage}: ${last.evidence ?? last.result})` : ""}; its change is still in its worktree. Continue it with the subagent tool and sessionID ${entry.session}, saying what is left, so the change is kept. To start over instead, add a line "Replaces: ${task.id}": its worktree is discarded.`
      }
    }
    return undefined
  }

  // The subagent call failed before its child took the task (refused, an unknown agent): the task is dropped.
  async abandon(prompt: string): Promise<void> {
    const k = tokenOf(prompt)
    const entry = k ? this.#entries.get(k) : undefined
    if (!entry || entry.session) return
    const job = this.#job(entry)
    const task = job?.tasks.find((t) => t.id === entry.taskId)
    if (task) {
      moveTask(task, "cancelled")
      stage(task, "delegate", "fail", "the subagent call failed")
    }
    await this.#dropWorktree(entry, task)
    this.#entries.delete(k!)
    if (job) saveJob(entry.project, job)
  }

  // A child's first prompt: the directory it must move to, when it carries one of our tasks.
  claim(session: string, text: string): { dir: string; task: string; parent: string } | undefined {
    if (!text.startsWith(CHILD_PREFIX)) return undefined
    const k = tokenOf(text)
    const entry = k ? this.#entries.get(k) : undefined
    if (!entry || entry.session) return undefined
    entry.session = session
    this.#bySession.set(session, k!)
    const job = this.#job(entry)
    const task = job?.tasks.find((t) => t.id === entry.taskId)
    if (job && task) {
      task.session = session
      task.sessions = [...(task.sessions ?? []), session]
      saveJob(entry.project, job)
    }
    return { dir: entry.dir, task: `${entry.taskId} ${task?.title ?? ""}: ${task?.description ?? ""}`, parent: entry.parent }
  }

  // The micromanager continues a worker (subagent with its sessionID): a merged writer gets a fresh worktree from the
  // session branch at the same place, as a new task, so its next change is checked and merged again.
  async resume(session: string): Promise<Task | undefined> {
    const entry = this.#entry(session)
    const job = entry && this.#job(entry)
    let task = job?.tasks.find((t) => t.id === entry!.taskId)
    if (!entry || !job || !task) return undefined
    entry.ended = false
    if (entry.writer && (task.status === "merged" || task.status === "cancelled")) {
      const added = addDelegated(job, { title: `${task.title} (continued)`, prompt: task.description, files: task.files, dependsOn: [], checks: entry.checks })
      if (!added.task) return undefined
      added.task.role = task.role
      added.task.model = task.model
      added.task.session = session
      added.task.sessions = [session]
      for (const s of ["ready", "planned", "running"] as const) moveTask(added.task, s)
      stage(added.task, "delegate", "pass", `continues ${task.id} in session ${session}`)
      this.#entries.delete(`${job.id}/${task.id}`)
      entry.taskId = added.task.id
      this.#entries.set(`${job.id}/${added.task.id}`, entry)
      this.#bySession.set(session, `${job.id}/${added.task.id}`)
      task = added.task
    } else if (task.status === "escalated" || task.status === "blocked" || task.status === "passed") {
      if (task.status === "passed") moveTask(task, "escalated") // a reader asked again
      moveTask(task, "running")
    }
    if (entry.writer && entry.removed) {
      // The session keeps its directory, so the worktree comes back where it was: the worktree root, which is what git
      // registers, not the project directory inside it.
      const w = await prepareTaskWorktree(entry.project, job.id, entry.taskId, job.integrationBranch!, this.#exec, entry.worktree, entry.rel)
      entry.worktree = w.worktree
      entry.dir = w.dir
      entry.branch = w.branch
      entry.removed = false
      task.worktree = w.worktree
      task.worktreeRel = w.rel
      task.branch = w.branch
    }
    saveJob(entry.project, job)
    return task
  }

  isWorker(session: string): boolean {
    return this.#bySession.has(session)
  }

  isWriter(session: string): boolean {
    return this.#entry(session)?.writer ?? false
  }

  // The micromanager session a worker answers to, and how that session knows its task (src/ask.ts).
  ownerOf(session: string): { parent: string; task: string } | undefined {
    const entry = this.#entry(session)
    if (!entry) return undefined
    const task = this.#job(entry)?.tasks.find((t) => t.id === entry.taskId)
    return { parent: entry.parent, task: task ? `${task.id} ${task.title}` : entry.taskId }
  }

  // A writer as its helpers see it (src/helpers.ts): where it works and what it works on. Undefined for anyone else.
  writerOf(session: string): { dir: string; label: string; task: string } | undefined {
    const entry = this.#entry(session)
    if (!entry?.writer) return undefined
    const task = this.#job(entry)?.tasks.find((t) => t.id === entry.taskId)
    return { dir: entry.dir, label: `${entry.taskId} of ${entry.jobId}`, task: task ? `${task.title}: ${task.description}`.slice(0, 1500) : entry.taskId }
  }

  hasGraph(session: string): boolean {
    return this.#entry(session)?.graph ?? false
  }

  // The code_graph tool: one question to the graph of the explorer's directory, rebuilt first when the session
  // branch moved on (a writer merged) since the last build.
  async askGraph(session: string, action: string, symbol: string, to: string): Promise<string> {
    const entry = this.#entry(session)
    if (!entry?.graph) return "This session has no code graph."
    if (!(await this.#graphs.get(entry.dir))) return "The code graph could not be built; use grep and read instead."
    return queryGraph(entry.dir, action, symbol, to, this.#exec)
  }

  // finish_task: the checks in the worker's worktree, then the commit and the merge train. The text goes back to the
  // worker; note is what the micromanager should hear (undefined: nothing new).
  async finish(session: string, summary: string): Promise<{ text: string; note?: string; parent?: string }> {
    const entry = this.#entry(session)
    const job = entry && this.#job(entry)
    const task = job?.tasks.find((t) => t.id === entry!.taskId)
    if (!entry || !job || !task) return { text: "This session has no task of the micromanager; there is nothing to finish." }
    if (!entry.writer) return { text: "You only read: there is nothing to check or merge. End with your findings; they are your result." }
    if (task.status === "merged") return { text: `${task.id} is already merged into ${job.integrationBranch}. End with your short report.` }
    if (task.status === "escalated") moveTask(task, "running")
    moveTask(task, "gating")
    task.summary = summary.trim().slice(0, 2000) || task.summary
    // The checks run where the worker's files are, not in the worktree root: a project below the repository root lives
    // that far down, and a check naming one of its files finds nothing above it.
    const failed = (await runGate(entry.worktree, entry.checks, this.#exec, undefined, entry.dir)).filter((r) => !r.passed)
    if (failed.length) {
      // The same cap the runner applies to its fix rounds (runner.ts: #work, `fixRounds ?? 2`). Without it a check that
      // cannot be satisfied in this environment -- a path that does not exist, a command the gate refuses -- was handed
      // back to the model until the watchdog's step limit stopped it, burning a session for nothing (live test,
      // 2026-10-06: four identical gate failures, then the worker gave up). The last failure goes back with the
      // reason, because at the cap the useful message is that the CHECK is the problem, not the work.
      task.attempts++
      if (task.attempts > FIX_ROUNDS) {
        stage(task, "gate", "fail", failed.map((f) => f.command).join(", "))
        moveTask(task, "blocked")
        task.summary = `its checks still fail after ${FIX_ROUNDS} fix round(s): ${failed.map((f) => f.command).join(", ")}`
        const note = `[jev-micromanager] ${task.id} ${task.title}: its worker hit the limit of ${FIX_ROUNDS} fix rounds with the checks still failing (${failed.map((f) => f.command).join(", ")}). If the check is what is wrong -- a path that does not exist in the worktree, a command the gate refuses -- correct the task with steer_task and its sessionID ${session} rather than starting a new worker.`
        saveJob(entry.project, job)
        return {
          text: `Your checks still fail after ${FIX_ROUNDS} rounds, so I am stopping here rather than spending the rest of your budget on them:\n\n${failed.map((f) => `$ ${f.command} (exit ${f.code})\n${f.output}`).join("\n\n")}\n\nIf the work is done and the CHECK is what cannot be satisfied here, say so plainly in your report. If the work is not done, name what is missing.`,
          note,
          parent: entry.parent,
        }
      }
      moveTask(task, "fixing")
      moveTask(task, "running")
      stage(task, "gate", "fail", failed.map((f) => f.command).join(", "))
      saveJob(entry.project, job)
      return { text: failText(`The checks fail in your directory (fix round ${task.attempts} of ${FIX_ROUNDS})`, failed, entry.dir) }
    }
    // A passing gate over an untouched tree proves nothing: read-only checks exit 0 on a worktree nobody wrote to, and
    // a worker whose session died mid-task never gets this far but a silent no-op worker does.
    const touched = await changedFiles(entry.worktree, this.#exec, task.worktreeRel ?? job.integrationRel ?? "")
    if (!touched.length) {
      stage(task, "gate", "fail", "the checks passed but no file was changed")
      moveTask(task, "blocked")
      task.summary = "its checks passed but it changed no file, so nothing was verified."
      saveJob(entry.project, job)
      return {
        text: `Your checks pass, but you changed no file, so there is nothing to commit and nothing was verified. If the task was already done by someone else, say so in your report. Otherwise make the change the task asked for and call finish_task again.`,
        note: `[jev-micromanager] ${task.id} ${task.title}: its checks passed but it changed no file, so nothing was committed. Continue it with the subagent tool and sessionID ${session}, or tell the user.`,
        parent: entry.parent,
      }
    }
    stage(task, "gate", "pass", entry.checks.length ? entry.checks.join(", ") : "no checks given")
    const commit = await commitTask(entry.worktree, `${task.id}: ${task.title}`, `Job: ${job.id}\nWorker: ${task.model ?? "?"} (${task.role}), session ${session}${task.summary ? `\n\n${task.summary}` : ""}`, this.#exec)
    moveTask(task, "passed")
    const train = this.#trains.get(job.id) ?? Promise.resolve()
    const step = train.then(() => this.#merge(entry, job, task))
    this.#trains.set(job.id, step.catch(() => undefined))
    const merged = await step
    saveJob(entry.project, job)
    if (!merged.ok) return { text: merged.text }
    // The commit as merged: a rebase onto other tasks' commits gave it a new id (live test).
    const head = commit && (await this.#exec("git", ["rev-parse", "--short", "HEAD"], { cwd: entry.worktree })).stdout.trim()
    const checks = entry.checks.length ? `checks passed: ${entry.checks.join("; ")}` : "no checks were given"
    return {
      text: `Merged into ${job.integrationBranch}${head ? ` as ${head}` : " (nothing to commit)"}; ${checks}. Now end with your short report.`,
      note: `[jev-micromanager] ${task.id} ${task.title}: merged into ${job.integrationBranch}${head ? ` (${head})` : ", nothing changed"}; ${checks}.`,
      parent: entry.parent,
    }
  }

  // Rebase onto the session branch, the checks again when it moved, then the fast-forward.
  async #merge(entry: Entry, job: Job, task: Task): Promise<{ ok: true } | { ok: false; text: string }> {
    const w = { worktree: entry.worktree, branch: entry.branch! }
    const step = await rebaseTask(w, job.integrationBranch!, this.#exec)
    if (!step.ok) {
      moveTask(task, "escalated")
      stage(task, "merge", "fail", step.conflict)
      return { ok: false, text: `Your commit does not apply on top of ${job.integrationBranch}, which other tasks moved on meanwhile (${step.conflict}). Run git rebase ${job.integrationBranch} in your directory, resolve the conflict keeping both changes, run the checks, and call finish_task again.` }
    }
    if (step.moved) {
      const failed = (await runGate(entry.worktree, entry.checks, this.#exec, undefined, entry.dir)).filter((r) => !r.passed)
      if (failed.length) {
        moveTask(task, "escalated")
        stage(task, "merge", "fail", `checks fail on top of the newer commits: ${failed.map((f) => f.command).join(", ")}`)
        return { ok: false, text: failText(`Your change is rebased onto ${job.integrationBranch}, which other tasks moved on meanwhile, and there the checks fail`, failed, entry.dir) }
      }
    }
    const ff = await fastForward(job.integrationWorktree!, entry.branch!, this.#exec)
    if (!ff.ok) {
      moveTask(task, "escalated")
      stage(task, "merge", "fail", ff.conflict)
      return { ok: false, text: `The merge into ${job.integrationBranch} failed (${ff.conflict}). Call finish_task again; if it fails the same way, report it.` }
    }
    moveTask(task, "merged")
    stage(task, "merge", "pass", `merged into ${job.integrationBranch}`)
    return { ok: true }
  }

  // Waits once per run for a worker's end (wait resolves when its session goes idle).
  // reason: why the watchdog stopped the worker, if it did.
  watchEnd(session: string, wait: () => Promise<unknown>, reason: () => string | undefined, ended: (note: string | undefined, parent: string) => void): void {
    if (this.#waiting.has(session) || !this.#bySession.has(session)) return
    this.#waiting.add(session)
    void wait().catch(() => undefined).then(async () => {
      this.#waiting.delete(session)
      const r = await this.ended(session, reason())
      if (r) ended(r.note, r.parent)
    })
  }

  // A worker's run ended: a merged writer's worktree goes, a reader's task is done, and a writer that did not get
  // through finish_task is reported, with its change still in its worktree. reason: why the watchdog stopped it.
  async ended(session: string, reason?: string): Promise<{ note?: string; parent: string } | undefined> {
    const entry = this.#entry(session)
    const job = entry && this.#job(entry)
    const task = job?.tasks.find((t) => t.id === entry!.taskId)
    if (!entry || !job || !task) return undefined
    entry.ended = true
    let note: string | undefined
    if (!entry.writer) {
      if (task.status === "running") {
        moveTask(task, "gating")
        moveTask(task, "passed")
        stage(task, "report", "pass", "the reader ended")
      }
    } else if (task.status === "merged") {
      await this.#dropWorktree(entry, task)
    } else {
      stage(task, "end", "fail", reason ?? "ended without finish_task")
      note = `[jev-micromanager] ${task.id} ${task.title}: its worker ended${reason ? ` (${reason})` : ""} without passing finish_task, so nothing was checked or merged; its change is still in ${entry.dir}. Continue it with the subagent tool and sessionID ${session} to finish, or tell the user.`
    }
    saveJob(entry.project, job)
    return { note, parent: entry.parent }
  }

  // The workers of a micromanager session that still run.
  running(parent: string): { session: string; task: string }[] {
    return [...this.#entries.values()]
      .filter((e) => e.parent === parent && e.session && !e.ended)
      .filter((e) => ["running", "gating", "fixing"].includes(this.#job(e)?.tasks.find((t) => t.id === e.taskId)?.status ?? ""))
      .map((e) => ({ session: e.session!, task: e.taskId }))
  }

  #entry(session: string): Entry | undefined {
    const k = this.#bySession.get(session)
    return k ? this.#entries.get(k) : undefined
  }

  #job(entry: Entry): Job | undefined {
    return this.#jobs.get(key(entry.project, entry.jobId))
  }

  async #dropWorktree(entry: Entry, task?: Task): Promise<void> {
    if (!entry.writer || entry.removed || !entry.branch) return
    await removeTaskWorktree(entry.project, { worktree: entry.worktree, branch: entry.branch }, this.#exec)
    entry.removed = true
    if (task) {
      task.worktree = undefined
      task.branch = undefined
    }
  }

  #brief(job: Job, task: Task, role: Role, model: string, d: Delegation, entry: Entry, graph?: Graph): string {
    const skills = [...(entry.writer ? ["verification-before-completion"] : []), ...(role.id === "research" ? ["research"] : [])].filter((s) => this.#skills.has(s))
    const others = job.tasks.filter((t) => t.id !== task.id && ["running", "gating", "fixing"].includes(t.status))
    return [
      `${HEADER} task ${task.id} · job ${job.id} · role ${role.id} · model ${model}`,
      "",
      d.body,
      "",
      graph ? graphBrief(graph) : "",
      "",
      entry.writer ? `Files you may change: ${task.files.join(", ")}. Work only in your current directory, a git worktree of its own.` : "Change no files.",
      // A worktree is a checkout of the repository root, so a project that is a subdirectory sits below it. Saying so
      // keeps a worker from concluding its premise is false when a path of its own does not resolve at the top.
      entry.rel ? `Your directory ${entry.dir} is the project directory inside the worktree ${entry.worktree}; the worktree holds the whole repository (${entry.rel} below its root). Every path you read or write is relative to your own directory, never to the worktree root.` : "",
      dirtyNote(job, entry.writer),
      entry.writer
        ? entry.checks.length
          ? `Checks the plugin runs when you finish: ${entry.checks.join("; ")}`
          : "No checks were given: test your change yourself as far as you can."
        : "",
      others.length ? `Other workers change other files at the same time (not yours): ${others.map((t) => `${t.id} ${t.title}`).join("; ")}` : "",
      "Keys and tokens show as <secret> in what you read; never write <secret> into a file, leave such lines as they are.",
      skillLine(skills),
      "",
      entry.writer
        ? "Two helpers answer questions while you wait: explore (an explorer reads your directory, your change included) and research (a researcher looks it up on the web). Ask one when a question would take you many reads or needs documentation you cannot reach; at most 3 per task. Like finish_task, they are called inside the execute tool: `await tools.explore({ question: \"…\" })`."
        : "",
      entry.writer
        ? "When your change is done, call finish_task with a two-line summary, inside the execute tool: `await tools.finish_task({ summary: \"…\" })`. The plugin then runs the checks, commits and merges; if it answers with failures, fix them and call finish_task again. Once it says merged, end with a short report: what you changed, what the checks showed, anything left open, and work you noticed outside your task (follow-ups)."
        : "End with your findings: they are your result. Add work you noticed that the request needs (follow-ups).",
    ].filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n").trim()
  }
}

function key(project: string, job: string): string {
  return `${project}\0${job}`
}

// A worktree starts from the last commit, so the user's uncommitted work is not in it. A worker told this fails far more
// gracefully than one that spends a session discovering its premise cannot hold.
function dirtyNote(job: Job, writer: boolean): string {
  if (!job.integrationDirty) return ""
  return writer
    ? `The working tree of the project has uncommitted changes that this worktree does not have (${job.integrationDirty}); the worktree is a checkout of the last commit. Do not try to read them: say so in your report if your task depends on them.`
    : `The working tree of the project has uncommitted changes that this worktree does not have (${job.integrationDirty}); what you read here is the last commit. Say so if your question depends on them.`
}

// "<job>/<task>" from a brief's header line.
function tokenOf(text: string): string | undefined {
  const m = text.match(/\[jev-micromanager\] task (T\d+) · job (\S+) ·/)
  return m ? `${m[2]}/${m[1]}` : undefined
}

// The directory is in the text: a check that says "No such file or directory" only makes sense next to the cwd it ran
// in, and that was the one diagnostic missing when a worker hunted for a file three directories up.
function failText(what: string, failed: readonly GateResult[], dir: string): string {
  return `${what}. Fix them, then call finish_task again:\n${failed.map((f) => `$ ${f.command} (exit ${f.code})\n${f.output}`).join("\n\n")}\n\nThe checks ran in ${dir}; a path in them is relative to that directory.`
}
