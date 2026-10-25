// Picks the model for a sub-agent call from the role's pool: the least-used model, weighted by its monthly budget
// (src/usage.ts), unless the sub-task needs something only another model has (images), or it is a review (never the
// worker's own model family). Without usage the pool's order decides: its first available model.

import { MODELS, family, type Role, type RoleId } from "./roles.ts"

export interface Routing {
  readonly models: Partial<Record<RoleId, readonly string[]>> // overrides of the roles' model chains
  readonly vision: string // the model with image input
}

export const DEFAULT_ROUTING: Routing = { models: {}, vision: MODELS.qwen }

export interface Needs {
  readonly vision: boolean
}

const IMAGE = /\b(screenshots?|images?|pictures?|photos?|png|jpe?g|webp|gif|mockups?)\b/i

// Phase 1 guesses needs from the prompt; Jev answers them from Phase 2 on.
export function guessNeeds(prompt: string): Needs {
  return { vision: IMAGE.test(prompt) }
}

// The user's picks from the TUI (src/config.ts loadPicks) over the config's routing: a picked role's pool replaces its
// pool, a picked vision model the vision model.
export function withPicks(base: Routing, picks: { readonly models: Routing["models"]; readonly vision?: string }): Routing {
  return { models: { ...base.models, ...picks.models }, vision: picks.vision ?? base.vision }
}

export function chain(role: Role, routing: Routing = DEFAULT_ROUTING): readonly string[] {
  const models = routing.models[role.id]
  return models && models.length > 0 ? models : role.models
}

// What spreads the work over a pool: the tasks each model got lately and its monthly budget in $. A free model has no
// budget and is weighted as FREE_BUDGET, or it would win every pick of its pools.
export interface Spread {
  readonly usage?: { count(model: string): number; record(model: string): void }
  readonly budget?: (model: string) => number | undefined
  readonly avoidFamilies?: readonly string[] // a task started again: not the family its failed attempt ran on
  readonly prefer?: (model: string) => boolean // a hard task: the pool's models of the deep tier, when it has any
}

export const FREE_BUDGET = 60

export interface Choice {
  readonly model: string
  readonly reason: string
  // The models that were wanted but are not available on this machine, in chain order. Empty for the normal case.
  readonly skipped?: readonly string[]
}

/**
 * Is this model one the host can actually run? The host is the only authority: a model can disappear because the
 * account changed, the provider is unauthenticated, or the id was renamed — none of which the plugin can see from
 * its own registry. `ctx.catalog.model.get()` is the one API that answers it.
 *
 * Returns true when no answer is available (the catalog could not be read): an unknown model is not proof of an
 * unavailable one, and refusing to route on a failed lookup would break routing for everyone whose catalog read
 * failed.
 */
export type Available = (model: string) => boolean | Promise<boolean>

export const unknown: Available = () => true

async function firstAvailable(models: readonly string[], available: Available): Promise<{ model: string; skipped: string[] }> {
  const skipped: string[] = []
  for (const model of models) {
    if (await available(model)) return { model, skipped }
    skipped.push(model)
  }
  // Nothing in the chain is available. Return the first anyway: a call against a model that is gone fails loudly and
  // says so, which beats silently substituting something the role's chain did not ask for. The skipped list is
  // journalled so the reason is visible either way.
  return { model: models[0] ?? MODELS.deepseek, skipped }
}

// The least-used available model of a list, by tasks per $ of budget; ties go to the list's order. Without usage, the
// first available one. The picked model is counted.
async function leastUsed(models: readonly string[], available: Available, spread: Spread): Promise<{ model: string; skipped: string[]; spread?: string }> {
  const { usage, budget = () => undefined } = spread
  if (!usage) return firstAvailable(models, available)
  const ready: string[] = []
  const skipped: string[] = []
  for (const model of models) (await available(model) ? ready : skipped).push(model)
  if (!ready.length) return firstAvailable(models, available)
  const weight = (m: string) => budget(m) ?? FREE_BUDGET
  const score = (m: string) => usage.count(m) / weight(m)
  const model = ready.reduce((best, m) => (score(m) < score(best) ? m : best))
  usage.record(model)
  const show = (m: string) => `${m.split("/").pop()} (${usage.count(m) - (m === model ? 1 : 0)}/$${weight(m)})`
  const others = ready.filter((m) => m !== model)
  return { model, skipped, spread: `${show(model)}${others.length ? ` over ${others.map(show).join(", ")}` : ""}` }
}

export async function chooseModel(
  role: Role,
  needs: Needs,
  routing: Routing = DEFAULT_ROUTING,
  workerModel?: string, // for a review: the model whose work is checked
  available: Available = unknown,
  spread: Spread = {},
): Promise<Choice> {
  const all = chain(role, routing)
  // A task started again leaves the family its failed attempt ran on, while the pool has another one.
  const avoid = spread.avoidFamilies ?? []
  const fresh = all.filter((m) => !avoid.includes(family(m)))
  const avoided = fresh.length > 0 && fresh.length < all.length
  const left = avoided ? fresh : all
  const preferred = spread.prefer ? left.filter(spread.prefer) : []
  const models = preferred.length ? preferred : left
  if (needs.vision && role.id !== "review") {
    const vision = await firstAvailable([routing.vision], available)
    return { model: vision.model, reason: "needs image input", ...(vision.skipped.length ? { skipped: vision.skipped } : {}) }
  }
  if (role.id === "review" && workerModel) {
    // The family rule and availability are separate questions, so they are applied in that order: a review that
    // would leave the family is preferred, and only if none of those is available do we take one that stays in it.
    const other = models.filter((m) => family(m) !== family(workerModel))
    const same = models.filter((m) => family(m) === family(workerModel))
    // Another family is preferred, but never at the cost of a model that does not exist: if none of the other
    // family is available, the worker's own family is taken and the reason says the rule was relaxed. The reverse
    // would hand a review to a model that cannot run.
    const left = other.length > 0 && (await Promise.all(other.map((m) => available(m)))).some(Boolean)
    const picked = await leastUsed(left ? other : same.length ? same : other, available, spread)
    const reason = left
      ? `another family than the worker (${family(workerModel)})${picked.spread ? `; least used: ${picked.spread}` : ""}`
      : other.length > 0
        ? `no other family available; reviewing with the worker's own (${family(workerModel)})`
        : `first available model for ${role.id}`
    return { model: picked.model, reason, ...(picked.skipped.length ? { skipped: picked.skipped } : {}) }
  }
  const picked = await leastUsed(models, available, spread)
  return {
    model: picked.model,
    reason: picked.spread
      ? `least used of ${role.id}: ${picked.spread}${avoided ? ` (not ${avoid.join(", ")}: the failed attempt's family)` : ""}${preferred.length ? " (deep tier: a hard task)" : ""}`
      : picked.skipped.length ? `first available model for ${role.id}` : `first model for ${role.id}`,
    ...(picked.skipped.length ? { skipped: picked.skipped } : {}),
  }
}
