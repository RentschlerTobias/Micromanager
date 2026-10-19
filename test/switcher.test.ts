import assert from "node:assert/strict"
import { test } from "node:test"

import { newJob, type Task } from "../src/state.ts"
import { agentRows, agentSummary, type SessionFacts } from "../src/switcher.ts"

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
