// The memory's write path: a candidate fact becomes an entry only after search and Jev (N17) have seen it.
//
// Sources: a worker's LEARNED lines (at its end), the micromanager's memory_set/memory_replace. Each candidate is
// compared with its nearest entries (src/context/search.ts): a near-identical one (similarity ≥ 0.95) is a duplicate
// without asking; for the rest Jev answers what the candidate is to its neighbours (new, duplicate, refines one,
// contradicts one), whether it is lasting and useful, and whose it is (the user's, true across projects, or this
// project's). Vector similarity alone cannot tell a duplicate from a contradiction ("tests run with uv run pytest" vs
// "pytest without uv fails"), and Jev alone cannot see past the entries it is shown; together they scale.

import type { Decider } from "../backends.ts"
import { NOUL_FLOOR } from "../catalog.ts"
import type { Question } from "../jev.ts"
import type { Embedder } from "./embed.ts"
import { search, type Hit } from "./search.ts"
import type { Entry, MemoryStore, Scope } from "./store.ts"

export const DUPLICATE_SIMILARITY = 0.95
export const NEIGHBOURS = 5

export type Verdict =
  | { readonly kind: "added"; readonly entry: Entry }
  | { readonly kind: "refined"; readonly entry: Entry; readonly old: Entry }
  | { readonly kind: "duplicate"; readonly of: Entry }
  | { readonly kind: "contradicts"; readonly entry: Entry; readonly other: Entry }
  | { readonly kind: "dropped"; readonly why: string }

export interface Candidate {
  readonly text: string
  readonly source: string
  readonly scope?: Scope // the caller knows it (the micromanager's tool); otherwise Jev picks
  readonly pinned?: boolean
}

export function captureQuestions(c: Candidate, neighbours: readonly Hit[]): Record<string, Question> {
  const q: Record<string, Question> = {
    lasting: { type: "noul", instructions: `"${c.text}" is a lasting fact (a command, a path, a convention, a pitfall, a preference) that later, different tasks will need, not a detail of one task.` },
    useful: { type: "noul", instructions: `Knowing "${c.text}" would save a later agent real time or a mistake; it is not obvious from a quick look at the code.` },
  }
  if (!c.scope) {
    q.scope = { type: "choice", instructions: `Whose fact is "${c.text}"?`, criteria: { user: "the user's own preference or way of working, true in every project", global: "true across projects: a tool, a provider, the machine", project: "true for this one project only" } }
  }
  if (neighbours.length) {
    q.relation = {
      type: "choice",
      instructions: `How does "${c.text}" relate to the stored entries listed in the state as neighbours?`,
      criteria: { new: "it says something none of them says", duplicate: "one of them already says the same, in other words or another language", refines: "it says the same thing as one of them, more precisely or more up to date", contradicts: "it contradicts one of them" },
    }
    q.which = { type: "choice", instructions: `Which neighbour is the one it duplicates, refines or contradicts (the closest one if it is new)?`, criteria: Object.fromEntries(neighbours.map((n, i) => [`n${i}`, n.entry.text.slice(0, 200)])) }
  }
  return q
}

export async function capture(store: MemoryStore, embedder: Embedder | undefined, decider: Decider | undefined, c: Candidate, o: { project?: string; journal?: (e: Record<string, unknown>) => void } = {}): Promise<Verdict> {
  const text = c.text.trim().replace(/\s+/g, " ").slice(0, 500)
  if (text.length < 12) return { kind: "dropped", why: "too short to be a fact" }
  const found = await search(store, embedder, text, { ...(o.project ? { project: o.project } : {}), task: "dedupe", limit: NEIGHBOURS })
  const neighbours = found.hits.slice(0, NEIGHBOURS)
  const top = neighbours[0]
  const journal = (v: Verdict, extra: Record<string, unknown> = {}) => {
    o.journal?.({ kind: "memory.write", verdict: v.kind, text: text.slice(0, 200), source: c.source, project: o.project, vectors: found.vectors, top: top?.similarity, ...extra })
    return v
  }
  if (top && ((top.similarity ?? 0) >= DUPLICATE_SIMILARITY || top.entry.text.toLowerCase() === text.toLowerCase())) return journal({ kind: "duplicate", of: top.entry })
  const asked = decider ? await decider.ask("N17", { project: o.project, candidate: text, source: c.source, neighbours: neighbours.map((n, i) => ({ id: `n${i}`, text: n.entry.text, scope: n.entry.scope, similarity: n.similarity })) }, captureQuestions({ ...c, text }, neighbours), { job: c.source }).catch(() => undefined) : undefined
  const a = asked?.decision.answers ?? {}
  const jev = Object.keys(a).length > 0 // the rules backend answers nothing
  const noul = (k: string) => (a[k]?.type === "noul" ? (a[k] as { noul: number }).noul : undefined)
  const choice = (k: string) => (a[k]?.type === "choice" ? (a[k] as { choice: string }).choice : undefined)
  // Without Jev: keep what no neighbour comes close to, as a project fact; the micromanager's own words are kept anyway.
  if (!jev) {
    if (top && (top.similarity ?? (top.keywordRank === 1 ? 0.9 : 0)) >= 0.75) return journal({ kind: "duplicate", of: top.entry }, { jev: false })
    const entry = store.add({ scope: c.scope ?? "project", ...(o.project && (c.scope ?? "project") === "project" ? { project: o.project } : {}), text, pinned: c.pinned ?? false, source: c.source })
    return journal({ kind: "added", entry }, { jev: false })
  }
  if (!c.scope && ((noul("lasting") ?? 1) < NOUL_FLOOR || (noul("useful") ?? 1) < NOUL_FLOOR)) return journal({ kind: "dropped", why: "not lasting or not useful" }, { lasting: noul("lasting"), useful: noul("useful") })
  const scope = c.scope ?? ((choice("scope") as Scope | undefined) ?? "project")
  const where = { scope, ...(scope === "project" && o.project ? { project: o.project } : {}) }
  const relation = neighbours.length ? choice("relation") ?? "new" : "new"
  const other = neighbours[Number((choice("which") ?? "n0").slice(1))]?.entry ?? top?.entry
  if (relation === "duplicate" && other) return journal({ kind: "duplicate", of: other })
  if (relation === "refines" && other) {
    const entry = store.update(other.id, { text, ...where }, "refine")
    if (entry) return journal({ kind: "refined", entry, old: other })
  }
  const entry = store.add({ ...where, text, pinned: c.pinned ?? false, source: c.source, ...(relation === "contradicts" && other ? { replaces: other.id } : {}) })
  if (relation === "contradicts" && other) return journal({ kind: "contradicts", entry, other }, { other: other.id })
  return journal({ kind: "added", entry })
}

// A worker report's LEARNED lines (the shared worker prompt asks for them, src/roles.ts).
export function learnedLines(report: string): string[] {
  return [...report.matchAll(/^\s*[-*]?\s*\**LEARNED\**\s*:\**\s*(.+)$/gim)].map((m) => m[1]!.trim()).filter((l) => l && !/^(none|nothing|n\/a|-)\.?$/i.test(l))
}
