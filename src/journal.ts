// What was decided, one JSON line per entry, so the user can see every answer given on their behalf, the eval
// harness can replay them and a local Jev can be trained on them:
// ${XDG_STATE_HOME:-~/.local/state}/jev-micromanager/decisions.jsonl
//
// Entry kinds: "permission" (src/decide.ts), "routing" (the subagent hook), "decision" (a Jev node through
// src/backends.ts, with the state object and the questions) and "label" (a later answer for a decision).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export function journalPath(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(base, "jev-micromanager", "decisions.jsonl")
}

export function record(entry: Record<string, unknown>, path = journalPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n")
  } catch {
    // the journal must never break a decision
  }
}

export type Entry = Record<string, unknown> & { time?: string; kind?: string }

// Every readable line; a broken line (a crash mid-write) is skipped, not fatal.
export function readJournal(path = journalPath()): Entry[] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (!line.trim()) return []
      try {
        return [JSON.parse(line) as Entry]
      } catch {
        return []
      }
    })
}
