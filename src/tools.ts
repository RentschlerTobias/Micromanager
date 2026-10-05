// The dictator's tools (Phase A, A3: custom tools work, with text content as their result). Only the dictator
// agent may use them; every other agent gets a refusal, and the context hook hides them from other agents.
// A role agent can still reach them through the code-mode execute tool; the nested call carries the caller's
// agent (Phase E spike), so the same check refuses it. A call without an agent is refused too.

import type { Job } from "./state.ts"

export const TOOL_IDS = ["dictator_task", "dictator_tasks", "dictator_answer", "dictator_plan", "dictator_questions", "dictator_run", "dictator_status", "dictator_stop"] as const

// What dictator_task takes; every field is a string, as the tool schema is built from read's path field.
export interface TaskInput {
  readonly title: string
  readonly prompt: string
  readonly files: string // comma separated
  readonly depends: string // task ids, comma separated
  readonly priority: string // 1..5, or empty
  readonly checks: string // shell commands, one per line
}

// The tool draft of ctx.tool.transform, as far as this file uses it.
export interface ToolDraft {
  get(id: string): { input?: { fields?: Record<string, unknown>; mapFields?: (f: () => Record<string, unknown>) => unknown } } | undefined
  add(tool: Record<string, unknown>): void
}

export interface ToolContext {
  readonly sessionID?: string
  readonly agent?: string
}

export interface Handlers {
  task(input: TaskInput, ctx: ToolContext): Promise<string>
  tasks(id: string, ctx: ToolContext): Promise<string>
  answer(task: string, text: string, ctx: ToolContext): Promise<string>
  plan(goal: string, ctx: ToolContext): Promise<string>
  questions(job: string, tree: string, ctx: ToolContext): Promise<string>
  run(job: string, note: string, ctx: ToolContext): Promise<string>
  status(job: string, ctx: ToolContext): Promise<string>
  stop(job: string, ctx: ToolContext): Promise<string>
}

export function installTools(draft: ToolDraft, handlers: Handlers, agent = "dictator", runnerSession: (id: string) => boolean = () => false): string[] {
  // A schema must come from the server's own Effect instance (Phase 0), so it is built from a built-in tool's.
  const read = draft.get("read")
  const str = read?.input?.fields?.path
  if (!read?.input?.mapFields || !str) throw new Error("the built-in read tool has no input schema to build from")
  const input = (...names: string[]) => read.input!.mapFields!(() => Object.fromEntries(names.map((n) => [n, str])))
  const guarded = (fn: (values: string[], ctx: ToolContext) => Promise<string>, ...names: string[]) =>
    async (args: Record<string, unknown>, ctx: ToolContext) => {
      if (ctx?.agent !== agent || (ctx.sessionID !== undefined && runnerSession(ctx.sessionID))) return { content: `Only the ${agent} agent may use this tool.` }
      try {
        return { content: await fn(names.map((n) => String(args?.[n] ?? "")), ctx ?? {}) }
      } catch (err) {
        return { content: `failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
  draft.add({
    id: "dictator_task",
    name: "dictator_task",
    description: "Delegate one task to a worker agent; it runs in the background on the session's own git branch, in parallel with other tasks that change other files, and this returns at once with its id. title: short; prompt: everything the worker needs, as it knows nothing else; files: the files it may change, comma separated (empty for research or reading); depends: ids of tasks it must wait for, comma separated; priority: 1 (first) to 5 (last), empty for 3; checks: shell commands only, one per line, that exit 0 when the task is done (e.g. npm test, or node --test test/x.test.js); never a sentence, the plugin runs them as they are. The plugin picks the role, model, skills and rights, runs the checks and merges. You get a report when it ends: do not wait or poll.",
    input: input("title", "prompt", "files", "depends", "priority", "checks"),
    execute: guarded(([title, prompt, files, depends, priority, checks], ctx) => handlers.task({ title: title!, prompt: prompt!, files: files!, depends: depends!, priority: priority!, checks: checks! }, ctx), "title", "prompt", "files", "depends", "priority", "checks"),
  })
  draft.add({
    id: "dictator_tasks",
    name: "dictator_tasks",
    description: "The tasks you delegated in this session with their status, or with a task id its full report (what the worker did, the checks, its follow-ups).",
    input: input("id"),
    execute: guarded(([id], ctx) => handlers.tasks(id!, ctx), "id"),
  })
  draft.add({
    id: "dictator_answer",
    name: "dictator_answer",
    description: "Give a task that waits for the user the user's answer or go, in their words; the task starts again with it.",
    input: input("task", "text"),
    execute: guarded(([task, text], ctx) => handlers.answer(task!, text!, ctx), "task", "text"),
  })
  draft.add({
    id: "dictator_plan",
    name: "dictator_plan",
    description: "For a large or unclear job only (most work goes through dictator_task): a planner reads the project and writes a full plan with acceptance points, which the user approves before dictator_run. With the user's goal: checks it and plans it, or opens a planning session when the user asked to plan it together. With a job id as goal: continues that job. When a plan waits for the user's go and they want changes, call it with their change request as goal: the planner writes the plan again with it. Changes nothing.",
    input: input("goal"),
    execute: guarded(([goal], ctx) => handlers.plan(goal!, ctx), "goal"),
  })
  draft.add({
    id: "dictator_questions",
    name: "dictator_questions",
    description: "Send the design questions of a planning session (or new ones found later) for a job: tree is a JSON list of { id, question, kind, dependsOn, impact }. Returns the one question to ask the user next.",
    input: input("job", "tree"),
    execute: guarded(([job, tree], ctx) => handlers.questions(job!, tree!, ctx), "job", "tree"),
  })
  draft.add({
    id: "dictator_run",
    name: "dictator_run",
    description: "Run a planned job after the user said go, or resume a stopped one. Takes the job id from dictator_plan; note is the user's answer when the job stopped for them (their words, or empty). The job is queued and runs in the background on its own git branch, independent tasks in parallel; this returns at once. Updates arrive later as [jev-dictator] notes: do not wait or poll, end your turn and keep talking with the user.",
    input: input("job", "note"),
    execute: guarded(([job, note], ctx) => handlers.run(job!, note!, ctx), "job", "note"),
  })
  draft.add({
    id: "dictator_status",
    name: "dictator_status",
    description: "Show the queue (running and waiting jobs) and a job's state: phase, tasks with status and priority, branch, and what was found but not done. An empty job id shows the newest job.",
    input: input("job"),
    execute: guarded(([job], ctx) => handlers.status(job!, ctx), "job"),
  })
  draft.add({
    id: "dictator_stop",
    name: "dictator_stop",
    description: "Stop a job when the user asks: the running worker is interrupted, and the job pauses; dictator_run resumes it later. A waiting job leaves the queue. An empty job id stops the running job.",
    input: input("job"),
    execute: guarded(([job], ctx) => handlers.stop(job!, ctx), "job"),
  })
  return [...TOOL_IDS]
}

// The plan as the dictator shows it to the user.
export function planText(job: Job): string {
  const acceptance = job.acceptance.map((a) => `- ${a.id}: ${a.text}${a.verify ? ` (check: ${a.verify})` : ""}`)
  const tasks = job.tasks.map((t) =>
    `- ${t.id} [${t.role}] ${t.title}${t.dependsOn.length ? ` (after ${t.dependsOn.join(", ")})` : ""}` +
    `${t.files.length ? `\n  files: ${t.files.join(", ")}` : ""}\n  covers: ${t.acceptance.join(", ")}${t.description ? `\n  ${t.description}` : ""}`,
  )
  return [`job ${job.id} (${job.phase})`, `goal: ${job.goal}`, "", "acceptance:", ...acceptance, "", "tasks:", ...tasks].join("\n")
}
