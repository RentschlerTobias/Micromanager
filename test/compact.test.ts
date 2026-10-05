import assert from "node:assert/strict"
import { test } from "node:test"

import { DEFAULT_BACKENDS, Decider, type Asker } from "../src/backends.ts"
import { candidates, Compactor, prune } from "../src/compact.ts"

// A micromanager history: a user request, then turns that each call a tool and get a result back.
function history(results: { tool: string; size: number }[]) {
  const msgs: Record<string, unknown>[] = [{ role: "user", content: [{ type: "text", text: "plan the voice rework" }] }]
  results.forEach((r, i) => {
    msgs.push({ role: "assistant", content: [{ type: "text", text: `step ${i}` }, { type: "tool-call", id: `c${i}`, name: r.tool, input: { id: `T${i}` } }] })
    msgs.push({ role: "tool", content: [{ type: "tool-result", id: `c${i}`, name: r.tool, result: { type: "text", value: `R${i} `.padEnd(r.size, "x") } }] })
  })
  msgs.push({ role: "assistant", content: [{ type: "text", text: "now" }] })
  return msgs
}

const value = (msgs: Record<string, unknown>[], id: string) =>
  ((msgs.find((m) => m.role === "tool" && (m.content as { id: string }[])[0]!.id === id)!.content as { result: { value: string } }[])[0]!.result.value)

test("candidates: old and large tool results, not the last turns' and not small ones", () => {
  const msgs = history([{ tool: "list_tasks", size: 9000 }, { tool: "read", size: 300 }, { tool: "list_tasks", size: 9000 }, { tool: "read", size: 5000 }])
  const c = candidates(msgs as never, { keepTurns: 2, minChars: 800, startChars: 0, reaskAge: 6, ruleAge: 8 })
  assert.deepEqual(c.map((x) => [x.id, x.age]), [["c0", 4], ["c2", 2]])
  assert.match(c[0]!.input, /T0/)
})

test("Jev decides per result; dropped ones become a stub and stay dropped in later turns", async () => {
  const asked: string[][] = []
  const jev: Asker = {
    ask: async (state, q) => {
      asked.push(Object.keys(q))
      const results = (JSON.parse(state) as { results: { input: string }[] }).results
      return { answers: Object.fromEntries(results.map((r, i) => [`needed.${i}`, { type: "noul", noul: r.input.includes("T0") ? 0.1 : 0.9 }])) as never, model: "jev", latencyMs: 1 }
    },
  }
  const journal: Record<string, unknown>[] = []
  const comp = new Compactor(new Decider({ ...DEFAULT_BACKENDS, default: "typesafe" }, { typesafe: jev }, () => {}), (e) => journal.push(e), { startChars: 1000 })
  const msgs = history([{ tool: "list_tasks", size: 9000 }, { tool: "list_tasks", size: 9000 }, { tool: "read", size: 100 }, { tool: "read", size: 100 }])
  const r = await comp.apply("ses_1", msgs)
  assert.equal(r.asked, 2)
  assert.match(value(msgs, "c0"), /^\[jev-dictator: this earlier list_tasks result \(9000 characters; \{"id":"T0"\}\) was dropped/)
  assert.match(value(msgs, "c1"), /^R1 x/, "the one Jev called needed stays")
  assert.ok(r.removed > 8000)
  // the next turn rebuilds the history from scratch: T0 is dropped again without asking, T1 is not asked again yet
  const next = history([{ tool: "list_tasks", size: 9000 }, { tool: "list_tasks", size: 9000 }, { tool: "read", size: 100 }, { tool: "read", size: 100 }, { tool: "read", size: 100 }])
  const r2 = await comp.apply("ses_1", next)
  assert.equal(r2.asked, 0)
  assert.match(value(next, "c0"), /was dropped/)
  assert.equal(asked.length, 1)
  assert.equal(journal[0]!.kind, "compaction")
})

test("nothing is asked while the old results are small in total; without Jev old ones go by age", async () => {
  const quiet = new Compactor(undefined, () => {}, { startChars: 1e9 })
  const msgs = history([{ tool: "read", size: 5000 }, { tool: "read", size: 100 }, { tool: "read", size: 100 }])
  assert.deepEqual(await quiet.apply("s", msgs), { removed: 0, asked: 0 })
  const rules = new Compactor(undefined, () => {}, { startChars: 0, ruleAge: 4 })
  const many = history([{ tool: "read", size: 5000 }, { tool: "read", size: 5000 }, { tool: "read", size: 100 }, { tool: "read", size: 100 }])
  await rules.apply("s", many)
  assert.match(value(many, "c0"), /was dropped/, "4 turns old")
  assert.match(value(many, "c1"), /^R1/, "3 turns old: still kept")
})

test("prune leaves other parts alone", () => {
  const msgs = history([{ tool: "read", size: 1000 }])
  assert.equal(prune(msgs as never, new Map()), 0)
})
