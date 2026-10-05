// Training rows from the journal (design.md §15, §20): Open-Jev JSONL for a local Jev, GLiNER2 JSO lines for the
// decision server's fine-tune.
//
// A row's target is, in this order: a label the user gave or an outcome (one-hot, the strongest), else the cloud
// Jev's own probabilities (a soft distillation target). Answers of GLiNER or the rules are never targets.

import { createHash } from "node:crypto"

import type { Answer, Question } from "./jev.ts"
import type { Entry } from "./journal.ts"

export interface Labeled {
  readonly entry: Entry // the decision
  readonly qid: string
  readonly question: Question
  readonly answer?: Answer
  readonly label?: { readonly value: string | number; readonly source: string }
}

// Joins every decision question with its newest label.
export function labeled(entries: readonly Entry[]): Labeled[] {
  const labels = new Map<string, { value: string | number; source: string }>()
  for (const e of entries) {
    if (e.kind === "label" && typeof e.decision === "string" && typeof e.question === "string") {
      labels.set(`${e.decision}/${e.question}`, { value: e.value as string | number, source: String(e.source) })
    }
  }
  const out: Labeled[] = []
  for (const e of entries) {
    if (e.kind !== "decision" || typeof e.id !== "string") continue
    const questions = (e.questions ?? {}) as Record<string, Question>
    const answers = (e.answers ?? {}) as Record<string, Answer>
    for (const [qid, question] of Object.entries(questions)) {
      out.push({ entry: e, qid, question, answer: answers[qid], label: labels.get(`${e.id}/${qid}`) })
    }
  }
  return out
}

export function options(q: Question): string[] {
  if (q.type === "choice") return Object.keys(q.criteria)
  if (q.type === "noul") return ["no", "yes"]
  return [...q.criteria]
}

// The target distribution over options(), or undefined when nothing may serve as a target.
export function target(row: Labeled): { probs: number[]; source: string } | undefined {
  const opts = options(row.question)
  if (row.label) {
    const v = row.label.value
    const index = row.question.type === "noul"
      ? (v === "yes" || v === 1 ? 1 : 0)
      : row.question.type === "score" && typeof v === "number" ? Math.round(v) : opts.indexOf(String(v))
    if (index < 0 || index >= opts.length) return undefined
    return { probs: opts.map((_, i) => (i === index ? 1 : 0)), source: row.label.source }
  }
  if (row.entry.backend !== "typesafe" || !row.answer) return undefined
  const a = row.answer
  if (a.type === "noul") return { probs: [1 - a.noul, a.noul], source: "jev" }
  const p = opts.map((o, i) => a.probabilities[o] ?? a.probabilities[String(i)] ?? 0)
  const sum = p.reduce((x, y) => x + y, 0)
  if (sum <= 0) return undefined
  return { probs: p.map((x) => x / sum), source: "jev" }
}

// 80 / 5 / 5 / 10 by a hash of the group, so one job or task never spans two splits.
export function splitOf(group: string): "train" | "calibration" | "validation" | "test" {
  const n = parseInt(createHash("sha256").update(group).digest("hex").slice(0, 8), 16) % 100
  return n < 80 ? "train" : n < 85 ? "calibration" : n < 90 ? "validation" : "test"
}

const groupOf = (e: Entry) => String(e.task ?? e.job ?? e.id)

export function openJevRows(entries: readonly Entry[]): Record<string, unknown>[] {
  return labeled(entries).flatMap((row) => {
    const t = target(row)
    if (!t) return []
    const group = groupOf(row.entry)
    return [{
      id: `${row.entry.id}/${row.qid}`,
      group_id: group,
      split: splitOf(group),
      source: "jev-micromanager",
      state: row.entry.state,
      question: row.question.instructions,
      kind: row.question.type,
      options: options(row.question),
      target: t.probs,
      metadata: {
        node: row.entry.node,
        qid: row.qid,
        backend: row.entry.backend,
        label_source: t.source,
        time: row.entry.time,
        ...(row.question.type === "choice" ? { option_meanings: row.question.criteria } : {}),
        ...(row.question.type === "score" ? { score_values: options(row.question).map((_, i) => i) } : {}),
      },
    }]
  })
}

// The text the decision server builds from a state object: the task text first, so a short GLiNER window keeps
// it. decider/decider/server.py renders the same way.
const FIRST = ["text", "utterance", "task", "question"]
export function renderState(state: unknown): string {
  if (typeof state === "string") return state
  if (!state || typeof state !== "object") return String(state)
  const entries = Object.entries(state as Record<string, unknown>)
  entries.sort(([a], [b]) => {
    const ia = FIRST.indexOf(a), ib = FIRST.indexOf(b)
    return (ia < 0 ? FIRST.length : ia) - (ib < 0 ? FIRST.length : ib)
  })
  return entries.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n")
}

const YES_NO = { yes: "Yes, the statement is true for this text.", no: "No, the statement is false for this text." }
const safe = (s: string) => s.replace(/\(/g, ", ").replace(/[)[\]]/g, "")

// GLiNER2 JSO lines (oc-voice training/tasks.py): hard labels only, the argmax of the target.
export function glinerRows(entries: readonly Entry[]): Record<string, unknown>[] {
  return labeled(entries).flatMap((row) => {
    const t = target(row)
    if (!t || row.question.type === "score") return []
    const labels = row.question.type === "choice" ? row.question.criteria : YES_NO
    const names = options(row.question)
    const trueLabel = names[t.probs.indexOf(Math.max(...t.probs))]
    const described = Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, safe(v)]))
    return [{
      input: renderState(row.entry.state),
      output: { classifications: [{ task: row.qid, labels: described, true_label: trueLabel, prompt: safe(row.question.instructions), label_descriptions: described }] },
    }]
  })
}
