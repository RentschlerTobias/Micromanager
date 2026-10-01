// Before the dictator's subagent call runs: the routed model goes into the call, the call runs in the
// foreground (sequential in Phase 1), and a header tells the sub-agent its role and model.

import { chooseModel, guessNeeds, type Routing } from "./routing.ts"
import { DICTATOR, roleByAgent } from "./roles.ts"

export interface ToolCall {
  tool: string
  agent?: string // the agent making the call
  sessionID?: string
  input: Record<string, unknown>
}

export interface Routed {
  readonly role: string
  readonly model: string
  readonly reason: string
}

export const HEADER = "[jev-dictator]"

// Rewrites `call.input` in place; returns what was decided, or undefined when the call is not the dictator's.
export function routeSubagentCall(call: ToolCall, routing: Routing, workerModel?: string): Routed | undefined {
  if (call.tool !== "subagent" || call.agent !== DICTATOR.agent) return undefined
  const role = roleByAgent(String(call.input.agent ?? ""))
  if (!role) return undefined // a built-in agent: left as the dictator asked
  const prompt = String(call.input.prompt ?? "")
  const choice = chooseModel(role, guessNeeds(prompt), routing, workerModel)
  call.input.model = choice.model
  call.input.background = false
  if (!prompt.startsWith(HEADER)) {
    call.input.prompt = `${HEADER} role: ${role.id} · model: ${choice.model}\n\n${prompt}`
  }
  return { role: role.id, model: choice.model, reason: choice.reason }
}
