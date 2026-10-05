// An LLM as a decision backend (Phase E, the user's rule: Jev only where it fits, an LLM elsewhere). It answers the
// same questions as Jev, in Jev's answer shapes, so a node switches backend in the config and a bench compares both
// on the same cases. The LLM is reached through OpenCode (a short session without tools in the plugin, `opencode run`
// in the bench); OpenCode Go serves no request without a session (Phase E spike on ctx.generate).

import { execFile } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { redact, type Answer, type Decision, type Question } from "./jev.ts"
import type { Asker } from "./backends.ts"

// Sends one prompt to a model and returns its final text.
export type Complete = (prompt: string) => Promise<string>

export function llmPrompt(state: string, questions: Record<string, Question>): string {
  const lines = Object.entries(questions).map(([id, q]) => {
    if (q.type === "noul") return `- "${id}": probability 0..1 that this is true: ${q.instructions}`
    if (q.type === "choice") return `- "${id}": ${q.instructions} Pick one of ${Object.entries(q.criteria).map(([k, v]) => `"${k}" (${v})`).join(", ")}; give {"choice": "<id>", "confidence": 0..1}.`
    return `- "${id}": ${q.instructions} Pick the level 0..${q.criteria.length - 1}: ${q.criteria.map((c, i) => `${i} = ${c}`).join("; ")}; give {"score": <level>, "confidence": 0..1}.`
  })
  return `You answer classification questions about a state, as a careful judge. Read the state, then answer every
question on its own, from the state alone. Use no tools.

State (JSON):
${redact(state)}

Questions:
${lines.join("\n")}

Answer with one JSON object and nothing else, keyed by question id: a number for a probability, an object for a
choice or a level. Be calibrated: 0.5 means you do not know.`
}

function json(text: string): Record<string, unknown> | undefined {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/)?.[1]
  const raw = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)
  try {
    const v = JSON.parse(raw)
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const clamp = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : undefined)

// The model's JSON in Jev's shapes; what it left out or got wrong is left out, so callers use their defaults.
export function parseLlm(text: string, questions: Record<string, Question>): Record<string, Answer> {
  const raw = json(text) ?? {}
  const out: Record<string, Answer> = {}
  for (const [id, q] of Object.entries(questions)) {
    const v = raw[id]
    if (q.type === "noul") {
      const p = clamp(typeof v === "object" && v ? (v as { probability?: unknown }).probability : v)
      if (p !== undefined) out[id] = { type: "noul", noul: p }
    } else if (q.type === "choice") {
      const c = v as { choice?: unknown; confidence?: unknown } | undefined
      if (typeof c?.choice === "string" && c.choice in q.criteria) {
        const confidence = clamp(c.confidence) ?? 0.5
        out[id] = { type: "choice", choice: c.choice, confidence, probabilities: { [c.choice]: confidence } }
      }
    } else {
      const s = v as { score?: unknown; confidence?: unknown } | undefined
      const level = typeof s?.score === "number" ? Math.round(s.score) : undefined
      if (level !== undefined && level >= 0 && level < q.criteria.length) {
        const confidence = clamp(s?.confidence) ?? 0.5
        out[id] = { type: "score", score: level, confidence, probabilities: { [String(level)]: confidence } }
      }
    }
  }
  return out
}

export class LlmAsker implements Asker {
  readonly #complete: Complete
  readonly #model: string

  constructor(complete: Complete, model: string) {
    this.#complete = complete
    this.#model = model
  }

  async ask(state: string, questions: Record<string, Question>): Promise<Decision> {
    const started = Date.now()
    const text = await this.#complete(llmPrompt(state, questions))
    const answers = parseLlm(text, questions)
    if (Object.keys(answers).length === 0) throw new Error(`the LLM answered no question: ${text.slice(0, 200)}`)
    return { answers, model: `llm:${this.#model}`, latencyMs: Date.now() - started }
  }
}

// For the bench, outside OpenCode: one `opencode run` per question set, on a private server with the user's provider
// config but without plugins, in an empty directory; the session is deleted afterwards. A start that hangs (seen in
// Phase A) is retried.
export function opencodeRun(model: string, timeoutMs = 120_000): Complete {
  const home = mkdtempSync(join(tmpdir(), "jd-llm-"))
  mkdirSync(join(home, "config", "opencode"), { recursive: true })
  copyFileSync(join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode", "opencode.json"), join(home, "config", "opencode", "opencode.json"))
  const env = { ...process.env, XDG_CONFIG_HOME: join(home, "config") }
  const run = (args: string[], ms: number) =>
    new Promise<string>((resolve) => execFile("opencode", args, { cwd: home, env, timeout: ms, maxBuffer: 16 * 1024 * 1024 }, (_e, out) => resolve(String(out ?? ""))))
  return async (prompt) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const out = await run(["run", "--standalone", "--format", "json", "-m", model, prompt], timeoutMs)
      const events = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return {} } }) as { type?: string; sessionID?: string; part?: { text?: string }; text?: string }[]
      const session = events.find((e) => e.sessionID)?.sessionID
      if (session) await run(["session", "delete", session, "--standalone"], 60_000)
      const text = events.filter((e) => e.type === "text").map((e) => e.part?.text ?? e.text ?? "").join("\n")
      if (text.trim()) return text
    }
    return ""
  }
}
