// Stage 3 of the context manager: when a long session nears its ceiling, its older turns become one summary.
//
// DCP lets the working model call `compress` and write the summary itself; weak flash models forget to, or cut what
// they still need. Here the plugin picks the segment (every turn before the last few that the rules and Jev left in
// place), and DeepSeek V4.1 Flash (the user's pick, 2026-10-20) writes the summary in a hidden, tool-less session, with
// DCP's rules: complete on files, decisions and commands, lean on the rest, the brief's words verbatim. The same call
// lists the lasting facts it saw, which go to the memory through search and Jev before anything is replaced (capture
// from the raw transcript, never from a summary: openMemory's lesson).
//
// The summary replaces tool results only (the first one carries it, the rest point to it), so every tool call keeps its
// result and the message structure stays valid. It runs in the background; its replacements wait for the next epoch.

import type { Ledger, Message } from "./ledger.ts"
import { resultText } from "./ledger.ts"
import type { Replacement } from "./rules.ts"

export interface SummaryOptions {
  readonly startAt: number // share of the ceiling at which a summary is started
  readonly keepTurns: number // the last turns are never summarized
  readonly minChars: number // a segment smaller than this is not worth a model call
  readonly maxChars: number // what the summarizer reads at most
  readonly perResult: number // characters of one tool result it reads
  readonly timeoutMs: number
}

export const DEFAULT_SUMMARY: SummaryOptions = { startAt: 0.8, keepTurns: 6, minChars: 20_000, maxChars: 120_000, perResult: 4000, timeoutMs: 120_000 }

export interface Segment {
  readonly ids: readonly string[] // tool calls whose results the summary replaces
  readonly fromTurn: number
  readonly toTurn: number
  readonly chars: number // characters their results hold now
  readonly text: string // what the summarizer reads
  readonly brief: string // the session's first user message
}

const textOf = (m: Message) => (typeof m.content === "string" ? m.content : (m.content ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n"))

// The turns before the last `keepTurns`, minus results already replaced.
export function segmentOf(messages: readonly Message[], l: Ledger, applied: ReadonlySet<string>, o: SummaryOptions = DEFAULT_SUMMARY): Segment | undefined {
  const until = l.turns - o.keepTurns
  if (until <= 0) return undefined
  const items = l.items.filter((i) => i.turn < until && !applied.has(i.id))
  const chars = items.reduce((n, i) => n + i.size, 0)
  if (!items.length || chars < o.minChars) return undefined
  const results = new Map<string, string>()
  for (const m of messages) if (m.role === "tool" && Array.isArray(m.content)) for (const p of m.content) if (p.type === "tool-result" && p.id) results.set(p.id, resultText(p))
  const parts: string[] = []
  let turn = -1
  for (const m of messages) {
    if (m.role === "assistant") turn++
    if (turn < 0 || turn >= until) continue
    if (m.role === "assistant") {
      const said = textOf(m).trim()
      if (said) parts.push(`[turn ${turn}] ${said.slice(0, 1500)}`)
      for (const p of Array.isArray(m.content) ? m.content : []) {
        if (p.type !== "tool-call" || !p.id) continue
        const r = results.get(p.id) ?? ""
        parts.push(`[turn ${turn}] ${p.name}(${JSON.stringify(p.input ?? {}).slice(0, 300)}) →\n${r.length > o.perResult ? `${r.slice(0, o.perResult / 2)}\n[…]\n${r.slice(-o.perResult / 2)}` : r}`)
      }
    } else if (m.role === "user") parts.push(`[user] ${textOf(m).slice(0, 1500)}`)
  }
  let text = parts.join("\n\n")
  if (text.length > o.maxChars) text = `${text.slice(0, o.maxChars / 2)}\n[…]\n${text.slice(-o.maxChars / 2)}`
  const first = messages.find((m) => m.role === "user")
  return { ids: items.map((i) => i.id), fromTurn: items[0]!.turn, toTurn: until - 1, chars, text, brief: first ? textOf(first).slice(0, 3000) : "" }
}

export const SUMMARIZER_SYSTEM = `You compress an AI coding agent's earlier work so it can go on without re-reading it.
You get the agent's brief and a transcript of its earlier turns (its words, tool calls and their results). Answer with
exactly two sections and nothing else:

SUMMARY:
What the agent learned and did, so it can continue without the transcript. Be complete on: files read or changed (paths,
what is in them that matters, line numbers if given), decisions and why, commands run and their outcome (passed, failed
with which error), errors still open, and what is left to do. Quote the brief's requirements verbatim where they matter.
Leave out exploration that led nowhere, repeated output and anything the agent will not need. Plain sentences and
lists, at most 600 words.

FACTS:
One line per lasting fact about the project that later, different tasks would need (how to run its tests, where
something lives, a pitfall), each starting with "- ". Write "- none" if there is none.`

export function summaryPrompt(s: Segment): string {
  return `Brief of the agent:\n${s.brief}\n\nTranscript of turns ${s.fromTurn}-${s.toTurn}:\n${s.text}`
}

export function parseSummary(text: string): { summary: string; facts: string[] } | undefined {
  const m = text.match(/SUMMARY:\s*([\s\S]*?)(?:\n\s*FACTS:\s*([\s\S]*))?$/i)
  const summary = m?.[1]?.trim()
  if (!summary || summary.length < 40) return undefined
  const facts = (m?.[2] ?? "").split("\n").map((l) => l.replace(/^\s*[-*]\s*/, "").trim()).filter((l) => l && !/^none\.?$/i.test(l))
  return { summary, facts }
}

export function summaryReplacements(s: Segment, summary: string, sizes: ReadonlyMap<string, number>): Replacement[] {
  const head = `[context: the results of turns ${s.fromTurn}-${s.toTurn} were replaced by this summary; call a tool again if you need one exactly]\n${summary}`
  return s.ids.map((id, i) => {
    const result = i === 0 ? head : `[context: in the summary of turns ${s.fromTurn}-${s.toTurn}]`
    return { id, reason: "summarized" as const, result, saved: Math.max(0, (sizes.get(id) ?? 0) - result.length) }
  })
}

export interface SummarizerDeps {
  // Runs the summarizer model on a prompt and returns its answer ("" on failure).
  readonly generate: (system: string, prompt: string, label: string) => Promise<string>
  readonly facts?: (facts: readonly string[], sessionID: string) => Promise<void>
  readonly journal?: (e: Record<string, unknown>) => void
}

// One summary per session at a time, in the background; its replacements are handed to the manager until applied.
export class Summarizer {
  readonly #d: SummarizerDeps
  readonly #o: SummaryOptions
  readonly #running = new Set<string>()
  readonly #ready = new Map<string, Replacement[]>()

  constructor(d: SummarizerDeps, o: Partial<SummaryOptions> = {}) {
    this.#d = d
    this.#o = { ...DEFAULT_SUMMARY, ...o }
  }

  // The replacements of finished summaries not yet applied. When an epoch applied the result that carried the summary
  // (a rule's stub got there first), the summary moves to the first result still open, so it is never lost.
  ready(sessionID: string, applied: ReadonlySet<string>): Replacement[] {
    const all = this.#ready.get(sessionID) ?? []
    const r = all.filter((x) => !applied.has(x.id))
    if (!r.length) {
      this.#ready.delete(sessionID)
      return r
    }
    const head = all[0]!
    if (r[0]!.id !== head.id && applied.has(head.id)) r[0] = { ...r[0]!, result: head.result, saved: Math.max(0, r[0]!.saved + r[0]!.result!.length - head.result!.length) }
    this.#ready.set(sessionID, r)
    return r
  }

  // Starts a summary when the context nears the ceiling and there is enough to summarize. Returns at once.
  maybeStart(sessionID: string, messages: readonly Message[], l: Ledger, applied: ReadonlySet<string>, contextTokens: number, ceilingTokens: number): boolean {
    if (this.#running.has(sessionID) || this.#ready.has(sessionID)) return false
    if (contextTokens < this.#o.startAt * ceilingTokens) return false
    const s = segmentOf(messages, l, applied, this.#o)
    if (!s) return false
    this.#running.add(sessionID)
    const sizes = new Map(l.items.map((i) => [i.id, i.size]))
    const started = Date.now()
    void (async () => {
      const answer = await Promise.race([
        this.#d.generate(SUMMARIZER_SYSTEM, summaryPrompt(s), `${sessionID} turns ${s.fromTurn}-${s.toTurn}`),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), this.#o.timeoutMs)),
      ]).catch(() => "")
      const parsed = parseSummary(answer)
      this.#d.journal?.({ kind: "context.summary", sessionID, fromTurn: s.fromTurn, toTurn: s.toTurn, results: s.ids.length, chars: s.chars, summaryChars: parsed?.summary.length ?? 0, facts: parsed?.facts.length ?? 0, ms: Date.now() - started, ok: Boolean(parsed) })
      if (!parsed) return
      // The facts first: nothing is replaced before what lasts is kept.
      if (parsed.facts.length && this.#d.facts) await this.#d.facts(parsed.facts.slice(0, 8), sessionID).catch(() => undefined)
      this.#ready.set(sessionID, summaryReplacements(s, parsed.summary, sizes))
    })().finally(() => this.#running.delete(sessionID))
    return true
  }
}
