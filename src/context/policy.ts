// When the context manager applies what it has collected: the epoch policy.
//
// A provider caches the prompt's prefix. Changing a message at position p makes everything after p uncached once, so
// a prune pays `invalidated × (input − cache read)` once and saves `saved × cache read` on every later step. With
// deepseek-v4.1-flash (0.15 vs 0.003 $/M, 50×) that pays off only after ~100 steps; with glm-5.3-flash (0.15 vs
// 0.03, 5×) after ~8. So the manager collects replacements and applies them all at once, when the gain beats the
// cost, or when the context passes a ceiling past which models work worse regardless of price.

export interface Prices {
  readonly input: number // $ per million uncached input tokens
  readonly cacheRead: number // $ per million cached input tokens
  readonly cacheWrite?: number // $ per million tokens written to the cache (some providers bill it)
}

export interface PolicyOptions {
  readonly charsPerToken: number // the estimate the manager counts with (no tokenizer in the hook)
  readonly ceilingTokens: number // past this context the epoch comes regardless of price
  readonly minSavedTokens: number // an epoch that saves less is not worth breaking the cache
  readonly minRemaining: number // bounds of the expected remaining steps
  readonly maxRemaining: number
}

export const DEFAULT_POLICY: PolicyOptions = { charsPerToken: 3.5, ceilingTokens: 120_000, minSavedTokens: 8_000, minRemaining: 5, maxRemaining: 100 }

// Prices when the host's catalog does not know the model: the common Go flash prices.
export const FALLBACK_PRICES: Prices = { input: 0.15, cacheRead: 0.03 }

// Steps a session is expected to go on for. Session lengths are heavy-tailed (coders: median 35, p90 112, max 250),
// so a session that already ran n steps is expected to run about n more; bounded both ways.
export function expectedRemaining(turns: number, o: PolicyOptions = DEFAULT_POLICY): number {
  return Math.min(o.maxRemaining, Math.max(o.minRemaining, turns))
}

export interface EpochInput {
  readonly contextTokens: number
  readonly savedTokens: number // what applying the pending replacements removes
  readonly invalidatedTokens: number // context from the first changed message to the end
  readonly turns: number
  readonly prices?: Prices
  readonly extraCost?: number // $ the epoch costs besides the cache (a summary's model call)
}

export interface EpochVerdict {
  readonly due: boolean
  readonly reason?: "price" | "ceiling"
  readonly gain: number // $ saved over the expected remaining steps
  readonly cost: number // $ the epoch costs once
}

export function epochDue(e: EpochInput, o: PolicyOptions = DEFAULT_POLICY): EpochVerdict {
  const p = e.prices ?? FALLBACK_PRICES
  const gain = (e.savedTokens * expectedRemaining(e.turns, o) * p.cacheRead) / 1e6
  const cost = (e.invalidatedTokens * Math.max(0, p.input - p.cacheRead + (p.cacheWrite ?? 0))) / 1e6 + (e.extraCost ?? 0)
  if (e.savedTokens < o.minSavedTokens) return { due: false, gain, cost }
  if (e.contextTokens >= o.ceilingTokens) return { due: true, reason: "ceiling", gain, cost }
  if (gain > cost) return { due: true, reason: "price", gain, cost }
  return { due: false, gain, cost }
}

// A model's prices from the host's catalog entry (opencode 2.0.18: `cost: [{ input, output, cache: { read, write } }]`).
export function pricesOf(entry: unknown): Prices | undefined {
  const cost = (entry as { cost?: unknown })?.cost
  const c = (Array.isArray(cost) ? cost[0] : cost) as { input?: number; cache?: { read?: number; write?: number }; cache_read?: number } | undefined
  if (!c || typeof c.input !== "number") return undefined
  const read = c.cache?.read ?? c.cache_read
  return { input: c.input, cacheRead: typeof read === "number" ? read : c.input, ...(c.cache?.write ? { cacheWrite: c.cache.write } : {}) }
}
