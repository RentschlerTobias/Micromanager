// ~/.config/opencode/jev-dictator.jsonc: optional overrides of the routing (JSON with // comments).

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { DEFAULT_ROUTING, type Routing } from "./routing.ts"
import { roleById, type RoleId } from "./roles.ts"

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

export function loadRouting(path = configPath()): { routing: Routing; error?: string } {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return { routing: DEFAULT_ROUTING } // no file: the defaults
  }
  try {
    return { routing: parseRouting(text) }
  } catch (err) {
    return { routing: DEFAULT_ROUTING, error: `${path}: ${String(err)}` }
  }
}
