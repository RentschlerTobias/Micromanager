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

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

import { Graphs, graphBrief, queryGraph, type Graph } from "./graph.ts"
import { HEADER } from "./hooks.ts"
import { coarse, contractBrief, describe, guardViolations, heldOutDir, keepHeldOut, parseContract, reached, type Contract, type Measured } from "./contract.ts"
import {
  changedFiles, commitTask, exec as defaultExec, fastForward, frozenChanged, gradedOf, hashFiles, prepareIntegration, prepareTaskWorktree, rebaseTask, removeTaskWorktree,
  repoRel, revertFiles, runEvaluator, runGate, taskDir,
  type Exec, type GateResult,
} from "./integration.ts"
import { addDelegated, checkSetProblems, parseFiles } from "./plan.ts"
import { WRITERS } from "./profile.ts"
import { FIX_ROUNDS } from "./watchdog.ts"
import { ROLES, roleByAgent, roleById, type Role, type RoleId } from "./roles.ts"
import { isDone, moveTask, newJob, moveJob, stage, type Job, type Later, type Task } from "./state.ts"
import { excludeFromGit, jobId, listJobs, saveContract, saveJob } from "./store.ts"
import { draftFromLater, draftFromTrial, localBackend, type BacklogBackend, type BacklogItem } from "./backlog.ts"
import { normalTarget, type ChangeAnswer, type ChangeKind } from "./checkchange.ts"
import { parseReport, sharedNote, skillLine, taskAcceptance } from "./brief.ts"
import { settled, startable } from "./continuation.ts"
import { isStarted, lastOptions, loadControl, optionsOf } from "./control.ts"
import { formInput, startForm } from "./forms.ts"
import { gitState } from "./nogit.ts"
import { allFailedText, attemptBrief, attemptFailedText, attempts, fanOutText, ranked, standing, wonText, type Assessment } from "./trials.ts"

// The first line OpenCode puts before a new subagent's prompt; how the prompt hook tells a child's first turn.
export const CHILD_PREFIX = "You are a subagent spawned by another session."

export class DelegationError extends Error {}

export interface Delegation {
  readonly body: string // the prompt without the Files, Checks, Replaces and Task lines
  readonly files: string // as written, parsed by parseFiles
  readonly checks: string[]
  readonly replaces: string[] // tasks this one deliberately starts over ("Replaces: T5")
  readonly planned?: { readonly task: string; readonly job: string } // a planned task to start ("Task: T5 · job-…")
  readonly attempt?: { readonly task: string; readonly job: string } // another attempt of a trial ("Attempt: T5 · job-…")
  readonly contract?: string // the fitness contract its work is measured against ("Contract: C1", src/contract.ts)
  readonly frozen?: string // files it may read and run but not change, as written ("Frozen: test/a.test.js")
}

// The "Files:" and "Checks:" lines of a delegation, wherever they stand; the checks go on over the following lines
// until a blank line or another such line.
export function parseDelegation(prompt: string): Delegation {
  const body: string[] = []
  const checks: string[] = []
  const replaces: string[] = []
  let files = ""
  let frozen = ""
  let planned: Delegation["planned"]
  let attempt: Delegation["attempt"]
  let contract: string | undefined
  let inChecks = false
  for (const line of prompt.split("\n")) {
    const k = line.match(/^\s*contract:\s*(C\d+)\s*$/i)
    if (k) {
      contract = k[1]!.toUpperCase()
      inChecks = false
      continue
    }
    // The line the plugin hands out for a trial's other attempts (src/trials.ts attemptLine).
    const a = line.match(/^\s*attempt:\s*(T\d+(?:\.\w+)*)\s*·\s*(job-[\w-]+)\s*$/i)
    if (a) {
      attempt = { task: a[1]!.toUpperCase(), job: a[2]! }
      inChecks = false
      continue
    }
    // Only the exact form run_job hands out (src/continuation.ts plannedLine): a prompt's own "Task: …" stays prose.
    const t = line.match(/^\s*task:\s*(T\d+(?:\.\w+)*)\s*·\s*(job-[\w-]+)\s*$/i)
    if (t) {
      planned = { task: t[1]!.toUpperCase(), job: t[2]! }
      inChecks = false
      continue
    }
    const z = line.match(/^\s*frozen:\s*(.*)$/i)
    if (z) {
      frozen = z[1]!.trim()
      inChecks = false
      continue
    }
    const f = line.match(/^\s*files:\s*(.*)$/i)
    const c = line.match(/^\s*checks:\s*(.*)$/i)
    const r = line.match(/^\s*replaces:\s*(.*)$/i)
    if (r) {
      replaces.push(...replaceIds(r[1]))
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
  return { body: body.join("\n").trim(), files, checks, replaces, ...(frozen ? { frozen } : {}), ...(planned ? { planned } : {}), ...(attempt ? { attempt } : {}), ...(contract ? { contract } : {}) }
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
  parent: string // the micromanager session; a later session that takes the job over becomes it
  readonly writer: boolean
  dir: string // where the worker works: its own worktree (writer) or the session branch's (reader), at the project offset
  worktree: string // the git worktree root of dir: what git commands need
  rel: string // the project directory's offset inside worktree; "" when the project is the repository root
  branch?: string // a writer's task branch
  removed?: boolean // the writer's worktree was removed after its merge
  session?: string // the child session, once claimed
  checks: string[]
  contract?: string // the fitness contract its work is measured against, by id
  frozen?: Map<string, string> // project-relative path -> content hash when the writer started (task.frozen)
  graph?: boolean // an explorer with a code graph of its directory (the code_graph tool)
  ended?: boolean // its session ended; a writer that did not merge stays "running" until it is continued or swept
}

export interface NativeDeps {
  readonly exec?: Exec
  readonly installedSkills?: ReadonlySet<string>
  readonly graphs?: Pick<Graphs, "get"> // the code graph an explorer starts from
  // Plan first (the user, 2026-10-20): a writer starts only from a todo of a job the user started with the start form,
  // so the work is planned with its order before anything changes files. Readers still start on the fly. Off in the
  // tests that delegate writers directly.
  readonly planFirst?: boolean
  // The note when the project is no git repository: the form that asks the user how to go on (src/plugin.ts, with
  // Jev's recommendation). Without it a plain note says the same.
  readonly noGit?: (project: string) => Promise<string>
  // A trial decided by score (src/contract.ts) waits this long after its first passing attempt for the others (the
  // "trialDeadline" setting); then the best of the passed ones is merged and the rest are stopped.
  readonly trialDeadlineMs?: number
  // A trial was decided by score. note and stop are set when nobody's finish_task carries them (a deadline, the last
  // attempt ending): the note goes to the micromanager, the sessions are interrupted. measured: the attempts that
  // waited for the decision, whose outcomes the log gets now that they are known.
  readonly onSettled?: (r: { project: string; job: Job; parent: string; note?: string; stop: string[]; measured: Task[] }) => void
}

export const TRIAL_DEADLINE_MS = 20 * 60_000

// The project is no git repository, or one without a commit: nothing starts until the user said how to go on.
export class NoGitError extends DelegationError {}

// One entry of the todo tool: what the micromanager means to start later.
export interface TodoItem {
  readonly title?: string
  readonly agent?: string // the role agent that will do it (coder when left out)
  readonly files?: string // a writer's write scope, as a delegation's Files line
  readonly checks?: string // shell commands, one per line
  readonly after?: readonly string[] // task ids it waits for
  readonly brief?: string // what the worker needs to know beyond the title
  readonly replaces?: readonly string[] // tasks it does over: "T19", or "job-…/T18" in another job of the session
  readonly contract?: string // the fitness contract it is measured against: "C1"
  readonly frozen?: string // files it may read and run but not change, comma separated
}

// Task ids in whatever a model wrote: ["T1", "T2"], "T1, T2", or "after T1 and T2 merged" (live run: the last one made
// a task wait for a task "MERGED").
export function taskIds(value: unknown): string[] {
  return (Array.isArray(value) ? value.join(" ") : String(value ?? "")).toUpperCase().match(/\bT\d+(?:\.\w+)*/g) ?? []
}

// The tasks a todo or a delegation does over: "T19", or "job-…/T18" for a task of another job of the session.
export function replaceIds(value: unknown): string[] {
  const text = Array.isArray(value) ? value.join(" ") : String(value ?? "")
  return [...text.matchAll(/\b(job-[\w-]+\/)?(T\d+(?:\.\w+)*)\b/gi)].map((m) => `${m[1]?.toLowerCase() ?? ""}${m[2]!.toUpperCase()}`)
}

// The todo tool's one argument: a JSON list of todos, with {"drop": [...]} entries for the ones to remove. A string
// when it cannot be read: the answer to the micromanager.
export function parseTodo(items: string): { list: TodoItem[]; ids: string[] } | string {
  const list: TodoItem[] = []
  const ids: string[] = []
  if (!items.trim()) return { list, ids }
  let parsed: unknown
  try {
    parsed = JSON.parse(items)
  } catch (err) {
    return `items is not a JSON list: ${err instanceof Error ? err.message : String(err)}. Nothing was changed.`
  }
  for (const x of Array.isArray(parsed) ? parsed : [parsed]) {
    const o = (x ?? {}) as Record<string, unknown>
    if (o.drop !== undefined) {
      ids.push(...taskIds(o.drop))
      if (!o.title) continue
    }
    const text = (v: unknown, join: string) => (v === undefined || v === null || v === "" ? undefined : Array.isArray(v) ? v.map(String).join(join) : String(v))
    list.push({
      title: String(o.title ?? "").replace(/^\s*T\d+(?:\.\w+)*\s*[:·.-]\s*/i, ""), // the plugin numbers todos itself
      agent: text(o.agent, ""),
      files: text(o.files, ", "),
      checks: text(o.checks, "\n"),
      after: taskIds(o.after),
      brief: text(o.brief, "\n"),
      replaces: replaceIds(o.replaces),
      ...(typeof o.contract === "string" && /^c\d+$/i.test(o.contract.trim()) ? { contract: o.contract.trim().toUpperCase() } : {}),
      ...(text(o.frozen, ", ") ? { frozen: text(o.frozen, ", ")! } : {}),
    })
  }
  return { list, ids }
}

// A worker's task as its session ended.
export interface Worker {
  readonly project: string
  readonly job: Job
  readonly task: Task
  readonly writer: boolean
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
    this.#planFirst = deps.planFirst ?? false
    this.#noGit = deps.noGit
    this.#deadlineMs = deps.trialDeadlineMs ?? TRIAL_DEADLINE_MS
    this.#onSettled = deps.onSettled
  }

  readonly #deadlineMs: number
  readonly #onSettled?: NativeDeps["onSettled"]
  readonly #deadlines = new Map<string, ReturnType<typeof setTimeout>>() // "<job>/<head>" -> its trial's deadline

  readonly #noGit?: (project: string) => Promise<string>

  // The user's choice for a project without git: its workers change the folder directly, one at a time.
  withoutGit(project: string, parent: string): Job {
    const job = this.job(project, parent)
    job.isolation = "none"
    saveJob(project, job)
    return job
  }

  readonly #planFirst: boolean

  // The note that asks the user to start the job, with the start form to pass to the question tool; undefined once
  // the job is started.
  startNote(project: string, job: Job): string | undefined {
    if (isStarted(job, loadControl(project, job.id))) return undefined
    const open = job.tasks.filter((t) => ["pending", "ready", "planned"].includes(t.status))
    if (!open.length) return undefined
    const form = startForm(job.id, open.length, startable(job).length, lastOptions(project))
    return `The plan is not started yet. When the todo list is complete, ask the user to start it: call the question tool with exactly this input (it is a form; the user ticks the options and says Start), then end your turn:\n${formInput(form)}`
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
      if (!(job.rolling || job.native) || !job.facilitator || ["done", "stopped", "failed"].includes(job.phase)) continue
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
          ...(task.contract ? { contract: task.contract.id } : {}),
          ...(task.frozen ? { frozen: new Map(Object.entries(task.frozen)) } : {}),
          ended: true,
        }
        this.#entries.set(k, entry)
        for (const s of new Set([task.session, ...(task.sessions ?? [])])) this.#bySession.set(s, k)
        adopted.push(k)
      }
      // A trial decided by score whose deadline lived in the process that ended: armed again, from the time it had.
      for (const head of job.tasks.filter((t) => t.settleBy && t.trial?.of === t.id)) {
        const now = standing(job, head)
        if (!now.winner && now.held.length) this.#arm(project, job, head)
      }
    }
    return adopted
  }

  // The open jobs of earlier micromanager sessions of this project: rolling, not finished, and with something left in
  // them (a merged task, or a task with a worktree). A new session starts a job of its own, so without this the
  // previous session's work was out of sight: merged tasks the checkout never got, unfinished changes in worktrees.
  openJobs(project: string, parent: string): Job[] {
    return listJobs(project)
      .filter((j) => j.rolling && j.facilitator && j.facilitator !== parent && !["done", "stopped", "failed"].includes(j.phase))
      .map((j) => this.#jobs.get(key(project, j.id)) ?? j)
      .filter((j) => j.tasks.some((t) => (t.status === "merged" && !t.undone) || (t.worktree && t.status !== "merged")))
  }

  // Whether this micromanager session has a job of its own yet.
  hasJob(project: string, parent: string): boolean {
    return listJobs(project).some((j) => j.rolling && j.facilitator === parent && !["done", "stopped", "failed"].includes(j.phase))
  }

  // "Continue" at the start of a session: the earlier session's job becomes this session's. New workers land on the
  // same branch, its unfinished workers can be continued by their sessions, and their notes and permission requests
  // come to this session. Refused when this session started a job of its own already: two jobs of one session would
  // split its work over two branches.
  takeOver(project: string, jobId: string, parent: string): { job?: Job; problem?: string } {
    if (this.hasJob(project, parent)) return { problem: "this session has a job of its own already; continue the earlier one in a new session, or merge or discard it" }
    this.adopt(project)
    const job = this.#jobs.get(key(project, jobId)) ?? listJobs(project).find((j) => j.id === jobId)
    if (!job || !job.rolling) return { problem: `there is no open job ${jobId} of a micromanager session in this project` }
    if (["done", "stopped", "failed"].includes(job.phase)) return { problem: `job ${jobId} is ${job.phase}` }
    job.facilitator = parent
    this.#jobs.set(key(project, job.id), job)
    for (const entry of this.#entries.values()) {
      if (entry.jobId === job.id && entry.project === project) entry.parent = parent
    }
    saveJob(project, job)
    return { job }
  }

  // A new subagent call of the micromanager: the task, its worktree and the worker's brief. Throws a
  // DelegationError the micromanager can act on when the call is not a valid delegation. Calls of one message come
  // at the same time; they go one after another (live test: two made the session branch at once, and one failed).
  // assess: what the plugin found out about a writer before (src/trials.ts): its difficulty and how many attempts.
  delegate(project: string, parent: string, input: { agent: string; description: string; prompt: string }, model: string, assess?: Assessment): Promise<Delegated> {
    const next = (this.#delegating.get(parent) ?? Promise.resolve()).then(() => this.#delegate(project, parent, input, model, assess))
    this.#delegating.set(parent, next.catch(() => undefined))
    return next
  }

  async #delegate(project: string, parent: string, input: { agent: string; description: string; prompt: string }, model: string, assess?: Assessment): Promise<Delegated> {
    const role = roleByAgent(input.agent)
    if (!role) throw new DelegationError(`Not started: use one of the role agents (${ROLES.map((r) => r.agent).join(", ")}), not ${input.agent || "none"}.`)
    const d = parseDelegation(input.prompt)
    if (d.attempt) return this.#attempt(project, parent, role, d, d.attempt, model)
    if (d.planned) return this.#planned(project, parent, role, d, d.planned, model, assess)
    if (this.#planFirst && WRITERS.has(role.id)) {
      throw new DelegationError(`Not started: a ${role.agent} starts from a todo. Write it down with the todo tool first (with "after" for what it waits for, "replaces" for a task it does over), then start it with the prompt line "Task: T… · job-…".`)
    }
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
    this.#contractFor(job, writer, d.contract, assess)
    await this.#replace(project, job, d.replaces)
    const duplicate = this.#duplicate(job, role, input.description.trim(), d.body, parsed.files, d.replaces)
    if (duplicate) throw new DelegationError(duplicate)
    const rel = await this.#integrate(project, job, WRITERS.has(role.id))
    const added = addDelegated(job, { title: input.description.trim() || d.body.split("\n")[0]!, prompt: d.body, files: parsed.files, dependsOn: [], checks: d.checks })
    if (!added.task) throw new DelegationError(`Not started: ${added.errors!.join("; ")}`)
    const task = added.task
    this.#bind(job, task, d.contract)
    if (d.frozen) task.freeze = parseFiles(d.frozen, project).files
    this.#link(project, job, task, d.replaces)
    task.role = role.id
    task.model = model
    this.#assess(project, job, task, assess)
    for (const s of ["ready", "planned", "running"] as const) moveTask(task, s)
    stage(task, "delegate", "pass", `${role.agent} on ${model}`)
    return this.#start(project, parent, job, task, role, model, d, d.checks, rel)
  }

  // The contract a writer is measured against, checked before anything of the task exists: one that the job has, with
  // a baseline to compare with. An open-ended task (N5's open_ended, src/trials.ts Assessment) without one is refused,
  // as a writer without checks is: nothing could tell a better result from a worse one.
  #contractFor(job: Job, writer: boolean, id: string | undefined, assess?: Assessment): Contract | undefined {
    if (!writer) {
      if (id) throw new DelegationError("Not started: a fitness contract measures a writer's work; leave out the Contract line for a reader.")
      return undefined
    }
    if (!id) {
      if (assess?.openEnded) throw new DelegationError('Not started: this task asks to make something better with no fixed end, so it needs a fitness contract that says what "better" means. Define one with the contract tool (goal, an evaluator that prints MM_SCORE, scores with a direction, guards), then delegate again with a line "Contract: C…".')
      return undefined
    }
    const c = job.contracts?.find((x) => x.id === id)
    if (!c) throw new DelegationError(`Not started: job ${job.id} has no contract ${id}; define it with the contract tool first.`)
    if (!c.baseline) throw new DelegationError(`Not started: contract ${id} has no baseline, because its evaluator did not give a valid result on today's code; fix the contract with the contract tool first.`)
    return c
  }

  // The task is measured against this version of the contract from now on.
  #bind(job: Job, task: Task, id: string | undefined): void {
    const c = id ? job.contracts?.find((x) => x.id === id) : undefined
    if (c) task.contract = { id: c.id, version: c.version }
  }

  // The contract tool: a contract for the job (the session's own when jobId is empty), new or as a new version of the
  // one with its id, with its baseline measured on the job's branch as it is now. Returns the answer to the micromanager.
  async contract(project: string, parent: string, jobId: string, json: string): Promise<string> {
    const job = jobId ? this.#jobs.get(key(project, jobId)) ?? listJobs(project).find((j) => j.id === jobId) : this.job(project, parent)
    if (!job) return `There is no job ${jobId} in this project. Nothing was stored.`
    const parsed = parseContract(json)
    if (!parsed.contract) return `Not stored: ${parsed.errors.join("; ")}.`
    const wanted = String((JSON.parse(json) as { id?: unknown }).id ?? "").toUpperCase()
    const old = wanted ? job.contracts?.find((c) => c.id === wanted) : undefined
    if (wanted && !old) return `Not stored: job ${job.id} has no contract ${wanted} to change; leave out the id for a new one.`
    if (old?.status === "frozen") return `Not stored: contract ${old.id} is frozen; only the user changes it.`
    const at = new Date().toISOString()
    const n = Math.max(0, ...(job.contracts ?? []).map((c) => Number(c.id.slice(1)))) + 1
    const c: Contract = old
      ? { ...old, ...parsed.contract, version: old.version + 1, baseline: undefined, history: [...old.history, { version: old.version + 1, change: "changed with the contract tool", at }] }
      : { id: `C${n}`, version: 1, status: "draft", ...parsed.contract, history: [{ version: 1, change: "defined with the contract tool", at }] }
    // The held-out cases come from a directory outside the project and go to the plugin's state directory; a new
    // version without them keeps the ones it had.
    if (parsed.heldOutFrom) {
      const kept = keepHeldOut(parsed.heldOutFrom, project, heldOutDir(project, job.id, c.id))
      if (!kept.heldOut) return `Not stored: ${kept.problem}.`
      c.corpus = { ...c.corpus, heldOut: kept.heldOut }
    } else if (old?.corpus.heldOut) c.corpus = { ...c.corpus, heldOut: old.corpus.heldOut }
    // The baseline is today's code on the job's branch, where the workers start from; a folder without git has only
    // itself.
    const rel = await this.#integrate(project, job, false)
    const dir = taskDir(job.integrationWorktree ?? project, rel)
    const { measured, seconds } = await runEvaluator(dir, c, "visible", this.#exec)
    this.#count(job, c, seconds)
    if (measured.valid) {
      const commit = job.integrationWorktree ? (await this.#exec("git", ["rev-parse", "--short", "HEAD"], { cwd: job.integrationWorktree })).stdout.trim() : undefined
      c.baseline = { values: { ...measured.values }, at, ...(commit ? { commit } : {}) }
      c.costPerEval = Math.round((seconds / c.repeats) * 10) / 10
      if (c.corpus.heldOut) {
        const held = await runEvaluator(dir, c, "heldout", this.#exec, heldOutDir(project, job.id, c.id))
        this.#count(job, c, held.seconds)
        if (held.measured.valid) c.baseline.heldOut = { ...held.measured.values }
      }
    }
    job.contracts = [...(job.contracts ?? []).filter((x) => x.id !== c.id), c]
    this.#jobs.set(key(project, job.id), job)
    saveJob(project, job)
    saveContract(project, job.id, c)
    if (!measured.valid) return `Contract ${c.id} (version ${c.version}) is stored for job ${job.id}, but its evaluator gave no valid result on today's code (${measured.error}), so it has no baseline and no writer can be measured against it yet. Fix the evaluator and send the contract again with "id": "${c.id}".`
    const held = c.corpus.heldOut ? ` It has ${c.corpus.heldOut.cases} held-out cases, which only the evaluator sees${c.baseline?.heldOut ? "" : "; on them today's code gave no valid result"}.` : ""
    return `Contract ${c.id} (version ${c.version}, ${c.status}) is stored for job ${job.id}. Baseline${c.baseline?.commit ? ` on ${c.baseline.commit}` : ""}: ${describe({ ...c, baseline: undefined }, measured)} (${c.costPerEval}s per run).${held} Start the writers it measures with a line "Contract: ${c.id}" (or "contract" in a todo).`
  }

  // The files a writer may read and run but not change, hashed as its worktree has them now: the ones its todo or
  // delegation asked for, the existing files its checks name that are not its own, and its contract's evaluator and
  // visible corpus. A file of its own write scope is never frozen: the two would contradict each other.
  async #freeze(job: Job, task: Task, entry: Entry): Promise<void> {
    const own = new Set(task.files)
    const c = entry.contract ? job.contracts?.find((x) => x.id === entry.contract) : undefined
    const corpus: string[] = []
    for (const p of c?.corpus.visible ?? []) {
      const listed = await this.#exec("git", ["ls-files", "--", p], { cwd: entry.dir })
      corpus.push(...listed.stdout.split("\n").map((l) => l.trim()).filter(Boolean))
    }
    const named = [...entry.checks, ...(c ? [c.evaluator] : [])].flatMap((command) => namedFiles(command, entry.dir))
    const paths = [...new Set([...(task.freeze ?? []), ...named, ...corpus])].filter((p) => !own.has(p)).sort()
    if (!paths.length) return
    entry.frozen = await hashFiles(entry.worktree, paths, this.#exec, entry.dir)
    task.frozen = Object.fromEntries(entry.frozen)
  }

  // A writer's frozen files as absolute paths, for the sandbox (src/sandbox.ts denyWrite) and the permission hook.
  frozenOf(session: string): string[] {
    const entry = this.#entry(session)
    return entry?.writer && entry.frozen ? [...entry.frozen.keys()].map((f) => resolve(entry.dir, f)) : []
  }

  // The resources of a write request that are frozen for this writer; resources are paths relative to its directory or
  // absolute.
  frozenHit(session: string, resources: readonly string[]): string[] {
    const entry = this.#entry(session)
    if (!entry?.writer || !entry.frozen?.size) return []
    const frozen = new Set(this.frozenOf(session))
    return resources.filter((r) => frozen.has(isAbsolute(r) ? resolve(r) : resolve(entry.dir, r)))
  }

  // A worker's report as it ended: its FOLLOWUP lines go to the job's later list, unless the job has the work already
  // (a task with nearly that title) or the list has it. They become backlog drafts when the job ends (backlog()).
  noteFollowUps(session: string, report: string): Later[] {
    const entry = this.#entry(session)
    const job = entry && this.#job(entry)
    if (!entry || !job) return []
    const known = [...job.tasks.map((t) => t.title), ...(job.later ?? []).map((l) => l.what)]
    const added = parseReport(report).followUps
      .filter((f) => !known.some((k) => similarity(k, f.what) >= SAME_WORK))
      .slice(0, 5)
      .map((f): Later => ({ ...f, from: entry.taskId, reason: "reported" }))
    if (!added.length) return []
    job.later = [...(job.later ?? []), ...added]
    saveJob(entry.project, job)
    return added
  }

  // The job ended (merged into the checkout or discarded): what it found and did not do goes to the backlog as drafts,
  // so it outlives the session. A follow-up that a task of the job took up after all is left out, and so is a failed
  // trial that a later task did over. Each item is written once. The item the job was started from (plan_job
  // backlog:<slug>) is done once the job is merged, and ready again once it is discarded.
  backlog(project: string, job: Job, merged: boolean, backend: BacklogBackend = localBackend, now = new Date()): { drafts: BacklogItem[]; source: BacklogItem[] } {
    const live = this.#jobs.get(key(project, job.id)) ?? job
    const items = backend.list(project)
    const source = items.filter((i) => i.job === live.id && i.status === "running")
    for (const i of source) {
      i.status = merged ? "done" : "ready"
      backend.save(project, i)
    }
    const taken = new Set(items.map((i) => i.slug))
    const drafts: BacklogItem[] = []
    const save = (item: BacklogItem) => {
      backend.save(project, item)
      taken.add(item.slug)
      drafts.push(item)
    }
    for (const l of live.later ?? []) {
      if (l.draft || live.tasks.some((t) => t.id !== l.from && similarity(t.title, l.what) >= SAME_WORK)) continue
      const item = draftFromLater(l, live, taken, now)
      save(item)
      l.draft = item.slug
    }
    for (const head of live.tasks.filter((t) => t.trial?.of === t.id)) {
      const trial = standing(live, head)
      if (trial.winner || trial.live.length || !trial.failed.length || trial.all.some((t) => t.replacedBy) || head.stages.some((s) => s.stage === "backlog")) continue
      const checks = live.acceptance.filter((a) => head.acceptance.includes(a.id)).flatMap((a) => (a.verify ? [a.verify] : []))
      const item = draftFromTrial(live, head, trial.failed, checks, taken, now)
      save(item)
      stage(head, "backlog", "pass", `draft ${item.slug}`)
    }
    if (drafts.length) saveJob(project, live)
    return { drafts, source }
  }

  // What a writer asking for a check change is, for the request: its job, task, model and how often it asked.
  changeContext(session: string): { project: string; job: Job; task: Task; parent: string; asked: number } | undefined {
    const entry = this.#entry(session)
    const job = entry && this.#job(entry)
    const task = job?.tasks.find((t) => t.id === entry!.taskId)
    if (!entry?.writer || !job || !task) return undefined
    return { project: entry.project, job, task, parent: entry.parent, asked: task.checkChanges?.length ?? 0 }
  }

  // A decided check change, on the task (and the outcome log after it).
  recordChange(project: string, jobId: string, taskId: string, kind: ChangeKind, a: ChangeAnswer, id: string, target: string): void {
    const job = this.#jobs.get(key(project, jobId))
    const task = job?.tasks.find((t) => t.id === taskId)
    if (!job || !task) return
    task.checkChanges = [...(task.checkChanges ?? []), { kind, accepted: a.accepted, by: a.by }]
    stage(task, "check-change", a.accepted ? "pass" : "fail", `${id} ${kind}: ${target.slice(0, 120)}${a.note ? ` (${a.note.slice(0, 120)})` : ""}`)
    saveJob(project, job)
  }

  // An accepted check change, applied from outside: the worker never touches the check itself. A check command is
  // replaced; a frozen file gets the proposed diff and is frozen again as it is now; a contract gets a new version. In a
  // trial every attempt still at work gets the same change and a note, so all are measured by the same rule. Returns
  // what was done, or why it could not be, and the notes for the other attempts.
  async applyCheckChange(project: string, jobId: string, taskId: string, r: { kind: ChangeKind; target: string; problem: string; proposal: string; id: string }): Promise<{ ok: boolean; text: string; steer: { session: string; note: string }[] }> {
    const job = this.#jobs.get(key(project, jobId))
    const task = job?.tasks.find((t) => t.id === taskId)
    const entry = this.#entries.get(`${jobId}/${taskId}`)
    if (!job || !task || !entry) return { ok: false, text: "the task is gone", steer: [] }
    const siblings = task.trial ? standing(job, task).live.filter((t) => t !== task) : []
    const entries = [entry, ...siblings.map((t) => this.#entries.get(`${job.id}/${t.id}`)).filter((e): e is Entry => Boolean(e && !e.ended))]
    const steer = (what: string) => entries.slice(1).filter((e) => e.session).map((e) => ({ session: e.session!, note: `[micromanager] ${r.id}: the check change another attempt asked for is accepted and applied to your worktree as well: ${what}. Your checks run against it from now on. This note comes from your own plugin; it is trusted.` }))
    if (r.kind === "contract") {
      const c = job.contracts?.find((x) => x.id === task.contract?.id)
      if (!c) return { ok: false, text: "the task is measured against no contract", steer: [] }
      let proposal: Record<string, unknown>
      try {
        proposal = JSON.parse(r.proposal) as Record<string, unknown>
      } catch {
        return { ok: false, text: "the proposal is no contract JSON", steer: [] }
      }
      const text = await this.contract(project, entry.parent, job.id, JSON.stringify({ ...proposal, id: c.id }))
      if (!text.startsWith(`Contract ${c.id} (version`)) return { ok: false, text, steer: [] }
      const now = job.contracts!.find((x) => x.id === c.id)!
      for (const e of entries) this.#bind(job, job.tasks.find((t) => t.id === e.taskId)!, c.id)
      return { ok: true, text: `contract ${c.id} is version ${now.version} now`, steer: steer(`contract ${c.id} is version ${now.version} now`) }
    }
    if (r.kind === "spec_incomplete") job.decisions.push({ id: `D${job.decisions.length + 1}`, text: `${r.problem.slice(0, 300)} Decided: ${r.proposal.slice(0, 300)}`, origin: "user" })
    const target = normalTarget(r.target)
    const check = entry.checks.find((c) => normalTarget(c) === target)
    if (check) {
      const next = r.proposal.trim()
      const why = checkSetProblems([next], true)
      if (why) return { ok: false, text: `the proposed check is not one: ${why}`, steer: [] }
      for (const e of entries) {
        e.checks = e.checks.map((c) => (normalTarget(c) === target ? next : c))
        const t = job.tasks.find((x) => x.id === e.taskId)!
        job.acceptance = job.acceptance.map((a) => (t.acceptance.includes(a.id) && a.verify ? { ...a, verify: e.checks.join(" && ") } : a))
      }
      saveJob(project, job)
      return { ok: true, text: `the check "${check}" is "${next}" now`, steer: steer(`the check "${check}" is "${next}" now`) }
    }
    const path = r.target.trim().replace(/^\.\//, "")
    const known = entry.frozen?.has(path) || (() => { try { return statSync(join(entry.dir, path)).isFile() } catch { return false } })()
    if (!known) return { ok: false, text: `${r.target.trim()} is neither a check of the task nor a file in its directory`, steer: [] }
    const scratch = mkdtempSync(join(tmpdir(), "mm-change-"))
    try {
      const patch = join(scratch, "change.patch")
      writeFileSync(patch, r.proposal.endsWith("\n") ? r.proposal : `${r.proposal}\n`)
      for (const e of entries) {
        const args = ["apply", "--whitespace=nowarn", ...(e.rel ? [`--directory=${e.rel}`] : []), patch]
        const applied = await this.#exec("git", args, { cwd: e.worktree })
        if (applied.code !== 0) return { ok: false, text: `the diff does not apply to ${path}${e === entry ? "" : ` in ${e.taskId}'s worktree`}: ${applied.stderr.trim().slice(0, 300)}`, steer: [] }
        if (e.frozen?.has(path)) {
          const hash = (await hashFiles(e.worktree, [path], this.#exec, e.dir)).get(path) ?? ""
          e.frozen.set(path, hash)
          const t = job.tasks.find((x) => x.id === e.taskId)!
          t.frozen = Object.fromEntries(e.frozen)
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
    saveJob(project, job)
    return { ok: true, text: `${path} is changed as proposed${entry.frozen?.has(path) ? " and frozen again" : ""}`, steer: steer(`${path} is changed as proposed`) }
  }

  // What a contract's evaluations cost: on the contract (its stop rule) and on the job (its counters).
  #count(job: Job, c: Contract, seconds: number): void {
    c.used = { evaluations: (c.used?.evaluations ?? 0) + 1, seconds: Math.round(((c.used?.seconds ?? 0) + seconds) * 10) / 10 }
    job.counters.evals = (job.counters.evals ?? 0) + 1
    job.counters.evalSeconds = Math.round(((job.counters.evalSeconds ?? 0) + seconds) * 10) / 10
  }

  // A writer's work measured against its contract, after its checks passed. Returns a failure the gate treats like a
  // failing check (an invalid result or a broken guard), with exhausted when the contract's stop rule allows no
  // further evaluation; or the evidence for a passing fitness stage.
  async #measure(entry: Entry, job: Job, task: Task): Promise<{ failed?: GateResult; exhausted?: boolean; evidence?: string }> {
    const c = job.contracts?.find((x) => x.id === entry.contract)
    if (!c) return {}
    const used = c.used ?? { evaluations: 0, seconds: 0 }
    const spent = (c.stop.evaluations && used.evaluations >= c.stop.evaluations && `${c.stop.evaluations} evaluations`) || (c.stop.seconds && used.seconds >= c.stop.seconds && `${c.stop.seconds}s of evaluation`)
    if (spent) return { failed: { command: `evaluator of ${c.id}`, passed: false, code: -1, output: `not run: contract ${c.id} allows ${spent}, and they are used up` }, exhausted: true }
    const { measured, seconds } = await runEvaluator(entry.dir, c, "visible", this.#exec)
    this.#count(job, c, seconds)
    const broken = measured.valid ? guardViolations(c, measured) : []
    if (!measured.valid || broken.length) {
      const why = measured.valid ? `guard broken: ${broken.join("; ")}` : measured.error ?? "invalid"
      return { failed: { command: `evaluator of ${c.id}: ${c.evaluator}`, passed: false, code: measured.valid ? 0 : 1, output: Object.keys(measured.values).length ? `${why}\nMeasured: ${describe(c, { ...measured, valid: true })}` : why } }
    }
    task.score = { ...measured, corpus: "visible", at: new Date().toISOString() }
    return { evidence: describe(c, measured) }
  }

  // The difficulty on the task, and a trial when the plugin asked for one and the job can run one: in worktrees of its
  // own (no trial without git) and with Parallel on.
  #assess(project: string, job: Job, task: Task, assess?: Assessment): void {
    if (assess?.difficulty !== undefined) task.difficulty = assess.difficulty
    if (!assess || assess.trials < 2 || !WRITERS.has(task.role) || job.isolation === "none") return
    if (!optionsOf(loadControl(project, job.id), lastOptions(project)).parallel) return
    task.trial = { of: task.id, n: assess.trials }
    task.title = `${task.title.replace(/ \(attempt \d+\/\d+\)$/, "")} (attempt 1/${assess.trials})`.slice(0, 140)
  }

  // "Attempt: T5 · job-…": another attempt of T5's trial. It gets T5's task, files and checks, a worktree of its own,
  // and is not refused as the same work: that is what it is meant to be.
  async #attempt(project: string, parent: string, role: Role, d: Delegation, attempt: NonNullable<Delegation["attempt"]>, model: string): Promise<Delegated> {
    const job = this.#jobs.get(key(project, attempt.job)) ?? listJobs(project).find((j) => j.id === attempt.job)
    if (!job) throw new DelegationError(`Not started: there is no job ${attempt.job} in this project.`)
    if (job.facilitator && job.facilitator !== parent) throw new DelegationError(`Not started: job ${job.id} belongs to another micromanager session.`)
    if (loadControl(project, job.id).stopped) throw new DelegationError(`Not started: the user stopped job ${job.id}. Ask them whether to go on; nothing starts until they start it again.`)
    const head = job.tasks.find((t) => t.id === attempt.task)
    if (!head?.trial || head.trial.of !== head.id) throw new DelegationError(`Not started: ${attempt.task} runs no trial; start a task with its own prompt instead.`)
    if (head.role !== role.id) throw new DelegationError(`Not started: ${head.id} is a task for ${roleById(head.role)?.agent ?? head.role}; start its attempts with that agent.`)
    const now = standing(job, head)
    if (now.winner) throw new DelegationError(`Not started: ${now.winner.id} already won the trial of ${head.id}; its work is merged.`)
    if (now.all.length >= head.trial.n) throw new DelegationError(`Not started: the trial of ${head.id} has all its ${head.trial.n} attempts already (${now.all.map((t) => t.id).join(", ")}).`)
    const checks = this.#entries.get(`${job.id}/${head.id}`)?.checks ?? []
    const title = `${head.title.replace(/ \(attempt \d+\/\d+\)$/, "")} (attempt ${now.all.length + 1}/${head.trial.n})`
    const added = addDelegated(job, { title, prompt: head.description, files: head.files, dependsOn: [], checks })
    if (!added.task) throw new DelegationError(`Not started: ${added.errors!.join("; ")}`)
    const task = added.task
    task.role = role.id
    task.model = model
    task.trial = { ...head.trial }
    if (head.difficulty !== undefined) task.difficulty = head.difficulty
    if (head.contract) task.contract = { ...head.contract }
    if (head.freeze) task.freeze = [...head.freeze]
    this.#jobs.set(key(project, job.id), job)
    for (const s of ["ready", "planned", "running"] as const) moveTask(task, s)
    stage(task, "delegate", "pass", `${role.agent} on ${model}, attempt of ${head.id}`)
    const rel = await this.#integrate(project, job, true)
    const body = job.rolling ? head.description : this.#plannedBody(job, head, d.body)
    return this.#start(project, parent, job, task, role, model, { ...d, body }, checks, rel)
  }

  // The fan-out note for a trial's first attempt, once its subagent call went through; undefined for any other task.
  trialNote(project: string, jobId: string, taskId: string): string | undefined {
    const job = this.#jobs.get(key(project, jobId))
    const task = job?.tasks.find((t) => t.id === taskId)
    return job && task ? fanOutText(job, task) : undefined
  }

  // The models a trial's attempts run on so far, so the next attempt goes to another family.
  trialModels(project: string, jobId: string, taskId: string): string[] {
    const job = this.#jobs.get(key(project, jobId)) ?? listJobs(project).find((j) => j.id === jobId)
    const task = job?.tasks.find((t) => t.id === taskId)
    return job && task ? attempts(job, task).map((t) => t.model).filter((m): m is string => Boolean(m)) : []
  }

  // The job's branch and its worktree, made at its first task. Returns the project's offset inside the repository.
  async #integrate(project: string, job: Job, writer = true): Promise<string> {
    if (job.isolation === "none") {
      job.integrationWorktree = project
      job.integrationRel = ""
      return ""
    }
    if (!job.integrationWorktree) {
      if ((await gitState(project, this.#exec)) !== "repo") {
        if (!writer) return "" // a reader changes nothing: it reads the project folder itself, no question needed
        const note = this.#noGit ? await this.#noGit(project) : `${project} is no git repository with a commit, so workers cannot get a worktree each. Ask the user whether to create one or to work without isolation.`
        throw new NoGitError(`Not started: ${note}`)
      }
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
    return job.integrationRel ?? (job.integrationWorktree ? await repoRel(project, this.#exec) : "")
  }

  // A running task's entry, its worktree (writer) and the worker's brief.
  async #start(project: string, parent: string, job: Job, task: Task, role: Role, model: string, d: Delegation, checks: string[], rel: string): Promise<Delegated> {
    const writer = WRITERS.has(role.id)
    const base = job.integrationWorktree ?? project // a reader in a folder without git reads the folder itself
    const entry: Entry = { project, jobId: job.id, taskId: task.id, parent, writer, dir: taskDir(base, rel), worktree: base, rel, checks, ...(task.contract ? { contract: task.contract.id } : {}) }
    if (writer && job.isolation === "none") {
      // No git: the project itself, and no branch; the worktree is the project, so adopt and resume keep it.
      task.worktree = project
      task.worktreeRel = ""
    } else if (writer) {
      const w = await prepareTaskWorktree(project, job.id, task.id, job.integrationBranch!, this.#exec, undefined, rel)
      entry.dir = w.dir
      entry.worktree = w.worktree
      entry.branch = w.branch
      task.worktree = w.worktree
      task.worktreeRel = w.rel
      task.branch = w.branch
    }
    if (writer) await this.#freeze(job, task, entry)
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

  // run_job: a planned job runs on the micromanager's own workers from now on. The job's phase goes to execute and the
  // session becomes its facilitator; nextStep (src/continuation.ts) then names the tasks to start.
  runPlanned(project: string, jobId: string, parent: string): { job?: Job; problem?: string } {
    const job = this.#jobs.get(key(project, jobId)) ?? listJobs(project).find((j) => j.id === jobId)
    if (!job) return { problem: `there is no job ${jobId} in this project` }
    if (job.rolling) return { problem: `${jobId} holds the tasks you delegated yourself; it has no plan to run` }
    if (!job.tasks.length) return { problem: `${jobId} has no tasks yet; plan it with plan_job first` }
    if (job.phase === "plan_gate") moveJob(job, "execute")
    else if ((job.phase === "paused" || job.phase === "ask_user") && job.resumePhase === "execute") moveJob(job, "execute")
    if (job.phase !== "execute") return { problem: `job ${jobId} is in phase ${job.phase}, not ready to run` }
    job.native = true
    if (job.facilitator !== parent) {
      job.facilitator = parent
      for (const entry of this.#entries.values()) if (entry.jobId === job.id && entry.project === project) entry.parent = parent
    }
    this.#jobs.set(key(project, job.id), job)
    saveJob(project, job)
    return { job }
  }

  // "Task: T5 · job-…": the micromanager starts a task of a planned job (run_job). The plan already says what it is:
  // its role, files, acceptance points and checks; the prompt can add to it. A task that ran before (on the runner, or
  // a worker that stopped) starts over in a fresh worktree; continuing its old worker is the way to keep its change.
  async #planned(project: string, parent: string, role: Role, d: Delegation, planned: NonNullable<Delegation["planned"]>, model: string, assess?: Assessment): Promise<Delegated> {
    const job = this.#jobs.get(key(project, planned.job)) ?? listJobs(project).find((j) => j.id === planned.job)
    if (!job) throw new DelegationError(`Not started: there is no job ${planned.job} in this project.`)
    if (!job.native && !job.rolling) throw new DelegationError(`Not started: job ${job.id} is not running on your workers; start it with run_job first.`)
    if (job.facilitator && job.facilitator !== parent) throw new DelegationError(`Not started: job ${job.id} belongs to another micromanager session; run_job ${job.id} here takes it over.`)
    if (job.phase !== "execute") throw new DelegationError(`Not started: job ${job.id} is ${job.phase}; run_job resumes it.`)
    const control = loadControl(project, job.id)
    if (control.stopped) throw new DelegationError(`Not started: the user stopped job ${job.id}. Ask them whether to go on; nothing starts until they start it again.`)
    const unstarted = this.#planFirst && job.rolling && WRITERS.has(role.id) ? this.startNote(project, job) : undefined
    if (unstarted) throw new DelegationError(`Not started: ${unstarted}`)
    const task = job.tasks.find((t) => t.id === planned.task)
    if (!task) throw new DelegationError(`Not started: job ${job.id} has no task ${planned.task}.`)
    const agent = roleById(task.role)?.agent ?? task.role
    if (task.role !== role.id) throw new DelegationError(`Not started: ${task.id} is a task for ${agent}; start it with agent ${agent}.`)
    const k = `${job.id}/${task.id}`
    const old = this.#entries.get(k)
    if (LIVE.has(task.status) && old && !old.ended) throw new DelegationError(`Not started: ${task.id} runs already${old.session ? ` (session ${old.session})` : ""}; its report comes to you when it ends.`)
    if (task.status === "merged" || task.status === "passed") throw new DelegationError(`Not started: ${task.id} is done already (${task.status}).`)
    if (WRITERS.has(role.id) && (job.isolation === "none" || !optionsOf(control, lastOptions(project)).parallel)) {
      const busy = [...this.#entries.values()].find((e) => e.jobId === job.id && e.project === project && e.writer && !e.ended && e.taskId !== task.id)
      if (busy) throw new DelegationError(`Not started: ${job.isolation === "none" ? `job ${job.id} works without git, so one writer at a time` : `Parallel is off for job ${job.id}`}, and ${busy.taskId} still runs; start ${task.id} after its report.`)
    }
    const byId = new Map(job.tasks.map((t) => [t.id, t]))
    const elsewhere = (id: string) => { const [owner, taskId] = this.#owner(project, job, id); return owner?.tasks.find((t) => t.id === taskId)?.status }
    const waits = task.dependsOn.filter((id) => { const dep = byId.get(id); return !dep || !settled(job, dep, elsewhere) })
    if (waits.length) throw new DelegationError(`Not started: ${task.id} waits for ${waits.join(", ")}; start it when ${waits.length > 1 ? "they are" : "it is"} merged.`)
    const checks = d.checks.length ? d.checks : [...new Set(taskAcceptance(job, task).map((a) => a.verify).filter((v): v is string => Boolean(v)))]
    if (d.checks.length) {
      const problem = checkSetProblems(d.checks, WRITERS.has(role.id))
      if (problem) throw new DelegationError(`Not started: ${problem}`)
    }
    const contract = d.contract ?? task.contract?.id
    this.#contractFor(job, WRITERS.has(role.id), contract, assess)
    this.#jobs.set(key(project, job.id), job)
    if (old) {
      await this.#dropWorktree(old, task)
      this.#entries.delete(k)
    } else if (task.worktree && task.branch) {
      await removeTaskWorktree(project, { worktree: task.worktree, branch: task.branch }, this.#exec).catch(() => undefined)
      task.worktree = undefined
      task.branch = undefined
    }
    // A todo that does other tasks over: their worktrees go now, as for a delegation's "Replaces:" line.
    await this.#replace(project, job, task.replaces ?? [])
    restart(task)
    task.model = model
    task.attempts = 0
    // A task started again starts a new trial, if it gets one: the old attempts' trial is over.
    task.trial = undefined
    this.#assess(project, job, task, assess)
    this.#bind(job, task, contract)
    if (d.frozen) task.freeze = [...new Set([...(task.freeze ?? []), ...parseFiles(d.frozen, project).files])]
    stage(task, "delegate", "pass", `${role.agent} on ${model}, planned task`)
    const rel = await this.#integrate(project, job, WRITERS.has(role.id))
    return this.#start(project, parent, job, task, role, model, { ...d, body: this.#plannedBody(job, task, d.body) }, checks, rel)
  }

  // A planned task's brief: the job, the task, its acceptance points and decisions, and what the micromanager added.
  #plannedBody(job: Job, task: Task, extra: string): string {
    const acceptance = taskAcceptance(job, task).map((a) => `- ${a.id}: ${a.text}${a.verify ? ` (checked with: ${a.verify})` : ""}${sharedNote(job, task, a.id)}`)
    return [
      `The job: ${job.goal}`,
      "",
      `Your task (${task.id}): ${task.title.replace(/ \(attempt \d+\/\d+\)$/, "")}`,
      task.description,
      "",
      "Acceptance points:",
      ...(acceptance.length ? acceptance : ["- none given"]),
      job.decisions.length ? `\nDecisions that apply: ${job.decisions.map((x) => x.text).join("; ")}` : "",
      extra ? `\nFrom the micromanager: ${extra}` : "",
    ].filter((line) => line !== "").join("\n")
  }

  // "Replaces: T5": the micromanager starts T5's work over on purpose. T5 is cancelled and its worktree, with whatever
  // change it held, goes; a task that still runs has to be stopped first, and a merged one has nothing to replace.
  async #replace(project: string, job: Job, ids: readonly string[]): Promise<void> {
    const cannot = this.#replaceable(project, job, ids)
    if (cannot.length) throw new DelegationError(`Not started: ${cannot.join("; ")}`)
    for (const id of ids) {
      const [owner, taskId] = this.#owner(project, job, id)
      if (owner && owner.tasks.find((t) => t.id === taskId)?.status !== "cancelled") await this.discard(project, owner, taskId, "replace", "started over by a new task")
    }
  }

  // The job a replaced id lives in and the task id inside it: "T19" in this job, "job-…/T18" in another of the project.
  #owner(project: string, job: Job, id: string): [Job | undefined, string] {
    const [jobId, taskId] = id.includes("/") ? id.split("/") as [string, string] : [job.id, id]
    if (jobId === job.id) return [job, taskId]
    return [this.current(project, jobId) ?? listJobs(project).find((j) => j.id === jobId), taskId]
  }

  // Why the given tasks cannot be done over: missing, still running, or merged already. Empty when they can.
  #replaceable(project: string, job: Job, ids: readonly string[]): string[] {
    return ids.flatMap((id) => {
      const [owner, taskId] = this.#owner(project, job, id)
      const task = owner?.tasks.find((t) => t.id === taskId)
      if (!owner || !task) return [`there is no task ${id} to replace`]
      if (LIVE.has(task.status) && !this.#entries.get(`${owner.id}/${taskId}`)?.ended) return [`${id} still runs; stop it with stop_task first, then replace it`]
      if (task.status === "merged" || task.status === "passed") return [`${id} is ${task.status}, so there is nothing to replace; say in the new task what to change on top of it`]
      return []
    })
  }

  // The link both ways: the new task names what it does over, each old task the one doing it (job-qualified across jobs).
  #link(project: string, job: Job, task: Task, ids: readonly string[]): void {
    if (!ids.length) return
    task.replaces = [...ids]
    for (const id of ids) {
      const [owner, taskId] = this.#owner(project, job, id)
      const old = owner?.tasks.find((t) => t.id === taskId)
      if (!owner || !old) continue
      old.replacedBy = owner === job ? task.id : `${job.id}/${task.id}`
      if (owner !== job) saveJob(project, owner)
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
      if (task.frozen) added.task.frozen = { ...task.frozen }
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
    // The sidebar tells a stopped worker by its last stage ("end"): continuing it runs again.
    stage(task, "resume", "pass", `continued in session ${session}`)
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

  // A worker's role, for the tools it may use (request_network: writers and researchers).
  roleOf(session: string): RoleId | undefined {
    const entry = this.#entry(session)
    return (entry && this.#job(entry)?.tasks.find((t) => t.id === entry.taskId)?.role) as RoleId | undefined
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
  // stop: the sessions of a trial's other attempts, which the plugin interrupts once one attempt won.
  async finish(session: string, summary: string): Promise<{ text: string; note?: string; parent?: string; stop?: string[] }> {
    const entry = this.#entry(session)
    const job = entry && this.#job(entry)
    const task = job?.tasks.find((t) => t.id === entry!.taskId)
    if (!entry || !job || !task) return { text: "This session has no task of the micromanager; there is nothing to finish." }
    if (!entry.writer) return { text: "You only read: there is nothing to check or merge. End with your findings; they are your result." }
    if (task.status === "merged") return { text: `${task.id} is already merged into ${job.integrationBranch}. End with your short report.` }
    if (task.trial && task.status === "cancelled") return { text: lostText(job, task) }
    if (task.status === "escalated") moveTask(task, "running")
    moveTask(task, "gating")
    task.summary = summary.trim().slice(0, 2000) || task.summary
    // The checks run where the worker's files are, not in the worktree root: a project below the repository root lives
    // that far down, and a check naming one of its files finds nothing above it.
    // Frozen files first: a changed test is put back before the checks run, so they judge the code against the tests as
    // they were, and the worker hears what it may not do.
    const frozen = entry.frozen ? await frozenChanged(entry.worktree, entry.frozen, this.#exec, entry.dir) : []
    if (frozen.length) await revertFiles(entry.worktree, frozen, this.#exec, entry.dir)
    const results = await runGate(entry.worktree, entry.checks, this.#exec, undefined, entry.dir)
    if (frozen.length) results.push({ command: "frozen files unchanged", passed: false, code: 1, output: `You changed ${frozen.join(", ")}, which you may read and run but not change; they are restored to how they were. Change the code instead. If one of them is wrong, ask for the change with request_check_change, with the line that shows it.` })
    const graded = gradedOf(results)
    if (graded) task.graded = graded
    const failed = results.filter((r) => !r.passed)
    // Another attempt of its trial won while these checks ran (and took the worktree away).
    if (task.status === "cancelled") return { text: lostText(job, task) }
    // The contract's evaluator runs only once the checks pass: it may take minutes, and a broken build measures nothing.
    const fitness = failed.length ? {} : await this.#measure(entry, job, task)
    // The evaluator can take minutes, and the trial may be decided meanwhile (TypeScript cannot see that across await).
    if ((task.status as Task["status"]) === "cancelled") return { text: lostText(job, task) }
    if (fitness.failed) {
      failed.push(fitness.failed)
      stage(task, "gate", "pass", entry.checks.join(", "))
      // A used-up stop rule is final for this worker: another fix round could not be measured.
      if (fitness.exhausted) task.attempts = FIX_ROUNDS
    }
    const what = fitness.failed ? "fitness" : "gate"
    if (failed.length) {
      // The same cap the runner applies to its fix rounds (runner.ts: #work, `fixRounds ?? 2`). Without it a check that
      // cannot be satisfied in this environment -- a path that does not exist, a command the gate refuses -- was handed
      // back to the model until the watchdog's step limit stopped it, burning a session for nothing (live test,
      // 2026-10-06: four identical gate failures, then the worker gave up). The last failure goes back with the
      // reason, because at the cap the useful message is that the CHECK is the problem, not the work.
      task.attempts++
      if (task.attempts > FIX_ROUNDS) {
        stage(task, what, "fail", failed.map((f) => f.command).join(", "))
        moveTask(task, "blocked")
        task.summary = `its checks still fail after ${FIX_ROUNDS} fix round(s): ${failed.map((f) => f.command).join(", ")}`
        const note = this.#trialFailed(job, task, entry.project) ?? `[micromanager] ${task.id} ${task.title}: its worker hit the limit of ${FIX_ROUNDS} fix rounds with the checks still failing (${failed.map((f) => f.command).join(", ")}). If the check is what is wrong -- a path that does not exist in the worktree, a command the gate refuses -- correct the task with steer_task and its sessionID ${session} rather than starting a new worker.`
        saveJob(entry.project, job)
        return {
          text: `Your checks still fail after ${FIX_ROUNDS} rounds, so I am stopping here rather than spending the rest of your budget on them:\n\n${failed.map((f) => `$ ${f.command} (exit ${f.code})\n${f.output}`).join("\n\n")}\n\nIf the work is done and the CHECK is what cannot be satisfied here, say so plainly in your report (request_check_change is the way to have a wrong check changed). If the work is not done, name what is missing.`,
          note,
          parent: entry.parent,
        }
      }
      moveTask(task, "fixing")
      moveTask(task, "running")
      stage(task, what, "fail", fitness.failed ? fitness.failed.output.split("\n")[0]! : failed.map((f) => f.command).join(", "))
      saveJob(entry.project, job)
      return { text: failText(fitness.failed ? `Your checks pass, but the fitness contract does not hold (fix round ${task.attempts} of ${FIX_ROUNDS})` : `The checks fail in your directory (fix round ${task.attempts} of ${FIX_ROUNDS})`, failed, entry.dir) }
    }
    if (job.isolation === "none") {
      // No git: nothing to commit or merge, and no way to see what changed; the checks are the evidence.
      stage(task, "gate", "pass", entry.checks.length ? entry.checks.join(", ") : "no checks given")
      if (fitness.evidence) stage(task, "fitness", "pass", fitness.evidence)
      moveTask(task, "passed")
      saveJob(entry.project, job)
      const checks = `${entry.checks.length ? `checks passed: ${entry.checks.join("; ")}` : "no checks were given"}${fitness.evidence ? `; measured: ${fitness.evidence}` : ""}`
      return {
        text: `Done; your change is in the project folder (no git, so nothing is committed); ${checks}. Now end with your short report.`,
        note: `[micromanager] ${task.id} ${task.title}: done in the project folder (no git); ${checks}.`,
        parent: entry.parent,
      }
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
        note: this.#trialFailed(job, task, entry.project) ?? `[micromanager] ${task.id} ${task.title}: its checks passed but it changed no file, so nothing was committed. Continue it with the subagent tool and sessionID ${session}, or tell the user.`,
        parent: entry.parent,
      }
    }
    stage(task, "gate", "pass", entry.checks.length ? entry.checks.join(", ") : "no checks given")
    if (fitness.evidence) stage(task, "fitness", "pass", fitness.evidence)
    const commit = await commitTask(entry.worktree, `${task.id}: ${task.title}`, `Job: ${job.id}\nWorker: ${task.model ?? "?"} (${task.role}), session ${session}${task.summary ? `\n\n${task.summary}` : ""}`, this.#exec)
    moveTask(task, "passed")
    const scored = task.trial && entry.contract ? job.contracts?.find((x) => x.id === entry.contract) : undefined
    if (scored) return this.#hold(entry, job, task, scored, fitness.evidence)
    const train = this.#trains.get(job.id) ?? Promise.resolve()
    const step = train.then(() => (task.status === "cancelled" ? { ok: false as const, text: lostText(job, task) } : this.#merge(entry, job, task)))
    this.#trains.set(job.id, step.catch(() => undefined))
    const merged = await step
    saveJob(entry.project, job)
    if (!merged.ok) return { text: merged.text }
    const won = task.trial ? await this.#settleTrial(entry, job, task) : undefined
    // The commit as merged: a rebase onto other tasks' commits gave it a new id (live test).
    const head = commit && (await this.#exec("git", ["rev-parse", "--short", "HEAD"], { cwd: entry.worktree })).stdout.trim()
    const checks = `${entry.checks.length ? `checks passed: ${entry.checks.join("; ")}` : "no checks were given"}${fitness.evidence ? `; measured: ${fitness.evidence}` : ""}`
    return {
      text: `Merged into ${job.integrationBranch}${head ? ` as ${head}` : " (nothing to commit)"}; ${checks}. Now end with your short report.`,
      note: won?.note ?? `[micromanager] ${task.id} ${task.title}: merged into ${job.integrationBranch}${head ? ` (${head})` : ", nothing changed"}; ${checks}.`,
      parent: entry.parent,
      ...(won?.stop.length ? { stop: won.stop } : {}),
    }
  }

  // A trial's attempt merged: it won. Every other attempt is done over by it (replacedBy, so what waits for the first
  // attempt waits for the winner), cancelled, and its worktree goes; the ones still at work are returned to be stopped.
  // score: how the winner won a trial decided by its contract, for the note; the held attempts it beat lost on score.
  async #settleTrial(winner: Entry, job: Job, task: Task, score?: string): Promise<{ note: string; stop: string[] }> {
    const now = standing(job, task)
    const stop: string[] = []
    const stopped = now.live.filter((t) => t !== task)
    const beaten = now.held.filter((t) => t !== task)
    for (const other of now.all) {
      if (other === task || other.status === "merged" || other.status === "cancelled") continue
      const e = this.#entries.get(`${job.id}/${other.id}`)
      if (e?.session && !e.ended && now.live.includes(other)) stop.push(e.session)
      moveTask(other, "cancelled")
      stage(other, "trial", "pass", other.held ? `won by ${task.id} on score` : `won by ${task.id}`)
      other.replacedBy = task.id
      if (e) await this.#dropWorktree(e, other)
    }
    // The first attempt is what the plan and the dependants know: done over by the winner, it counts as done.
    stage(task, "trial", "pass", `won the trial of ${task.trial!.of}${score ? ` on score (${score})` : ""} (${now.failed.length} failed, ${stopped.length} stopped${beaten.length ? `, ${beaten.length} beaten` : ""})`)
    saveJob(winner.project, job)
    return { note: wonText(job, task, stopped, now.failed.length, undefined, score !== undefined ? { beaten, how: score } : undefined), stop }
  }

  // A passed attempt of a trial decided by score: measured on the held-out cases too, committed, and held in its
  // worktree instead of merged. The worker hears only how many held-out cases passed. The trial is decided when no
  // attempt is at work any more, at its deadline, or at once when one reaches the contract's target.
  async #hold(entry: Entry, job: Job, task: Task, c: Contract, visible?: string): Promise<{ text: string; note?: string; parent?: string; stop?: string[] }> {
    let held: Measured | undefined
    if (c.corpus.heldOut) {
      const r = await runEvaluator(entry.dir, c, "heldout", this.#exec, heldOutDir(entry.project, job.id, c.id))
      this.#count(job, c, r.seconds)
      held = r.measured
      task.score = { ...held, corpus: "heldout", at: new Date().toISOString() }
    }
    task.held = true
    stage(task, "trial", "pass", `passed, waits for the trial to be decided by score${held ? `; held-out ${coarse(held)}` : ""}`)
    const head = job.tasks.find((t) => t.id === task.trial!.of) ?? task
    this.#arm(entry.project, job, head)
    saveJob(entry.project, job)
    const settled = await this.#settleQueued(entry.project, job, head, false)
    // Decided here: finish_task carries the note and the sessions to stop; the outcomes are known now.
    if (settled) this.#onSettled?.({ project: entry.project, job, parent: entry.parent, stop: [], measured: settled.measured })
    if (settled?.winner === task) {
      return { text: `Your attempt won the trial on score and is merged into ${job.integrationBranch}. Now end with your short report.`, note: settled.note, parent: entry.parent, stop: settled.stop }
    }
    const measured = [visible ? `measured: ${visible}` : "", held ? `on the held-out cases, which you cannot see: ${coarse(held)}` : ""].filter(Boolean).join("; ")
    return {
      text: `Your checks pass${measured ? ` (${measured})` : ""}, and your commit waits in your worktree: the attempt with the best score is merged once every attempt of this trial is done. There is nothing more to do; end now with your short report.`,
      ...(settled ? { note: settled.note, parent: entry.parent, stop: settled.stop } : {}),
    }
  }

  // The trial's deadline, armed once per trial from its first held attempt; after a restart from the time it had.
  #arm(project: string, job: Job, head: Task): void {
    head.settleBy ??= new Date(Date.now() + this.#deadlineMs).toISOString()
    const k = `${job.id}/${head.id}`
    if (this.#deadlines.has(k)) return
    const timer = setTimeout(() => {
      this.#deadlines.delete(k)
      this.#settleLater(project, job, head)
    }, Math.max(0, Date.parse(head.settleBy) - Date.now()))
    timer.unref?.()
    this.#deadlines.set(k, timer)
  }

  // A settle nobody's finish_task waits for (the deadline, the last attempt failing or ending): its note goes to the
  // micromanager through onSettled.
  #settleLater(project: string, job: Job, head: Task): void {
    void this.#settleQueued(project, job, head, true).then((r) => {
      if (r) this.#onSettled?.({ project, job, parent: job.facilitator ?? this.#entries.get(`${job.id}/${head.id}`)?.parent ?? "", note: r.note, stop: r.stop, measured: r.measured })
    }).catch(() => undefined)
  }

  // On the job's merge train: one merge at a time, and a trial is decided once.
  #settleQueued(project: string, job: Job, head: Task, force: boolean): Promise<{ winner?: Task; note: string; stop: string[]; measured: Task[] } | undefined> {
    const train = this.#trains.get(job.id) ?? Promise.resolve()
    const step = train.then(() => this.#settle(project, job, head, force))
    this.#trains.set(job.id, step.catch(() => undefined))
    return step
  }

  // Decides a trial by score once no attempt is at work (or force: the deadline, or every other attempt ended): the
  // best held attempt is merged, the others are cancelled. The two best are measured again one after the other, so a
  // machine that was busier during one attempt's measurement does not decide it. One that reached the target wins at
  // once. When the best cannot be merged (a conflict), the next is tried.
  async #settle(project: string, job: Job, head: Task, force: boolean): Promise<{ winner?: Task; note: string; stop: string[]; measured: Task[] } | undefined> {
    const c = job.contracts?.find((x) => x.id === head.contract?.id)
    const now = standing(job, head)
    if (!c || now.winner || !now.held.length) return undefined
    const target = now.held.find((t) => reached(c, t.score))
    if (!force && !target && now.live.length) return undefined
    const corpus = c.corpus.heldOut ? "heldout" : "visible"
    let order = target ? [target, ...ranked(c, now.held).filter((t) => t !== target)] : ranked(c, now.held)
    if (!target && order.length >= 2) {
      for (const t of order.slice(0, 2)) {
        const e = this.#entries.get(`${job.id}/${t.id}`)
        if (!e || e.removed) continue
        const r = await runEvaluator(e.dir, c, corpus, this.#exec, corpus === "heldout" ? heldOutDir(project, job.id, c.id) : undefined)
        this.#count(job, c, r.seconds)
        t.score = { ...r.measured, corpus, at: new Date().toISOString() }
      }
      order = [...ranked(c, order.slice(0, 2)), ...order.slice(2)]
    }
    const k = `${job.id}/${head.id}`
    for (const cand of order) {
      const e = this.#entries.get(`${job.id}/${cand.id}`)
      if (!e || e.removed) continue
      const how = cand.score ? (corpus === "heldout" ? `held-out ${coarse(cand.score)}` : describe(c, cand.score)) : "no score"
      const merged = await this.#merge(e, job, cand)
      if (!merged.ok) {
        stage(cand, "trial", "fail", "had the best score but did not merge")
        continue
      }
      const won = await this.#settleTrial(e, job, cand, how)
      clearTimeout(this.#deadlines.get(k))
      this.#deadlines.delete(k)
      saveJob(project, job)
      return { winner: cand, note: won.note, stop: won.stop, measured: now.held }
    }
    saveJob(project, job)
    return { note: `${HEADER} The trial of ${head.id} is decided by score, but none of its passed attempts (${order.map((t) => t.id).join(", ")}) merged onto ${job.integrationBranch}: each conflicts with what other tasks merged meanwhile. Continue the best one with the subagent tool and its sessionID to resolve the conflict.`, stop: [], measured: now.held }
  }

  // The note when a trial's attempt failed: the trial's state (others still run, or all failed); undefined outside one.
  #trialFailed(job: Job, task: Task, project: string): string | undefined {
    if (!task.trial) return undefined
    const now = standing(job, task)
    if (now.winner) return undefined
    if (now.live.length) return attemptFailedText(task, now.live)
    const head = job.tasks.find((t) => t.id === task.trial!.of) ?? task
    // Others passed and wait for the decision by score: it is due now, and its note says how it came out.
    if (now.held.length) {
      this.#settleLater(project, job, head)
      return undefined
    }
    return allFailedText(job, head, now.failed)
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
      // Other tasks' commits can change what the evaluator measures as much as what the checks see.
      const fitness = await this.#measure(entry, job, task)
      if (fitness.failed) {
        moveTask(task, "escalated")
        stage(task, "merge", "fail", `the fitness contract does not hold on top of the newer commits: ${fitness.failed.output.split("\n")[0]}`)
        return { ok: false, text: failText(`Your change is rebased onto ${job.integrationBranch}, which other tasks moved on meanwhile, and there the fitness contract does not hold`, [fitness.failed], entry.dir) }
      }
      if (fitness.evidence) stage(task, "fitness", "pass", `after the rebase: ${fitness.evidence}`)
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
  // ended gets the worker's task as it ended too, for the outcome log (src/outcomes.ts).
  watchEnd(session: string, wait: () => Promise<unknown>, reason: () => string | undefined, ended: (note: string | undefined, parent: string, w: Worker) => void): void {
    if (this.#waiting.has(session) || !this.#bySession.has(session)) return
    this.#waiting.add(session)
    void wait().catch(() => undefined).then(async () => {
      this.#waiting.delete(session)
      const r = await this.ended(session, reason())
      const entry = this.#entry(session)
      const job = entry && this.#job(entry)
      const task = job?.tasks.find((t) => t.id === entry!.taskId)
      if (r && entry && job && task) ended(r.note, r.parent, { project: entry.project, job, task, writer: entry.writer })
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
    } else if (task.trial && task.status === "cancelled") {
      // Stopped because another attempt won: its work is not needed, and the winner's note said so.
      await this.#dropWorktree(entry, task)
    } else if (task.held && task.status === "passed") {
      // Passed and waiting for its trial to be decided by score: its commit stays in its worktree until then.
    } else {
      const blocked = task.status === "blocked"
      stage(task, "end", "fail", reason ?? "ended without finish_task")
      // In a trial, finish_task reported a blocked attempt already; one that ended unfinished is a failed attempt.
      if (task.trial) note = blocked ? undefined : this.#trialFailed(job, task, entry.project)
      else note = `[micromanager] ${task.id} ${task.title}: its worker ended${reason ? ` (${reason})` : ""} without passing finish_task, so nothing was checked or merged; its change is still in ${entry.dir}. Continue it with the subagent tool and sessionID ${session} to finish, or tell the user.`
    }
    saveJob(entry.project, job)
    return { note, parent: entry.parent }
  }

  // The todo tool: the micromanager writes down the tasks it means to start, as open tasks of its session's job, so the
  // job file holds the whole list (the sidebar shows it; the continuation names the ready ones). v2 has no todowrite,
  // and a list kept in the model's context was lost on compaction. Each is started later with "Task: T… · job-…".
  todo(project: string, parent: string, items: readonly TodoItem[], drop: readonly string[]): { job: Job; added: Task[]; dropped: string[]; errors: string[] } {
    const job = this.job(project, parent)
    const errors: string[] = []
    const added: Task[] = []
    const dropped: string[] = []
    for (const id of drop) {
      const task = job.tasks.find((t) => t.id === id)
      if (!task) errors.push(`${id}: no such task`)
      else if (!["pending", "ready", "planned"].includes(task.status)) errors.push(`${id} is ${task.status}, not an open todo; stop_task stops a running one`)
      else {
        moveTask(task, "cancelled")
        stage(task, "drop", "pass", "dropped from the todo list")
        dropped.push(id)
      }
    }
    for (const item of items) {
      const title = item.title?.trim() ?? ""
      const role = roleByAgent(item.agent ?? "") ?? (item.agent ? undefined : roleByAgent("coder"))
      if (!title) { errors.push("a todo without a title"); continue }
      if (!role) { errors.push(`${title}: ${item.agent} is not a role agent (${ROLES.map((r) => r.agent).join(", ")})`); continue }
      const writer = WRITERS.has(role.id)
      const parsed = parseFiles(item.files ?? "", project)
      if (parsed.problem) { errors.push(`${title}: ${parsed.problem}`); continue }
      if (writer && !parsed.files.length) { errors.push(`${title}: a ${role.agent} changes files; give the files it may change`); continue }
      if (!writer && parsed.files.length) { errors.push(`${title}: ${role.agent} only reads; leave out files`); continue }
      const checks = (item.checks ?? "").split("\n").map((c) => c.trim()).filter(Boolean)
      const bad = checks.length ? checkSetProblems(checks, writer) : undefined
      if (bad) { errors.push(`${title}: ${bad}`); continue }
      const after = (item.after ?? []).map((id) => id.trim().toUpperCase()).filter(Boolean)
      const unknown = after.filter((id) => !job.tasks.some((t) => t.id === id))
      if (unknown.length) { errors.push(`${title}: no task ${unknown.join(", ")} to wait for`); continue }
      const replaces = item.replaces ?? []
      const cannot = this.#replaceable(project, job, replaces)
      if (cannot.length) { errors.push(`${title}: ${cannot.join("; ")}`); continue }
      if (item.contract && !writer) { errors.push(`${title}: ${role.agent} only reads; a fitness contract measures a writer's work`); continue }
      if (item.contract && !job.contracts?.some((c) => c.id === item.contract)) { errors.push(`${title}: job ${job.id} has no contract ${item.contract}; define it with the contract tool first`); continue }
      const result = addDelegated(job, { title, prompt: item.brief?.trim() || title, files: parsed.files, dependsOn: after, checks })
      if (!result.task) { errors.push(`${title}: ${result.errors!.join("; ")}`); continue }
      this.#bind(job, result.task, item.contract)
      const freeze = item.frozen ? parseFiles(item.frozen, project) : undefined
      if (freeze?.problem) errors.push(`${title}: frozen ${freeze.problem}`)
      else if (freeze?.files.length) result.task.freeze = freeze.files
      this.#link(project, job, result.task, replaces)
      result.task.role = role.id
      stage(result.task, "todo", "pass", "written down by the micromanager")
      added.push(result.task)
    }
    if (added.length || dropped.length) saveJob(project, job)
    return { job, added, dropped, errors }
  }

  // The job a worker works for, as this process holds it.
  jobOf(session: string): { project: string; job: Job } | undefined {
    const entry = this.#entry(session)
    const job = entry && this.#job(entry)
    return entry && job ? { project: entry.project, job } : undefined
  }

  // The live worker that works in a directory (a shell command's cwd: its own directory or below), for the sandbox
  // (src/sandbox.ts). The deepest match wins, so a writer's worktree beats the job's integration worktree it lies in.
  workerAt(cwd: string): { project: string; jobId: string; role: RoleId; writer: boolean; dir: string; worktree: string; frozen: string[] } | undefined {
    const inside = (dir: string) => cwd === dir || cwd.startsWith(`${dir}/`)
    const found = [...this.#entries.values()]
      .filter((e) => !e.ended && (inside(e.dir) || inside(e.worktree)))
      .sort((a, b) => b.dir.length - a.dir.length)[0]
    const task = found && this.#job(found)?.tasks.find((t) => t.id === found.taskId)
    return found && task
      ? { project: found.project, jobId: found.jobId, role: task.role as RoleId, writer: found.writer, dir: found.dir, worktree: found.worktree, frozen: found.writer && found.frozen ? [...found.frozen.keys()].map((f) => resolve(found.dir, f)) : [] }
      : undefined
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
      attemptBrief(task),
      "",
      graph ? graphBrief(graph) : "",
      "",
      entry.writer ? `Files you may change: ${task.files.join(", ")}. Work only in your current directory, ${job.isolation === "none" ? "the project folder itself (it has no git, so change nothing beyond your files)" : "a git worktree of its own"}.` : "Change no files.",
      // A worktree is a checkout of the repository root, so a project that is a subdirectory sits below it. Saying so
      // keeps a worker from concluding its premise is false when a path of its own does not resolve at the top.
      entry.rel ? `Your directory ${entry.dir} is the project directory inside the worktree ${entry.worktree}; the worktree holds the whole repository (${entry.rel} below its root). Every path you read or write is relative to your own directory, never to the worktree root.` : "",
      dirtyNote(job, entry.writer),
      entry.writer
        ? entry.checks.length
          ? `Checks the plugin runs when you finish: ${entry.checks.join("; ")}`
          : "No checks were given: test your change yourself as far as you can."
        : "",
      entry.contract && job.contracts?.find((c) => c.id === entry.contract) ? contractBrief(job.contracts.find((c) => c.id === entry.contract)!) : "",
      entry.frozen?.size ? `Frozen, so read and run them but do not change them (the plugin puts them back and counts it as a failing check): ${[...entry.frozen.keys()].join(", ")}.` : "",
      entry.writer ? "If a check or a frozen test is itself wrong (a path that does not exist, a typo, a test that contradicts the task), do not work around it: ask with request_check_change ({ kind: \"check_bug\" | \"test_contradicts_spec\" | \"spec_incomplete\" | \"contract\", target: the check command or file, problem, evidence: the output or spec line that shows it, proposal: the new command or a unified diff }), inside the execute tool. Someone else decides; it waits for the answer. Twice per task at most, and a refused change stays refused." : "",
      others.length ? `Other workers change other files at the same time (not yours): ${others.map((t) => `${t.id} ${t.title}`).join("; ")}` : "",
      "Keys and tokens show as <secret> in what you read; never write <secret> into a file, leave such lines as they are.",
      // The sandbox's limits, and how to ask past them (src/grants.ts).
      entry.writer || role.id === "research"
        ? "Your shell commands run in a sandbox with a cleaned environment that reaches the package registries only. If a command fails because a variable is not set, ask for it with request_env; if it cannot reach a host, with request_network. Never set a missing variable yourself with a value you made up: the real value is the user's, and an invented one only makes a check pass that proves nothing. Both are called inside the execute tool, e.g. `await tools.request_env({ name: \"DATABASE_URL\", why: \"…\" })`, and wait until they are decided."
        : "Your shell commands run in a sandbox with a cleaned environment. If a command fails because a variable is not set, ask for it with request_env (never set it yourself with a value you made up), inside the execute tool: `await tools.request_env({ name: \"…\", why: \"…\" })`; it waits until it is decided.",
      skillLine(skills),
      "",
      entry.writer
        ? "Two helpers answer questions while you wait: explore (an explorer reads your directory, your change included) and research (a researcher looks it up on the web). Ask one when a question would take you many reads or needs documentation you cannot reach; at most 3 per task. Like finish_task, they are called inside the execute tool: `await tools.explore({ question: \"…\" })`."
        : "",
      entry.writer
        ? `When your change is done, call finish_task with a two-line summary, inside the execute tool: \`await tools.finish_task({ summary: "…" })\`. The plugin then runs the checks, commits and merges; if it answers with failures, fix them and call finish_task again. Once it says merged, end with a short report: what you changed, what the checks showed, anything left open. ${FOLLOWUP_LINE}`
        : `End with your findings: they are your result. ${FOLLOWUP_LINE}`,
    ].filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n").trim()
  }
}

// How a worker reports work outside its task, so the plugin can keep it (src/brief.ts parseReport reads these lines).
const FOLLOWUP_LINE = "Name work you noticed outside your task that the project needs, one line each, as FOLLOWUP: what | why | the files it would change (leave it out if none)."

// A planned task on its way to a worker, from wherever it stopped: open, given up, stopped, left running by a process
// that ended, or cancelled by a sweep. Cancelled is final for the state machine, so a task started again on purpose
// goes back to pending first.
function restart(task: Task): void {
  if (task.status === "cancelled") {
    task.status = "pending"
    stage(task, "restart", "pass", "started again by the micromanager")
  }
  if (LIVE.has(task.status)) moveTask(task, "escalated")
  if (task.status === "blocked") moveTask(task, "running")
  if (task.status === "escalated") moveTask(task, "running")
  if (task.status === "pending") moveTask(task, "ready")
  if (task.status === "ready") moveTask(task, "planned")
  if (task.status === "planned") moveTask(task, "running")
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

// What an attempt hears when another attempt of its trial won first.
function lostText(job: Job, task: Task): string {
  return `${task.replacedBy ?? "Another attempt"} of this trial merged into ${job.integrationBranch} first, so your work is not needed and nothing of it is merged. Stop now and end with a one-line report; add a LEARNED line if your attempt found something worth knowing.`
}

// "<job>/<task>" from a brief's header line.
function tokenOf(text: string): string | undefined {
  const m = text.match(/\[micromanager\] task (T\d+) · job (\S+) ·/)
  return m ? `${m[2]}/${m[1]}` : undefined
}

// The directory is in the text: a check that says "No such file or directory" only makes sense next to the cwd it ran
// in, and that was the one diagnostic missing when a worker hunted for a file three directories up.
function failText(what: string, failed: readonly GateResult[], dir: string): string {
  return `${what}. Fix them, then call finish_task again:\n${failed.map((f) => `$ ${f.command} (exit ${f.code})\n${f.output}`).join("\n\n")}\n\nThe checks ran in ${dir}; a path in them is relative to that directory.`
}

// The existing files a shell command names, project-relative: "node --test test/a.test.js" names test/a.test.js. A
// word that is no path, or no file in dir, is left out; a check names a file it reads far more often than one it
// writes, and one it would write does not exist yet.
export function namedFiles(command: string, dir: string): string[] {
  return [...new Set(command.split(/[\s;|&()<>=]+/).map((w) => w.replace(/^['"]+|['"]+$/g, "")))]
    .filter((w) => /^[\w./@+-]+$/.test(w) && /[./]/.test(w) && !w.startsWith("-") && !w.startsWith("/") && !w.split("/").includes(".."))
    .map((w) => w.replace(/^\.\//, ""))
    .filter((w) => {
      try {
        return statSync(join(dir, w)).isFile()
      } catch {
        return false
      }
    })
}
