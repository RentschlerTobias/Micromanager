// Jev compaction of the micromanager's context (the user's request after reading about Jev token savings, 2026-10-05).
// The orchestrator is the biggest consumer: in a real session it carried 360k input tokens, its workers 10-40k each,
// because every turn resends every old tool result (task reports, reads, refused attempts).
//
// Before each of its turns, old and large tool results become candidates; Jev answers per candidate whether the
// micromanager still needs it; the ones it does not are replaced by a one-line stub that says how to get them back. The
// context hook's messages are what the provider gets (Phase E spike: a replaced tool result never reached the model),
// and the hook is awaited, so Jev can answer in time.
//
// A decision sticks: a pruned result stays pruned in every later turn, so the history's prefix does not change back
// and forth (prompt caches). A kept one is asked again only after it has aged.

import { NOUL_FLOOR } from "./catalog.ts"
import type { Decider } from "./backends.ts"
import type { Question } from "./jev.ts"

// The context hook's message shapes (opencode 2.0.18, seen in the spike).
interface Part {
  type?: string
  id?: string
  name?: string
  input?: unknown
  text?: string
  result?: { type?: string; value?: unknown }
}
interface Message {
  role?: string
  content?: Part[] | string
}

export interface Candidate {
  readonly id: string // the tool call id
  readonly tool: string
  readonly input: string
  readonly size: number // characters of its result
  readonly age: number // assistant turns since it came in
  readonly head: string // the start of the result, for the decision
}

export interface CompactOptions {
  readonly keepTurns: number // results of the last turns are never candidates
  readonly minChars: number // smaller results are not worth a decision
  readonly startChars: number // compaction starts when candidates hold this much
  readonly reaskAge: number // a kept result is asked about again after this many more turns
  readonly ruleAge: number // without an answer, results older than this go
}

export const DEFAULT_COMPACT: CompactOptions = { keepTurns: 2, minChars: 800, startChars: 20_000, reaskAge: 6, ruleAge: 8 }

const valueOf = (p: Part) => (typeof p.result?.value === "string" ? p.result.value : p.result?.value === undefined ? "" : JSON.stringify(p.result.value))

export function stub(c: Pick<Candidate, "tool" | "input" | "size">): string {
  return `[micromanager: this earlier ${c.tool} result (${c.size} characters; ${c.input.slice(0, 120)}) was dropped from your context, as it is no longer needed; call the tool again if you need it]`
}

// Old, large tool results, with their call's input and their age in assistant turns.
export function candidates(messages: readonly Message[], o: CompactOptions = DEFAULT_COMPACT): Candidate[] {
  const inputs = new Map<string, string>()
  const out: Candidate[] = []
  let assistantTurns = 0
  const seen: { part: Part; at: number }[] = []
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    if (m.role === "assistant") {
      assistantTurns++
      for (const p of m.content) if (p.type === "tool-call" && p.id) inputs.set(p.id, JSON.stringify(p.input ?? {}))
    }
    if (m.role === "tool") for (const p of m.content) if (p.type === "tool-result" && p.id) seen.push({ part: p, at: assistantTurns })
  }
  for (const { part, at } of seen) {
    const text = valueOf(part)
    const age = assistantTurns - at
    if (age < o.keepTurns || text.length < o.minChars || text.startsWith("[micromanager: this earlier")) continue
    out.push({ id: part.id!, tool: part.name ?? "tool", input: inputs.get(part.id!) ?? "", size: text.length, age, head: text.slice(0, 400) })
  }
  return out
}

// Replaces the results of the given calls in place; returns the characters removed.
export function prune(messages: Message[], drop: ReadonlyMap<string, Candidate>): number {
  let removed = 0
  for (const m of messages) {
    if (m.role !== "tool" || !Array.isArray(m.content)) continue
    for (const p of m.content) {
      const c = p.type === "tool-result" && p.id ? drop.get(p.id) : undefined
      if (!c || !p.result) continue
      const before = valueOf(p).length
      p.result = { type: "text", value: stub(c) }
      removed += before - stub(c).length
    }
  }
  return removed
}

export function compactQuestions(cands: readonly Candidate[]): Record<string, Question> {
  return Object.fromEntries(cands.map((c, i) => [`needed.${i}`, {
    type: "noul",
    instructions: `The orchestrator still needs the result of call ${i} (${c.tool}, ${c.input.slice(0, 160)}) to finish the user's request: it is not yet acted on, and no later result replaces it.`,
  } satisfies Question]))
}

// The last user request and the orchestrator's last words: what "still needed" is judged against.
function focus(messages: readonly Message[]): { request: string; latest: string } {
  const text = (m: Message) => (typeof m.content === "string" ? m.content : (m.content ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join(" "))
  const users = messages.filter((m) => m.role === "user")
  const assistants = messages.filter((m) => m.role === "assistant").map(text).filter(Boolean)
  return { request: text(users.at(-1) ?? {}).slice(0, 2000), latest: (assistants.at(-1) ?? "").slice(0, 1500) }
}

export class Compactor {
  readonly #decider: Decider | undefined
  readonly #o: CompactOptions
  readonly #journal: (entry: Record<string, unknown>) => void
  readonly #pruned = new Map<string, Map<string, Candidate>>() // session -> call id -> what was dropped
  readonly #kept = new Map<string, Map<string, number>>() // session -> call id -> its age when kept

  constructor(decider: Decider | undefined, journal: (entry: Record<string, unknown>) => void, options: Partial<CompactOptions> = {}) {
    this.#decider = decider
    this.#journal = journal
    this.#o = { ...DEFAULT_COMPACT, ...options }
  }

  // One turn of the micromanager: decides on new candidates when it is worth it, then prunes everything decided so far.
  async apply(sessionID: string, messages: unknown): Promise<{ removed: number; asked: number }> {
    if (!Array.isArray(messages)) return { removed: 0, asked: 0 }
    const msgs = messages as Message[]
    const pruned = this.#pruned.get(sessionID) ?? new Map<string, Candidate>()
    const kept = this.#kept.get(sessionID) ?? new Map<string, number>()
    this.#pruned.set(sessionID, pruned)
    this.#kept.set(sessionID, kept)
    const cands = candidates(msgs, this.#o).filter((c) => !pruned.has(c.id))
    const open = cands.filter((c) => !kept.has(c.id) || c.age - kept.get(c.id)! >= this.#o.reaskAge)
    const load = cands.reduce((n, c) => n + c.size, 0)
    let asked = 0
    if (open.length && load >= this.#o.startChars) {
      const answers = this.#decider
        ? (await this.#decider.ask("N14", { ...focus(msgs), results: open.map((c, i) => ({ call: i, tool: c.tool, input: c.input.slice(0, 300), age: c.age, start: c.head })) }, compactQuestions(open), { job: sessionID }).catch(() => undefined))?.decision.answers ?? {}
        : {}
      asked = open.length
      open.forEach((c, i) => {
        const a = answers[`needed.${i}`]
        const needed = a?.type === "noul" ? a.noul >= NOUL_FLOOR : c.age < this.#o.ruleAge
        if (needed) kept.set(c.id, c.age)
        else pruned.set(c.id, c)
      })
    }
    const removed = prune(msgs, pruned)
    if (asked) this.#journal({ kind: "compaction", sessionID, asked, pruned: pruned.size, removedChars: removed, candidates: cands.length })
    return { removed, asked }
  }
}
