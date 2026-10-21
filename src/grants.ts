// A worker's request for a variable or a host the sandbox keeps from it (src/sandbox.ts). A test that needs
// DATABASE_URL, or a build that fetches from a host beyond the package registries, used to fail with no way to ask.
// Now the worker calls request_env or request_network with the name and why; the plugin decides in steps:
//   - never: a variable on the never list (sockets into the desktop, agent sockets, the plugin's own credentials), a
//     variable that is not set where the server runs, or a name or host refused before in this job;
//   - Jev: a variable that is a setting, not a secret (NODE_ENV, RUST_LOG), or a public host while the job holds no
//     secret, when Jev is sure;
//   - the user, with a form through the micromanager: everything else, and always a secret-looking variable or a host
//     asked for while the job's commands hold a secret (the form names it: a secret and an open host together are what
//     it takes to send the secret away).
// A grant holds for the job and is kept in its control file (src/control.ts), names and hosts only. The worker sees a
// variable's name, never its value, and no model ever does: Jev gets the value's shape at most.

import { formInput, grantForm } from "./forms.ts"
import { ENV_ALLOW, looksSecret, neverHanded, REGISTRIES } from "./sandbox.ts"

export type GrantKind = "env" | "network"
export type GrantedBy = "jev" | "user" | "timeout"

export const GRANT_TIMEOUT_MS = 10 * 60_000
// How sure Jev must be that a variable is a setting, or a host harmless, to grant it without the user.
export const GRANT_FLOOR = 0.9

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
// A host, or "*." and a host of at least two labels ("*.com" is no host).
const DOMAIN = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/

// What is wrong with a requested name or host, or undefined when it is one.
export function badName(kind: GrantKind, name: string): string | undefined {
  if (kind === "env") return NAME.test(name) ? undefined : `"${name}" is no variable name: letters, digits and _, not starting with a digit`
  return DOMAIN.test(name) ? undefined : `"${name}" is no host name: a name like api.example.com or *.example.com, without scheme, port or path`
}

const matches = (name: string, pattern: string) => (pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern)
const covers = (host: string, pattern: string) => host === pattern || (pattern.startsWith("*.") && host.endsWith(pattern.slice(1)))

// The facts a request is decided on.
export interface GrantFacts {
  readonly kind: GrantKind
  readonly name: string // a variable's name, or a host, lowercased
  readonly open: readonly string[] // the user's "env" / "network" setting and the job's grants
  readonly refused: readonly string[] // what the user refused in this job
  readonly value?: string // env: its value where the server runs; undefined when it is not set
  readonly sandboxed: boolean // network: without the sandbox nothing restricts it
  readonly secrets: readonly string[] // the secret-looking variables the job's commands hold
}

export type Triage =
  | { readonly verdict: "open"; readonly text: string } // nothing to grant: the worker has it already
  | { readonly verdict: "refused"; readonly text: string }
  | { readonly verdict: "jev" | "user"; readonly reason: string }

export function triage(f: GrantFacts): Triage {
  if (f.kind === "env") {
    if (neverHanded(f.name)) return { verdict: "refused", text: `${f.name} is never handed to a worker command: it opens the user's desktop, an agent socket or the plugin's own credentials. Carry on without it.` }
    if (f.value === undefined) return { verdict: "refused", text: `${f.name} is not set where the server runs, so there is nothing to hand on. If your task needs it, say so in your report: the user has to set it.` }
    if ([...ENV_ALLOW, ...f.open].some((p) => matches(f.name, p))) return { verdict: "open", text: `${f.name} is handed to your commands already. If a command still misses it, it is not the environment: look at how the command reads it.` }
    if (f.refused.includes(f.name)) return { verdict: "refused", text: `The user refused ${f.name} for this job. Do not ask again; carry on without it and say in your report what it was for.` }
    if (looksSecret(f.name, f.value)) return { verdict: "user", reason: "its name or value looks like a secret" }
    return { verdict: "jev", reason: "a setting, if Jev is sure it is no secret" }
  }
  if (!f.sandboxed) return { verdict: "open", text: "Your commands run without a sandbox, so the network is not restricted. If a host is unreachable, it is not the plugin." }
  if ([...REGISTRIES, ...f.open].some((p) => covers(f.name, p))) return { verdict: "open", text: `${f.name} is open to your commands already. If it is still unreachable, the cause is elsewhere (DNS, the host, a proxy setting of the tool).` }
  if (f.refused.includes(f.name)) return { verdict: "refused", text: `The user refused ${f.name} for this job. Do not ask again; carry on without it and say in your report what it was for.` }
  if (f.secrets.length) return { verdict: "user", reason: `the job's commands hold ${f.secrets.join(", ")}` }
  return { verdict: "jev", reason: "a public host, if Jev is sure it sends nothing private" }
}

// What Jev may see of a value: its length and the kinds of characters, never the value itself.
export function valueShape(value: string): string {
  const kinds = [
    /[a-z]/.test(value) && "lowercase letters", /[A-Z]/.test(value) && "uppercase letters", /\d/.test(value) && "digits",
    /[^A-Za-z0-9]/.test(value) && "other characters",
  ].filter(Boolean)
  return `${value.length} characters${kinds.length ? `: ${kinds.join(", ")}` : ""}`
}

// Jev's question about a request it may decide: the statement it gives the probability of.
export function harmlessQuestion(kind: GrantKind): { readonly type: "noul"; readonly instructions: string } {
  return kind === "env"
    ? { type: "noul", instructions: "This environment variable is a configuration setting (a mode, a log level, a flag, a path or a port), not a secret such as a token, key, password or a URL with credentials." }
    : { type: "noul", instructions: "This host is a public documentation, package, source or API host that a build or a test of a coding project plausibly needs, and reaching it from the project's commands sends nothing private." }
}

export function grantState(kind: GrantKind, name: string, why: string, task: string, value?: string): string {
  const what = kind === "env" ? `the environment variable ${name} (value: ${valueShape(value ?? "")})` : `network access to the host ${name}`
  return `A coding agent's shell commands run in a sandbox. Working on "${task}", it asks for ${what}. Its reason: ${why}`
}

export interface GrantRequest {
  readonly kind: GrantKind
  readonly name: string
  readonly why: string
  readonly sessionID: string // the waiting worker
  readonly parent: string // the micromanager session that puts the form to the user
  readonly task: string
  readonly project: string
  readonly jobId: string
  readonly secrets: readonly string[] // network: the secret-looking variables the job holds, named in the form
}

export interface PendingGrant extends GrantRequest {
  readonly id: string // "G1", the form's header
  readonly at: number
}

export type GrantAnswer = { readonly granted: boolean; readonly by: GrantedBy }

interface Waiting extends PendingGrant {
  readonly answer: Promise<GrantAnswer>
  readonly settle: (answer: GrantAnswer) => void
  timer?: ReturnType<typeof setTimeout>
}

// The requests waiting for the user. The worker's tool call waits on its promise; the form's answer, the worker's end
// or the timeout settles it.
export class GrantRequests {
  readonly #pending = new Map<string, Waiting>()
  readonly #journal: (entry: Record<string, unknown>) => void
  readonly #timeoutMs: number
  #n = 0

  constructor(journal: (entry: Record<string, unknown>) => void = () => {}, timeoutMs = GRANT_TIMEOUT_MS) {
    this.#journal = journal
    this.#timeoutMs = timeoutMs
  }

  // A request for the same name of the same job that waits already: the second worker waits on the first one's form.
  open(request: GrantRequest): { pending: PendingGrant; answer: Promise<GrantAnswer>; fresh: boolean } {
    const same = [...this.#pending.values()].find((p) => p.project === request.project && p.jobId === request.jobId && p.kind === request.kind && p.name === request.name)
    if (same) return { pending: strip(same), answer: same.answer, fresh: false }
    const id = `G${++this.#n}`
    let settle!: (answer: GrantAnswer) => void
    const answer = new Promise<GrantAnswer>((resolve) => (settle = resolve))
    const waiting: Waiting = { ...request, id, at: Date.now(), answer, settle }
    waiting.timer = setTimeout(() => {
      if (!this.#pending.delete(id)) return
      this.#journal({ kind: "grant", event: "timeout", id, grant: request.kind, name: request.name, sessionID: request.sessionID, job: request.jobId })
      settle({ granted: false, by: "timeout" })
    }, this.#timeoutMs)
    waiting.timer.unref?.()
    this.#pending.set(id, waiting)
    this.#journal({ kind: "grant", event: "asked", id, grant: request.kind, name: request.name, why: request.why.slice(0, 300), sessionID: request.sessionID, job: request.jobId })
    return { pending: strip(waiting), answer, fresh: true }
  }

  get(id: string): PendingGrant | undefined {
    const p = this.#pending.get(id)
    return p && strip(p)
  }

  // The user's answer. Returns the request it settled, or undefined when none waits under this id any more.
  answer(id: string, granted: boolean): PendingGrant | undefined {
    const p = this.#take(id)
    if (!p) return undefined
    this.#journal({ kind: "grant", event: "answered", id, grant: p.kind, name: p.name, granted, sessionID: p.sessionID, job: p.jobId, waitedMs: Date.now() - p.at })
    p.settle({ granted, by: "user" })
    return strip(p)
  }

  // The requests of workers that ended: refused quietly, nobody waits for them any more.
  drop(sessionIDs: readonly string[]): PendingGrant[] {
    const dropped = [...this.#pending.values()].filter((p) => sessionIDs.includes(p.sessionID))
    for (const p of dropped) {
      this.#take(p.id)
      this.#journal({ kind: "grant", event: "dropped", id: p.id, grant: p.kind, name: p.name, sessionID: p.sessionID, job: p.jobId })
      p.settle({ granted: false, by: "timeout" })
    }
    return dropped.map(strip)
  }

  #take(id: string): Waiting | undefined {
    const p = this.#pending.get(id)
    if (!p) return undefined
    this.#pending.delete(id)
    clearTimeout(p.timer)
    return p
  }
}

function strip(p: Waiting): PendingGrant {
  const { settle: _s, timer: _t, answer: _a, ...shown } = p
  return shown
}

// The note that wakes the micromanager: the form to put to the user, as it is.
export function grantNote(p: PendingGrant, timeoutMs = GRANT_TIMEOUT_MS): string {
  const what = p.kind === "env" ? `the variable ${p.name}` : `the host ${p.name}`
  return `[micromanager] ${p.id}: worker ${p.task} waits for ${what} (${p.why.slice(0, 300)}). Only the user can grant it: ask them with the question tool, with exactly this input (a form that waits for their answer; it reaches the plugin by itself), then end your turn:\n${formInput(grantForm(p.id, p.kind, p.name, p.task, p.why, p.secrets))}\nWithout an answer it is refused in ${Math.round(timeoutMs / 60_000)} minutes and the worker carries on without it.`
}

// What the worker reads once its request is decided.
export function grantResult(kind: GrantKind, name: string, granted: boolean, by: "jev" | GrantedBy): string {
  if (granted) {
    return kind === "env"
      ? `${name} is granted for this job (${by === "jev" ? "a setting" : "the user said yes"}): every shell command you start from now on has it. Run the command again.`
      : `${name} is open for this job (${by === "jev" ? "a public host" : "the user said yes"}): every shell command you start from now on may reach it. Run the command again.`
  }
  return by === "timeout"
    ? `${name} is not granted: nobody answered in time. Carry on without it, and say in your report what you needed it for. Report STATUS: NEEDS_CONTEXT only if you genuinely cannot proceed without it.`
    : `${name} is refused for this job. Do not ask again or try it another way; carry on without it, and say in your report what you needed it for.`
}
