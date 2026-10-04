import assert from "node:assert/strict"
import { test } from "node:test"

import { DEFAULT_REGISTRY, mergeRegistry, probe, route, tierFor } from "../src/registry.ts"

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

// What the local servers answered in Phase A: ornith-u loaded on the 4060, the iGPU idle, FLM up.
const fakeFetch = (async (url: string | URL) => {
  const u = String(url)
  if (u.endsWith(":8000/v1/models")) return json({ data: [{ id: "ornith-u", status: { value: "loaded" } }, { id: "oss-u", status: { value: "unloaded" } }, { id: "ornith", status: { value: "unloaded" } }, { id: "mimo", status: { value: "unloaded" } }, { id: "ornith-u-s", status: { value: "unloaded" } }] })
  if (u.endsWith(":8092/health")) return json({ status: "ok" })
  if (u.endsWith(":8092/slots")) return json([{ is_processing: false }, { is_processing: true }])
  if (u.endsWith(":52625/v1/models")) return json({ data: [{ id: "qwen3:4b" }, { id: "qwen3vl-it:4b" }] })
  throw new Error("unreachable " + u)
}) as typeof fetch

test("probe reads loaded models, iGPU health and slots, and the NPU catalog", async () => {
  const a = await probe(DEFAULT_REGISTRY, undefined, fakeFetch)
  assert.deepEqual(a.get("llamaswap/ornith-u"), { reachable: true, loaded: true })
  assert.deepEqual(a.get("llamaswap/oss-u"), { reachable: true, loaded: false })
  assert.deepEqual(a.get("llamaigpu/qwen3.8-u"), { reachable: true, loaded: true, busy: false })
  assert.deepEqual(a.get("flmnpu/qwen3:4b"), { reachable: true })
  assert.deepEqual(a.get("opencode-go/glm-5.3-flash"), { reachable: true })
})

test("probe marks everything local unreachable when the servers are down", async () => {
  const down = (async () => { throw new Error("down") }) as typeof fetch
  const a = await probe(DEFAULT_REGISTRY, undefined, down)
  assert.equal(a.get("llamaswap/ornith-u")?.reachable, false)
  assert.equal(a.get("llamaigpu/qwen3.8-u")?.reachable, false)
  assert.equal(route(DEFAULT_REGISTRY, { role: "code", difficulty: 0.5 }, a).model?.startsWith("opencode-go/"), true)
})

test("local when capable, and the loaded model wins over a swap", async () => {
  const a = await probe(DEFAULT_REGISTRY, undefined, fakeFetch)
  const r = route(DEFAULT_REGISTRY, { role: "code", difficulty: 0.5 }, a)
  assert.equal(r.model, "llamaswap/ornith-u")
  assert.match(r.reason, /local, agent task, already loaded/)
})

test("a hard task goes to the local deep model when it exists, else the cloud", async () => {
  const a = await probe(DEFAULT_REGISTRY, undefined, fakeFetch)
  assert.equal(route(DEFAULT_REGISTRY, { role: "oracle", difficulty: 0.9 }, a).model, "llamaswap/oss-u")
  const noDeep = DEFAULT_REGISTRY.filter((m) => m.id !== "llamaswap/oss-u")
  assert.equal(route(noDeep, { role: "oracle", difficulty: 0.9 }, a).model?.startsWith("opencode-go/"), true)
})

test("long contexts and the cloud pin go to the cloud", async () => {
  const a = await probe(DEFAULT_REGISTRY, undefined, fakeFetch)
  assert.equal(route(DEFAULT_REGISTRY, { role: "code", ctx: 60000 }, a).model?.startsWith("opencode-go/"), true)
  assert.equal(route(DEFAULT_REGISTRY, { role: "code", preferCloud: true }, a).model?.startsWith("opencode-go/"), true)
})

test("refusal_likely goes to a local uncensored model, sensitive to any local model", async () => {
  const a = await probe(DEFAULT_REGISTRY, undefined, fakeFetch)
  const unc = route(DEFAULT_REGISTRY, { role: "code", refusalLikely: true, ctx: 60000 }, a)
  assert.equal(unc.model, undefined, "no local model has 60k context")
  assert.match(unc.reason, /uncensored, local/)
  const r = route(DEFAULT_REGISTRY, { role: "code", refusalLikely: true }, a)
  assert.ok(r.ranked.every((id) => !DEFAULT_REGISTRY.find((m) => m.id === id)?.censored))
  assert.ok(route(DEFAULT_REGISTRY, { role: "code", sensitive: true, preferCloud: true }, a).ranked.every((id) => !id.startsWith("opencode-go/")))
})

test("the NPU only takes quick read-and-write work, never agentic roles", async () => {
  const a = await probe(DEFAULT_REGISTRY, undefined, fakeFetch)
  assert.ok(!route(DEFAULT_REGISTRY, { role: "code", difficulty: 0.1 }, a).ranked.some((id) => id.startsWith("flmnpu/")))
  assert.ok(route(DEFAULT_REGISTRY, { role: "explore", difficulty: 0.1 }, a).ranked.includes("flmnpu/qwen3:4b"))
  assert.ok(!route(DEFAULT_REGISTRY, { role: "explore" }, a).ranked.includes("flmnpu/gpt-oss:20b"), "disabled")
})

test("a reviewer avoids the writer's family; vision filters", async () => {
  const a = await probe(DEFAULT_REGISTRY, undefined, fakeFetch)
  const r = route(DEFAULT_REGISTRY, { role: "review", avoidFamilies: ["ornith"] }, a)
  assert.ok(r.model && !r.model.includes("ornith"))
  assert.ok(route(DEFAULT_REGISTRY, { role: "visual", vision: true }, a).ranked.every((id) => DEFAULT_REGISTRY.find((m) => m.id === id)?.vision))
})

test("tiers and registry overrides", () => {
  assert.deepEqual([tierFor(0.1), tierFor(0.5), tierFor(0.9), tierFor()], ["quick", "agent", "deep", "agent"])
  const merged = mergeRegistry(DEFAULT_REGISTRY, [{ id: "llamaswap/mimo", disabled: true }, { id: "llamaswap/new-model", censored: false }])
  assert.equal(merged.find((m) => m.id === "llamaswap/mimo")?.disabled, true)
  assert.deepEqual(merged.find((m) => m.id === "llamaswap/new-model"), { id: "llamaswap/new-model", location: "local", device: "cuda", censored: false, family: "new", tier: "agent", vision: false, ctx: 16384 })
})
