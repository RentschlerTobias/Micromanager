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
}

export function chooseModel(
  role: Role,
  needs: Needs,
  routing: Routing = DEFAULT_ROUTING,
  workerModel?: string, // for a review: the model whose work is checked
): Choice {
  const models = chain(role, routing)
  if (needs.vision && role.id !== "review") {
    return { model: routing.vision, reason: "needs image input" }
  }
  if (role.id === "review" && workerModel) {
    const other = models.find((m) => family(m) !== family(workerModel))
    if (other) return { model: other, reason: `another family than the worker (${family(workerModel)})` }
  }
  return { model: models[0] ?? MODELS.deepseek, reason: `first model for ${role.id}` }
}
