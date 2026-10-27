import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import type { Contract } from "../src/contract.ts"
import { estimate, evolverFits, evolverForm, heldOutProblem, markBlock, progressOf, readMethod, runEvolver, specOf, startBridge } from "../src/evolver.ts"

const contract = (extra: Partial<Contract> = {}): Contract => ({
  id: "C1", version: 2, status: "frozen", goal: "faster", evaluator: "node bench.js", timeoutMs: 60_000, repeats: 1,
  scores: [{ name: "ms", direction: "min" }], guards: [{ name: "correct", direction: "max", tolerance: 0, origin: "user" }],
  corpus: { visible: ["corpus/"] }, baseline: { values: { ms: 200, correct: 2 }, heldOut: { ms: 150 }, at: "" }, stop: { target: { ms: 50 } }, history: [],
  ...extra,
})

test("the evolving block is marked by a function's name or a line range, in the file's comment syntax", () => {
  const js = "const a = 1\nfunction countWords(text) {\n  const s = '}'\n  if (text) { return 1 }\n  return 0\n}\n\nmodule.exports = {}"
  const m = markBlock(js, "search.js", "countWords")
  assert.deepEqual(m.lines, [2, 6])
  assert.equal(m.text, "const a = 1\n// EVOLVE-BLOCK-START\nfunction countWords(text) {\n  const s = '}'\n  if (text) { return 1 }\n  return 0\n}\n// EVOLVE-BLOCK-END\n\nmodule.exports = {}")
  assert.deepEqual(markBlock("const f = async (x) => {\n  return x\n}\n", "a.ts", "f").lines, [1, 3])
  const py = "import os\n\ndef count(text):\n    words = text.split()\n\n    return len(words)\n\nprint(count('a'))\n"
  assert.match(markBlock(py, "count.py", "count").text!, /^import os\n\n# EVOLVE-BLOCK-START\ndef count\(text\):\n    words = text\.split\(\)\n\n    return len\(words\)\n# EVOLVE-BLOCK-END\n\nprint/)
  assert.deepEqual(markBlock(js, "search.js", "3-5").lines, [3, 5])
  assert.match(markBlock(js, "search.js", "7-99").problem!, /not inside search\.js \(8 lines\)/)
  assert.match(markBlock(js, "search.js", "nope").problem!, /no definition of nope/)
})

test("progress is read off evals.jsonl, the best by combined score among the valid ones", () => {
  const lines = [{ valid: 1, combined_score: 1, ms: 200 }, { valid: 0, combined_score: 0 }, { valid: 1, combined_score: 8, ms: 25 }, { valid: 1, combined_score: 3, ms: 60 }]
  assert.deepEqual(progressOf(lines.map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n"), { evaluations: 4, valid: 3, best: { valid: 1, combined_score: 8, ms: 25 } })
  assert.deepEqual(progressOf(""), { evaluations: 0, valid: 0 })
})

test("the spec carries the contract's measure, the bridge and the sandbox runner", () => {
  const s = specOf({ workdir: "/w", file: "search.js", initial: "/o/initial.js", checks: ["npm test"], contract: contract(), output: "/o", models: ["m/a"], iterations: 12, heldOutDir: "/held", runner: ["node", "cli.ts", "sandboxed", "--dir", "{dir}", "--"], bridge: { url: "http://127.0.0.1:9", token: "t" } })
  assert.deepEqual([s.evaluator, s.scores, s.guards, s.baseline, s.target, s.timeout_s, s.api_base, s.api_key, s.held_out_dir], ["node bench.js", [{ name: "ms", direction: "min" }], [{ name: "correct", direction: "max", tolerance: 0 }], { ms: 200, correct: 2 }, { ms: 50 }, 60, "http://127.0.0.1:9/v1", "t", "/held"])
})

test("the best is kept out when the held-out cases say it learned the corpus, not the task", () => {
  assert.equal(heldOutProblem(contract(), { valid: 1, combined_score: 9, ms: 100 }), undefined)
  assert.match(heldOutProblem(contract(), { valid: 1, ms: 180 })!, /worse than today's code \(ms 180 against 150\)/)
  assert.match(heldOutProblem(contract(), { valid: 0, error: "check failed" })!, /invalid on the held-out cases \(check failed\)/)
  assert.equal(heldOutProblem(contract(), null), undefined)
})

test("the bridge answers OpenEvolve's client like an OpenAI endpoint, for its own token only", async () => {
  const asked: string[] = []
  const bridge = await startBridge(async (model, system, prompt) => {
    asked.push(`${model}|${system}|${prompt}`)
    if (prompt === "fail") throw new Error("no model")
    return { text: "<<<<<<< SEARCH", tokens: 42, cost: 0.001 }
  })
  try {
    const call = (token: string, content: string) => fetch(`${bridge.url}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "m/a", messages: [{ role: "system", content: "be brief" }, { role: "user", content }] }) })
    const ok = (await (await call(bridge.token, "mutate")).json()) as { choices: { message: { content: string } }[] }
    assert.equal(ok.choices[0]!.message.content, "<<<<<<< SEARCH")
    assert.deepEqual(asked, ["m/a|be brief|mutate"])
    assert.equal((await call("wrong", "x")).status, 401)
    assert.equal((await call(bridge.token, "fail")).status, 500)
    assert.deepEqual(bridge.calls(), { calls: 1, failed: 1, tokens: 42, cost: 0.001 })
  } finally {
    await bridge.close()
  }
})

test("the sidecar's run is watched through evals.jsonl and ends with its result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jd-evolve-"))
  // A stand-in for `uv run … mm-evolve spec.json`: two evaluations, then the result.
  const fake = join(dir, "uv")
  writeFileSync(fake, [
    "#!/bin/sh",
    'spec="$6"; out=$(dirname "$spec")',
    'echo \'{"valid":1,"combined_score":1,"ms":200}\' >> "$out/evals.jsonl"; sleep 0.3',
    'echo \'{"valid":1,"combined_score":4,"ms":50}\' >> "$out/evals.jsonl"',
    'echo "x" > "$out/best.js"',
    'echo "{\\"best\\":\\"$out/best.js\\",\\"metrics\\":{\\"ms\\":50},\\"heldOut\\":null,\\"seconds\\":1}" > "$out/result.json"',
    "",
  ].join("\n"))
  chmodSync(fake, 0o755)
  const spec = specOf({ workdir: dir, file: "a.js", initial: join(dir, "i.js"), checks: [], contract: contract(), output: join(dir, "out"), models: ["m"], iterations: 2, runner: [], bridge: { url: "http://x", token: "t" } })
  const seen: number[] = []
  const run = runEvolver(spec, (p) => seen.push(p.evaluations), { uv: fake, dir, pollMs: 100 })
  const { result, problem } = await run.done
  assert.equal(problem, undefined)
  assert.deepEqual(result!.metrics, { ms: 50 })
  assert.equal(seen.at(-1), 2)
  const failing = runEvolver({ ...spec, output: join(dir, "out2") }, () => undefined, { uv: "/bin/false", dir })
  assert.match((await failing.done).problem!, /ended with code 1/)
})

test("the evolver is offered for a frozen contract that measures fast, on one or two files, with what it would take", () => {
  const fast = contract({ costPerEval: 0.4 })
  assert.equal(evolverFits(fast, ["search.js"]), true)
  assert.equal(evolverFits(fast, ["a.js", "b.js", "c.js"]), false, "a wide change is a worker's")
  assert.equal(evolverFits(contract({ costPerEval: 4, repeats: 3 }), ["a.js"]), false, "12 s per measurement is too slow")
  assert.equal(evolverFits(contract({ costPerEval: 0.4, status: "draft" }), ["a.js"]), false)
  assert.equal(evolverFits(contract(), ["a.js"]), false, "never measured")
  assert.deepEqual(estimate(fast, 0.004), { iterations: 30, minutes: 13, cost: 0.12 })
  assert.deepEqual(estimate(contract({ costPerEval: 0.4, stop: { evaluations: 10 } }), 0.004), { iterations: 10, minutes: 4, cost: 0.04 })
  const form = evolverForm("M2", "faster search", ["search.js"], fast, estimate(fast, 0.004))
  assert.equal(form[0]!.header, "Method M2")
  assert.match(form[0]!.options[0]!.description, /about 30 variants in the sandbox, .* about 13 min and 0\.12 in model calls/)
  assert.deepEqual(readMethod("Method M2", ["Evolver (Recommended)"]), { id: "M2", method: "evolver" })
  assert.deepEqual(readMethod("Method M2", ["One worker"]), { id: "M2", method: "worker" })
  assert.deepEqual(readMethod("Method M2", ["whatever"]), { id: "M2", said: "whatever" })
  assert.equal(readMethod("Change K1", ["Trial"]), undefined)
})
