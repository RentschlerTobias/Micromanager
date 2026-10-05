// N7, a worker's follow-ups (design.md §8): what the decision model is asked, and how code turns its answers into
// a verdict per item. Pure, so the runner and the N7 bench (npm run bench-n7) decide the same way.

import { CHOICE_FLOOR, followUpQuestions, NOUL_FLOOR } from "./catalog.ts"
import type { Answer } from "./jev.ts"
import type { FollowUp } from "./state.ts"

export interface N7Context {
  readonly goal: string
  readonly acceptance: readonly string[]
  readonly task: string // the finder: "<id> <title>"
  readonly otherTasks: readonly string[] // "<id> <title> (files: …)", every other live task of the job
  readonly openFiles: ReadonlySet<string> // files of tasks still open (not the finder)
  readonly doneFiles: ReadonlySet<string> // files of done tasks and the finder
}

export type Verdict =
  | { readonly kind: "task"; readonly priority: number }
  | { readonly kind: "planned" }
  | { readonly kind: "later"; readonly reason: "user_should_decide" | "out_of_scope" | "no_files" }

export function n7State(ctx: N7Context, items: readonly FollowUp[]): Record<string, unknown> {
  return { goal: ctx.goal, acceptance: ctx.acceptance, task: ctx.task, otherTasks: ctx.otherTasks, followUps: items }
}

export const n7Questions = followUpQuestions

const PRIORITY: Record<string, number> = { high: 1, normal: 3, low: 5 }

// answers: the model's, or empty (no model, or a rule preset). Without answers, files decide: a follow-up only on
// files of tasks still open is already planned, one on files of done tasks is in scope, anything else is not.
export function triage(answers: Readonly<Record<string, Answer>>, items: readonly FollowUp[], ctx: N7Context): Verdict[] {
  const noul = (q: string) => (answers[q]?.type === "noul" ? (answers[q] as { noul: number }).noul : undefined)
  return items.map((item, i): Verdict => {
    const planned = noul(`planned.${i}`)
    const onOpen = item.files.length > 0 && item.files.every((f) => ctx.openFiles.has(f))
    if (planned !== undefined ? planned >= NOUL_FLOOR : onOpen) return { kind: "planned" }
    // "Needed or in scope" goes before "the user's call": on the N7 bench the latter is high for nearly everything
    // outside the job's text (0.6 to 0.8), real work included, while needed and in_scope stay low for what is not.
    const needed = noul(`needed.${i}`)
    const inScope = noul(`in_scope.${i}`)
    const take = needed !== undefined || inScope !== undefined
      ? Math.max(needed ?? 0, inScope ?? 0) >= NOUL_FLOOR
      : item.files.length > 0 && item.files.every((f) => ctx.doneFiles.has(f))
    if (!take) return { kind: "later", reason: (noul(`user.${i}`) ?? 0) >= NOUL_FLOOR ? "user_should_decide" : "out_of_scope" }
    if (item.files.length === 0) return { kind: "later", reason: "no_files" }
    const p = answers[`priority.${i}`]
    return { kind: "task", priority: p?.type === "choice" && p.confidence >= CHOICE_FLOOR ? PRIORITY[p.choice] ?? 3 : 3 }
  })
}
