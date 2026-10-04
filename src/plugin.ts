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
import { resolvePolicy } from "./policy.ts"
import { probe } from "./registry.ts"
import { DICTATOR, ROLES } from "./roles.ts"
import { Runner, summary, type SessionApi } from "./runner.ts"
import { listJobs, loadJob } from "./store.ts"
import { installTools, planText, TOOL_IDS, type ToolDraft } from "./tools.ts"

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
  tool: {
    hook(name: string, callback: (call: ToolCall) => void): Promise<unknown>
    transform(callback: (draft: ToolDraft) => void): Promise<unknown>
  }
  session: SessionApi & { hook(name: string, callback: (input: { agent?: string; tools?: Record<string, unknown> }) => void): Promise<unknown> }
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
    const { routing, floors, decisions, registry, error } = loadSettings()
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

    // The sub-task each agent works on, for Jev's context: the dictator's last delegation per role agent, and
    // the task of each worker session the runner started.
    const tasks = new Map<string, string>()
    const workerTasks = new Map<string, string>()

    await ctx.tool.hook("execute.before", (call) => {
      const routed = routeSubagentCall(call, routing)
      if (!routed) return
      tasks.set(String(call.input.agent), String(call.input.prompt ?? ""))
      // What the router decided, next to the permission decisions, so /flow can show the whole path.
      record({
        kind: "routing",
        sessionID: call.sessionID,
        agent: call.agent,
        role: routed.role,
        requested: String(call.input.agent ?? ""),
        model: routed.model,
        reason: routed.reason,
        prompt: String(call.input.prompt ?? "").slice(0, 300),
      })
      log("info", `${routed.role} -> ${routed.model} (${routed.reason})`)
    })

    // The dictator's own agents only: build, plan and every other agent are never touched.
    const ours = new Set([DICTATOR.agent, ...ROLES.map((role) => role.agent)])

    // Every question of the dictator and its sub-agents goes to Jev first: it answers itself when sure enough,
    // else the user is asked as usual.
    await ctx.permission.hook("evaluate", async (evaluation) => {
      if (evaluation.effect !== "ask" || !ours.has(evaluation.agent)) return
      const request: PermissionRequest = {
        sessionID: evaluation.sessionID,
        agent: evaluation.agent,
        action: evaluation.action,
        resources: evaluation.resources,
        directory: ctx.location?.directory,
        task: evaluation.agent === DICTATOR.agent && evaluation.action === "subagent"
          ? tasks.get(evaluation.resources[0] ?? "")
          : workerTasks.get(evaluation.sessionID) ?? tasks.get(evaluation.agent),
      }
      // "N13.<action>" or "N13" in the config: fixed:allow / fixed:deny, or ask for "always the user".
      const policy = resolvePolicy(`N13.${evaluation.action}`, { global: decisions }).policy
      const preset = policy.kind === "ask" ? "user" : policy.kind === "fixed" && (policy.value === "allow" || policy.value === "deny") ? policy.value : undefined
      const outcome = await decide(jev, request, floors, undefined, preset)
      if (outcome.verdict !== "user") evaluation.effect = outcome.verdict
      record({ kind: "permission", ...request, task: request.task?.slice(0, 500), ...outcome })
      log("info", `${evaluation.action} ${evaluation.resources.join(" | ").slice(0, 120)}: ${outcome.verdict} (${outcome.reason})`)
    })

    // Jobs: the dictator plans and runs them through its tools; the plugin drives the loop (Phase B).
    const project = ctx.location?.directory
    if (!project) {
      log("warn", "no project directory: the dictator tools are not installed")
      return
    }
    const runner = (parentID?: string) =>
      new Runner({
        session: ctx.session,
        project,
        registry,
        policies: { global: decisions },
        availability: () => probe(registry),
        progress: (text) => log("info", text),
        parentID,
        onWorker: (sessionID, task) => workerTasks.set(sessionID, task),
      })
    await ctx.tool.transform((draft) => {
      try {
        installTools(draft, {
          plan: async (goal, tctx) => {
            if (!goal.trim()) return "dictator_plan needs the goal in the user's words."
            const { job, errors } = await runner(tctx.sessionID).plan(goal)
            return errors ? `The planner could not produce a valid plan (job ${job.id}):\n- ${errors.join("\n- ")}` : planText(job)
          },
          run: async (id, tctx) => summary(await runner(tctx.sessionID).run(id.trim())),
          status: async (id) => {
            const job = id.trim() ? loadJob(project, id.trim()) : listJobs(project)[0]
            return job ? `${summary(job)}\n\n${planText(job)}` : "no job yet"
          },
        })
      } catch (err) {
        log("error", `dictator tools not installed: ${String(err)}`)
      }
    })
    // The tools exist for every agent; only the dictator sees them.
    await ctx.session.hook("context", (input) => {
      if (input.agent === DICTATOR.agent || !input.tools) return
      for (const id of TOOL_IDS) delete input.tools[id]
    })
  },
}
