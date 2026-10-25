// ~/.config/opencode/micromanager.jsonc: optional overrides of the routing (JSON with // comments).

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { DEFAULT_FLOORS, type Floors } from "./decide.ts"
import { validatePolicies, type PolicySet } from "./policy.ts"
import { DEFAULT_REGISTRY, mergeRegistry, type ModelEntry } from "./registry.ts"
import { DEFAULT_ROUTING, type Routing } from "./routing.ts"
import { roleById, type RoleId } from "./roles.ts"
import { DEFAULT_TRIALS, MAX_TRIALS } from "./trials.ts"
import type { NotifyMode } from "./scheduler.ts"

// The name before 2026-10-19 (jev-micromanager.jsonc) is still read while the new one does not exist.
export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  const path = join(base, "opencode", "micromanager.jsonc")
  const old = join(base, "opencode", "jev-micromanager.jsonc")
  return !existsSync(path) && existsSync(old) ? old : path
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

// "models": a pool per role id, each a non-empty list of "provider/model" strings.
function parseModels(raw: Record<string, unknown> | undefined): Partial<Record<RoleId, readonly string[]>> {
  const models: Partial<Record<RoleId, readonly string[]>> = {}
  for (const [id, value] of Object.entries(raw ?? {})) {
    const role = roleById(id)
    if (!role) throw new Error(`unknown role ${JSON.stringify(id)} in models`)
    if (!Array.isArray(value) || value.length === 0 || !value.every((m) => typeof m === "string" && m.includes("/"))) {
      throw new Error(`models.${id} must be a non-empty list of "provider/model" strings`)
    }
    models[role.id] = value
  }
  return models
}

export function parseRouting(text: string): Routing {
  const raw = JSON.parse(stripComments(text)) as { models?: Record<string, unknown>; vision?: unknown }
  const vision = typeof raw.vision === "string" && raw.vision.includes("/") ? raw.vision : DEFAULT_ROUTING.vision
  return { models: parseModels(raw.models), vision }
}

// ~/.config/opencode/micromanager-models.json: the models the user picked per role in the TUI's MODELS section
// (src/tui.tsx). Only the TUI writes it, so the hand-written micromanager.jsonc keeps its comments. The server reads it
// at each delegation, so a pick holds from the next task on, without a restart of the hub. It wins over "models" and
// "vision" of micromanager.jsonc (src/routing.ts withPicks).
export interface Picks {
  readonly models: Partial<Record<RoleId, readonly string[]>>
  readonly vision?: string
}

export const NO_PICKS: Picks = { models: {} }

export function picksPath(): string {
  return join(dirname(configPath()), "micromanager-models.json")
}

export function parsePicks(text: string): Picks {
  const raw = JSON.parse(text) as { models?: Record<string, unknown>; vision?: unknown }
  if (raw.vision !== undefined && (typeof raw.vision !== "string" || !raw.vision.includes("/"))) throw new Error('vision must be a "provider/model" string')
  return { models: parseModels(raw.models), ...(typeof raw.vision === "string" ? { vision: raw.vision } : {}) }
}

// Read again only when the file changed: the server asks at every delegation, the TUI at every poll.
let cachedPicks: { path: string; stamp: string; picks: Picks } | undefined

// A missing or broken file means no picks: the pools of roles.ts and micromanager.jsonc route as before.
export function loadPicks(path = picksPath()): Picks {
  let stamp: string
  try {
    const st = statSync(path)
    stamp = `${st.mtimeMs}:${st.size}`
  } catch {
    return NO_PICKS
  }
  if (cachedPicks?.path === path && cachedPicks.stamp === stamp) return cachedPicks.picks
  let picks: Picks
  try {
    picks = parsePicks(readFileSync(path, "utf8"))
  } catch {
    picks = NO_PICKS
  }
  cachedPicks = { path, stamp, picks }
  return picks
}

// Written to a temporary file and renamed, so a delegation never reads half a file.
export function savePicks(picks: Picks, path = picksPath()): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(picks, null, 2)}\n`)
  renameSync(tmp, path)
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

// "trials": attempts a hard writer task runs as at once, each on another model, the first to pass is merged (default 3,
// at most 4; 1 turns trials off; src/trials.ts).
export function parseTrials(text: string): number {
  const raw = (JSON.parse(stripComments(text)) as { trials?: unknown }).trials
  if (raw === undefined) return DEFAULT_TRIALS
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) throw new Error("trials must be a whole number from 1")
  return Math.min(raw, MAX_TRIALS)
}

// "cloudOnly": true (the default for now, the user's choice of 2026-10-05) routes no task to a local model and asks
// cloud Jev for the guards instead of the local GLiNER server. false brings the local fleet and GLiNER back.
export function parseCloudOnly(text: string): boolean {
  const raw = (JSON.parse(stripComments(text)) as { cloudOnly?: unknown }).cloudOnly ?? true
  if (typeof raw !== "boolean") throw new Error("cloudOnly must be true or false")
  return raw
}

// "allowOutside": absolute paths (or path prefixes) a worker may reach even where src/decide.ts refuses, e.g.
// ["/home/u/.config/omarchy"]. Empty by default: the user's list is the only thing that lifts those rules, and it lifts
// nothing until they write it. A wrong entry here is a widened rule, so the value is checked, not cast: a list of
// non-empty strings, each of which resolves to an absolute path. `~` is left to src/decide.ts to expand, so what the
// user wrote is what they can see in the journal.
export function parseAllowOutside(text: string): readonly string[] {
  const raw = (JSON.parse(stripComments(text)) as { allowOutside?: unknown }).allowOutside ?? []
  if (!Array.isArray(raw)) throw new Error('allowOutside must be a list of absolute paths, e.g. ["/home/u/.config/omarchy"]')
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(`allowOutside must be a list of absolute paths; ${JSON.stringify(entry)} is not one`)
    }
    const path = entry.trim()
    // A relative entry is a silent no-op or, worse, a guess at the cwd of whatever asked; say so instead.
    if (!path.startsWith("/") && path !== "~" && !path.startsWith("~/")) {
      throw new Error(`allowOutside entries must be absolute paths (or start with ~), got ${JSON.stringify(entry)}`)
    }
    // The entry is kept as written (src/decide.ts normalises it when it matches), so the journal shows the user their
    // own words. A repeated entry is dropped: a list that lists the same path twice says nothing a list says once.
    if (!out.includes(path)) out.push(path)
  }
  return out
}

// "sandbox": run worker commands in the sandbox (src/sandbox.ts; default true). "env": names of variables worker
// commands keep beyond the allowlist ("DATABASE_URL", or "MYAPP_*"). "network": domains worker commands may reach
// beyond the package registries ("api.example.com", "*.example.com", "host:8443"). Both lists are the user's standing
// grants for every job; a single job's grants come from request_env / request_network.
export function parseSandbox(text: string): { sandbox: boolean; env: readonly string[]; network: readonly string[] } {
  const raw = JSON.parse(stripComments(text)) as { sandbox?: unknown; env?: unknown; network?: unknown }
  const sandbox = raw.sandbox ?? true
  if (typeof sandbox !== "boolean") throw new Error("sandbox must be true or false")
  const list = (value: unknown, name: string, ok: RegExp, example: string): string[] => {
    if (value === undefined) return []
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && ok.test(v))) throw new Error(`${name} must be a list like ${example}`)
    return [...new Set(value as string[])]
  }
  return {
    sandbox,
    env: list(raw.env, "env", /^[A-Za-z_][A-Za-z0-9_]*\*?$/, '["DATABASE_URL", "MYAPP_*"]'),
    network: list(raw.network, "network", /^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:\d{1,5})?$/, '["api.example.com", "*.example.com"]'),
  }
}

// The memory (src/context/): on by default; "embedding" names the local service install.sh --embedding sets up, false
// for keyword search only. The model id is recorded with every vector, so a new size re-embeds rather than mixes.
export interface MemorySettings {
  readonly enabled: boolean
  readonly embedding: { readonly url: string; readonly model: string } | false
}

export const DEFAULT_MEMORY: MemorySettings = { enabled: true, embedding: { url: "http://127.0.0.1:8093", model: "qwen3-embedding-4b" } }

export function parseMemory(text: string): MemorySettings {
  const raw = (JSON.parse(stripComments(text)) as { memory?: unknown }).memory
  if (raw === undefined) return DEFAULT_MEMORY
  if (typeof raw === "boolean") return { ...DEFAULT_MEMORY, enabled: raw }
  if (typeof raw !== "object" || raw === null) throw new Error('memory must be true, false or { "embedding": { "url": …, "model": … } | false }')
  const m = raw as { enabled?: unknown; embedding?: unknown }
  if (m.enabled !== undefined && typeof m.enabled !== "boolean") throw new Error("memory.enabled must be true or false")
  let embedding: MemorySettings["embedding"] = DEFAULT_MEMORY.embedding
  if (m.embedding === false) embedding = false
  else if (m.embedding !== undefined) {
    const e = m.embedding as { url?: unknown; model?: unknown }
    if (typeof e !== "object" || e === null || (e.url !== undefined && typeof e.url !== "string") || (e.model !== undefined && typeof e.model !== "string")) throw new Error('memory.embedding must be { "url": "http://…", "model": "qwen3-embedding-4b" } or false')
    embedding = { url: String(e.url ?? (DEFAULT_MEMORY.embedding as { url: string }).url), model: String(e.model ?? (DEFAULT_MEMORY.embedding as { model: string }).model) }
  }
  return { enabled: m.enabled ?? true, embedding }
}

// With cloudOnly, local models stay in the registry (they show up in the journal's ranking) but are never routed to.
export function cloudRegistry(registry: readonly ModelEntry[]): ModelEntry[] {
  return registry.map((m) => (m.location === "local" ? { ...m, disabled: true } : m))
}

export interface Settings {
  readonly cloudOnly: boolean
  readonly parallel: number
  readonly perModel: number
  readonly trials: number
  readonly budget: Budget
  readonly notify: NotifyMode
  readonly routing: Routing
  readonly floors: Floors
  readonly decisions: PolicySet
  readonly registry: readonly ModelEntry[]
  readonly allowOutside: readonly string[]
  readonly sandbox: boolean
  readonly env: readonly string[]
  readonly network: readonly string[]
  readonly memory: MemorySettings
}

// The settings a config file that is missing or broken falls back to. One place, so the two returns below cannot drift
// apart and a setting added here is never left out of the error path.
const DEFAULTS: Omit<Settings, "registry"> = {
  cloudOnly: true,
  parallel: 3,
  perModel: 2,
  trials: DEFAULT_TRIALS,
  budget: DEFAULT_BUDGET,
  notify: "jobs",
  routing: DEFAULT_ROUTING,
  floors: DEFAULT_FLOORS,
  decisions: {},
  allowOutside: [],
  sandbox: true,
  env: [],
  network: [],
  memory: DEFAULT_MEMORY,
}

export function loadSettings(path = configPath()): Settings & { error?: string } {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return { ...DEFAULTS, registry: DEFAULT_REGISTRY } // no file: the defaults
  }
  try {
    return { ...DEFAULTS, cloudOnly: parseCloudOnly(text), ...parseParallel(text), trials: parseTrials(text), budget: parseBudget(text), notify: parseNotify(text), routing: parseRouting(text), floors: parseFloors(text), decisions: parseDecisions(text), registry: parseRegistry(text), allowOutside: parseAllowOutside(text), ...parseSandbox(text), memory: parseMemory(text) }
  } catch (err) {
    return { ...DEFAULTS, registry: DEFAULT_REGISTRY, error: `${path}: ${String(err)}` }
  }
}
