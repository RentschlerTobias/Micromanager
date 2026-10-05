// The guard bench (design.md §21): every case of bench/guard_cases.json through the G0 backend, then recall and
// false-positive rate per guard at a range of floors. A floor for a backend is set from this, never guessed.

import { readFileSync } from "node:fs"

import type { Decider } from "./backends.ts"
import { GUARDS } from "./catalog.ts"

export interface Case {
  readonly text: string
  readonly yes: readonly string[]
}

export interface GuardScore {
  readonly guard: string
  readonly floor: number
  readonly recall: number // share of positives at or above the floor
  readonly fpr: number // share of negatives at or above the floor
  readonly positives: number
}

export function loadCases(path: string): Case[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { cases: Case[] }).cases
}

export async function scoreCases(decider: Decider, cases: readonly Case[]): Promise<{ text: string; yes: readonly string[]; p: Record<string, number> }[]> {
  const out = []
  for (const c of cases) {
    const asked = await decider.ask("G0", { text: c.text }, GUARDS, { localOnly: true })
    const p: Record<string, number> = {}
    for (const g of Object.keys(GUARDS)) {
      const a = asked.decision.answers[g]
      if (a?.type === "noul") p[g] = a.noul
    }
    out.push({ text: c.text, yes: c.yes, p })
  }
  return out
}

export function sweep(rows: readonly { yes: readonly string[]; p: Record<string, number> }[], floors = [0.3, 0.5, 0.7, 0.9]): GuardScore[] {
  return Object.keys(GUARDS).flatMap((guard) => {
    const scored = rows.filter((r) => r.p[guard] !== undefined)
    if (scored.length === 0) return [] // no answers for this guard: nothing to report, not 0 %
    const pos = scored.filter((r) => r.yes.includes(guard))
    const neg = scored.filter((r) => !r.yes.includes(guard))
    return floors.map((floor) => ({
      guard,
      floor,
      positives: pos.length,
      recall: pos.length ? pos.filter((r) => r.p[guard]! >= floor).length / pos.length : 0,
      fpr: neg.length ? neg.filter((r) => r.p[guard]! >= floor).length / neg.length : 0,
    }))
  })
}

export function formatSweep(scores: readonly GuardScore[]): string {
  if (scores.length === 0) return "no answers from the G0 backend: is the decision server running and fast enough?"
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(5)
  return ["guard           floor  recall   fpr", ...scores.map((s) => `${s.guard.padEnd(15)} ${s.floor.toFixed(1).padStart(5)} ${pct(s.recall)} ${pct(s.fpr)}`)].join("\n")
}

// Repeat-run check (Phase D: one goal scored 0.59, then 2e-8): the same cases scored twice, and per guard the largest
// change between the runs and how many cases crossed the floor.
export function drift(a: readonly { p: Record<string, number> }[], b: readonly { p: Record<string, number> }[], floor = 0.5): { guard: string; maxDelta: number; flips: number }[] {
  return Object.keys(GUARDS).flatMap((guard) => {
    const pairs = a.map((r, i) => [r.p[guard], b[i]?.p[guard]] as const).filter((x): x is readonly [number, number] => x[0] !== undefined && x[1] !== undefined)
    if (pairs.length === 0) return []
    return [{ guard, maxDelta: Math.max(...pairs.map(([x, y]) => Math.abs(x - y))), flips: pairs.filter(([x, y]) => (x >= floor) !== (y >= floor)).length }]
  })
}

export function formatDrift(rows: readonly { guard: string; maxDelta: number; flips: number }[]): string {
  return ["guard           max change  floor flips", ...rows.map((r) => `${r.guard.padEnd(15)} ${r.maxDelta.toFixed(3).padStart(10)} ${String(r.flips).padStart(12)}`)].join("\n")
}
