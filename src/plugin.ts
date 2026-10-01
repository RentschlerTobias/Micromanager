// jev-dictator, an OpenCode v2 plugin. Installed as a symlink into ~/.config/opencode/plugins/ (install.sh).
//
// The default export is what `define()` from @opencode-ai/plugin/v2/promise returns (it is the identity), so
// the plugin needs no package of its own. The runtime context has more domains than the typed SDK shows
// (seen on opencode 2.0.18): agent, tool, session, event, permission, worktree, generate, storage, skill, …

import { installAgents, type AgentDraft } from "./agents.ts"
import { loadRouting } from "./config.ts"
import { routeSubagentCall, type ToolCall } from "./hooks.ts"

interface Context {
  agent: { transform(callback: (draft: AgentDraft) => void): Promise<unknown> }
  tool: { hook(name: string, callback: (call: ToolCall) => void): Promise<unknown> }
  app?: { log?(entry: { level: string; message: string }): unknown }
}

function logger(ctx: Context) {
  return (level: "info" | "warn" | "error", message: string): void => {
    try {
      ctx.app?.log?.({ level, message: `[jev-dictator] ${message}` })
    } catch {
      // logging must never break the hub
    }
    if (level !== "info") console.error(`[jev-dictator] ${message}`)
  }
}

export default {
  id: "jev-dictator",
  setup: async (ctx: Context): Promise<void> => {
    const log = logger(ctx)
    const { routing, error } = loadRouting()
    if (error) log("warn", `config ignored, defaults used: ${error}`)

    await ctx.agent.transform((draft) => {
      try {
        log("info", `agents: ${installAgents(draft).join(", ")}`)
      } catch (err) {
        log("error", `agents not installed: ${String(err)}`)
      }
    })

    await ctx.tool.hook("execute.before", (call) => {
      const routed = routeSubagentCall(call, routing)
      if (routed) log("info", `${routed.role} -> ${routed.model} (${routed.reason})`)
    })
  },
}
