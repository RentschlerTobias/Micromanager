// The leaf skills workers load (design.md §13.1): adapted copies in skills/, linked into OpenCode by
// `install.sh --skills`. Workflow logic stays in the plugin; a skill only says how to do the work.
//
// Some skills come by rule (every writer verifies, P3 works test-first, a reviewer reviews), the others are offered
// to the decision model per task (N5's skill.<name> nouls). A skill is named in a brief only when the link in the
// OpenCode skills directory is ours, so a user's own skill of the same name is never loaded by mistake.

import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { Profile, Skill } from "./profile.ts"

export interface CatalogSkill extends Skill {
  readonly asked: boolean // offered to the decision model; otherwise only added by rule
}

// The gitmaster is deliberately not in this list and so gets no skill: a merge is not work with a process to follow, and
// the one skill that would apply (verification-before-completion) tells it to run the checks, which its shell rules refuse
// on purpose — the plugin already ran them on the branch before the merge.
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

export function skillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode", "skills")
}

const REPO_SKILLS = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "..", "skills")

// The catalog skills whose OpenCode link resolves to this repo's copy.
export function installedSkills(dir = skillsDir(), repo = REPO_SKILLS): Set<string> {
  const ours = (name: string) => {
    try {
      return realpathSync(join(dir, name)) === realpathSync(join(repo, name))
    } catch {
      return false
    }
  }
  return new Set(SKILLS.map((s) => s.name).filter(ours))
}
