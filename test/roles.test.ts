import assert from "node:assert/strict"
import { test } from "node:test"

import { DICTATOR, MODELS, ROLES, dictatorSystem, family, roleByAgent } from "../src/roles.ts"

const ALLOWED = new Set<string>(Object.values(MODELS))
const effect = (rules: readonly { action: string; resource: string; effect: string }[], action: string, resource = "*") =>
  [...rules].reverse().find((r) => r.action === action && r.resource === resource)?.effect // last match wins

test("every role routes only to the three allowed models", () => {
  for (const role of ROLES) {
    assert.ok(role.models.length > 0, role.id)
    for (const model of role.models) assert.ok(ALLOWED.has(model), `${role.id}: ${model}`)
  }
})

test("read-only roles can neither write nor run commands, and no sub-agent delegates further", () => {
  for (const id of ["explore", "research", "plan", "review", "oracle"]) {
    const role = ROLES.find((r) => r.id === id)!
    for (const tool of ["edit", "write", "patch"]) assert.equal(effect(role.rules, tool), "deny", `${id} ${tool}`)
    assert.equal(effect(role.rules, "shell"), "deny", `${id} shell`)
  }
  for (const role of ROLES) assert.equal(effect(role.rules, "subagent"), "deny", role.id)
})

test("the web is open to research only; code asks before shell commands", () => {
  const research = ROLES.find((r) => r.id === "research")!
  assert.equal(effect(research.rules, "webfetch"), undefined) // inherits the base agent's allow
  for (const role of ROLES.filter((r) => ["explore", "code", "test", "write", "review"].includes(r.id))) {
    assert.equal(effect(role.rules, "webfetch"), "deny", role.id)
  }
  assert.equal(effect(ROLES.find((r) => r.id === "code")!.rules, "shell"), "ask")
  assert.equal(effect(ROLES.find((r) => r.id === "test")!.rules, "shell", "python -m pytest*"), "allow")
})

test("the micromanager never edits or runs commands, and every delegation asks the user", () => {
  for (const tool of ["edit", "write", "patch", "shell"]) assert.equal(effect(DICTATOR.rules, tool), "deny", tool)
  assert.equal(effect(DICTATOR.rules, "subagent"), "ask")
  const system = dictatorSystem()
  for (const role of ROLES) assert.ok(system.includes(role.agent), role.agent)
})

test("agent ids never clash with built-in agents, and families are told apart", () => {
  for (const role of ROLES) {
    assert.ok(!["build", "plan", "explore", "general", "compaction", "title", "summary"].includes(role.agent), role.agent)
    assert.equal(roleByAgent(role.agent), role)
  }
  assert.equal(family(MODELS.glm), "glm")
  assert.equal(family(MODELS.qwen), "qwen3")
  assert.notEqual(family(MODELS.deepseek), family(MODELS.qwen))
})

test("no agent may read or change the plugin's state directory", () => {
  for (const r of [...ROLES.map((x) => x.rules), DICTATOR.rules]) {
    for (const path of [".jev-dictator/jobs/job-1.json", "proj/.jev-dictator/notes/job-1/T1.md"]) {
      const match = [...r].reverse().find((x) => x.action === "read" && new RegExp("^" + x.resource.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(path))
      assert.equal(match?.effect, "deny", path)
    }
  }
})

test("the micromanager never reads outside the project (live test: it searched the plugin's source for a way past the gate)", () => {
  assert.ok(DICTATOR.rules.some((r) => r.action === "external_directory" && r.effect === "deny" && r.resource === "*"))
})
