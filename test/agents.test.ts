import assert from "node:assert/strict"
import { test } from "node:test"

import { installAgents, type AgentInfo } from "../src/agents.ts"
import { ROLES } from "../src/roles.ts"

function fakeDraft(base: AgentInfo) {
  const agents = new Map<string, AgentInfo>([["build", base]])
  return {
    agents,
    get: (id: string) => agents.get(id),
    update(id: string, update: (agent: AgentInfo) => void) {
      const agent = agents.get(id) ?? ({ id } as AgentInfo) // like opencode 2.0.18: an unknown id is created
      update(agent)
      agents.set(id, agent)
    },
  }
}

test("the micromanager and every role become agents that keep the user's base rules", () => {
  const base: AgentInfo = {
    id: "build", name: "Build", mode: "primary", hidden: false, request: { body: {} },
    permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "read", resource: "*.env", effect: "ask" }],
  }
  const draft = fakeDraft(base)
  const ids = installAgents(draft)
  assert.deepEqual(ids, ["micromanager", ...ROLES.map((r) => r.agent)])
  const explorer = draft.agents.get("explorer")!
  assert.equal(explorer.mode, "subagent")
  assert.equal(explorer.hidden, true) // not offered to build or plan
  assert.deepEqual(explorer.permissions.slice(0, 2), base.permissions)
  assert.ok(explorer.permissions.some((r) => r.action === "edit" && r.effect === "deny"))
  assert.equal(draft.agents.get("micromanager")!.mode, "primary")
  assert.equal(base.permissions.length, 2) // the built-in agent itself is untouched
  assert.throws(() => installAgents({ get: () => undefined, update: () => {} }), /build/)
})
