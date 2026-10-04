// Phase B's runner: a job from goal to its own branch, one task at a time on pipeline P1 (implement -> gate,
// fix at most twice). The planner and the workers are plugin-started sessions (Phase A, A2); code moves the
// state, runs the checks and commits. The decision model joins in later phases; here the rules decide.

import { readdirSync } from "node:fs"

import { buildAgenda, nextProposal } from "./agenda.ts"
import { Decider, RulesBackend } from "./backends.ts"
import { ANSWER, CHOICE_FLOOR, complexityOf, NOUL_FLOOR, nextQuestionChoice, TRIAGE } from "./catalog.ts"
import { checkGuards, flagsWithoutUser, gateAnswer, gateQuestion, type Unchecked } from "./gate.ts"
import { brief, fixPrompt, lastAssistantText, parseReport, taskAcceptance, usage } from "./brief.ts"
import { changedFiles, commitTask, exec as defaultExec, prepareIntegration, runGate, type Exec } from "./integration.ts"
import { record } from "./journal.ts"
import { HEADER } from "./hooks.ts"
import { applyPlan, parsePlan, PLAN_FORMAT } from "./plan.ts"
import { resolvePolicy, type Policies } from "./policy.ts"
import { route, type Availability, type ModelEntry } from "./registry.ts"
import { roleById } from "./roles.ts"
import {
  addNodes, applyAnswer, applyShortcut, decisionsText, frontier, instruction, matchSessionShortcut, nextStep, parseTree, settle,
  type AnswerReading, type DesignTree, type Step,
} from "./session.ts"
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
  readonly decider?: Decider // the decision model per node; without one, the rules decide
  readonly unchecked?: Unchecked // what G0 does when nothing local could check a job
}

// What a step of the dictator's tools ends with: text for the dictator to act on.
export interface Outcome {
  readonly kind: "gate" | "session" | "plan" | "failed" | "info"
  readonly job: Job
  readonly text: string
}

export function toModel(id: string): { providerID: string; id: string } {
  const i = id.indexOf("/")
  return { providerID: id.slice(0, i), id: id.slice(i + 1) }
}

export class Runner {
  readonly #d: RunnerDeps
  readonly #exec: Exec
  readonly #journal: (entry: Record<string, unknown>) => void

  readonly #decider: Decider

  constructor(deps: RunnerDeps) {
    this.#d = deps
    this.#exec = deps.exec ?? defaultExec
    this.#journal = deps.journal ?? record
    this.#decider = deps.decider ?? new Decider({ default: "rules", nodes: {}, urls: {} }, { rules: new RulesBackend() }, this.#journal)
  }

  #policies(job: Job, task?: string): Policies {
    return { ...(this.#d.policies ?? {}), job: job.pins, ...(task && job.taskPins?.[task] ? { task: job.taskPins[task] } : {}) }
  }

  #say(text: string): void {
    this.#d.progress?.(text)
  }

  // The model for a role: the user's preset if any, else the router over the registry, else the role's cloud model.
  async #model(job: Job, role: string, difficulty: number, task?: string): Promise<{ id: string; reason: string }> {
    const preset = resolvePolicy("N5.model", this.#policies(job, task))
    const presetModel = preset.policy.kind === "fixed" ? this.#d.registry.find((m) => m.id === (preset.policy as { value: string }).value) : undefined
    const presetBreaksGate = job.flags?.localOnly && (presetModel?.location === "cloud" || (job.flags.uncensored && presetModel?.censored))
    if (preset.policy.kind === "fixed" && !presetBreaksGate) {
      this.#journal({ kind: "routing", job: job.id, task, role, model: preset.policy.value, reason: `preset (${preset.level})` })
      return { id: preset.policy.value, reason: `preset (${preset.level})` }
    }
    if (presetBreaksGate) this.#say(`preset ${(preset.policy as { value: string }).value} ignored: the job must stay local${job.flags?.uncensored ? " and uncensored" : ""}`)
    const availability = await this.#d.availability?.().catch(() => undefined)
    const r = route(this.#d.registry, { role, difficulty, sensitive: job.flags?.localOnly, refusalLikely: job.flags?.uncensored }, availability)
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
    return this.planJob(job)
  }

  // A job from triage or a confirmed checkpoint to a validated plan at the plan gate.
  async planJob(job: Job): Promise<{ job: Job; errors?: string[] }> {
    if (job.phase !== "plan") moveJob(job, "plan")
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
      job.lessons.push(`planning failed: ${answer.timedOut ? "the planner timed out" : (parsed.errors ?? []).join("; ")}`)
      moveJob(job, "failed")
      saveJob(this.#d.project, job)
      return { job, errors: answer.timedOut ? ["the planner timed out"] : parsed.errors }
    }
    applyPlan(job, parsed.plan)
    moveJob(job, "plan_gate")
    saveJob(this.#d.project, job)
    return { job }
  }

  // A new job from the dictator: the local gate, triage, then a planning session or the planner (design.md §6).
  async start(goal: string, facilitator?: string): Promise<Outcome> {
    const job = newJob(jobId(), goal)
    job.facilitator = facilitator
    excludeFromGit(this.#d.project)
    moveJob(job, "triage")
    const gate = await checkGuards(this.#decider, goal, job.id)
    const flags = flagsWithoutUser(gate, this.#d.unchecked ?? "local")
    if (flags === "ask_user") {
      job.flags = { gate }
      moveJob(job, "ask_user")
      saveJob(this.#d.project, job)
      return { kind: "gate", job, text: `job ${job.id}\n${gateQuestion(gate)}` }
    }
    job.flags = flags
    return this.#triage(job)
  }

  // dictator_plan with a job id: go on from wherever the job stands.
  async continueJob(id: string): Promise<Outcome> {
    const job = loadJob(this.#d.project, id)
    if (!job) return { kind: "failed", job: newJob(id, ""), text: `no job ${id}` }
    if (job.phase === "triage") return this.#triage(job)
    if (job.phase === "plan") return this.#planned(await this.planJob(job))
    if (job.phase === "planning_session" && job.designTree) {
      const node = job.designTree.nodes.find((n) => n.id === job.designTree!.current)
      return { kind: "session", job, text: node ? instruction({ kind: "ask", node, reason: "continued" }, job.id, job.designTree) : draftInstruction(job) }
    }
    if (job.phase === "planning_session") return { kind: "session", job, text: draftInstruction(job) }
    if (job.phase === "paused" && job.resumePhase === "planning_session") {
      moveJob(job, "planning_session")
      saveJob(this.#d.project, job)
      return this.continueJob(id)
    }
    return { kind: "info", job, text: `job ${job.id} is in phase ${job.phase}` }
  }

  #planned(r: { job: Job; errors?: string[] }): Outcome {
    return r.errors
      ? { kind: "failed", job: r.job, text: `The planner could not produce a valid plan (job ${r.job.id}):\n- ${r.errors.join("\n- ")}` }
      : { kind: "plan", job: r.job, text: "" }
  }

  // N1: how complex, and does it need the user's decisions first? A pin ("no planning session") skips the session.
  async #triage(job: Job): Promise<Outcome> {
    const pin = resolvePolicy("N2.clarity", this.#policies(job)).policy
    const asked = await this.#decider.ask("N1", { goal: job.goal, files: topLevel(this.#d.project) }, TRIAGE, { localOnly: job.flags?.localOnly, job: job.id })
    const c = asked.decision.answers.complexity
    const n = asked.decision.answers.needs_clarification
    const complexity = c?.type === "score" ? complexityOf(c.score) : undefined
    const clarification = n?.type === "noul" ? n.noul : undefined
    let session: boolean
    let reason: string
    if (pin.kind === "fixed") [session, reason] = [pin.value !== "clear", `preset ${pin.value}`]
    else if (pin.kind === "ask") [session, reason] = [true, "the user wants to be asked"]
    else if (clarification === undefined) [session, reason] = [true, "no decision model answer: open questions count as open"]
    else if (clarification >= NOUL_FLOOR) [session, reason] = [true, `open decisions (${clarification.toFixed(2)})`]
    else [session, reason] = [false, `clear enough (${clarification.toFixed(2)})`]
    job.triage = { complexity, clarification, session, reason }
    if (!session) return this.#planned(await this.planJob(job))
    moveJob(job, "clarity")
    moveJob(job, "planning_session")
    saveJob(this.#d.project, job)
    return { kind: "session", job, text: draftInstruction(job) }
  }

  // The facilitator's draft of the design tree, or new branches for an existing one.
  async questions(id: string, json: string): Promise<string> {
    const job = loadJob(this.#d.project, id)
    if (!job || (job.phase !== "planning_session" && job.phase !== "design_checkpoint")) return `no planning session for job ${id}`
    let raw: unknown
    try {
      raw = JSON.parse(json)
    } catch (err) {
      return `invalid JSON: ${err instanceof Error ? err.message : String(err)}. Send the list of questions again.`
    }
    if (!job.designTree) {
      const parsed = parseTree(raw)
      if (parsed.errors) return `The questions have problems:\n- ${parsed.errors.join("\n- ")}\nSend them again.`
      job.designTree = parsed.tree
    } else {
      const errors = addNodes(job.designTree, raw)
      if (errors.length) return `The new questions have problems:\n- ${errors.join("\n- ")}\nSend them again.`
    }
    if (job.phase === "design_checkpoint") moveJob(job, "planning_session")
    await this.#settledByJob(job)
    return this.#advance(job, nextStep(job.designTree, await this.#pick(job)))
  }

  // N2: questions the job text already answers are settled without asking (one request, one noul per question).
  async #settledByJob(job: Job): Promise<void> {
    const tree = job.designTree!
    const open = tree.nodes.filter((n) => n.status === "open" && n.kind === "decision")
    if (open.length === 0) return
    const questions = Object.fromEntries(open.map((n) => [`settled_${n.id}`, {
      type: "noul" as const,
      instructions: `The question "${n.question}" is already answered by the job text, so the user does not need to be asked.`,
    }]))
    const asked = await this.#decider.ask("N2", { goal: job.goal }, questions, { localOnly: job.flags?.localOnly, job: job.id })
    for (const n of open) {
      const a = asked.decision.answers[`settled_${n.id}`]
      if (a?.type === "noul" && a.noul >= 0.8) settle(tree, n.id, "answered by the job text", "fact")
    }
  }

  // N2b: which frontier question next; below the floor the rules pick.
  async #pick(job: Job): Promise<string | undefined> {
    const options = frontier(job.designTree!)
    if (options.length < 2) return undefined
    const asked = await this.#decider.ask("N2b", { goal: job.goal, decided: decisionsText(job.designTree!) },
      { next: nextQuestionChoice(Object.fromEntries(options.map((n) => [n.id, n.question]))) }, { localOnly: job.flags?.localOnly, job: job.id })
    const a = asked.decision.answers.next
    return a?.type === "choice" && a.confidence >= CHOICE_FLOOR ? a.choice : undefined
  }

  #advance(job: Job, step: Step): string {
    if (step.kind === "checkpoint" && job.phase === "planning_session") moveJob(job, "design_checkpoint")
    if (step.kind === "stopped") moveJob(job, "paused")
    saveJob(this.#d.project, job)
    return instruction(step, job.id, job.designTree!)
  }

  // One user turn in the dictator session: the gate answer, a planning-session answer, or the checkpoint reply.
  // Returns the instruction for the dictator's next turn, or undefined when the turn is not about this job.
  async answer(id: string, text: string): Promise<string | undefined> {
    const job = loadJob(this.#d.project, id)
    if (!job) return undefined
    if (job.phase === "ask_user" && job.resumePhase === "triage" && job.flags?.gate) {
      const reply = gateAnswer(text)
      if (reply === undefined) return `[job ${id}] Waiting for the user's answer to the local check: "always local", "use uncensored", "continue" or "stop".`
      if (reply === "stop") {
        moveJob(job, "stopped")
        saveJob(this.#d.project, job)
        return `[job ${id}] The user stopped the job. Confirm briefly.`
      }
      job.flags = { ...job.flags, ...reply }
      moveJob(job, "triage")
      saveJob(this.#d.project, job)
      return `[job ${id}] The user answered the local check${reply.uncensored ? ": local uncensored models only" : reply.localOnly ? ": everything stays local" : ""}. Call dictator_plan with goal "${id}" to continue.`
    }
    const tree = job.designTree
    if (job.phase === "design_checkpoint" && tree) {
      const s = matchSessionShortcut(text)
      if (s?.kind === "confirm") {
        job.decisions = tree.nodes.filter((n) => n.status === "settled").map((n) => ({ id: n.id, text: `${n.question} -> ${n.answer}`, origin: n.origin === "fact" ? "fact" : "user" }))
        moveJob(job, "plan")
        saveJob(this.#d.project, job)
        return `[job ${id}] The user confirmed the design. Call dictator_plan with goal "${id}" to plan it now.`
      }
      moveJob(job, "planning_session")
      saveJob(this.#d.project, job)
      return `[planning session ${id}] The user wants to change something ("${text.slice(0, 200)}"). Ask which decision they mean, one question, no suggestions. Reopen it with their words in mind; "back to <id>" reopens a question.`
    }
    if (job.phase !== "planning_session" || !tree) return undefined
    const shortcut = matchSessionShortcut(text)
    if (shortcut) {
      const step = applyShortcut(tree, shortcut)
      return this.#advance(job, step ?? nextStep(tree, await this.#pick(job)))
    }
    const reading = await this.#read(job, tree, text)
    const step = applyAnswer(tree, text, reading)
    return this.#advance(job, step ?? nextStep(tree, await this.#pick(job)))
  }

  // N2c: what the answer does; without the decision model an answer counts as settling the question.
  async #read(job: Job, tree: DesignTree, text: string): Promise<AnswerReading> {
    const node = tree.nodes.find((n) => n.id === tree.current)
    const asked = await this.#decider.ask("N2c", { question: node?.question, answer: text, decided: decisionsText(tree) }, ANSWER, { localOnly: job.flags?.localOnly, job: job.id })
    const yes = (q: string) => {
      const a = asked.decision.answers[q]
      return a?.type === "noul" ? a.noul >= NOUL_FLOOR : undefined
    }
    if (Object.keys(asked.decision.answers).length === 0) return { settles: true }
    return { settles: yes("settles_decision"), newBranches: yes("opens_new_branches"), stuck: yes("user_stuck"), asksOptions: yes("user_asks_for_options"), contradicts: yes("contradicts_earlier_decision"), outOfScope: yes("out_of_scope") }
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
  const decided = job.designTree ? decisionsText(job.designTree) : job.decisions.map((d) => d.text)
  return `${HEADER} planning job ${job.id}

The user's job: ${job.goal}
${decided.length ? `\nDecided with the user (follow these; for assumed points, decide and say what you chose):\n- ${decided.join("\n- ")}\n` : ""}
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

// The instruction to draft the design tree; the format is the one parseTree reads.
export function draftInstruction(job: Job): string {
  return `[planning session ${job.id}] Before planning, the user's open decisions are settled in a planning session.
Draft the design questions this job leaves open and send them with dictator_questions (job "${job.id}", tree as a
JSON list): [{ "id": "D1", "question": "...", "kind": "decision" | "fact" | "assumption", "dependsOn": [], "impact":
"low" | "medium" | "high" }]. Decisions are what only the user can decide (behaviour, scope, interfaces, trade-offs);
facts are what agents can look up; at most 25. Write every question open: never list possible answers or examples
of answers in it. Do not ask the user anything in this turn, and do not call dictator_plan again.`
}

// The project's top-level entries, as cheap context for triage.
function topLevel(project: string): string[] {
  try {
    return readdirSync(project).filter((f) => !f.startsWith(".")).slice(0, 40)
  } catch {
    return []
  }
}

// A goal the same session failed to plan a short while ago: the dictator reports that instead of starting the
// same job again (live test: a looping local planner made it restart three times). "retry: <goal>" overrides.
export function recentFailure(job: Job | undefined, goal: string, now = Date.now(), windowMs = 30 * 60_000): string | undefined {
  if (!job || job.phase !== "failed" || /^retry:/i.test(goal.trim())) return undefined
  const same = job.goal.trim().toLowerCase() === goal.trim().toLowerCase()
  if (!same || now - Date.parse(job.updated) > windowMs) return undefined
  const why = job.lessons.at(-1) ?? "unknown reason"
  return `Job ${job.id} with this goal failed ${Math.round((now - Date.parse(job.updated)) / 60_000)} min ago (${why}). Tell the user and do not start it again by yourself; if the user wants another try, call dictator_plan with goal "retry: <goal>".`
}
