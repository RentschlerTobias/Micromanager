// The continuation of a planned job on native workers (run_job, omo-hybrid): which tasks the micromanager starts next.
//
// A planned job used to run on the runner, which made its worker sessions itself: they were not children of the
// micromanager (opencode 2.0.18 drops parentID on a plugin's session.create), so the user could not find them in the
// TUI (2026-10-19). Now the micromanager starts each planned task with the subagent tool, as it does its own tasks, and
// the code keeps the plan: after every worker's end it says which tasks are ready, until the job is done or stuck.
// That is the todo continuation of Sisyphus, driven by the job file rather than by the model's memory.

import { HEADER } from "./hooks.ts"
import { roleById } from "./roles.ts"
import { isDone, type Job, type Task } from "./state.ts"

const LIVE = new Set<Task["status"]>(["running", "gating", "fixing", "reviewing"])
const OPEN = new Set<Task["status"]>(["pending", "ready", "planned"])
const HALTED = new Set<Job["phase"]>(["paused", "stopped", "done", "failed"])

export type Step =
  | { readonly kind: "start"; readonly tasks: readonly Task[]; readonly text: string }
  | { readonly kind: "done"; readonly text: string }
  | { readonly kind: "stuck"; readonly text: string }

// The line of a subagent prompt that starts a planned task; native.ts parses it back (parseDelegation).
export const plannedLine = (task: string, job: string) => `Task: ${task} · ${job}`

// Whether a task's work is in: it is merged, or the task that does it over is (in this job, or in another one the
// caller can look up: "job-…/T17").
export function settled(job: Job, task: Task, resolve: (id: string) => Task["status"] | undefined = () => undefined): boolean {
  if (isDone(task)) return true
  if (!task.replacedBy) return false
  if (task.replacedBy.includes("/")) return ["merged", "passed"].includes(resolve(task.replacedBy) ?? "")
  const by = job.tasks.find((t) => t.id === task.replacedBy)
  return by !== undefined && by !== task && isDone(by)
}

// Open tasks whose dependencies are all merged (or done over), by priority, then in plan order.
export function startable(job: Job, resolve?: (id: string) => Task["status"] | undefined): Task[] {
  const byId = new Map(job.tasks.map((t) => [t.id, t]))
  return job.tasks
    .filter((t) => OPEN.has(t.status) && t.dependsOn.every((d) => { const dep = byId.get(d); return dep !== undefined && settled(job, dep, resolve) }))
    .sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3))
}

function call(job: Job, task: Task): string {
  const agent = roleById(task.role)?.agent ?? task.role
  return `- agent ${agent}, description "${task.id} ${task.title}", prompt "${plannedLine(task.id, job.id)}"`
}

// What the micromanager does next for a planned job on native workers, or for its session's own job when it wrote
// todos (the todo tool); undefined while workers run and nothing new can start, for a job the runner runs, and for a
// paused or stopped one. A session's own job only hears which todos can start: it is "done" whenever the micromanager
// has nothing more in mind, which is not news.
export function nextStep(job: Job, parallel: number): Step | undefined {
  if (!(job.native || job.rolling) || HALTED.has(job.phase)) return undefined
  const live = job.tasks.filter((t) => LIVE.has(t.status))
  const ready = startable(job).slice(0, Math.max(0, parallel - live.length))
  if (ready.length) {
    return {
      kind: "start",
      tasks: ready,
      text: [
        `${HEADER} job ${job.id}: start ${ready.length === 1 ? "this task" : "these tasks"} of your ${job.rolling ? "todo list" : "plan"} now, in one message, with the subagent tool (background = true):`,
        ...ready.map((t) => call(job, t)),
        `The plugin gives each worker its task, files, checks and acceptance points from the ${job.rolling ? "todo" : "plan"}; add to a prompt only what it does not say, below that line. Do not wait for them: the next tasks follow in a note like this one when they end.`,
        live.length ? `Still running: ${live.map((t) => t.id).join(", ")}.` : "",
      ].filter(Boolean).join("\n"),
    }
  }
  if (live.length || !job.native) return undefined
  // A cancelled task is out of the plan, unless an open task still needs it.
  const needed = new Set(job.tasks.filter((t) => OPEN.has(t.status)).flatMap((t) => t.dependsOn))
  const left = job.tasks.filter((t) => !isDone(t) && !t.undone && (t.status !== "cancelled" || needed.has(t.id)))
  if (!left.length) {
    const merged = job.tasks.filter((t) => isDone(t)).length
    return {
      kind: "done",
      text: `${HEADER} job ${job.id}: the plan is through, ${merged} of ${job.tasks.length} tasks merged on ${job.integrationBranch ?? `jev/${job.id}`}${merged < job.tasks.length ? " (the rest were cancelled)" : ""}. Tell the user briefly what changed; merge_job brings it into their checkout once they say so.`,
    }
  }
  const stopped = left.filter((t) => !OPEN.has(t.status))
  const waiting = left.filter((t) => OPEN.has(t.status))
  return {
    kind: "stuck",
    text: [
      `${HEADER} job ${job.id} cannot go on by itself:`,
      ...stopped.map((t) => `- ${t.id} ${t.title}: ${t.status}${t.escalation ? ` (${t.escalation.detail.slice(0, 200)})` : t.summary ? ` (${t.summary.slice(0, 200)})` : ""}${t.session ? `, session ${t.session}` : ""}`),
      waiting.length ? `Waiting on those: ${waiting.map((t) => `${t.id} (after ${t.dependsOn.join(", ")})`).join("; ")}.` : "",
      `For each stopped task: continue its worker with the subagent tool and its sessionID when its change is worth keeping, start it again with a prompt "${plannedLine("T…", job.id)}", or ask the user. A task that is not needed any more: stop_task.`,
    ].filter(Boolean).join("\n"),
  }
}
