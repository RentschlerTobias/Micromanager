// Before the micromanager's subagent call runs: the routed model goes into the call, and the call runs in the
// background (OpenCode notifies the micromanager when the worker ends; src/native.ts keeps writers in worktrees).

import { chooseModel, guessNeeds, type Routing } from "./routing.ts"
import { MICROMANAGER, ROLES, roleByAgent } from "./roles.ts"

export interface ToolCall {
  tool: string
  agent?: string // the agent making the call
  sessionID?: string
  input: Record<string, unknown>
  result?: unknown // tool.execute.after: what the model will see
  error?: unknown // tool.execute.after: why the tool failed (a hook's throw lands here too)
}

export interface Routed {
  readonly role: string
  readonly model: string
  readonly reason: string
}

export const HEADER = "[jev-micromanager]"

// Rewrites `call.input` in place; returns what was decided, or undefined when the call is not the micromanager's.
export function routeSubagentCall(call: ToolCall, routing: Routing, workerModel?: string): Routed | undefined {
  if (call.tool !== "subagent" || call.agent !== MICROMANAGER.agent) return undefined
  const role = roleByAgent(String(call.input.agent ?? ""))
  if (!role) return undefined // a built-in agent: left as the micromanager asked
  const prompt = String(call.input.prompt ?? "")
  const choice = chooseModel(role, guessNeeds(prompt), routing, workerModel)
  call.input.model = choice.model
  call.input.background = true
  if (!prompt.startsWith(HEADER)) {
    call.input.prompt = `${HEADER} role: ${role.id} · model: ${choice.model}\n\n${prompt}`
  }
  return { role: role.id, model: choice.model, reason: choice.reason }
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
