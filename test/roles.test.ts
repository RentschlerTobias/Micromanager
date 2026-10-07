import assert from "node:assert/strict"
import { test } from "node:test"

import { MICROMANAGER, MODELS, ROLES, micromanagerSystem, family, roleByAgent, roleById } from "../src/roles.ts"

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

test("the gitmaster is a role like any other, and it works in the user's checkout", () => {
  const role = roleByAgent("gitmaster")!
  assert.equal(role.id, "gitmaster")
  assert.equal(roleById("gitmaster"), role)
  assert.match(role.description, /merges? one named job branch into/i)
  assert.equal(role.models[0], MODELS.space, "space-bunny first, a paid model behind it")
  assert.ok(role.models.length > 1)
  // Its own words, because the difference from every other role is exactly this: the checkout, never a worktree, and
  // a stop instead of a fix when the merge is not clean.
  for (const phrase of [/user's own checkout/i, /never push/i, /never reset/i, /rebase/i, /dirty/i, /report what you found and stop/i]) {
    assert.match(role.system, phrase, String(phrase))
  }
  assert.ok(micromanagerSystem().includes("gitmaster"), "the micromanager can pick it")
})

test("the gitmaster may read the repository and merge one branch, and nothing else", () => {
  const rules = roleById("gitmaster")!.rules
  for (const cmd of ["git status*", "git log*", "git show*", "git diff*", "git branch*", "git ls-files*", "git rev-parse*", "git merge*", "git add *", "git commit*", "git worktree list", "git stash list"]) {
    assert.equal(effect(rules, "shell", cmd), "allow", cmd)
  }
  for (const cmd of ["git status --porcelain", "git log --oneline", "git diff HEAD~1", "git merge jev/job-1", "git add src/a.ts", "git commit -m merge", "git worktree list", "git stash list"]) {
    assert.equal(effectFor(rules, cmd), "allow", cmd)
  }
  // The commands it may not run: the destructive and the irreversible ones, which are the only way a merge could lose
  // the user's commits or move the checkout somewhere nobody asked for.
  for (const cmd of ["git push", "git push origin main", "git reset --hard HEAD~1", "git checkout other", "git switch -c x", "git rebase main", "git clean -fd", "git cherry-pick abc", "git revert abc", "git remote add x y", "git reflog expire --all", "git gc --prune=now", "git filter-branch --all"]) {
    assert.equal(effectFor(rules, cmd), "deny", cmd)
  }
  // A chain is checked segment by segment, so a merge followed by a push is refused on the push.
  assert.deepEqual(everySegment(rules, "git fetch origin && git merge jev/job-1"), ["git fetch origin -> ask", "git merge jev/job-1 -> allow"])
  assert.deepEqual(everySegment(rules, "git merge jev/job-1 && git push"), ["git merge jev/job-1 -> allow", "git push -> deny"])
  // Not a test runner and not a linter: the plugin already ran the checks on the branch before the merge.
  for (const cmd of ["npm test", "uv run pyright .", "npx tsc", "grep -rn foo src", "sed -i s/a/b/ f.ts"]) {
    assert.notEqual(effectFor(rules, cmd), "allow", cmd)
  }
})

test("the gitmaster's denies come after the allows, or a later edit would let them run", () => {
  // The whole mechanism, asserted the way the sed -i test asserts it: last matching rule wins, so a deny placed before
  // the allow it overlaps is overridden by it. `git merge*` does not overlap a deny, so the ordering is checked on the
  // role's own shell lists: every deny must sit after every allow, and the ask that opens them.
  const rules = roleById("gitmaster")!.rules
  const shell = rules.map((r, i) => ({ ...r, i })).filter((r) => r.action === "shell")
  const lastAllow = Math.max(...shell.filter((r) => r.effect === "allow").map((r) => r.i))
  const firstDeny = Math.min(...shell.filter((r) => r.effect === "deny").map((r) => r.i))
  assert.ok(firstDeny > lastAllow, `the first deny (${firstDeny}) comes after the last allow (${lastAllow})`)
  assert.ok(shell.some((r) => r.effect === "ask" && r.resource === "*"), "everything else still asks")
  // And the effect of a command is what the last matching rule says, not what the first one says.
  for (const cmd of ["git push*", "git reset*", "git checkout*", "git rebase*", "git clean*", "git remote*"]) {
    assert.equal(effect(rules, "shell", cmd), "deny", cmd)
  }
})

test("the gitmaster edits a file only where a conflict asks it to, and has no web and no sub-agents", () => {
  const rules = roleById("gitmaster")!.rules
  // ask, not deny (a conflict cannot be resolved without an edit) and not allow (it would rewrite anything it likes).
  for (const tool of ["edit", "write", "patch"]) assert.equal(effect(rules, tool), "ask", tool)
  for (const tool of ["webfetch", "websearch"]) assert.equal(effect(rules, tool), "deny", tool)
  assert.equal(effect(rules, "subagent"), "deny")
  // It works in the checkout and nowhere else.
  assert.ok(rules.some((r) => r.action === "external_directory" && r.effect === "deny" && r.resource === "*"))
  assert.ok(!rules.some((r) => r.action === "external_directory" && r.effect === "allow"))
})

test("the gitmaster is the only change to the matrix: eleven roles, and the other ten kept their rights", () => {
  assert.equal(ROLES.length, 11)
  assert.deepEqual(ROLES.map((r) => r.id), ["explore", "research", "plan", "code", "test", "visual", "write", "debug", "review", "oracle", "gitmaster"])
  // How many rules each role has, its own plus the shared tail it always got (21 state paths + 4 memory tools). A role
  // that gained or lost one for this task would move a number here.
  const counts: Record<string, number> = { explore: 51, research: 30, plan: 32, code: 66, test: 66, visual: 66, write: 29, debug: 69, review: 69, oracle: 32, gitmaster: 57 }
  for (const [id, n] of Object.entries(counts)) assert.equal(roleById(id)!.rules.length, n, id)
  // No other role was given a merge command: the ten kept the shell rights the tests above pin, and this is the check
  // that none of them silently gained a way into the checkout.
  for (const role of ROLES.filter((r) => r.id !== "gitmaster")) {
    const own = role.rules.filter((r) => r.action === "shell" && /^(git merge|git push|git add|git commit|git stash|git worktree)/.test(r.resource))
    assert.deepEqual(own, [], role.id)
    assert.ok(!role.rules.some((r) => r.action === "external_directory" && r.effect === "allow"), `${role.id}: no path outside the project`)
  }
})
