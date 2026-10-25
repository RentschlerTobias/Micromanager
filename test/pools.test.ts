import assert from "node:assert/strict"
import { test } from "node:test"

import { NO_PICKS } from "../src/config.ts"
import { agentOptions, CLEAR, modelOptions, poolRows, RESET, shortNames, toggle, updatePicks, VISION, type CatalogModel } from "../src/pools.ts"
import { MODELS, roleById } from "../src/roles.ts"
import { DEFAULT_ROUTING } from "../src/routing.ts"

const go = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({ id, providerID: "opencode-go", name: id, enabled: true, status: "active", capabilities: { input: ["text"] }, ...extra })
const catalog = [
  go("glm-5.3-flash"), go("mimo-v2.6-pro"), go("deepseek-v4.1-flash"), go("qwen3.8-flash", { capabilities: { input: ["text", "image"] } }),
  go("retired-1", { status: "deprecated" }), go("off-1", { enabled: false }),
  { id: "minimax-m3.1-flash-free", providerID: "opencode", name: "MiniMax Free", enabled: true, status: "active" },
]

test("the rows are the default pools until the user picks, and a pick is marked as the user's", () => {
  const rows = poolRows(DEFAULT_ROUTING, NO_PICKS)
  const coder = rows.find((r) => r.agent === "coder")!
  assert.deepEqual(coder.models, roleById("code")!.models)
  assert.equal(coder.own, false)
  assert.deepEqual(rows.at(-1), { key: VISION, agent: VISION, models: [MODELS.qwen], own: false })
  const picked = poolRows(DEFAULT_ROUTING, { models: { code: [MODELS.mimo] }, vision: MODELS.glm })
  assert.deepEqual(picked.find((r) => r.agent === "coder"), { key: "code", agent: "coder", models: [MODELS.mimo], own: true })
  assert.deepEqual(picked.at(-1)!.models, [MODELS.glm])
})

test("short names tell two models of one family apart", () => {
  assert.deepEqual(shortNames([MODELS.glm, MODELS.mimo, MODELS.mimoFlash]), ["glm", "mimo-p", "mimo-f"])
})

test("the popup lists what the host runs, by provider with the pool's first, the pool checked", () => {
  const coder = { key: "code" as const, agent: "coder", models: [MODELS.glm, MODELS.mimo, MODELS.step], own: true }
  const options = modelOptions(catalog, coder, (m) => (m === MODELS.glm ? 9 : 0), (m) => (m === MODELS.glm ? 60 : undefined))
  assert.deepEqual(options.map((o) => `${o.category}: ${o.title}`), [
    "coder: ↺ back to the default",
    "coder: ✕ clear all",
    "opencode-go: [ ] deepseek-v4.1-flash",
    "opencode-go: [x] glm-5.3-flash",
    "opencode-go: [x] mimo-v2.6-pro",
    "opencode-go: [ ] qwen3.8-flash",
    "opencode: [ ] MiniMax Free",
    "not available here: [x] step-5-preview",
  ])
  assert.equal(options.find((o) => o.value === MODELS.glm)!.description, "#1 · 9 tasks/7d · $60/month")
  // The vision row offers only models with image input.
  const vision = poolRows(DEFAULT_ROUTING, NO_PICKS).at(-1)!
  assert.deepEqual(modelOptions(catalog, vision).map((o) => o.value), [RESET, MODELS.qwen])
})

test("clear all unchecks the pool, and the next check starts a new one", () => {
  const coder = { key: "code" as const, agent: "coder", models: [MODELS.glm, MODELS.mimo], own: true }
  const cleared = { ...coder, models: [] }
  const options = modelOptions(catalog, cleared)
  assert.ok(options.every((o) => !o.title.startsWith("[x]")))
  assert.ok(!options.some((o) => o.value === CLEAR))
  assert.deepEqual(toggle(cleared, MODELS.deepseek), [MODELS.deepseek])
})

test("a toggle adds at the end, takes out, never empties a pool; vision holds one", () => {
  const row = { key: "code" as const, agent: "coder", models: [MODELS.glm, MODELS.mimo], own: false }
  assert.deepEqual(toggle(row, MODELS.deepseek), [MODELS.glm, MODELS.mimo, MODELS.deepseek])
  assert.deepEqual(toggle(row, MODELS.glm), [MODELS.mimo])
  assert.equal(toggle({ ...row, models: [MODELS.glm] }, MODELS.glm), undefined)
  assert.deepEqual(toggle({ key: VISION, agent: VISION, models: [MODELS.qwen], own: false }, MODELS.glm), [MODELS.glm])
})

test("a pool back at its default, or reset, leaves the picks file", () => {
  const picks = updatePicks(NO_PICKS, DEFAULT_ROUTING, "code", [MODELS.mimo])
  assert.deepEqual(picks, { models: { code: [MODELS.mimo] } })
  assert.deepEqual(updatePicks(picks, DEFAULT_ROUTING, "code", RESET), NO_PICKS)
  assert.deepEqual(updatePicks(picks, DEFAULT_ROUTING, "code", roleById("code")!.models), NO_PICKS)
  const vision = updatePicks(picks, DEFAULT_ROUTING, VISION, [MODELS.glm])
  assert.equal(vision.vision, MODELS.glm)
  assert.deepEqual(updatePicks(vision, DEFAULT_ROUTING, VISION, [MODELS.qwen]), picks)
})

test("step one names the micromanager's session model and every row's pool", () => {
  const options = agentOptions(poolRows(DEFAULT_ROUTING, { models: { review: [MODELS.haiku] } }), "opencode-go/glm-5.3-flash")
  assert.equal(options[0]!.description, "glm-5.3-flash · the session's model: /model")
  assert.deepEqual(options.find((o) => o.value === "review"), { title: "reviewer ✎", value: "review", description: "claude" })
})
