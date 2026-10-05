// The loop watchdog (design.md §10.1): code, not the model, decides that a session is going in circles.
//
// It is fed every tool call of a watched session (tool.execute.after) and every provider turn (the context hook,
// which carries the message history), and returns a signal when a limit or a loop signature fires. The plugin
// then interrupts the session; the runner never resumes it, but may start a fresh one with a handoff note.
// The signatures come from real failures: Kimi restarting its task, Gemini's read loops, and a local planner
// that read the same directory sixty times in this project's own test.

export type SignalKind = "steps" | "same_call" | "read_loop" | "no_new_files" | "restart" | "monologue" | "repeat_text" | "tokens" | "stalled"

export interface Signal {
  readonly kind: SignalKind
  readonly detail: string
}

export interface Limits {
  readonly maxSteps: number // provider turns
  readonly sameCall: number // the same tool with the same input this often ...
  readonly window: number // ... within this many calls
  readonly readRepeat: number // the same path read this often with no write in between
  readonly noNewFiles: number // this many reads in a row without a path not read before
  readonly restartLength: number // the opening calls repeated in this length
  readonly monologue: number // assistant turns in a row without a tool call
}

export const DEFAULT_LIMITS: Limits = { maxSteps: 60, sameCall: 3, window: 10, readRepeat: 3, noNewFiles: 8, restartLength: 4, monologue: 3 }

// The budget tier the decision model picks (design.md §8.1) maps to step limits; code keeps the ceiling.
export const TIER_STEPS = { S: 30, M: 60, L: 120 } as const
// ... and to tokens per session (input + output over all turns), checked after each turn by the runner.
export const TIER_TOKENS = { S: 250_000, M: 600_000, L: 1_500_000 } as const

const READS = new Set(["read", "list"])
const WRITES = new Set(["edit", "write", "patch", "multiedit", "apply_patch"])

interface State {
  limits: Limits
  calls: string[] // tool + input, in order
  readCount: Map<string, number>
  readPaths: Set<string>
  readsSinceNew: number
  steps: number
  texts: string[] // normalized assistant texts seen so far
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  return `{${Object.keys(value as object).sort().map((k) => `${k}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`
}

function pathOf(input: unknown): string | undefined {
  const i = input as Record<string, unknown> | undefined
  const p = i?.path ?? i?.filePath ?? i?.file_path
  return typeof p === "string" ? p.replace(/\/+$/, "") : undefined
}

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim()

export class Watchdog {
  readonly #sessions = new Map<string, State>()

  watch(sessionID: string, limits: Partial<Limits> = {}): void {
    this.#sessions.set(sessionID, {
      limits: { ...DEFAULT_LIMITS, ...limits },
      calls: [],
      readCount: new Map(),
      readPaths: new Set(),
      readsSinceNew: 0,
      steps: 0,
      texts: [],
    })
  }

  unwatch(sessionID: string): void {
    this.#sessions.delete(sessionID)
  }

  watching(sessionID: string | undefined): boolean {
    return sessionID !== undefined && this.#sessions.has(sessionID)
  }

  onTool(sessionID: string, tool: string, input: unknown): Signal | undefined {
    const s = this.#sessions.get(sessionID)
    if (!s) return undefined
    const key = `${tool} ${stable(input)}`
    s.calls.push(key)
    const recent = s.calls.slice(-s.limits.window)
    const same = recent.filter((c) => c === key).length
    if (same >= s.limits.sameCall) return { kind: "same_call", detail: `${tool} with the same input ${same}x in the last ${recent.length} calls` }
    const path = pathOf(input)
    if (WRITES.has(tool)) {
      s.readCount.clear() // a write changes what a re-read shows
      s.readsSinceNew = 0
    } else if (READS.has(tool) && path) {
      const n = (s.readCount.get(path) ?? 0) + 1
      s.readCount.set(path, n)
      if (n >= s.limits.readRepeat) return { kind: "read_loop", detail: `read ${path} ${n}x with no write in between` }
      if (s.readPaths.has(path)) s.readsSinceNew++
      else {
        s.readPaths.add(path)
        s.readsSinceNew = 0
      }
      if (s.readsSinceNew >= s.limits.noNewFiles) return { kind: "no_new_files", detail: `${s.readsSinceNew} reads in a row without a new file` }
    }
    const k = s.limits.restartLength
    if (s.calls.length >= 2 * k && s.calls.slice(-k).join("\n") === s.calls.slice(0, k).join("\n")) {
      return { kind: "restart", detail: `the first ${k} calls came again: the session started over` }
    }
    return undefined
  }

  // One provider turn; messages as the context hook gives them (role + content parts).
  onTurn(sessionID: string, messages: unknown): Signal | undefined {
    const s = this.#sessions.get(sessionID)
    if (!s) return undefined
    s.steps++
    if (s.steps > s.limits.maxSteps) return { kind: "steps", detail: `more than ${s.limits.maxSteps} steps` }
    if (!Array.isArray(messages)) return undefined
    const assistant = (messages as { role?: string; content?: unknown }[]).filter((m) => m.role === "assistant")
    const parts = (m: { content?: unknown }) => (Array.isArray(m.content) ? (m.content as { type?: string; text?: string }[]) : [])
    let silent = 0
    for (let i = assistant.length - 1; i >= 0 && !parts(assistant[i]!).some((p) => p.type === "tool-call"); i--) silent++
    if (silent >= s.limits.monologue) return { kind: "monologue", detail: `${silent} replies in a row without a tool call` }
    const last = assistant.at(-1)
    const text = last ? normalize(parts(last).filter((p) => p.type === "text").map((p) => p.text ?? "").join(" ")) : ""
    if (text.length > 40) {
      if (s.texts.includes(text)) return { kind: "repeat_text", detail: "the same answer text came again" }
      s.texts.push(text)
    }
    return undefined
  }
}

// What a fresh session is told after the watchdog stopped the previous one.
export function handoffNote(signal: Signal, changed: readonly string[]): string {
  return [
    `A previous attempt at this task was stopped by the loop watchdog: ${signal.detail}.`,
    changed.length ? `Files already changed in this directory: ${changed.join(", ")}. Check them instead of starting over.` : "No file was changed yet.",
    "Do not read the same file again and again: once you have read a file, use what you know. If something is missing, say so in your report.",
  ].join("\n")
}
