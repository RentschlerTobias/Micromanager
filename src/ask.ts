// Asks: a worker's permission request that nobody could decide is paused and put to the micromanager, and through it
// to the user, instead of being refused.
//
// Background workers used to get "refused, not queued" for every request Jev was not sure about (live runs: 568 times
// "Jev unsure", 90 "the user must decide"), and a worker that cannot run its own verification cannot finish its task.
// OpenCode parks a request whose effect stays "ask" until someone replies (Permission.assert waits on a deferred,
// whatever the session), and the plugin can reply through ctx.permission.reply. So the request waits, the micromanager
// is woken with what is asked and why, and the answer comes from the one who can give it:
//   - the micromanager, through answer_permission, for a request that clearly serves the task;
//   - the user, in their own turn ("yes", "yes always", "no"), for anything else, and always for a hard rule: the
//     micromanager is an LLM a worker's output can steer, so a hard rule never opens on its word;
//   - nobody, after the timeout: then it is refused as before, and the worker carries on without it.
// "once" lets this call run; "job" also lets the exact same request run for the rest of the job; "refuse" fails it with
// the reason. OpenCode's own "always" is never used: it writes a rule into the project for good.

export type AskDecision = "once" | "job" | "refuse"
export type AskedBy = "micromanager" | "user" | "timeout"

export const ASK_TIMEOUT_MS = 10 * 60_000

export interface AskRequest {
  readonly sessionID: string // the paused worker
  readonly parent: string // the micromanager session that answers for it
  readonly task: string // the worker's task, as the micromanager knows it ("T2 Wire percent into summary")
  readonly agent: string
  readonly action: string
  readonly resources: readonly string[]
  readonly reason: string // why it was not decided automatically
  readonly hard: boolean // a hard rule: only the user may open it
}

export interface PendingAsk extends AskRequest {
  readonly id: string // "A1", what the micromanager and the user refer to
  readonly at: number
}

// How a paused request is let go or failed: bound to the plugin instance whose permission service holds it.
export type Reply = (decision: "once" | "reject", message?: string) => Promise<void>

export interface Answered {
  readonly text: string // what the micromanager is told
  readonly ask?: PendingAsk
}

export function askKey(action: string, resources: readonly string[]): string {
  return `${action}\0${resources.map((r) => r.trim().replace(/\s+/g, " ")).join("\0")}`
}

// The user's answer, in English or German, as short as people answer. Anything else is not an answer.
export function askAnswer(text: string): AskDecision | undefined {
  const t = text.trim().toLowerCase().replace(/[.!?"']+$/g, "").replace(/^["']/, "").replace(/\s+/g, " ")
  if (["yes always", "always", "allow always", "for the job", "yes for the job", "ja immer", "immer", "für den job"].includes(t)) return "job"
  if (["yes", "y", "yeah", "yep", "sure", "ok", "okay", "allow", "allow it", "once", "allow once", "go ahead", "do it", "ja", "einmal", "ja einmal", "erlauben"].includes(t)) return "once"
  if (["no", "n", "nope", "nah", "deny", "refuse", "no way", "nein", "ablehnen", "verweigern"].includes(t)) return "refuse"
  return undefined
}

export class Asks {
  readonly #pending = new Map<string, PendingAsk & { reply: Reply; timer?: ReturnType<typeof setTimeout> }>()
  readonly #granted = new Map<string, Set<string>>() // micromanager session -> keys allowed for the job
  readonly #refused = new Map<string, Set<string>>() // micromanager session -> keys the user or micromanager refused
  readonly #journal: (entry: Record<string, unknown>) => void
  readonly #timeoutMs: number
  #n = 0

  constructor(journal: (entry: Record<string, unknown>) => void = () => {}, timeoutMs = ASK_TIMEOUT_MS) {
    this.#journal = journal
    this.#timeoutMs = timeoutMs
  }

  // What was decided before about exactly this request in this micromanager's job: asked once, never asked again.
  standing(parent: string, action: string, resources: readonly string[]): "allow" | "deny" | undefined {
    const key = askKey(action, resources)
    if (this.#refused.get(parent)?.has(key)) return "deny"
    if (this.#granted.get(parent)?.has(key)) return "allow"
    return undefined
  }

  open(request: AskRequest, reply: Reply): PendingAsk {
    const ask: PendingAsk & { reply: Reply; timer?: ReturnType<typeof setTimeout> } = { ...request, id: `A${++this.#n}`, at: Date.now(), reply }
    this.#pending.set(ask.id, ask)
    ask.timer = setTimeout(() => void this.answer(ask.id, "refuse", "timeout"), this.#timeoutMs)
    ask.timer.unref?.()
    this.#journal({ kind: "ask", event: "opened", id: ask.id, sessionID: ask.sessionID, parent: ask.parent, agent: ask.agent, action: ask.action, resources: ask.resources, reason: ask.reason, hard: ask.hard })
    const { reply: _reply, timer: _timer, ...shown } = ask
    return shown
  }

  get(id: string): PendingAsk | undefined {
    return this.#pending.get(id)
  }

  // The oldest request still waiting for this micromanager's answer: the one the user's next "yes" or "no" is about.
  oldest(parent: string): PendingAsk | undefined {
    return [...this.#pending.values()].filter((a) => a.parent === parent).sort((a, b) => a.at - b.at)[0]
  }

  waiting(sessionID: string): boolean {
    return [...this.#pending.values()].some((a) => a.sessionID === sessionID)
  }

  async answer(id: string, decision: AskDecision, by: AskedBy, note = ""): Promise<Answered> {
    const ask = this.#pending.get(id)
    if (!ask) return { text: `There is no request ${id} waiting: it was answered already, or it timed out.` }
    if (ask.hard && by === "micromanager" && decision !== "refuse") {
      return { text: `${id} is a hard rule (${ask.reason}): only the user can allow it. Show them the request as it is and end your turn; their answer reaches the plugin by itself.`, ask }
    }
    this.#pending.delete(id)
    clearTimeout(ask.timer)
    const key = askKey(ask.action, ask.resources)
    const who = by === "timeout" ? "nobody answered in time" : `the ${by}`
    if (decision === "refuse") {
      if (by !== "timeout") this.#set(this.#refused, ask.parent, key)
      // OpenCode fails every other paused request of the same session with a reject, so they leave the list too.
      for (const [other, a] of this.#pending) if (a.sessionID === ask.sessionID) { clearTimeout(a.timer); this.#pending.delete(other) }
      const message = by === "timeout"
        ? `This is refused, not queued: nobody answered in time (${ask.reason}). It does not stop your task: carry on without it, and say in your report what you wanted it for and what you did instead. Report STATUS: NEEDS_CONTEXT only if you genuinely cannot proceed without it.`
        : `Refused by the ${by}${note ? `: ${note}` : ""}. Do not try it another way; carry on without it, and say in your report what you wanted it for. Report STATUS: NEEDS_CONTEXT only if you genuinely cannot proceed without it.`
      await ask.reply("reject", message).catch(() => undefined)
    } else {
      if (decision === "job") this.#set(this.#granted, ask.parent, key)
      await ask.reply("once").catch(() => undefined)
    }
    this.#journal({ kind: "ask", event: "answered", id, sessionID: ask.sessionID, parent: ask.parent, action: ask.action, resources: ask.resources, decision, by, note: note.slice(0, 300), waitedMs: Date.now() - ask.at })
    const verdict = decision === "refuse" ? "refused" : decision === "job" ? "allowed for the rest of the job" : "allowed once"
    return { text: `${id} ${verdict} (${who}); the worker ${decision === "refuse" ? "gets the refusal with the reason" : "goes on"}.`, ask }
  }

  // The paused requests of sessions that ended or were stopped: nobody needs their answer any more, so they are failed
  // quietly and leave the list, and the caller tells the micromanager they are void (src/plugin.ts release).
  async drop(sessionIDs: readonly string[], why: string): Promise<PendingAsk[]> {
    const dropped: PendingAsk[] = []
    for (const [id, ask] of this.#pending) {
      if (!sessionIDs.includes(ask.sessionID)) continue
      this.#pending.delete(id)
      clearTimeout(ask.timer)
      await ask.reply("reject", `This request is void: ${why}.`).catch(() => undefined)
      this.#journal({ kind: "ask", event: "dropped", id, sessionID: ask.sessionID, parent: ask.parent, why, waitedMs: Date.now() - ask.at })
      const { reply: _reply, timer: _timer, ...shown } = ask
      dropped.push(shown)
    }
    return dropped
  }

  #set(map: Map<string, Set<string>>, parent: string, key: string): void {
    const set = map.get(parent) ?? new Set<string>()
    set.add(key)
    map.set(parent, set)
  }
}

// The note that wakes the micromanager. Everything needed to decide is in it.
export function askNote(ask: PendingAsk, timeoutMs = ASK_TIMEOUT_MS): string {
  const what = `${ask.action}: ${ask.resources.join(" | ").slice(0, 600)}`
  const minutes = Math.round(timeoutMs / 60_000)
  const head = `[jev-micromanager] ${ask.id}: worker ${ask.task} (${ask.agent}, session ${ask.sessionID}) is paused on a permission request until it is answered.\nRequest: ${what}\nWhy it was not decided automatically: ${ask.reason}`
  const end = `Without an answer it is refused in ${minutes} minutes and the worker carries on without it.`
  if (ask.hard) {
    return `${head}\nThis is a hard rule: only the user can allow it. Show them the request and why the worker wants it, in one or two sentences, ask "yes, yes always (for this job) or no?", call no tool and end your turn. Their answer reaches the plugin by itself. ${end}`
  }
  return `${head}\nDecide it: if it clearly serves the worker's task and reaches nothing outside the project, call answer_permission with id ${ask.id} and decision once (this call) or job (this exact request for the rest of the job), inside the execute tool: await tools.answer_permission({ id: "${ask.id}", decision: "once", note: "" }). If it is risky, outside the task, or you are not sure, ask the user instead: show the request and why, ask "yes, yes always or no?", call no tool and end your turn; their answer reaches the plugin by itself. To refuse it yourself, call answer_permission with decision refuse and a note why. ${end}`
}
