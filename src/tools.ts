// The dictator's tools (Phase A, A3: custom tools work, with text content as their result). Only the dictator
// agent may use them; every other agent gets a refusal, and the context hook hides them from other agents.
// A role agent can still reach them through the code-mode execute tool; the nested call carries the caller's
// agent (Phase E spike), so the same check refuses it. A call without an agent is refused too.

import type { Job } from "./state.ts"

export const TOOL_IDS = ["dictator_plan", "dictator_questions", "dictator_run", "dictator_status"] as const

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
  plan(goal: string, ctx: ToolContext): Promise<string>
  questions(job: string, tree: string, ctx: ToolContext): Promise<string>
  run(job: string, ctx: ToolContext): Promise<string>
  status(job: string, ctx: ToolContext): Promise<string>
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
    id: "dictator_plan",
    name: "dictator_plan",
    description: "Start or continue a job. With the user's goal: checks it, and either opens a planning session (follow the instruction it returns) or plans it right away. With a job id as goal: continues that job. Returns the plan to show the user, or what to do next. Changes nothing.",
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
    description: "Run a planned job after the user said go: one task at a time on the job's own git branch, with checks. Takes the job id from dictator_plan. Returns each task's status and the branch.",
    input: input("job"),
    execute: guarded(([job], ctx) => handlers.run(job!, ctx), "job"),
  })
  draft.add({
    id: "dictator_status",
    name: "dictator_status",
    description: "Show a job's state: phase, tasks, branch. An empty job id shows the newest job.",
    input: input("job"),
    execute: guarded(([job], ctx) => handlers.status(job!, ctx), "job"),
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
