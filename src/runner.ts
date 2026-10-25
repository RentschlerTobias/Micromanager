// Phase B's runner: a job from goal to its own branch, one task at a time on pipeline P1 (implement -> gate,
// fix at most twice). The planner and the workers are plugin-started sessions (Phase A, A2); code moves the
// state, runs the checks and commits. The decision model joins in later phases; here the rules decide.

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { buildAgenda, nextProposal } from "./agenda.ts"
import { Decider, RulesBackend } from "./backends.ts"
import { createHash } from "node:crypto"

import {
  ANSWER, batchQuestions, CHOICE_FLOOR, complexityOf, ESCALATE, ESCALATION, NOUL_FLOOR, nextQuestionChoice, PROGRESS, splitQuestions, TRIAGE,
  type EscalationKind,
} from "./catalog.ts"
import { n7Questions, n7State, triage, type N7Context, type Verdict } from "./followups.ts"
import { checkGuards, flagsWithoutUser, gateAnswer, gateQuestion, injected, injectionScore, type Unchecked } from "./gate.ts"
import { brief, fixPrompt, handoffText, lastAssistantText, parseReport, refused, skillLine, taskAcceptance, usage } from "./brief.ts"
import {
  changedFiles, commitTask, exec as defaultExec, fastForward, hashFiles, prepareIntegration, prepareTaskWorktree, rebaseTask, removeTaskWorktree, revertFiles,
  runGate, taskDir, workingDiff, type Exec, type GateResult,
} from "./integration.ts"
import { redact } from "./jev.ts"
import { learnQuestions, readMemory, RECALL_MAX, writeMemory } from "./memory.ts"
import { record } from "./journal.ts"
import { HEADER } from "./hooks.ts"
import {
  choosePipeline, citationCheck, riskAtLeast, greenNote, mergeReviews, readerCount, readerPrompt, redPrompt, researchPath, reviewFixPrompt, reviewPrompt, parseReview,
  standardsPrompt, synthesisPrompt, TEST_FILE, type Review, type ReviewAxis,
} from "./pipelines.ts"
import {
  addDelegated, addDiscovered, applyPlan, applyReplan, applySplits, MAX_SPLIT_LEVEL, parsePlan, PLAN_FORMAT, replanFormat, splitFormat, waves,
  type Delegation, type Parsed, type Plan, type PlannedTask,
} from "./plan.ts"
import { classifyQuestions, classifyState, combine, narrowing, profileText, type Profile, type Skill } from "./profile.ts"
import { resolvePolicy, type Policies } from "./policy.ts"
import { route, type Availability, type ModelEntry } from "./registry.ts"
import { family, roleById, type Rule } from "./roles.ts"
import {
  addNodes, applyAnswer, applyShortcut, decisionsText, frontier, instruction, matchSessionShortcut, nextStep, parseTree, settle,
  type AnswerReading, type DesignTree, type Step,
} from "./session.ts"
import { discoveredCap, isDone, parallelSafe, moveJob, moveTask, newJob, promoteReady, stage, type FollowUp, type Job, type JobPhase, type Later, type Task } from "./state.ts"
import { skillsFor, type Stage } from "./skills.ts"
import { excludeFromGit, jobId, loadJob, saveJob, saveNote } from "./store.ts"
import { FIX_ROUNDS, handoffNote, MAX_STEPS, TIER_STEPS, type Signal } from "./watchdog.ts"
import { overBudget } from "./budget.ts"

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
  readonly progress?: (text: string, task?: boolean) => void // task: a task finished or was added
  readonly parentID?: string // the micromanager session; workers show up as its children
  readonly onWorker?: (sessionID: string, task: string, rules: readonly Rule[]) => void // a worker's task and narrowed rights, for permissions
  readonly workerTimeoutMs?: number
  readonly stallMs?: number // a session whose messages do not change this long is stalled (default 4 min)
  readonly pollMs?: number // how often a running session is looked at for that (default 20 s)
  readonly fixRounds?: number
  readonly planRetries?: number
  readonly decider?: Decider // the decision model per node; without one, the rules decide
  readonly watch?: (sessionID: string, maxSteps: number) => void // the loop watchdog starts judging a session
  readonly stopped?: (sessionID: string) => Signal | undefined // why the watchdog stopped a session, if it did
  readonly unchecked?: Unchecked // what G0 does when nothing local could check a job
  readonly cloudOnly?: boolean // local models are switched off (the user's choice for now): nothing may need them
  readonly skills?: readonly Skill[] // the skills the decision model may pick per task (design.md §13.1)
  readonly installedSkills?: ReadonlySet<string> // the skills a brief may name: linked into OpenCode by install.sh
  readonly cancelled?: () => boolean // the user stopped the job (stop_job); checked around every session turn
  readonly budget?: { tokens?: number; requests?: number; cost?: number } // per job, from the config (design.md §10.2)
  readonly parallel?: number // tasks of a job at the same time (Phase F); 1 runs them one after another in the job's worktree
  readonly perModel?: number // sessions of one cloud model at the same time; a local model serves one at a time
  readonly taskEnded?: (job: Job, task: Task) => void // a task of a rolling job merged, escalated or waits for the user
  readonly waiting?: (sessionID: string) => boolean // a permission request of the session is paused for an answer (src/ask.ts)
}

// Thrown out of a session turn when the user stopped the job; run() pauses the job, and the next run resumes it.
export class Cancelled extends Error {}

// A worker session in progress: its model, its last answer, and whether it is already the fresh retry.
interface Work {
  s: { id: string }
  model: { id: string; reason: string }
  answer: { text: string; timedOut: boolean; stopped?: Signal }
  fresh: boolean
  uncensored?: boolean // rerouted to a local uncensored model after a refusal
}

const REVIEW_ROUNDS = 3

// What a step of the micromanager's tools ends with: text for the micromanager to act on.
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
  #job?: Job // the job this runner works on; its counters take every session's usage
  readonly #seen = new Map<string, { tokens: number; cost: number; requests: number }>() // usage per session so far
  readonly #tokenCaps = new Map<string, number>() // N5's budget tier per worker session
  readonly #sessionModel = new Map<string, string>() // for the per-model limit
  readonly #slots = new Map<string, { used: number; waiting: (() => void)[] }>()
  #train: Promise<void> = Promise.resolve() // the merge train: one task's branch at a time

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

  #say(text: string, task = false): void {
    this.#d.progress?.(text, task)
  }

  // The model for a role: the user's preset if any, else the router over the registry, else the role's cloud model.
  // uncensored: this task needs a local uncensored model (a worker refused it); routed is false when none fits.
  async #model(job: Job, role: string, difficulty: number, task?: string, avoidFamilies?: string[], vision = false, uncensored = false): Promise<{ id: string; reason: string; routed: boolean }> {
    const preset = resolvePolicy("N5.model", this.#policies(job, task))
    const presetModel = preset.policy.kind === "fixed" ? this.#d.registry.find((m) => m.id === (preset.policy as { value: string }).value) : undefined
    const local = job.flags?.localOnly || uncensored
    const free = job.flags?.uncensored || uncensored
    const presetBreaksGate = local && (presetModel?.location === "cloud" || (free && presetModel?.censored !== false))
    if (preset.policy.kind === "fixed" && !presetBreaksGate) {
      this.#journal({ kind: "routing", job: job.id, task, role, model: preset.policy.value, reason: `preset (${preset.level})` })
      return { id: preset.policy.value, reason: `preset (${preset.level})`, routed: true }
    }
    if (presetBreaksGate) this.#say(`preset ${(preset.policy as { value: string }).value} ignored: the ${uncensored ? "task" : "job"} must stay local${free ? " and uncensored" : ""}`)
    const availability = await this.#d.availability?.().catch(() => undefined)
    const r = route(this.#d.registry, { role, difficulty, vision, sensitive: local, refusalLikely: free, avoidFamilies }, availability)
    const id = r.model ?? roleById(role)?.models[0] ?? this.#d.registry[0]!.id
    this.#journal({ kind: "routing", job: job.id, task, role, model: id, reason: r.model ? r.reason : `fallback: ${r.reason}`, ranked: r.ranked.slice(0, 5) })
    return { id, reason: r.model ? r.reason : "fallback", routed: r.model !== undefined }
  }

  async #ask(sessionID: string, text: string): Promise<{ text: string; timedOut: boolean; stopped?: Signal }> {
    if (this.#d.cancelled?.()) throw new Cancelled()
    const model = this.#sessionModel.get(sessionID)
    const release = model ? await this.#acquire(model) : () => {}
    const timeoutMs = this.#d.workerTimeoutMs ?? 20 * 60_000
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut: boolean
    let stalled: Signal | undefined
    let done = false
    try {
      // Briefs, handoff notes, check output and review diffs may quote a key; no model needs one (E2b).
      await this.#d.session.prompt({ sessionID, text: redact(text) })
      timedOut = await Promise.race([
        this.#d.session.wait({ sessionID }).then(() => false),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs) }),
        this.#stall(sessionID, () => done).then((s) => { stalled = s; return s !== undefined }),
      ])
    } finally {
      done = true
      clearTimeout(timer) // also when wait() fails, or the timer keeps the process alive for the whole timeout
      release()
    }
    if (timedOut && !stalled) await this.#d.session.interrupt({ sessionID }).catch(() => undefined) // a stall interrupted already
    if (this.#d.cancelled?.()) throw new Cancelled()
    const messages = await this.#d.session.context({ sessionID })
    const used = this.#count(sessionID, messages)
    const cap = this.#tokenCaps.get(sessionID)
    const stopped = stalled ?? this.#d.stopped?.(sessionID) ?? (cap && used.tokens > cap ? { kind: "tokens" as const, detail: `${used.tokens} tokens in one session, over the task's ${cap}` } : undefined)
    return { text: lastAssistantText(messages), timedOut: timedOut && !stalled, stopped }
  }

  // A provider stream that stops mid-answer leaves a session waiting with no hook firing (live test: a reviewer's
  // message started streaming and never completed). The session is looked at every pollMs; when nothing changed for
  // stallMs, it is stalled and treated like a watchdog stop: a fresh session on another family.
  //
  // "Did anything change?" is answered by the message bookkeeping, not by the messages: JSON.stringify over the
  // whole history of a session in the hundreds of thousands of tokens cost megabytes per poll, per active session,
  // to learn nothing. The fingerprint is the number of messages plus the last one's id and updated time, all of it
  // monotonic and O(1) to read.
  async #stall(sessionID: string, finished: () => boolean): Promise<Signal | undefined> {
    const pollMs = this.#d.pollMs ?? 20_000
    const stallMs = this.#d.stallMs ?? 4 * 60_000
    const fingerprint = (messages: unknown): string => {
      if (!Array.isArray(messages)) return ""
      const last = messages[messages.length - 1] as { id?: unknown; time?: { created?: unknown; updated?: unknown } } | undefined
      return `${messages.length}:${String(last?.id ?? "")}:${String(last?.time?.updated ?? last?.time?.created ?? "")}`
    }
    let last = ""
    let since = Date.now()
    while (!finished()) {
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, pollMs); t.unref?.() })
      if (finished()) return undefined
      // A context call that fails counts as no change, as before: an unreadable session is not a moving one.
      const seen = await this.#d.session.context({ sessionID }).catch(() => undefined)
      const now = seen === undefined ? last : fingerprint(seen)
      // A session paused on a permission request waits for an answer, not for a stuck model: it is no stall.
      if (now !== last || this.#d.waiting?.(sessionID)) [last, since] = [now, Date.now()]
      else if (Date.now() - since >= stallMs) {
        await this.#d.session.interrupt({ sessionID }).catch(() => undefined)
        return { kind: "stalled", detail: `no progress for ${Math.round(stallMs / 1000)} s (the model stopped answering)` }
      }
    }
    return undefined
  }

  // A turn on a model waits for a free slot: 2 sessions per cloud model, 1 per local one (design.md §11).
  async #acquire(model: string): Promise<() => void> {
    const cap = this.#d.registry.find((m) => m.id === model)?.location === "local" ? 1 : (this.#d.perModel ?? 2)
    const slot = this.#slots.get(model) ?? { used: 0, waiting: [] }
    this.#slots.set(model, slot)
    while (slot.used >= cap) await new Promise<void>((resolve) => slot.waiting.push(resolve))
    slot.used++
    return () => {
      slot.used--
      slot.waiting.shift()?.()
    }
  }

  // A session's usage so far; what is new since the last turn goes to the job's counters.
  #count(sessionID: string, messages: unknown): { tokens: number; cost: number; requests: number } {
    const now = { ...usage(messages), requests: Array.isArray(messages) ? (messages as { type?: string }[]).filter((m) => m.type === "assistant").length : 0 }
    const before = this.#seen.get(sessionID) ?? { tokens: 0, cost: 0, requests: 0 }
    this.#seen.set(sessionID, now)
    const c = this.#job?.counters
    if (c) {
      c.tokens = (c.tokens ?? 0) + Math.max(0, now.tokens - before.tokens)
      c.cost = (c.cost ?? 0) + Math.max(0, now.cost - before.cost)
      c.requests = (c.requests ?? 0) + Math.max(0, now.requests - before.requests)
    }
    return now
  }

  // The first budget the job has used up, as a reason; checked before every start (design.md §10.2).
  #overBudget(job: Job): string | undefined {
    return overBudget(job)
  }

  // Goal -> validated plan, waiting at the plan gate for the user's go.
  async plan(goal: string): Promise<{ job: Job; errors?: string[] }> {
    const job = newJob(jobId(), goal)
    excludeFromGit(this.#d.project)
    moveJob(job, "triage")
    return this.planJob(job)
  }

  // A job from triage or a confirmed checkpoint to a validated plan at the plan gate.
  // In cloud-only mode a job is local-only only by the user's choice. A local-only flag that came from the "nothing
  // local could check it" default (the GLiNER server was down) is dropped.
  #cloudFlags(job: Job): void {
    if (this.#d.cloudOnly && job.flags?.localOnly && job.flags.gate && !job.flags.gate.checked) {
      job.flags = { ...job.flags, localOnly: false }
      job.lessons.push("cloud only: the local-only default of an unchecked goal was dropped")
    }
  }

  async planJob(job: Job): Promise<{ job: Job; errors?: string[] }> {
    this.#cloudFlags(job)
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

  // A new job from the micromanager: the local gate, triage, then a planning session or the planner (design.md §6).
  async start(goal: string, facilitator?: string): Promise<Outcome> {
    const job = newJob(jobId(), goal)
    job.facilitator = facilitator
    excludeFromGit(this.#d.project)
    moveJob(job, "triage")
    const gate = await checkGuards(this.#decider, goal, job.id)
    const flags = flagsWithoutUser(gate, this.#d.unchecked ?? (this.#d.cloudOnly ? "cloud" : "local"), this.#d.cloudOnly)
    if (flags === "ask_user") {
      job.flags = { gate }
      moveJob(job, "ask_user")
      saveJob(this.#d.project, job)
      return { kind: "gate", job, text: `[job ${job.id}] Only the user can answer the local check, so ask them now: show the question below word for word, call no tool, and end your turn. Their reply reaches the plugin by itself.\n\n${gateQuestion(gate, this.#d.cloudOnly)}` }
    }
    job.flags = flags
    return this.#triage(job)
  }

  // plan_job with a job id: go on from wherever the job stands.
  // feedback: what the user wants changed in a plan at the plan gate. It becomes a decision, and the planner writes
  // the plan again (live test: the micromanager asked eight times for a fuller plan and always got the old one back).
  async continueJob(id: string, feedback?: string): Promise<Outcome> {
    const job = loadJob(this.#d.project, id)
    if (!job) return { kind: "failed", job: newJob(id, ""), text: `no job ${id}` }
    if (job.phase === "plan_gate" && feedback?.trim()) {
      job.decisions.push({ id: `F${job.decisions.length + 1}`, text: `plan feedback: ${feedback.trim()}`, origin: "user" })
      moveJob(job, "plan")
      saveJob(this.#d.project, job)
      return this.#planned(await this.planJob(job))
    }
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

  // One user turn in the micromanager session: the gate answer, a planning-session answer, or the checkpoint reply.
  // Returns the instruction for the micromanager's next turn, or undefined when the turn is not about this job.
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
      return `[job ${id}] The user answered the local check${reply.uncensored ? ": local uncensored models only" : reply.localOnly ? ": everything stays local" : ""}. Call plan_job with goal "${id}" to continue.`
    }
    const tree = job.designTree
    if (job.phase === "design_checkpoint" && tree) {
      const s = matchSessionShortcut(text)
      if (s?.kind === "confirm") {
        job.decisions = tree.nodes.filter((n) => n.status === "settled").map((n) => ({ id: n.id, text: `${n.question} -> ${n.answer}`, origin: n.origin === "fact" ? "fact" : "user" }))
        moveJob(job, "plan")
        saveJob(this.#d.project, job)
        return `[job ${id}] The user confirmed the design. Call plan_job with goal "${id}" to plan it now.`
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
  // note: the user's answer when the job stopped for them; it becomes a decision every later brief carries, and a
  // blocked task starts again with it.
  async run(id: string, note?: string): Promise<Job> {
    const job = loadJob(this.#d.project, id)
    if (!job) throw new Error(`no job ${id}`)
    if (job.phase === "plan_gate") moveJob(job, "execute")
    else if (job.phase === "paused" && job.resumePhase === "execute") moveJob(job, "execute")
    else if (job.phase === "ask_user" && job.resumePhase === "execute") {
      // Running the job again after "confirm Tn before it runs" is the user's go for those tasks.
      for (const t of job.tasks) if (t.confirmed === false) t.confirmed = true
      for (const t of job.tasks) if (t.status === "blocked") moveTask(t, "pending")
      moveJob(job, "execute")
    }
    if (note?.trim()) job.decisions.push({ id: `U${job.decisions.length + 1}`, text: note.trim(), origin: "user" })
    if (job.phase !== "execute") throw new Error(`job ${id} is in phase ${job.phase}, not ready to run`)
    this.#job = job
    this.#cloudFlags(job)
    // Never quietly to the cloud: a job that must stay on this machine waits while local models are switched off.
    if (this.#d.cloudOnly && job.flags?.localOnly) {
      this.#stop(job, "this job must stay on this machine, but local models are switched off (cloudOnly); the user can let it go to the cloud, or switch local models on")
      saveJob(this.#d.project, job)
      return job
    }
    job.budget.tokensMax ??= this.#d.budget?.tokens
    job.budget.requestsMax ??= this.#d.budget?.requests
    job.budget.costMax ??= this.#d.budget?.cost
    if (!job.integrationWorktree) {
      excludeFromGit(this.#d.project) // also for a rolling job, which never passes plan or start
      const integration = await prepareIntegration(this.#d.project, job.id, this.#exec)
      job.integrationBranch = integration.branch
      job.integrationWorktree = integration.worktree
      // A git worktree is a checkout of the repository ROOT, so a project below it keeps an offset: without it every
      // worker and every check would work three levels above its own files.
      job.integrationRel = integration.rel
      job.integrationBase = integration.base
      job.integrationDirty = integration.dirty ? integration.dirtySummary : ""
      this.#say(`working on branch ${integration.branch}`)
      if (integration.rel) this.#say(`the project is ${integration.rel} below the repository root, so the worktree holds the whole repository; the tasks work in ${taskDir(integration.worktree, integration.rel)}`)
      if (integration.dirty) this.#say(`the working tree has uncommitted paths no worker will see (${integration.dirtySummary}); this job starts from ${integration.base.slice(0, 7)}`)
    } else await this.#reconcile(job)
    saveJob(this.#d.project, job)
    // Tasks run as promises; with parallel 1 one at a time, as before Phase F. A task that stops the job lets the
    // others finish what they are doing; a stop by the user cuts them all.
    const running = new Map<string, Promise<void>>()
    let cancelled = false
    let failure: unknown
    const start = (task: Task) => {
      const p = this.#dispatch(job, task)
        .catch((err: unknown) => { if (err instanceof Cancelled) cancelled = true; else failure ??= err })
        .finally(() => { running.delete(task.id); saveJob(this.#d.project, job) })
      running.set(task.id, p)
    }
    const settle = () => Promise.race(running.values())
    try {
      for (;;) {
        if (failure) throw failure
        if (cancelled || job.phase !== "execute") {
          if (running.size) await settle()
          else break
          continue
        }
        promoteReady(job)
        // A rolling job only runs what the orchestrator delegated: no verify, replan or wrap; it ends when nothing is
        // left to start, and the next delegation runs it again.
        const agenda = buildAgenda(job).filter((p) => (!p.taskId || !running.has(p.taskId)) && (!job.rolling || p.action === "dispatch"))
        const next = nextProposal(agenda)
        if (!next || (next.action !== "dispatch" && running.size)) {
          // verify, replan and asking the user wait until every running task has finished
          if (running.size) await settle()
          else break
          continue
        }
        if (++job.counters.turns > job.budget.turnsMax) {
          this.#stop(job, `turn budget of ${job.budget.turnsMax} used up`)
          continue
        }
        const over = this.#overBudget(job)
        if (over) {
          this.#stop(job, `budget: ${over}; raise it in the config or with a pin, then run the job again`)
          continue
        }
        if (next.action === "dispatch") {
          const batch = await this.#batch(job, agenda, running)
          if (batch.length === 0) await settle()
          for (const t of batch) start(t)
          if ((this.#d.parallel ?? 1) <= 1) while (running.size) await settle()
        } else if (next.action === "verify") await this.#verify(job)
        else if (next.action === "replan") await this.#replan(job)
        else this.#stop(job, next.label)
        saveJob(this.#d.project, job)
      }
      if (failure) throw failure
      if (cancelled) throw new Cancelled()
    } catch (err) {
      if (!(err instanceof Cancelled)) throw err
      // The tasks in progress are cut; the next run's reconcile starts them again from the last commit.
      if ((job.phase as JobPhase) === "replan") moveJob(job, "execute")
      job.lessons.push("stopped by the user")
      const phase = job.phase as JobPhase
      if (phase === "ask_user") moveJob(job, job.resumePhase ?? "execute") // a task had stopped it: pause the run itself
      if ((job.phase as JobPhase) !== "paused") moveJob(job, "paused")
      this.#say("stopped by the user; run the job again to resume")
    }
    saveJob(this.#d.project, job)
    return job
  }

  // The next ready tasks that may run next to the running ones: disjoint files, within the job's limit. Two or more
  // new ones are a batch the decision model confirms (N10); one it doubts waits for a later batch.
  async #batch(job: Job, agenda: readonly { action: string; taskId?: string }[], running: ReadonlyMap<string, unknown>): Promise<Task[]> {
    const limit = Math.max(1, this.#d.parallel ?? 1)
    const busy = job.tasks.filter((t) => running.has(t.id))
    const batch: Task[] = []
    for (const p of agenda) {
      if (p.action !== "dispatch" || !p.taskId || busy.length + batch.length >= limit) continue
      const t = job.tasks.find((x) => x.id === p.taskId)!
      if ([...busy, ...batch].every((o) => parallelSafe(o, t))) batch.push(t)
    }
    // N10 is opt-in ("N10": "auto" in the config): disjoint files are enough to run side by side.
    const n10 = resolvePolicy("N10", this.#policies(job))
    if (batch.length + busy.length < 2 || batch.length === 0 || n10.level === undefined || n10.policy.kind !== "auto") {
      if (batch.length + busy.length > 1) this.#say(`starting ${batch.map((t) => t.id).join(", ")}${busy.length ? ` next to ${busy.map((t) => t.id).join(", ")}` : " in parallel"}`)
      return batch
    }
    const all = [...busy, ...batch]
    const others = (id: string) => all.filter((t) => t.id !== id).map((t) => `${t.id} ("${t.title}")`).join(", ")
    const asked = await this.#decider.ask("N10", { goal: job.goal, tasks: all.map((t) => `${t.id} ${t.title}: ${t.description.slice(0, 300)} (files: ${t.files.join(", ") || "none"})`) }, batchQuestions(batch, others), { localOnly: job.flags?.localOnly, job: job.id })
    const a = asked.decision.answers
    // The first new task always goes when nothing runs; the others need the model's yes when it answered.
    const kept = batch.filter((t, i) => {
      const p = a[`independent.${t.id}`]
      return (i === 0 && busy.length === 0) || p?.type !== "noul" || p.noul >= NOUL_FLOOR
    })
    if (kept.length > 1 || busy.length) this.#say(`starting ${kept.map((t) => t.id).join(", ")} in parallel${busy.length ? ` with ${busy.map((t) => t.id).join(", ")}` : ""}`)
    return kept
  }

  // One task: in the job's worktree when tasks run one at a time, else in its own worktree, then the merge train.
  async #dispatch(job: Job, task: Task): Promise<void> {
    if ((this.#d.parallel ?? 1) <= 1) return this.#runTask(job, task)
    const w = await prepareTaskWorktree(this.#d.project, job.id, task.id, job.integrationBranch!, this.#exec, undefined, job.integrationRel ?? "")
    task.worktree = w.worktree
    task.worktreeRel = w.rel
    task.branch = w.branch
    try {
      await this.#runTask(job, task)
      if (task.status === "passed") {
        const step = this.#train.then(() => this.#merge(job, task))
        this.#train = step.catch(() => undefined)
        await step
      }
    } finally {
      if (task.worktree && task.status !== "blocked") await this.#dropWorktree(task)
    }
  }

  async #dropWorktree(task: Task): Promise<void> {
    if (!task.worktree || !task.branch) return
    await removeTaskWorktree(this.#d.project, { worktree: task.worktree, branch: task.branch }, this.#exec)
    task.worktree = undefined
    task.branch = undefined
  }

  // The merge train (design.md §11): rebase onto the job's branch, the task's checks again when that moved, then a
  // fast-forward. A conflict sends the task back to start again from the newest commit once; the second goes to the
  // user.
  async #merge(job: Job, task: Task): Promise<void> {
    const w = { worktree: task.worktree!, branch: task.branch! }
    let step = await rebaseTask(w, job.integrationBranch!, this.#exec)
    if (step.ok && step.moved) {
      const checks = [...new Set(taskAcceptance(job, task).map((a) => a.verify).filter((v): v is string => Boolean(v)))]
      const failed = (await runGate(w.worktree, checks, this.#exec, undefined, this.#dir(job, task))).filter((r) => !r.passed)
      if (failed.length) step = { ok: false, conflict: `checks fail on top of the newer commits (in ${this.#dir(job, task)}): ${failed.map((f) => f.command).join(", ")}` }
    }
    if (step.ok) step = await fastForward(job.integrationWorktree!, w.branch, this.#exec)
    if (step.ok) {
      moveTask(task, "merged")
      stage(task, "merge", "pass", `merged into ${job.integrationBranch}`)
      this.#say(`${task.id} merged into ${job.integrationBranch}`, true)
      await this.#dropWorktree(task)
      await this.#ended(job, task)
      return
    }
    task.conflicts = (task.conflicts ?? 0) + 1
    stage(task, "merge", "fail", step.conflict)
    await this.#dropWorktree(task)
    if (task.conflicts === 1) {
      moveTask(task, "pending")
      job.lessons.push(`${task.id} did not merge (${step.conflict}); it starts again from the newest commit`)
      this.#say(`${task.id}: ${step.conflict}; it starts again from the newest commit`)
      return
    }
    await this.#escalate(job, task, `it did not merge twice: ${step.conflict}`, "", "merge_conflict")
  }

  // omo-hybrid: the orchestrator's delegation goes into the job this runner works on, so the run loop sees it at its
  // next turn; undefined when this runner does not work on that job (the caller then writes the job file).
  addTask(jobId: string, d: Delegation): { task?: Task; errors?: string[] } | undefined {
    const job = this.#job
    if (!job || job.id !== jobId) return undefined
    const r = addDelegated(job, d)
    if (r.task) saveJob(this.#d.project, job)
    return r
  }

  // The user's answer for a task of the job this runner works on, applied to the live job so the run loop starts the
  // task again; undefined when this runner does not work on that job.
  answerTask(jobId: string, taskId: string, text: string, checks: readonly string[] = []): string | undefined | false {
    const job = this.#job
    if (!job || job.id !== jobId) return false
    const err = Runner.answer(job, taskId, text, checks)
    if (!err) saveJob(this.#d.project, job)
    return err
  }

  // A rolling job's task that waits for the user: the answer becomes a decision every later brief carries, and the
  // task starts again from the job's newest commit.
  // checks: new checks for the task, replacing the ones it was delegated with (live test: a check with a wrong path
  // kept a finished reader blocked, and no answer could change it).
  static answer(job: Job, taskId: string, text: string, checks: readonly string[] = []): string | undefined {
    const task = job.tasks.find((t) => t.id === taskId)
    if (!task) return `no task ${taskId}`
    if (task.status !== "blocked" && task.status !== "escalated") return `task ${taskId} is ${task.status}; it waits for nobody`
    if (checks.length) {
      const own = job.acceptance.filter((a) => task.acceptance.includes(a.id) && !job.tasks.some((t) => t.id !== task.id && t.acceptance.includes(a.id)))
      if (!own.length) return `task ${taskId} shares its acceptance points with other tasks; its checks cannot change alone`
      job.acceptance = job.acceptance.map((a) => (own.some((o) => o.id === a.id) ? { ...a, verify: checks.join(" && ") } : a))
    }
    job.decisions.push({ id: `U${job.decisions.length + 1}`, text: `${taskId}: ${text}`, origin: "user" })
    moveTask(task, "pending")
    task.confirmed = true
    task.attempts = 0
    return undefined
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
      passed: ["pending"], // passed in its own worktree, but the train had not merged it yet
    }
    const cut = job.tasks.filter((t) => PATH[t.status])
    for (const t of cut) await this.#dropWorktree(t)
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

  // task: the stop concerns one task. In a rolling job that never stops the job: the task waits, and the orchestrator
  // hears of it and asks the user.
  #stop(job: Job, reason: string, task?: Task): void {
    job.lessons.push(reason)
    if (job.rolling && task) {
      this.#say(`${task.id} waits: ${reason}`)
      this.#d.taskEnded?.(job, task)
      return
    }
    // A parallel task may stop a job another task already stopped; the job keeps the phase it returns to.
    if (job.phase !== "ask_user" && job.phase !== "paused") moveJob(job, "ask_user")
    this.#say(`stopped: ${reason}`)
  }

  async #runTask(job: Job, task: Task): Promise<void> {
    if (job.budget.workersUsed >= job.budget.workersMax) return this.#stop(job, `worker budget of ${job.budget.workersMax} used up`)
    const worktree = this.#worktree(job, task) // git commands run in the worktree root
    const dir = this.#dir(job, task) // the worker and its checks work in the project directory
    const profile = task.profile ?? (await this.#classify(job, task))
    if (profile.injection) {
      moveTask(task, "blocked")
      task.summary = "the task text looks like an attempt to make the agent ignore its rules"
      return this.#stop(job, `${task.id}: ${task.summary}; check the plan before going on`, task)
    }
    const pipeline = choosePipeline(task, profile, this.#policies(job, task.id))
    task.pipeline = pipeline.id
    const askFirst = pipeline.modifiers.includes("user_confirm") || resolvePolicy("N5", this.#policies(job, task.id)).policy.kind === "ask"
    if (askFirst && task.confirmed !== true) {
      task.confirmed = false
      if (job.rolling) {
        moveTask(task, "blocked")
        task.summary = `waits for the user's go: ${profileText(profile)}`
      }
      return this.#stop(job, `confirm ${task.id} before it runs: ${profileText(profile)} · pipeline ${pipeline.id} (${pipeline.reason}). Run the job again to go on, or pin a change first ("${task.id} use <model>", "pipeline P2").`, task)
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
    const first = [brief(job, task, model.id, dir, this.#skills("implement", task)), frozen.size ? greenNote([...frozen.keys()]) : ""].filter(Boolean).join("\n\n")
    let work: Work | undefined = { s, model, answer: await this.#ask(s.id, first), fresh: false }
    work = await this.#untilGreen(job, task, work, checks, frozen)
    if (!work) return
    const review = (pipeline.id === "P2" || pipeline.id === "P3") && resolvePolicy("N6.review", this.#policies(job, task.id)).policy.kind !== "fixed"
    let lastIssues = ""
    for (let round = 1; review; round++) {
      moveTask(task, "reviewing")
      const r = await this.#review(job, task, work.model.id)
      stage(task, "review", r.blocking.length ? "fail" : "pass", r.error ?? (r.blocking.length ? r.blocking.map((c) => `${c.point}: ${c.evidence}`).join("; ").slice(0, 500) : `verdict ${r.verdict ?? "none"}, nothing blocking`))
      if (r.blocking.length === 0) break
      // N8 signature: the same unmet points as the last round mean this session is not getting there.
      const issues = r.blocking.map((c) => c.point).sort().join(",")
      const repeated = issues === lastIssues
      lastIssues = issues
      if (round >= REVIEW_ROUNDS || repeated) {
        const why = repeated ? `the review found the same unmet points twice: ${issues}` : `the review still finds unmet points after ${REVIEW_ROUNDS} rounds: ${issues}`
        work = await this.#nextRung(job, task, work, frozen, why, r.blocking.map((c) => `- ${c.point}: ${c.evidence}`).join("\n"), "conflicting_review")
        if (!work) return
        round = 0
        lastIssues = ""
      } else {
        moveTask(task, "fixing")
        moveTask(task, "running")
        this.#say(`${task.id}: the review found ${r.blocking.length} unmet point(s), round ${round + 1}`)
        work.answer = await this.#ask(work.s.id, [reviewFixPrompt(r), skillLine(this.#skills("review_fix", task))].filter(Boolean).join("\n\n"))
      }
      work = await this.#untilGreen(job, task, work, checks, frozen)
      if (!work) return
    }
    moveTask(task, "passed")
    task.summary = work.answer.text.slice(-500)
    const outside = (await changedFiles(worktree, this.#exec)).filter((f) => task.files.length > 0 && !task.files.includes(f) && !frozen.has(f))
    const commit = await commitTask(worktree, `${task.id}: ${task.title}`, `Job: ${job.id}\nWorker: ${work.model.id} (${task.role}), pipeline ${pipeline.id}${outside.length ? `\nOutside the declared files: ${outside.join(", ")}` : ""}`, this.#exec)
    job.counters.stalls = Math.max(0, job.counters.stalls - 1)
    if (task.worktree) return this.#say(`${task.id} passed${commit ? ` (${commit})` : ", nothing to commit"}; waiting for the merge train`)
    moveTask(task, "merged")
    this.#say(`${task.id} passed${commit ? ` (${commit})` : ", nothing to commit"}`, true)
    await this.#ended(job, task)
  }

  // A merged task: in a rolling job the orchestrator gets its report and decides on its follow-ups; in a planned job
  // N7 does (design.md §8).
  async #ended(job: Job, task: Task): Promise<void> {
    await this.#learn(job, task)
    if (job.rolling) this.#d.taskEnded?.(job, task)
    else await this.#discover(job, task)
  }

  // N15: a merged task's LEARNED lines go into the project memory when Jev calls them lasting and not yet known.
  // Without an answer nothing is kept: a wrong fact in the memory misleads every later task.
  async #learn(job: Job, task: Task): Promise<void> {
    const items = (task.learned ?? []).slice(0, 5)
    if (items.length === 0) return
    const memory = readMemory(this.#d.project)
    const asked = await this.#decider.ask("N15", { project: this.#d.project.split("/").pop(), memory: memory.slice(-40), learned: items }, learnQuestions(items), { localOnly: job.flags?.localOnly, job: job.id, task: task.id })
    const a = asked.decision.answers
    const p = (q: string) => (a[q]?.type === "noul" ? (a[q] as { noul: number }).noul : undefined)
    const keep = items.filter((_, i) => (p(`lasting.${i}`) ?? 0) >= NOUL_FLOOR && (p(`useful.${i}`) ?? 0) >= NOUL_FLOOR && (p(`known.${i}`) ?? 1) < NOUL_FLOOR)
    this.#journal({ kind: "memory", job: job.id, task: task.id, offered: items, kept: keep, decision: asked.id })
    task.learned = []
    if (keep.length === 0) return
    excludeFromGit(this.#d.project)
    writeMemory(this.#d.project, [...memory, ...keep.map((k) => k.slice(0, 300))])
    this.#say(`${task.id}: remembered for this project: ${keep.join("; ")}`)
  }

  // N7: what the worker found outside its task. Needed or in scope: a new task after this one, with the priority the
  // model gave. The user's call, out of scope, or over the cap: the job's "later" list, shown at the end. Without a
  // decision model a follow-up is in scope when every file it names is already in the plan.
  async #discover(job: Job, task: Task): Promise<void> {
    const items = task.followUps ?? []
    if (items.length === 0) return
    const policy = resolvePolicy("N7", this.#policies(job, task.id)).policy
    const live = job.tasks.filter((t) => t.id !== task.id && t.status !== "cancelled")
    const ctx: N7Context = {
      goal: job.goal,
      acceptance: job.acceptance.map((a) => a.text),
      task: `${task.id} ${task.title}`,
      otherTasks: live.map((t) => `${t.id} ${t.title} (files: ${t.files.join(", ") || "none"})`),
      openFiles: new Set(live.filter((t) => !isDone(t)).flatMap((t) => t.files)),
      doneFiles: new Set(job.tasks.filter((t) => isDone(t) || t.id === task.id).flatMap((t) => t.files)),
    }
    const asked = policy.kind === "rule" || policy.kind === "fixed" ? undefined
      : await this.#decider.ask("N7", n7State(ctx, items), n7Questions(items), { localOnly: job.flags?.localOnly, job: job.id, task: task.id })
    // "N7": "fixed:yes" takes every follow-up as a task, "fixed:no" none.
    const verdicts: Verdict[] = policy.kind === "fixed"
      ? items.map((f) => (policy.value === "no" ? { kind: "later", reason: "out_of_scope" } : f.files.length ? { kind: "task", priority: 3 } : { kind: "later", reason: "no_files" }))
      : triage(asked?.decision.answers ?? {}, items, ctx)
    for (const [i, item] of items.entries()) {
      const v = verdicts[i]!
      if (v.kind === "planned") {
        this.#journal({ kind: "discovered", job: job.id, from: task.id, what: item.what, dropped: "already planned", decision: asked?.id })
        continue
      }
      let reason: Later["reason"] | undefined = v.kind === "later" ? v.reason : undefined
      // A follow-up is text a model wrote, so it passes the local guards like a goal before it can become a task.
      if (v.kind === "task") {
        const guard = await checkGuards(this.#decider, `${item.what}. ${item.why}`, job.id, task.id)
        if (guard.flagged.includes("sensitive") && !job.flags?.localOnly && !this.#d.cloudOnly) {
          job.flags = { ...job.flags, localOnly: true }
          this.#say(`a follow-up of ${task.id} looks sensitive: the rest of the job stays on this machine`)
        }
        if (guard.flagged.some((g) => g === "injection" || g === "harmful")) reason = "flagged"
        else if (job.tasks.filter((t) => t.origin === "discovered").length >= discoveredCap(job)) reason = "cap"
      }
      if (v.kind === "task" && !reason) {
        const added = addDiscovered(job, task, item, v.priority)
        if (added.task) {
          this.#journal({ kind: "discovered", job: job.id, task: added.task.id, from: task.id, what: item.what, priority: v.priority, decision: asked?.id })
          this.#say(`${added.task.id} added (found by ${task.id}, priority ${v.priority}): ${item.what}`, true)
          continue
        }
        job.lessons.push(`follow-up of ${task.id} not added: ${added.errors!.slice(0, 2).join("; ")}`)
        reason = "invalid"
      }
      job.later = [...(job.later ?? []), { ...item, from: task.id, reason: reason! }]
    }
    task.followUps = []
    saveJob(this.#d.project, job)
  }

  // The job is stalled: the planner rewrites the unfinished part; done tasks and their commits stay.
  async #replan(job: Job): Promise<void> {
    moveJob(job, "replan")
    job.counters.replans++
    const model = await this.#model(job, "plan", 0.7)
    this.#say(`replanning (${job.counters.replans} of ${job.budget.replansMax}) with ${model.id}`)
    const s = await this.#plannerSession(job, model.id)
    let answer = await this.#ask(s.id, `${HEADER} replanning job ${job.id}\n\nThe user's job: ${job.goal}\n\n${replanFormat(job)}`)
    let r: Parsed = answer.stopped || answer.timedOut ? { errors: ["the planner stopped"] } : applyReplan(job, answer.text)
    if (r.errors && !answer.stopped && !answer.timedOut) {
      answer = await this.#ask(s.id, `${HEADER} The plan has these problems:\n- ${r.errors.join("\n- ")}\n\nAnswer again with the corrected JSON only.`)
      r = answer.stopped || answer.timedOut ? { errors: ["the planner stopped"] } : applyReplan(job, answer.text)
    }
    if (r.errors) {
      moveJob(job, "execute")
      return this.#stop(job, `the replan failed: ${r.errors.slice(0, 3).join("; ")}`)
    }
    const cut = job.tasks.filter((t) => !isDone(t) && t.status !== "cancelled")
    for (const t of cut) moveTask(t, "cancelled")
    const w = waves([...job.tasks.filter(isDone).map((t) => ({ ...t, dependsOn: t.dependsOn })), ...r.plan.tasks])
    job.acceptance = [...r.plan.acceptance]
    for (const t of r.plan.tasks) {
      job.tasks.push({
        id: t.id, title: t.title, description: t.description, role: t.role, acceptance: [...t.acceptance], dependsOn: [...t.dependsOn],
        files: [...t.files], wave: w.get(t.id) ?? 0, status: "pending", attempts: 0, stages: [], signatures: [],
        priority: t.priority ?? 3, origin: "replan",
      })
    }
    job.counters.stalls = 0
    job.lessons.push(`replanned: ${cut.map((t) => t.id).join(", ")} replaced by ${r.plan.tasks.map((t) => t.id).join(", ")}`)
    this.#journal({ kind: "replan", job: job.id, cancelled: cut.map((t) => t.id), added: r.plan.tasks.map((t) => t.id) })
    this.#say(`replanned: ${cut.map((t) => t.id).join(", ")} -> ${r.plan.tasks.map((t) => t.id).join(", ")}`)
    moveJob(job, "execute")
  }

  // N5 + N5b: one request classifies the task and sets its profile; the role may change to one that can do it.
  async #classify(job: Job, task: Task): Promise<Profile> {
    const policies = this.#policies(job, task.id)
    const acceptance = taskAcceptance(job, task)
    const skip = resolvePolicy("N5", policies).policy.kind === "rule"
    const memory = readMemory(this.#d.project)
    const asked = skip ? undefined : await this.#decider.ask("N5", { ...classifyState(job.goal, task, acceptance), ...(memory.length ? { projectMemory: memory.slice(-RECALL_MAX) } : {}) }, classifyQuestions(task, this.#d.skills ?? [], memory), { localOnly: job.flags?.localOnly, job: job.id, task: task.id })
    const profile = combine(task, acceptance, asked, policies, this.#d.skills ?? [], memory)
    if (profile.role !== task.role) this.#say(`${task.id}: role ${task.role} -> ${profile.role} (${profile.roleReason})`)
    task.role = profile.role
    task.profile = profile
    stage(task, "classify", "pass", profileText(profile))
    saveJob(this.#d.project, job)
    return profile
  }

  // Worker turns until the task's checks pass: the watchdog's stops, the report, the gate, at most fixRounds fixes,
  // then the N9 ladder. Returns undefined when the task went to the user or was given up (escalated or blocked).
  async #untilGreen(job: Job, task: Task, work: Work, checks: readonly string[], frozen: ReadonlyMap<string, string>): Promise<Work | undefined> {
    const worktree = this.#worktree(job, task) // git work
    const dir = this.#dir(job, task) // the checks name the worker's own paths
    let lastDiff: string | undefined
    let lastFailure: string | undefined
    for (;;) {
      const answer = work.answer
      if (answer.stopped?.kind === "handback") {
        // A checkpoint found the task itself unclear or blocked: no fresh try, the micromanager rethinks it.
        stage(task, "implement", "fail", answer.stopped.detail)
        await this.#escalate(job, task, answer.stopped.detail, "", "spec_ambiguous")
        return undefined
      }
      if (answer.stopped) {
        // The watchdog stopped it: never resume that session.
        stage(task, "implement", "fail", `loop watchdog: ${answer.stopped.detail}`)
        const next = await this.#nextRung(job, task, work, frozen, `stopped by the loop watchdog: ${answer.stopped.detail}`, handoffNote(answer.stopped, []).split("\n").at(-1)!)
        if (!next) return undefined
        ;[work, lastDiff, lastFailure] = [next, undefined, undefined]
        continue
      }
      if (!answer.timedOut && refused(answer.text)) {
        // worker_refused: a safety-tuned model said no. Never for a job the gate flagged as possibly harmful; else one
        // fresh session on a local uncensored model (design.md §10.2, §21).
        stage(task, "implement", "fail", `worker_refused: ${answer.text.slice(0, 200)}`)
        this.#journal({ kind: "watchdog", job: job.id, task: task.id, signal: "worker_refused", model: work.model.id })
        const harmful = job.flags?.gate?.flagged.includes("harmful")
        if (harmful || work.uncensored) {
          await this.#escalate(job, task, harmful ? "the model refused, and the gate flagged the job as possibly harmful" : "even a local uncensored model refused", answer.text.slice(-1500), "refused")
          return undefined
        }
        const next = await this.#nextRung(job, task, { ...work, fresh: false }, frozen, "the model refused the task", "", "too_hard", true)
        if (!next) return undefined
        ;[work, lastDiff, lastFailure] = [next, undefined, undefined]
        continue
      }
      const report = parseReport(answer.text)
      collectFollowUps(task, report.followUps)
      for (const l of report.learned) if (!(task.learned ?? []).includes(l)) task.learned = [...(task.learned ?? []), l]
      stage(task, "implement", answer.timedOut ? "fail" : "pass", answer.timedOut ? "timed out" : `status ${report.status ?? "missing"}`)
      if (answer.timedOut) {
        const next = await this.#nextRung(job, task, work, frozen, "the worker timed out", "")
        if (!next) return undefined
        ;[work, lastDiff, lastFailure] = [next, undefined, undefined]
        continue
      }
      if (report.status === "BLOCKED" || report.status === "NEEDS_CONTEXT") {
        moveTask(task, "blocked")
        task.summary = report.open || report.text.slice(-500)
        this.#stop(job, `${task.id} needs the user: ${task.summary}`, task)
        return undefined
      }
      moveTask(task, "gating")
      const results = [...(await runGate(worktree, checks, this.#exec, undefined, dir, { cancelled: () => Boolean(this.#d.cancelled?.()) })), ...(await frozenCheck(worktree, frozen, this.#exec))]
      const failed = results.filter((r) => !r.passed)
      const changed = await changedFiles(worktree, this.#exec, task.worktreeRel ?? job.integrationRel ?? "")
      const outside = task.files.length ? changed.filter((f) => !task.files.includes(f) && !frozen.has(f)) : changed
      stage(task, "gate", failed.length ? "fail" : "pass", results.length ? results.map((r) => `${r.command}: exit ${r.code}`).join("; ") : "no checks defined")
      saveNote(this.#d.project, job.id, task.id, noteText(task, report.text, results, outside))
      if (failed.length === 0) {
        // A gate that only reads exits 0 on an untouched tree, so passing it proves nothing: a worker that wrote
        // nothing, or died before writing, would otherwise merge as a success (live test, 2026-10-06). Reported apart
        // from a failing check, because the fix is different -- a passing check set and no diff means the task was
        // never done, not that it is broken.
        if (!changed.length) {
          moveTask(task, "blocked")
          task.summary = "its checks passed but it changed no file, so nothing was verified. Ask the worker what it did, or give the task checks that can fail on an unchanged tree."
          this.#stop(job, `${task.id} finished without changing anything: ${task.summary}`, task)
          return undefined
        }
        return work
      }
      // N8: the same diff as the last round (the worker changed nothing) is a loop; the same failure is one when the
      // decision model says so, or without one. A loop skips the remaining fix rounds.
      const diff = createHash("sha1").update(await workingDiff(worktree, this.#exec)).digest("hex").slice(0, 12)
      // The directory the checks ran in travels with the failure: a check naming a file of the project says "No such
      // file or directory" without it, and the worker has no way to tell which tree it was run against.
      const failure = failed.map((f) => `$ ${f.command} (exit ${f.code}) [in ${dir}]\n${f.output.slice(-1500)}`).join("\n\n")
      const loop = diff === lastDiff || (failure === lastFailure && (await this.#inLoop(job, task, lastFailure, failure)))
      task.signatures.push(`diff:${diff}`)
      ;[lastDiff, lastFailure] = [diff, failure]
      task.attempts++
      if (loop || task.attempts > (this.#d.fixRounds ?? FIX_ROUNDS)) {
        const why = loop ? `it kept failing the same way: ${failed.map((f) => f.command).join(", ")}` : `checks still fail after ${task.attempts - 1} fix round(s): ${failed.map((f) => f.command).join(", ")}`
        const next = await this.#nextRung(job, task, work, frozen, why, failure)
        if (!next) return undefined
        ;[work, lastDiff, lastFailure] = [next, undefined, undefined]
        continue
      }
      moveTask(task, "fixing")
      this.#say(`${task.id}: ${failed.length} check(s) failed, fix round ${task.attempts}`)
      moveTask(task, "running")
      // fixPrompt is brief.ts's, and it takes the failures as they are; the directory goes in as part of the output.
      work.answer = await this.#ask(work.s.id, fixPrompt(failed.map((f) => ({ ...f, output: `checked in ${dir}\n${f.output}` }))))
    }
  }

  // N8 with the decision model: is a failure that came back unchanged a loop? Without an answer, yes.
  async #inLoop(job: Job, task: Task, before: string, now: string): Promise<boolean> {
    const asked = await this.#decider.ask("N8", { task: `${task.id} ${task.title}`, previous: before.slice(-1500), now: now.slice(-1500) }, PROGRESS, { localOnly: job.flags?.localOnly, job: job.id, task: task.id })
    const a = asked.decision.answers.in_loop
    return a?.type === "noul" ? a.noul >= NOUL_FLOOR : true
  }

  // N9 (design.md §10.2): rung 1 is the fix rounds in the same session; rung 2 a fresh session on another model family
  // with a handoff note; rung 3 the escalation. A budget that is used up skips rung 2.
  async #nextRung(job: Job, task: Task, work: Work, frozen: ReadonlyMap<string, string>, reason: string, details: string, hint: EscalationKind = "too_hard", uncensored = work.uncensored ?? false): Promise<Work | undefined> {
    const over = this.#overBudget(job)
    if (work.fresh || over) {
      await this.#escalate(job, task, over ?? reason, details, over ? "budget" : hint)
      return undefined
    }
    const model = await this.#model(job, task.role, task.profile?.difficulty ?? 0.5, task.id, [this.#family(work.model.id)], task.profile?.vision, uncensored)
    if (uncensored && !model.routed) {
      await this.#escalate(job, task, `${reason}, and no local uncensored model is available`, details, "refused")
      return undefined
    }
    task.model = model.id
    toRunning(task)
    task.attempts = 0
    stage(task, "escalate", "skip", `rung 2: fresh session on ${model.id} after: ${reason}`)
    this.#say(`${task.id}: ${reason}; fresh session on ${model.id}`)
    const s = await this.#workerSession(job, task, model.id)
    const text = [
      brief(job, task, model.id, this.#dir(job, task), this.#skills("implement", task)),
      frozen.size ? greenNote([...frozen.keys()]) : "",
      handoffText(reason, details, await changedFiles(this.#worktree(job, task), this.#exec)),
    ].filter(Boolean).join("\n\n")
    return { s, model, answer: await this.#ask(s.id, text), fresh: true, uncensored }
  }

  // P3's red stage: a test worker writes the tests first, and they must fail before anything is built. Returns the
  // frozen test files with their hashes (empty: no red could be shown, the task goes on as P2), or undefined when
  // the task went to the user.
  async #red(job: Job, task: Task, checks: readonly string[]): Promise<Map<string, string> | undefined> {
    const worktree = this.#worktree(job, task)
    const dir = this.#dir(job, task)
    const model = await this.#model(job, "test", task.profile?.difficulty ?? 0.5, task.id)
    const s = await this.#workerSession(job, task, model.id, "test")
    const testFiles = task.files.filter((f) => TEST_FILE.test(f))
    const answer = await this.#ask(s.id, `${brief(job, task, model.id, dir, this.#skills("red", task))}\n\n${redPrompt(task, testFiles)}`)
    if (answer.stopped || answer.timedOut) {
      stage(task, "red", "fail", answer.stopped ? `loop watchdog: ${answer.stopped.detail}` : "timed out")
      await this.#escalate(job, task, `the tests-first worker ${answer.stopped ? "was stopped by the loop watchdog" : "timed out"}`)
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
    const results = await runGate(worktree, checks, this.#exec, undefined, dir)
    if (results.every((r) => r.passed)) {
      stage(task, "red", "skip", "the new tests pass before the change, so they do not show the missing behaviour")
      this.#say(`${task.id}: the tests pass before the change; not frozen, going on as P2`)
      return new Map()
    }
    stage(task, "red", "pass", `${tests.join(", ")} fail before the change: ${results.filter((r) => !r.passed).map((r) => r.command).join(", ")}`)
    return hashFiles(worktree, tests, this.#exec)
  }

  // Two reviewers of other model families read the change in parallel (P2, P3; design.md §9): one against the
  // acceptance points, one against the repository's standards. Only findings with evidence and confidence block; what
  // they saw outside the task becomes a follow-up. A reviewer whose answer is not JSON after one reminder blocks
  // nothing.
  async #review(job: Job, task: Task, workerModel: string): Promise<Review> {
    const diff = await workingDiff(this.#worktree(job, task), this.#exec)
    const worker = this.#family(workerModel)
    const specModel = await this.#model(job, "review", task.profile?.difficulty ?? 0.5, task.id, [worker], task.profile?.vision)
    const standardsModel = await this.#model(job, "review", task.profile?.difficulty ?? 0.5, task.id, [worker, this.#family(specModel.id)], task.profile?.vision)
    const skills = skillLine(this.#skills("review", task))
    const one = async (axis: ReviewAxis, first: string, prompt: string): Promise<Review> => {
      let model = first
      let s = await this.#workerSession(job, task, model, "review", TIER_STEPS.S)
      let answer = await this.#ask(s.id, [prompt, skills].filter(Boolean).join("\n\n"))
      if (answer.stopped?.kind === "stalled") {
        // The model stopped answering: once more on another family, so a hanging provider does not skip the review.
        model = (await this.#model(job, "review", task.profile?.difficulty ?? 0.5, task.id, [worker, this.#family(model)], task.profile?.vision)).id
        this.#say(`${task.id}: the ${axis} reviewer stalled; again on ${model}`)
        s = await this.#workerSession(job, task, model, "review", TIER_STEPS.S)
        answer = await this.#ask(s.id, [prompt, skills].filter(Boolean).join("\n\n"))
      }
      const confidence = axis === "spec" ? 100 : 0
      let review: Review = answer.stopped || answer.timedOut ? { checks: [], fixes: [], blocking: [], outside: [], error: answer.stopped ? `${axis} reviewer stopped: ${answer.stopped.detail}` : `${axis} reviewer timed out` } : parseReview(answer.text, confidence)
      if (review.error && !answer.stopped && !answer.timedOut) {
        answer = await this.#ask(s.id, `${HEADER} Answer again with the JSON only.`)
        review = parseReview(answer.text, confidence)
      }
      saveNote(this.#d.project, job.id, `${task.id}.review-${axis}`, `# ${axis} review of ${task.id} by ${model}\n\n${answer.text}\n`)
      return review
    }
    const spec = () => one("spec", specModel.id, reviewPrompt(job, task, taskAcceptance(job, task), diff))
    const standards = () => one("standards", standardsModel.id, standardsPrompt(job, task, diff))
    // omo-hybrid: the standards axis only for data or security risk, or when the config asks for it.
    const both = riskAtLeast(task.profile?.risk ?? "internal", "data_security") || resolvePolicy("N6.standards", this.#policies(job, task.id)).level !== undefined
    const none: Review = { checks: [], fixes: [], blocking: [], outside: [] }
    // A local device serves one model at a time, so local reviewers take turns (like P9 readers).
    const local = [specModel, standardsModel].every((m) => this.#d.registry.find((e) => e.id === m.id)?.location === "local")
    const [a, b] = !both ? [await spec(), none] : local ? [await spec(), await standards()] : await Promise.all([spec(), standards()])
    const merged = mergeReviews(a, b)
    collectFollowUps(task, merged.outside)
    const advisory = merged.checks.filter((c) => !c.met && !merged.blocking.includes(c))
    if (advisory.length) stage(task, "review_notes", "skip", advisory.map((c) => `${c.point} (${c.confidence}): ${c.evidence}`).join("; ").slice(0, 500))
    return merged
  }

  // P9: parallel readers, one synthesis written to docs/research/, and a citation check by code.
  async #research(job: Job, task: Task, model: string): Promise<void> {
    const worktree = this.#worktree(job, task)
    const dir = this.#dir(job, task)
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
    const answered = readers.filter((r) => !r.stopped && !r.timedOut && r.text).map((r) => r.text)
    readers.forEach((r, i) => saveNote(this.#d.project, job.id, `${task.id}.reader${i + 1}`, r.text || "(no answer)"))
    // Readers quote the web; a note that carries an injection never reaches the synthesis (E2b).
    const notes: string[] = []
    for (const note of answered) {
      const score = await injectionScore(this.#decider, note, job.id, task.id)
      if (!injected(score)) notes.push(note)
      else {
        this.#journal({ kind: "guard", job: job.id, task: task.id, guard: "injection", score, action: "reader note dropped" })
        job.lessons.push(`${task.id}: a research note was dropped, it looked like a prompt injection (${score!.toFixed(2)})`)
      }
    }
    stage(task, "readers", notes.length ? "pass" : "fail", `${notes.length} of ${n} readers answered`)
    if (notes.length === 0) return await this.#escalate(job, task, "no research reader came back with findings")
    const path = researchPath(task)
    const writerModel = await this.#model(job, "write", task.profile?.difficulty ?? 0.5, task.id)
    const s = await this.#workerSession(job, task, writerModel.id, "write")
    let answer = await this.#ask(s.id, synthesisPrompt(job, task, path, notes))
    for (let round = 0; ; round++) {
      if (answer.stopped || answer.timedOut) return await this.#escalate(job, task, `the synthesis ${answer.stopped ? "was stopped by the loop watchdog" : "timed out"}`)
      let doc = ""
      try {
        doc = readFileSync(join(dir, path), "utf8") // the writer worked in the project directory, so the doc is there
      } catch {
        // checked below: no file means no citations
      }
      const check = citationCheck(doc, notes)
      stage(task, "citations", check.ok ? "pass" : "fail", doc ? `${check.cited} cited${check.unknown.length ? `, not from a reader: ${check.unknown.join(" ")}` : ""}` : `${path} was not written`)
      if (check.ok) break
      if (round >= 1) return await this.#escalate(job, task, `the research synthesis fails the citation check: ${doc ? (check.unknown.length ? `${check.unknown.length} URL(s) not from a reader` : "no citations") : `${path} missing`}`)
      answer = await this.#ask(s.id, `${HEADER} ${doc ? (check.unknown.length ? `These URLs are not in any reader's notes: ${check.unknown.join(" ")}. Remove them or the claims they support.` : "The document cites nothing. Cite every claim with a URL from the readers' notes.") : `Write ${path} as asked.`}`)
    }
    moveTask(task, "gating")
    const checks = [...new Set(taskAcceptance(job, task).map((a) => a.verify).filter((v): v is string => Boolean(v)))]
    const failed = (await runGate(worktree, checks, this.#exec, undefined, dir)).filter((r) => !r.passed)
    if (failed.length) return await this.#escalate(job, task, `checks fail after the research (in ${dir}): ${failed.map((f) => f.command).join(", ")}`)
    moveTask(task, "passed")
    task.summary = `research written to ${path}`
    const commit = await commitTask(worktree, `${task.id}: ${task.title}`, `Job: ${job.id}\nResearch: ${n} reader(s) on ${model}, synthesis by ${writerModel.id}, pipeline P9`, this.#exec)
    moveTask(task, "merged")
    this.#say(`${task.id} researched${commit ? ` (${commit})` : ""}: ${path}`, true)
  }

  // The git worktree root of a task: its own in a parallel batch, else the job's. Git commands run here; a worktree is
  // always a checkout of the repository root, whatever the project is.
  #worktree(job: Job, task: Task): string {
    return task.worktree ?? job.integrationWorktree!
  }

  // Where a task works: the worktree root plus the project's offset inside it, because the worker's paths, its tools and
  // its checks are all relative to the project directory, not to the repository root.
  #dir(job: Job, task: Task): string {
    return taskDir(this.#worktree(job, task), task.worktreeRel ?? job.integrationRel ?? "")
  }

  #skills(stage: Stage, task: Task): string[] {
    return skillsFor(stage, task.profile, task.pipeline, this.#d.installedSkills ?? new Set())
  }

  // OpenCode 2.0.18's plugin session.create drops parentID, so these sessions are not children of the micromanager in
  // OpenCode's eyes. The metadata names it instead, for the clients that list sessions: oc-voice treats a session with
  // a parent there as a sub-agent and does not announce it as one of the user's own.
  #origin(job: Job, task?: Task): Record<string, unknown> {
    return this.#d.parentID ? { metadata: { micromanager: { parent: this.#d.parentID, job: job.id, ...(task ? { task: task.id } : {}) } } } : {}
  }

  async #plannerSession(job: Job, model: string): Promise<{ id: string }> {
    const s = await this.#d.session.create({
      ...(this.#d.parentID ? { parentID: this.#d.parentID } : {}),
      title: `plan ${job.id}`,
      agent: roleById("plan")!.agent,
      model: toModel(model),
      location: { directory: this.#d.project },
      ...this.#origin(job),
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
      title: `${task.id} · ${roleById(role)?.agent ?? role} · ${task.title}`,
      agent: roleById(role)?.agent ?? "coder",
      model: toModel(model),
      location: { directory: this.#dir(job, task) },
      ...(rules.length ? { permissions: rules } : {}),
      ...this.#origin(job, task),
    })
    task.session = s.id
    task.sessions = [...(task.sessions ?? []), s.id]
    this.#sessionModel.set(s.id, model)
    this.#d.onWorker?.(s.id, `${task.id} ${task.title}: ${task.description}`, rules)
    this.#d.watch?.(s.id, steps ?? MAX_STEPS)
    saveJob(this.#d.project, job)
    return s
  }


  // N9 rung 3: the task stops, with a typed reason. A task that is too hard as planned does not stop the job: other
  // tasks go on and the job replans around it (stalls, design.md §10.2). Everything else needs the user.
  async #escalate(job: Job, task: Task, reason: string, details = "", hint: EscalationKind = "too_hard"): Promise<void> {
    let kind = hint
    let decision: string | undefined
    // N9 is opt-in ("N9": "auto"): the call site's reason type is good enough by default (omo-hybrid).
    const n9 = resolvePolicy("N9", this.#policies(job, task.id))
    if (hint !== "budget" && hint !== "refused" && n9.level !== undefined && n9.policy.kind === "auto") {
      const asked = await this.#decider.ask(
        "N9",
        { goal: job.goal, task: `${task.id} ${task.title}: ${task.description}`, acceptance: taskAcceptance(job, task).map((a) => a.text), reason, details: details.slice(-2000), stages: task.stages.slice(-6).map((s) => `${s.stage} ${s.result}${s.evidence ? `: ${s.evidence.slice(0, 200)}` : ""}`) },
        { reason: ESCALATE },
        { localOnly: job.flags?.localOnly, job: job.id, task: task.id },
      )
      decision = asked.id
      const c = asked.decision.answers.reason
      if (c?.type === "choice" && c.confidence >= CHOICE_FLOOR && c.choice in ESCALATION) kind = c.choice as EscalationKind
    }
    moveTask(task, "escalated")
    task.escalation = { kind, detail: reason }
    job.counters.stalls++
    this.#journal({ kind: "escalation", job: job.id, task: task.id, reason, type: kind, decision })
    if (kind === "too_hard") {
      job.lessons.push(`${task.id} given up as planned: ${reason}`)
      this.#say(`${task.id} given up as planned (${reason}); the job goes on and replans around it`, true)
      if (job.rolling) this.#d.taskEnded?.(job, task)
      return
    }
    this.#stop(job, `${task.id} (${kind.replace(/_/g, " ")}): ${reason}`, task)
  }

  async #verify(job: Job): Promise<void> {
    moveJob(job, "verify")
    const checks = [...new Set(job.acceptance.map((a) => a.verify).filter((v): v is string => Boolean(v)))]
    const results = await runGate(job.integrationWorktree!, checks, this.#exec, undefined, taskDir(job.integrationWorktree!, job.integrationRel ?? ""))
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
  // The planning session's decisions and anything else decided with the user (plan feedback included).
  const decided = [...(job.designTree ? decisionsText(job.designTree) : []), ...job.decisions.map((d) => d.text)]
  return `${HEADER} planning job ${job.id}

The user's job: ${job.goal}
${decided.length ? `\nDecided with the user (follow these; for assumed points, decide and say what you chose). Every decision must show up in
the plan's tasks and acceptance points; a large job gets as many tasks as it needs:\n- ${decided.join("\n- ")}\n` : ""}
Read as much of the project as you need (read, glob, grep); change nothing.
Verify commands run from the project root in a fresh checkout of the current commit; use only commands that
work there, such as the project's own test script.

${PLAN_FORMAT}`
}

// Back to running from wherever a task's last stage left it, for a fresh session (N9 rung 2).
function toRunning(task: Task): void {
  if (task.status === "gating" || task.status === "reviewing") moveTask(task, "fixing")
  if (task.status !== "running") moveTask(task, "running")
}

// A worker's follow-ups over all its reports in this task, without repeats.
function collectFollowUps(task: Task, items: readonly FollowUp[]): void {
  if (items.length === 0) return
  const seen = new Set((task.followUps ?? []).map((f) => f.what.toLowerCase()))
  task.followUps = [...(task.followUps ?? []), ...items.filter((f) => !seen.has(f.what.toLowerCase()))]
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

// What the orchestrator learns when a delegated task ends (omo-hybrid): status and why, the worker's report, the
// checks, and its follow-ups with a hint when another task already covers their files.
export function taskReport(job: Job, task: Task): string {
  const open = new Set(job.tasks.filter((t) => t.id !== task.id && !isDone(t) && t.status !== "cancelled").flatMap((t) => t.files))
  const gate = [...task.stages].reverse().find((s) => s.stage === "gate")
  const follow = (task.followUps ?? []).map((f) => `  - ${f.what}${f.why ? ` (${f.why})` : ""}${f.files.length ? ` · files: ${f.files.join(", ")}` : ""}${f.files.length && f.files.every((x) => open.has(x)) ? " · another open task has these files" : ""}`)
  const status = task.status === "merged" ? `merged into ${job.integrationBranch}` : task.status === "escalated" ? `given up (${task.escalation?.kind?.replace(/_/g, " ")}): ${task.escalation?.detail}` : task.status === "blocked" ? `waits for the user: ${task.summary}` : task.status
  return [
    `${task.id} ${task.title}: ${status}`,
    task.model ? `  ${task.role} on ${task.model}, ${task.pipeline ?? "P1"}` : "",
    gate ? `  checks: ${gate.evidence}` : "",
    task.status === "merged" && task.summary ? `  report: ${task.summary.replace(/\s+/g, " ").slice(-400)}` : "",
    follow.length ? `  follow-ups the worker found (yours to decide):\n${follow.join("\n")}` : "",
    task.sessions?.length ? `  sessions: ${task.sessions.join(", ")} (open one with: opencode -s <id>)` : "",
    `  notes: notes/${job.id}/${task.id}.md in the project's .micromanager directory`,
  ].filter(Boolean).join("\n")
}

export function summary(job: Job): string {
  const lines = job.tasks.map((t) => `- ${t.id} ${t.title}: ${t.status}${t.model ? ` (${t.role} on ${t.model}${t.pipeline ? `, ${t.pipeline}` : ""})` : ""}`)
  const head = `job ${job.id}: ${job.phase}${job.resumePhase ? ` (from ${job.resumePhase})` : ""}`
  const branch = job.integrationBranch
    ? `\nbranch ${job.integrationBranch} in ${job.integrationWorktree}\nmerge: git merge ${job.integrationBranch} · discard: git worktree remove --force ${job.integrationWorktree} && git branch -D ${job.integrationBranch}`
    : ""
  const why = job.phase === "ask_user" && job.lessons.length ? `\nwhy: ${job.lessons[job.lessons.length - 1]}` : ""
  const later = job.later?.length ? `\nfound but not done (for the user to decide):\n${job.later.map((l) => `- ${l.what} (from ${l.from}, ${l.reason.replace(/_/g, " ")})`).join("\n")}` : ""
  return `${head}\n${lines.join("\n")}${branch}${why}${later}`
}

// The instruction to draft the design tree; the format is the one parseTree reads.
export function draftInstruction(job: Job): string {
  return `[planning session ${job.id}] Before planning, the user's open decisions are settled in a planning session.
Draft the design questions this job leaves open and send them with plan_questions (job "${job.id}", tree as a
JSON list): [{ "id": "D1", "question": "...", "kind": "decision" | "fact" | "assumption", "dependsOn": [], "impact":
"low" | "medium" | "high" }]. Decisions are what only the user can decide (behaviour, scope, interfaces, trade-offs);
facts are what agents can look up; at most 25. Write every question open: never list possible answers or examples
of answers in it. Do not ask the user anything in this turn, and do not call plan_job again.`
}

// The project's top-level entries, as cheap context for triage.
function topLevel(project: string): string[] {
  try {
    return readdirSync(project).filter((f) => !f.startsWith(".")).slice(0, 40)
  } catch {
    return []
  }
}

// A goal the same session failed to plan a short while ago: the micromanager reports that instead of starting the
// same job again (live test: a looping local planner made it restart three times). "retry: <goal>" overrides.
export function recentFailure(job: Job | undefined, goal: string, now = Date.now(), windowMs = 30 * 60_000): string | undefined {
  if (!job || job.phase !== "failed" || /^retry:/i.test(goal.trim())) return undefined
  const same = job.goal.trim().toLowerCase() === goal.trim().toLowerCase()
  if (!same || now - Date.parse(job.updated) > windowMs) return undefined
  const why = job.lessons.at(-1) ?? "unknown reason"
  return `Job ${job.id} with this goal failed ${Math.round((now - Date.parse(job.updated)) / 60_000)} min ago (${why}). Tell the user and do not start it again by yourself; if the user wants another try, call plan_job with goal "retry: <goal>".`
}
