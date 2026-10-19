// Before the micromanager's subagent call runs: the routed model goes into the call, and the call runs in the
// background (OpenCode notifies the micromanager when the worker ends; src/native.ts keeps writers in worktrees).

import { chooseModel, guessNeeds, type Available, type Routing, type Spread } from "./routing.ts"
import { MICROMANAGER, ROLES, roleByAgent, type Role } from "./roles.ts"

export interface ToolCall {
  tool: string
  agent?: string // the agent making the call
  sessionID?: string
  input: Record<string, unknown>
  result?: unknown // tool.execute.after: what the model will see
  error?: unknown // tool.execute.after: why the tool failed (a hook's throw lands here too)
}

// The tool a delegation arrives under.
//
// Read in the bundled server (~/.opencode/bin/opencode, the @opencode/Tool service): opencode registers exactly one
// delegation tool, `subagent`, and it carries `options.codemode:false`. That one flag settles the question of a
// nested shape — Tool.snapshot builds the code-mode catalog from the tools whose codemode option is not false, so a
// delegation cannot be issued from inside the code-mode `execute` tool at all. There is no second shape to
// recognise, and parsing the code string would be a parser for an event that cannot happen.
//
// (Nested calls that do exist are surfaced individually with their real tool name, so the hook sees them normally:
// Tool.execute triggers tool.execute.before per nested call, with that call's own name, input and the outer
// session's id and agent. The same code path also confirms the fields a call carries: tool, sessionID, agent,
// messageID, id and input.)
export const DELEGATION_TOOL = "subagent"

// Every tool name the delegation hook recognises, so the setup record can name them (a field operator has to be able
// to read off the journal what the hook thinks it is looking at).
export const DELEGATION_TOOLS: readonly string[] = [DELEGATION_TOOL]

export interface Routed {
  readonly role: string
  readonly model: string
  readonly reason: string
  // The chain entries the host cannot run. Absent unless the catalog said so, so an ordinary delegation is unchanged.
  readonly skipped?: readonly string[]
}

export const HEADER = "[micromanager]"

// The role a call delegates to, when it delegates to one of this plugin's own role agents; undefined otherwise.
//
// The caller is deliberately not part of the question, and that is the whole fix for a live run of 2026-10-06: the
// caller used to have to be the micromanager agent, the user switched the parent session's agent from `micromanager`
// to `build`, and the ten delegations that followed (coder, tester, explorer, oracle) all returned early from that
// one check. No task, no worktree, no claim, no move, no gate, no merge and not one word of it — the workers ran in
// the user's checkout. The agent is a property of the session the user happens to be sitting in, not a property of
// the delegation.
//
// What makes widening this safe is that the discriminator is the *target*: a target that is one of this plugin's own
// agents cannot be anything but a delegation, and routing one can only ever narrow what the worker may do. A built-in
// agent (`explore`, `general`) is not one of ours, so nothing is routed on its behalf and the call is left exactly as
// its caller wrote it.
export function delegationRole(call: ToolCall): Role | undefined {
  if (!DELEGATION_TOOLS.includes(call.tool)) return undefined
  return roleByAgent(String(call.input.agent ?? ""))
}

// Whether this call is a delegation attempt the plugin cannot isolate: the subagent tool, aimed at an agent it does
// not own or at none. It is worth a journal record of its own, because a delegation that reached neither the routing
// nor a refusal is precisely how a live run wrote into the user's checkout in silence.
export function unownedDelegation(call: ToolCall): boolean {
  return call.tool === DELEGATION_TOOL && !roleByAgent(String(call.input.agent ?? ""))
}

// Rewrites `call.input` in place; returns what was decided, or undefined when the call is not the micromanager's.
export async function routeSubagentCall(call: ToolCall, routing: Routing, workerModel?: string, available?: Available, spread?: Spread): Promise<Routed | undefined> {
  if (call.tool !== DELEGATION_TOOL || call.agent !== MICROMANAGER.agent) return undefined
  return await route(call, routing, workerModel, available, spread)
}

// The same routing for a delegation that the micromanager agent did not make. Narrower than the caller alone would
// suggest and never wider: it returns nothing at all for a tool that is not the delegation tool.
export async function routeDelegation(call: ToolCall, routing: Routing, workerModel?: string, available?: Available, spread?: Spread): Promise<Routed | undefined> {
  if (call.tool !== DELEGATION_TOOL) return undefined
  return await route(call, routing, workerModel, available, spread)
}

async function route(call: ToolCall, routing: Routing, workerModel?: string, available?: Available, spread?: Spread): Promise<Routed | undefined> {
  const role = roleByAgent(String(call.input.agent ?? ""))
  if (!role) return undefined // a built-in agent: left as the caller asked
  const prompt = String(call.input.prompt ?? "")
  const choice = await chooseModel(role, guessNeeds(prompt), routing, workerModel, available, spread)
  call.input.model = choice.model
  call.input.background = true
  if (!prompt.startsWith(HEADER)) {
    call.input.prompt = `${HEADER} role: ${role.id} · model: ${choice.model}\n\n${prompt}`
  }
  // skipped travels with the decision so the plugin can journal why this model and not the first of the chain.
  return { role: role.id, model: choice.model, reason: choice.reason, ...(choice.skipped ? { skipped: choice.skipped } : {}) }
}

// --- the backstop: a child of a micromanager session that no worktree ever got must not be able to write ---

// The write-capable actions a permission evaluation can carry. The names are the ones opencode asserts for its own
// tools (opencode.tool.edit and opencode.tool.patch both assert action "edit", the shell tool asserts "shell"), plus
// the code-mode `execute` tool, which reaches everything else: a worker that may run `execute` may run a shell inside
// it. Anything not listed here is a read, and a read cannot damage the checkout.
const WRITES = new Set(["shell", "edit", "write", "patch", "execute"])

// What the permission hook knows about a session before it lets anything change the tree.
//
// `parent` is the session that started it — OpenCode's own Session record, whose parentID is in the SDK's Session
// type — and `parentIsMicromanager` says whether that parent is a session this plugin owns. The relation is the
// discriminator because it is the one thing a delegation cannot fake and cannot lose: a plugin-recognised delegation
// rewrites the child's prompt, and an unrecognised one does not, so the prompt text cannot tell them apart (and a
// child's prompt is not even visible to the permission hook).
export interface ChildSession {
  readonly sessionID: string
  readonly directory?: string // where the session would write
  readonly parent?: string // the session that started it
  readonly parentIsMicromanager: boolean // that parent is a session this plugin owns
  readonly job?: string // the job of that parent, for the journal line
}

export interface Denial {
  readonly reason: string // greppable, and says the thing that failed
  readonly message: string // what the agent reads instead of its write
}

// The refusal an unclaimed child of a micromanager session gets instead of its write, and undefined for every other
// session and every other action.
//
// This is the part that holds when the delegation hook did not engage, which is why it does not depend on knowing how
// the delegation was made: it asks only whether this session is a child of a session the plugin owns and whether the
// plugin claimed it as a worker. The live run this exists for had no task, no worktree, no claim and no session move,
// and nothing complained — the children were ordinary sessions of a micromanager session, and every one of their
// writes went straight into the user's checkout.
//
// It never keys on the agent name. A user who picks a role agent by hand and works in their own checkout is not a
// delegated child — it is a root session, or a child of a session that is not the plugin's — and keeps working
// exactly as before. Only a session that was *started by* a micromanager session is ever caught.
export function backstop(facts: ChildSession, action: string, claimed: boolean): Denial | undefined {
  if (claimed || !facts.parent || !facts.parentIsMicromanager) return undefined
  if (!WRITES.has(action)) return undefined
  return {
    reason: "isolation did not engage: a child of a micromanager session that is not a claimed worker",
    message: `Stopped: you were started as a sub-agent of micromanager session ${facts.parent}${facts.job ? ` (job ${facts.job})` : ""}, but the plugin never gave you a task and never put you in a worktree, so nothing of yours is checked and nothing of yours can be merged. You are in ${facts.directory ?? "a directory the plugin does not know"}; writing there would change the user's own checkout. Do not work around this and do not write anything. Stop now and report: STATUS: NEEDS_CONTEXT — say that the delegation was not isolated, that you were never placed in a worktree, and what you were asked to do.`,
  }
}

// Why a call of the micromanager was not routed, when it is about the agent name at all; undefined for every other
// reason routeSubagentCall returns nothing (a call that is not the micromanager's, or one it already routed).
//
// routeSubagentCall leaves a built-in agent alone on purpose (it routes nothing it does not own), so the caller got
// "Not started: use one of the role agents (coder, …)" for `explore` and looked for a `explore` role agent that does
// not exist. The two cases need different fixes: rename the agent, or install the plugin's agents.
export function notRouted(call: ToolCall): string | undefined {
  if (call.tool !== "subagent" || call.agent !== MICROMANAGER.agent) return undefined
  const asked = String(call.input.agent ?? "").trim()
  if (roleByAgent(asked)) return undefined // a role agent: routed, or nothing to say about the name
  if (asked) {
    return `"${asked}" is not a role agent, so nothing was started. Use one of this plugin's role agents (${ROLES.map((r) => r.agent).join(", ")}); OpenCode's own agents (explore, general, …) are not role agents here.`
  }
  return `No agent was named, so nothing was started. Name one of this plugin's role agents (${ROLES.map((r) => r.agent).join(", ")}).`
}

// The text of a tool result as the model sees it: result.content[] text parts, plus string fields of result.output
// (shapes seen in the Phase E spike for read, shell, execute and custom tools).
function textSlots(result: unknown): { get(): string; set(v: string): void }[] {
  const slots: { get(): string; set(v: string): void }[] = []
  const r = result as { content?: unknown; output?: unknown } | undefined
  if (!r || typeof r !== "object") return slots
  if (Array.isArray(r.content)) {
    for (const part of r.content as { text?: unknown }[]) {
      if (part && typeof part.text === "string") slots.push({ get: () => part.text as string, set: (v) => { part.text = v } })
    }
  }
  if (typeof r.output === "string") slots.push({ get: () => r.output as string, set: (v) => { r.output = v } })
  else if (r.output && typeof r.output === "object") {
    const o = r.output as Record<string, unknown>
    for (const key of ["output", "content", "text"]) {
      if (typeof o[key] === "string") slots.push({ get: () => o[key] as string, set: (v) => { o[key] = v } })
    }
  }
  return slots
}

export function resultText(result: unknown): string {
  return textSlots(result).map((s) => s.get()).join("\n")
}

// Rewrites a tool result in place before the model sees it (tool.execute.after is awaited, Phase E spike); returns
// whether anything changed.
export function rewriteResult(result: unknown, fn: (text: string) => string): boolean {
  let changed = false
  for (const slot of textSlots(result)) {
    const before = slot.get()
    const after = fn(before)
    if (after !== before) {
      slot.set(after)
      changed = true
    }
  }
  return changed
}
