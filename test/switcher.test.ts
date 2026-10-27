import assert from "node:assert/strict"
import { test } from "node:test"

import { newJob, type Task } from "../src/state.ts"
import { agentRows, agentSummary, taskSessions, type SessionFacts } from "../src/switcher.ts"

const now = Date.parse("2026-10-19T12:00:00Z")
const at = (iso: string) => Date.parse(iso)
const s = (id: string, extra: Partial<SessionFacts> = {}): SessionFacts => ({ id, title: id, agent: "coder", time: { created: at("2026-10-19T11:50:00Z"), updated: at("2026-10-19T11:58:00Z") }, ...extra })
const task = (id: string, sessions: string[]): Task => ({
  id, title: id, description: "", role: "code", acceptance: [], dependsOn: [], files: [], wave: 0, status: "running", attempts: 0, stages: [], signatures: [], session: sessions.at(-1), sessions,
})

test("workers sit under their micromanager: by parentID, by the plugin's metadata, or by the job they work for", () => {
  const mm = s("ses_mm", { agent: "micromanager", title: "PPO/GRPO", cost: 0.43 })
  const native = s("ses_native", { parentID: "ses_mm", model: { providerID: "opencode-go", id: "glm-5.3-flash" }, time: { created: at("2026-10-19T11:56:00Z"), updated: now } })
  const planned = s("ses_planned", { metadata: { micromanager: { parent: "ses_mm" } } })
  const older = s("ses_old_runner", { outcome: "failed" })
  const job = { ...newJob("job-1", "goal"), facilitator: "ses_mm", tasks: [task("T6", ["ses_old_runner"])] }
  const other = s("ses_user", { agent: "build", title: "Fix /voice", time: { created: at("2026-10-19T11:00:00Z"), updated: at("2026-10-19T11:30:00Z") } })
  const rows = agentRows([mm, native, planned, older, other], { active: new Set(["ses_native"]), asking: new Set(["ses_planned"]) }, [job], "ses_mm", now)
  assert.deepEqual(rows.map((r) => `${"  ".repeat(r.depth)}${r.tag} ${r.id}`), [
    "IDLE ses_mm",
    "  ASK ses_planned",
    "  RUN ses_native",
    "  FAIL ses_old_runner",
    "IDLE ses_user",
  ])
  assert.equal(rows[2]!.model, "glm")
  assert.equal(rows[2]!.elapsed, "4m")
  assert.equal(rows[0]!.cost, 0.43)
  assert.equal(agentSummary(rows), "1 running · 1 asks")
})

test("sessions with something running come first; old idle ones drop out", () => {
  const stale = s("ses_stale", { time: { created: at("2026-10-18T08:00:00Z"), updated: at("2026-10-18T09:00:00Z") } })
  const quiet = s("ses_quiet")
  const busy = s("ses_busy", { time: { created: at("2026-10-19T09:00:00Z"), updated: at("2026-10-19T09:00:00Z") } })
  const rows = agentRows([stale, quiet, busy], { active: new Set(["ses_busy"]), asking: new Set() }, [], undefined, now)
  assert.deepEqual(rows.map((r) => `${r.tag} ${r.id}`), ["RUN ses_busy", "IDLE ses_quiet"])
  assert.equal(agentSummary(agentRows([quiet], { active: new Set(), asking: new Set() }, [], undefined, now)), "nothing running")
  const onScreen = agentRows([quiet, busy], { active: new Set(["ses_busy"]), asking: new Set() }, [], "ses_quiet", now)
  assert.equal(onScreen[0]!.id, "ses_quiet", "the session on screen leads")
})

test("a task unfolds its own sessions, and under each the subagents it started", () => {
  const worker = s("ses_worker", { time: { created: at("2026-10-19T11:50:00Z"), updated: now } })
  const kid = s("ses_kid", { parentID: "ses_worker", agent: "explore", time: { created: at("2026-10-19T11:55:00Z"), updated: now } })
  const quiet = s("ses_kid2", { parentID: "ses_worker", agent: "research" })
  const asks = s("ses_ask", { parentID: "ses_worker", agent: "general" })
  const older = s("ses_older", { agent: "writer", outcome: "interrupted" })
  const got = taskSessions(["ses_older", "ses_worker"], [worker, older, kid, quiet, asks], { active: new Set(["ses_worker", "ses_kid"]), asking: new Set(["ses_ask"]) }, now)
  assert.deepEqual(got.rows.map((r) => `${r.depth} ${r.tag} ${r.id}`), [
    "0 FAIL ses_older",
    "0 RUN ses_worker",
    "1 ASK ses_ask", // a subagent that waits for the user comes first
    "1 RUN ses_kid",
    "1 DONE ses_kid2",
  ])
  assert.equal(got.rows[1]!.elapsed, "10m")
  assert.equal(got.rows[1]!.known, true)
  assert.equal(got.hidden, 0)
})

test("a session the host no longer lists stays visible but reads as unknown", () => {
  const got = taskSessions(["ses_gone"], [], { active: new Set(), asking: new Set() }, now)
  assert.deepEqual(got.rows, [{ id: "ses_gone", depth: 0, tag: "IDLE", title: "ses_gone", agent: "", elapsed: "", known: false }])
})

test("a worker with more subagents than the cap shows the first ones and counts the rest", () => {
  const kids = Array.from({ length: 10 }, (_, i) => s(`ses_k${i}`, { parentID: "ses_w" }))
  const got = taskSessions(["ses_w"], [s("ses_w"), ...kids], { active: new Set(), asking: new Set() }, now)
  assert.equal(got.rows.length, 1 + 8)
  assert.equal(got.hidden, 2)
})
