// What Jev decided, one JSON line per decision, so the user can see every answer Jev gave on their behalf:
// ${XDG_STATE_HOME:-~/.local/state}/jev-dictator/decisions.jsonl

import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export function journalPath(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(base, "jev-dictator", "decisions.jsonl")
}

export function record(entry: Record<string, unknown>, path = journalPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n")
  } catch {
    // the journal must never break a decision
  }
}
