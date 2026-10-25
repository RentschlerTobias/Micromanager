// Embeddings for the memory's search: a local Qwen3-Embedding service (llama.cpp, OpenAI-compatible /v1/embeddings),
// the user's choice of 2026-10-20, multilingual unlike openMemory's MiniLM. It may be down: then every call answers
// undefined at once for a minute, search goes on with keywords, and missing vectors are filled in later.
//
// Qwen3-Embedding wants an instruction in front of a query and none in front of a stored text; the task differs between
// finding the same fact (dedupe) and finding what helps a task (recall).

export interface EmbedOptions {
  readonly url: string // the service's base URL
  readonly model: string // recorded with every vector; a different model means re-embedding
  readonly timeoutMs: number
  readonly retryMs: number // after a failure, calls are skipped for this long
}

export const DEFAULT_EMBED: EmbedOptions = { url: "http://127.0.0.1:8093", model: "qwen3-embedding-4b", timeoutMs: 8000, retryMs: 60_000 }

export const TASKS = {
  dedupe: "Given a fact about a software project, find stored facts that state the same thing or contradict it",
  recall: "Given a task for a coding agent, find stored notes that help with doing this task",
} as const

export type Task = keyof typeof TASKS

export function unit(v: readonly number[]): Float32Array {
  const out = Float32Array.from(v)
  const n = Math.hypot(...out) || 1
  for (let i = 0; i < out.length; i++) out[i]! /= n
  return out
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i]! * b[i]!
  return s
}

export class Embedder {
  readonly o: EmbedOptions
  readonly #fetch: typeof fetch
  #downUntil = 0
  #lastError = ""

  constructor(o: Partial<EmbedOptions> = {}, f: typeof fetch = fetch) {
    this.o = { ...DEFAULT_EMBED, ...o }
    this.#fetch = f
  }

  get available(): boolean {
    return Date.now() >= this.#downUntil
  }

  get lastError(): string {
    return this.#lastError
  }

  // Unit vectors for the texts, or undefined while the service is down.
  async embed(texts: readonly string[], task?: Task): Promise<Float32Array[] | undefined> {
    if (!texts.length) return []
    if (!this.available) return undefined
    const input = texts.map((t) => (task ? `Instruct: ${TASKS[task]}\nQuery:${t}` : t))
    try {
      const r = await this.#fetch(`${this.o.url}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.o.model, input }),
        signal: AbortSignal.timeout(this.o.timeoutMs),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const body = (await r.json()) as { data?: { index?: number; embedding?: number[] }[] }
      const data = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      if (data.length !== texts.length || data.some((d) => !Array.isArray(d.embedding))) throw new Error("malformed answer")
      return data.map((d) => unit(d.embedding!))
    } catch (err) {
      this.#downUntil = Date.now() + this.o.retryMs
      this.#lastError = String(err)
      return undefined
    }
  }
}
