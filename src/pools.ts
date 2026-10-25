// The MODELS section of the sidebar and its popup (src/tui.tsx, `/pools`; /models is OpenCode's own): which models
// each worker role may run on, picked by the user (the user, 2026-10-20: "buttons in the sidebar for the models, a
// popup like /model, several choices per agent"). Plain data, so it is tested without a TUI.
//
// A role's pool is the user's pick (src/config.ts loadPicks), else micromanager.jsonc's "models", else the pool of
// src/roles.ts. Each task still goes to the pool's least-used model (src/routing.ts); a pick only says which ones.

import type { Picks } from "./config.ts"
import { family, ROLES, roleById, type RoleId } from "./roles.ts"
import { chain, withPicks, type Routing } from "./routing.ts"

// The row of the popup and the sidebar that stands for the vision model, next to the role ids.
export const VISION = "vision"
// The popup entry that drops the user's pick and goes back to the default pool.
export const RESET = "\u0000default"
// The popup entry that unchecks every model of a role's pool, so the user picks a new pool from nothing. The empty
// pool lives only in the popup: nothing is saved until a model is checked again.
export const CLEAR = "\u0000clear"

export interface PoolRow {
  readonly key: RoleId | typeof VISION
  readonly agent: string // the name the user knows: the agent id, or "vision"
  readonly models: readonly string[]
  readonly own: boolean // the user's pick, not the default
}

// Every role's pool and the vision model, as routing will see them with the picks applied.
export function poolRows(config: Routing, picks: Picks): PoolRow[] {
  const routing = withPicks(config, picks)
  return [
    ...ROLES.map((role) => ({ key: role.id, agent: role.agent, models: chain(role, routing), own: Boolean(picks.models[role.id]) })),
    { key: VISION, agent: VISION, models: [routing.vision], own: Boolean(picks.vision) },
  ]
}

// Short names that still tell the models of one pool apart: "glm", and "mimo-p" / "mimo-f" when two share a family.
export function shortNames(models: readonly string[]): string[] {
  return models.map((model) => {
    const short = family(model)
    if (models.filter((m) => family(m) === short).length < 2) return short
    const last = (model.split("/").pop() ?? model).split("-").pop() ?? ""
    return `${short}-${last.slice(0, 1)}`
  })
}

// A model as the host lists it (client.model.list), only the fields used here.
export interface CatalogModel {
  readonly id?: string
  readonly providerID?: string
  readonly name?: string
  readonly enabled?: boolean
  readonly status?: string
  readonly capabilities?: { readonly input?: readonly string[] }
}

export interface Option {
  readonly title: string
  readonly value: string
  readonly description?: string
  readonly category?: string
}

const idOf = (m: CatalogModel) => `${m.providerID}/${m.id}`

// What the popup tells about a model: its place in the pool, its tasks of the week and its monthly budget.
function about(model: string, pool: readonly string[], count: (model: string) => number, budget: (model: string) => number | undefined): string {
  const at = pool.indexOf(model)
  const b = budget(model)
  return [at >= 0 && pool.length > 1 ? `#${at + 1}` : "", `${count(model)} tasks/7d`, b === undefined ? "" : `$${b}/month`].filter(Boolean).join(" · ")
}

// Step 2 of the popup: every model the host can run, by provider, the pool's members checked. A pool member the host
// does not list is shown too, under "not available here", so the user can take it out. The vision row offers only
// models with image input.
export function modelOptions(
  catalog: readonly CatalogModel[],
  row: PoolRow,
  count: (model: string) => number = () => 0,
  budget: (model: string) => number | undefined = () => undefined,
): Option[] {
  const usable = catalog.filter((m) => m.id && m.providerID && m.enabled !== false && (m.status ?? "active") === "active")
    .filter((m) => row.key !== VISION || (m.capabilities?.input ?? []).includes("image"))
  const listed = new Set(usable.map(idOf))
  // The providers with a pool member first, so the pool is what the popup opens on.
  const providers = [...new Set(usable.map((m) => m.providerID!))]
    .sort((a, b) => Number(row.models.some((m) => m.startsWith(`${b}/`))) - Number(row.models.some((m) => m.startsWith(`${a}/`))))
  const option = (model: string, name: string, category: string): Option => ({
    title: `${row.models.includes(model) ? "[x]" : "[ ]"} ${name}`,
    value: model,
    description: about(model, row.models, count, budget),
    category,
  })
  return [
    { title: row.own ? "↺ back to the default" : "  (default)", value: RESET, category: row.agent },
    ...(row.key !== VISION && row.models.length > 0 ? [{ title: "✕ clear all", value: CLEAR, category: row.agent }] : []),
    ...providers.flatMap((provider) => usable.filter((m) => m.providerID === provider)
      .sort((a, b) => (a.name ?? a.id!).localeCompare(b.name ?? b.id!))
      .map((m) => option(idOf(m), m.name ?? m.id!, provider))),
    ...row.models.filter((m) => !listed.has(m)).map((m) => option(m, m.split("/").pop() ?? m, "not available here")),
  ]
}

// A model in or out of a role's pool: out when it is in, else in at the end. The last model stays: a pool is never
// empty (undefined says so). The vision row holds one model, so a pick replaces it.
export function toggle(row: PoolRow, model: string): string[] | undefined {
  if (row.key === VISION) return [model]
  if (!row.models.includes(model)) return [...row.models, model]
  return row.models.length > 1 ? row.models.filter((m) => m !== model) : undefined
}

// The picks after the user changed one row: a pool equal to the default is no pick, so the default can move on with
// the code (and with micromanager.jsonc) instead of being frozen in the file.
export function updatePicks(picks: Picks, config: Routing, key: PoolRow["key"], models: readonly string[] | typeof RESET): Picks {
  const reset = models === RESET
  if (key === VISION) {
    const { vision: _, ...rest } = picks
    return reset || models[0] === config.vision ? rest : { ...rest, vision: models[0] }
  }
  const { [key]: _, ...others } = picks.models
  const role = roleById(key)!
  const fallback = chain(role, config)
  const same = !reset && fallback.length === models.length && fallback.every((m, i) => m === models[i])
  return { ...picks, models: reset || same ? others : { ...others, [key]: [...models] } }
}

// Step 1 of the popup: the micromanager (the session's own model, changed with /model) and every row.
export function agentOptions(rows: readonly PoolRow[], session?: string): Option[] {
  return [
    { title: "micromanager", value: "micromanager", description: `${session ? `${session.split("/").pop()} · ` : ""}the session's model: /model` },
    ...rows.map((row) => ({ title: `${row.agent}${row.own ? " ✎" : ""}`, value: row.key, description: shortNames(row.models).join(" ") })),
  ]
}
