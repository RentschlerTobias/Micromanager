// Replays recorded OpenCode sessions through the context manager (src/context/manager.ts), without any model call, and
// reports the context and cost they would have had. Calibrates the rules and the epoch policy before they go live.
//
//   node bench/context-replay.ts [--db path] [--exclude substr]... [--ceiling 120000] [--ceiling-mm 100000]
//                                [--rules '{"readTurns":12}'] [--policy '{"minSavedTokens":8000}'] [--role coder] [--json]
//
// The recorded steps give the real context per step (input + cache read + cache write) and the real cost. The replay
// rebuilds the messages each step saw, lets the manager decide, and subtracts what it removed. A step after an epoch
// pays the invalidated part uncached once. Prices come from the host's model cache (~/.cache/opencode/models.json);
// steps of models without a known price keep their recorded cost ratio.

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { ContextManager } from "../src/context/manager.ts"
import type { Message, Part } from "../src/context/ledger.ts"
import { pricesOf, type Prices } from "../src/context/policy.ts"

const args = process.argv.slice(2)
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const many = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []))
const DB = opt("--db") ?? join(homedir(), ".local", "share", "opencode", "opencode.db")
const EXCLUDE = many("--exclude").length ? many("--exclude") : ["/Repos/vm"]
const ONLY_ROLE = opt("--role")
const CEILINGS: Record<string, number> = { micromanager: Number(opt("--ceiling-mm") ?? 100_000) }
const CEILING = Number(opt("--ceiling") ?? 120_000)

// Prices per model id, from OpenCode's model cache (models.dev shape: cost.input, cost.cache_read).
function loadPrices(): Map<string, Prices> {
  const out = new Map<string, Prices>()
  const file = join(homedir(), ".cache", "opencode", "models.json")
  if (!existsSync(file)) return out
  const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, { models?: Record<string, { cost?: { input?: number; cache_read?: number; cache_write?: number } }> }>
  for (const provider of Object.values(data)) {
    for (const [id, m] of Object.entries(provider.models ?? {})) {
      const c = m.cost
      if (!c || typeof c.input !== "number" || out.has(id)) continue
      const p = pricesOf({ cost: [{ input: c.input, cache: { read: c.cache_read ?? c.input, write: c.cache_write } }] })
      if (p) out.set(id, p)
    }
  }
  return out
}

interface Stored {
  type: string
  data: { content?: { type: string; id?: string; name?: string; text?: string; state?: { input?: unknown; content?: { text?: string }[]; error?: unknown; status?: string } }[]; text?: string; tokens?: { input?: number; cache?: { read?: number; write?: number } }; cost?: number; model?: { id?: string } }
}

// One stored assistant step → the hook's shape: an assistant message with text and tool calls, then a tool message.
function toMessages(rows: Stored[]): { messages: Message[]; steps: { at: number; row: Stored }[] } {
  const messages: Message[] = []
  const steps: { at: number; row: Stored }[] = []
  for (const r of rows) {
    if (r.type === "user" || r.type === "synthetic") {
      messages.push({ role: "user", content: [{ type: "text", text: r.data.text ?? "" }] })
      continue
    }
    if (r.type !== "assistant") continue
    steps.push({ at: messages.length, row: r })
    const content: Part[] = []
    const results: Part[] = []
    for (const c of r.data.content ?? []) {
      if (c.type === "text") content.push({ type: "text", text: c.text ?? "" })
      if (c.type === "tool" && c.id) {
        content.push({ type: "tool-call", id: c.id, name: c.name ?? "tool", input: c.state?.input ?? {} })
        const text = (c.state?.content ?? []).map((x) => x.text ?? "").join("") || (c.state?.error ? JSON.stringify(c.state.error) : "")
        results.push({ type: "tool-result", id: c.id, name: c.name ?? "tool", result: { type: c.state?.error ? "error-text" : "text", value: text } })
      }
    }
    messages.push({ role: "assistant", content })
    if (results.length) messages.push({ role: "tool", content: results })
  }
  return { messages, steps }
}

const clone = (m: Message[]): Message[] => structuredClone(m)

const db = new DatabaseSync(DB, { readOnly: true })
const sessions = db.prepare("select id, parent_id as parent, directory as dir, agent from session_v2").all() as { id: string; parent: string | null; dir: string; agent: string | null }[]
const kids = new Map<string, string[]>()
for (const s of sessions) if (s.parent) kids.set(s.parent, [...(kids.get(s.parent) ?? []), s.id])
const scope = new Set<string>()
const walk = (id: string) => { scope.add(id); for (const k of kids.get(id) ?? []) walk(k) }
for (const s of sessions) if (s.agent === "micromanager" && !s.parent && !EXCLUDE.some((e) => s.dir.includes(e))) walk(s.id)
for (const s of sessions) if (s.dir.includes(".jev-micromanager") && !EXCLUDE.some((e) => s.dir.includes(e)) && !(s.agent ?? "").startsWith("dictator")) scope.add(s.id)
const byId = new Map(sessions.map((s) => [s.id, s]))

const prices = loadPrices()
const rowsOf = db.prepare("select type, data from session_message where session_id = ? order by seq")

interface Acc { sessions: number; steps: number; ctxBefore: number; ctxAfter: number; costBefore: number; costAfter: number; epochs: number; byReason: Record<string, number> }
const acc = new Map<string, Acc>()
const get = (role: string) => acc.get(role) ?? (acc.set(role, { sessions: 0, steps: 0, ctxBefore: 0, ctxAfter: 0, costBefore: 0, costAfter: 0, epochs: 0, byReason: {} }), acc.get(role)!)

for (const id of scope) {
  const role = byId.get(id)?.agent ?? "-"
  if (ONLY_ROLE && role !== ONLY_ROLE) continue
  const rows = (rowsOf.all(id) as { type: string; data: string }[]).map((r) => ({ type: r.type, data: JSON.parse(r.data) as Stored["data"] }))
  const { messages, steps } = toMessages(rows)
  if (!steps.length) continue
  const a = get(role)
  a.sessions++
  const manager = new ContextManager({ dir: null, rules: JSON.parse(opt("--rules") ?? "{}"), policy: JSON.parse(opt("--policy") ?? "{}"), journal: (e) => { for (const [k, v] of Object.entries((e.byReason ?? {}) as Record<string, number>)) a.byReason[k] = (a.byReason[k] ?? 0) + v } })
  let carry = 0 // uncached tokens an epoch adds to the next step
  for (const { at, row } of steps) {
    const t = row.data.tokens ?? {}
    const ctx = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
    if (!ctx) continue
    const model = row.data.model?.id ?? ""
    const p = prices.get(model) ?? prices.get(model.split("/").at(-1) ?? "")
    const view = clone(messages.slice(0, at))
    const r = manager.apply(id, view, { ...(p ? { prices: p } : {}), ceilingTokens: CEILINGS[role] ?? CEILING })
    if (r.epoch) { a.epochs++; carry += r.epoch.invalidatedTokens }
    const removedTokens = Math.round(r.renderedChars / 3.5)
    const after = Math.max(1, ctx - removedTokens)
    const recorded = row.data.cost ?? 0
    a.steps++
    a.ctxBefore += ctx
    a.ctxAfter += after
    a.costBefore += recorded
    if (p) {
      const uncachedBefore = t.input ?? 0
      const before = (uncachedBefore * p.input + (ctx - uncachedBefore) * p.cacheRead) / 1e6
      const uncachedAfter = Math.min(after, uncachedBefore + carry)
      const now = (uncachedAfter * p.input + (after - uncachedAfter) * p.cacheRead) / 1e6
      a.costAfter += recorded - before + now // output and reasoning stay as recorded
    } else a.costAfter += recorded * (after / ctx)
    carry = 0
  }
}

const rows = [...acc.entries()].sort((x, y) => y[1].costBefore - x[1].costBefore)
if (args.includes("--json")) console.log(JSON.stringify(Object.fromEntries(rows), null, 1))
else {
  console.log("role           sessions  steps   ctx before → after (M tok)      cost before → after ($)   epochs  replacements")
  let tb = 0, ta = 0, cb = 0, ca = 0
  for (const [role, a] of rows) {
    tb += a.ctxBefore; ta += a.ctxAfter; cb += a.costBefore; ca += a.costAfter
    const pct = (x: number, y: number) => (x ? `${Math.round(100 * (1 - y / x))}%` : "-")
    console.log(`${role.padEnd(14)} ${String(a.sessions).padStart(8)} ${String(a.steps).padStart(6)}   ${(a.ctxBefore / 1e6).toFixed(1).padStart(7)} → ${(a.ctxAfter / 1e6).toFixed(1).padStart(7)} (-${pct(a.ctxBefore, a.ctxAfter)})   ${a.costBefore.toFixed(2).padStart(7)} → ${a.costAfter.toFixed(2).padStart(7)} (-${pct(a.costBefore, a.costAfter)})  ${String(a.epochs).padStart(6)}  ${JSON.stringify(a.byReason)}`)
  }
  console.log(`total: context ${(tb / 1e6).toFixed(0)}M → ${(ta / 1e6).toFixed(0)}M tokens, cost $${cb.toFixed(2)} → $${ca.toFixed(2)}`)
}
