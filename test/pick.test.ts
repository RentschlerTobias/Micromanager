import assert from "node:assert/strict"
import { test } from "node:test"

import { combineBase, comparisonPage, pickForm, pickNote, readPick, type Candidate } from "../src/pick.ts"

const cands: Candidate[] = [
  { id: "T1", model: "opencode-go/qwen3.8-flash", cost: 0.012, lines: { added: 40, removed: 2 }, files: ["index.html"], summary: "a bold <hero>", preview: { path: "index.html", png: Buffer.from("png") } },
  { id: "T2", model: "opencode-go/glm-5.3-flash", lines: { added: 12, removed: 0 }, files: ["index.html", "style.css"], preview: { path: "index.html", problem: "No picture: no browser" } },
]

test("the pick form offers each passed attempt, a combination and none, and asks for words for the last two", () => {
  const q = pickForm("T1", "Landing page hero", cands, "/p/.micromanager/trials/j-T1.html")
  assert.equal(q[0]!.header, "Pick T1")
  assert.deepEqual(q[0]!.options.map((o) => o.label), ["T1", "T2", "Combine", "None of them"])
  assert.match(q[0]!.options[0]!.description, /qwen3\.8-flash · \$0\.012 · \+40\/-2 lines/)
  assert.match(q[0]!.options[1]!.description, /cost unknown/)
  assert.equal(q[1]!.header, "Pick T1 notes")
  assert.match(pickNote("T1", "Landing page hero", cands, "/x.html"), /Ask them with the question tool, with exactly this input[\s\S]*"header":"Pick T1"[\s\S]*Do not pick for them/)
})

test("the pick answer: an attempt, a combination or none with the user's words; anything else is unclear", () => {
  const q = pickForm("T1", "hero", cands, "/x.html")
  assert.deepEqual(readPick(q, [["T2"], ["Nothing to add"]]), { head: "T1", answer: { kind: "attempt", id: "T2" } })
  assert.deepEqual(readPick(q, [["Combine"], ["layout of T2, colours of T1"]]), { head: "T1", answer: { kind: "combine", notes: "layout of T2, colours of T1" } })
  assert.deepEqual(readPick(q, [["None of them"], ["too dark"]]), { head: "T1", answer: { kind: "none", notes: "too dark" } })
  assert.deepEqual(readPick(q, [["the first one"], []]), { head: "T1", answer: { kind: "unclear", said: "the first one" } })
  assert.equal(readPick([{ header: "Grant G1" }], [["Allow"]]), undefined)
  assert.equal(combineBase("layout of t2, colours of T1", ["T1", "T2"]), "T2")
  assert.equal(combineBase("mix them", ["T1", "T2"]), "T1")
})

test("the comparison page shows each version with its picture or why there is none, escaped", () => {
  const html = comparisonPage("T1", "Landing <page>", cands)
  assert.match(html, /<img src="data:image\/png;base64,cG5n"/)
  assert.match(html, /No picture: no browser/)
  assert.match(html, /a bold &lt;hero&gt;/)
  assert.match(html, /Landing &lt;page&gt;/)
  assert.match(html, /prefers-color-scheme:dark/)
})
