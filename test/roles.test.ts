import assert from "node:assert/strict"
import { test } from "node:test"

import { MICROMANAGER, MODELS, ROLES, micromanagerSystem, family, roleByAgent } from "../src/roles.ts"

const ALLOWED = new Set<string>(Object.values(MODELS))
const effect = (rules: readonly { action: string; resource: string; effect: string }[], action: string, resource = "*") =>
  [...rules].reverse().find((r) => r.action === action && r.resource === resource)?.effect // last match wins

// The role's rules as OpenCode applies them: every rule whose resource is a pattern the command matches, last match
// wins. "*" stands for any run of characters, as in OpenCode's own permission patterns.
const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`)
const effectFor = (rules: readonly { action: string; resource: string; effect: string }[], command: string) =>
  [...rules].reverse().find((r) => r.action === "shell" && glob(r.resource).test(command))?.effect

// What OpenCode sends as resources for one shell call: every segment of every chain, one resource each (see the
// READ_COMMANDS comment in src/roles.ts; decide.ts's segments() splits the same way).
const chain = (command: string) => command.split(/(?:&&|\|\||;|\|)/).map((part) => part.trim()).filter(Boolean)
const everySegment = (rules: readonly { action: string; resource: string; effect: string }[], command: string) =>
  chain(command).map((segment) => `${segment} -> ${effectFor(rules, segment) ?? "ask"}`)

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

test("an explorer may read git history and the file tree, nothing else on the shell", () => {
  const explore = ROLES.find((r) => r.id === "explore")!
  for (const cmd of ["git log*", "git show*", "ls *", "tree *"]) assert.equal(effect(explore.rules, "shell", cmd), "allow", cmd)
  assert.equal(effect(explore.rules, "shell"), "deny")
  assert.equal(effect(explore.rules, "shell", "git commit*"), undefined, "no rule for it: the deny on * applies")
  assert.equal(effect(explore.rules, "shell", "ast-grep run *"), "allow")
  assert.equal(effect(explore.rules, "shell", "graphify update *"), undefined, "the graph is the plugin's: explorers ask it through code_graph")
  const last = (cmd: string) => explore.rules.findLastIndex((r) => r.action === "shell" && r.resource === cmd)
  for (const cmd of ["ast-grep * -U*", "ast-grep * --rewrite*"]) {
    assert.equal(effect(explore.rules, "shell", cmd), "deny", cmd)
    assert.ok(last(cmd) > last("ast-grep run *"), `${cmd} comes after the allow, so it wins`)
  }
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

test("a coder may run the project's own tests and linters (live test: it could run no type-checker at all)", () => {
  const code = ROLES.find((r) => r.id === "code")!.rules
  for (const cmd of ["npm test*", "uv run pytest*", "uv run pyright*", "npx tsc*", "cargo test*"]) {
    assert.equal(effect(code, "shell", cmd), "allow", cmd)
  }
  // The same set for every other role that may run commands, so no writer is left unable to check its own work.
  for (const id of ["test", "visual", "debug", "review"]) {
    const rules = ROLES.find((r) => r.id === id)!.rules
    for (const cmd of ["npm test*", "uv run pyright*", "npx tsc*"]) assert.equal(effect(rules, "shell", cmd), "allow", `${id} ${cmd}`)
  }
})

test("a coder may run the readers after a pipe: OpenCode asks about each segment on its own", () => {
  // The live command that lost a task, with the pipe inside the sed expression left out so each segment is a command:
  // every segment after `uv run pyright` was on no allow list.
  const live = "uv run pyright 2>&1 | grep -E '^  /' | sed -E 's#.*--T1/##' | cut -d: -f1 | sort | uniq -c | sort -rn"
  for (const rules of [ROLES.find((r) => r.id === "code")!.rules, ROLES.find((r) => r.id === "test")!.rules]) {
    assert.deepEqual(everySegment(rules, live), [
      "uv run pyright 2>&1 -> allow",
      "grep -E '^  /' -> allow",
      "sed -E 's#.*--T1/##' -> allow",
      "cut -d: -f1 -> allow",
      "sort -> allow",
      "uniq -c -> allow",
      "sort -rn -> allow",
    ])
  }
  const code = ROLES.find((r) => r.id === "code")!.rules
  for (const cmd of ["grep -rn foo src", "sed -n 1,20p a.ts", "cut -d: -f1 f", "sort f", "uniq -c", "wc -l f", "head -5 f", "tail -5 f"]) {
    assert.equal(effectFor(code, cmd), "allow", cmd)
  }
})

test("the readers that write are denied, and only because the deny comes after the allow", () => {
  for (const id of ["code", "test", "visual", "debug", "review"]) {
    const rules = ROLES.find((r) => r.id === id)!.rules
    for (const cmd of ["sed -i s/a/b/ f.ts", "sed --in-place s/a/b/ f.ts", "sort -o out.txt in.txt", "sort --output=out.txt in.txt", "tee out.txt"]) {
      assert.equal(effectFor(rules, cmd), "deny", `${id}: ${cmd}`)
    }
    // The ordering is the whole mechanism: last matching rule wins, so a deny before the allow is overridden by it.
    const last = (resource: string) => rules.findLastIndex((r) => r.action === "shell" && r.resource === resource)
    for (const deny of ["sed -i*", "sort -o*", "tee*"]) {
      assert.ok(last(deny) > last("sed*") && last(deny) > last("sort*"), `${deny} comes after the allow, so it wins`)
    }
    // A chain that ends in a writing reader: that segment is denied, and the ones before it are not.
    assert.deepEqual(everySegment(rules, "npm test | tail -20 | sed -i s/1/2/ f.txt"), [
      "npm test -> allow",
      "tail -20 -> allow",
      "sed -i s/1/2/ f.txt -> deny",
    ])
  }
})

test("a read-only role gained nothing from the pipe readers", () => {
  for (const id of ["explore", "research", "plan", "oracle"]) {
    const rules = ROLES.find((r) => r.id === id)!.rules
    assert.equal(effect(rules, "shell"), "deny", `${id} shell`)
    // No allow for a runner or a reader, so the deny on * is what every command still meets.
    for (const cmd of ["npm test*", "uv run pyright*", "grep*", "sed*"]) assert.equal(effect(rules, "shell", cmd), undefined, `${id} ${cmd}`)
    for (const cmd of ["npm test", "uv run pyright .", "grep -rn foo src", "sed -n 1,20p a.ts"]) {
      assert.notEqual(effectFor(rules, cmd), "allow", `${id}: ${cmd}`)
    }
  }
  const explore = ROLES.find((r) => r.id === "explore")!
  assert.equal(effectFor(explore.rules, "npm test"), "deny")
  assert.equal(effectFor(explore.rules, "git log --oneline"), "allow", "what it had before")
})

test("a worker is told a refused permission does not end its task", () => {
  for (const role of ROLES) {
    assert.match(role.system, /refused permission is not a blocker/)
    assert.match(role.system, /carry\s+on without it/, role.id)
  }
})

test("the micromanager never edits or runs commands, and every delegation asks the user", () => {
  for (const tool of ["edit", "write", "patch", "shell"]) assert.equal(effect(MICROMANAGER.rules, tool), "deny", tool)
  assert.equal(effect(MICROMANAGER.rules, "subagent"), "ask")
  const system = micromanagerSystem()
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
  for (const r of [...ROLES.map((x) => x.rules), MICROMANAGER.rules]) {
    for (const path of [".jev-micromanager/jobs/job-1.json", "proj/.jev-micromanager/notes/job-1/T1.md"]) {
      const match = [...r].reverse().find((x) => x.action === "read" && new RegExp("^" + x.resource.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(path))
      assert.equal(match?.effect, "deny", path)
    }
  }
})

test("the micromanager never reads outside the project (live test: it searched the plugin's source for a way past the gate)", () => {
  assert.ok(MICROMANAGER.rules.some((r) => r.action === "external_directory" && r.effect === "deny" && r.resource === "*"))
})
