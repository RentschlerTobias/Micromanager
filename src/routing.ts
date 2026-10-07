// Picks the model for a sub-agent call: the role's first model, unless the sub-task needs something only
// another model has (images), or it is a review (never the worker's own model family).

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

export function chain(role: Role, routing: Routing = DEFAULT_ROUTING): readonly string[] {
  const models = routing.models[role.id]
  return models && models.length > 0 ? models : role.models
}

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

export async function chooseModel(
  role: Role,
  needs: Needs,
  routing: Routing = DEFAULT_ROUTING,
  workerModel?: string, // for a review: the model whose work is checked
  available: Available = unknown,
): Promise<Choice> {
  const models = chain(role, routing)
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
    const fromOther = other.length > 0 ? await firstAvailable(other, available) : undefined
    const left = fromOther ? fromOther.skipped.length < other.length : false
    const picked = left && fromOther ? fromOther : await firstAvailable(same, available)
    const reason = picked === fromOther && left
      ? `another family than the worker (${family(workerModel)})`
      : other.length > 0 && !left
        ? `no other family available; reviewing with the worker's own (${family(workerModel)})`
        : `first available model for ${role.id}`
    return { model: picked.model, reason, ...(picked.skipped.length ? { skipped: picked.skipped } : {}) }
  }
  const picked = await firstAvailable(models, available)
  return {
    model: picked.model,
    reason: picked.skipped.length ? `first available model for ${role.id}` : `first model for ${role.id}`,
    ...(picked.skipped.length ? { skipped: picked.skipped } : {}),
  }
}
