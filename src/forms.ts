// Questions to the user as forms (the user, 2026-10-20: a question the micromanager writes as text scrolls away, and a
// job then waits for an answer nobody saw). The micromanager asks with OpenCode's question tool; the form stays in the
// TUI until it is answered, and the answer comes back as the tool's result, which the plugin reads (tool.execute.after).
//
// The plugin cannot open a form itself (its context has no form domain in opencode 2.0.18), so it hands the
// micromanager the exact input to pass, and recognises its forms by their headers. Spike, 2026-10-20: several
// questions go into one form, `multiple: true` makes a question a multi-select, a "Type your own answer" option is
// added by OpenCode, there are no default ticks, and the turn waits until the user submits. The answer arrives as one
// list of labels per question: [["Auto-continue", "Parallel"], ["Start"]].

// One question as the question tool takes it.
export interface Question {
  readonly question: string
  readonly header: string // at most 30 characters
  readonly options: readonly { readonly label: string; readonly description: string }[]
  readonly multiple?: boolean
}

export interface JobOptions {
  readonly auto: boolean // auto-continue: work the todo list without stopping
  readonly parallel: boolean // start every startable todo at once
  readonly review: boolean // a reviewer checks each writer's change before it counts as done
}

export const DEFAULT_OPTIONS: JobOptions = { auto: true, parallel: true, review: false }

const H = { options: "Job options", start: "Start job", access: "Open a path", git: "No git repository" } as const
const OPTION = { auto: "Auto-continue", parallel: "Parallel", review: "Review per task" } as const
const START = { start: "Start", change: "Change the plan", cancel: "Cancel" } as const
const ACCESS = { open: "Open it", closed: "Keep it closed" } as const
const ASK = { once: "Allow once", job: "Allow for this job", refuse: "Refuse" } as const
export const GIT = { init: "Create a git repository", none: "Without isolation", cancel: "Cancel" } as const

// The text the micromanager passes to the question tool, ready to copy.
export const formInput = (questions: readonly Question[]): string => JSON.stringify({ questions })

// The start form: the job's options (ticked last time: said in the description, as a form has no default ticks) and
// the go. It doubles as the plan's approval: nothing that writes starts before "Start".
export function startForm(jobId: string, todos: number, startable: number, last: JobOptions = DEFAULT_OPTIONS): Question[] {
  const was = (on: boolean) => (on ? " (on last time)" : "")
  return [
    {
      header: H.options,
      question: `How should ${jobId} run?`,
      multiple: true,
      options: [
        { label: OPTION.auto, description: `Work the todo list without stopping; pause only for questions to you${was(last.auto)}` },
        { label: OPTION.parallel, description: `Start every task that can start at once, not one after another${was(last.parallel)}` },
        { label: OPTION.review, description: `A reviewer checks each change before it counts as done${was(last.review)}` },
      ],
    },
    {
      header: H.start,
      question: `The plan has ${todos} todo${todos === 1 ? "" : "s"}, ${startable} can start now. Start ${jobId}?`,
      options: [
        { label: `${START.start} (Recommended)`, description: "Start the job with the options ticked above" },
        { label: START.change, description: "Say what to change; the plan comes back to you" },
        { label: START.cancel, description: "Drop the plan" },
      ],
    },
  ]
}

// The question about a path only the user can open (request_access on a refused path).
export function accessForm(path: string, why: string, rule: string): Question[] {
  return [{
    header: H.access,
    question: `A worker needs ${path}, which is refused by default (${rule}). What it needs there: ${why}. Open it for this job?`,
    options: [
      { label: ACCESS.open, description: "The workers of this job may read and write there while this server runs" },
      { label: ACCESS.closed, description: "It stays closed for this job; the question will not come back" },
    ],
  }]
}

// The question about a worker's paused permission request (src/ask.ts).
export function askForm(id: string, task: string, request: string, why: string): Question[] {
  return [{
    header: `Request ${id}`,
    question: `Worker ${task} asks to run ${request}. ${why} Allow it?`,
    options: [
      { label: ASK.once, description: "This one call" },
      { label: ASK.job, description: "This exact request for the rest of the job" },
      { label: ASK.refuse, description: "The worker carries on without it" },
    ],
  }]
}

// The question when the project is no git repository (src/integration.ts): the recommended way first.
export function gitForm(path: string, files: number, size: string, recommend: "init" | "none", excluded: readonly string[]): Question[] {
  const init = { label: `${GIT.init}${recommend === "init" ? " (Recommended)" : ""}`, description: `git init and a first commit${excluded.length ? `; left out: ${excluded.join(", ")}` : ""}` }
  const none = { label: `${GIT.none}${recommend === "none" ? " (Recommended)" : ""}`, description: "Workers change the folder directly, one task after another; checks run, nothing is committed" }
  return [{
    header: H.git,
    question: `${path} is not a git repository (${files} files, ${size}). How should the workers work there?`,
    options: [...(recommend === "init" ? [init, none] : [none, init]), { label: GIT.cancel, description: "Start nothing" }],
  }]
}

// What one answered form of the micromanager means. The answer is matched on the labels the plugin wrote; a label the
// user typed themselves ("Type your own answer") is kept as `said` and never taken for a yes.
export type Answer =
  | { readonly kind: "start"; readonly decision?: "start" | "change" | "cancel"; readonly options: JobOptions; readonly said?: string }
  | { readonly kind: "access"; readonly open?: boolean; readonly question: string; readonly said?: string }
  | { readonly kind: "ask"; readonly id: string; readonly decision?: "once" | "job" | "refuse"; readonly said?: string }
  | { readonly kind: "git"; readonly decision?: "init" | "none" | "cancel"; readonly said?: string }

const is = (answer: string, label: string) => answer.trim().toLowerCase().replace(/\s*\(recommended\)\s*$/, "") === label.toLowerCase()
const pick = <K extends string>(answers: readonly string[], labels: Record<K, string>): { key?: K; said?: string } => {
  for (const a of answers) {
    const key = (Object.keys(labels) as K[]).find((k) => is(a, labels[k]))
    if (key) return { key }
  }
  const said = answers.find((a) => a.trim())
  return said ? { said: said.trim() } : {}
}

export function readForm(questions: readonly Partial<Question>[], answers: readonly (readonly string[])[]): Answer | undefined {
  const at = (header: string) => questions.findIndex((q) => q.header === header)
  const of = (i: number) => (i >= 0 ? answers[i] ?? [] : [])
  if (at(H.start) >= 0) {
    const ticked = of(at(H.options))
    const { key, said } = pick(of(at(H.start)), START)
    const options = { auto: ticked.some((a) => is(a, OPTION.auto)), parallel: ticked.some((a) => is(a, OPTION.parallel)), review: ticked.some((a) => is(a, OPTION.review)) }
    return { kind: "start", options, ...(key ? { decision: key } : {}), ...(said ? { said } : {}) }
  }
  if (at(H.access) >= 0) {
    const { key, said } = pick(of(at(H.access)), ACCESS)
    return { kind: "access", question: questions[at(H.access)]!.question ?? "", ...(key ? { open: key === "open" } : {}), ...(said ? { said } : {}) }
  }
  if (at(H.git) >= 0) {
    const { key, said } = pick(of(at(H.git)), GIT)
    return { kind: "git", ...(key ? { decision: key } : {}), ...(said ? { said } : {}) }
  }
  const ask = questions.findIndex((q) => /^Request A\d+$/.test(q.header ?? ""))
  if (ask >= 0) {
    const { key, said } = pick(of(ask), ASK)
    return { kind: "ask", id: questions[ask]!.header!.split(" ")[1]!, ...(key ? { decision: key } : {}), ...(said ? { said } : {}) }
  }
  return undefined
}

// The answer lists out of the question tool's result: { output: { answers } } or { metadata: { answers } }.
export function answersOf(result: unknown): string[][] | undefined {
  const r = result as { output?: { answers?: unknown }; metadata?: { answers?: unknown } } | undefined
  const a = r?.metadata?.answers ?? r?.output?.answers
  return Array.isArray(a) && a.every((x) => Array.isArray(x)) ? (a as unknown[][]).map((x) => x.map(String)) : undefined
}
