// Phase B's runner: a job from goal to its own branch, one task at a time on pipeline P1 (implement -> gate,
// fix at most twice). The planner and the workers are plugin-started sessions (Phase A, A2); code moves the
// state, runs the checks and commits. The decision model joins in later phases; here the rules decide.

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { buildAgenda, nextProposal } from "./agenda.ts"
import { Decider, RulesBackend } from "./backends.ts"
import { ANSWER, CHOICE_FLOOR, complexityOf, NOUL_FLOOR, nextQuestionChoice, splitQuestions, TRIAGE } from "./catalog.ts"
import { checkGuards, flagsWithoutUser, gateAnswer, gateQuestion, type Unchecked } from "./gate.ts"
import { brief, fixPrompt, lastAssistantText, parseReport, skillLine, taskAcceptance, usage } from "./brief.ts"
import { changedFiles, commitTask, exec as defaultExec, hashFiles, prepareIntegration, revertFiles, runGate, workingDiff, type Exec, type GateResult } from "./integration.ts"
import { record } from "./journal.ts"
import { HEADER } from "./hooks.ts"
import {
  choosePipeline, citationCheck, greenNote, readerCount, readerPrompt, redPrompt, researchPath, reviewFixPrompt, reviewPrompt, parseReview,
  synthesisPrompt, TEST_FILE, type Review,
} from "./pipelines.ts"
import { applyPlan, applySplits, MAX_SPLIT_LEVEL, parsePlan, PLAN_FORMAT, splitFormat, type Parsed, type Plan, type PlannedTask } from "./plan.ts"
import { classifyQuestions, classifyState, combine, narrowing, profileText, type Profile, type Skill } from "./profile.ts"
import { resolvePolicy, type Policies } from "./policy.ts"
import { route, type Availability, type ModelEntry } from "./registry.ts"
import { family, roleById, type Rule } from "./roles.ts"
import {
  addNodes, applyAnswer, applyShortcut, decisionsText, frontier, instruction, matchSessionShortcut, nextStep, parseTree, settle,
  type AnswerReading, type DesignTree, type Step,
} from "./session.ts"
import { moveJob, moveTask, newJob, promoteReady, stage, type Job, type Task } from "./state.ts"
import { skillsFor, type Stage } from "./skills.ts"
import { excludeFromGit, jobId, loadJob, saveJob, saveNote } from "./store.ts"
import { handoffNote, TIER_STEPS, type Signal } from "./watchdog.ts"

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
  readonly onWorker?: (sessionID: string, task: string, rules: readonly Rule[]) => void // a worker's task and narrowed rights, for permissions
  readonly workerTimeoutMs?: number
  readonly fixRounds?: number
  readonly planRetries?: number
  readonly decider?: Decider // the decision model per node; without one, the rules decide
  readonly watch?: (sessionID: string, maxSteps: number) => void // the loop watchdog starts judging a session
  readonly stopped?: (sessionID: string) => Signal | undefined // why the watchdog stopped a session, if it did
  readonly unchecked?: Unchecked // what G0 does when nothing local could check a job
  readonly skills?: readonly Skill[] // the skills the decision model may pick per task (design.md §13.1)
  readonly installedSkills?: ReadonlySet<string> // the skills a brief may name: linked into OpenCode by install.sh
}

// A worker session in progress: its model, its last answer, and whether it is already the fresh retry.
interface Work {
  s: { id: string }
  model: { id: string; reason: string }
  answer: { text: string; timedOut: boolean; stopped?: Signal }
  fresh: boolean
}

const REVIEW_ROUNDS = 3

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

  // A model's family as the registry knows it ("qwen" for qwen3.8-flash and qwen3.8-u alike), so "another family"
  // means what routing compares.
  #family(id: string): string {
    return this.#d.registry.find((m) => m.id === id)?.family ?? family(id)
  }

  #say(text: string): void {
    this.#d.progress?.(text)
  }

  // The model for a role: the user's preset if any, else the router over the registry, else the role's cloud model.
  async #model(job: Job, role: string, difficulty: number, task?: string, avoidFamilies?: string[], vision = false): Promise<{ id: string; reason: string }> {
    const preset = resolvePolicy("N5.model", this.#policies(job, task))
    const presetModel = preset.policy.kind === "fixed" ? this.#d.registry.find((m) => m.id === (preset.policy as { value: string }).value) : undefined
    const presetBreaksGate = job.flags?.localOnly && (presetModel?.location === "cloud" || (job.flags.uncensored && presetModel?.censored))
    if (preset.policy.kind === "fixed" && !presetBreaksGate) {
      this.#journal({ kind: "routing", job: job.id, task, role, model: preset.policy.value, reason: `preset (${preset.level})` })
      return { id: preset.policy.value, reason: `preset (${preset.level})` }
    }
    if (presetBreaksGate) this.#say(`preset ${(preset.policy as { value: string }).value} ignored: the job must stay local${job.flags?.uncensored ? " and uncensored" : ""}`)
    const availability = await this.#d.availability?.().catch(() => undefined)
    const r = route(this.#d.registry, { role, difficulty, vision, sensitive: job.flags?.localOnly, refusalLikely: job.flags?.uncensored, avoidFamilies }, availability)
    const id = r.model ?? roleById(role)?.models[0] ?? this.#d.registry[0]!.id
    this.#journal({ kind: "routing", job: job.id, task, role, model: id, reason: r.model ? r.reason : `fallback: ${r.reason}`, ranked: r.ranked.slice(0, 5) })
    return { id, reason: r.model ? r.reason : "fallback" }
  }

  async #ask(sessionID: string, text: string): Promise<{ text: string; timedOut: boolean; stopped?: Signal }> {
    await this.#d.session.prompt({ sessionID, text })
    const timeoutMs = this.#d.workerTimeoutMs ?? 20 * 60_000
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut: boolean
    try {
      timedOut = await Promise.race([
        this.#d.session.wait({ sessionID }).then(() => false),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs) }),
      ])
    } finally {
      clearTimeout(timer) // also when wait() fails, or the timer keeps the process alive for the whole timeout
    }
    if (timedOut) await this.#d.session.interrupt({ sessionID }).catch(() => undefined)
    return { text: lastAssistantText(await this.#d.session.context({ sessionID })), timedOut, stopped: this.#d.stopped?.(sessionID) }
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
    let s = await this.#plannerSession(job, model.id)
    let answer = await this.#ask(s.id, plannerPrompt(job))
    if (answer.stopped) {
      // never resume a stopped session: one fresh planner with a handoff note
      this.#say(`the planner was stopped by the loop watchdog (${answer.stopped.detail}); one fresh try`)
      s = await this.#plannerSession(job, model.id)
      answer = await this.#ask(s.id, `${plannerPrompt(job)}\n\n${handoffNote(answer.stopped, [])}`)
    }
    let parsed: Parsed = answer.stopped ? { errors: [`the planner was stopped by the loop watchdog: ${answer.stopped.detail}`] } : parsePlan(answer.text)
    for (let retry = 0; parsed.errors && !answer.timedOut && !answer.stopped && retry < (this.#d.planRetries ?? 2); retry++) {
      this.#say(`the plan has ${parsed.errors.length} problem(s), asking again`)
      answer = await this.#ask(s.id, `${HEADER} The plan has these problems:\n- ${parsed.errors.join("\n- ")}\n\nAnswer again with the corrected JSON only.`)
      parsed = answer.stopped ? { errors: [`the planner was stopped by the loop watchdog: ${answer.stopped.detail}`] } : parsePlan(answer.text)
    }
    if (!parsed.plan) {
      job.lessons.push(`planning failed: ${answer.timedOut ? "the planner timed out" : (parsed.errors ?? []).join("; ")}`)
      moveJob(job, "failed")
      saveJob(this.#d.project, job)
      return { job, errors: answer.timedOut ? ["the planner timed out"] : parsed.errors }
    }
    let plan = parsed.plan
    let candidates: readonly PlannedTask[] = plan.tasks
    for (let level = 1; level <= MAX_SPLIT_LEVEL && candidates.length > 0 && !answer.stopped; level++) {
      const before = new Set(plan.tasks.map((t) => t.id))
      plan = await this.#split(job, s.id, plan, candidates)
      candidates = plan.tasks.filter((t) => !before.has(t.id))
    }
    applyPlan(job, plan)
    moveJob(job, "plan_gate")
    saveJob(this.#d.project, job)
    return { job }
  }

  // N4: tasks that are too big for one fresh session and can be split go back to the planner, which writes the parts;
  // code re-validates. Without a decision model, more than 3 files means too big. A split that stays invalid keeps
  // the task whole.
  async #split(job: Job, plannerSession: string, plan: Plan, candidates: readonly PlannedTask[]): Promise<Plan> {
    const policy = resolvePolicy("N4", this.#policies(job)).policy
    if (policy.kind === "fixed") return plan // "N4": "fixed:no" keeps the planner's tasks
    const asked = policy.kind === "rule" ? undefined : await this.#decider.ask("N4", { goal: job.goal }, splitQuestions(candidates), { localOnly: job.flags?.localOnly, job: job.id })
    const a = asked?.decision.answers ?? {}
    const p = (q: string) => (a[q]?.type === "noul" ? (a[q] as { noul: number }).noul : undefined)
    const ids = candidates.filter((t) => {
      const big = p(`too_big.${t.id}`)
      const hard = p(`hard.${t.id}`)
      const splittable = p(`splittable.${t.id}`)
      if (big === undefined && hard === undefined) return t.files.length > 3
      return Math.max(big ?? 0, hard ?? 0) >= NOUL_FLOOR && (splittable ?? 0) >= NOUL_FLOOR
    }).map((t) => t.id)
    if (ids.length === 0) return plan
    this.#say(`splitting ${ids.join(", ")}`)
    let answer = await this.#ask(plannerSession, `${HEADER} ${splitFormat(ids)}`)
    let r = answer.stopped || answer.timedOut ? { errors: ["the planner stopped"] } as Parsed : applySplits(plan, answer.text, ids)
    if (r.errors && !answer.stopped && !answer.timedOut) {
      answer = await this.#ask(plannerSession, `${HEADER} The split has these problems:\n- ${r.errors.join("\n- ")}\n\nAnswer again with the corrected JSON only.`)
      r = answer.stopped || answer.timedOut ? { errors: ["the planner stopped"] } : applySplits(plan, answer.text, ids)
    }
    if (r.errors) {
      job.lessons.push(`split of ${ids.join(", ")} kept whole: ${r.errors.slice(0, 3).join("; ")}`)
      this.#say(`the split of ${ids.join(", ")} stays invalid; the tasks stay whole`)
      return plan
    }
    return r.plan
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
      return { kind: "gate", job, text: `[job ${job.id}] Only the user can answer the local check, so ask them now: show the question below word for word, call no tool, and end your turn. Their reply reaches the plugin by itself.\n\n${gateQuestion(gate)}` }
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
    else if (job.phase === "ask_user" && job.resumePhase === "execute") {
      // Running the job again after "confirm Tn before it runs" is the user's go for those tasks.
      for (const t of job.tasks) if (t.confirmed === false) t.confirmed = true
      moveJob(job, "execute")
    }
    if (job.phase !== "execute") throw new Error(`job ${id} is in phase ${job.phase}, not ready to run`)
    if (!job.integrationWorktree) {
      const integration = await prepareIntegration(this.#d.project, job.id, this.#exec)
      job.integrationBranch = integration.branch
      job.integrationWorktree = integration.worktree
      this.#say(`working on branch ${integration.branch}`)
    } else await this.#reconcile(job)
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

  // A run that ended in the middle of a task (the server stopped, a crash) leaves it running with half a change in
  // the worktree. Nothing of this process works on it, so it goes back to pending and the worktree back to the last
  // commit; the passed tasks are commits and stay.
  async #reconcile(job: Job): Promise<void> {
    const PATH: Partial<Record<Task["status"], Task["status"][]>> = {
      planned: ["running", "escalated", "pending"],
      running: ["escalated", "pending"],
      gating: ["escalated", "pending"],
      reviewing: ["fixing", "escalated", "pending"],
      fixing: ["escalated", "pending"],
    }
    const cut = job.tasks.filter((t) => PATH[t.status])
    if (cut.length === 0) return
    for (const t of cut) {
      for (const to of PATH[t.status]!) moveTask(t, to)
      stage(t, "reconcile", "skip", "the run ended in the middle of this task; it starts again")
    }
    const dirty = await changedFiles(job.integrationWorktree!, this.#exec)
    await revertFiles(job.integrationWorktree!, dirty, this.#exec)
    job.lessons.push(`interrupted run: ${cut.map((t) => t.id).join(", ")} started again${dirty.length ? `, unfinished changes undone (${dirty.join(", ")})` : ""}`)
    this.#say(`resuming: ${cut.map((t) => t.id).join(", ")} start again`)
  }

  #stop(job: Job, reason: string): void {
    job.lessons.push(reason)
    moveJob(job, "ask_user")
    this.#say(`stopped: ${reason}`)
  }

  async #runTask(job: Job, task: Task): Promise<void> {
    if (job.budget.workersUsed >= job.budget.workersMax) return this.#stop(job, `worker budget of ${job.budget.workersMax} used up`)
    const worktree = job.integrationWorktree!
    const profile = task.profile ?? (await this.#classify(job, task))
    if (profile.injection) {
      moveTask(task, "blocked")
      task.summary = "the task text looks like an attempt to make the agent ignore its rules"
      return this.#stop(job, `${task.id}: ${task.summary}; check the plan before going on`)
    }
    const pipeline = choosePipeline(task, profile, this.#policies(job, task.id))
    task.pipeline = pipeline.id
    const askFirst = pipeline.modifiers.includes("user_confirm") || resolvePolicy("N5", this.#policies(job, task.id)).policy.kind === "ask"
    if (askFirst && task.confirmed !== true) {
      task.confirmed = false
      return this.#stop(job, `confirm ${task.id} before it runs: ${profileText(profile)} · pipeline ${pipeline.id} (${pipeline.reason}). Run the job again to go on, or pin a change first ("${task.id} use <model>", "pipeline P2").`)
    }
    moveTask(task, "planned")
    let model = await this.#model(job, task.role, profile.difficulty, task.id, undefined, profile.vision)
    task.model = model.id
    moveTask(task, "running")
    job.budget.workersUsed++
    this.#say(`${task.id} ${task.title}: ${task.role} on ${model.id} (${model.reason}), ${pipeline.id} (${pipeline.reason})`)
    if (pipeline.id === "P9") return this.#research(job, task, model.id)
    const checks = [...new Set(taskAcceptance(job, task).map((a) => a.verify).filter((v): v is string => Boolean(v)))]
    let frozen = new Map<string, string>()
    if (pipeline.id === "P3") {
      const red = await this.#red(job, task, checks)
      if (!red) return
      frozen = red
    }
    const s = await this.#workerSession(job, task, model.id)
    const first = [brief(job, task, model.id, worktree, this.#skills("implement", task)), frozen.size ? greenNote([...frozen.keys()]) : ""].filter(Boolean).join("\n\n")
    let work: Work | undefined = { s, model, answer: await this.#ask(s.id, first), fresh: false }
    work = await this.#untilGreen(job, task, work, checks, frozen)
    if (!work) return
    const review = (pipeline.id === "P2" || pipeline.id === "P3") && resolvePolicy("N6.review", this.#policies(job, task.id)).policy.kind !== "fixed"
    for (let round = 1; review; round++) {
      moveTask(task, "reviewing")
      const r = await this.#review(job, task, work.model.id)
      stage(task, "review", r.blocking.length ? "fail" : "pass", r.error ?? (r.blocking.length ? r.blocking.map((c) => `${c.point}: ${c.evidence}`).join("; ").slice(0, 500) : `verdict ${r.verdict ?? "none"}, nothing blocking`))
      if (r.blocking.length === 0) break
      if (round >= REVIEW_ROUNDS) return this.#escalate(job, task, `the review still finds unmet points after ${REVIEW_ROUNDS} rounds: ${r.blocking.map((c) => c.point).join(", ")}`)
      moveTask(task, "fixing")
      moveTask(task, "running")
      this.#say(`${task.id}: the review found ${r.blocking.length} unmet point(s), round ${round + 1}`)
      work.answer = await this.#ask(work.s.id, [reviewFixPrompt(r), skillLine(this.#skills("review_fix", task))].filter(Boolean).join("\n\n"))
      work = await this.#untilGreen(job, task, work, checks, frozen)
      if (!work) return
    }
    moveTask(task, "passed")
    task.summary = work.answer.text.slice(-500)
    const outside = (await changedFiles(worktree, this.#exec)).filter((f) => task.files.length > 0 && !task.files.includes(f) && !frozen.has(f))
    const commit = await commitTask(worktree, `${task.id}: ${task.title}`, `Job: ${job.id}\nWorker: ${work.model.id} (${task.role}), pipeline ${pipeline.id}${outside.length ? `\nOutside the declared files: ${outside.join(", ")}` : ""}`, this.#exec)
    moveTask(task, "merged")
    this.#say(`${task.id} passed${commit ? ` (${commit})` : ", nothing to commit"}`)
  }

  // N5 + N5b: one request classifies the task and sets its profile; the role may change to one that can do it.
  async #classify(job: Job, task: Task): Promise<Profile> {
    const policies = this.#policies(job, task.id)
    const acceptance = taskAcceptance(job, task)
    const skip = resolvePolicy("N5", policies).policy.kind === "rule"
    const asked = skip ? undefined : await this.#decider.ask("N5", classifyState(job.goal, task, acceptance), classifyQuestions(task, this.#d.skills ?? []), { localOnly: job.flags?.localOnly, job: job.id, task: task.id })
    const profile = combine(task, acceptance, asked, policies, this.#d.skills ?? [])
    if (profile.role !== task.role) this.#say(`${task.id}: role ${task.role} -> ${profile.role} (${profile.roleReason})`)
    task.role = profile.role
    task.profile = profile
    stage(task, "classify", "pass", profileText(profile))
    saveJob(this.#d.project, job)
    return profile
  }

  // Worker turns until the task's checks pass: the watchdog's stops, the report, the gate, at most fixRounds fixes.
  // Returns undefined when the task went to the user (escalated or blocked); the status is then "gating", passed.
  async #untilGreen(job: Job, task: Task, work: Work, checks: readonly string[], frozen: ReadonlyMap<string, string>): Promise<Work | undefined> {
    const worktree = job.integrationWorktree!
    for (;;) {
      const answer = work.answer
      if (answer.stopped) {
        // The watchdog stopped it: never resume that session. One fresh session, on another model family when no
        // preset pins the model, told what was already done; a second stop goes to the user.
        stage(task, "implement", "fail", `loop watchdog: ${answer.stopped.detail}`)
        if (work.fresh) {
          this.#escalate(job, task, `stopped twice by the loop watchdog: ${answer.stopped.detail}`)
          return undefined
        }
        const model = await this.#model(job, task.role, task.profile?.difficulty ?? 0.5, task.id, [this.#family(work.model.id)], task.profile?.vision)
        task.model = model.id
        this.#say(`${task.id}: stopped by the loop watchdog (${answer.stopped.detail}), fresh session on ${model.id}`)
        const s = await this.#workerSession(job, task, model.id)
        const text = `${brief(job, task, model.id, worktree, this.#skills("implement", task))}\n\n${frozen.size ? `${greenNote([...frozen.keys()])}\n\n` : ""}${handoffNote(answer.stopped, await changedFiles(worktree, this.#exec))}`
        work = { s, model, answer: await this.#ask(s.id, text), fresh: true }
        continue
      }
      const report = parseReport(answer.text)
      stage(task, "implement", answer.timedOut ? "fail" : "pass", answer.timedOut ? "timed out" : `status ${report.status ?? "missing"}`)
      if (answer.timedOut) {
        this.#escalate(job, task, "the worker timed out")
        return undefined
      }
      if (report.status === "BLOCKED" || report.status === "NEEDS_CONTEXT") {
        moveTask(task, "blocked")
        task.summary = report.open || report.text.slice(-500)
        this.#stop(job, `${task.id} needs the user: ${task.summary}`)
        return undefined
      }
      moveTask(task, "gating")
      const results = [...(await runGate(worktree, checks, this.#exec)), ...(await frozenCheck(worktree, frozen, this.#exec))]
      const failed = results.filter((r) => !r.passed)
      const changed = await changedFiles(worktree, this.#exec)
      const outside = task.files.length ? changed.filter((f) => !task.files.includes(f) && !frozen.has(f)) : changed
      stage(task, "gate", failed.length ? "fail" : "pass", results.length ? results.map((r) => `${r.command}: exit ${r.code}`).join("; ") : "no checks defined")
      saveNote(this.#d.project, job.id, task.id, noteText(task, report.text, results, outside))
      if (failed.length === 0) return work
      task.attempts++
      if (task.attempts > (this.#d.fixRounds ?? 2)) {
        this.#escalate(job, task, `checks still fail after ${task.attempts - 1} fix round(s): ${failed.map((f) => f.command).join(", ")}`)
        return undefined
      }
      moveTask(task, "fixing")
      this.#say(`${task.id}: ${failed.length} check(s) failed, fix round ${task.attempts}`)
      moveTask(task, "running")
      work.answer = await this.#ask(work.s.id, fixPrompt(failed))
    }
  }

  // P3's red stage: a test worker writes the tests first, and they must fail before anything is built. Returns the
  // frozen test files with their hashes (empty: no red could be shown, the task goes on as P2), or undefined when
  // the task went to the user.
  async #red(job: Job, task: Task, checks: readonly string[]): Promise<Map<string, string> | undefined> {
    const worktree = job.integrationWorktree!
    const model = await this.#model(job, "test", task.profile?.difficulty ?? 0.5, task.id)
    const s = await this.#workerSession(job, task, model.id, "test")
    const testFiles = task.files.filter((f) => TEST_FILE.test(f))
    const answer = await this.#ask(s.id, `${brief(job, task, model.id, worktree, this.#skills("red", task))}\n\n${redPrompt(task, testFiles)}`)
    if (answer.stopped || answer.timedOut) {
      stage(task, "red", "fail", answer.stopped ? `loop watchdog: ${answer.stopped.detail}` : "timed out")
      this.#escalate(job, task, `the tests-first worker ${answer.stopped ? "was stopped by the loop watchdog" : "timed out"}`)
      return undefined
    }
    const changed = await changedFiles(worktree, this.#exec)
    const tests = changed.filter((f) => TEST_FILE.test(f) && (testFiles.length === 0 || testFiles.includes(f)))
    const other = changed.filter((f) => !tests.includes(f))
    // Only tests in this stage: anything else the worker wrote is undone, the implementation comes after red.
    await revertFiles(worktree, other, this.#exec)
    if (tests.length === 0 || checks.length === 0) {
      stage(task, "red", "skip", tests.length === 0 ? "no tests written" : "no checks to show red with")
      this.#say(`${task.id}: no red stage (${tests.length === 0 ? "no tests written" : "no checks"}), going on as P2`)
      return new Map()
    }
    const results = await runGate(worktree, checks, this.#exec)
    if (results.every((r) => r.passed)) {
      stage(task, "red", "skip", "the new tests pass before the change, so they do not show the missing behaviour")
      this.#say(`${task.id}: the tests pass before the change; not frozen, going on as P2`)
      return new Map()
    }
    stage(task, "red", "pass", `${tests.join(", ")} fail before the change: ${results.filter((r) => !r.passed).map((r) => r.command).join(", ")}`)
    return hashFiles(worktree, tests, this.#exec)
  }

  // A reviewer of another model family reads the change against the acceptance points (P2, P3). A finding without
  // evidence is advisory; a review that is not JSON after one reminder counts as advisory too.
  async #review(job: Job, task: Task, workerModel: string): Promise<Review> {
    const worktree = job.integrationWorktree!
    const model = await this.#model(job, "review", task.profile?.difficulty ?? 0.5, task.id, [this.#family(workerModel)], task.profile?.vision)
    const s = await this.#workerSession(job, task, model.id, "review", TIER_STEPS.S)
    const diff = await workingDiff(worktree, this.#exec)
    let answer = await this.#ask(s.id, [reviewPrompt(job, task, taskAcceptance(job, task), diff), skillLine(this.#skills("review", task))].filter(Boolean).join("\n\n"))
    let review = answer.stopped || answer.timedOut ? { checks: [], fixes: [], blocking: [], error: answer.stopped ? `reviewer stopped: ${answer.stopped.detail}` : "reviewer timed out" } : parseReview(answer.text)
    if (review.error && !answer.stopped && !answer.timedOut) {
      answer = await this.#ask(s.id, `${HEADER} Answer again with the JSON only.`)
      review = parseReview(answer.text)
    }
    saveNote(this.#d.project, job.id, `${task.id}.review`, `# review of ${task.id} by ${model.id}\n\n${answer.text}\n`)
    return review
  }

  // P9: parallel readers, one synthesis written to docs/research/, and a citation check by code.
  async #research(job: Job, task: Task, model: string): Promise<void> {
    const worktree = job.integrationWorktree!
    const n = readerCount(task.profile?.difficulty ?? 0.5)
    const read = async (i: number) => {
      const s = await this.#workerSession(job, task, model, "research")
      return this.#ask(s.id, [readerPrompt(job, task, i, n), skillLine(this.#skills("reader", task))].filter(Boolean).join("\n\n"))
    }
    // Readers run in parallel in the cloud; a local device serves one model at a time, so there they take turns.
    const local = this.#d.registry.find((m) => m.id === model)?.location === "local"
    const readers: Awaited<ReturnType<typeof read>>[] = []
    if (local) for (let i = 0; i < n; i++) readers.push(await read(i))
    else readers.push(...(await Promise.all(Array.from({ length: n }, (_, i) => read(i)))))
    const notes = readers.filter((r) => !r.stopped && !r.timedOut && r.text).map((r) => r.text)
    readers.forEach((r, i) => saveNote(this.#d.project, job.id, `${task.id}.reader${i + 1}`, r.text || "(no answer)"))
    stage(task, "readers", notes.length ? "pass" : "fail", `${notes.length} of ${n} readers answered`)
    if (notes.length === 0) return this.#escalate(job, task, "no research reader came back with findings")
    const path = researchPath(task)
    const writerModel = await this.#model(job, "write", task.profile?.difficulty ?? 0.5, task.id)
    const s = await this.#workerSession(job, task, writerModel.id, "write")
    let answer = await this.#ask(s.id, synthesisPrompt(job, task, path, notes))
    for (let round = 0; ; round++) {
      if (answer.stopped || answer.timedOut) return this.#escalate(job, task, `the synthesis ${answer.stopped ? "was stopped by the loop watchdog" : "timed out"}`)
      let doc = ""
      try {
        doc = readFileSync(join(worktree, path), "utf8")
      } catch {
        // checked below: no file means no citations
      }
      const check = citationCheck(doc, notes)
      stage(task, "citations", check.ok ? "pass" : "fail", doc ? `${check.cited} cited${check.unknown.length ? `, not from a reader: ${check.unknown.join(" ")}` : ""}` : `${path} was not written`)
      if (check.ok) break
      if (round >= 1) return this.#escalate(job, task, `the research synthesis fails the citation check: ${doc ? (check.unknown.length ? `${check.unknown.length} URL(s) not from a reader` : "no citations") : `${path} missing`}`)
      answer = await this.#ask(s.id, `${HEADER} ${doc ? (check.unknown.length ? `These URLs are not in any reader's notes: ${check.unknown.join(" ")}. Remove them or the claims they support.` : "The document cites nothing. Cite every claim with a URL from the readers' notes.") : `Write ${path} as asked.`}`)
    }
    moveTask(task, "gating")
    const checks = [...new Set(taskAcceptance(job, task).map((a) => a.verify).filter((v): v is string => Boolean(v)))]
    const failed = (await runGate(worktree, checks, this.#exec)).filter((r) => !r.passed)
    if (failed.length) return this.#escalate(job, task, `checks fail after the research: ${failed.map((f) => f.command).join(", ")}`)
    moveTask(task, "passed")
    task.summary = `research written to ${path}`
    const commit = await commitTask(worktree, `${task.id}: ${task.title}`, `Job: ${job.id}\nResearch: ${n} reader(s) on ${model}, synthesis by ${writerModel.id}, pipeline P9`, this.#exec)
    moveTask(task, "merged")
    this.#say(`${task.id} researched${commit ? ` (${commit})` : ""}: ${path}`)
  }

  #skills(stage: Stage, task: Task): string[] {
    return skillsFor(stage, task.profile, task.pipeline, this.#d.installedSkills ?? new Set())
  }

  async #plannerSession(job: Job, model: string): Promise<{ id: string }> {
    const s = await this.#d.session.create({
      ...(this.#d.parentID ? { parentID: this.#d.parentID } : {}),
      title: `plan ${job.id}`,
      agent: roleById("plan")!.agent,
      model: toModel(model),
      location: { directory: this.#d.project },
    })
    this.#d.watch?.(s.id, 40)
    return s
  }

  // A worker session: the task's role unless a stage needs another (red: test, review, research readers), with the
  // profile's narrowed rights as the session's own permission rules (Phase A, A5).
  async #workerSession(job: Job, task: Task, model: string, role = task.role, steps?: number): Promise<{ id: string }> {
    const rules = role === task.role && task.profile ? narrowing(task.profile) : []
    const s = await this.#d.session.create({
      ...(this.#d.parentID ? { parentID: this.#d.parentID } : {}),
      title: `${task.id} ${role === task.role ? "" : `${role} `}${task.title}`,
      agent: roleById(role)?.agent ?? "dictator-code",
      model: toModel(model),
      location: { directory: job.integrationWorktree! },
      ...(rules.length ? { permissions: rules } : {}),
    })
    task.session = s.id
    this.#d.onWorker?.(s.id, `${task.id} ${task.title}: ${task.description}`, rules)
    this.#d.watch?.(s.id, steps ?? TIER_STEPS[task.profile?.budget ?? "M"])
    saveJob(this.#d.project, job)
    return s
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

// Frozen tests (P3) must not change after red: a changed or deleted one fails the gate like a failing check.
async function frozenCheck(worktree: string, frozen: ReadonlyMap<string, string>, run: Exec): Promise<GateResult[]> {
  if (frozen.size === 0) return []
  const now = await hashFiles(worktree, [...frozen.keys()], run)
  const changed = [...frozen].filter(([f, h]) => now.get(f) !== h).map(([f]) => f)
  return [{ command: "frozen tests unchanged", passed: changed.length === 0, code: changed.length ? 1 : 0, output: changed.length ? `changed after the red stage: ${changed.join(", ")}; restore them and change the code instead` : "" }]
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
  const lines = job.tasks.map((t) => `- ${t.id} ${t.title}: ${t.status}${t.model ? ` (${t.role} on ${t.model}${t.pipeline ? `, ${t.pipeline}` : ""})` : ""}`)
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
