// TypeSafe Jev (System One): program state + typed questions in, typed answers with probabilities out.
// Wire format: POST https://api.typesafe.ai/v1/systemone {model, state, questions} -> {model, answers, usage}
// (the same shape the oc-voice project uses in decision/systemone.py).

import { execFileSync } from "node:child_process"

import { scrub } from "./redact.ts"

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> } // option id -> meaning
  | { type: "score"; instructions: string; criteria: string[] } // rubric levels, lowest first
  | { type: "noul"; instructions: string } // a statement; Jev returns the probability that it is true

export type Answer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number }

export interface Decision {
  readonly answers: Record<string, Answer>
  readonly model: string
  readonly latencyMs: number
}

export class JevError extends Error {}

export interface JevOptions {
  readonly url?: string
  readonly model?: string
  readonly timeoutMs?: number
  readonly retries?: number // on 429/529 only
  readonly maxStateChars?: number
  readonly fetch?: typeof fetch
}

// The key: JEV_API_KEY, else the desktop keyring (secret-tool store --label="TypeSafe Jev API key" service typesafe key jev).
export function apiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.JEV_API_KEY) return env.JEV_API_KEY
  try {
    const key = execFileSync("secret-tool", ["lookup", "service", "typesafe", "key", "jev"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return key || undefined
  } catch {
    return undefined
  }
}

// Private data is swapped for the vault's placeholders before the state leaves the machine (src/redact.ts); with
// redaction off, keys and tokens are still masked.
export function redact(text: string): string {
  return scrub(text)
}

export class Jev {
  readonly #key: string
  readonly #url: string
  readonly #model: string
  readonly #timeoutMs: number
  readonly #retries: number
  readonly #maxStateChars: number
  readonly #fetch: typeof fetch

  constructor(key: string, options: JevOptions = {}) {
    this.#key = key
    this.#url = options.url ?? "https://api.typesafe.ai/v1/systemone"
    this.#model = options.model ?? "jev-latest"
    this.#timeoutMs = options.timeoutMs ?? 3000
    this.#retries = options.retries ?? 1
    this.#maxStateChars = options.maxStateChars ?? 24000
    this.#fetch = options.fetch ?? fetch
  }

  async ask(state: string, questions: Record<string, Question>): Promise<Decision> {
    // The newest part of the state is at the end; a cut keeps it.
    const cut = state.length > this.#maxStateChars ? state.slice(-this.#maxStateChars) : state
    const body = JSON.stringify({ model: this.#model, state: redact(cut), questions })
    const started = Date.now()
    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await this.#fetch(this.#url, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.#key}`, "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.#timeoutMs),
        })
      } catch (err) {
        throw new JevError(`Jev unreachable: ${err instanceof Error ? err.name : String(err)}`)
      }
      if ((response.status === 429 || response.status === 529) && attempt < this.#retries) {
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt))
        continue
      }
      if (response.status === 401) throw new JevError("Jev: API key rejected (401)")
      if (response.status !== 200) throw new JevError(`Jev: HTTP ${response.status}`)
      const payload = (await response.json()) as { model?: string; answers?: Record<string, unknown> }
      return { answers: parseAnswers(questions, payload.answers ?? {}), model: payload.model ?? this.#model, latencyMs: Date.now() - started }
    }
  }
}

function num(value: unknown, what: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) throw new JevError(`Jev: missing numeric ${what}`)
  return value
}

function probs(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {}
  return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "number")) as Record<string, number>
}

export function parseAnswers(questions: Record<string, Question>, raw: Record<string, unknown>): Record<string, Answer> {
  const answers: Record<string, Answer> = {}
  for (const [id, question] of Object.entries(questions)) {
    const data = raw[id] as Record<string, unknown> | undefined
    if (!data) continue
    if (question.type === "choice") {
      const choice = data.choice
      if (typeof choice !== "string" || !(choice in question.criteria)) throw new JevError(`Jev: ${id}: choice not offered`)
      answers[id] = { type: "choice", choice, confidence: num(data.confidence, `${id}.confidence`), probabilities: probs(data.probabilities) }
    } else if (question.type === "score") {
      answers[id] = { type: "score", score: num(data.score, `${id}.score`), confidence: num(data.confidence, `${id}.confidence`), probabilities: probs(data.probabilities) }
    } else {
      const noul = num(data.noul, `${id}.noul`)
      if (noul < 0 || noul > 1) throw new JevError(`Jev: ${id}: noul outside 0..1`)
      answers[id] = { type: "noul", noul }
    }
  }
  return answers
}
