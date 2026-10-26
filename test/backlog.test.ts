import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { backlogTool, byTurn, draftFromLater, draftFromTrial, goalOf, localBackend, parseFrontMatter, parseItem, renderItem, slugOf, type BacklogItem } from "../src/backlog.ts"
import { newJob, stage, type Task } from "../src/state.ts"

const item = (extra: Partial<BacklogItem> = {}): BacklogItem => ({
  slug: "faster-search",
  title: "Make code search faster",
  status: "ready",
  order: 20,
  kind: "optimize",
  origin: "user",
  acceptance: [{ text: "Same hits: on the fixture repo", verify: "npm test -- test/search.test.ts" }, { text: "documented" }],
  checks: ["npm run typecheck"],
  fitness: { goal: "faster", evaluator: "sh bench.sh", scores: [{ name: "ms", direction: "min" }] },
  created: "2026-10-26",
  body: "## Goal\nSearch over 10k files takes 4 s.",
  ...extra,
})

test("an item is written as front matter and Markdown, and read back the same", () => {
  const text = renderItem(item())
  assert.match(text, /^---\ntitle: Make code search faster\nstatus: ready\norder: 20\nkind: optimize\norigin: user\ncreated: 2026-10-26\nacceptance:\n  - text: "Same hits: on the fixture repo"\n    verify: npm test -- test\/search.test.ts\n  - text: documented\nchecks:\n  - npm run typecheck\nfitness: \{"goal":"faster"/)
  assert.deepEqual(parseItem(text, "faster-search").item, item())
  const { fitness: _, ...rest } = item()
  const odd: BacklogItem = { ...rest, title: "true", from: "job-1/T7", job: "job-2", checks: ["test -f 'a b.js' # really"], body: "" }
  assert.deepEqual(parseItem(renderItem(odd), "faster-search").item, odd)
})

test("hand-written front matter is read leniently, and what is wrong is named", () => {
  const f = parseFrontMatter("# a comment\ntitle: Fix the login   # why not\norder: 5\nchecks:\n  - npm test\n  - 'it''s'\nacceptance:\n  - text: works\n    verify: npm test\n  - plain point\n")
  assert.deepEqual(f, { title: "Fix the login", order: 5, checks: ["npm test", "it's"], acceptance: [{ text: "works", verify: "npm test" }, "plain point"] })
  const lenient = parseItem("---\ntitle: Fix it\n---\nbody", "fix-it").item!
  assert.equal(lenient.status, "draft")
  assert.equal(lenient.kind, "build")
  assert.deepEqual(lenient.acceptance, [])
  assert.deepEqual(parseItem("no front matter", "x").errors, ["x: no front matter between --- lines"])
  assert.deepEqual(parseItem("---\nstatus: maybe\nkind: chore\n---\n", "x").errors, ["x: title is missing", "x: status must be one of draft, ready, running, done, dropped", "x: kind must be one of build, fix, optimize"])
})

test("items run open first, ready before draft, then by order; slugs stay unique", () => {
  const a = item({ slug: "a", status: "draft", order: 1 })
  const b = item({ slug: "b", status: "ready", order: 50 })
  const c = item({ slug: "c", status: "ready", order: 10 })
  const d = item({ slug: "d", status: "done", order: 0 })
  assert.deepEqual([a, b, c, d].sort(byTurn).map((i) => i.slug), ["c", "b", "a", "d"])
  assert.equal(slugOf("Größe der Übersicht: halbieren!", new Set()), "groesse-der-uebersicht-halbieren")
  assert.equal(slugOf("Fix it", new Set(["fix-it", "fix-it-2"])), "fix-it-3")
  assert.equal(slugOf("!!!", new Set()), "item")
})

test("a follow-up and a trial that failed on every attempt become drafts that say where they came from", () => {
  const job = newJob("job-1", "speed up the search\nmore")
  const later = draftFromLater({ what: "Fix the flaky date test", why: "it fails at midnight", files: ["test/date.test.ts"], from: "T3", reason: "reported" }, job, new Set(), new Date("2026-10-26T12:00:00Z"))
  assert.equal(later.slug, "fix-the-flaky-date-test")
  assert.equal(later.kind, "fix")
  assert.equal(later.from, "job-1/T3")
  assert.match(later.body, /## Why\nit fails at midnight\n\n## Files\ntest\/date\.test\.ts\n\nFound by T3 of job-1 \(speed up the search\)\./)
  const t = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: `Rewrite the index (attempt 1/3)`, description: "rewrite it", role: "code", acceptance: ["A1"], dependsOn: [], files: ["i.js"], wave: 0, status: "blocked", attempts: 2, stages: [], signatures: [], model: "m/x", ...extra })
  const failed = [t("T1"), t("T2")]
  stage(failed[0]!, "gate", "fail", "npm test")
  const trial = draftFromTrial(job, failed[0]!, failed, ["npm test"], new Set(), new Date("2026-10-26T12:00:00Z"))
  assert.equal(trial.title, "Rewrite the index")
  assert.equal(trial.origin, "trial-failed")
  assert.deepEqual(trial.checks, ["npm test"])
  assert.match(trial.body, /## What the 2 attempts hit\n- T1 on m\/x: gate: npm test/)
  assert.match(goalOf(item()), /^Make code search faster\n\n## Goal\n.*\n\nAcceptance:\n- Same hits: on the fixture repo \(checked with: npm test -- test\/search\.test\.ts\)\n- documented\n\nChecks: npm run typecheck\n\nFitness contract to define first/s)
})

test("the backlog tool lists, adds, shows and changes items in the project", () => {
  const project = mkdtempSync(join(tmpdir(), "jd-backlog-"))
  assert.match(backlogTool(project, "list", "", ""), /empty \(\.micromanager\/backlog\/\)/)
  assert.match(backlogTool(project, "add", "", JSON.stringify({ title: "Faster search", kind: "optimize", goal: "4 s is too slow", checks: ["npm test"] })), /^Added faster-search \(draft\)/)
  assert.match(backlogTool(project, "add", "", JSON.stringify({ title: "Faster search", checks: ["Run the tests."] })), /^Not added: .* reads like a sentence/)
  assert.match(backlogTool(project, "add", "", JSON.stringify({ title: "Docs", status: "ready", order: 5 })), /^Added docs \(ready\)/)
  assert.ok(existsSync(join(project, ".micromanager", "backlog", "faster-search.md")))
  assert.match(readFileSync(join(project, ".micromanager", "backlog", "faster-search.md"), "utf8"), /Needs a fitness contract before it can run/)
  assert.equal(backlogTool(project, "set", "faster-search", "order=1"), "faster-search is draft, order 1.")
  assert.match(backlogTool(project, "set", "faster-search", "status=later"), /status is one of/)
  assert.match(backlogTool(project, "list", "", ""), /- docs \[ready, build, order 5\] Docs\n- faster-search \[draft, optimize, order 1\] Faster search/)
  assert.equal(backlogTool(project, "set", "docs", "status=done"), "docs is done, order 5.")
  assert.match(backlogTool(project, "list", "", ""), /1 done or dropped\./)
  assert.match(backlogTool(project, "show", "docs", ""), /^---\ntitle: Docs\nstatus: done/)
  assert.equal(localBackend.list(project).length, 2)
  assert.match(backlogTool(project, "show", "nope", ""), /no backlog item nope/)
})
