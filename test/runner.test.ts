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
      if (s.agent === "dictator-plan") s.last = planAnswers.shift() ?? (behaviour.plan ? "no plan" : "```json\n" + JSON.stringify(PLAN) + "\n```")
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

// --- Phase C: gate, triage and the planning session -----------------------------------------------------

import { DEFAULT_BACKENDS, Decider, type Asker } from "../src/backends.ts"
import type { Decision } from "../src/jev.ts"

const noul = (v: number) => ({ type: "noul" as const, noul: v })
// A decision model that answers by node: G0 on gliner, the rest on "typesafe".
function nodeDecider(byNode: Record<string, Decision["answers"]>) {
  let node = ""
  const answer: Asker = { async ask() { return { answers: byNode[node] ?? {}, model: "fake", latencyMs: 1 } } }
  const d = new Decider(DEFAULT_BACKENDS, { typesafe: answer, gliner: answer, rules: { async ask() { return { answers: {}, model: "rules", latencyMs: 0 } } } }, () => {})
  const ask = d.ask.bind(d)
  d.ask = (n, ...rest) => { node = n; return ask(n, ...rest) }
  return d
}
const CLEAN = { injection: noul(0), harmful: noul(0), refusal_likely: noul(0.1), sensitive: noul(0.1) }
const TREE = JSON.stringify([
  { id: "D1", question: "Should add() accept more than two numbers?", kind: "decision", dependsOn: [], impact: "high" },
  { id: "D2", question: "What should add() do with non-numbers?", kind: "decision", dependsOn: ["D1"], impact: "medium" },
])

test("an unclear job goes through the planning session, one question per turn, then planning with the decisions", async () => {
  const project = repo()
  const fake = fakeSession({ worker: writeFiles })
  const decider = nodeDecider({ G0: CLEAN, N1: { complexity: { type: "score", score: 2, confidence: 0.8, probabilities: {} }, needs_clarification: noul(0.9) }, N2: {}, N2c: { settles_decision: noul(0.9) } })
  const r = runner(project, fake.api, { decider })
  const started = await r.start("add an add function", "ses_dictator")
  assert.equal(started.kind, "session")
  assert.match(started.text, /dictator_questions/)
  assert.equal(started.job.triage?.complexity, 6)
  const first = await r.questions(started.job.id, TREE)
  assert.match(first, /Ask the user question D1 now/)
  assert.match(await r.answer(started.job.id, "only two numbers") ?? "", /Ask the user question D2 now/)
  assert.match(await r.answer(started.job.id, "throw a TypeError") ?? "", /Design checkpoint/)
  assert.match(await r.answer(started.job.id, "confirm") ?? "", /Call dictator_plan with goal/)
  const planned = await r.continueJob(started.job.id)
  assert.equal(planned.kind, "plan")
  assert.equal(planned.job.phase, "plan_gate")
  assert.ok(planned.job.decisions.some((d) => d.text.includes("throw a TypeError")))
})

test("a clear job skips the session; a pin forces it; a flagged gate asks the user first", async () => {
  const project = repo()
  const fake = fakeSession({ worker: writeFiles })
  const clear = nodeDecider({ G0: CLEAN, N1: { needs_clarification: noul(0.1) } })
  assert.equal((await runner(project, fake.api, { decider: clear }).start("add an add function")).kind, "plan")
  const pinned = runner(project, fake.api, { decider: clear, policies: { global: { "N2.clarity": "ask" } } })
  assert.equal((await pinned.start("add an add function")).kind, "session")
  const flagged = nodeDecider({ G0: { ...CLEAN, refusal_likely: noul(0.9) }, N1: { needs_clarification: noul(0.1) } })
  const r = runner(project, fake.api, { decider: flagged })
  const gated = await r.start("scan my own LAN")
  assert.equal(gated.kind, "gate")
  assert.match(gated.text, /use uncensored/)
  assert.match(await r.answer(gated.job.id, "maybe") ?? "", /Waiting for the user's answer/)
  assert.match(await r.answer(gated.job.id, "use uncensored") ?? "", /local uncensored models only/)
  const job = loadJob(project, gated.job.id)!
  assert.deepEqual([job.phase, job.flags?.localOnly, job.flags?.uncensored], ["triage", true, true])
  assert.equal((await r.continueJob(gated.job.id)).kind, "plan")
})

test("without any decision model the gate keeps the job local and every open question is asked", async () => {
  const project = repo()
  const fake = fakeSession({ worker: writeFiles })
  const started = await runner(project, fake.api).start("add an add function")
  assert.equal(started.kind, "session")
  assert.equal(started.job.flags?.localOnly, true)
  assert.match(started.job.triage?.reason ?? "", /no decision model answer/)
})

test("a cloud model preset never takes a local-only job to the cloud", async () => {
  const project = repo()
  const fake = fakeSession({ worker: writeFiles })
  const r = runner(project, fake.api, { policies: { global: { "N5.model": "fixed:opencode-go/qwen3.8-flash" } } })
  const started = await r.start("add an add function") // no decision model: the gate keeps the job local
  assert.equal(started.job.flags?.localOnly, true)
  await r.questions(started.job.id, JSON.stringify([{ id: "D1", question: "Two numbers or more?", kind: "decision", dependsOn: [], impact: "high" }]))
  await r.answer(started.job.id, "two")
  await r.answer(started.job.id, "confirm")
  await r.continueJob(started.job.id)
  const planner = fake.created.find((c) => c.agent === "dictator-plan")!
  assert.equal((planner.model as { providerID: string }).providerID === "opencode-go", false)
})

test("a goal that failed to plan a short while ago is reported, not started again", async () => {
  const { recentFailure } = await import("../src/runner.ts")
  const project = repo()
  const fake = fakeSession({ plan: ["no", "no", "no"] })
  const { job } = await runner(project, fake.api).plan("add an add function")
  assert.equal(job.phase, "failed")
  assert.match(job.lessons.at(-1)!, /planning failed: no JSON object found/)
  const now = Date.parse(job.updated) + 5 * 60_000
  assert.match(recentFailure(job, "Add an add function", now) ?? "", /failed 5 min ago.*retry: <goal>/s)
  assert.equal(recentFailure(job, "retry: add an add function", now), undefined)
  assert.equal(recentFailure(job, "something else", now), undefined)
  assert.equal(recentFailure(job, "add an add function", now + 60 * 60_000), undefined)
})

// --- the loop watchdog --------------------------------------------------------------------------------------

test("a worker stopped by the watchdog gets one fresh session with a handoff note, a second stop escalates", async () => {
  const project = repo()
  const prompts: string[] = []
  const fake = fakeSession({ worker: (dir, prompt) => { prompts.push(prompt); return writeFiles(dir, prompt) } })
  const watched: string[] = []
  const stoppedOnce = new Set(["ses_2"]) // ses_1 is the planner, ses_2 the first worker of T1
  const r = runner(project, fake.api, {
    watch: (id: string) => watched.push(id),
    stopped: (id: string) => (stoppedOnce.has(id) ? { kind: "read_loop", detail: "read add.js 3x with no write in between" } : undefined),
  })
  const done = await r.run((await r.plan("goal")).job.id)
  assert.equal(done.phase, "integrate", summary(done))
  assert.deepEqual(watched.slice(0, 3), ["ses_1", "ses_2", "ses_3"], "planner and every worker session are watched")
  assert.match(prompts[1]!, /stopped by the loop watchdog: read add.js 3x/)
  assert.ok(done.tasks[0]!.stages.some((s) => s.result === "fail" && s.evidence?.includes("loop watchdog")))

  const always = runner(repo(), fakeSession({ worker: writeFiles }).api, { stopped: (id: string) => (id === "ses_1" ? undefined : { kind: "steps", detail: "more than 60 steps" }) })
  const stuck = await always.run((await always.plan("goal")).job.id)
  assert.equal(stuck.tasks[0]!.status, "escalated")
  assert.match(stuck.lessons.at(-1)!, /stopped twice by the loop watchdog/)
})

test("a planner stopped by the watchdog gets one fresh try, then the job fails with the reason", async () => {
  const project = repo()
  const fake = fakeSession({})
  const ok = runner(project, fake.api, { stopped: (id: string) => (id === "ses_1" ? { kind: "same_call", detail: "read .jev-dictator 3x" } : undefined) })
  assert.equal((await ok.plan("goal")).job.phase, "plan_gate")
  const bad = runner(repo(), fakeSession({}).api, { stopped: () => ({ kind: "read_loop", detail: "read .jev-dictator 3x" }) })
  const failed = await bad.plan("goal")
  assert.equal(failed.job.phase, "failed")
  assert.deepEqual(failed.errors, ["the planner was stopped by the loop watchdog: read .jev-dictator 3x"])
})
