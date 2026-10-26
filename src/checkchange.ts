// request_check_change (design.md §25, P3): a writer that finds its check or a frozen test wrong asks for the change
// instead of failing or getting around it. Frozen tests are only fair with such a valve: without it a worker with a
// broken test can only give up or cheat.
//
// The worker never changes the check itself. It names what is wrong, shows evidence and proposes the change; someone
// else decides, by what the change touches:
// - check_bug (a wrong path, a typo, a command that cannot run here): the micromanager, after Jev's prefilter;
// - test_contradicts_spec: a reviewer of another model family checks the claim, then the micromanager decides;
// - spec_incomplete (the spec did not think of the case) and contract (the fitness contract): always the user, because
//   that changes what is wanted, not only how it is checked.
// The plugin applies an accepted change from outside, freezes the test again, and in a trial gives it to every
// attempt, so they are all measured by the same rule. A task may ask twice; a refused target is final.

import { formInput } from "./forms.ts"

export type ChangeKind = "check_bug" | "test_contradicts_spec" | "spec_incomplete" | "contract"
export const CHANGE_KINDS: readonly ChangeKind[] = ["check_bug", "test_contradicts_spec", "spec_incomplete", "contract"]
export type Decider = "micromanager" | "reviewer" | "user"

export const MAX_CHANGES = 2 // requests per task
export const CHANGE_TIMEOUT_MS = 20 * 60_000 // a reviewer may have to read first

export interface ChangeRequest {
  readonly kind: ChangeKind
  readonly target: string // the check command, or the frozen file's path
  readonly problem: string
  readonly evidence: string // the output, or the line of the spec, that shows it
  readonly proposal: string // the new command, a unified diff of the file, or for a contract its JSON
  readonly sessionID: string
  readonly parent: string // the micromanager session
  readonly task: string // "T3 title", for the notes
  readonly taskId: string
  readonly project: string
  readonly jobId: string
}

export interface PendingChange extends ChangeRequest {
  readonly id: string // "K1"
  readonly at: number
}

export interface ChangeAnswer {
  readonly accepted: boolean
  readonly by: "micromanager" | "user" | "jev" | "timeout"
  readonly note?: string
}

// Who decides a kind of change.
export function route(kind: ChangeKind): Decider {
  if (kind === "check_bug") return "micromanager"
  if (kind === "test_contradicts_spec") return "reviewer"
  return "user"
}

// A target as it is compared: a refusal holds for the target, not for the wording of the request.
export function normalTarget(target: string): string {
  return target.trim().replace(/^\.\//, "").replace(/\s+/g, " ").toLowerCase()
}

// Why a request is not taken; undefined when it is. asked: the task's requests so far; refused: the job's refused
// targets.
export function validateRequest(r: Pick<ChangeRequest, "kind" | "target" | "problem" | "evidence" | "proposal">, asked: number, refused: readonly string[]): string | undefined {
  if (!CHANGE_KINDS.includes(r.kind)) return `kind is one of ${CHANGE_KINDS.join(", ")}.`
  if (!r.target.trim()) return "target: the check command, or the path of the frozen file, that is wrong."
  if (!r.problem.trim()) return "problem: what is wrong with it, in a sentence."
  // "The test is too hard" is no evidence: a contradiction has to be shown, with the output or the spec line.
  if (r.evidence.trim().length < 20) return "evidence: quote the output or the line of the spec that shows the check is wrong; a request without it is not taken."
  if (!r.proposal.trim()) return "proposal: the new command, or a unified diff of the file (for a contract, its JSON)."
  if (refused.includes(normalTarget(r.target))) return `a change to ${r.target.trim()} was refused for this job already; it stays as it is. Do not ask again in other words: make the work pass it, or report what you could not do.`
  if (asked >= MAX_CHANGES) return `this task asked for ${MAX_CHANGES} changes already, which is the limit. Make the work pass the checks as they are, or report what you could not do.`
  return undefined
}

interface Waiting extends PendingChange {
  readonly answer: Promise<ChangeAnswer>
  readonly settle: (answer: ChangeAnswer) => void
  timer?: ReturnType<typeof setTimeout>
}

// The requests that wait for a decision, shared by every plugin instance of a server (as GrantRequests is).
export class ChangeRequests {
  readonly #pending = new Map<string, Waiting>()
  readonly #journal: (entry: Record<string, unknown>) => void
  readonly #timeoutMs: number
  #n = 0

  constructor(journal: (entry: Record<string, unknown>) => void = () => {}, timeoutMs = CHANGE_TIMEOUT_MS) {
    this.#journal = journal
    this.#timeoutMs = timeoutMs
  }

  open(request: ChangeRequest): { pending: PendingChange; answer: Promise<ChangeAnswer> } {
    const id = `K${++this.#n}`
    let settle!: (answer: ChangeAnswer) => void
    const answer = new Promise<ChangeAnswer>((resolve) => (settle = resolve))
    const waiting: Waiting = { ...request, id, at: Date.now(), answer, settle }
    waiting.timer = setTimeout(() => {
      if (!this.#pending.delete(id)) return
      this.#journal({ kind: "check-change", event: "timeout", id, change: request.kind, sessionID: request.sessionID, job: request.jobId })
      settle({ accepted: false, by: "timeout" })
    }, this.#timeoutMs)
    waiting.timer.unref?.()
    this.#pending.set(id, waiting)
    this.#journal({ kind: "check-change", event: "asked", id, change: request.kind, target: request.target.slice(0, 200), problem: request.problem.slice(0, 300), sessionID: request.sessionID, job: request.jobId })
    return { pending: strip(waiting), answer }
  }

  get(id: string): PendingChange | undefined {
    const p = this.#pending.get(id.trim().toUpperCase())
    return p && strip(p)
  }

  // The decision. Returns the request it settled, or undefined when none waits under this id any more.
  answer(id: string, a: ChangeAnswer): PendingChange | undefined {
    const p = this.#pending.get(id.trim().toUpperCase())
    if (!p) return undefined
    this.#pending.delete(p.id)
    clearTimeout(p.timer)
    this.#journal({ kind: "check-change", event: "answered", id: p.id, change: p.kind, accepted: a.accepted, by: a.by, sessionID: p.sessionID, job: p.jobId, waitedMs: Date.now() - p.at })
    p.settle(a)
    return strip(p)
  }

  // The requests of workers that ended: nobody waits for them any more.
  drop(sessionIDs: readonly string[]): PendingChange[] {
    const dropped = [...this.#pending.values()].filter((p) => sessionIDs.includes(p.sessionID))
    for (const p of dropped) this.answer(p.id, { accepted: false, by: "timeout" })
    return dropped.map(strip)
  }
}

function strip(p: Waiting): PendingChange {
  const { settle: _s, timer: _t, answer: _a, ...shown } = p
  return shown
}

const CHANGE = { accept: "Accept the change", refuse: "Refuse" } as const

// The form for a change only the user decides.
export function changeForm(p: PendingChange): { header: string; question: string; options: { label: string; description: string }[] }[] {
  return [{
    header: `Change ${p.id}`,
    question: `Worker ${p.task} asks to change ${p.target.slice(0, 200)} (${p.kind === "contract" ? "the fitness contract" : "the spec did not cover this"}). Problem: ${p.problem.slice(0, 300)} Evidence: ${p.evidence.slice(0, 400)} Proposed: ${p.proposal.slice(0, 400)}`,
    options: [
      { label: CHANGE.accept, description: "The plugin applies it, freezes it again, and every attempt of the task works against it" },
      { label: CHANGE.refuse, description: "It stays as it is; the worker may not ask for it again" },
    ],
  }]
}

// The user's answer to a change form: accepted, refused, or undefined for typed text, which is no answer.
export function readChange(header: string, answers: readonly string[]): { id: string; accepted?: boolean; said?: string } | undefined {
  const m = header.match(/^Change (K\d+)$/)
  if (!m) return undefined
  const is = (a: string, label: string) => a.trim().toLowerCase().replace(/\s*\(recommended\)\s*$/, "") === label.toLowerCase()
  if (answers.some((a) => is(a, CHANGE.accept))) return { id: m[1]!, accepted: true }
  if (answers.some((a) => is(a, CHANGE.refuse))) return { id: m[1]!, accepted: false }
  const said = answers.find((a) => a.trim())
  return { id: m[1]!, ...(said ? { said: said.trim() } : {}) }
}

// The note that wakes the micromanager with a request, by who decides it.
export function changeNote(p: PendingChange, by: Decider, workerModel?: string): string {
  const what = `[micromanager] ${p.id}: worker ${p.task} asks to change ${p.target.slice(0, 200)} (${p.kind}).\nProblem: ${p.problem.slice(0, 500)}\nEvidence: ${p.evidence.slice(0, 1200)}\nProposed: ${p.proposal.slice(0, 1500)}\nThe worker waits for the decision.`
  if (by === "user") {
    return `${what}\nOnly the user decides this: it changes what is wanted, not only how it is checked. Ask them with the question tool, with exactly this input (a form; its answer reaches the plugin by itself), then end your turn:\n${formInput(changeForm(p))}`
  }
  if (by === "reviewer") {
    return `${what}\nThe worker claims the test contradicts the spec. Before you decide, start a reviewer with the subagent tool (agent reviewer${workerModel ? `; it runs on another model family than the worker's ${workerModel}` : ""}) and ask it whether the evidence holds: give it the problem, the evidence and the proposal above, and the spec or task text. Then decide with decide_change ({ id: "${p.id}", decision: "accept" | "refuse", note: why, in one sentence }). Accept only when the reviewer confirms a real contradiction; "too hard" is no reason.`
  }
  return `${what}\nDecide it with decide_change ({ id: "${p.id}", decision: "accept" | "refuse", note: why, in one sentence }). Accept a check that is wrong in itself (a path that does not exist, a typo, a command that cannot run here); refuse one that only fails because the work is not done. A refused target stays as it is for this job.`
}

// What the worker reads once its request is decided.
export function changeResult(p: Pick<PendingChange, "id" | "target">, a: ChangeAnswer, applied?: string): string {
  if (a.accepted) return `${p.id} is accepted${a.note ? ` (${a.note})` : ""}: ${applied ?? "the change is applied"}. Run the checks again and call finish_task when they pass.`
  return a.by === "timeout"
    ? `${p.id} was not decided in time, so ${p.target.slice(0, 200)} stays as it is. Make the work pass it, or say plainly in your report what you could not do.`
    : `${p.id} is refused${a.note ? ` (${a.note})` : ""}: ${p.target.slice(0, 200)} stays as it is for this job. Do not ask again in other words; make the work pass it, or say plainly in your report what you could not do.`
}
