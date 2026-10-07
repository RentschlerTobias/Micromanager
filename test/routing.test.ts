import assert from "node:assert/strict"
import { test } from "node:test"

import { parseRouting, stripComments } from "../src/config.ts"
import { backstop, DELEGATION_TOOLS, delegationRole, HEADER, notRouted, routeDelegation, routeSubagentCall, unownedDelegation, type ChildSession } from "../src/hooks.ts"
import { family, MODELS, ROLES, roleById } from "../src/roles.ts"
import { DEFAULT_ROUTING, chooseModel, guessNeeds } from "../src/routing.ts"

// The three paid cloud models: everything a role keeps behind space-bunny.
const PAID = new Set<string>([MODELS.glm, MODELS.qwen, MODELS.deepseek])

test("a role's first model, images to the vision model, a review in another family", () => {
  const code = roleById("code")!
  assert.equal(chooseModel(code, { vision: false }).model, MODELS.space, "space-bunny leads every chain")
  assert.equal(chooseModel(code, guessNeeds("fix the layout shown in the screenshot")).model, MODELS.qwen)
  const review = roleById("review")!
  // The rule is "not the worker's own family", not "not space-bunny": reviewing qwen or glm work with space-bunny
  // is a different family and free, so it is allowed. Only a review OF space-bunny has to leave the family.
  assert.equal(chooseModel(review, { vision: false }, DEFAULT_ROUTING, MODELS.qwen).model, MODELS.space)
  assert.equal(chooseModel(review, { vision: false }, DEFAULT_ROUTING, MODELS.glm).model, MODELS.space)
  assert.equal(chooseModel(review, { vision: false }, DEFAULT_ROUTING, MODELS.deepseek).model, MODELS.space)
  // space-bunny writes almost everything, so a review of its work has to be another family: the rule finds the
  // first entry in the chain whose family differs, which is what keeps a reviewer from checking its own output.
  assert.equal(chooseModel(review, { vision: false }, DEFAULT_ROUTING, MODELS.space).model, MODELS.glm)
  assert.equal(chooseModel(review, { vision: false }, DEFAULT_ROUTING, MODELS.space).reason,
    "another family than the worker (space)", "and it says which family it avoided")
  assert.notEqual(family(MODELS.space), family(MODELS.glm))
  assert.notEqual(family(MODELS.space), family(MODELS.qwen))
  assert.notEqual(family(MODELS.space), family(MODELS.deepseek))
})

test("every role leads with space-bunny and keeps a fallback behind it", () => {
  for (const role of ROLES) {
    assert.equal(role.models[0], MODELS.space, `${role.id} leads with space-bunny`)
    assert.ok(role.models.length > 1, `${role.id} keeps a fallback`)
    assert.equal(new Set(role.models).size, role.models.length, `${role.id}: no model twice in its chain`)
    // The fallbacks are the three paid cloud models, which is what a review of space-bunny's work falls back to.
    for (const m of role.models.slice(1)) assert.ok(PAID.has(m), `${role.id}: ${m}`)
  }
})

test("the micromanager's subagent call gets the routed model, runs in the background, carries a header", () => {
  const call = {
    tool: "subagent",
    agent: "micromanager",
    input: { agent: "coder", model: "opencode-go/kimi-k3", prompt: "Add a --verbose flag.", background: false },
  }
  const routed = routeSubagentCall(call, DEFAULT_ROUTING)
  assert.deepEqual(routed, { role: "code", model: MODELS.space, reason: "first model for code" })
  assert.equal(call.input.model, MODELS.space) // the model the micromanager asked for is overridden
  assert.equal(call.input.background, true)
  assert.ok(String(call.input.prompt).startsWith(`${HEADER} role: code · model: ${MODELS.space}\n\nAdd a --verbose flag.`))
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

test("a delegation is recognised by what it delegates to, not by who asked", () => {
  // The live run of 2026-10-06 lost every worktree on one check: the caller had to be the micromanager agent, the
  // user switched the parent session off it to `build`, and ten delegations to coder/tester/explorer/oracle were
  // skipped in silence. The agent is a property of the session the user sits in, so the target is the discriminator.
  assert.deepEqual(DELEGATION_TOOLS, ["subagent"])
  for (const tool of DELEGATION_TOOLS) {
    assert.equal(delegationRole({ tool, agent: "build", input: { agent: "coder", prompt: "x" } })?.id, "code")
    assert.equal(delegationRole({ tool, agent: "micromanager", input: { agent: "tester", prompt: "x" } })?.id, "test")
  }
  // Conservative by construction: only a tool of ours, aimed at an agent of ours. A built-in agent and every other
  // tool are not delegations here, so nothing is ever routed on their behalf.
  assert.equal(delegationRole({ tool: "subagent", agent: "build", input: { agent: "explore", prompt: "x" } }), undefined)
  assert.equal(delegationRole({ tool: "subagent", agent: "build", input: { agent: "general", prompt: "x" } }), undefined)
  assert.equal(delegationRole({ tool: "subagent", agent: "build", input: { prompt: "x" } }), undefined)
  assert.equal(delegationRole({ tool: "read", agent: "micromanager", input: { agent: "coder", prompt: "x" } }), undefined)
  assert.equal(delegationRole({ tool: "execute", agent: "micromanager", input: { code: "tools.coder()" } }), undefined)
  // A call that merely mentions a subagent is not one: nothing is hijacked.
  const mentions = { tool: "bash", agent: "build", input: { command: "grep -rn subagent src/" } }
  assert.equal(delegationRole(mentions), undefined)
  assert.equal(unownedDelegation(mentions), false)
})

test("a delegation from another agent produces the same task and worktree as the micromanager's", () => {
  const ask: Record<string, unknown> = { agent: "coder", description: "Add a --verbose flag", prompt: "Add a --verbose flag." }
  const direct = { tool: "subagent", agent: "micromanager", input: { ...ask } }
  const alternate = { tool: "subagent", agent: "build", input: { ...ask } }
  // Both route to the same role and the same model, and both rewrite the call the same way — so one delegation still
  // makes one task and one worktree, whichever agent made it.
  assert.deepEqual(routeDelegation(direct, DEFAULT_ROUTING), routeDelegation(alternate, DEFAULT_ROUTING))
  assert.equal(direct.input.model, MODELS.space)
  assert.equal(alternate.input.model, MODELS.space)
  assert.equal(direct.input.background, true)
  assert.equal(alternate.input.background, true)
  assert.equal(String(alternate.input.prompt), String(direct.input.prompt))
  // The narrow entry point still refuses it: what the plugin does with it is the plugin's decision, not the hook's.
  assert.equal(routeSubagentCall(alternate, DEFAULT_ROUTING), undefined)
  // Nothing but the delegation tool is ever routed.
  assert.equal(routeDelegation({ tool: "read", agent: "build", input: { agent: "coder", prompt: "x" } }, DEFAULT_ROUTING), undefined)
  // And a delegation the plugin cannot isolate is named as such, so the plugin can say it did not route it.
  assert.equal(unownedDelegation(direct), false)
  assert.equal(unownedDelegation(alternate), false)
  assert.equal(unownedDelegation({ tool: "subagent", agent: "build", input: { agent: "explore", prompt: "x" } }), true)
  assert.equal(unownedDelegation({ tool: "subagent", agent: "build", input: { prompt: "x" } }), true)
})

test("an unclaimed child of a micromanager session cannot write; every other session can", () => {
  const checkout = "/home/t1dde/Fun/Projects/Repos/jev-micromanager"
  // The live run: a child of the micromanager session with no task, no worktree, no claim and no move, writing into
  // the user's checkout while nothing complained.
  const unclaimed: ChildSession = { sessionID: "ses_child", parent: "ses_micro", parentIsMicromanager: true, job: "job-1", directory: checkout }
  for (const action of ["shell", "edit", "write", "patch", "execute"]) {
    const denial = backstop(unclaimed, action, false)
    assert.ok(denial, `${action} must be refused`)
    assert.match(denial.reason, /isolation did not engage/)
    assert.match(denial.message, /never put you in a worktree/)
    assert.match(denial.message, /STATUS: NEEDS_CONTEXT/)
    assert.match(denial.message, new RegExp(checkout.replace(/[/.]/g, "\\$&"))) // it names where it would have written
    assert.match(denial.message, /ses_micro/)
    assert.match(denial.message, /job-1/)
  }
  // A read cannot damage the checkout, so it is left alone: refusing it would only make the run harder to diagnose.
  assert.equal(backstop(unclaimed, "read", false), undefined)
  assert.equal(backstop(unclaimed, "glob", false), undefined)
  assert.equal(backstop(unclaimed, "external_directory", false), undefined)
  // A worker the plugin claimed and moved is the case this exists for not to touch.
  assert.equal(backstop(unclaimed, "shell", true), undefined)
  // A session the user opened has no parent at all: the micromanager's own session, and the user's.
  assert.equal(backstop({ sessionID: "ses_user", parentIsMicromanager: false }, "shell", false), undefined)
  // A role agent picked by hand, working in the user's own checkout: it is not a delegated child of a micromanager
  // session, so the rule never reaches it and the user keeps working normally.
  assert.equal(backstop({ sessionID: "ses_byhand", parent: "ses_user_build", parentIsMicromanager: false, directory: checkout }, "shell", false), undefined)
  // A parent the plugin does not own is not a micromanager parent, whatever the child's agent is called.
  assert.equal(backstop({ sessionID: "ses_child", parent: "ses_other", parentIsMicromanager: false }, "edit", false), undefined)
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
