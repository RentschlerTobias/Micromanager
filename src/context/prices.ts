// Model prices from the host's catalog (`ctx.model.list()`, opencode 2.0.18), for the epoch policy. Read at most once a
// minute; a failed read leaves the policy on its fallback prices rather than guessing.

import { pricesOf, type Prices } from "./policy.ts"

const TTL_MS = 60_000

export class PriceBook {
  readonly #list: () => Promise<unknown> | unknown
  readonly #now: () => number
  #at = Number.NEGATIVE_INFINITY
  #prices = new Map<string, Prices>()

  constructor(list: () => Promise<unknown> | unknown, now = () => Date.now()) {
    this.#list = list
    this.#now = now
  }

  async get(model?: { providerID?: string; id?: string; modelID?: string }): Promise<Prices | undefined> {
    if (!model) return undefined
    if (this.#now() - this.#at > TTL_MS) {
      this.#at = this.#now()
      try {
        const raw = await this.#list()
        const list = (Array.isArray(raw) ? raw : ((raw as { data?: unknown })?.data ?? [])) as { id?: string; providerID?: string }[]
        const next = new Map<string, Prices>()
        for (const m of list) {
          const p = pricesOf(m)
          if (p && m.id) next.set(`${m.providerID}/${m.id}`, p)
        }
        if (next.size) this.#prices = next
      } catch {
        // keep what was read before
      }
    }
    return this.#prices.get(`${model.providerID}/${model.id ?? model.modelID}`)
  }
}
