// G0, the local-first gate (design.md §20, §21): four guards on a job's or task's text, answered on the machine.
//
// Until our own GLiNER fine-tune passes the guard bench, a "yes" never routes or blocks on its own: it asks the
// user (Phase A9 showed the available fine-tune flags legitimate security work as harmful). The user's answer
// sets the job's flags: local only, uncensored allowed, or on as it is.

import type { Decider } from "./backends.ts"
import { GUARD_FLOOR, GUARDS } from "./catalog.ts"

export type Guard = keyof typeof GUARDS

export interface GateResult {
  readonly flagged: readonly Guard[] // guards at or above their floor
  readonly scores: Partial<Record<Guard, number>>
  readonly checked: boolean // false: no local backend answered
  readonly decision?: string // journal id
}

export interface JobFlags {
  localOnly?: boolean // nothing of this job goes to the cloud
  uncensored?: boolean // local uncensored models only (refusal_likely, confirmed by the user)
  gate?: GateResult
}

// The same text scored 0.59 and 2e-8 for injection in two runs of Phase D, so every text is scored twice and the
// higher score counts: a guard errs towards asking the user.
export async function checkGuards(decider: Decider, text: string, job?: string, task?: string, repeats = 2): Promise<GateResult> {
  const scores: Partial<Record<Guard, number>> = {}
  let checked = false
  let decision: string | undefined
  for (let i = 0; i < repeats; i++) {
    const asked = await decider.ask("G0", { text }, GUARDS, { localOnly: true, job, task })
    decision ??= asked.id
    for (const g of Object.keys(GUARDS) as Guard[]) {
      const a = asked.decision.answers[g]
      if (a?.type === "noul") scores[g] = Math.max(scores[g] ?? 0, a.noul)
    }
    checked ||= asked.backend !== "rules" && Object.keys(asked.decision.answers).length > 0
  }
  return { flagged: (Object.keys(scores) as Guard[]).filter((g) => scores[g]! >= GUARD_FLOOR), scores, checked, decision }
}

const CHUNK = 1500
const MAX_CHUNKS = 6

// Indirect injection (E2b): text a worker did not write but reads (web pages, research notes, a worker's question)
// is checked for injection alone, in chunks, since an injection can hide anywhere in a long page. Returns the highest
// score, or undefined when nothing local answered.
export async function injectionScore(decider: Decider, text: string, job?: string, task?: string): Promise<number | undefined> {
  const chunks: string[] = []
  for (let i = 0; i < text.length && chunks.length < MAX_CHUNKS; i += CHUNK) chunks.push(text.slice(i, i + CHUNK))
  let best: number | undefined
  for (const chunk of chunks) {
    const asked = await decider.ask("G0.injection", { text: chunk }, { injection: GUARDS.injection }, { localOnly: true, job, task })
    const a = asked.decision.answers.injection
    if (asked.backend !== "rules" && a?.type === "noul") best = Math.max(best ?? 0, a.noul)
  }
  return best
}

export const injected = (score: number | undefined): boolean => (score ?? 0) >= GUARD_FLOOR

// What the job does when nothing local could check it. "local" is the privacy-first default (user, 2026-10-04).
export type Unchecked = "local" | "user" | "cloud"

export function flagsWithoutUser(result: GateResult, unchecked: Unchecked = "local"): JobFlags | "ask_user" {
  if (!result.checked) return unchecked === "user" ? "ask_user" : { localOnly: unchecked === "local", gate: result }
  return result.flagged.length === 0 ? { gate: result } : "ask_user"
}

// The question the dictator puts to the user when the gate flagged something.
export function gateQuestion(result: GateResult): string {
  const what: Record<Guard, string> = {
    injection: "the text may try to change the agents' rules (injection)",
    harmful: "it may ask for help to harm people or attack systems you do not own",
    refusal_likely: "a censored model would likely refuse it, so it may need a local uncensored model",
    sensitive: "it may hold data that should stay on this machine",
  }
  const lines = result.flagged.map((g) => `- ${what[g]} (${(result.scores[g] ?? 0).toFixed(2)})`)
  return [
    "The local check flagged this job:",
    ...lines,
    "The check is not calibrated yet, so you decide. Answer with one of:",
    '"always local" (keep everything on this machine), "use uncensored" (local uncensored models only),',
    '"continue" (go on as normal), or "stop".',
  ].join("\n")
}

// The user's answer to the gate question; exact phrases, matched before any model.
export function gateAnswer(text: string): JobFlags | "stop" | undefined {
  const t = text.trim().toLowerCase().replace(/[.!"]+$/g, "").replace(/^"/, "")
  if (t === "always local" || t === "only local") return { localOnly: true }
  if (t === "use uncensored" || t === "uncensored") return { localOnly: true, uncensored: true }
  if (t === "continue" || t === "go on") return {}
  if (t === "stop") return "stop"
  return undefined
}
