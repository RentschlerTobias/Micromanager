// N6: which loops a task passes (design.md §9). Rules over the N5 answers pick the pipeline, as §8.1 says
// ("pipeline = rules over the answers"); the user can pin one with "pipeline P2". The stages themselves are run by
// the runner; this file holds the choice and the pure parts: review and research prompts, their parsers, and the
// citation check.

import { CAVEMAN, sharedNote } from "./brief.ts"
import { CHOICE_FLOOR, type Risk } from "./catalog.ts"
import { HEADER } from "./hooks.ts"
import { resolvePolicy, type Policies } from "./policy.ts"
import { WRITERS, type Profile } from "./profile.ts"
import type { Acceptance, FollowUp, Job, Task } from "./state.ts"

export type PipelineId = "P1" | "P2" | "P3" | "P9"
export type Modifier = "user_confirm" | "oracle"

export interface Pipeline {
  readonly id: PipelineId
  readonly reason: string
  readonly modifiers: readonly Modifier[]
}

export const PIPELINES: Record<PipelineId, string> = {
  P1: "implement -> gate, fix at most twice",
  P2: "implement -> gate -> review by another model family, at most 3 review rounds",
  P3: "tests first (red, then frozen) -> implement (green) -> gate -> review",
  P9: "research: parallel readers -> synthesis -> citation check",
}

const RISK_RANK: Record<Risk, number> = { cosmetic: 0, internal: 1, public_api: 2, data_security: 3, destructive: 4 }

export const riskAtLeast = (risk: Risk, floor: Risk): boolean => RISK_RANK[risk] >= RISK_RANK[floor]

export function choosePipeline(task: Task, profile: Profile, policies: Policies): Pipeline {
  const modifiers: Modifier[] = []
  if (profile.risk === "destructive") modifiers.push("user_confirm")
  if (riskAtLeast(profile.risk, "data_security")) modifiers.push("oracle")
  const writer = WRITERS.has(profile.role) && task.files.length > 0
  const pin = resolvePolicy("N6.pipeline", policies).policy
  if (pin.kind === "fixed" && pin.value in PIPELINES) {
    const id = pin.value as PipelineId
    // A pin cannot make a reader write or a writer skip its gate into research.
    if ((id === "P9") === (profile.role === "research") && (id !== "P3" || writer)) return { id, reason: "preset", modifiers }
  }
  if (profile.role === "research" && !writer) return { id: "P9", reason: "read-only research", modifiers }
  if (!writer) return { id: "P1", reason: "a reader: one session, checks if any", modifiers }
  let id: PipelineId
  let reason: string
  if (profile.testFirst && (profile.bugFix || riskAtLeast(profile.risk, "public_api"))) [id, reason] = ["P3", `test first: ${profile.bugFix ? "a bug fix" : `risk ${profile.risk}`}`]
  else if (riskAtLeast(profile.risk, "public_api")) [id, reason] = ["P2", `risk ${profile.risk}`]
  else if (!profile.testOracle) [id, reason] = ["P2", "no test oracle"]
  else [id, reason] = ["P1", "small and clear, with a test oracle"]
  // Low confidence on the classification: one tier up.
  if (id === "P1" && profile.confidence < CHOICE_FLOOR) [id, reason] = ["P2", `low confidence (${profile.confidence.toFixed(2)})`]
  return { id, reason, modifiers }
}

// --- review (P2, P3) ---------------------------------------------------------------------------------------

export interface ReviewCheck {
  readonly point: string
  readonly met: boolean
  readonly evidence: string
  readonly confidence: number // 0..100; under BLOCKING_CONFIDENCE a finding is advisory (design.md §9)
}

export type ReviewAxis = "spec" | "standards"

export interface Review {
  readonly verdict?: "PASS" | "FAIL"
  readonly checks: readonly ReviewCheck[]
  readonly fixes: readonly string[]
  readonly blocking: readonly ReviewCheck[] // unmet points with evidence and confidence; the rest is advisory
  readonly outside: readonly FollowUp[] // work the reviewer saw the job needs outside this task (N7 candidates)
  readonly error?: string
}

export const BLOCKING_CONFIDENCE = 80

const OUTSIDE_FORMAT = `"outside": [{"what": "work the job needs that is not this task's", "why": "...", "files": ["..."]}]`

const MAX_DIFF = 12000

export function reviewPrompt(job: Job, task: Task, acceptance: readonly Acceptance[], diff: string): string {
  const shown = diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… (cut; read the files for the rest)` : diff
  return `${HEADER} review of task ${task.id}

The job: ${job.goal}
The task (${task.id}): ${task.title}
${task.description}

Acceptance points:
${acceptance.map((a) => `- ${a.id}: ${a.text}${a.verify ? ` (checked with: ${a.verify})` : ""}${sharedNote(job, task, a.id)}`).join("\n") || "- none given"}

The change (the plugin already ran the checks; they pass):
\`\`\`diff
${shown || "(no diff)"}
\`\`\`

Check the change against each acceptance point and the task. A point shared with other tasks counts as met when
this task's part of it is done; what belongs to the others is not this task's finding. Read the changed files if
you need more; stay in this directory. Report a point as not met only with evidence: a file and line, a failing command, or a concrete input that breaks it.
Answer only with JSON: {"verdict": "PASS" | "FAIL", "checks": [{"point": "A1", "met": true, "evidence": "...", "confidence": 0-100}],
"fixes": ["what to change, one per entry"], ${OUTSIDE_FORMAT}}`
}

// The second axis (design.md §9: standards ∥ spec): not whether the task is done, but whether it is done well in this
// repository. Another reviewer, in parallel, so neither axis crowds out the other.
export function standardsPrompt(job: Job, task: Task, diff: string): string {
  const shown = diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… (cut; read the files for the rest)` : diff
  return `${HEADER} standards review of task ${task.id}

The job: ${job.goal}
The task (${task.id}): ${task.title}

The change (the checks pass; another reviewer checks the acceptance points):
\`\`\`diff
${shown || "(no diff)"}
\`\`\`

Review the change against this repository's own standards, not your taste. Read neighbouring code first, then check:
- it follows the conventions around it: naming, structure, error handling, comment style;
- tests test behaviour through the public interface, not implementation details, and would fail if the code broke;
- inputs at the edges: empty, very large, non-ASCII text (umlauts, ß, emoji), missing files, concurrent calls;
- no dead code, debug output, commented-out code or needless new dependencies;
- nothing silently swallows an error, and nothing leaks a secret.
Only findings in this change count. Give each a confidence 0-100 that it is a real problem; below 80 it is a note.
Every finding needs evidence: a file and line, a command and its output, or a concrete input that breaks it.
Answer only with JSON: {"verdict": "PASS" | "FAIL", "checks": [{"point": "short name of the issue", "met": false, "evidence": "...", "confidence": 0-100}],
"fixes": ["what to change, one per entry"], ${OUTSIDE_FORMAT}}`
}

// A spec finding without a confidence keeps the old meaning (evidence decides); a standards finding must give one.
export function parseReview(text: string, defaultConfidence = 100): Review {
  const json = text.match(/```(?:json)?\s*\n([\s\S]*?)```/)?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)
  let raw: { verdict?: unknown; checks?: unknown; fixes?: unknown; outside?: unknown }
  try {
    raw = JSON.parse(json)
  } catch {
    return { checks: [], fixes: [], blocking: [], outside: [], error: "the review is not JSON" }
  }
  const checks: ReviewCheck[] = (Array.isArray(raw.checks) ? raw.checks : [])
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object")
    .map((c) => ({
      point: String(c.point ?? ""),
      met: c.met !== false,
      evidence: typeof c.evidence === "string" ? c.evidence.trim() : "",
      confidence: typeof c.confidence === "number" ? Math.max(0, Math.min(100, c.confidence <= 1 ? c.confidence * 100 : c.confidence)) : defaultConfidence,
    }))
  const fixes = Array.isArray(raw.fixes) ? raw.fixes.filter((f): f is string => typeof f === "string" && f.trim() !== "") : []
  const verdict = raw.verdict === "PASS" || raw.verdict === "FAIL" ? raw.verdict : undefined
  const outside = (Array.isArray(raw.outside) ? raw.outside : [])
    .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === "object" && typeof (o as { what?: unknown }).what === "string")
    .map((o): FollowUp => ({ what: String(o.what), why: typeof o.why === "string" ? o.why : "", files: Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === "string") : [] }))
  return { verdict, checks, fixes, outside, blocking: checks.filter((c) => !c.met && c.evidence.length > 0 && c.confidence >= BLOCKING_CONFIDENCE) }
}

// Both axes as one result: what blocks on either blocks, findings keep their axis in the point name.
export function mergeReviews(spec: Review, standards: Review): Review {
  const tag = (r: Review, axis: ReviewAxis) => (c: ReviewCheck) => ({ ...c, point: axis === "spec" ? c.point : `standards: ${c.point}` })
  const error = spec.error && standards.error ? `${spec.error}; ${standards.error}` : undefined
  return {
    verdict: spec.verdict === "FAIL" || standards.verdict === "FAIL" ? "FAIL" : spec.verdict ?? standards.verdict,
    checks: [...spec.checks.map(tag(spec, "spec")), ...standards.checks.map(tag(standards, "standards"))],
    fixes: [...spec.fixes, ...standards.fixes],
    blocking: [...spec.blocking.map(tag(spec, "spec")), ...standards.blocking.map(tag(standards, "standards"))],
    outside: [...spec.outside, ...standards.outside],
    ...(error ? { error } : {}),
  }
}

export function reviewFixPrompt(review: Review): string {
  const points = review.blocking.map((c) => `- ${c.point}: ${c.evidence}`).join("\n")
  const fixes = review.fixes.length ? `\nSuggested fixes:\n${review.fixes.map((f) => `- ${f}`).join("\n")}` : ""
  return `${HEADER} Reviewers of another model family found problems (acceptance points not met, or "standards:" findings about how it is done):\n${points}${fixes}\n\nFix them in your task's files, then report again in the same format.`
}

// --- tests first (P3) --------------------------------------------------------------------------------------

export const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$/

export function redPrompt(task: Task, testFiles: readonly string[]): string {
  return `${HEADER} tests first for task ${task.id}

Before anything is implemented, write the tests for this task's acceptance points, and nothing else.
${testFiles.length ? `Write them in: ${testFiles.join(", ")}.` : "Put them in new test files next to the code, named like the project's existing tests."}
The tests must fail now, because the behaviour does not exist yet, and pass once it is built as described.
Do not write the implementation. Run the tests once and show that they fail for the right reason.`
}

export function greenNote(frozen: readonly string[]): string {
  return `Tests for this task already exist and are frozen: ${frozen.join(", ")}. Make them pass without changing them.`
}

// --- research (P9) -----------------------------------------------------------------------------------------

const ANGLES = [
  "the official documentation and specifications",
  "source code and repositories",
  "issue trackers, changelogs and discussions",
  "papers, benchmarks and long-form articles",
  "alternatives and how others solved it",
]

// 1 reader for an easy question, 3 for a moderate one, 5 for a hard one (design.md §13.3: 1 / 2–4 / 5+).
export function readerCount(difficulty: number): number {
  return difficulty < 0.34 ? 1 : difficulty < 0.67 ? 3 : 5
}

export function readerPrompt(job: Job, task: Task, i: number, n: number): string {
  const angle = n > 1 ? `\nYou are reader ${i + 1} of ${n}. Look mainly at ${ANGLES[i % ANGLES.length]}; the others cover the rest.` : ""
  return `${HEADER} research for task ${task.id}

The job: ${job.goal}
The question (${task.id}): ${task.title}
${task.description}${angle}

Use primary sources. For every finding give the URL it comes from. Change no files.
Answer with the findings as a list, each with its URL; then what stayed unclear.
${CAVEMAN}`
}

export function synthesisPrompt(job: Job, task: Task, path: string, notes: readonly string[]): string {
  return `${HEADER} synthesis for task ${task.id}

The job: ${job.goal}
The question (${task.id}): ${task.title}
${task.description}

Readers found the following:
${notes.map((n, i) => `--- reader ${i + 1} ---\n${n}`).join("\n\n")}

Write ${path} in clear English prose: the answer first, then the evidence. Cite every claim with the URL from the
readers' notes, inline as a Markdown link. Use only URLs the readers gave; leave out what no reader sourced.
Change no other file.`
}

const URL = /https?:\/\/[^\s)<>\]"'`]+/g

const clean = (u: string) => u.replace(/[.,;:!?]+$/, "")

// Every URL in the synthesis must come from a reader; a synthesis without any URL cites nothing.
export function citationCheck(doc: string, notes: readonly string[]): { ok: boolean; unknown: string[]; cited: number } {
  const known = new Set(notes.flatMap((n) => (n.match(URL) ?? []).map(clean)))
  const cited = [...new Set((doc.match(URL) ?? []).map(clean))]
  const unknown = cited.filter((u) => !known.has(u))
  return { ok: cited.length > 0 && unknown.length === 0, unknown, cited: cited.length }
}

export function researchPath(task: Task): string {
  const slug = task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || task.id.toLowerCase()
  return `docs/research/${slug}.md`
}
