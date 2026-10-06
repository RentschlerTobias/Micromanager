import assert from "node:assert/strict"
import { test } from "node:test"

import { parseRouting, stripComments } from "../src/config.ts"
import { HEADER, notRouted, routeSubagentCall } from "../src/hooks.ts"
import { MODELS, roleById } from "../src/roles.ts"
import { DEFAULT_ROUTING, chooseModel, guessNeeds } from "../src/routing.ts"

test("a role's first model, images to the vision model, a review in another family", () => {
  const code = roleById("code")!
  assert.equal(chooseModel(code, { vision: false }).model, MODELS.glm)
  assert.equal(chooseModel(code, guessNeeds("fix the layout shown in the screenshot")).model, MODELS.qwen)
  const review = roleById("review")!
  assert.equal(chooseModel(review, { vision: false }, DEFAULT_ROUTING, MODELS.qwen).model, MODELS.glm)
  assert.equal(chooseModel(review, { vision: false }, DEFAULT_ROUTING, MODELS.glm).model, MODELS.qwen)
  assert.equal(chooseModel(review, { vision: false }, DEFAULT_ROUTING, MODELS.deepseek).model, MODELS.qwen)
})

test("the micromanager's subagent call gets the routed model, runs in the background, carries a header", () => {
  const call = {
    tool: "subagent",
    agent: "micromanager",
    input: { agent: "coder", model: "opencode-go/kimi-k3", prompt: "Add a --verbose flag.", background: false },
  }
  const routed = routeSubagentCall(call, DEFAULT_ROUTING)
  assert.deepEqual(routed, { role: "code", model: MODELS.glm, reason: "first model for code" })
  assert.equal(call.input.model, MODELS.glm) // the model the micromanager asked for is overridden
  assert.equal(call.input.background, true)
  assert.ok(String(call.input.prompt).startsWith(`${HEADER} role: code · model: ${MODELS.glm}\n\nAdd a --verbose flag.`))
  routeSubagentCall(call, DEFAULT_ROUTING)
  assert.equal(String(call.input.prompt).split(HEADER).length, 2) // the header only once
})

test("other agents' calls and built-in sub-agents are left alone", () => {
  const fromBuild = { tool: "subagent", agent: "build", input: { agent: "coder", prompt: "x" } }
  assert.equal(routeSubagentCall(fromBuild, DEFAULT_ROUTING), undefined)
  const builtIn = { tool: "subagent", agent: "micromanager", input: { agent: "explore", prompt: "x", model: "a/b" } }
  assert.equal(routeSubagentCall(builtIn, DEFAULT_ROUTING), undefined)
  assert.equal(builtIn.input.model, "a/b")
  const read = { tool: "read", agent: "micromanager", input: { path: "." } }
  assert.equal(routeSubagentCall(read, DEFAULT_ROUTING), undefined)
})

test("a call that was not routed says which name was the problem", () => {
  // The live run asked for OpenCode's own `explore` and was told to use a role agent, so it looked for an `explore`
  // role agent that does not exist. The message names the name it could not find instead.
  const builtIn = { tool: "subagent", agent: "micromanager", input: { agent: "explore", prompt: "x" } }
  assert.equal(routeSubagentCall(builtIn, DEFAULT_ROUTING), undefined)
  assert.match(notRouted(builtIn) ?? "", /^"explore" is not a role agent, so nothing was started\./)
  assert.match(notRouted(builtIn) ?? "", /explorer, researcher/, "the list of role agents is still there")
  const typo = { tool: "subagent", agent: "micromanager", input: { agent: "codr", prompt: "x" } }
  assert.match(notRouted(typo) ?? "", /"codr" is not a role agent/)
  const none = { tool: "subagent", agent: "micromanager", input: { prompt: "x" } }
  assert.match(notRouted(none) ?? "", /^No agent was named/)
  // A role agent is never the problem with its own name, and neither is a call of another agent.
  assert.equal(notRouted({ tool: "subagent", agent: "micromanager", input: { agent: "coder", prompt: "x" } }), undefined)
  assert.equal(notRouted({ tool: "subagent", agent: "build", input: { agent: "explore", prompt: "x" } }), undefined)
  assert.equal(notRouted({ tool: "read", agent: "micromanager", input: { path: "." } }), undefined)
})

test("the config overrides chains and rejects unknown roles or bad models", () => {
  const text = `{
    // cheaper coding for a while
    "models": { "code": ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"] },
    "vision": "opencode-go/qwen3.8-flash" // the only one with image input
  }`
  const routing = parseRouting(text)
  assert.equal(chooseModel(roleById("code")!, { vision: false }, routing).model, MODELS.deepseek)
  assert.throws(() => parseRouting('{"models": {"coder": ["a/b"]}}'), /unknown role/)
  assert.throws(() => parseRouting('{"models": {"code": ["glm"]}}'), /provider\/model/)
  assert.equal(stripComments('{"url": "http://x//y"} // c'), '{"url": "http://x//y"} \n')
})
