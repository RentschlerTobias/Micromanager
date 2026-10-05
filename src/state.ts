// The job state: one job, its tasks, and the two state machines that move them (design.md §4, §5).
//
// Code owns every transition. An illegal jump throws, so a bug shows up at once instead of as a stuck job.
// The tables follow the jev-tutor engine's ALLOWED pattern.

import type { JobFlags } from "./gate.ts"
import type { PolicySet } from "./policy.ts"
import type { Profile } from "./profile.ts"
import type { DesignTree } from "./session.ts"

export type JobPhase =
  | "intake"
  | "triage"
  | "clarity"
  | "planning_session"
  | "design_checkpoint"
  | "plan"
  | "plan_gate"
  | "execute"
  | "replan"
  | "verify"
  | "integrate"
  | "wrap"
  | "done"
  | "paused"
  | "stopped"
  | "failed"
  | "ask_user"

export type TaskStatus =
  | "pending"
  | "ready"
  | "planned"
  | "running"
  | "gating"
  | "reviewing"
  | "fixing"
  | "escalated"
  | "passed"
  | "merged"
  | "blocked"
  | "cancelled"

export class StateError extends Error {}

// Reachable from every phase: the user can always pause or stop, a job can always fail or ask the user.
const JOB_ANYWHERE: readonly JobPhase[] = ["paused", "stopped", "failed", "ask_user"]

const JOB_ALLOWED: Record<JobPhase, readonly JobPhase[]> = {
  intake: ["triage"],
  triage: ["clarity", "plan"],
  clarity: ["planning_session", "plan"],
  planning_session: ["design_checkpoint"],
  design_checkpoint: ["plan", "planning_session"],
  plan: ["plan_gate"],
  plan_gate: ["execute", "plan"],
  execute: ["replan", "verify"],
  replan: ["plan_gate", "execute"],
  verify: ["integrate", "execute"],
  integrate: ["wrap"],
  wrap: ["done"],
  done: [],
  paused: [], // resumes to the phase it was paused in (resumePhase)
  stopped: [],
  failed: [],
  ask_user: [], // returns to the phase that asked (resumePhase)
}

// Reachable from every live task: a worker can always block on a question, a task can always be cancelled.
const TASK_ANYWHERE: readonly TaskStatus[] = ["blocked", "cancelled"]

const TASK_ALLOWED: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["ready"],
  ready: ["planned", "pending"],
  planned: ["running"],
  running: ["gating", "escalated"],
  gating: ["reviewing", "passed", "fixing", "escalated"],
  reviewing: ["passed", "fixing", "escalated"],
  fixing: ["running", "escalated"],
  escalated: ["running", "pending"],
  passed: ["merged"],
  merged: [],
  blocked: ["running", "planned"],
  cancelled: [],
}

const TASK_FINAL = new Set<TaskStatus>(["merged", "cancelled"])

export interface Acceptance {
  readonly id: string
  readonly text: string
  readonly verify?: string // a shell command whose exit code 0 means the point is met
}

export interface Stage {
  readonly stage: string // "implement", "gate", "review", …
  readonly result: "pass" | "fail" | "skip" | "running"
  readonly evidence?: string
  readonly at: string
}

// Where a task came from: the plan, an N4 split, a worker's follow-up (N7), or a replan.
export type TaskOrigin = "plan" | "split" | "discovered" | "replan"

// Work a worker found outside its own task (its report's FOLLOWUP lines).
export interface FollowUp {
  readonly what: string
  readonly why: string
  readonly files: readonly string[]
}

// A follow-up that did not become a task: shown to the user at the end of the job.
export interface Later extends FollowUp {
  readonly from: string // the task that found it
  readonly reason: "out_of_scope" | "user_should_decide" | "cap" | "no_files" | "invalid" | "flagged"
}

export interface Task {
  readonly id: string
  title: string
  description: string
  role: string
  acceptance: string[] // ids of the job's acceptance points
  dependsOn: string[]
  files: string[] // the declared write scope
  wave: number
  parent?: string
  status: TaskStatus
  model?: string
  session?: string
  attempts: number
  stages: Stage[]
  signatures: string[] // hashes for stall detection
  summary?: string
  profile?: Profile // N5 + N5b, set when the task is first dispatched
  pipeline?: string // N6: P1, P2, P3 or P9
  confirmed?: boolean // false: waits for the user's go (destructive risk, or "ask me about everything")
  priority?: number // 1 (first) .. 5 (last); 3 when the planner gave none
  origin?: TaskOrigin
  followUps?: FollowUp[] // what the task's worker reported as work outside its task
  escalation?: { kind: string; detail: string } // why the task stopped (N9 rung 3)
}

export interface Job {
  readonly id: string
  goal: string
  phase: JobPhase
  resumePhase?: JobPhase
  acceptance: Acceptance[]
  decisions: { id: string; text: string; origin: "user" | "proposed_and_confirmed" | "fact" }[]
  tasks: Task[]
  integrationBranch?: string
  integrationWorktree?: string
  flags?: JobFlags // set by the G0 gate and the user's answer to it
  triage?: { complexity?: number; clarification?: number; session: boolean; reason: string }
  designTree?: DesignTree // the planning session
  facilitator?: string // the dictator session that runs this job's planning session
  pins?: PolicySet // job-level policies from the user's shortcuts ("always local", "pipeline P1", …)
  taskPins?: Record<string, PolicySet> // task-level ones ("T3 use llamaswap/oss-u")
  budget: {
    workersMax: number
    workersUsed: number
    turnsMax: number
    replansMax: number
    discoveredMax?: number
    tokensMax?: number // input + output tokens over every session of the job
    requestsMax?: number // provider turns over every session of the job
    costMax?: number // in the providers' currency, when they report a cost
  }
  counters: { turns: number; stalls: number; replans: number; tokens?: number; requests?: number; cost?: number }
  lessons: string[]
  later?: Later[] // follow-ups that did not become tasks
  created: string
  updated: string
}

export function canMoveJob(from: JobPhase, to: JobPhase): boolean {
  if (from === to) return true
  if (from === "done" || from === "stopped" || from === "failed") return false
  return JOB_ANYWHERE.includes(to) || JOB_ALLOWED[from].includes(to)
}

export function moveJob(job: Job, to: JobPhase, now = new Date()): void {
  // paused and ask_user hand back to the phase they interrupted
  if ((job.phase === "paused" || job.phase === "ask_user") && to === job.resumePhase) {
    job.phase = to
    job.resumePhase = undefined
  } else {
    if (!canMoveJob(job.phase, to)) throw new StateError(`job ${job.id}: illegal move ${job.phase} -> ${to}`)
    if (to === "paused" || to === "ask_user") job.resumePhase = job.phase
    job.phase = to
  }
  job.updated = now.toISOString()
}

export function canMoveTask(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true
  if (TASK_FINAL.has(from)) return false
  return TASK_ANYWHERE.includes(to) || TASK_ALLOWED[from].includes(to)
}

export function moveTask(task: Task, to: TaskStatus): void {
  if (!canMoveTask(task.status, to)) throw new StateError(`task ${task.id}: illegal move ${task.status} -> ${to}`)
  task.status = to
}

const DONE = new Set<TaskStatus>(["passed", "merged"])

export function isDone(task: Task): boolean {
  return DONE.has(task.status)
}

// Pending tasks whose dependencies all passed; derived, never stored as a decision.
export function readyTasks(job: Job): Task[] {
  const byId = new Map(job.tasks.map((t) => [t.id, t]))
  return job.tasks.filter(
    (t) => (t.status === "pending" || t.status === "ready") && t.dependsOn.every((d) => {
      const dep = byId.get(d)
      return dep !== undefined && isDone(dep)
    }),
  )
}

// Moves every pending task whose dependencies are done to ready; returns the ones it moved.
export function promoteReady(job: Job): Task[] {
  const moved = readyTasks(job).filter((t) => t.status === "pending")
  for (const task of moved) moveTask(task, "ready")
  return moved
}

// Two tasks may run at the same time when their declared write scopes do not overlap. A task without files
// writes nothing (a reader) and never conflicts.
export function parallelSafe(a: Task, b: Task): boolean {
  if (a.files.length === 0 || b.files.length === 0) return true
  const mine = new Set(a.files)
  return !b.files.some((f) => mine.has(f))
}

export const DEFAULT_PRIORITY = 3

// How many discovered tasks a job may add: half its planned tasks, at least 3.
export function discoveredCap(job: Job): number {
  return job.budget.discoveredMax ?? Math.max(3, Math.ceil(job.tasks.filter((t) => t.origin !== "discovered").length / 2))
}

export function allDone(job: Job): boolean {
  return job.tasks.length > 0 && job.tasks.every((t) => isDone(t) || t.status === "cancelled")
}

export function newJob(id: string, goal: string, now = new Date()): Job {
  const at = now.toISOString()
  return {
    id,
    goal,
    phase: "intake",
    acceptance: [],
    decisions: [],
    tasks: [],
    budget: { workersMax: 20, workersUsed: 0, turnsMax: 80, replansMax: 2 },
    counters: { turns: 0, stalls: 0, replans: 0 },
    lessons: [],
    created: at,
    updated: at,
  }
}

export function stage(task: Task, name: string, result: Stage["result"], evidence?: string, now = new Date()): void {
  task.stages.push({ stage: name, result, evidence, at: now.toISOString() })
}
