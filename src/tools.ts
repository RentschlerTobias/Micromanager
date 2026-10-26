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
  // A worker's paused permission request, answered (src/ask.ts).
  "answer_permission",
  // Checkpoints: the job branch back to an earlier state, and the last merge_job taken back.
  "rewind_job", "undo_merge",
  // An earlier session's open job, made this session's.
  "take_over_job",
  // The micromanager's todo list, kept in its job (src/native.ts todo).
  "todo",
  // What "better" means for a task with no fixed end (src/contract.ts).
  "contract",
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
  permission(id: string, decision: string, note: string, ctx: ToolContext): Promise<string>
  rewind(job: string, to: string, ack: string, ctx: ToolContext): Promise<string>
  undoMerge(job: string, ack: string, ctx: ToolContext): Promise<string>
  takeOver(job: string, ctx: ToolContext): Promise<string>
  todo(items: string, ctx: ToolContext): Promise<string>
  contract(job: string, json: string, ctx: ToolContext): Promise<string>
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
    description: "Run a planned job after the user said go, or resume a paused one. Takes the job id from plan_job; note is the user's answer when the job stopped for them (their words, or empty). Answers with the planned tasks to start now: start each with the subagent tool exactly as listed, in one message. Later [micromanager] job notes name the next ones as workers end; do not wait or poll.",
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
    description: "Vouch that a worker of this job legitimately needs a path outside the project: path with its full path, why in one sentence for the user. From then on a worker that only reads may read it without asking again; writing there still goes to the user. A path the plugin refuses by default — the user's keys, credentials, home and the system directories — is not a refusal but a question: calling this with one returns the question to put to the user word for word, and their answer on the next turn opens it for this job or leaves it closed. End your turn after showing it.",
    input: input("path", "why"),
    execute: guarded(([path, why], ctx) => handlers.access(path!, why!, ctx), "path", "why"),
  })
  draft.add({
    id: "answer_permission",
    name: "answer_permission",
    description: "Answer a worker's paused permission request (a note \"[micromanager] A…: worker … is paused\" names it). id: the A-number. decision: once (let this call run), job (also this exact request for the rest of the job) or refuse. note: for a refusal, why, in one sentence for the worker. Allow only what clearly serves the worker's task and reaches nothing outside the project; anything else is the user's to decide, and a hard rule always is.",
    input: input("id", "decision", "note"),
    execute: guarded(([id, decision, note], ctx) => handlers.permission(id!, decision!, note!, ctx), "id", "decision", "note"),
  })
  draft.add({
    id: "rewind_job",
    name: "rewind_job",
    description: "Move a job's branch back to a checkpoint: \"start\", the state after a merged task (\"T3\"), or \"before-rewind-<n>\" (a rewind undone). job: the job id, or empty for this session's job. to: empty lists the checkpoints and changes nothing. Without ack it shows what would leave the branch and which unfinished tasks would be given up, and changes nothing; with ack (the user's own words, repeated) it moves the branch, keeps the old tip as before-rewind-<n>, and deletes the unfinished tasks' worktrees. Refused while a worker of the job runs. The user's checkout is never touched (undo_merge).",
    input: input("job", "to", "ack"),
    execute: guarded(([job, to, ack], ctx) => handlers.rewind(job!, to!, ack!, ctx), "job", "to", "ack"),
  })
  draft.add({
    id: "take_over_job",
    name: "take_over_job",
    description: "Make an earlier micromanager session's open job this session's, after the user chose to continue it: new workers land on its branch, its unfinished workers are continued with the subagent tool and their sessionID, and their notes and permission requests come here. job: the job id the plugin's note named. Refused when this session started a job of its own already.",
    input: input("job"),
    execute: guarded(([job], ctx) => handlers.takeOver(job!, ctx), "job"),
  })
  draft.add({
    id: "todo",
    name: "todo",
    description: "Your todo list, kept in your job so it is never lost: write down the tasks you mean to start before you start them, and start each later with the subagent tool and the prompt line \"Task: T… · job-…\" (plus anything to add below it); the plugin fills in its brief, files and checks. items: a JSON list of {\"title\", \"agent\" (a role agent, coder if left out), \"files\" (what a writer may change, comma separated), \"checks\" (shell commands, one per line), \"after\" ([task ids it waits for, e.g. [\"T1\", \"T2\"]]), \"brief\" (what the worker needs to know), \"replaces\" ([ids of failed or stopped tasks it does over, e.g. [\"T19\"], or [\"job-…/T18\"] for one of an older job])}; an entry {\"drop\": [\"T5\"]} removes open todos that are not needed any more. Empty: it only shows the list. When a worker ends, a note names the todos that can start.",
    input: input("items"),
    execute: guarded(([items], ctx) => handlers.todo(items!, ctx), "items"),
  })
  draft.add({
    id: "contract",
    name: "contract",
    description: "Define what \"better\" means before a writer works on a task with no fixed end (make X faster, smaller, more reliable): such a writer is refused without one. json: {\"goal\": what the work is for, in words; \"evaluator\": a shell command that prints one line MM_SCORE {\"scores\": {\"<name>\": <number>, …}} (exit 0; anything else counts as an invalid result); \"scores\": [{\"name\", \"direction\": \"min\"|\"max\", \"noise\": 0.05}] (the first decides, the next break ties inside its noise band); \"guards\": [{\"name\", \"direction\", \"tolerance\": 0.2}] (measured values that may not get worse than today by more than that share: they close the ways to raise a score without improving the goal); \"corpus\": {\"visible\": [paths it measures on]}; \"repeats\": runs per measurement, the median counts (3 for timings); \"timeoutSeconds\"; \"stop\": {\"evaluations\": n, \"seconds\": s}}. With \"id\": \"C1\" it changes that contract (a new version). The plugin measures the baseline on the job's branch now and answers with it; a writer is then measured with a line \"Contract: C1\" in its prompt (or \"contract\" in its todo). job: empty for this session's job.",
    input: input("job", "json"),
    execute: guarded(([job, json], ctx) => handlers.contract(job!, json!, ctx), "job", "json"),
  })
  draft.add({
    id: "undo_merge",
    name: "undo_merge",
    description: "Take back the last merge_job of a job: the user's checkout goes back to where it was before that merge. Only while the checkout is exactly where the merge left it and has no uncommitted changes. job: the job id, or empty for this session's job. Without ack it shows which commits would leave the checkout and changes nothing; with ack (the user's own words, repeated) it moves it back. The commits stay on the job branch; merge_job brings them back.",
    input: input("job", "ack"),
    execute: guarded(([job, ack], ctx) => handlers.undoMerge(job!, ack!, ctx), "job", "ack"),
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

// A writer's helpers (src/helpers.ts): an explorer or a researcher answers one question while the writer waits. Only the
// writers the micromanager started may use them; the context hook hides them from every other session, the helpers
// themselves included, so a helper never asks a helper.
export const HELPER_IDS = { explore: "explore", research: "research" } as const

export function installHelperTools(draft: ToolDraft, ask: (role: "explore" | "research", question: string, ctx: ToolContext) => Promise<string>, allowed: (sessionID: string) => boolean): void {
  const read = draft.get("read")
  const str = read?.input?.fields?.path
  if (!read?.input?.mapFields || !str) throw new Error("the built-in read tool has no input schema to build from")
  const descriptions = {
    explore: "Ask an explorer one question about the code and wait for its answer: who calls or uses something, where a thing is defined, how a part works, what the history says. It reads your directory as it is now, your uncommitted change included. Use it for a question that would take you many reads; for one file, read it yourself. question: one question in a sentence. At most 3 helpers per task.",
    research: "Ask a researcher one question that needs the web and wait for its answer: an API's documentation, a library's behaviour, an error message, a current version. It cites its sources. question: one question in a sentence. At most 3 helpers per task.",
  }
  for (const role of ["explore", "research"] as const) {
    draft.add({
      id: HELPER_IDS[role],
      name: HELPER_IDS[role],
      description: descriptions[role],
      input: read.input.mapFields(() => ({ question: str })),
      execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
        if (!ctx?.sessionID || !allowed(ctx.sessionID)) return { content: "Only a worker that changes files for the micromanager may ask a helper." }
        try {
          return { content: await ask(role, String(args?.question ?? ""), ctx) }
        } catch (err) {
          return { content: `failed: ${err instanceof Error ? err.message : String(err)}` }
        }
      },
    })
  }
}

// A worker's request for a variable or a host its sandbox keeps from it (src/grants.ts). The call waits until it is
// decided: at once for what the plugin or Jev decides, up to ten minutes for the user's form. Every worker of the
// micromanager may ask for a variable; only writers and researchers for a host. The context hook hides each tool from
// every other session.
export const GRANT_IDS = { env: "request_env", network: "request_network" } as const

export function installGrantTools(draft: ToolDraft, request: (kind: "env" | "network", name: string, why: string, ctx: ToolContext) => Promise<string>, allowed: (kind: "env" | "network", sessionID: string) => boolean): void {
  const read = draft.get("read")
  const str = read?.input?.fields?.path
  if (!read?.input?.mapFields || !str) throw new Error("the built-in read tool has no input schema to build from")
  const tools = {
    env: { field: "name", description: "Ask for an environment variable your shell commands do not get: they start with a cleaned environment (PATH, HOME, locale and the usual toolchain variables only). Use it when a command fails because a variable is not set, e.g. DATABASE_URL for the integration tests. name: the variable's name only; you never see its value. why: what needs it, in one sentence for the user. The call waits until it is decided, up to ten minutes when the user has to answer; once granted, every command you start has it." },
    network: { field: "domain", description: "Ask for a host your shell commands cannot reach: they reach the package registries only. Use it when a command fails to connect, e.g. a build that downloads from github.com. domain: the host, like api.example.com (or *.example.com), without scheme or path. why: what needs it, in one sentence for the user. The call waits until it is decided, up to ten minutes when the user has to answer." },
  }
  for (const kind of ["env", "network"] as const) {
    const { field, description } = tools[kind]
    draft.add({
      id: GRANT_IDS[kind],
      name: GRANT_IDS[kind],
      description,
      input: read.input.mapFields(() => ({ [field]: str, why: str })),
      execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
        if (!ctx?.sessionID || !allowed(kind, ctx.sessionID)) return { content: "Only a worker of the micromanager may use this tool." }
        try {
          return { content: await request(kind, String(args?.[field] ?? "").trim(), String(args?.why ?? "").trim(), ctx) }
        } catch (err) {
          return { content: `failed: ${err instanceof Error ? err.message : String(err)}` }
        }
      },
    })
  }
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