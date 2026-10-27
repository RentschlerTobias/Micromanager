import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { combine } from "../src/profile.ts"
import { registerSkills, SKILLS, skillsFor, type SkillEditor } from "../src/skills.ts"
import type { Task } from "../src/state.ts"

const ALL = new Set(SKILLS.map((s) => s.name))
const task: Task = { id: "T1", title: "t", description: "", role: "code", acceptance: ["A1"], dependsOn: [], files: ["a.js"], wave: 0, status: "ready", attempts: 0, stages: [], signatures: [] }
const profile = combine(task, [{ id: "A1", text: "x", verify: "npm test" }], undefined, {})

test("skills by rule: writers verify, P3 and red work test-first, reviewers review, readers research", () => {
  assert.deepEqual(skillsFor("implement", profile, "P1", ALL), ["verification-before-completion"])
  assert.deepEqual(skillsFor("implement", profile, "P3", ALL), ["verification-before-completion", "tdd"])
  assert.deepEqual(skillsFor("review_fix", profile, "P2", ALL), ["verification-before-completion", "receiving-code-review"])
  assert.deepEqual(skillsFor("review", profile, "P2", ALL), ["code-review"])
  assert.deepEqual(skillsFor("reader", undefined, "P9", ALL), ["research"])
  assert.deepEqual(skillsFor("implement", { ...profile, bugUnknownCause: true, skills: ["tdd"] }, "P2", ALL), ["verification-before-completion", "diagnosing-bugs", "tdd"])
  assert.deepEqual(skillsFor("implement", profile, "P3", new Set(["tdd"])), ["tdd"], "only installed skills are named")
})

test("the plugin registers the catalog itself, and a skill of the user's own with the same name keeps its place", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jd-skills-"))
  mkdirSync(join(dir, "tdd"))
  writeFileSync(join(dir, "tdd", "SKILL.md"), "---\nname: tdd\n---\nours\n")
  const added: { id: string; path: string; content: string }[] = []
  const editor: SkillEditor = {
    list: () => [{ id: "research", path: "/somewhere/else/.config/opencode/skills/research/SKILL.md" }],
    add: (skill) => void added.push(skill),
  }
  const installed = await registerSkills({ transform: async (callback) => callback(editor) }, dir)
  assert.deepEqual([...installed], ["tdd"], "the user's research is not ours, so tdd is the only one registered")
  assert.deepEqual(added.map((s) => s.id), ["tdd"])
  assert.equal(added[0].path, join(dir, "tdd", "SKILL.md"))
  assert.match(added[0].content, /^---\nname: tdd/)
})

test("an install that lost skills/, or a server without ctx.skill, still starts: no skills, no throw", async () => {
  assert.deepEqual([...await registerSkills(undefined)], [])
  const missing: string[] = []
  const empty = await registerSkills({ transform: async () => assert.fail("must not register from a missing directory") }, join(tmpdir(), "jd-skills-none"), (name) => void missing.push(name))
  assert.deepEqual([...empty], [])
  assert.deepEqual(missing, SKILLS.map((s) => s.name))
})

test("every catalog skill exists in skills/ with a matching name and its source in the frontmatter", () => {
  for (const s of SKILLS) {
    const path = join(import.meta.dirname, "..", "skills", s.name, "SKILL.md")
    assert.ok(existsSync(path), path)
    const text = readFileSync(path, "utf8")
    assert.match(text, new RegExp(`^---\\nname: ${s.name}\\n`), s.name)
    assert.match(text, /\n {2}source: https:\/\/github\.com\/[\w-]+\/[\w-]+\/blob\/[0-9a-f]{40}\//, s.name)
  }
})
