// Decision backends per node (design.md §20): cloud Jev, the local GLiNER decision server, Open-Jev, or rules.
// All speak the Jev wire format, so one client (src/jev.ts) serves them; only URL, model and key differ.
//
// Shadow mode: the primary backend decides, a secondary one answers the same request in parallel and is only
// journaled, so GLiNER can be measured against Jev and retrained on its answers.

import { randomUUID } from "node:crypto"

import { Jev, type Decision, type Question } from "./jev.ts"
import { record } from "./journal.ts"

export type BackendName = "typesafe" | "gliner" | "openjev" | "rules"

export interface Asker {
  ask(state: string, questions: Record<string, Question>): Promise<Decision>
}

export interface BackendConfig {
  readonly default: BackendName
  readonly nodes: Readonly<Record<string, BackendName>> // node -> backend, e.g. { G0: "gliner" }
  readonly shadow?: BackendName // answers in parallel, journaled only
  readonly urls: Readonly<Partial<Record<Exclude<BackendName, "rules">, string>>>
}

// Guards start on GLiNER, everything else on cloud Jev (oc-voice's verdict, Phase A9). G0 never leaves the machine.
export const DEFAULT_BACKENDS: BackendConfig = {
  default: "typesafe",
  nodes: { G0: "gliner", G: "gliner" },
  urls: {
    typesafe: "https://api.typesafe.ai/v1/systemone",
    gliner: "http://127.0.0.1:8781/v1/systemone",
    openjev: "http://127.0.0.1:8782/v1/systemone",
  },
}

const LOCAL: ReadonlySet<BackendName> = new Set(["gliner", "openjev", "rules"])
// Nodes whose questions carry user and task text that must never reach the cloud.
const ALWAYS_LOCAL = new Set(["G0"])

export class RulesBackend implements Asker {
  // Answers nothing: every caller falls back to its code default, as without Jev.
  async ask(): Promise<Decision> {
    return { answers: {}, model: "rules", latencyMs: 0 }
  }
}

export function makeAskers(config: BackendConfig, jevKey: string | undefined, fetcher?: typeof fetch): Partial<Record<BackendName, Asker>> {
  const out: Partial<Record<BackendName, Asker>> = { rules: new RulesBackend() }
  if (jevKey && config.urls.typesafe) out.typesafe = new Jev(jevKey, { url: config.urls.typesafe, fetch: fetcher })
  // Local servers take any key; their timeout is short so a dead server costs little.
  // GLiNER answers four guards in about 0.4 s on the CPU; 5 s leaves room for a loaded machine.
  if (config.urls.gliner) out.gliner = new Jev("local", { url: config.urls.gliner, model: "gliner", timeoutMs: 5000, fetch: fetcher })
  if (config.urls.openjev) out.openjev = new Jev("local", { url: config.urls.openjev, model: "openjev", timeoutMs: 5000, fetch: fetcher })
  return out
}

export interface Asked {
  readonly id: string // journal id; labels refer to it
  readonly backend: BackendName
  readonly decision: Decision
  readonly error?: string // the backend that should have answered failed; rules answered instead
}

export interface AskOptions {
  readonly localOnly?: boolean // a sensitive or refusal_likely job: no cloud backend
  readonly job?: string
  readonly task?: string
}

export class Decider {
  readonly #config: BackendConfig
  readonly #askers: Partial<Record<BackendName, Asker>>
  readonly #journal: (entry: Record<string, unknown>) => void

  constructor(config: BackendConfig, askers: Partial<Record<BackendName, Asker>>, journal: (entry: Record<string, unknown>) => void = record) {
    this.#config = config
    this.#askers = askers
    this.#journal = journal
  }

  // The backend a node uses: its configured one, kept local when it has to be, rules when nothing else is there.
  backendFor(node: string, localOnly = false): BackendName {
    const wanted = this.#config.nodes[node] ?? this.#config.default
    const local = localOnly || ALWAYS_LOCAL.has(node)
    const chain: BackendName[] = local && !LOCAL.has(wanted) ? ["gliner", "openjev", "rules"] : [wanted, "rules"]
    return chain.find((b) => this.#askers[b] !== undefined) ?? "rules"
  }

  async ask(node: string, state: Record<string, unknown>, questions: Record<string, Question>, options: AskOptions = {}): Promise<Asked> {
    const id = randomUUID()
    const backend = this.backendFor(node, options.localOnly)
    const text = JSON.stringify(state)
    const shadowName = this.#config.shadow
    const shadowAllowed = shadowName && shadowName !== backend && this.#askers[shadowName] && (LOCAL.has(shadowName) || !(options.localOnly || ALWAYS_LOCAL.has(node)))
    const shadow = shadowAllowed ? this.#askers[shadowName]!.ask(text, questions).catch((err: unknown) => err as Error) : undefined
    let decision: Decision
    let error: string | undefined
    try {
      decision = await this.#askers[backend]!.ask(text, questions)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      decision = await new RulesBackend().ask()
    }
    const shadowResult = shadow ? await shadow : undefined
    this.#journal({
      kind: "decision",
      id,
      node,
      job: options.job,
      task: options.task,
      backend: error ? "rules" : backend,
      error,
      state,
      questions,
      answers: decision.answers,
      model: decision.model,
      latencyMs: decision.latencyMs,
      ...(shadowResult && shadowName
        ? shadowResult instanceof Error
          ? { shadow: { backend: shadowName, error: shadowResult.message } }
          : { shadow: { backend: shadowName, answers: shadowResult.answers, latencyMs: shadowResult.latencyMs } }
        : {}),
    })
    return { id, backend: error ? "rules" : backend, decision, error }
  }
}

// A label for a journaled decision: the user's answer, an override, or an outcome observed later (design.md §15).
export function label(
  decisionId: string,
  question: string,
  value: string | number,
  source: "user" | "user_override" | "outcome" | "planning_answer",
  journal: (entry: Record<string, unknown>) => void = record,
): void {
  journal({ kind: "label", decision: decisionId, question, value, source })
}
