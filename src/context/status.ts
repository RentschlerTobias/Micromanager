// What the TUI shows about a session's context and the memory (src/tui.tsx, the CONTEXT section). The server writes a
// small status file per session at each request; the TUI runs in another process and only reads files.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { contextDir } from "./manager.ts"

export interface ContextStatus {
  readonly tokens: number // the context's estimate after this request's replacements
  readonly ceiling: number
  readonly summaryAt: number // tokens at which a summary starts
  readonly epochs: number
  readonly savedChars: number // what the applied replacements removed
  readonly pending: number
  readonly recalled?: readonly string[] // the memory notes this request got (the micromanager's tail, a worker's brief)
  readonly at: number // epoch ms
}

export interface MemoryStats {
  readonly entries: number
  readonly coreChars: number
  readonly vectors: boolean // the embedding service answered last time
  readonly writes: { readonly added: number; readonly duplicate: number; readonly contradicts: number } // today
}

const file = (sessionID: string, dir = contextDir()) => join(dir, `${sessionID}.status.json`)

export function writeStatus(sessionID: string, s: ContextStatus, dir = contextDir()): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${file(sessionID, dir)}.tmp`, JSON.stringify(s))
    renameSync(`${file(sessionID, dir)}.tmp`, file(sessionID, dir))
  } catch {
    // the sidebar shows the last status it could read
  }
}

export function readStatus(sessionID: string, dir = contextDir()): ContextStatus | undefined {
  try {
    return existsSync(file(sessionID, dir)) ? (JSON.parse(readFileSync(file(sessionID, dir), "utf8")) as ContextStatus) : undefined
  } catch {
    return undefined
  }
}

export function writeMemoryStats(m: MemoryStats, dir = contextDir()): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "memory.json.tmp"), JSON.stringify(m))
    renameSync(join(dir, "memory.json.tmp"), join(dir, "memory.json"))
  } catch {
    // as above
  }
}

export function readMemoryStats(dir = contextDir()): MemoryStats | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "memory.json"), "utf8")) as MemoryStats
  } catch {
    return undefined
  }
}

// Status files of sessions gone quiet for a day are left behind by crashed servers; the TUI lists only fresh ones.
export function freshStatuses(dir = contextDir(), maxAgeMs = 86_400_000, now = Date.now()): Map<string, ContextStatus> {
  const out = new Map<string, ContextStatus>()
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".status.json")) continue
      const id = f.slice(0, -".status.json".length)
      const s = readStatus(id, dir)
      if (s && now - s.at <= maxAgeMs) out.set(id, s)
    }
  } catch {
    // no directory yet
  }
  return out
}

export const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)))

// A bar of `width` cells: filled up to the context, a mark where the summary starts.
export function bar(tokens: number, ceiling: number, summaryAt: number, width: number): string {
  const fill = Math.min(width, Math.round((tokens / Math.max(1, ceiling)) * width))
  const mark = Math.min(width - 1, Math.round((summaryAt / Math.max(1, ceiling)) * width))
  return Array.from({ length: width }, (_, i) => (i === mark && i >= fill ? "│" : i < fill ? "█" : "░")).join("")
}

// The folded line: "context 84k/120k ▓▓▓▓░░ · mem 142 · ↺2".
export function foldedContext(s: ContextStatus | undefined, m: MemoryStats | undefined): string {
  const parts: string[] = []
  if (s) parts.push(`ctx ${kTokens(s.tokens)}/${kTokens(s.ceiling)} ${bar(s.tokens, s.ceiling, s.summaryAt, 6)}`)
  if (m) parts.push(`mem ${m.entries}`)
  if (s?.epochs) parts.push(`↺${s.epochs}`)
  return parts.join(" · ") || "no context data yet"
}
