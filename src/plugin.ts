// jev-dictator, an OpenCode v2 plugin. Installed as a symlink into ~/.config/opencode/plugins/ (install.sh).
//
// The default export is what `define()` from @opencode-ai/plugin/v2/promise returns (it is the identity), so
// the plugin needs no package of its own. The runtime context has more domains than the typed SDK shows
// (seen on opencode 2.0.18): agent, tool, session, event, permission, worktree, generate, storage, skill, …

import { installAgents, type AgentDraft } from "./agents.ts"
import { loadSettings } from "./config.ts"
import { decide, type PermissionRequest } from "./decide.ts"
import { routeSubagentCall, type ToolCall } from "./hooks.ts"
import { Jev, apiKey } from "./jev.ts"
import { record } from "./journal.ts"
import { DICTATOR } from "./roles.ts"

// What the permission hook "evaluate" gets (opencode 2.0.18): the planned effect can be changed in place.
interface Evaluation {
  sessionID: string
  agent: string
  action: string
  resources: string[]
  effect: "allow" | "ask" | "deny"
}

interface Context {
  agent: { transform(callback: (draft: AgentDraft) => void): Promise<unknown> }
  tool: { hook(name: string, callback: (call: ToolCall) => void): Promise<unknown> }
  permission: { hook(name: string, callback: (evaluation: Evaluation) => Promise<void> | void): Promise<unknown> }
  location?: { directory?: string }
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
    const { routing, floors, error } = loadSettings()
    if (error) log("warn", `config ignored, defaults used: ${error}`)

    await ctx.agent.transform((draft) => {
      try {
        log("info", `agents: ${installAgents(draft).join(", ")}`)
      } catch (err) {
        log("error", `agents not installed: ${String(err)}`)
      }
    })

    const key = apiKey()
    const jev = key ? new Jev(key) : undefined
    if (!jev) log("warn", "no Jev key (JEV_API_KEY or the keyring entry service=typesafe key=jev): every question goes to the user")

    // The sub-task each agent works on, for Jev's context: the dictator's last delegation per role agent.
    const tasks = new Map<string, string>()

    await ctx.tool.hook("execute.before", (call) => {
      const routed = routeSubagentCall(call, routing)
      if (!routed) return
      tasks.set(String(call.input.agent), String(call.input.prompt ?? ""))
      log("info", `${routed.role} -> ${routed.model} (${routed.reason})`)
    })

    // Every question goes to Jev first: it answers itself when sure enough, else the user is asked as usual.
    await ctx.permission.hook("evaluate", async (evaluation) => {
      if (evaluation.effect !== "ask") return
      const request: PermissionRequest = {
        sessionID: evaluation.sessionID,
        agent: evaluation.agent,
        action: evaluation.action,
        resources: evaluation.resources,
        directory: ctx.location?.directory,
        task: evaluation.agent === DICTATOR.agent && evaluation.action === "subagent"
          ? tasks.get(evaluation.resources[0] ?? "")
          : tasks.get(evaluation.agent),
      }
      const outcome = await decide(jev, request, floors)
      if (outcome.verdict !== "user") evaluation.effect = outcome.verdict
      record({ kind: "permission", ...request, task: request.task?.slice(0, 500), ...outcome })
      log("info", `${evaluation.action} ${evaluation.resources.join(" | ").slice(0, 120)}: ${outcome.verdict} (${outcome.reason})`)
    })
  },
}
