// The leaf skills workers load (design.md §13.1): adapted copies in skills/. Workflow logic stays in the plugin; a
// skill only says how to do the work.
//
// They are registered through ctx.skill at setup, not linked into the OpenCode config directory. A package install
// (`opencode plugin add`) has no checkout to link from, and the files ship inside this package, so the plugin reads
// its own skills/ directory and adds them itself. That also makes the set identical on every platform: a link is a
// filesystem feature, a registration is not.
//
// Some skills come by rule (every writer verifies, P3 works test-first, a reviewer reviews), the others are offered
// to the decision model per task (N5's skill.<name> nouls). A skill is named in a brief only when the skill in
// OpenCode is this package's copy, so a user's own skill of the same name is never loaded by mistake.

import { readFileSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { Profile, Skill } from "./profile.ts"

export interface CatalogSkill extends Skill {
  readonly asked: boolean // offered to the decision model; otherwise only added by rule
}

// One skill as OpenCode takes it: what the editor's add() is given.
export interface SkillFile {
  readonly name: string
  readonly description: string
  readonly path: string
  readonly content: string
}

// The slice of ctx.skill this plugin uses. Kept structural for two reasons: the plugin then needs no dependency on
// @opencode/plugin (it exports a plain object, see src/plugin.ts), and a test can pass a fake editor.
export interface SkillEditor {
  list(): readonly { readonly id: string; readonly path?: string }[]
  add(skill: { id: string; name: string; description: string; path: string; content: string }): void
}

export interface SkillDomain {
  transform(callback: (editor: SkillEditor) => void): Promise<unknown>
}

const WRITER_ROLES = ["code", "test", "visual", "write", "debug"]

export const SKILLS: readonly CatalogSkill[] = [
  { name: "verification-before-completion", description: "run the checks and read their output before claiming the task is done", roles: WRITER_ROLES, asked: false },
  { name: "tdd", description: "test-driven development: tests at the public seams, red before green", roles: ["code", "test"], asked: true },
  { name: "diagnosing-bugs", description: "a disciplined loop for bugs with an unknown cause: feedback loop, hypotheses, instrumentation", roles: ["code", "debug"], asked: true },
  { name: "receiving-code-review", description: "check review findings against the code before changing anything", roles: ["code", "test", "visual", "write", "debug"], asked: false },
  { name: "code-review", description: "review a change on two axes: what the task asked, and the repo's standards", roles: ["review"], asked: false },
  { name: "research", description: "answer a question from primary sources and cite every claim", roles: ["research"], asked: false },
]

export type Stage = "implement" | "red" | "review" | "review_fix" | "reader"

// The skills a stage gets by rule, plus the ones the decision model picked for the task.
export function skillsFor(stage: Stage, profile: Profile | undefined, pipeline: string | undefined, installed: ReadonlySet<string>): string[] {
  const out: string[] = []
  if (stage === "implement" || stage === "red" || stage === "review_fix") {
    if (profile && WRITER_ROLES.includes(profile.role)) out.push("verification-before-completion")
    if (stage === "red" || pipeline === "P3") out.push("tdd")
    if (profile?.bugUnknownCause) out.push("diagnosing-bugs")
    if (stage === "review_fix") out.push("receiving-code-review")
    out.push(...(profile?.skills ?? []))
  }
  if (stage === "review") out.push("code-review")
  if (stage === "reader") out.push("research")
  return [...new Set(out)].filter((s) => installed.has(s))
}

// Next to this module, so a package install (node_modules/…) and a symlinked dev checkout both resolve to the copy
// that belongs to the running code. realpath, because the dev install is a symlink into the repo.
export const SKILLS_DIR = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "..", "skills")

// The catalog's files on disk, in catalog order. A missing file is reported and left out rather than thrown: an
// install that lost its skills/ directory must still start, with its workers getting no skill.
export function skillFiles(dir = SKILLS_DIR, missing: (name: string) => void = () => {}): readonly SkillFile[] {
  const out: SkillFile[] = []
  for (const skill of SKILLS) {
    const path = join(dir, skill.name, "SKILL.md")
    try {
      out.push({ name: skill.name, description: skill.description, path, content: readFileSync(path, "utf8") })
    } catch {
      missing(skill.name)
    }
  }
  return out
}

// Registers the catalog into OpenCode and answers with the names that are ours and now in place: exactly what a
// brief may say, because skillsFor filters on this set. A skill the user wrote under the same name keeps its place;
// ours is not added over it, and the name stays out of the set, so no worker is told to load a skill that would
// turn out to be someone else's.
export async function registerSkills(
  domain: SkillDomain | undefined,
  dir = SKILLS_DIR,
  missing?: (name: string) => void,
): Promise<ReadonlySet<string>> {
  const files = skillFiles(dir, missing)
  const added = new Set<string>()
  if (!domain || files.length === 0) return added
  await domain.transform((editor) => {
    const present = new Map(editor.list().map((skill) => [skill.id, skill]))
    for (const file of files) {
      const seen = present.get(file.name)
      if (seen && seen.path !== file.path) continue
      editor.add({ id: file.name, name: file.name, description: file.description, path: file.path, content: file.content })
      added.add(file.name)
    }
  })
  return added
}
