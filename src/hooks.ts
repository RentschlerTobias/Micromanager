// Before the micromanager's subagent call runs: the routed model goes into the call, the call runs in the
// foreground (sequential in Phase 1), and a header tells the sub-agent its role and model.

import { chooseModel, guessNeeds, type Routing } from "./routing.ts"
import { MICROMANAGER, roleByAgent } from "./roles.ts"

export interface ToolCall {
  tool: string
  agent?: string // the agent making the call
  sessionID?: string
  input: Record<string, unknown>
  result?: unknown // tool.execute.after: what the model will see
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
  call.input.background = false
  if (!prompt.startsWith(HEADER)) {
    call.input.prompt = `${HEADER} role: ${role.id} · model: ${choice.model}\n\n${prompt}`
  }
  return { role: role.id, model: choice.model, reason: choice.reason }
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
