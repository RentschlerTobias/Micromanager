import assert from "node:assert/strict"
import { test } from "node:test"

import { DEFAULT_REGISTRY } from "../src/registry.ts"
import { family, MODELS, roleById } from "../src/roles.ts"
import { chooseModel, DEFAULT_ROUTING, FREE_BUDGET } from "../src/routing.ts"
import { seedFromJournal, Usage, WINDOW_MS } from "../src/usage.ts"

const budget = (model: string) => DEFAULT_REGISTRY.find((m) => m.id === model)?.budget
const picks = async (role: string, n: number, usage = new Usage(), extra: { avoidFamilies?: string[]; worker?: string } = {}) => {
  const counts = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    const c = await chooseModel(roleById(role)!, { vision: false }, DEFAULT_ROUTING, extra.worker, undefined, { usage, budget, avoidFamilies: extra.avoidFamilies })
    counts.set(c.model, (counts.get(c.model) ?? 0) + 1)
  }
  return counts
}

test("a role's tasks spread over its pool in proportion to each model's monthly budget", async () => {
  // code: glm $60, mimo-pro $15, deepseek $80, step $60 = $215; 43 tasks are one task per $5
  const counts = await picks("code", 43)
  assert.deepEqual(Object.fromEntries(counts), { [MODELS.glm]: 12, [MODELS.mimo]: 3, [MODELS.deepseek]: 16, [MODELS.step]: 12 })
})

test("the free model is weighted like a $60 one, or it would take every task of its pools", async () => {
  // explore: minimax free (as $60), deepseek $80, qwen $30, mimo-flash $60 = $230
  const counts = await picks("explore", 23)
  assert.equal(counts.get(MODELS.minimax), 6)
  assert.equal(FREE_BUDGET, 60)
  assert.equal(counts.size, 4, "every model of the pool gets work")
})

test("the first pick says why: least used, with each model's tasks per budget", async () => {
  const usage = new Usage()
  usage.record(MODELS.glm)
  const c = await chooseModel(roleById("code")!, { vision: false }, DEFAULT_ROUTING, undefined, undefined, { usage, budget })
  assert.equal(c.model, MODELS.mimo, "glm has a task already; mimo-v2.6-pro is first of the untouched ones")
  assert.match(c.reason, /^least used of code: mimo-v2\.6-pro \(0\/\$15\) over glm-5\.3-flash \(1\/\$60\), deepseek-v4\.1-flash \(0\/\$80\), step-5-preview \(0\/\$60\)$/)
})

test("a task started again runs on another family than its failed attempt", async () => {
  const counts = await picks("code", 20, new Usage(), { avoidFamilies: ["glm"] })
  assert.equal(counts.get(MODELS.glm), undefined)
  const one = await chooseModel(roleById("code")!, { vision: false }, DEFAULT_ROUTING, undefined, undefined, { usage: new Usage(), budget, avoidFamilies: ["glm"] })
  assert.match(one.reason, /\(not glm: the failed attempt's family\)$/)
  // a pool of one family cannot leave it: the planner's fallback is still taken rather than nothing
  const plan = await chooseModel(roleById("plan")!, { vision: false }, DEFAULT_ROUTING, undefined, undefined, { usage: new Usage(), budget, avoidFamilies: ["gemini", "glm"] })
  assert.ok([MODELS.gemini, MODELS.glm].includes(plan.model as never))
})

test("a review spreads too, but never onto the writer's family", async () => {
  const counts = await picks("review", 15, new Usage(), { worker: MODELS.haiku })
  assert.equal(counts.get(MODELS.haiku), undefined)
  // gemini $60 and deepseek $80 share the 15 reviews of Haiku's work by budget (a tie goes to the pool's first)
  assert.deepEqual(Object.fromEntries(counts), { [MODELS.gemini]: 7, [MODELS.deepseek]: 8 })
  assert.ok([...counts.keys()].every((m) => family(m) !== "claude"))
})

test("the week's routing records seed the counts, and older ones drop out", () => {
  const now = Date.parse("2026-10-19T12:00:00Z")
  const day = 24 * 60 * 60_000
  const seed = seedFromJournal([
    { kind: "routing", model: MODELS.glm, time: new Date(now - day).toISOString() },
    { kind: "routing", model: MODELS.glm, time: new Date(now - 2 * day).toISOString() },
    { kind: "routing", model: MODELS.deepseek, time: new Date(now - 8 * day).toISOString() },
    { kind: "permission", model: MODELS.glm, time: new Date(now - day).toISOString() },
    { kind: "routing", time: new Date(now).toISOString() },
  ], now)
  assert.deepEqual(seed.map((p) => p.model), [MODELS.glm, MODELS.glm])
  let clock = now
  const usage = new Usage(seed, () => clock)
  assert.equal(usage.count(MODELS.glm), 2)
  assert.equal(usage.count(MODELS.deepseek), 0, "eight days ago is outside the week")
  clock = now + WINDOW_MS
  assert.equal(usage.count(MODELS.glm), 0)
})
