// A trial the user decides (src/trials.ts pick "user"; the user, 2026-10-27: design drafts are a matter of taste). Once
// every attempt has ended, those that passed are put side by side on a comparison page, and the micromanager asks the
// user with a form: one of the attempts, a combination ("the layout of T2 with the colours of T3"), or none of them.
// The answer is read from the form's result, which only the user fills in; the micromanager cannot pick for them.

import { formInput, type Question } from "./forms.ts"
import { HEADER } from "./hooks.ts"

// One passed attempt as the comparison shows it.
export interface Candidate {
  readonly id: string
  readonly model?: string
  readonly cost?: number
  readonly lines: { readonly added: number; readonly removed: number }
  readonly files: readonly string[]
  readonly summary?: string // the worker's own words at finish_task
  readonly preview?: { readonly path: string; readonly png?: Buffer; readonly problem?: string }
}

const COMBINE = "Combine"
const NONE = "None of them"
const NOTHING = "Nothing to add"

export const pickHeader = (head: string) => `Pick ${head}`
const notesHeader = (head: string) => `Pick ${head} notes`

const money = (n: number | undefined) => (n === undefined ? "cost unknown" : `$${n.toFixed(3)}`)

// The form: which attempt, and the user's words for a combination or for none.
export function pickForm(head: string, title: string, candidates: readonly Candidate[], page: string): Question[] {
  return [
    {
      header: pickHeader(head),
      question: `Which version of "${title.slice(0, 120)}" do you want? The comparison with pictures is in ${page}.`,
      options: [
        ...candidates.map((c) => ({ label: c.id, description: `${c.model ?? "?"} · ${money(c.cost)} · +${c.lines.added}/-${c.lines.removed} lines` })),
        { label: COMBINE, description: "Take parts of several; say which in the next question" },
        { label: NONE, description: "None fits; say why in the next question, and the task is tried again" },
      ],
    },
    {
      header: notesHeader(head),
      question: `For ${COMBINE} or ${NONE}: what should change? Name the versions you mean (e.g. "layout of T2, colours of T3").`,
      options: [{ label: NOTHING, description: "I picked one version above" }],
    },
  ]
}

export type PickAnswer =
  | { readonly kind: "attempt"; readonly id: string; readonly notes?: string }
  | { readonly kind: "combine"; readonly notes?: string }
  | { readonly kind: "none"; readonly notes?: string }
  | { readonly kind: "unclear"; readonly said?: string }

// The answer to a pick form, or undefined when the form is none. head: the trial's first attempt, from the header.
export function readPick(questions: readonly Partial<Question>[], answers: readonly (readonly string[])[]): { head: string; answer: PickAnswer } | undefined {
  const at = questions.findIndex((q) => /^Pick T\d+(?:\.\w+)*$/.test(q.header ?? ""))
  if (at < 0) return undefined
  const head = questions[at]!.header!.slice(5)
  const labels = new Set((questions[at]!.options ?? []).map((o) => o.label))
  const chosen = (answers[at] ?? []).map((a) => a.trim())
  const n = questions.findIndex((q) => q.header === notesHeader(head))
  const typed = (n >= 0 ? answers[n] ?? [] : []).map((a) => a.trim()).filter((a) => a && a !== NOTHING)
  const notes = typed.join(" ") || undefined
  const one = chosen.find((c) => labels.has(c))
  if (!one) return { head, answer: { kind: "unclear", ...(chosen[0] ? { said: chosen[0] } : {}) } }
  if (one === COMBINE) return { head, answer: { kind: "combine", ...(notes ? { notes } : {}) } }
  if (one === NONE) return { head, answer: { kind: "none", ...(notes ? { notes } : {}) } }
  return { head, answer: { kind: "attempt", id: one, ...(notes ? { notes } : {}) } }
}

// What the micromanager reads when every attempt has ended: the form to put to the user.
export function pickNote(head: string, title: string, candidates: readonly Candidate[], page: string): string {
  return [
    `${HEADER} Every attempt at ${head} (${title.slice(0, 120)}) has ended, and ${candidates.length} passed their checks: ${candidates.map((c) => c.id).join(", ")}. The user picks the version to merge.`,
    `Ask them with the question tool, with exactly this input (a form that waits for their answer; it reaches the plugin by itself), then end your turn; tell them the comparison page is ${page}:`,
    formInput(pickForm(head, title, candidates, page)),
    "Do not pick for them, and do not merge anything yourself: nothing that depends on this task starts before they answer.",
  ].join("\n")
}

// The base of a combination: the first attempt the user's words name, else the first candidate.
export function combineBase(notes: string | undefined, ids: readonly string[]): string | undefined {
  const named = (notes ?? "").toUpperCase().match(/\bT\d+(?:\.\w+)*\b/g) ?? []
  return named.find((id) => ids.includes(id)) ?? ids[0]
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

// The comparison page: one column per passed attempt, its picture first. Self-contained, pictures inline.
export function comparisonPage(head: string, title: string, candidates: readonly Candidate[]): string {
  const cards = candidates.map((c) => {
    const pic = c.preview?.png
      ? `<img src="data:image/png;base64,${c.preview.png.toString("base64")}" alt="${esc(c.id)}: ${esc(c.preview.path)}">`
      : `<p class="none">${esc(c.preview?.problem ?? "No picture: the task named no preview.")}</p>`
    return `<section><h2>${esc(c.id)}</h2><p class="meta">${esc(c.model ?? "?")} · ${esc(money(c.cost))} · +${c.lines.added}/-${c.lines.removed} lines · ${c.files.length} file${c.files.length === 1 ? "" : "s"}</p>${pic}${c.summary ? `<p>${esc(c.summary)}</p>` : ""}<details><summary>Files</summary><ul>${c.files.map((f) => `<li><code>${esc(f)}</code></li>`).join("")}</ul></details></section>`
  }).join("\n")
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pick ${esc(head)}</title>
<style>
:root{--bg:#f4f5f7;--card:#fff;--ink:#1b1f24;--muted:#5c6570;--line:#d6dbe1;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--card:#1a1f25;--ink:#e6eaef;--muted:#98a2ad;--line:#2c343d;color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif;padding:20px}
h1{font-size:22px;margin:0 0 4px}.lead{color:var(--muted);margin:0 0 18px}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;align-items:start}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;min-width:0}
h2{margin:0;font-size:18px}.meta{color:var(--muted);font-size:13px;margin:2px 0 10px}
img{width:100%;border:1px solid var(--line);border-radius:6px;display:block}.none{color:var(--muted);font-style:italic}
code{font-size:12px}
</style></head><body><h1>Pick a version of ${esc(head)}</h1><p class="lead">${esc(title)}: every version below passed its checks. Answer in the form in OpenCode.</p><main>
${cards}
</main></body></html>`
}
