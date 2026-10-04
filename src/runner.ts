// Phase B's runner: a job from goal to its own branch, one task at a time on pipeline P1 (implement -> gate,
// fix at most twice). The planner and the workers are plugin-started sessions (Phase A, A2); code moves the
// state, runs the checks and commits. The decision model joins in later phases; here the rules decide.

import { buildAgenda, nextProposal } from "./agenda.ts"
import { brief, fixPrompt, lastAssistantText, parseReport, taskAcceptance, usage } from "./brief.ts"
import { changedFiles, commitTask, exec as defaultExec, prepareIntegration, runGate, type Exec } from "./integration.ts"
import { record } from "./journal.ts"
import { HEADER } from "./hooks.ts"
import { applyPlan, parsePlan, PLAN_FORMAT } from "./plan.ts"
import { resolvePolicy, type Policies } from "./policy.ts"
import { route, type Availability, type ModelEntry } from "./registry.ts"
import { roleById } from "./roles.ts"
import { moveJob, moveTask, newJob, promoteReady, stage, type Job, type Task } from "./state.ts"
import { excludeFromGit, jobId, loadJob, saveJob, saveNote } from "./store.ts"

// The part of ctx.session the runner needs (argument shapes as seen in Phase A).
export interface SessionApi {
  create(args: Record<string, unknown>): Promise<{ id: string }>
  prompt(args: { sessionID: string; text: string }): Promise<unknown>
  wait(args: { sessionID: string }): Promise<unknown>
  context(args: { sessionID: string }): Promise<unknown>
  interrupt(args: { sessionID: string }): Promise<unknown>
}

export interface RunnerDeps {
  readonly session: SessionApi
  readonly project: string
  readonly registry: readonly ModelEntry[]
  readonly policies?: Policies
  readonly availability?: () => Promise<Map<string, Availability>>
  readonly exec?: Exec
  readonly journal?: (entry: Record<string, unknown>) => void
  readonly progress?: (text: string) => void
  readonly parentID?: string // the dictator session; workers show up as its children
  readonly onWorker?: (sessionID: string, task: string) => void // what a worker session works on, for permissions
  readonly workerTimeoutMs?: number
  readonly fixRounds?: number
  readonly planRetries?: number
}

export function toModel(id: string): { providerID: string; id: string } {
  const i = id.indexOf("/")
  return { providerID: id.slice(0, i), id: id.slice(i + 1) }
}

export class Runner {
  readonly #d: RunnerDeps
  readonly #exec: Exec
  readonly #journal: (entry: Record<string, unknown>) => void

  constructor(deps: RunnerDeps) {
    this.#d = deps
    this.#exec = deps.exec ?? defaultExec
    this.#journal = deps.journal ?? record
  }

  #say(text: string): void {
    this.#d.progress?.(text)
  }

  // The model for a role: the user's preset if any, else the router over the registry, else the role's cloud model.
  async #model(job: Job, role: string, difficulty: number, task?: string): Promise<{ id: string; reason: string }> {
    const preset = resolvePolicy("N5.model", this.#d.policies ?? {})
    if (preset.policy.kind === "fixed") {
      this.#journal({ kind: "routing", job: job.id, task, role, model: preset.policy.value, reason: `preset (${preset.level})` })
      return { id: preset.policy.value, reason: `preset (${preset.level})` }
    }
    const availability = await this.#d.availability?.().catch(() => undefined)
    const r = route(this.#d.registry, { role, difficulty }, availability)
    const id = r.model ?? roleById(role)?.models[0] ?? this.#d.registry[0]!.id
    this.#journal({ kind: "routing", job: job.id, task, role, model: id, reason: r.model ? r.reason : `fallback: ${r.reason}`, ranked: r.ranked.slice(0, 5) })
    return { id, reason: r.model ? r.reason : "fallback" }
  }

  async #ask(sessionID: string, text: string): Promise<{ text: string; timedOut: boolean }> {
    await this.#d.session.prompt({ sessionID, text })
    const timeoutMs = this.#d.workerTimeoutMs ?? 20 * 60_000
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = await Promise.race([
      this.#d.session.wait({ sessionID }).then(() => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs) }),
    ])
    clearTimeout(timer)
    if (timedOut) await this.#d.session.interrupt({ sessionID }).catch(() => undefined)
    return { text: lastAssistantText(await this.#d.session.context({ sessionID })), timedOut }
  }

  // Goal -> validated plan, waiting at the plan gate for the user's go.
  async plan(goal: string): Promise<{ job: Job; errors?: string[] }> {
    const job = newJob(jobId(), goal)
    excludeFromGit(this.#d.project)
    moveJob(job, "triage")
    moveJob(job, "plan")
    saveJob(this.#d.project, job)
    const model = await this.#model(job, "plan", 0.7)
    this.#say(`planning with ${model.id} (${model.reason})`)
    const s = await this.#d.session.create({
      ...(this.#d.parentID ? { parentID: this.#d.parentID } : {}),
      title: `plan ${job.id}`,
      agent: roleById("plan")!.agent,
      model: toModel(model.id),
      location: { directory: this.#d.project },
    })
    let answer = await this.#ask(s.id, plannerPrompt(job))
    let parsed = parsePlan(answer.text)
    for (let retry = 0; parsed.errors && !answer.timedOut && retry < (this.#d.planRetries ?? 2); retry++) {
      this.#say(`the plan has ${parsed.errors.length} problem(s), asking again`)
      answer = await this.#ask(s.id, `${HEADER} The plan has these problems:\n- ${parsed.errors.join("\n- ")}\n\nAnswer again with the corrected JSON only.`)
      parsed = parsePlan(answer.text)
    }
    if (!parsed.plan) {
      moveJob(job, "failed")
      saveJob(this.#d.project, job)
      return { job, errors: answer.timedOut ? ["the planner timed out"] : parsed.errors }
    }
    applyPlan(job, parsed.plan)
    moveJob(job, "plan_gate")
    saveJob(this.#d.project, job)
    return { job }
  }

  // The user said go: work the plan on the job's branch until it is done or needs the user.
  async run(id: string): Promise<Job> {
    const job = loadJob(this.#d.project, id)
    if (!job) throw new Error(`no job ${id}`)
    if (job.phase === "plan_gate") moveJob(job, "execute")
    else if (job.phase === "ask_user" && job.resumePhase === "execute") moveJob(job, "execute")
    if (job.phase !== "execute") throw new Error(`job ${id} is in phase ${job.phase}, not ready to run`)
    if (!job.integrationWorktree) {
      const integration = await prepareIntegration(this.#d.project, job.id, this.#exec)
      job.integrationBranch = integration.branch
      job.integrationWorktree = integration.worktree
      this.#say(`working on branch ${integration.branch}`)
    }
    saveJob(this.#d.project, job)
    while (job.phase === "execute") {
      if (++job.counters.turns > job.budget.turnsMax) {
        this.#stop(job, `turn budget of ${job.budget.turnsMax} used up`)
        break
      }
      promoteReady(job)
      const next = nextProposal(buildAgenda(job))
      if (!next) break
      if (next.action === "dispatch" && next.taskId) await this.#runTask(job, job.tasks.find((t) => t.id === next.taskId)!)
      else if (next.action === "verify") await this.#verify(job)
      else this.#stop(job, next.label)
      saveJob(this.#d.project, job)
    }
    saveJob(this.#d.project, job)
    return job
  }

  #stop(job: Job, reason: string): void {
    job.lessons.push(reason)
    moveJob(job, "ask_user")
    this.#say(`stopped: ${reason}`)
  }

  async #runTask(job: Job, task: Task): Promise<void> {
    if (job.budget.workersUsed >= job.budget.workersMax) return this.#stop(job, `worker budget of ${job.budget.workersMax} used up`)
    const worktree = job.integrationWorktree!
    moveTask(task, "planned")
    const model = await this.#model(job, task.role, 0.5, task.id)
    task.model = model.id
    moveTask(task, "running")
    job.budget.workersUsed++
    this.#say(`${task.id} ${task.title}: ${task.role} on ${model.id} (${model.reason})`)
    const s = await this.#d.session.create({
      ...(this.#d.parentID ? { parentID: this.#d.parentID } : {}),
      title: `${task.id} ${task.title}`,
      agent: roleById(task.role)?.agent ?? "dictator-code",
      model: toModel(model.id),
      location: { directory: worktree },
    })
    task.session = s.id
    this.#d.onWorker?.(s.id, `${task.id} ${task.title}: ${task.description}`)
    saveJob(this.#d.project, job)
    let answer = await this.#ask(s.id, brief(job, task, model.id, worktree))
    const checks = [...new Set(taskAcceptance(job, task).map((a) => a.verify).filter((v): v is string => Boolean(v)))]
    for (;;) {
      const report = parseReport(answer.text)
      stage(task, "implement", answer.timedOut ? "fail" : "pass", answer.timedOut ? "timed out" : `status ${report.status ?? "missing"}`)
      if (answer.timedOut) return this.#escalate(job, task, "the worker timed out")
      if (report.status === "BLOCKED" || report.status === "NEEDS_CONTEXT") {
        moveTask(task, "blocked")
        task.summary = report.open || report.text.slice(-500)
        return this.#stop(job, `${task.id} needs the user: ${task.summary}`)
      }
      moveTask(task, "gating")
      const results = await runGate(worktree, checks, this.#exec)
      const failed = results.filter((r) => !r.passed)
      const changed = await changedFiles(worktree, this.#exec)
      const outside = task.files.length ? changed.filter((f) => !task.files.includes(f)) : changed
      stage(task, "gate", failed.length ? "fail" : "pass", checks.length ? results.map((r) => `${r.command}: exit ${r.code}`).join("; ") : "no checks defined")
      saveNote(this.#d.project, job.id, task.id, noteText(task, report.text, results, outside))
      if (failed.length === 0) {
        moveTask(task, "passed")
        task.summary = report.text.slice(-500)
        const commit = await commitTask(worktree, `${task.id}: ${task.title}`, `Job: ${job.id}\nWorker: ${model.id} (${task.role})${outside.length ? `\nOutside the declared files: ${outside.join(", ")}` : ""}`, this.#exec)
        moveTask(task, "merged")
        this.#say(`${task.id} passed${commit ? ` (${commit})` : ", nothing to commit"}`)
        return
      }
      task.attempts++
      if (task.attempts > (this.#d.fixRounds ?? 2)) return this.#escalate(job, task, `checks still fail after ${task.attempts - 1} fix round(s): ${failed.map((f) => f.command).join(", ")}`)
      moveTask(task, "fixing")
      this.#say(`${task.id}: ${failed.length} check(s) failed, fix round ${task.attempts}`)
      moveTask(task, "running")
      answer = await this.#ask(s.id, fixPrompt(failed))
    }
  }

  // Phase B's escalation ladder ends at the user; other families and best-of-N come in Phase E.
  #escalate(job: Job, task: Task, reason: string): void {
    moveTask(task, "escalated")
    this.#stop(job, `${task.id}: ${reason}`)
  }

  async #verify(job: Job): Promise<void> {
    moveJob(job, "verify")
    const checks = [...new Set(job.acceptance.map((a) => a.verify).filter((v): v is string => Boolean(v)))]
    const results = await runGate(job.integrationWorktree!, checks, this.#exec)
    const failed = results.filter((r) => !r.passed)
    if (failed.length > 0) {
      moveJob(job, "execute")
      return this.#stop(job, `the final checks fail: ${failed.map((f) => f.command).join(", ")}`)
    }
    moveJob(job, "integrate") // the user merges, keeps or discards the branch
    this.#say(`all checks pass on ${job.integrationBranch}`)
  }

  async sessionUsage(sessionID: string): Promise<{ tokens: number; cost: number }> {
    return usage(await this.#d.session.context({ sessionID }))
  }
}

export function plannerPrompt(job: Job): string {
  return `${HEADER} planning job ${job.id}

The user's job: ${job.goal}

Read as much of the project as you need (read, glob, grep); change nothing.
Verify commands run from the project root in a fresh checkout of the current commit; use only commands that
work there, such as the project's own test script.

${PLAN_FORMAT}`
}

function noteText(task: Task, report: string, results: readonly { command: string; code: number; output: string }[], outside: readonly string[]): string {
  return [
    `# ${task.id} ${task.title}`,
    "",
    "## Report",
    report || "(none)",
    "",
    "## Checks",
    ...(results.length ? results.map((r) => `$ ${r.command} (exit ${r.code})\n${r.output}`) : ["none defined"]),
    ...(outside.length ? ["", `## Changed outside the declared files`, outside.join(", ")] : []),
    "",
  ].join("\n")
}

export function summary(job: Job): string {
  const lines = job.tasks.map((t) => `- ${t.id} ${t.title}: ${t.status}${t.model ? ` (${t.model})` : ""}`)
  const head = `job ${job.id}: ${job.phase}${job.resumePhase ? ` (from ${job.resumePhase})` : ""}`
  const branch = job.integrationBranch
    ? `\nbranch ${job.integrationBranch} in ${job.integrationWorktree}\nmerge: git merge ${job.integrationBranch} · discard: git worktree remove --force ${job.integrationWorktree} && git branch -D ${job.integrationBranch}`
    : ""
  const why = job.phase === "ask_user" && job.lessons.length ? `\nwhy: ${job.lessons[job.lessons.length - 1]}` : ""
  return `${head}\n${lines.join("\n")}${branch}${why}`
}
