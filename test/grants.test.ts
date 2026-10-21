import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { addGrant, loadControl } from "../src/control.ts"
import { grantForm, readForm } from "../src/forms.ts"
import { badName, grantNote, GrantRequests, grantResult, grantState, triage, valueShape, type GrantFacts } from "../src/grants.ts"

const env = (name: string, value: string | undefined, more: Partial<GrantFacts> = {}): GrantFacts => ({ kind: "env", name, value, open: [], refused: [], sandboxed: true, secrets: [], ...more })
const host = (name: string, more: Partial<GrantFacts> = {}): GrantFacts => ({ kind: "network", name, open: [], refused: [], sandboxed: true, secrets: [], ...more })

test("names and hosts: a variable name, a host or *.host, nothing with a scheme, a path or a bare TLD", () => {
  assert.equal(badName("env", "DATABASE_URL"), undefined)
  assert.match(badName("env", "1X")!, /no variable name/)
  assert.match(badName("env", "A=B")!, /no variable name/)
  assert.equal(badName("network", "api.github.com"), undefined)
  assert.equal(badName("network", "*.example.com"), undefined)
  for (const bad of ["https://api.github.com", "github.com/x", "*.com", "*", "localhost", "api.github.com:443"]) assert.ok(badName("network", bad), bad)
})

test("a variable: never list and unset refused, the allowlist already open, a secret to the user, a setting to Jev", () => {
  assert.equal(triage(env("SSH_AUTH_SOCK", "/run/x")).verdict, "refused")
  assert.equal(triage(env("DBUS_SESSION_BUS_ADDRESS", "unix:x")).verdict, "refused")
  assert.match((triage(env("DATABASE_URL", undefined)) as { text: string }).text, /not set where the server runs/)
  assert.equal(triage(env("NODE_ENV", "test")).verdict, "open")
  assert.equal(triage(env("MY_FLAG", "1", { open: ["MY_FLAG"] })).verdict, "open")
  assert.equal(triage(env("MY_FLAG", "1", { refused: ["MY_FLAG"] })).verdict, "refused")
  assert.equal(triage(env("GITHUB_TOKEN", "ghp_x")).verdict, "user")
  assert.equal(triage(env("DATABASE_URL", "postgres://u:pw@localhost/db")).verdict, "user")
  assert.equal(triage(env("RUST_LOG", "debug")).verdict, "jev")
  assert.equal(triage(env("DATABASE_URL", "postgres://localhost/db")).verdict, "jev")
})

test("a host: registries open, no sandbox means open, a refusal stays, a host next to a secret goes to the user", () => {
  assert.equal(triage(host("registry.npmjs.org")).verdict, "open")
  assert.equal(triage(host("api.example.com", { open: ["*.example.com"] })).verdict, "open")
  assert.equal(triage(host("evil.com", { sandboxed: false })).verdict, "open")
  assert.equal(triage(host("github.com", { refused: ["github.com"] })).verdict, "refused")
  const t = triage(host("api.github.com", { secrets: ["GITHUB_TOKEN"] }))
  assert.equal(t.verdict, "user")
  assert.match((t as { reason: string }).reason, /GITHUB_TOKEN/)
  assert.equal(triage(host("docs.rs")).verdict, "jev")
})

test("Jev sees a value's shape, never the value", () => {
  assert.equal(valueShape("debug"), "5 characters: lowercase letters")
  const state = grantState("env", "API_MODE", "the tests read it", "T1 Tests", "s3cr3t-Value")
  assert.ok(!state.includes("s3cr3t-Value"))
  assert.match(state, /12 characters/)
})

test("the grant form: names the secrets beside a host, reads only the plugin's labels", () => {
  const form = grantForm("G3", "network", "api.github.com", "T2 Sync", "fetches releases", ["GITHUB_TOKEN"])
  assert.equal(form[0]!.header, "Grant G3")
  assert.match(form[0]!.question, /already hold GITHUB_TOKEN/)
  assert.deepEqual(readForm(form, [["Allow for this job"]]), { kind: "grant", id: "G3", granted: true })
  assert.deepEqual(readForm(form, [["Refuse"]]), { kind: "grant", id: "G3", granted: false })
  assert.deepEqual(readForm(form, [["yes please"]]), { kind: "grant", id: "G3", said: "yes please" })
  assert.doesNotMatch(grantForm("G1", "env", "DATABASE_URL", "T1", "tests")[0]!.question, /already hold/)
})

test("requests: the user's answer settles the waiting call, a second worker waits on the same form, timeout refuses", async () => {
  const journal: Record<string, unknown>[] = []
  const requests = new GrantRequests((e) => journal.push(e), 30)
  const base = { kind: "env" as const, name: "DATABASE_URL", why: "tests", parent: "mm", task: "T1", project: "/p", jobId: "job-1", secrets: [] }
  const a = requests.open({ ...base, sessionID: "w1" })
  const b = requests.open({ ...base, sessionID: "w2" })
  assert.equal(a.fresh, true)
  assert.equal(b.fresh, false)
  assert.equal(b.pending.id, a.pending.id)
  assert.match(grantNote(a.pending), /Grant G1/)
  assert.equal(requests.answer(a.pending.id, true)?.name, "DATABASE_URL")
  assert.deepEqual(await a.answer, { granted: true, by: "user" })
  assert.deepEqual(await b.answer, { granted: true, by: "user" })
  assert.equal(requests.answer(a.pending.id, false), undefined)
  const late = requests.open({ ...base, name: "OTHER", sessionID: "w1" })
  assert.deepEqual(await late.answer, { granted: false, by: "timeout" })
  const gone = requests.open({ ...base, name: "THIRD", sessionID: "w3" })
  assert.equal(requests.drop(["w3"]).length, 1)
  assert.equal((await gone.answer).granted, false)
  assert.ok(journal.every((e) => !JSON.stringify(e).includes("postgres")))
  assert.match(grantResult("env", "X", false, "timeout"), /nobody answered in time/)
})

test("grants and refusals are kept per job in its control file, names only", () => {
  const project = mkdtempSync(join(tmpdir(), "mm-grants-"))
  addGrant(project, "job-1", "env", "DATABASE_URL", true)
  addGrant(project, "job-1", "env", "DATABASE_URL", true)
  addGrant(project, "job-1", "network", "api.github.com", false)
  const c = loadControl(project, "job-1")
  assert.deepEqual(c.grants, { env: ["DATABASE_URL"] })
  assert.deepEqual(c.refused, { network: ["api.github.com"] })
  assert.deepEqual(loadControl(project, "job-2"), {})
})
