// The micromanager's tools (Phase A, A3: custom tools work, with text content as their result). Only the micromanager
// agent may use them; every other agent gets a refusal, and the context hook hides them from other agents.
// A role agent can still reach them through the code-mode execute tool; the nested call carries the caller's
// agent (Phase E spike), so the same check refuses it. A call without an agent is refused too.
//
// The descriptions here are also how the orchestrator learns what it may do: the micromanager's own system prompt
// (src/roles.ts micromanagerSystem) names stop_job and plan_job only, so every control below carries its own rule
// (when to use it, what it refuses, what it leaves behind) in the line the model always sees.

import type { Job } from "./state.ts"

export const TOOL_IDS = [
  "list_tasks", "plan_job", "plan_questions", "run_job", "job_status", "stop_job",
  // The controls a run showed were missing: one task at a time, the job branch, the worktrees behind it, and a vouch.
  "steer_task", "stop_task", "merge_job", "discard_job", "request_access",
] as const

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
  tasks(id: string, ctx: ToolContext): Promise<string>
  plan(goal: string, ctx: ToolContext): Promise<string>
  questions(job: string, tree: string, ctx: ToolContext): Promise<string>
  run(job: string, note: string, ctx: ToolContext): Promise<string>
  status(job: string, ctx: ToolContext): Promise<string>
  stop(job: string, ctx: ToolContext): Promise<string>
  steer(id: string, text: string, ctx: ToolContext): Promise<string>
  stopTask(id: string, ctx: ToolContext): Promise<string>
  merge(job: string, ack: string, ctx: ToolContext): Promise<string>
  discard(job: string, ack: string, ctx: ToolContext): Promise<string>
  access(path: string, why: string, ctx: ToolContext): Promise<string>
}

export function installTools(draft: ToolDraft, handlers: Handlers, agent = "micromanager", runnerSession: (id: string) => boolean = () => false): string[] {
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
    id: "list_tasks",
    name: "list_tasks",
    description: "The tasks you started in this session with their status, worker session and branch, or with a task id its stages (checks, merge) and summary.",
    input: input("id"),
    execute: guarded(([id], ctx) => handlers.tasks(id!, ctx), "id"),
  })
  draft.add({
    id: "plan_job",
    name: "plan_job",
    description: "For a large or unclear job only (most work goes to workers through the subagent tool): a planner reads the project and writes a full plan with acceptance points, which the user approves before run_job. With the user's goal: checks it and plans it, or opens a planning session when the user asked to plan it together. With a job id as goal: continues that job. When a plan waits for the user's go and they want changes, call it with their change request as goal: the planner writes the plan again with it. Changes nothing.",
    input: input("goal"),
    execute: guarded(([goal], ctx) => handlers.plan(goal!, ctx), "goal"),
  })
  draft.add({
    id: "plan_questions",
    name: "plan_questions",
    description: "Send the design questions of a planning session (or new ones found later) for a job: tree is a JSON list of { id, question, kind, dependsOn, impact }. Returns the one question to ask the user next.",
    input: input("job", "tree"),
    execute: guarded(([job, tree], ctx) => handlers.questions(job!, tree!, ctx), "job", "tree"),
  })
  draft.add({
    id: "run_job",
    name: "run_job",
    description: "Run a planned job after the user said go, or resume a stopped one. Takes the job id from plan_job; note is the user's answer when the job stopped for them (their words, or empty). The job is queued and runs in the background on its own git branch, independent tasks in parallel; this returns at once. Updates arrive later as [jev-micromanager] notes: do not wait or poll, end your turn and keep talking with the user.",
    input: input("job", "note"),
    execute: guarded(([job, note], ctx) => handlers.run(job!, note!, ctx), "job", "note"),
  })
  draft.add({
    id: "job_status",
    name: "job_status",
    description: "Show the queue and an ASCII board of a job: each task with its state, role, model and what it does now, the usage, and what was found but not done. Show the board to the user in a code block as it is. An empty job id shows the newest job.",
    input: input("job"),
    execute: guarded(([job], ctx) => handlers.status(job!, ctx), "job"),
  })
  draft.add({
    id: "stop_job",
    name: "stop_job",
    description: "Stop a job when the user asks: the running worker is interrupted, and the job pauses; run_job resumes it later. A waiting job leaves the queue. An empty job id stops the running job.",
    input: input("job"),
    execute: guarded(([job], ctx) => handlers.stop(job!, ctx), "job"),
  })
  draft.add({
    id: "steer_task",
    name: "steer_task",
    description: "Send a note to a worker that is still running, without interrupting it: id is a task id (list_tasks), text is what the worker should know, in a sentence. The note reaches it as a system block at its next turn, so it finishes what it is doing first. Use it when the user changes their mind about a task, or when a report tells you what to fix next. A worker that already ended cannot be steered: the answer then names its sessionID to continue it with the subagent tool.",
    input: input("id", "text"),
    execute: guarded(([id, text], ctx) => handlers.steer(id!, text!, ctx), "id", "text"),
  })
  draft.add({
    id: "stop_task",
    name: "stop_task",
    description: "Stop one task's worker and leave the rest of the job running; use it when the user says one worker is stuck, wrong or not needed any more. Its worktree and whatever it wrote stay exactly where they are, and the answer names them, so nothing is lost. When it was the last running task, the job ends like a stopped one.",
    input: input("id"),
    execute: guarded(([id], ctx) => handlers.stopTask(id!, ctx), "id"),
  })
  draft.add({
    id: "merge_job",
    name: "merge_job",
    description: "Bring a finished job's branch into the user's checkout, the one write you may make there. It shows the commits that would land, refuses a checkout with uncommitted changes and a job with unfinished or failed tasks (ack then carries the user's own words that this is fine), and merges fast-forward only. It never forces, resets or throws work away: without a fast-forward it says so and leaves the checkout as it was. Afterwards discard_job drops the branch and its worktrees.",
    input: input("job", "ack"),
    execute: guarded(([job, ack], ctx) => handlers.merge(job!, ack!, ctx), "job", "ack"),
  })
  draft.add({
    id: "discard_job",
    name: "discard_job",
    description: "Give a job's branch and worktrees back to git: git worktree remove --force and git branch -D for each of them. Without ack it only lists what it would delete; with the user's words in ack it deletes that and reports what went and what stayed. Your checkout and every file in it are never touched. Use it when the user does not want the job's work any more, or after merge_job.",
    input: input("job", "ack"),
    execute: guarded(([job, ack], ctx) => handlers.discard(job!, ack!, ctx), "job", "ack"),
  })
  draft.add({
    id: "request_access",
    name: "request_access",
    description: "Vouch that a worker of this job legitimately needs a path outside the project: path with its full path, why in one sentence for the user. From then on a worker that only reads may read it without asking again; writing there still goes to the user. It cannot open the user's keys, credentials, config or home directory, the system directories or another job's worktrees, whatever the reason: for those, ask the user.",
    input: input("path", "why"),
    execute: guarded(([path, why], ctx) => handlers.access(path!, why!, ctx), "path", "why"),
  })
  return [...TOOL_IDS]
}

// A worker's last step (src/native.ts): the plugin runs the task's checks, commits and merges. Only the sessions of
// writers the micromanager started may use it; the context hook hides it from every other session.
export const FINISH_ID = "finish_task"

export function installFinishTool(draft: ToolDraft, finish: (summary: string, ctx: ToolContext) => Promise<string>, writer: (sessionID: string) => boolean): void {
  const read = draft.get("read")
  const str = read?.input?.fields?.path
  if (!read?.input?.mapFields || !str) throw new Error("the built-in read tool has no input schema to build from")
  draft.add({
    id: FINISH_ID,
    name: FINISH_ID,
    description: "Call this when your change is done: the plugin runs the task's checks in your directory, commits and merges your change. summary: what you changed, in two lines. If it answers with failures, fix them and call it again; once it says merged, end with your short report.",
    input: read.input.mapFields(() => ({ summary: str })),
    execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
      if (!ctx?.sessionID || !writer(ctx.sessionID)) return { content: "Only a worker that changes files for the micromanager may use this tool." }
      try {
        return { content: await finish(String(args?.summary ?? ""), ctx) }
      } catch (err) {
        return { content: `failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    },
  })
}

// An explorer's code graph (src/graph.ts): who calls, uses or imports what, from the syntax tree. Only explorers the
// micromanager started with a graph may use it; the context hook hides it from every other session.
export const GRAPH_ID = "code_graph"

export function installGraphTool(draft: ToolDraft, ask: (args: { action: string; symbol: string; to: string }, ctx: ToolContext) => Promise<string>, allowed: (sessionID: string) => boolean): void {
  const read = draft.get("read")
  const str = read?.input?.fields?.path
  if (!read?.input?.mapFields || !str) throw new Error("the built-in read tool has no input schema to build from")
  draft.add({
    id: GRAPH_ID,
    name: GRAPH_ID,
    description: "Ask the code graph of your directory, built from the syntax tree of every file. action: explain (a symbol: where it is defined, what calls it, what it calls), affected (what depends on a symbol, two levels deep), path (how symbol reaches to), query (symbols whose names match the words in symbol). symbol: a function, class, method or file name, e.g. instruction_language or server.py. to: the second symbol for path, else empty. Use it before grep for any who-calls or what-uses question.",
    input: read.input.mapFields(() => ({ action: str, symbol: str, to: str })),
    execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
      if (!ctx?.sessionID || !allowed(ctx.sessionID)) return { content: "Only an explorer of the micromanager may use this tool." }
      try {
        return { content: await ask({ action: String(args?.action ?? ""), symbol: String(args?.symbol ?? ""), to: String(args?.to ?? "") }, ctx) }
      } catch (err) {
        return { content: `failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    },
  })
}

// The plan as the micromanager shows it to the user.
export function planText(job: Job): string {
  const acceptance = job.acceptance.map((a) => `- ${a.id}: ${a.text}${a.verify ? ` (check: ${a.verify})` : ""}`)
  const tasks = job.tasks.map((t) =>
    `- ${t.id} [${t.role}] ${t.title}${t.dependsOn.length ? ` (after ${t.dependsOn.join(", ")})` : ""}` +
    `${t.files.length ? `\n  files: ${t.files.join(", ")}` : ""}\n  covers: ${t.acceptance.join(", ")}${t.description ? `\n  ${t.description}` : ""}`,
  )
  return [`job ${job.id} (${job.phase})`, `goal: ${job.goal}`, "", "acceptance:", ...acceptance, "", "tasks:", ...tasks].join("\n")
}