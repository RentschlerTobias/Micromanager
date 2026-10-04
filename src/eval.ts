// The eval harness (design.md §15): replays journaled decisions that have a label against a floor and reports,
// per node and question, how often the model would have decided alone, how often it would have been wrong, and
// how well its confidence matches its accuracy. Floors change only together with a run of this.

import type { Answer } from "./jev.ts"
import { labeled, options, type Labeled } from "./dataset.ts"
import type { Entry } from "./journal.ts"

export interface Report {
  readonly key: string // "node.qid"
  readonly labeled: number
  readonly automatic: number // share decided alone at this floor
  readonly wrong: number // share of the automatic ones that disagree with the label
  readonly ece: number // expected calibration error over 5 bins
}

// The chosen option and its confidence; a noul is decided when it is clearly yes or clearly no.
export function verdict(answer: Answer): { choice: string; confidence: number } {
  if (answer.type === "noul") return answer.noul >= 0.5 ? { choice: "yes", confidence: answer.noul } : { choice: "no", confidence: 1 - answer.noul }
  if (answer.type === "choice") return { choice: answer.choice, confidence: answer.confidence }
  return { choice: String(Math.round(answer.score)), confidence: answer.confidence }
}

function truth(row: Labeled): string | undefined {
  const v = row.label?.value
  if (v === undefined) return undefined
  if (row.question.type === "noul") return v === "yes" || v === 1 ? "yes" : "no"
  if (row.question.type === "score") return String(Math.round(Number(v)))
  return options(row.question).includes(String(v)) ? String(v) : undefined
}

export function evaluate(entries: readonly Entry[], floor: number, backend?: string): Report[] {
  const groups = new Map<string, { confidence: number; correct: boolean }[]>()
  for (const row of labeled(entries)) {
    if (!row.answer || (backend && row.entry.backend !== backend)) continue
    const t = truth(row)
    if (t === undefined) continue
    const v = verdict(row.answer)
    const key = `${String(row.entry.node)}.${row.qid}`
    groups.set(key, [...(groups.get(key) ?? []), { confidence: v.confidence, correct: v.choice === t }])
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => {
    const auto = rows.filter((r) => r.confidence >= floor)
    const bins = Array.from({ length: 5 }, (_, i) => rows.filter((r) => Math.min(4, Math.floor(r.confidence * 5)) === i))
    const ece = bins.reduce((sum, bin) => {
      if (bin.length === 0) return sum
      const conf = bin.reduce((s, r) => s + r.confidence, 0) / bin.length
      const acc = bin.filter((r) => r.correct).length / bin.length
      return sum + (bin.length / rows.length) * Math.abs(conf - acc)
    }, 0)
    return {
      key,
      labeled: rows.length,
      automatic: auto.length / rows.length,
      wrong: auto.length === 0 ? 0 : auto.filter((r) => !r.correct).length / auto.length,
      ece,
    }
  })
}

export function formatReport(reports: readonly Report[], floor: number): string {
  if (reports.length === 0) return "no labeled decisions in the journal yet"
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(5)
  const lines = reports.map((r) => `${r.key.padEnd(28)} ${String(r.labeled).padStart(5)} ${pct(r.automatic)} ${pct(r.wrong)} ${r.ece.toFixed(3)}`)
  return [`floor ${floor}`, `${"node.question".padEnd(28)} label  auto wrong   ece`, ...lines].join("\n")
}
