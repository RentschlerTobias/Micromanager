// The memory's read path: what goes into a prompt.
//
// - Core memory (pinned entries of the user, global and the project) is a block in the system prompt, snapshotted per
//   session and refreshed only at a context epoch (src/context/manager.ts), so it never breaks the prompt cache.
// - A worker's brief gets the entries that help its task, once, when it is delegated: search, then Jev (N5's question
//   per entry), then diversity, then a character budget per role instead of a fixed count; what does not fit is listed
//   in one line each, for memory_search.
// - The micromanager gets the same for each new message of the user, at the request's end only (never stored), with
//   entries it got in its last turns held back, so the same notes do not come back every turn (openMemory's failure).

import type { Decider } from "../backends.ts"
import { NOUL_FLOOR } from "../catalog.ts"
import type { Question } from "../jev.ts"
import type { Embedder } from "./embed.ts"
import { diversify, search, type Hit } from "./search.ts"
import type { Entry, MemoryStore } from "./store.ts"

// Characters of recalled notes per role's brief; a coder starts with no context and lives long, a reader is short.
export const BRIEF_BUDGET: Record<string, number> = { code: 1600, debug: 1600, plan: 1600, test: 1200, write: 1200, review: 1200, visual: 1200, explore: 800, research: 800, micromanager: 1200 }
const DEFAULT_BUDGET = 1000
export const HOLD_TURNS = 3 // a note given to the micromanager is held back for this many of its user turns

export interface Recalled {
  readonly picked: readonly Hit[]
  readonly more: readonly Hit[]
  readonly vectors: boolean
}

// Without Jev: a vector match must be close; keywords alone decide only while there are no vectors.
const plausible = (vectors: boolean) => (h: Hit) => (vectors ? (h.similarity ?? 0) >= 0.5 : (h.keywordRank ?? 99) <= 3)

export function recallQuestions(hits: readonly Hit[]): Record<string, Question> {
  return Object.fromEntries(hits.map((h, i) => [`help.${i}`, { type: "noul", instructions: `Knowing "${h.entry.text.slice(0, 300)}" helps an agent do the task in the state.` } satisfies Question]))
}

export async function recall(store: MemoryStore, embedder: Embedder | undefined, decider: Decider | undefined, task: string, o: { project?: string; role?: string; exclude?: ReadonlySet<string>; journal?: (e: Record<string, unknown>) => void; session?: string } = {}): Promise<Recalled> {
  const budget = BRIEF_BUDGET[o.role ?? ""] ?? DEFAULT_BUDGET
  const found = await search(store, embedder, task.slice(0, 4000), { ...(o.project ? { project: o.project } : {}), task: "recall", limit: 20, ...(o.exclude ? { exclude: o.exclude } : {}) })
  let hits = [...found.hits]
  if (hits.length && decider) {
    const asked = await decider.ask("N5m", { task: task.slice(0, 2000), role: o.role, entries: hits.map((h, i) => ({ i, text: h.entry.text.slice(0, 300) })) }, recallQuestions(hits), { job: o.session ?? "" }).catch(() => undefined)
    const a = asked?.decision.answers ?? {}
    if (Object.keys(a).length) hits = hits.filter((_, i) => { const x = a[`help.${i}`]; return x?.type === "noul" ? x.noul >= NOUL_FLOOR : false })
    else hits = hits.filter(plausible(found.vectors))
  } else hits = hits.filter(plausible(found.vectors))
  const vecs = embedder && found.vectors ? new Map(store.vectors(embedder.o.model, o.project).map((v) => [v.id, v.values])) : new Map<string, Float32Array>()
  const ordered = diversify(hits, (id) => vecs.get(id), hits.length)
  const picked: Hit[] = []
  const more: Hit[] = []
  let used = 0
  for (const h of ordered) {
    if (used + h.entry.text.length <= budget) { picked.push(h); used += h.entry.text.length }
    else more.push(h)
  }
  store.markRecalled(picked.map((h) => h.entry.id))
  o.journal?.({ kind: "recall", session: o.session, role: o.role, query: task.slice(0, 200), vectors: found.vectors, candidates: found.hits.map((h) => ({ id: h.entry.id, score: +h.score.toFixed(4), sim: h.similarity === undefined ? undefined : +h.similarity.toFixed(3) })), picked: picked.map((h) => h.entry.id), more: more.length })
  return { picked, more: more.slice(0, 5), vectors: found.vectors }
}

export function recallBlock(r: Recalled): string {
  if (!r.picked.length && !r.more.length) return ""
  const lines = ["[memory] Notes from earlier work on this project and others; check one before you rely on it:"]
  for (const h of r.picked) lines.push(`- ${h.entry.text}`)
  if (r.more.length) lines.push(`More in memory (memory_search finds them, if you can use it): ${r.more.map((h) => `"${h.entry.text.slice(0, 70)}"`).join("; ")}`)
  return lines.join("\n")
}

export function coreBlock(pinned: readonly Entry[]): string {
  if (!pinned.length) return ""
  const part = (title: string, es: readonly Entry[]) => (es.length ? [`${title}:`, ...es.map((e) => `- ${e.text}`)] : [])
  return [
    "[memory] Core memory: lasting facts kept for you; they hold unless the user or the code says otherwise.",
    ...part("About the user", pinned.filter((e) => e.scope === "user")),
    ...part("Across projects", pinned.filter((e) => e.scope === "global")),
    ...part("This project", pinned.filter((e) => e.scope === "project")),
  ].join("\n")
}

// Per session: the core block as of the session's last epoch, so the system prompt stays the same bytes between epochs.
export class CoreSnapshots {
  readonly #snap = new Map<string, string>()

  get(sessionID: string, make: () => string): string {
    let s = this.#snap.get(sessionID)
    if (s === undefined) { s = make(); this.#snap.set(sessionID, s) }
    return s
  }

  refresh(sessionID: string): void {
    this.#snap.delete(sessionID)
  }
}

// Per session: which entries the micromanager got in its recent user turns.
export class RecentRecalls {
  readonly #given = new Map<string, { id: string; turn: number }[]>()
  readonly #turns = new Map<string, number>()

  // A new user turn: returns the ids to hold back for it.
  next(sessionID: string): Set<string> {
    const turn = (this.#turns.get(sessionID) ?? 0) + 1
    this.#turns.set(sessionID, turn)
    const kept = (this.#given.get(sessionID) ?? []).filter((g) => turn - g.turn <= HOLD_TURNS)
    this.#given.set(sessionID, kept)
    return new Set(kept.map((g) => g.id))
  }

  given(sessionID: string, ids: readonly string[]): void {
    const turn = this.#turns.get(sessionID) ?? 0
    this.#given.set(sessionID, [...(this.#given.get(sessionID) ?? []), ...ids.map((id) => ({ id, turn }))])
  }
}
