// The context manager: per session, what stays in the context the provider gets, applied in epochs.
//
// Two sets per session: `applied` (replacements in force) and `pending` (found since the last epoch, by the rules of
// src/context/rules.ts or by Jev). Every request renders exactly `applied`, so between epochs the prompt's prefix is
// byte-identical and the provider's cache holds; `pending` only grows. An epoch (src/context/policy.ts) moves all of
// `pending` into `applied` at once, breaking the cache once, from the first changed message on. `applied` is kept on
// disk, so a restarted server renders the same bytes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { ledger, resultText, type Ledger, type Message } from "./ledger.ts"
import { DEFAULT_POLICY, epochDue, type EpochVerdict, type PolicyOptions, type Prices } from "./policy.ts"
import { DEFAULT_RULES, findReplacements, type Replacement, type RuleOptions } from "./rules.ts"

export interface ApplyInput {
  readonly prices?: Prices
  readonly ceilingTokens?: number // the role's ceiling (src/context/plugin.ts)
  readonly judged?: readonly Replacement[] // replacements Jev decided on (stage 2)
  readonly extraCost?: number
  readonly baseChars?: number // the system prompt's characters: part of the context, never replaced
}

export interface ApplyResult {
  readonly epoch?: EpochVerdict & { readonly applied: number; readonly savedChars: number; readonly invalidatedTokens: number }
  readonly renderedChars: number // characters the applied replacements removed in this request
  readonly pending: number
  readonly contextTokens: number // estimate after rendering
}

interface SessionState {
  applied: Map<string, Replacement>
  pending: Map<string, Replacement>
  epochs: number
}

export interface ManagerOptions {
  readonly rules?: Partial<RuleOptions>
  readonly policy?: Partial<PolicyOptions>
  readonly journal?: (entry: Record<string, unknown>) => void
  readonly dir?: string | null // where `applied` is kept; null keeps it in memory only (tests, the replay bench)
}

export function contextDir(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "micromanager", "context")
}

// Puts the given replacements into the messages, in place (the hook's messages are what the provider gets).
export function render(messages: Message[], applied: ReadonlyMap<string, Replacement>): number {
  let removed = 0
  if (!applied.size) return 0
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const p of m.content) {
      const r = p.id ? applied.get(p.id) : undefined
      if (!r) continue
      if (p.type === "tool-result" && r.result !== undefined) {
        removed += resultText(p).length - r.result.length
        p.result = { type: "text", value: r.result }
      }
      if (p.type === "tool-call" && r.input !== undefined) {
        removed += JSON.stringify(p.input ?? {}).length - JSON.stringify(r.input).length
        p.input = r.input
      }
    }
  }
  return removed
}

export class ContextManager {
  readonly #rules: RuleOptions
  readonly #policy: PolicyOptions
  readonly #journal: (entry: Record<string, unknown>) => void
  readonly #dir: string | null
  readonly #sessions = new Map<string, SessionState>()

  constructor(o: ManagerOptions = {}) {
    this.#rules = { ...DEFAULT_RULES, ...o.rules }
    this.#policy = { ...DEFAULT_POLICY, ...o.policy }
    this.#journal = o.journal ?? (() => {})
    this.#dir = o.dir === undefined ? contextDir() : o.dir
  }

  #state(sessionID: string): SessionState {
    let s = this.#sessions.get(sessionID)
    if (s) return s
    s = { applied: new Map(), pending: new Map(), epochs: 0 }
    const file = this.#dir ? join(this.#dir, `${sessionID}.json`) : undefined
    if (file && existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, "utf8")) as { applied?: Replacement[]; epochs?: number }
        for (const r of saved.applied ?? []) s.applied.set(r.id, r)
        s.epochs = saved.epochs ?? 0
      } catch {
        // a broken file starts the session over: the next epoch rewrites it
      }
    }
    this.#sessions.set(sessionID, s)
    return s
  }

  #save(sessionID: string, s: SessionState): void {
    if (!this.#dir) return
    try {
      mkdirSync(this.#dir, { recursive: true })
      writeFileSync(join(this.#dir, `${sessionID}.json`), JSON.stringify({ epochs: s.epochs, applied: [...s.applied.values()] }))
    } catch {
      // losing the file only costs one more cache break after a restart
    }
  }

  // How far the session got: epochs, what its applied replacements removed, what waits.
  stats(sessionID: string): { epochs: number; savedChars: number; pending: number } {
    const s = this.#state(sessionID)
    return { epochs: s.epochs, savedChars: [...s.applied.values()].reduce((n, r) => n + r.saved, 0), pending: s.pending.size }
  }

  // The session's applied replacements, for the TUI and the journal.
  applied(sessionID: string): readonly Replacement[] {
    return [...this.#state(sessionID).applied.values()]
  }

  // One request of a session: collect, maybe start an epoch, render.
  apply(sessionID: string, messages: unknown, input: ApplyInput = {}): ApplyResult {
    if (!Array.isArray(messages)) return { renderedChars: 0, pending: 0, contextTokens: 0 }
    const msgs = messages as Message[]
    const s = this.#state(sessionID)
    const l = ledger(msgs)
    this.#collect(l, msgs, s, input.judged ?? [])
    const cpt = this.#policy.charsPerToken
    const at = new Map(l.items.map((i) => [i.id, i.message]))
    let epoch: ApplyResult["epoch"]
    if (s.pending.size) {
      const saved = [...s.pending.values()].reduce((n, r) => n + r.saved, 0)
      const first = Math.min(...[...s.pending.keys()].map((id) => at.get(id) ?? msgs.length))
      const appliedChars = [...s.applied.values()].reduce((n, r) => n + r.saved, 0)
      const invalidatedChars = l.chars - (l.offsets[first] ?? l.chars) - [...s.applied.values()].filter((r) => (at.get(r.id) ?? 0) >= first).reduce((n, r) => n + r.saved, 0)
      const verdict = epochDue({
        contextTokens: (l.chars + (input.baseChars ?? 0) - appliedChars) / cpt,
        savedTokens: saved / cpt,
        invalidatedTokens: Math.max(0, invalidatedChars - saved) / cpt,
        turns: l.turns,
        ...(input.prices ? { prices: input.prices } : {}),
        ...(input.extraCost ? { extraCost: input.extraCost } : {}),
      }, { ...this.#policy, ...(input.ceilingTokens ? { ceilingTokens: input.ceilingTokens } : {}) })
      if (verdict.due) {
        for (const [id, r] of s.pending) s.applied.set(id, r)
        const byReason: Record<string, number> = {}
        for (const r of s.pending.values()) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1
        epoch = { ...verdict, applied: s.pending.size, savedChars: saved, invalidatedTokens: Math.round(Math.max(0, invalidatedChars - saved) / cpt) }
        s.pending.clear()
        s.epochs++
        this.#save(sessionID, s)
        this.#journal({ kind: "context.epoch", sessionID, epoch: s.epochs, reason: verdict.reason, applied: epoch.applied, savedChars: saved, invalidatedTokens: epoch.invalidatedTokens, contextTokens: Math.round((l.chars + (input.baseChars ?? 0) - appliedChars) / cpt), gain: +verdict.gain.toFixed(5), cost: +verdict.cost.toFixed(5), byReason })
      }
    }
    const renderedChars = render(msgs, s.applied)
    return { ...(epoch ? { epoch } : {}), renderedChars, pending: s.pending.size, contextTokens: Math.round((l.chars + (input.baseChars ?? 0) - renderedChars) / cpt) }
  }

  #collect(l: Ledger, msgs: readonly Message[], s: SessionState, judged: readonly Replacement[]): void {
    const live = new Set(l.items.map((i) => i.id))
    // A call that is gone (OpenCode compacted the session) takes its pending replacement along.
    for (const id of s.pending.keys()) if (!live.has(id)) s.pending.delete(id)
    const results = new Map<string, string>()
    for (const m of msgs) {
      if (m.role !== "tool" || !Array.isArray(m.content)) continue
      for (const p of m.content) if (p.type === "tool-result" && p.id && !s.applied.has(p.id)) results.set(p.id, resultText(p))
    }
    for (const r of [...findReplacements(l, results, this.#rules), ...judged]) {
      if (s.applied.has(r.id) || !live.has(r.id)) continue
      s.pending.set(r.id, r)
    }
  }
}
