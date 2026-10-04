import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { combine } from "../src/profile.ts"
import { installedSkills, SKILLS, skillsFor } from "../src/skills.ts"
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

test("a skill counts as installed only when its OpenCode link points at this repo's copy", () => {
  const repo = mkdtempSync(join(tmpdir(), "jd-skills-repo-"))
  const dir = mkdtempSync(join(tmpdir(), "jd-skills-"))
  for (const n of ["tdd", "research"]) mkdirSync(join(repo, n))
  symlinkSync(join(repo, "tdd"), join(dir, "tdd"))
  mkdirSync(join(dir, "research")) // the user's own skill of the same name
  assert.deepEqual([...installedSkills(dir, repo)], ["tdd"])
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
