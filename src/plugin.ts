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
import { DEFAULT_BACKENDS, Decider, makeAskers } from "./backends.ts"
import { matchShortcut, resolvePolicy } from "./policy.ts"
import { probe } from "./registry.ts"
import { DICTATOR, ROLES } from "./roles.ts"
import { recentFailure, Runner, summary, type SessionApi } from "./runner.ts"
import { listJobs, loadJob, saveJob } from "./store.ts"
import { installTools, planText, TOOL_IDS, type ToolDraft } from "./tools.ts"
import { Watchdog, type Signal } from "./watchdog.ts"

// What the permission hook "evaluate" gets (opencode 2.0.18): the planned effect can be changed in place.
interface Evaluation {
  sessionID: string
  agent: string
  action: string
  resources: string[]
  effect: "allow" | "ask" | "deny"
  message?: string
}

// The dictator reads only to orient itself (README, file list); past this many reads per session it is refused
// and told to let the agents explore (design.md §3).
const DICTATOR_READ_CAP = 12
const READS = new Set(["read", "glob", "grep", "list"])

// What the session hooks "prompt" and "context" get (opencode 2.0.18, Phase A1).
interface SessionHookInput {
  sessionID?: string
  agent?: string
  messages?: unknown
  prompt?: { text?: string }
  system?: { type: string; text: string }[]
  tools?: Record<string, unknown>
}

interface Context {
  agent: { transform(callback: (draft: AgentDraft) => void): Promise<unknown> }
  tool: {
    hook(name: string, callback: (call: ToolCall) => void): Promise<unknown>
    transform(callback: (draft: ToolDraft) => void): Promise<unknown>
  }
  session: SessionApi & { hook(name: string, callback: (input: SessionHookInput) => Promise<void> | void): Promise<unknown> }
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
    const dictatorReads = new Map<string, number>()
    await ctx.permission.hook("evaluate", async (evaluation) => {
      if (evaluation.agent === DICTATOR.agent && READS.has(evaluation.action) && evaluation.effect !== "deny") {
        const reads = (dictatorReads.get(evaluation.sessionID) ?? 0) + 1
        dictatorReads.set(evaluation.sessionID, reads)
        if (reads > DICTATOR_READ_CAP) {
          evaluation.effect = "deny"
          evaluation.message = "The dictator only orients itself; let the agents explore (dictator_plan starts a planner that reads the project)."
          record({ kind: "permission", sessionID: evaluation.sessionID, agent: evaluation.agent, action: evaluation.action, resources: evaluation.resources, verdict: "deny", reason: `dictator read cap (${DICTATOR_READ_CAP})` })
          return
        }
      }
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

    // Jobs: the dictator plans and runs them through its tools; the plugin drives the loop (Phase B, C).
    const project = ctx.location?.directory
    if (!project) {
      log("warn", "no project directory: the dictator tools are not installed")
      return
    }
    const decider = new Decider(DEFAULT_BACKENDS, makeAskers(DEFAULT_BACKENDS, key))
    // The loop watchdog judges the planner and worker sessions the runner starts; a signal interrupts the session
    // and the runner reads why (design.md §10.1).
    const watchdog = new Watchdog()
    const stops = new Map<string, Signal>()
    const stop = (sessionID: string, signal: Signal) => {
      if (stops.has(sessionID)) return
      stops.set(sessionID, signal)
      watchdog.unwatch(sessionID)
      record({ kind: "watchdog", sessionID, signal: signal.kind, detail: signal.detail })
      log("warn", `watchdog stopped ${sessionID}: ${signal.detail}`)
      ctx.session.interrupt({ sessionID }).catch((err: unknown) => log("warn", `interrupt failed: ${String(err)}`))
    }
    const runner = (parentID?: string) =>
      new Runner({
        session: ctx.session,
        project,
        registry,
        decider,
        policies: { global: decisions },
        availability: () => probe(registry),
        progress: (text) => log("info", text),
        parentID,
        onWorker: (sessionID, task) => workerTasks.set(sessionID, task),
        watch: (sessionID, maxSteps) => watchdog.watch(sessionID, { maxSteps }),
        stopped: (sessionID) => stops.get(sessionID),
      })
    await ctx.tool.hook("execute.after", (call) => {
      if (!call.sessionID || !watchdog.watching(call.sessionID)) return
      const signal = watchdog.onTool(call.sessionID, call.tool, call.input)
      if (signal) stop(call.sessionID, signal)
    })
    // The dictator's newest job in a session, for the user's turns (planning session, gate answer, pins).
    const sessionJob = (sessionID: string) => listJobs(project).find((j) => j.facilitator === sessionID)
    const JOB_ID = /^job-\d{8}-\d{6}-[0-9a-f]{1,4}$/
    await ctx.tool.transform((draft) => {
      try {
        installTools(draft, {
          plan: async (goal, tctx) => {
            const text = goal.trim()
            if (!text) return "dictator_plan needs the goal in the user's words, or a job id to continue."
            // One job at a time per dictator session: until a job is finished, stopped or failed, a goal continues it
            // instead of starting another (live test: the dictator re-sent the goal mid-session and after confirm).
            const active = tctx.sessionID ? sessionJob(tctx.sessionID) : undefined
            const planning = active && !["done", "stopped", "failed", "integrate", "wrap"].includes(active.phase)
            const failed = !JOB_ID.test(text) && !planning ? recentFailure(active, text) : undefined
            if (failed) return failed
            const fresh = text.replace(/^retry:\s*/i, "")
            const out = JOB_ID.test(text) ? await runner(tctx.sessionID).continueJob(text)
              : planning ? await runner(tctx.sessionID).continueJob(active.id)
              : await runner(tctx.sessionID).start(fresh, tctx.sessionID)
            if (out.job.facilitator === undefined && tctx.sessionID) {
              out.job.facilitator = tctx.sessionID
              saveJob(project, out.job)
            }
            return out.kind === "plan" ? planText(out.job) : out.text
          },
          questions: async (job, tree, tctx) => runner(tctx.sessionID).questions(job.trim(), tree),
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

    // What the dictator must do in its next turn, per session; set from the user's turn, used by every provider
    // turn of that answer (steering through a system block, Phase A1), replaced at the user's next turn.
    const steering = new Map<string, string>()

    await ctx.session.hook("prompt", async (input) => {
      const sessionID = input.sessionID
      const text = String(input.prompt?.text ?? "")
      if (!sessionID || !text) return
      steering.delete(sessionID)
      const job = sessionJob(sessionID)
      if (!job) return
      try {
        const pin = matchShortcut(text)
        if (pin) {
          if (pin.level === "job") job.pins = { ...job.pins, [pin.key]: pin.value }
          else if (pin.taskId) job.taskPins = { ...job.taskPins, [pin.taskId]: { ...job.taskPins?.[pin.taskId], [pin.key]: pin.value } }
          saveJob(project, job)
          steering.set(sessionID, `[job ${job.id}] Noted the user's preset: ${pin.key} = ${pin.value}${pin.taskId ? ` for ${pin.taskId}` : ""}. Confirm it in one sentence.`)
          return
        }
        const next = await runner(sessionID).answer(job.id, text)
        if (next) steering.set(sessionID, next)
      } catch (err) {
        log("warn", `planning turn failed: ${String(err)}`)
      }
    })

    await ctx.session.hook("context", (input) => {
      // The tools exist for every agent; only the dictator sees them.
      if (input.agent !== DICTATOR.agent) {
        if (input.tools) for (const id of TOOL_IDS) delete input.tools[id]
        if (input.sessionID && watchdog.watching(input.sessionID)) {
          const signal = watchdog.onTurn(input.sessionID, input.messages)
          if (signal) stop(input.sessionID, signal)
        }
        return
      }
      const note = input.sessionID ? steering.get(input.sessionID) : undefined
      if (note && Array.isArray(input.system)) input.system.push({ type: "text", text: note })
    })
  },
}
