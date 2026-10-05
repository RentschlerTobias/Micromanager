// ~/.config/opencode/jev-dictator.jsonc: optional overrides of the routing (JSON with // comments).

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { DEFAULT_FLOORS, type Floors } from "./decide.ts"
import { validatePolicies, type PolicySet } from "./policy.ts"
import { DEFAULT_REGISTRY, mergeRegistry, type ModelEntry } from "./registry.ts"
import { DEFAULT_ROUTING, type Routing } from "./routing.ts"
import { roleById, type RoleId } from "./roles.ts"
import type { NotifyMode } from "./scheduler.ts"

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(base, "opencode", "jev-dictator.jsonc")
}

export function stripComments(text: string): string {
  // Drops // comments outside strings, enough for a hand-written config file.
  let out = ""
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === "\\") out += text[++i] ?? ""
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
      out += ch
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else {
      out += ch
    }
  }
  return out
}

export function parseRouting(text: string): Routing {
  const raw = JSON.parse(stripComments(text)) as { models?: Record<string, unknown>; vision?: unknown }
  const models: Partial<Record<RoleId, readonly string[]>> = {}
  for (const [id, value] of Object.entries(raw.models ?? {})) {
    const role = roleById(id)
    if (!role) throw new Error(`unknown role ${JSON.stringify(id)} in models`)
    if (!Array.isArray(value) || value.length === 0 || !value.every((m) => typeof m === "string" && m.includes("/"))) {
      throw new Error(`models.${id} must be a non-empty list of "provider/model" strings`)
    }
    models[role.id] = value
  }
  const vision = typeof raw.vision === "string" && raw.vision.includes("/") ? raw.vision : DEFAULT_ROUTING.vision
  return { models, vision }
}

export function parseFloors(text: string): Floors {
  const raw = (JSON.parse(stripComments(text)) as { floors?: Record<string, unknown> }).floors ?? {}
  const floors: Record<string, number> = { ...DEFAULT_FLOORS }
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in DEFAULT_FLOORS)) throw new Error(`unknown floor ${JSON.stringify(key)}`)
    const max = key === "risk" ? 2 : 1
    if (typeof value !== "number" || value < 0 || value > max) throw new Error(`floors.${key} must be a number from 0 to ${max}`)
    floors[key] = value
  }
  return floors as unknown as Floors
}

// "decisions": the global policy per decision key, e.g. { "N6.pipeline": "fixed:P1", "N5": "ask" } (design.md §22).
export function parseDecisions(text: string): PolicySet {
  const raw = (JSON.parse(stripComments(text)) as { decisions?: unknown }).decisions ?? {}
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("decisions must be an object")
  const errors = validatePolicies(raw as Record<string, unknown>)
  if (errors.length > 0) throw new Error(errors.join("; "))
  return raw as PolicySet
}

// "registry": models to add or change by id, e.g. [{ "id": "llamaswap/mimo", "disabled": true }] (design.md §19).
export function parseRegistry(text: string): ModelEntry[] {
  const raw = (JSON.parse(stripComments(text)) as { registry?: unknown }).registry ?? []
  if (!Array.isArray(raw) || !raw.every((e) => typeof e === "object" && e !== null && typeof (e as { id?: unknown }).id === "string" && (e as { id: string }).id.includes("/"))) {
    throw new Error('registry must be a list of objects with an "id" like "provider/model"')
  }
  return mergeRegistry(DEFAULT_REGISTRY, raw as Partial<ModelEntry>[])
}

// "notify": desktop notifications when a job needs the user or ends ("jobs", the default), also per task ("tasks"),
// or never ("off"). Updates in the micromanager's session come either way.
export function parseNotify(text: string): NotifyMode {
  const raw = (JSON.parse(stripComments(text)) as { notify?: unknown }).notify ?? "jobs"
  if (raw !== "jobs" && raw !== "tasks" && raw !== "off") throw new Error('notify must be "jobs", "tasks" or "off"')
  return raw
}

// "budget": per job, { "tokens": 4000000, "requests": 800, "cost": 5 }; the defaults below, capped by hard ceilings
// so a typo cannot make a job unbounded (design.md §10.2).
export interface Budget {
  readonly tokens?: number
  readonly requests?: number
  readonly cost?: number
}

// No limits unless the config sets them (the user's choice, 2026-10-05: a job cut at a limit wastes its work).
export const DEFAULT_BUDGET: Budget = {}
const CEILINGS = { tokens: 50_000_000, requests: 5000, cost: 1000 } as const

export function parseBudget(text: string): Budget {
  const raw = (JSON.parse(stripComments(text)) as { budget?: unknown }).budget
  if (raw === undefined) return DEFAULT_BUDGET
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("budget must be an object")
  const out: Record<string, number> = { ...DEFAULT_BUDGET }
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in CEILINGS)) throw new Error(`unknown budget ${JSON.stringify(key)}`)
    if (typeof value !== "number" || value <= 0) throw new Error(`budget.${key} must be a positive number`)
    out[key] = Math.min(value, CEILINGS[key as keyof typeof CEILINGS])
  }
  return out
}

// "parallel": tasks of one job at the same time (default 3, at most 6); 1 runs them one after another.
// "perModel": sessions of one cloud model at the same time (default 2, at most 4); a local model serves one.
export function parseParallel(text: string): { parallel: number; perModel: number } {
  const raw = JSON.parse(stripComments(text)) as { parallel?: unknown; perModel?: unknown }
  const int = (v: unknown, name: string, def: number, max: number) => {
    if (v === undefined) return def
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`${name} must be a whole number from 1`)
    return Math.min(v, max)
  }
  return { parallel: int(raw.parallel, "parallel", 3, 6), perModel: int(raw.perModel, "perModel", 2, 4) }
}

// "cloudOnly": true (the default for now, the user's choice of 2026-10-05) routes no task to a local model and asks
// cloud Jev for the guards instead of the local GLiNER server. false brings the local fleet and GLiNER back.
export function parseCloudOnly(text: string): boolean {
  const raw = (JSON.parse(stripComments(text)) as { cloudOnly?: unknown }).cloudOnly ?? true
  if (typeof raw !== "boolean") throw new Error("cloudOnly must be true or false")
  return raw
}

// With cloudOnly, local models stay in the registry (they show up in the journal's ranking) but are never routed to.
export function cloudRegistry(registry: readonly ModelEntry[]): ModelEntry[] {
  return registry.map((m) => (m.location === "local" ? { ...m, disabled: true } : m))
}

export interface Settings {
  readonly cloudOnly: boolean
  readonly parallel: number
  readonly perModel: number
  readonly budget: Budget
  readonly notify: NotifyMode
  readonly routing: Routing
  readonly floors: Floors
  readonly decisions: PolicySet
  readonly registry: readonly ModelEntry[]
}

export function loadSettings(path = configPath()): Settings & { error?: string } {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return { cloudOnly: true, parallel: 3, perModel: 2, budget: DEFAULT_BUDGET, notify: "jobs", routing: DEFAULT_ROUTING, floors: DEFAULT_FLOORS, decisions: {}, registry: DEFAULT_REGISTRY } // no file: the defaults
  }
  try {
    return { cloudOnly: parseCloudOnly(text), ...parseParallel(text), budget: parseBudget(text), notify: parseNotify(text), routing: parseRouting(text), floors: parseFloors(text), decisions: parseDecisions(text), registry: parseRegistry(text) }
  } catch (err) {
    return { cloudOnly: true, parallel: 3, perModel: 2, budget: DEFAULT_BUDGET, notify: "jobs", routing: DEFAULT_ROUTING, floors: DEFAULT_FLOORS, decisions: {}, registry: DEFAULT_REGISTRY, error: `${path}: ${String(err)}` }
  }
}
