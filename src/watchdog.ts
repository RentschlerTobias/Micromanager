// The loop watchdog (design.md §10.1): code, not the model, decides that a session is going in circles.
//
// It is fed every tool call of a watched session (tool.execute.after) and every provider turn (the context hook,
// which carries the message history), and returns a signal when a limit or a loop signature fires. The plugin
// then interrupts the session; the runner never resumes it, but may start a fresh one with a handoff note.
// The signatures come from real failures: Kimi restarting its task, Gemini's read loops, and a local planner
// that read the same directory sixty times in this project's own test.

export type SignalKind = "steps" | "same_call" | "read_loop" | "no_new_files" | "restart" | "monologue" | "repeat_text" | "tokens" | "stalled" | "checkpoint" | "handback"

// How hard a signal hits. A nudge asks the worker to get on with it (Jev decides whether to pass it on); a stop
// interrupts the session. Absent means "stop", so every caller written before this field keeps its behaviour.
export type SignalSeverity = "stop" | "nudge"

export interface Signal {
  readonly kind: SignalKind
  readonly detail: string
  readonly severity?: SignalSeverity // absent = "stop"
}

export interface Limits {
  readonly maxSteps: number // provider turns
  readonly sameCall: number // the same tool with the same input this often ...
  readonly window: number // ... within this many calls
  readonly readRepeat: number // the same path read this often ...
  readonly readWindow: number // ... within this many calls, and with no write in between
  readonly noNewFiles: number // this many calls in a row without progress; 0 disables the check (see below)
  readonly restartLength: number // the opening calls repeated in this length
  readonly monologue: number // assistant turns in a row without a tool call
}

// The thresholds, and what each one defends against (2026-10-06, after a live run in which nine signals fired on
// healthy sessions and three were escalated):
//
// - sameCall 3 in window 10, unchanged: the tightest loop there is, and the one the real failures showed first
//   (Kimi restarting its task, Gemini rereading). Keeping the value means a genuinely stuck session still ends at
//   three repeats; raising it to spare a TDD loop that runs `npm test` three times would let a real forever-loop
//   (the same failing command, forever) run on to the step limit, which is a much more expensive mistake.
// - readRepeat 3 in readWindow 16: "the same file again and again" only means a loop *while it stays the recent
//   work*. Before the window, reading a config file three times anywhere in a 200-call session was a hard stop, and
//   normal work looked like the planner's loop. 16 calls is more than a read-explore-read cycle takes and less than
//   a session's worth, so a real loop cannot hide outside it.
// - noNewFiles 16: calls in a row that make no progress. Three things count as progress: a new path, a search, and
//   a command that actually did something. A command that runs is progress -- a worker verifying with `npm test` or
//   `git status` ten times over is working, not stuck -- and the signature that actually catches a stuck command is
//   sameCall, which compares the command itself rather than counting calls (live test, 2026-10-07: a worker was
//   stopped after "8 calls in a row without a new file or a search" while it was eight calls into reading a source
//   file it had already opened, before it had written anything). Only a command that keeps FAILING now counts
//   towards the run, because that is the case sameCall cannot see. Readers, whose whole job is reading and who never
//   write, are the extreme case: they would trip a low bar on ordinary work.
// - restartLength 4: the opening calls repeated verbatim at the tail of the *whole* session. That comparison is
//   deliberately not windowed: starting over is by definition where the session began. Four is enough of an opening
//   to be a shape rather than a coincidence (one read can repeat by chance, four calls rarely do).
// - monologue 3: a worker writing a long report in several messages was interrupted mid-report, so it only nudges.
// - maxSteps: the last safety net for a session that never ends (the user, 2026-10-05: a cut session wastes work).
// How many times a worker's failing checks are handed back for another try, on both gate paths (the runner's fix
// rounds and the native finish_task loop). The runner's own cap is configurable through RunnerDeps.fixRounds; this is
// the default both use. A check that cannot be satisfied in the environment -- a path that does not exist there, a
// command the gate refuses -- is the case this exists for: handed back forever, it burned a whole session.
export const FIX_ROUNDS = 2

export const DEFAULT_LIMITS: Limits = { maxSteps: 60, sameCall: 3, window: 10, readRepeat: 3, readWindow: 16, noNewFiles: 16, restartLength: 4, monologue: 3 }

// The budget tier the decision model picks (design.md §8.1) maps to step limits; code keeps the ceiling.
export const TIER_STEPS = { S: 30, M: 60, L: 120 } as const
// The user's choice (2026-10-05): no budget estimates per task, since a cut session wastes what it did. Loops are
// caught by the signatures above; this is only the last safety net for a session that never ends.
export const MAX_STEPS = 400

// Task checkpoints (the user's idea, 2026-10-05): every CHECKPOINT_STEPS steps a task is reviewed, not cut. Jev looks
// at the facts below and says whether it still makes progress (go on), needs another approach (a fresh session on
// another family), or goes back to the micromanager.
export const CHECKPOINT_STEPS = 60

// What a checkpoint is decided on: facts the watchdog has anyway, no estimate.
export interface Progress {
  readonly steps: number
  readonly calls: number
  readonly writes: number
  readonly callsSinceWrite: number
  readonly filesRead: number
  readonly recent: readonly string[] // the last tool calls, short
  readonly recentFailures: number // failed tool calls among them
}
// ... and to tokens per session (input + output over all turns), checked after each turn by the runner.
export const TIER_TOKENS = { S: 250_000, M: 600_000, L: 1_500_000 } as const

const READS = new Set(["read", "list"])
const WRITES = new Set(["edit", "write", "patch", "multiedit", "apply_patch"])
// Searching is work: a worker that greps and globs nine times in a row is exploring a repository, not going in
// circles, and none of those calls opens a path the noNewFiles counter could see. code_graph is in here because it
// is a search over the syntax tree that opens no path at all (added 2026-10-06, missed by this list until then).
const SEARCHES = new Set([
  "grep", "glob", "ast-grep", "astgrep", "websearch", "webfetch", "search", "code_search", "code_graph",
])
// Tools that act: they run something whose outcome is not a file this watchdog can see. A successful one is progress,
// whatever it touched. A failing one is not counted here -- it falls through and counts towards the run, which is
// what a worker repeatedly failing the same way looks like, and the one case sameCall cannot catch because the
// command text differs each time.
const ACTS = new Set(["shell", "bash", "execute", "task"])

interface State {
  limits: Limits
  calls: string[] // tool + input, in order
  readWindow: string[] // the read part key per call, "" for anything else, trimmed to limits.readWindow
  readPaths: Set<string>
  quiet: number // calls in a row without a new path and without a search
  steps: number
  texts: string[] // normalized assistant texts seen so far
  writes: number
  lastWrite: number // index into calls of the last write, -1 before any
  failed: boolean[] // per call: did it fail
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
      readWindow: [],
      readPaths: new Set(),
      quiet: 0,
      steps: 0,
      texts: [],
      writes: 0,
      lastWrite: -1,
      failed: [],
    })
  }

  unwatch(sessionID: string): void {
    this.#sessions.delete(sessionID)
  }

  watching(sessionID: string | undefined): boolean {
    return sessionID !== undefined && this.#sessions.has(sessionID)
  }

  // failed: the call's result reads like an error (for the checkpoint's facts).
  onTool(sessionID: string, tool: string, input: unknown, failed = false): Signal | undefined {
    const s = this.#sessions.get(sessionID)
    if (!s) return undefined
    const key = `${tool} ${stable(input)}`
    s.calls.push(key)
    s.failed.push(failed)
    // One definition of "changed something": the writes counter and the re-read window reset on the same calls.
    // A `git commit` or `git add` through the shell is a write too; without this a session that read a file,
    // committed and read again kept its read count and looked like a loop.
    const wrote = WRITES.has(tool) || (tool === "shell" && /\b(git (add|commit)|>|tee|sed -i|mv|cp)\b/.test(stable(input)))
    if (wrote) {
      s.writes++
      s.lastWrite = s.calls.length - 1
    }
    const recent = s.calls.slice(-s.limits.window)
    const same = recent.filter((c) => c === key).length
    if (same >= s.limits.sameCall) return { kind: "same_call", severity: "stop", detail: `${tool} with the same input ${same}x in the last ${recent.length} calls` }
    const path = pathOf(input)
    const i = input as { offset?: unknown; limit?: unknown } | undefined
    // A long file read part by part (offset/limit) is no loop (live test: a reader stopped while reading
    // conversation.py in three parts); the same part again is.
    const part = READS.has(tool) && path ? `${path}@${String(i?.offset ?? 0)}+${String(i?.limit ?? "")}` : ""
    s.readWindow.push(part)
    if (s.readWindow.length > s.limits.readWindow) s.readWindow.shift() // only recent work counts as a repeat
    if (wrote) s.readWindow.length = 0 // a write changes what a re-read shows
    if (part) {
      const n = s.readWindow.filter((p) => p === part).length
      if (n >= s.limits.readRepeat) return { kind: "read_loop", severity: "nudge", detail: `read ${path}${i?.offset !== undefined ? ` from line ${String(i.offset)}` : ""} ${n}x in a row with no write in between` }
    }
    // Progress, not only new files. A search counts, and so does a command that ran and did not fail -- including
    // the `execute` tool, which is how a worker acts in code mode and which opens no path for the check below to
    // see. Only a command that keeps failing counts towards the run (see ACTS above).
    if (wrote || SEARCHES.has(tool)) s.quiet = 0
    else if (ACTS.has(tool) && !failed) s.quiet = 0
    else if (path && READS.has(tool) && !s.readPaths.has(path)) {
      s.readPaths.add(path)
      s.quiet = 0
    } else s.quiet++
    if (s.limits.noNewFiles > 0 && s.quiet >= s.limits.noNewFiles) {
      return { kind: "no_new_files", severity: "stop", detail: `${s.quiet} calls in a row without progress: no new file, no search, no command that worked` }
    }
    const k = s.limits.restartLength
    if (s.calls.length >= 2 * k && s.calls.slice(-k).join("\n") === s.calls.slice(0, k).join("\n")) {
      return { kind: "restart", detail: `the first ${k} calls came again: the session started over` }
    }
    return undefined
  }

  // A checkpoint is due at every CHECKPOINT_STEPS steps of a watched session.
  checkpointDue(sessionID: string, every = CHECKPOINT_STEPS): boolean {
    const s = this.#sessions.get(sessionID)
    return Boolean(s && s.steps > 0 && s.steps % every === 0)
  }

  progress(sessionID: string): Progress | undefined {
    const s = this.#sessions.get(sessionID)
    if (!s) return undefined
    const tail = s.calls.slice(-12)
    return {
      steps: s.steps,
      calls: s.calls.length,
      writes: s.writes,
      callsSinceWrite: s.calls.length - 1 - s.lastWrite,
      filesRead: s.readPaths.size,
      recent: tail.map((c) => c.slice(0, 120)),
      recentFailures: s.failed.slice(-12).filter(Boolean).length,
    }
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
    // A nudge, not a stop: a worker that writes a long report in several messages was interrupted mid-report (live
    // run, 2026-10-06), and three text turns say nothing about a loop.
    if (silent >= s.limits.monologue) return { kind: "monologue", severity: "nudge", detail: `${silent} replies in a row without a tool call` }
    const last = assistant.at(-1)
    const text = last ? normalize(parts(last).filter((p) => p.type === "text").map((p) => p.text ?? "").join(" ")) : ""
    if (text.length > 40) {
      if (s.texts.includes(text)) return { kind: "repeat_text", detail: "the same answer text came again" }
      s.texts.push(text)
    }
    return undefined
  }
}

// What a fresh session is told after the watchdog stopped (or nudged) the previous one.
export function handoffNote(signal: Signal, changed: readonly string[]): string {
  const what = signal.severity === "nudge" ? "drew a nudge from the loop watchdog, not a stop" : "was stopped by the loop watchdog"
  return [
    `A previous attempt at this task ${what}: ${signal.detail}.`,
    changed.length ? `Files already changed in this directory: ${changed.join(", ")}. Check them instead of starting over.` : "No file was changed yet.",
    "Do not read the same file again and again: once you have read a file, use what you know. If something is missing, say so in your report.",
  ].join("\n")
}
