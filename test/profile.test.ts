import assert from "node:assert/strict"
import { test } from "node:test"

import type { Asked } from "../src/backends.ts"
import type { Answer } from "../src/jev.ts"
import { choosePipeline, citationCheck, parseReview, readerCount, researchPath, TEST_FILE } from "../src/pipelines.ts"
import { classifyQuestions, combine, narrowing, profileText, type Skill } from "../src/profile.ts"
import type { Acceptance, Task } from "../src/state.ts"

const task = (over: Partial<Task> = {}): Task => ({
  id: "T1", title: "add mean()", description: "in stats.js", role: "code", acceptance: ["A1"], dependsOn: [], files: ["stats.js"],
  wave: 0, status: "ready", attempts: 0, stages: [], signatures: [], ...over,
})
const acc: Acceptance[] = [{ id: "A1", text: "mean works", verify: "npm test" }]

const asked = (answers: Record<string, Answer>): Asked => ({ id: "d1", backend: "typesafe", decision: { answers, model: "jev", latencyMs: 1 } })
const choice = (c: string, confidence = 0.9): Answer => ({ type: "choice", choice: c, confidence, probabilities: {} })
const noul = (p: number): Answer => ({ type: "noul", noul: p })
const score = (s: number): Answer => ({ type: "score", score: s, confidence: 0.9, probabilities: {} })

test("without a decision model: the planner's role, middle difficulty, strict, budget M, oracle from the verify commands", () => {
  const p = combine(task(), acc, undefined, {})
  assert.equal(p.role, "code")
  assert.equal(p.difficulty, 0.5)
  assert.equal(p.risk, "internal")
  assert.equal(p.perm, "strict")
  assert.equal(p.budget, "M")
  assert.equal(p.testOracle, true)
  assert.equal(p.source, "rules")
  assert.deepEqual(narrowing(p), [], "nothing is narrowed without an answer")
})

test("the model's answers set difficulty, risk and the flags; a choice under its floor keeps the default", () => {
  const p = combine(task(), acc, asked({
    difficulty: score(3), risk: choice("public_api"), has_test_oracle: noul(0.9), test_first_possible: noul(0.8), is_bug_fix: noul(0.1),
    perm_profile: choice("normal", 0.4), budget_tier: choice("L"),
  }), {})
  assert.equal(p.difficulty, 0.75)
  assert.equal(p.risk, "public_api")
  assert.equal(p.testFirst, true)
  assert.equal(p.bugFix, false)
  assert.equal(p.perm, "strict", "0.4 is under the choice floor")
  assert.equal(p.budget, "L")
  assert.equal(p.source, "model")
})

test("a sure model may change the role only within the write class", () => {
  assert.equal(combine(task(), acc, asked({ role: choice("test") }), {}).role, "test")
  assert.equal(combine(task(), acc, asked({ role: choice("explore") }), {}).role, "code", "a task with files keeps a writer")
  assert.equal(combine(task(), acc, asked({ role: choice("test", 0.5) }), {}).role, "code", "under the floor")
})

test("a task that needs shell never stays with a role that has none (live test: tests run by the oracle)", () => {
  const t4 = task({ id: "T4", title: "Run the test suite and confirm green", role: "oracle", files: [] })
  const ruled = combine(t4, acc, undefined, {})
  assert.equal(ruled.role, "review", "without a model: a reader that may run test runners")
  const modelled = combine(t4, acc, asked({ "tool.shell": noul(0.95) }), {})
  assert.equal(modelled.role, "review")
  assert.match(modelled.roleReason, /oracle has no shell/)
  assert.ok(modelled.confidence < 1, "the contradiction lowers the confidence")
  const writer = combine(task({ role: "write", files: ["README.md"] }), acc, asked({ "tool.shell": noul(0.9) }), {})
  assert.equal(writer.role, "code")
})

test("user presets beat the model", () => {
  const p = combine(task(), acc, asked({ risk: choice("cosmetic"), role: choice("test") }), { job: { "N5.risk": "fixed:destructive", "N5.role": "fixed:debug", "N5.difficulty": "fixed:0.2" } })
  assert.equal(p.risk, "destructive")
  assert.equal(p.role, "debug")
  assert.equal(p.difficulty, 0.2)
})

test("narrowing denies whole tool groups by how strict the profile is, never what the role is for", () => {
  const base = { "tool.shell": noul(0.3), "tool.web": noul(0.1) }
  const strict = narrowing(combine(task(), acc, asked(base), {}))
  assert.deepEqual(strict.map((r) => r.action), ["shell", "webfetch", "websearch"])
  const normal = narrowing(combine(task(), acc, asked({ ...base, perm_profile: choice("normal") }), {}))
  assert.deepEqual(normal.map((r) => r.action), ["webfetch", "websearch"], "normal only drops what is clearly not needed")
  assert.deepEqual(narrowing(combine(task(), acc, asked({ ...base, perm_profile: choice("trusted") }), {})), [])
  const tester = narrowing(combine(task({ role: "test", files: ["a.test.js"] }), acc, asked(base), {}))
  assert.ok(!tester.some((r) => r.action === "shell"), "a test worker keeps its shell")
  assert.ok(strict.every((r) => r.effect === "deny" && r.resource === "*"))
})

test("skills: one noul per skill the role may load, at most three above the floor", () => {
  const skills: Skill[] = ["a", "b", "c", "d", "e"].map((n) => ({ name: n, description: n, roles: n === "e" ? ["write"] : ["code"] }))
  const qs = classifyQuestions(task(), skills)
  assert.ok(qs["skill.a"] && !qs["skill.e"], "only the role's skills are asked")
  assert.ok(qs.role && qs.difficulty && qs["tool.shell"])
  const p = combine(task(), acc, asked({ "skill.a": noul(0.6), "skill.b": noul(0.9), "skill.c": noul(0.7), "skill.d": noul(0.8) }), {}, skills)
  assert.deepEqual(p.skills, ["b", "d", "c"])
  assert.match(profileText(p), /skills b, d, c/)
})

test("the pipeline follows the rules of design.md §9", () => {
  const pick = (answers: Record<string, Answer>, over: Partial<Task> = {}, pins = {}) => {
    const t = task(over)
    return choosePipeline(t, combine(t, acc, asked(answers), pins), pins)
  }
  assert.equal(pick({ has_test_oracle: noul(0.9), risk: choice("internal") }).id, "P1")
  assert.equal(pick({ has_test_oracle: noul(0.1) }).id, "P2")
  assert.equal(pick({ has_test_oracle: noul(0.9), risk: choice("public_api") }).id, "P2")
  assert.equal(pick({ test_first_possible: noul(0.9), is_bug_fix: noul(0.9) }).id, "P3")
  assert.equal(pick({ test_first_possible: noul(0.9), risk: choice("cosmetic") }).id, "P1", "test first alone is not enough")
  assert.equal(pick({ has_test_oracle: noul(0.9), role: choice("debug", 0.55) }).id, "P1", "a weak role answer is just ignored")
  assert.equal(pick({ has_test_oracle: noul(0.9), "tool.shell": noul(0.9), risk: choice("internal", 0.7) }, { role: "write", files: ["README.md"] }).id, "P2", "a contradiction lowers confidence: one tier up")
  assert.equal(pick({ has_test_oracle: noul(0.9), risk: choice("internal", 0.7) }).id, "P1")
  assert.equal(pick({}, { role: "research", files: [] }).id, "P9")
  assert.equal(pick({}, { role: "explore", files: [] }).id, "P1")
  const destructive = pick({ risk: choice("destructive") })
  assert.deepEqual(destructive.modifiers, ["user_confirm", "oracle"])
  assert.equal(pick({ has_test_oracle: noul(0.9) }, {}, { job: { "N6.pipeline": "fixed:P2" } }).id, "P2")
  assert.equal(pick({ has_test_oracle: noul(0.9) }, {}, { job: { "N6.pipeline": "fixed:P9" } }).id, "P1", "a pin cannot turn a writer into research")
})

test("reviews: unmet points need evidence to block; non-JSON is an error", () => {
  const r = parseReview('```json\n{"verdict":"FAIL","checks":[{"point":"A1","met":false,"evidence":"mean([]) returns NaN"},{"point":"A2","met":false,"evidence":""}],"fixes":["throw on empty"]}\n```')
  assert.equal(r.verdict, "FAIL")
  assert.deepEqual(r.blocking.map((c) => c.point), ["A1"])
  assert.deepEqual(r.fixes, ["throw on empty"])
  assert.ok(parseReview("looks good to me").error)
})

test("citation check: every URL from a reader, at least one", () => {
  const notes = ["- x is y (https://a.dev/doc). more at https://b.dev/x"]
  assert.equal(citationCheck("See [a](https://a.dev/doc).", notes).ok, true)
  assert.deepEqual(citationCheck("See https://a.dev/doc and https://evil.dev/z.", notes).unknown, ["https://evil.dev/z"])
  assert.equal(citationCheck("no links", notes).ok, false)
})

test("small helpers: reader count, research path, test file names", () => {
  assert.deepEqual([0, 0.5, 0.9].map(readerCount), [1, 3, 5])
  assert.equal(researchPath(task({ title: "Which YAML parser?" })), "docs/research/which-yaml-parser.md")
  for (const f of ["stats.test.js", "test/a.js", "tests/test_x.py", "src/a.spec.ts", "test_b.py"]) assert.ok(TEST_FILE.test(f), f)
  for (const f of ["stats.js", "latest.js", "contest/a.js"]) assert.ok(!TEST_FILE.test(f), f)
})
