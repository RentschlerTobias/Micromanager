import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { Graphs, queryGraph, updateGraph } from "../src/graph.ts"
import type { Exec } from "../src/integration.ts"

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", timedOut: false })

test("explorers of one commit share one build; a new commit builds again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jd-graph-"))
  let head = "aaa1111"
  const builds: string[] = []
  const run: Exec = async (command, args) => {
    if (command === "git") return ok(`${head}\n`)
    builds.push(args.join(" "))
    await new Promise((r) => setTimeout(r, 10))
    execFileSync("mkdir", ["-p", join(dir, "graphify-out")])
    writeFileSync(join(dir, "graphify-out", "graph.json"), "{}")
    return ok()
  }
  const graphs = new Graphs(run)
  const [a, b] = await Promise.all([graphs.get(dir), graphs.get(dir)])
  assert.deepEqual(a, { commit: "aaa1111" })
  assert.equal(a, b)
  assert.deepEqual(builds, ["update . --force"])
  assert.equal(readFileSync(join(dir, "graphify-out", ".gitignore"), "utf8"), "*\n")
  head = "bbb2222"
  assert.deepEqual(await graphs.get(dir), { commit: "bbb2222" })
  assert.equal(builds.length, 2)
})

test("a missing or failing graphify gives no graph", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jd-graph-"))
  const run: Exec = async (command) => (command === "git" ? ok("abc\n") : { code: 1, stdout: "", stderr: "spawn graphify ENOENT", timedOut: false })
  assert.equal(await updateGraph(dir, run), undefined)
  assert.ok(!existsSync(join(dir, "graphify-out")))
})

test("a graph question becomes one graphify call; bad input gets a hint, a long answer is cut", async () => {
  const calls: string[] = []
  const run: Exec = async (_command, args) => (calls.push(args.join(" ")), ok(args[0] === "explain" ? "x".repeat(20_000) : "answer"))
  assert.equal(await queryGraph("/d", "path", "a", "b", run), "answer")
  assert.equal(await queryGraph("/d", "query", "lesson flow", "", run), "answer")
  assert.match(await queryGraph("/d", "explain", "Trainer", "", run), /\[cut at 12000 characters; ask about a narrower symbol\]$/)
  assert.deepEqual(calls, ["path a b", "query lesson flow --budget 3000", "explain Trainer"])
  assert.match(await queryGraph("/d", "path", "a", "", run), /needs both/)
  assert.match(await queryGraph("/d", "explain", " ", "", run), /Name a symbol/)
  assert.equal(calls.length, 3)
})

const hasGraphify = (() => {
  try {
    execFileSync("graphify", ["--help"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

test("graphify builds a graph of a real repository and git does not see it", { skip: !hasGraphify && "graphify is not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "jd-graph-"))
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]).toString()
  git("init", "-q")
  writeFileSync(join(dir, "a.py"), "def helper():\n    return 1\n\n\ndef main():\n    return helper()\n")
  git("add", "-A")
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
  const graph = await updateGraph(dir)
  assert.ok(graph, "a graph")
  assert.ok(existsSync(join(dir, "graphify-out", "GRAPH_REPORT.md")))
  assert.equal(git("status", "--porcelain"), "")
  assert.match(await queryGraph(dir, "explain", "main"), /helper/)
  assert.match(await queryGraph(dir, "affected", "helper"), /main/)
})
