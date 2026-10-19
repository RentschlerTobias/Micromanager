// Project memory (the user's decision, 2026-10-05): what workers learn about a project lasts beyond the job. The
// store is a block in opencode-agent-memory's format (Markdown with YAML frontmatter in .opencode/memory/), so with
// that plugin installed the micromanager sees it and can tend it; workers never write it themselves.
//
// Jev decides the two points that plugin leaves to the LLM:
// - saving: a worker's LEARNED line is kept when Jev calls it lasting for this project and not known yet;
// - recalling: in the one N5 request per task, Jev picks the entries that help this task, and only those go into the
//   brief.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { Question } from "./jev.ts"

export const BLOCK = "jev-project"
const LIMIT = 6000 // characters of the block's body; the oldest entries go first
export const RECALL_MAX = 20 // entries offered to N5 per task
export const RECALL_PICK = 3 // entries a brief carries at most

export function memoryPath(project: string): string {
  return join(project, ".opencode", "memory", `${BLOCK}.md`)
}

export function readMemory(project: string): string[] {
  const path = memoryPath(project)
  if (!existsSync(path)) return []
  const text = readFileSync(path, "utf8")
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "")
  return body.split("\n").map((l) => l.match(/^- (.+)$/)?.[1]?.trim()).filter((l): l is string => Boolean(l))
}

export function writeMemory(project: string, entries: readonly string[]): void {
  const kept = [...entries]
  while (kept.join("\n").length > LIMIT && kept.length > 1) kept.shift()
  mkdirSync(join(project, ".opencode", "memory"), { recursive: true })
  writeFileSync(memoryPath(project), `---
label: ${BLOCK}
description: Lasting facts about this project that micromanager's workers learned (commands, layout, conventions, pitfalls). Kept by micromanager; one fact per line.
limit: ${LIMIT}
read_only: false
---
${kept.map((e) => `- ${e}`).join("\n")}
`)
}

// N15: per learned item, three independent questions against the project's current memory: lasting (true beyond
// this task), useful (knowing it saves a later worker time or a mistake: the relevance the user asked for), known.
export function learnQuestions(items: readonly string[]): Record<string, Question> {
  const out: Record<string, Question> = {}
  items.forEach((item, i) => {
    out[`lasting.${i}`] = { type: "noul", instructions: `"${item}" is a lasting fact about this project (a command, a path, a convention, a pitfall) that later, different tasks will need, not a detail of one task.` }
    out[`useful.${i}`] = { type: "noul", instructions: `Knowing "${item}" would save a later worker on this project real time or a mistake; it is not obvious from a quick look at the code.` }
    out[`known.${i}`] = { type: "noul", instructions: `"${item}" is already said, in other words, by one of the entries in the project's memory.` }
  })
  return out
}

// In N5's request: one noul per memory entry.
export function recallQuestions(entries: readonly string[]): Record<string, Question> {
  return Object.fromEntries(entries.slice(-RECALL_MAX).map((e, i) => [`memory.${i}`, { type: "noul", instructions: `Knowing "${e}" helps a worker do this task.` } satisfies Question]))
}

// The entries N5 picked: at most RECALL_PICK, the most certain first.
export function recalled(entries: readonly string[], answers: Readonly<Record<string, { type: string; noul?: number }>>, floor: number): string[] {
  const offered = entries.slice(-RECALL_MAX)
  return offered
    .map((e, i) => ({ e, p: answers[`memory.${i}`]?.type === "noul" ? answers[`memory.${i}`]!.noul ?? 0 : 0 }))
    .filter((x) => x.p >= floor)
    .sort((a, b) => b.p - a.p)
    .slice(0, RECALL_PICK)
    .map((x) => x.e)
}
