import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { covers, ledger, type Message } from "../src/context/ledger.ts"
import { ContextManager } from "../src/context/manager.ts"
import { epochDue, expectedRemaining, pricesOf } from "../src/context/policy.ts"
import { PriceBook } from "../src/context/prices.ts"
import { DEFAULT_RULES, findReplacements } from "../src/context/rules.ts"

interface Call { tool: string; input: Record<string, unknown>; out: string; error?: boolean }

// A worker's history: a brief, then one tool call per turn.
function history(calls: Call[]): Message[] {
  const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "fix the parser" }] }]
  calls.forEach((c, i) => {
    msgs.push({ role: "assistant", content: [{ type: "text", text: `step ${i}` }, { type: "tool-call", id: `c${i}`, name: c.tool, input: c.input }] })
    msgs.push({ role: "tool", content: [{ type: "tool-result", id: `c${i}`, name: c.tool, result: { type: c.error ? "error-text" : "text", value: c.out } }] })
  })
  return msgs
}

const big = (tag: string, n = 2000) => `${tag}\n`.padEnd(n, "x")
const filler = (n: number): Call[] => Array.from({ length: n }, (_, i) => ({ tool: "grep", input: { pattern: `p${i}` }, out: "1 match" }))
const results = (msgs: Message[]) => new Map(msgs.flatMap((m) => (m.role === "tool" && Array.isArray(m.content) ? m.content.map((p) => [p.id!, String(p.result?.value ?? "")] as [string, string]) : [])))
const valueOf = (msgs: Message[], id: string) => String((msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((p) => p.type === "tool-result" && p.id === id)?.result?.value) ?? "")

test("ledger: calls with their turn, size, file and read range", () => {
  const l = ledger(history([{ tool: "read", input: { path: "a.ts", offset: 10, limit: 5 }, out: "abc" }, { tool: "edit", input: { path: "a.ts", oldString: "a", newString: "b" }, out: "ok" }]))
  assert.equal(l.turns, 2)
  assert.deepEqual(l.items.map((i) => [i.id, i.tool, i.turn, i.path]), [["c0", "read", 0, "a.ts"], ["c1", "edit", 1, "a.ts"]])
  assert.deepEqual(l.items[0]!.range, { from: 10, to: 14 })
  assert.ok(covers(undefined, { from: 1, to: 3 }))
  assert.ok(!covers({ from: 5, to: 9 }, { from: 1, to: 3 }))
  assert.equal(l.offsets.length, 5)
})

test("rules: a read the file's later edit made stale, a read a later read covers, a repeated grep", () => {
  const msgs = history([
    { tool: "read", input: { path: "a.ts" }, out: big("A1") },
    { tool: "read", input: { path: "b.ts", offset: 1, limit: 50 }, out: big("B1") },
    { tool: "grep", input: { pattern: "foo" }, out: big("G1") },
    { tool: "edit", input: { path: "a.ts", oldString: "x", newString: "y" }, out: "Edited a.ts" },
    { tool: "read", input: { path: "b.ts" }, out: big("B2") },
    { tool: "grep", input: { pattern: "foo" }, out: big("G2") },
    ...filler(4),
  ])
  const r = findReplacements(ledger(msgs), results(msgs))
  assert.deepEqual(r.map((x) => [x.id, x.reason]), [["c0", "stale"], ["c1", "superseded"], ["c2", "duplicate"]])
  assert.match(r[0]!.result!, /^\[context: this read result \(2000 characters; \{"path":"a.ts"\}\) was dropped: the file was changed after this read/)
})

test("rules: the last turns stay; old shell output keeps its tail; old write content goes", () => {
  const out = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")
  const msgs = history([
    { tool: "shell", input: { command: "npm test" }, out },
    { tool: "write", input: { path: "c.ts", content: big("C", 3000) }, out: "Wrote c.ts" },
    ...filler(5),
    { tool: "read", input: { path: "d.ts" }, out: big("D") },
    { tool: "read", input: { path: "d.ts" }, out: big("D") },
  ])
  const r = findReplacements(ledger(msgs), results(msgs))
  const shell = r.find((x) => x.id === "c0")!
  assert.equal(shell.reason, "shell")
  assert.match(shell.result!, /cut to its last 10 lines/)
  assert.match(shell.result!, /line 199$/)
  assert.doesNotMatch(shell.result!, /line 100\n/)
  const write = r.find((x) => x.id === "c1")!
  assert.equal(write.reason, "written")
  assert.match(String(write.input!.content), /^\[3000 characters, dropped: the file on disk has it\]$/)
  assert.equal(write.input!.path, "c.ts")
  assert.ok(!r.some((x) => x.id === "c7"), "a duplicate inside the last turns stays")
  assert.equal(DEFAULT_RULES.readTurns, Number.POSITIVE_INFINITY)
})

test("policy: the cache price decides, and the ceiling overrides it", () => {
  const glm = { input: 0.15, cacheRead: 0.03 }
  const deepseek = { input: 0.15, cacheRead: 0.003 }
  const e = { contextTokens: 120_000 - 1, savedTokens: 50_000, invalidatedTokens: 100_000, turns: 40 }
  assert.equal(epochDue({ ...e, prices: glm }).reason, "price")
  assert.equal(epochDue({ ...e, prices: deepseek }).due, false)
  assert.equal(epochDue({ ...e, contextTokens: 130_000, prices: deepseek }).reason, "ceiling")
  assert.equal(epochDue({ ...e, savedTokens: 1000, contextTokens: 500_000 }).due, false, "too little to save")
  assert.equal(expectedRemaining(2), 5)
  assert.equal(expectedRemaining(300), 100)
  assert.deepEqual(pricesOf({ cost: [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }] }), { input: 0.15, cacheRead: 0.003 })
})

test("manager: nothing changes between epochs; an epoch applies everything at once, and it sticks across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-"))
  const journal: Record<string, unknown>[] = []
  const calls: Call[] = [
    ...Array.from({ length: 6 }, (_, i): Call => ({ tool: "read", input: { path: `f${i}.ts` }, out: big(`F${i}`, 9000) })),
    ...Array.from({ length: 6 }, (_, i): Call => ({ tool: "edit", input: { path: `f${i}.ts`, oldString: "a", newString: "b" }, out: "ok" })),
    ...filler(4),
  ]
  // A ceiling of 1 token makes any epoch due once enough is pending; the price never would with this little.
  const m = new ContextManager({ dir, journal: (e) => journal.push(e), policy: { minSavedTokens: 10_000 } })
  const early = history(calls.slice(0, 9))
  const before = JSON.stringify(early)
  const r1 = m.apply("ses_1", early, { ceilingTokens: 1 })
  assert.equal(r1.epoch, undefined, "pending holds too little yet")
  assert.equal(JSON.stringify(early), before, "between epochs the messages stay byte-identical")
  const later = history(calls)
  const r2 = m.apply("ses_1", later, { ceilingTokens: 1 })
  assert.equal(r2.epoch?.reason, "ceiling")
  assert.equal(r2.epoch?.applied, 6)
  assert.match(valueOf(later, "c0"), /^\[context: this read result/)
  assert.equal(journal[0]!.kind, "context.epoch")
  // the next turn renders the same replacements without a new epoch
  const next = history([...calls, ...filler(1)])
  const r3 = m.apply("ses_1", next, { ceilingTokens: 1 })
  assert.equal(r3.epoch, undefined)
  assert.equal(JSON.stringify(next.slice(0, later.length)), JSON.stringify(later), "the prefix is the same bytes as in the epoch's request")
  // a restarted server reads the applied set back
  const fresh = new ContextManager({ dir })
  const again = history([...calls, ...filler(1)])
  fresh.apply("ses_1", again, { ceilingTokens: 1e9 })
  assert.equal(JSON.stringify(again), JSON.stringify(next))
})

test("price book: prices by provider and model from the host's catalog, read once a minute", async () => {
  let reads = 0
  let t = 0
  const book = new PriceBook(() => { reads++; return [{ id: "deepseek-v4.1-flash", providerID: "opencode-go", cost: [{ input: 0.15, cache: { read: 0.003 } }] }] }, () => t)
  assert.deepEqual(await book.get({ providerID: "opencode-go", id: "deepseek-v4.1-flash" }), { input: 0.15, cacheRead: 0.003 })
  assert.equal(await book.get({ providerID: "openrouter", id: "x" }), undefined)
  t = 30_000
  await book.get({ providerID: "opencode-go", id: "deepseek-v4.1-flash" })
  assert.equal(reads, 1)
})

test("summary: the older turns form a segment; the answer is parsed; the summary survives a rule's stub", async () => {
  const { segmentOf, parseSummary, Summarizer } = await import("../src/context/summary.ts")
  const msgs = history(Array.from({ length: 12 }, (_, i): Call => ({ tool: "read", input: { path: `f${i}.ts` }, out: big(`F${i}`, 5000) })))
  const l = ledger(msgs)
  const seg = segmentOf(msgs, l, new Set(["c0"]), { startAt: 0.8, keepTurns: 6, minChars: 10_000, maxChars: 120_000, perResult: 4000, timeoutMs: 1000 })!
  assert.deepEqual(seg.ids, ["c1", "c2", "c3", "c4", "c5"], "the last turns and applied results stay out")
  assert.equal(seg.brief, "fix the parser")
  assert.deepEqual(parseSummary("SUMMARY:\nRead f1 to f5; the parser lives in f3.ts at line 40, nothing changed yet.\n\nFACTS:\n- the parser is in f3.ts\n- none"), { summary: "Read f1 to f5; the parser lives in f3.ts at line 40, nothing changed yet.", facts: ["the parser is in f3.ts"] })
  assert.equal(parseSummary("no sections"), undefined)
  const facts: string[] = []
  const s = new Summarizer({ generate: async () => "SUMMARY:\nThe agent read the files f1 to f5 and found the parser in f3.ts.\nFACTS:\n- the parser is in f3.ts", facts: async (f) => { facts.push(...f) } }, { minChars: 10_000 })
  assert.equal(s.maybeStart("ses", msgs, l, new Set(["c0"]), 1000, 100_000), false, "far from the ceiling")
  assert.equal(s.maybeStart("ses", msgs, l, new Set(["c0"]), 90_000, 100_000), true)
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(facts, ["the parser is in f3.ts"])
  const ready = s.ready("ses", new Set(["c0"]))
  assert.match(ready[0]!.result!, /^\[context: the results of turns 1-5 were replaced by this summary/)
  const moved = s.ready("ses", new Set(["c0", "c1"]))
  assert.equal(moved[0]!.id, "c2")
  assert.match(moved[0]!.result!, /replaced by this summary/, "the summary moves on when its result was stubbed first")
})

test("status: the server's file per session, the bar and the folded line the sidebar shows", async () => {
  const { bar, foldedContext, freshStatuses, readStatus, writeStatus } = await import("../src/context/status.ts")
  const dir = mkdtempSync(join(tmpdir(), "status-"))
  const s = { tokens: 60_000, ceiling: 120_000, summaryAt: 96_000, epochs: 2, savedChars: 284_000, pending: 3, recalled: ["tests need uv run"], at: Date.now() }
  writeStatus("ses_1", s, dir)
  assert.deepEqual(readStatus("ses_1", dir), s)
  assert.deepEqual([...freshStatuses(dir).keys()], ["ses_1"])
  assert.equal(freshStatuses(dir, 1000, Date.now() + 5000).size, 0, "a stale file is not listed")
  assert.equal(bar(60_000, 120_000, 96_000, 10), "█████░░░│░")
  assert.equal(bar(120_000, 120_000, 96_000, 10), "██████████")
  assert.equal(foldedContext(s, { entries: 142, coreChars: 3900, vectors: true, writes: { added: 1, duplicate: 0, contradicts: 0 } }), "ctx 60k/120k ███░░│ · mem 142 · ↺2")
  assert.equal(foldedContext(undefined, undefined), "no context data yet")
})

// Spike (Ralph loops in one session): the history at a loop boundary, the last turn being finish_task with the handoff.
function looped(): Message[] {
  const msgs = history([
    { tool: "read", input: { path: "a.ts" }, out: big("A") },
    { tool: "edit", input: { path: "a.ts", oldString: "x".repeat(400), newString: "y" }, out: "Edited a.ts" },
    { tool: "shell", input: { command: "npm test" }, out: big("FAIL") },
  ])
  msgs.push({ role: "assistant", content: [{ type: "text", text: "done" }, { type: "tool-call", id: "fin", name: "finish_task", input: { summary: "s" } }] })
  msgs.push({ role: "tool", content: [{ type: "tool-result", id: "fin", name: "finish_task", result: { type: "text", value: "Loop 1 of 3 is over … handoff" } }] })
  return msgs
}

test("a loop reset (stubs): every result before the boundary turn becomes a stub at once, and stays one", () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-ctx-"))
  const journal: Record<string, unknown>[] = []
  const m = new ContextManager({ dir, journal: (e) => journal.push(e) })
  m.apply("s", looped())
  m.requestReset("s", "stubs")
  const msgs = looped()
  const r = m.apply("s", msgs)
  for (const id of ["c0", "c1", "c2"]) assert.match(valueOf(msgs, id), /^\[loop reset/)
  assert.equal(valueOf(msgs, "fin"), "Loop 1 of 3 is over … handoff", "the handoff stays")
  const edit = msgs[3]!.content as { type?: string; input?: unknown }[]
  assert.deepEqual(edit.find((p) => p.type === "tool-call")!.input, { dropped: "[loop reset]" }, "a long input goes too")
  assert.equal(msgs.length, 9, "stubs keep every message")
  assert.ok(r.renderedChars > 3000)
  assert.equal(journal.find((e) => e.kind === "context.reset")?.results, 3)
  // a later request of the same session, with a new turn, and a manager started over from disk
  const later = looped()
  later.push({ role: "assistant", content: [{ type: "tool-call", id: "c9", name: "read", input: { path: "a.ts" } }] }, { role: "tool", content: [{ type: "tool-result", id: "c9", name: "read", result: { type: "text", value: "A2" } }] })
  new ContextManager({ dir }).apply("s", later)
  assert.match(valueOf(later, "c0"), /^\[loop reset/)
  assert.equal(valueOf(later, "c9"), "A2", "loop 2's own work is untouched")
})

test("a loop reset (cut): the request holds the brief and the turn that crossed the boundary, from then on", () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-ctx-"))
  const m = new ContextManager({ dir })
  m.requestReset("s", "cut")
  const msgs = looped()
  m.apply("s", msgs)
  assert.deepEqual(msgs.map((x) => x.role), ["user", "assistant", "tool"])
  assert.equal(valueOf(msgs, "fin"), "Loop 1 of 3 is over … handoff")
  const later = looped()
  later.push({ role: "assistant", content: [{ type: "tool-call", id: "c9", name: "read", input: { path: "a.ts" } }] }, { role: "tool", content: [{ type: "tool-result", id: "c9", name: "read", result: { type: "text", value: "A2" } }] })
  new ContextManager({ dir }).apply("s", later)
  assert.deepEqual(later.map((x) => x.role), ["user", "assistant", "tool", "assistant", "tool"], "the cut holds across a restart")
})
