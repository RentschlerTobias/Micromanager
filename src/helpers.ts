// Helpers: a worker that writes asks an explorer or a researcher one question and gets the answer back as a tool result
// (the explore and research tools).
//
// A writer used to have no way to learn anything its own tools did not reach: no web (a coder that needed an API's
// docs could not read them) and no sub-agents (only the micromanager delegates, so it can count the workers). Opening
// the subagent tool to workers would make every such call a new task of the job, with a worktree, a merge and a place
// on the micromanager's list. A helper is none of that: it reads in the asking writer's own directory (so it sees the
// writer's uncommitted change), it runs while the writer waits, it cannot ask a helper of its own, and a writer gets a
// few per task. Its session is a child of the writer's, so OpenCode shows it under the writer, and the plugin treats it
// like any other worker: the permission hook, the guards on web content, the watchdog and the journal.

import { lastAssistantText } from "./brief.ts"
import { redact } from "./jev.ts"
import { roleById, type Role } from "./roles.ts"
import { toModel, type SessionApi } from "./runner.ts"

export type HelperRole = "explore" | "research"
export const HELPER_ROLES: readonly HelperRole[] = ["explore", "research"]
export const MAX_HELPERS = 3 // per writer session: enough for the questions a task raises, not a second job
export const HELPER_STEPS = 60
const MAX_ANSWER = 12_000
const TIMEOUT_MS = 10 * 60_000

// The writer asking, as the plugin knows it.
export interface Caller {
  readonly dir: string // where the writer works: the helper reads there
  readonly label: string // "T3 of job-…", for the helper's title and brief
  readonly task: string // what the writer is working on
}

export interface HelperDeps {
  readonly session: SessionApi
  readonly caller: (sessionID: string) => Caller | undefined // undefined: not a writer of the micromanager
  readonly model: (role: Role) => Promise<string>
  // The helper session exists: the plugin registers it with the permission hook and the watchdog before its first turn.
  readonly started: (helper: string, caller: string, dir: string, brief: string) => void
  readonly ended?: (helper: string) => void
  readonly journal?: (entry: Record<string, unknown>) => void
  readonly timeoutMs?: number
}

export function helperBrief(role: HelperRole, caller: Caller, question: string): string {
  const how = role === "explore"
    ? "Answer it from the code and the git history in your directory, which holds the worker's change as it is right now, uncommitted edits included."
    : "Look it up in the documentation and sources on the web, and in your directory where it helps; cite the URLs you used."
  return [
    `A worker on ${caller.label} asks you one question and waits for your answer. Its task: ${caller.task}`,
    "",
    `Question: ${question}`,
    "",
    how,
    "Answer only what was asked, as briefly as the answer allows: paths with line numbers and short excerpts, at most about 40 lines. Change nothing. If you cannot answer it, say what you found and what is missing.",
  ].join("\n")
}

export class Helpers {
  readonly #d: HelperDeps
  readonly #used = new Map<string, number>()

  constructor(deps: HelperDeps) {
    this.#d = deps
  }

  async ask(callerSession: string, role: HelperRole, question: string): Promise<string> {
    const caller = this.#d.caller(callerSession)
    if (!caller) return "Only a worker that changes files for the micromanager may ask a helper."
    if (!question.trim()) return "Ask one question, in a sentence."
    const used = this.#used.get(callerSession) ?? 0
    if (used >= MAX_HELPERS) {
      return `You asked ${MAX_HELPERS} helpers in this task already. Work with what you have, and name what you still need in your report.`
    }
    this.#used.set(callerSession, used + 1)
    const r = roleById(role)!
    const model = await this.#d.model(r)
    const brief = helperBrief(role, caller, question.trim())
    const s = await this.#d.session.create({
      parentID: callerSession,
      title: `${caller.label} · ${r.agent} · ${question.trim().slice(0, 60)}`,
      agent: r.agent,
      model: toModel(model),
      location: { directory: caller.dir },
    })
    this.#d.started(s.id, callerSession, caller.dir, brief)
    const start = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    try {
      await this.#d.session.prompt({ sessionID: s.id, text: redact(brief) })
      timedOut = await Promise.race([
        this.#d.session.wait({ sessionID: s.id }).then(() => false),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), this.#d.timeoutMs ?? TIMEOUT_MS) }),
      ])
    } finally {
      clearTimeout(timer)
    }
    if (timedOut) await this.#d.session.interrupt({ sessionID: s.id }).catch(() => undefined)
    const answer = lastAssistantText(await this.#d.session.context({ sessionID: s.id }).catch(() => undefined))
    this.#d.ended?.(s.id)
    this.#d.journal?.({ kind: "helper", sessionID: callerSession, helper: s.id, role, model, question: question.slice(0, 300), chars: answer.length, ms: Date.now() - start, timedOut })
    if (!answer) return `The ${r.agent} ended without an answer${timedOut ? " (it ran out of time)" : ""}. Go on without it, and name the open question in your report.`
    const cut = answer.length > MAX_ANSWER ? `${answer.slice(0, MAX_ANSWER)}\n[cut at ${MAX_ANSWER} characters]` : answer
    return `${timedOut ? "[the helper ran out of time; this is what it had]\n" : ""}${cut}`
  }
}
