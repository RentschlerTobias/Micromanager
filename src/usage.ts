// How many tasks each model got lately, so a role's pool can go to its least-used model (src/routing.ts).
//
// The user, 2026-10-19: the point of several models is diversity, and a fixed order sent every coder to the same
// one. Counting tasks per model over a week, divided by the model's monthly Go budget, spreads the work over the
// pool in proportion to what each model may spend. Seeded from the journal's routing records, so a restart of the
// server does not forget the week; counted in memory from then on.

import { readJournal, type Entry } from "./journal.ts"

export const WINDOW_MS = 7 * 24 * 60 * 60_000

export interface Pick {
  readonly model: string
  readonly at: number // epoch ms
}

export class Usage {
  readonly #picks: Pick[] = []
  readonly #now: () => number

  constructor(seed: readonly Pick[] = [], now: () => number = () => Date.now()) {
    this.#now = now
    this.#picks.push(...seed)
  }

  record(model: string): void {
    this.#picks.push({ model, at: this.#now() })
    this.#prune()
  }

  // The tasks this model got within the window.
  count(model: string): number {
    const since = this.#now() - WINDOW_MS
    return this.#picks.filter((p) => p.model === model && p.at >= since).length
  }

  #prune(): void {
    const since = this.#now() - WINDOW_MS
    while (this.#picks.length && this.#picks[0]!.at < since) this.#picks.shift()
  }
}

// The model of every routing record of the window: the delegations (src/plugin.ts) and the runner's own sessions
// (src/runner.ts) both write one per session they start.
export function seedFromJournal(entries: readonly Entry[] = readJournal(), now = Date.now()): Pick[] {
  const since = now - WINDOW_MS
  return entries.flatMap((e) => {
    if (e.kind !== "routing" || typeof e.model !== "string" || typeof e.time !== "string") return []
    const at = Date.parse(e.time)
    return Number.isFinite(at) && at >= since ? [{ model: e.model, at }] : []
  }).sort((a, b) => a.at - b.at)
}
