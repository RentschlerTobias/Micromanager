// Turns the role matrix into OpenCode agents. v2 does not load agent markdown files, so the agents are
// created in the plugin (ctx.agent.transform), each copied from the built-in "build" agent so it inherits the
// user's base rules (external directories, .env files), with the role's rules appended.

import { MICROMANAGER, ROLES, micromanagerSystem, type Rule } from "./roles.ts"

export interface AgentInfo {
  id: string
  name: string
  mode: "primary" | "subagent" | "all"
  hidden: boolean
  description?: string
  system?: string
  permissions: Rule[]
  [key: string]: unknown
}

export interface AgentDraft {
  get(id: string): AgentInfo | undefined
  update(id: string, update: (agent: AgentInfo) => void): void
}

export function agentsFrom(base: AgentInfo): AgentInfo[] {
  const copy = (): AgentInfo => ({ ...base, permissions: [...base.permissions] })
  const roles = ROLES.map((role) => ({
    ...copy(),
    id: role.agent,
    name: role.agent[0]!.toUpperCase() + role.agent.slice(1), // "Coder", "Reviewer", …
    mode: "subagent" as const,
    hidden: true, // only the micromanager delegates to them; build and plan never see them
    description: role.description,
    system: role.system,
    permissions: [...base.permissions, ...role.rules],
  }))
  const micromanager: AgentInfo = {
    ...copy(),
    id: MICROMANAGER.agent,
    name: "Micromanager",
    mode: "primary",
    hidden: false,
    description: MICROMANAGER.description,
    system: micromanagerSystem(),
    permissions: [...base.permissions, ...MICROMANAGER.rules],
  }
  return [micromanager, ...roles]
}

export function installAgents(draft: AgentDraft): string[] {
  const base = draft.get("build")
  if (!base) throw new Error('no built-in "build" agent to copy the base rules from')
  const agents = agentsFrom(base)
  for (const agent of agents) {
    // update() on an unknown id creates it (seen on opencode 2.0.18)
    draft.update(agent.id, (target) => {
      for (const key of Object.keys(target)) delete target[key]
      Object.assign(target, agent)
    })
  }
  return agents.map((a) => a.id)
}
