// What a worker is told, and what it reports back (design.md §8.2). The brief is plain instructions: acceptance
// points and files go in verbatim. The report is short and fixed, so code can read it.

import { HEADER } from "./hooks.ts"
import type { Acceptance, FollowUp, Job, Task } from "./state.ts"

export type WorkerStatus = "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED"

export interface Report {
  readonly status?: WorkerStatus
  readonly files: string[]
  readonly evidence: string
  readonly open: string
  readonly followUps: FollowUp[]
  readonly text: string
}

// Caveman (design.md §13.2): text that only code or another agent reads is terse. Briefs to workers stay plain.
export const CAVEMAN = `Style (only code reads this): answer first; no greeting, recap or filler; fragments are fine. Keep every
"not", number, path, command and quote exact.`

const REPORT_FORMAT = `End your answer with this report, nothing after it:
STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
FILES: the files you changed, comma separated, or none
EVIDENCE: the commands you ran and their results, short
OPEN: what is left open or what you need, or nothing
FOLLOWUP: work the job needs that is outside your task | why | the files it would change (one line each; leave out if none)
${CAVEMAN}`

export function taskAcceptance(job: Job, task: Task): Acceptance[] {
  return job.acceptance.filter((a) => task.acceptance.includes(a.id))
}

// An acceptance point several tasks cover: each task does and is judged on its own part only.
export function sharedNote(job: Job, task: Task, id: string): string {
  const others = job.tasks.filter((t) => t.id !== task.id && t.acceptance.includes(id)).map((t) => t.id)
  return others.length ? ` [shared with ${others.join(", ")}: only this task's part counts here]` : ""
}

export function brief(job: Job, task: Task, model: string, directory: string, skills: readonly string[] = []): string {
  const acceptance = taskAcceptance(job, task)
    .map((a) => `- ${a.id}: ${a.text}${a.verify ? ` (checked with: ${a.verify})` : ""}${sharedNote(job, task, a.id)}`)
    .join("\n")
  const done = job.tasks.filter((t) => t.status === "passed" || t.status === "merged")
  return [
    `${HEADER} task ${task.id} · role ${task.role} · model ${model}`,
    "",
    `The job: ${job.goal}`,
    "",
    `Your task (${task.id}): ${task.title}`,
    task.description,
    "",
    "Acceptance points:",
    acceptance || "- none given",
    "",
    task.files.length ? `Files you may change: ${task.files.join(", ")}` : "Change no files.",
    `Work only in ${directory}. Do only this task.`,
    "Keys and tokens show as <secret> in what you read; never write <secret> into a file, leave such lines as they are.",
    done.length ? `Already done: ${done.map((t) => `${t.id} ${t.title}`).join("; ")}` : "",
    job.decisions.length ? `Decisions that apply: ${job.decisions.map((d) => d.text).join("; ")}` : "",
    job.lessons.length ? `Learned earlier in this job: ${job.lessons.slice(-3).join("; ")}` : "",
    skillLine(skills),
    "",
    REPORT_FORMAT,
  ].filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n").trim()
}

export function skillLine(skills: readonly string[]): string {
  return skills.length ? `Load these skills before you start: ${skills.join(", ")}.` : ""
}

// What a fresh session on another model is told after the previous one failed (N9 rung 2, design.md §8.2).
export function handoffText(reason: string, details: string, changed: readonly string[]): string {
  return [
    `A previous attempt at this task, by another model, failed: ${reason}.`,
    details ? `What it ran into:\n${details.slice(0, 3000)}` : "",
    changed.length ? `Files it already changed in this directory: ${changed.join(", ")}. Check them: keep what is right, fix what is wrong, and do not start over blindly.` : "It changed no file.",
    "Try another way than the previous attempt if its way kept failing.",
  ].filter(Boolean).join("\n\n")
}

export function fixPrompt(failures: readonly { command: string; code: number; output: string }[]): string {
  const parts = failures.map((f) => `$ ${f.command}  (exit ${f.code})\n${f.output}`)
  return `${HEADER} The checks of your task failed:\n\n${parts.join("\n\n")}\n\nFix the cause in your task's files, then report again in the same format.`
}

const STATUSES: readonly WorkerStatus[] = ["DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED", "DONE"]

export function parseReport(text: string): Report {
  const field = (name: string) => text.match(new RegExp(`^\\s*\\**${name}\\**\\s*:\\**\\s*(.*)$`, "im"))?.[1]?.trim() ?? ""
  const statusText = field("STATUS").toUpperCase()
  const status = STATUSES.find((s) => statusText.startsWith(s))
  const files = field("FILES")
  const followUps = [...text.matchAll(/^\s*\**FOLLOWUP\**\s*:\**\s*(.+)$/gim)]
    .map((m) => m[1]!.split("|").map((p) => p.trim()))
    .filter(([what]) => what && !/^(none|nothing|-)$/i.test(what))
    .map(([what, why, paths]): FollowUp => ({
      what: what!,
      why: why ?? "",
      files: !paths || /^none$/i.test(paths) ? [] : paths.split(/[,\s]+/).map((f) => f.replace(/[`*]/g, "")).filter(Boolean),
    }))
  return {
    status,
    files: !files || /^none$/i.test(files) ? [] : files.split(/[,\s]+/).map((f) => f.replace(/[`*]/g, "")).filter(Boolean),
    evidence: field("EVIDENCE"),
    open: field("OPEN"),
    followUps,
    text,
  }
}

// worker_refused (design.md §10.2): a reply without a report that reads like a safety refusal. Code decides, by
// phrasing; the patterns are conservative until the refusal probe set (A10) calibrates them.
const REFUSAL = /\b(I can(?:'|no)t (?:help|assist|do|comply|provide|write|create)|I(?:'m| am) (?:not able|unable) to (?:help|assist|comply|do)|I won't (?:help|do|write|create|be able)|I must decline|I(?:'m| am) sorry, but I can|against (?:my|the|our) (?:guidelines|policies|policy|usage policies))/i

export function refused(text: string): boolean {
  return REFUSAL.test(text) && parseReport(text).status === undefined
}

// The last assistant message's text, from ctx.session.context() (shape seen in Phase A).
export function lastAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return ""
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { type?: string; content?: { type?: string; text?: string }[] }
    if (m.type !== "assistant" || !Array.isArray(m.content)) continue
    const text = m.content.filter((c) => c.type === "text" && c.text).map((c) => c.text).join("\n").trim()
    if (text) return text
  }
  return ""
}

// Tokens and cost of a session, summed over its assistant messages.
export function usage(messages: unknown): { tokens: number; cost: number } {
  if (!Array.isArray(messages)) return { tokens: 0, cost: 0 }
  let tokens = 0
  let cost = 0
  for (const m of messages as { type?: string; tokens?: { input?: number; output?: number }; cost?: number }[]) {
    if (m.type !== "assistant") continue
    tokens += (m.tokens?.input ?? 0) + (m.tokens?.output ?? 0)
    cost += m.cost ?? 0
  }
  return { tokens, cost }
}
