import assert from "node:assert/strict"
import { test } from "node:test"

import { Helpers, MAX_HELPERS, type Caller } from "../src/helpers.ts"

const CALLER: Caller = { dir: "/p/.jev-micromanager/worktrees/job-1--T3", label: "T3 of job-1", task: "Add a --verbose flag: …" }

// A host that answers every prompt with `answer`, or never ends when `hang` is set.
function fakeHost(answer = "src/cli.ts:12 parses the flags", hang = false) {
  const created: Record<string, unknown>[] = []
  const prompts: string[] = []
  const interrupted: string[] = []
  let n = 0
  const session = {
    async create(args: Record<string, unknown>) { created.push(args); return { id: `ses_h${++n}` } },
    async prompt(args: { sessionID: string; text: string }) { prompts.push(args.text) },
    wait: () => (hang ? new Promise(() => {}) : Promise.resolve()),
    async context() { return [{ type: "assistant", content: [{ type: "text", text: answer }] }] },
    async interrupt(args: { sessionID: string }) { interrupted.push(args.sessionID) },
  }
  return { session, created, prompts, interrupted }
}

function helpers(host: ReturnType<typeof fakeHost>, extra: Partial<ConstructorParameters<typeof Helpers>[0]> = {}) {
  const started: string[] = []
  const ended: string[] = []
  const journal: Record<string, unknown>[] = []
  const h = new Helpers({
    session: host.session,
    caller: (id) => (id === "ses_writer" ? CALLER : undefined),
    model: async (role) => role.models[0]!,
    started: (helper, caller, dir) => started.push(`${helper}<-${caller}@${dir}`),
    ended: (helper) => ended.push(helper),
    journal: (e) => journal.push(e),
    ...extra,
  })
  return { h, started, ended, journal }
}

test("a writer's question runs an explorer in the writer's directory and comes back as the answer", async () => {
  const host = fakeHost()
  const { h, started, ended, journal } = helpers(host)
  assert.equal(await h.ask("ses_writer", "explore", "Who parses the flags?"), "src/cli.ts:12 parses the flags")
  const [args] = host.created
  assert.equal(args!.agent, "explorer")
  assert.equal(args!.parentID, "ses_writer", "OpenCode shows it under the writer")
  assert.deepEqual(args!.location, { directory: CALLER.dir }, "it reads the writer's change, uncommitted edits included")
  assert.match(String(args!.title), /^T3 of job-1 · explorer · Who parses/)
  assert.deepEqual(started, [`ses_h1<-ses_writer@${CALLER.dir}`], "registered before its first turn")
  assert.deepEqual(ended, ["ses_h1"])
  assert.match(host.prompts[0]!, /Question: Who parses the flags\?/)
  assert.match(host.prompts[0]!, /Change nothing\./)
  assert.equal(journal[0]!.kind, "helper")
  assert.equal(journal[0]!.role, "explore")
})

test("research goes to the researcher and is told to cite its sources", async () => {
  const host = fakeHost("zod 4 renamed it: https://zod.dev/v4")
  const { h } = helpers(host)
  await h.ask("ses_writer", "research", "What replaced z.string().nonempty()?")
  assert.equal(host.created[0]!.agent, "researcher")
  assert.match(host.prompts[0]!, /cite the URLs/)
})

test("only a writer may ask, with a question, and a few times per task", async () => {
  const host = fakeHost()
  const { h } = helpers(host)
  assert.match(await h.ask("ses_reader", "explore", "q?"), /^Only a worker that changes files/)
  assert.match(await h.ask("ses_writer", "explore", "  "), /^Ask one question/)
  for (let i = 0; i < MAX_HELPERS; i++) await h.ask("ses_writer", "explore", `q${i}?`)
  assert.match(await h.ask("ses_writer", "research", "one more?"), /You asked 3 helpers in this task already/)
  assert.equal(host.created.length, MAX_HELPERS, "no session for a refused question")
})

test("a helper that runs out of time is interrupted, and the writer gets what it had", async () => {
  const host = fakeHost("half an answer", true)
  const { h, journal } = helpers(host, { timeoutMs: 10 })
  const answer = await h.ask("ses_writer", "explore", "q?")
  assert.match(answer, /^\[the helper ran out of time; this is what it had\]\nhalf an answer/)
  assert.deepEqual(host.interrupted, ["ses_h1"])
  assert.equal(journal[0]!.timedOut, true)
})

test("a helper without an answer says so instead of returning nothing", async () => {
  const host = fakeHost("")
  const { h } = helpers(host)
  assert.match(await h.ask("ses_writer", "explore", "q?"), /^The explorer ended without an answer\. Go on without it/)
})
