// Stage 1 of the context manager: what can leave a session's context without asking anyone (no model, no Jev).
//
// The measurement of 2026-10-23 (376 micromanager sessions): coders' contexts hold 14 M characters of reads (802 of
// 3,188 reads re-read a path), 9.7 M of shell output and 5.9 M of write/edit inputs, and none of it ever left. Each
// rule here names what is safe to drop and leaves a stub that says how to get it back.
//
// A replacement is deterministic: no age, time or counter in its text, so the same decision renders the same bytes in
// every later turn and the provider's prompt cache holds (src/context/manager.ts applies them only at an epoch).

import type { Item, Ledger } from "./ledger.ts"
import { covers } from "./ledger.ts"

export type Reason = "duplicate" | "superseded" | "stale" | "errored" | "written" | "shell" | "web" | "aged" | "judged" | "summarized"

export interface Replacement {
  readonly id: string // the tool call id
  readonly reason: Reason
  readonly result?: string // the tool result's new text
  readonly input?: Record<string, unknown> // the tool call's new input
  readonly saved: number // characters it removes
}

export interface RuleOptions {
  readonly keepTurns: number // results of the last turns are never touched
  readonly minChars: number // smaller results are not worth a stub
  readonly shellTurns: number // shell output older than this is cut to its tail
  readonly shellTail: number // lines a cut shell output keeps
  readonly webTurns: number // web results older than this go
  readonly writtenTurns: number // write/edit inputs older than this go (the file on disk has them)
  readonly erroredTurns: number // inputs of failed calls older than this go
  readonly readTurns: number // reads older than this go even when nothing replaced them (Infinity: never; Jev's call)
}

export const DEFAULT_RULES: RuleOptions = { keepTurns: 3, minChars: 600, shellTurns: 4, shellTail: 10, webTurns: 6, writtenTurns: 4, erroredTurns: 4, readTurns: Number.POSITIVE_INFINITY }

// Tools whose results the rules may touch. Everything else (subagent reports, skills, questions, todos, the plugin's
// own tools) carries decisions and stays.
const READS = new Set(["read", "grep", "glob", "list"])
const SHELLS = new Set(["shell", "bash"])
const WEB = new Set(["webfetch", "websearch"])
const WRITES = new Set(["write", "edit", "patch", "apply_patch", "multiedit"])
const CONTENT_FIELDS = ["content", "newString", "oldString", "patch", "patchText", "edits"]

const brief = (input: Record<string, unknown>) => JSON.stringify(input).slice(0, 160)

export function stub(item: Item, why: string): string {
  return `[context: this ${item.tool} result (${item.size} characters; ${brief(item.input)}) was dropped: ${why}. Call the tool again if you need it.]`
}

function tail(item: Item, text: string, lines: number): string {
  const kept = text.trimEnd().split("\n").slice(-lines).join("\n")
  return `[context: earlier output of this command (${item.size} characters), cut to its last ${lines} lines; run it again for all of it]\n${kept}`
}

function shrinkInput(input: Record<string, unknown>, why: string): { input: Record<string, unknown>; saved: number } {
  const out: Record<string, unknown> = {}
  let saved = 0
  for (const [k, v] of Object.entries(input)) {
    const s = typeof v === "string" ? v : CONTENT_FIELDS.includes(k) ? JSON.stringify(v) : undefined
    if (s !== undefined && CONTENT_FIELDS.includes(k) && s.length > 200) {
      const note = `[${s.length} characters, dropped: ${why}]`
      out[k] = note
      saved += s.length - note.length
    } else out[k] = v
  }
  return { input: out, saved }
}

// The replacements stage 1 finds in a ledger. `results` gives a call's result text (for the shell tail).
export function findReplacements(l: Ledger, results: ReadonlyMap<string, string>, o: RuleOptions = DEFAULT_RULES): Replacement[] {
  const out: Replacement[] = []
  const age = (it: Item) => l.turns - 1 - it.turn
  // Items are in call order; what came after item i is what has a larger index.
  const lastOfKey = new Map<string, number>()
  const reads = new Map<string, { at: number; range: Item["range"] }[]>()
  const lastWrite = new Map<string, number>()
  l.items.forEach((x, i) => {
    if (x.error) return
    lastOfKey.set(x.key, i)
    if (x.path && x.tool === "read") reads.set(x.path, [...(reads.get(x.path) ?? []), { at: i, range: x.range }])
    if (x.path && WRITES.has(x.tool)) lastWrite.set(x.path, i)
  })
  l.items.forEach((it, i) => {
    if (age(it) < o.keepTurns) return
    const big = it.size >= o.minChars
    if (READS.has(it.tool) && big) {
      if ((lastOfKey.get(it.key) ?? -1) > i) {
        out.push({ id: it.id, reason: "duplicate", result: stub(it, "the same call was made again later"), saved: it.size })
        return
      }
      if (it.tool === "read" && it.path) {
        if ((reads.get(it.path) ?? []).some((x) => x.at > i && covers(x.range, it.range))) {
          out.push({ id: it.id, reason: "superseded", result: stub(it, "a later read of the same file covers it"), saved: it.size })
          return
        }
        if ((lastWrite.get(it.path) ?? -1) > i) {
          out.push({ id: it.id, reason: "stale", result: stub(it, "the file was changed after this read"), saved: it.size })
          return
        }
      }
      if (age(it) >= o.readTurns) {
        out.push({ id: it.id, reason: "aged", result: stub(it, "it was read long ago"), saved: it.size })
        return
      }
    }
    if (SHELLS.has(it.tool) && big && age(it) >= o.shellTurns) {
      const text = results.get(it.id) ?? ""
      const cut = tail(it, text, o.shellTail)
      if (cut.length < it.size) out.push({ id: it.id, reason: "shell", result: cut, saved: it.size - cut.length })
      return
    }
    if (WEB.has(it.tool) && big && age(it) >= o.webTurns) {
      out.push({ id: it.id, reason: "web", result: stub(it, "the page was read long ago; what mattered is in the notes after it"), saved: it.size })
      return
    }
    if (WRITES.has(it.tool) && age(it) >= o.writtenTurns && it.inputSize >= o.minChars) {
      const s = shrinkInput(it.input, "the file on disk has it")
      if (s.saved > 0) out.push({ id: it.id, reason: "written", input: s.input, saved: s.saved })
      return
    }
    if (it.error && age(it) >= o.erroredTurns && it.inputSize >= o.minChars) {
      const s = shrinkInput(it.input, "the call failed")
      if (s.saved > 0) out.push({ id: it.id, reason: "errored", input: s.input, saved: s.saved })
    }
  })
  return out
}
