import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { DEFAULT_BACKENDS, Decider, type Asker } from "../src/backends.ts"
import { capture, learnedLines } from "../src/context/capture.ts"
import { Embedder } from "../src/context/embed.ts"
import { CoreSnapshots, recall, recallBlock, RecentRecalls } from "../src/context/recall.ts"
import { diversify, search } from "../src/context/search.ts"
import { CORE_BUDGET, MemoryStore, parseEntry, projectSlug, renderEntry } from "../src/context/store.ts"

const dir = () => mkdtempSync(join(tmpdir(), "mem-"))

// A fake embedding service: a bag of words hashed into 64 dimensions, so texts sharing words are close.
function fakeEmbedder(down = false): Embedder {
  const f = (async (_url: string, init: { body: string }) => {
    if (down) throw new Error("connection refused")
    const { input } = JSON.parse(init.body) as { input: string[] }
    const data = input.map((t, index) => {
      const v = new Array(64).fill(0)
      for (const w of t.replace(/^Instruct:.*\nQuery:/s, "").toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 64, 7)] += 1
      return { index, embedding: v }
    })
    return { ok: true, json: async () => ({ data }) }
  }) as unknown as typeof fetch
  return new Embedder({ retryMs: 60_000 }, f)
}

function jev(answer: (questions: Record<string, unknown>) => Record<string, unknown>): Decider {
  const asker: Asker = { ask: async (_state, q) => ({ answers: answer(q as Record<string, unknown>) as never, model: "jev", latencyMs: 1 }) }
  return new Decider({ ...DEFAULT_BACKENDS, default: "typesafe" }, { typesafe: asker }, () => {})
}

test("store: entries are Markdown files; the index follows hand edits; core stays within its budget", () => {
  const root = dir()
  const s = new MemoryStore(root, { git: false })
  const a = s.add({ scope: "project", project: "p1", text: "Tests run with uv run pytest in the worktree", pinned: true })
  s.add({ scope: "project", project: "p2", text: "Another project's fact about pytest", pinned: false })
  s.add({ scope: "user", text: "The user wants short German replies", pinned: true })
  assert.deepEqual(parseEntry(renderEntry(a)), a)
  assert.deepEqual(s.list({ project: "p1" }).map((e) => e.text).sort(), ["Tests run with uv run pytest in the worktree", "The user wants short German replies"])
  assert.equal(s.keyword("how to run pytest", "p1")[0]!.id, a.id, "another project's entry is not found")
  // a hand edit of the file reaches the index when the store opens again
  const file = join(root, "entries", `${a.id}.md`)
  writeFileSync(file, readFileSync(file, "utf8").replace("uv run pytest", "make check").replace(/updated: ".*"/, 'updated: "2099-01-01"'))
  s.close()
  const again = new MemoryStore(root, { git: false })
  assert.equal(again.keyword("make check", "p1")[0]!.id, a.id)
  for (let i = 0; i < 12; i++) again.add({ scope: "project", project: "p1", text: `Pinned fact number ${i} `.padEnd(400, "x"), pinned: true })
  const core = again.list({ project: "p1", pinned: true }).filter((e) => e.scope === "project")
  assert.ok(core.reduce((n, e) => n + e.text.length, 0) <= CORE_BUDGET.project)
  assert.ok(again.list({ project: "p1", pinned: false }).length >= 1, "unpinned entries stay in the archive")
  assert.match(projectSlug("/home/u/Repos/My Project"), /^my-project-[0-9a-f]{6}$/)
})

test("search: keywords and vectors fused; keywords only while the service is down", async () => {
  const s = new MemoryStore(dir(), { git: false })
  s.add({ scope: "project", project: "p", text: "Run the tests with uv run pytest", pinned: false })
  s.add({ scope: "project", project: "p", text: "The sidebar is 36 characters wide", pinned: false })
  const up = await search(s, fakeEmbedder(), "how to run the tests with pytest", { project: "p", task: "recall" })
  assert.equal(up.vectors, true)
  assert.match(up.hits[0]!.entry.text, /pytest/)
  assert.ok(up.hits[0]!.similarity! > 0.3)
  const down = await search(s, fakeEmbedder(true), "pytest", { project: "p", task: "recall" })
  assert.equal(down.vectors, false)
  assert.match(down.hits[0]!.entry.text, /pytest/)
})

test("diversify: a second wording of the same fact loses to a different fact", () => {
  const e = (id: string, text: string) => ({ entry: { id, text, scope: "project" as const, pinned: false, created: "", updated: "" }, score: 1 })
  const hits = [e("a", "run tests with uv run pytest"), { ...e("b", "run the tests with uv run pytest please"), score: 0.95 }, { ...e("c", "sidebar width is 36 characters"), score: 0.6 }]
  assert.deepEqual(diversify(hits, () => undefined, 2).map((h) => h.entry.id), ["a", "c"])
})

test("capture: a near copy is a duplicate without Jev; Jev tells refinement and contradiction apart", async () => {
  const s = new MemoryStore(dir(), { git: false })
  const emb = fakeEmbedder()
  const first = await capture(s, emb, undefined, { text: "Tests run with uv run pytest in the worktree", source: "t" }, { project: "p" })
  assert.equal(first.kind, "added")
  const copy = await capture(s, emb, undefined, { text: "Tests run with uv run pytest in the worktree", source: "t" }, { project: "p" })
  assert.equal(copy.kind, "duplicate")
  const refine = jev((q) => ({ lasting: { type: "noul", noul: 0.9 }, useful: { type: "noul", noul: 0.9 }, scope: { type: "choice", choice: "project", confidence: 1, probabilities: {} }, ...(q.relation ? { relation: { type: "choice", choice: "refines", confidence: 1, probabilities: {} }, which: { type: "choice", choice: "n0", confidence: 1, probabilities: {} } } : {}) }))
  const r = await capture(s, emb, refine, { text: "Tests run with uv run pytest -x in the worktree since the split", source: "t" }, { project: "p" })
  assert.equal(r.kind, "refined")
  assert.equal(s.list({ project: "p" }).length, 1, "a refinement replaces, it does not add")
  const contra = jev((q) => ({ lasting: { type: "noul", noul: 0.9 }, useful: { type: "noul", noul: 0.9 }, scope: { type: "choice", choice: "global", confidence: 1, probabilities: {} }, ...(q.relation ? { relation: { type: "choice", choice: "contradicts", confidence: 1, probabilities: {} }, which: { type: "choice", choice: "n0", confidence: 1, probabilities: {} } } : {}) }))
  const c = await capture(s, emb, contra, { text: "Tests run with plain pytest, uv is not used in the worktree", source: "t" }, { project: "p" })
  assert.equal(c.kind, "contradicts")
  const dull = jev(() => ({ lasting: { type: "noul", noul: 0.1 }, useful: { type: "noul", noul: 0.9 } }))
  assert.equal((await capture(s, emb, dull, { text: "I renamed the variable foo to bar in line 12", source: "t" }, { project: "p" })).kind, "dropped")
  assert.deepEqual(learnedLines("done.\nLEARNED: ruff needs --fix for imports\n- **LEARNED:** none\nLEARNED: tests need uv"), ["ruff needs --fix for imports", "tests need uv"])
})

test("recall: Jev's picks within the role's budget, the rest as pointers; held-back entries stay out", async () => {
  const s = new MemoryStore(dir(), { git: false })
  const emb = fakeEmbedder()
  const ids = ["Run the tests with uv run pytest", "pytest needs the fixtures in tests/conftest.py", "The sidebar is 36 characters wide"].map((text) => s.add({ scope: "project", project: "p", text, pinned: false }).id)
  const yes = jev((q) => Object.fromEntries(Object.keys(q).map((k) => [k, { type: "noul", noul: 0.9 }])))
  const r = await recall(s, emb, yes, "fix the failing pytest tests", { project: "p", role: "code" })
  assert.ok(r.picked.some((h) => h.entry.id === ids[0]))
  assert.match(recallBlock(r), /^\[memory\] Notes from earlier work/)
  const held = await recall(s, emb, yes, "fix the failing pytest tests", { project: "p", role: "code", exclude: new Set([ids[0]!]) })
  assert.ok(!held.picked.some((h) => h.entry.id === ids[0]))
  const recents = new RecentRecalls()
  recents.next("s")
  recents.given("s", ["x"])
  assert.ok(recents.next("s").has("x"))
  recents.next("s"); recents.next("s")
  assert.ok(!recents.next("s").has("x"), "held back for three user turns only")
  const cores = new CoreSnapshots()
  let n = 0
  assert.equal(cores.get("s", () => `core ${++n}`), "core 1")
  assert.equal(cores.get("s", () => `core ${++n}`), "core 1", "the same bytes until refreshed")
  cores.refresh("s")
  assert.equal(cores.get("s", () => `core ${++n}`), "core 2")
})
