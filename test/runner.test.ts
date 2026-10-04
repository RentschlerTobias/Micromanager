import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { lastAssistantText, parseReport } from "../src/brief.ts"
import { DEFAULT_REGISTRY } from "../src/registry.ts"
import { Runner, summary, toModel, type SessionApi } from "../src/runner.ts"
import { loadJob } from "../src/store.ts"

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "jd-run-"))
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args])
  git("init", "-q")
  writeFileSync(join(dir, "README.md"), "demo\n")
  git("add", "-A")
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
  return dir
}

const PLAN = {
  acceptance: [{ id: "A1", text: "add.js exists", verify: "test -f add.js" }, { id: "A2", text: "notes", verify: "grep -q ok notes.md" }],
  tasks: [
    { id: "T1", title: "write add.js", description: "create it", role: "code", acceptance: ["A1"], dependsOn: [], files: ["add.js"] },
    { id: "T2", title: "write notes", description: "notes", role: "write", acceptance: ["A2"], dependsOn: ["T1"], files: ["notes.md"] },
  ],
}

// A fake ctx.session: the planner answers with a plan, workers write files into their session's directory.
function fakeSession(behaviour: { plan?: string[]; worker?: (dir: string, prompt: string, n: number) => string }) {
  const sessions = new Map<string, { dir: string; agent: string; model: unknown; last: string; n: number }>()
  const created: Record<string, unknown>[] = []
  let planAnswers = [...(behaviour.plan ?? ["```json\n" + JSON.stringify(PLAN) + "\n```"])]
  const api: SessionApi = {
    async create(args) {
      created.push(args)
      const id = `ses_${sessions.size + 1}`
      sessions.set(id, { dir: (args.location as { directory: string }).directory, agent: String(args.agent), model: args.model, last: "", n: 0 })
      return { id }
    },
    async prompt({ sessionID, text }) {
      const s = sessions.get(sessionID)!
      s.n++
      if (s.agent === "dictator-plan") s.last = planAnswers.shift() ?? "no plan"
      else s.last = behaviour.worker ? behaviour.worker(s.dir, text, s.n) : "done\nSTATUS: DONE\nFILES: none"
      return {}
    },
    async wait() { return {} },
    async context({ sessionID }) {
      return [{ type: "user", text: "x" }, { type: "assistant", content: [{ type: "text", text: sessions.get(sessionID)!.last }], tokens: { input: 10, output: 5 }, cost: 0.01 }, { type: "idle" }]
    },
    async interrupt() { return {} },
  }
  return { api, created, sessions, setPlan: (p: string[]) => { planAnswers = p } }
}

const writeFiles = (dir: string, prompt: string) => {
  if (prompt.includes("task T1")) writeFileSync(join(dir, "add.js"), "export const add = (a, b) => a + b\n")
  if (prompt.includes("task T2")) writeFileSync(join(dir, "notes.md"), "ok\n")
  return "Done.\nSTATUS: DONE\nFILES: add.js\nEVIDENCE: wrote it\nOPEN: nothing"
}

const runner = (project: string, api: SessionApi, extra = {}) =>
  new Runner({ session: api, project, registry: DEFAULT_REGISTRY, journal: () => {}, availability: async () => new Map(), ...extra })

test("plan -> run: tasks pass their checks one by one and land as commits on the job's branch", async () => {
  const project = repo()
  const fake = fakeSession({ worker: writeFiles })
  const r = runner(project, fake.api)
  const { job, errors } = await r.plan("add an add function")
  assert.equal(errors, undefined)
  assert.equal(job.phase, "plan_gate")
  const done = await r.run(job.id)
  assert.equal(done.phase, "integrate", summary(done))
  assert.deepEqual(done.tasks.map((t) => t.status), ["merged", "merged"])
  const log = execFileSync("git", ["-C", project, "log", "--format=%s", done.integrationBranch!]).toString()
  assert.match(log, /T2: write notes\nT1: write add.js\ninit/)
  assert.equal(existsSync(join(project, "add.js")), false, "the user's checkout is untouched")
  assert.equal(loadJob(project, job.id)?.phase, "integrate")
  assert.match(readFileSync(join(project, ".git", "info", "exclude"), "utf8"), /\.jev-dictator\//)
  assert.match(readFileSync(join(project, ".jev-dictator", "notes", job.id, "T1.md"), "utf8"), /test -f add.js \(exit 0\)/)
  // workers run inside the job's worktree, on the routed model, with their role's agent
  const worker = fake.created.find((c) => c.agent === "dictator-code")!
  assert.equal((worker.location as { directory: string }).directory, done.integrationWorktree)
})

test("a failing check gets fix rounds, then the task escalates to the user", async () => {
  const project = repo()
  let rounds = 0
  const fake = fakeSession({ worker: (_dir, prompt) => { if (prompt.includes("checks of your task failed")) rounds++; return "STATUS: DONE\nFILES: none" } })
  const r = runner(project, fake.api, { fixRounds: 2 })
  const { job } = await r.plan("goal")
  const done = await r.run(job.id)
  assert.equal(rounds, 2)
  assert.equal(done.phase, "ask_user")
  assert.equal(done.tasks[0]!.status, "escalated")
  assert.match(summary(done), /why: T1: checks still fail after 2 fix round\(s\): test -f add.js/)
})

test("a blocked worker stops the job and says what it needs", async () => {
  const project = repo()
  const fake = fakeSession({ worker: () => "STATUS: BLOCKED\nFILES: none\nOPEN: which file format?" })
  const r = runner(project, fake.api)
  const done = await r.run((await r.plan("goal")).job.id)
  assert.equal(done.tasks[0]!.status, "blocked")
  assert.match(done.lessons.at(-1)!, /which file format/)
})

test("a bad plan is sent back, and a plan that stays bad fails the job", async () => {
  const project = repo()
  const fake = fakeSession({ plan: ["no json", "```json\n" + JSON.stringify(PLAN) + "\n```"] })
  const ok = await runner(project, fake.api).plan("goal")
  assert.equal(ok.job.phase, "plan_gate")
  fake.setPlan(["nope", "still nope", "nope again"])
  const bad = await runner(project, fake.api).plan("goal")
  assert.equal(bad.job.phase, "failed")
  assert.deepEqual(bad.errors, ["no JSON object found"])
})

test("a model preset beats the router", async () => {
  const project = repo()
  const fake = fakeSession({ worker: writeFiles })
  const r = runner(project, fake.api, { policies: { global: { "N5.model": "fixed:opencode-go/qwen3.8-flash" } } })
  await r.run((await r.plan("goal")).job.id)
  assert.ok(fake.created.every((c) => JSON.stringify(c.model) === JSON.stringify({ providerID: "opencode-go", id: "qwen3.8-flash" })))
})

test("reports and assistant text are read from the session context", () => {
  const r = parseReport("work...\n**STATUS:** DONE_WITH_CONCERNS\nFILES: `a.ts`, b.ts\nEVIDENCE: npm test ok\nOPEN: nothing")
  assert.equal(r.status, "DONE_WITH_CONCERNS")
  assert.deepEqual(r.files, ["a.ts", "b.ts"])
  assert.equal(lastAssistantText([{ type: "assistant", content: [{ type: "text", text: "first" }] }, { type: "assistant", content: [{ type: "tool" }] }]), "first")
  assert.deepEqual(toModel("opencode-go/glm-5.3-flash"), { providerID: "opencode-go", id: "glm-5.3-flash" })
})
