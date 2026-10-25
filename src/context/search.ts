// Hybrid search over the memory (src/context/store.ts), built against what went wrong in openMemory, where the same
// entries came back for every prompt:
// - keywords (BM25) and vectors are fused by rank (reciprocal rank fusion), so neither a vague vector match nor a
//   common word alone wins;
// - entries that are recalled for everything are damped a little;
// - the picked set is diversified (maximal marginal relevance), so three wordings of one fact do not fill a budget;
// - entries injected in the last turns can be held back by the caller (src/context/recall.ts).
// Without the embedding service it is keyword search, and says so.

import { cosine, type Embedder, type Task } from "./embed.ts"
import type { Entry, MemoryStore } from "./store.ts"

export interface Hit {
  readonly entry: Entry
  readonly score: number
  readonly similarity?: number // cosine to the query, when vectors were used
  readonly keywordRank?: number
  readonly vectorRank?: number
}

export interface SearchResult {
  readonly hits: readonly Hit[]
  readonly vectors: boolean // false: the embedding service was down, keywords only
}

const RRF_K = 60

// Fills in vectors the index lacks (a batch per call), so a service that was down catches up.
export async function backfill(store: MemoryStore, embedder: Embedder, limit = 32): Promise<number> {
  const missing = store.missingVectors(embedder.o.model, limit)
  if (!missing.length || !embedder.available) return 0
  const vs = await embedder.embed(missing.map((e) => e.text))
  if (!vs) return 0
  missing.forEach((e, i) => store.setVector(e.id, { model: embedder.o.model, values: vs[i]! }))
  return missing.length
}

export async function search(store: MemoryStore, embedder: Embedder | undefined, query: string, o: { project?: string; task: Task; limit?: number; exclude?: ReadonlySet<string> }): Promise<SearchResult> {
  const limit = o.limit ?? 20
  const keyword = store.keyword(query, o.project, 30)
  let vectorRanks: { id: string; rank: number; sim: number }[] = []
  let usedVectors = false
  if (embedder) {
    await backfill(store, embedder)
    const q = await embedder.embed([query], o.task)
    if (q) {
      usedVectors = true
      vectorRanks = store.vectors(embedder.o.model, o.project)
        .map((v) => ({ id: v.id, sim: cosine(q[0]!, v.values) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, 30)
        .map((v, i) => ({ ...v, rank: i + 1 }))
    }
  }
  const scores = new Map<string, { score: number; keywordRank?: number; vectorRank?: number; similarity?: number }>()
  for (const k of keyword) scores.set(k.id, { score: 1 / (RRF_K + k.rank), keywordRank: k.rank })
  for (const v of vectorRanks) {
    const s = scores.get(v.id) ?? { score: 0 }
    scores.set(v.id, { ...s, score: s.score + 1 / (RRF_K + v.rank), vectorRank: v.rank, similarity: v.sim })
  }
  const hits: Hit[] = []
  for (const [id, s] of scores) {
    if (o.exclude?.has(id)) continue
    const entry = store.get(id)
    if (!entry) continue
    // Damping: an entry recalled 20 times scores ~23% less than a fresh one with the same ranks.
    const damp = 1 / (1 + 0.08 * Math.log1p(store.recalledCount(id)))
    hits.push({ entry, score: s.score * damp, ...(s.similarity !== undefined ? { similarity: s.similarity } : {}), ...(s.keywordRank ? { keywordRank: s.keywordRank } : {}), ...(s.vectorRank ? { vectorRank: s.vectorRank } : {}) })
  }
  hits.sort((a, b) => b.score - a.score)
  return { hits: hits.slice(0, limit), vectors: usedVectors }
}

const words = (t: string) => new Set(t.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [])

function jaccard(a: Set<string>, b: Set<string>): number {
  let both = 0
  for (const w of a) if (b.has(w)) both++
  return both / Math.max(1, a.size + b.size - both)
}

// Maximal marginal relevance: picks hits one by one, trading relevance against likeness to what is already picked.
// Likeness is cosine when both have vectors, word overlap otherwise.
export function diversify(hits: readonly Hit[], vectorOf: (id: string) => Float32Array | undefined, count: number, lambda = 0.5): Hit[] {
  const picked: Hit[] = []
  const rest = [...hits]
  const top = hits[0]?.score || 1
  while (picked.length < count && rest.length) {
    let best = 0
    let bestValue = Number.NEGATIVE_INFINITY
    rest.forEach((h, i) => {
      const like = Math.max(0, ...picked.map((p) => {
        const a = vectorOf(h.entry.id)
        const b = vectorOf(p.entry.id)
        return a && b ? cosine(a, b) : jaccard(words(h.entry.text), words(p.entry.text))
      }))
      const value = lambda * (h.score / top) - (1 - lambda) * like
      if (value > bestValue) { bestValue = value; best = i }
    })
    picked.push(rest.splice(best, 1)[0]!)
  }
  return picked
}
