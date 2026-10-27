// The evolver (design.md §26): OpenEvolve run against a task's fitness contract, in the Python sidecar evolver/.
// This side prepares the run and watches it:
// - the evolving file with EVOLVE-BLOCK markers around the one block that may change (in a copy, never the worktree);
// - the spec the sidecar reads: the task's checks, the contract's evaluator, scores, guards and baseline;
// - a bridge: an OpenAI-compatible endpoint on 127.0.0.1 with a one-run token, through which OpenEvolve's own client
//   reaches the models. The plugin answers it with its session API (a tool-less session per call), so the evolver
//   needs no API key and every call is charged to the job like any worker's;
// - the sidecar process (uv run mm-evolve), its progress from evals.jsonl, and its result.json.
// The best candidate then goes through the task's gate like any writer's change (src/native.ts finishEvolved).

import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { extname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { Contract } from "./contract.ts"

// The evolver's state travels with its task in the job file (the sidebar and job_status read it there); state.ts owns
// the interface, the field is declared here as contract.ts does.
declare module "./state.ts" {
  interface Task {
    evolve?: {
      state: "running" | "done" | "failed"
      iterations: number
      evaluations: number
      valid: number
      best?: Record<string, number>
      calls: number
      tokens: number
      cost: number
      started: string
    }
  }
}

export function evolverDir(): string {
  return fileURLToPath(new URL("../evolver", import.meta.url))
}

// --- the block that may change ------------------------------------------------------------------------------------

const COMMENT: Record<string, string> = { ".py": "#", ".sh": "#", ".rb": "#", ".r": "#", ".jl": "#", ".lua": "--", ".sql": "--", ".hs": "--" }

// The file with EVOLVE-BLOCK markers around the block: a line range ("12-40", 1-based, inclusive) or a function's
// name, found by its definition and, for brace languages, its balanced braces (Python and the like by indentation).
export function markBlock(text: string, file: string, block: string): { text?: string; lines?: [number, number]; problem?: string } {
  const lines = text.split("\n")
  const c = COMMENT[extname(file).toLowerCase()] ?? "//"
  let range: [number, number] | undefined
  const r = block.trim().match(/^(\d+)\s*-\s*(\d+)$/)
  if (r) {
    range = [Number(r[1]), Number(r[2])]
    if (range[0] < 1 || range[1] > lines.length || range[0] > range[1]) return { problem: `lines ${block} are not inside ${file} (${lines.length} lines)` }
  } else {
    const name = block.trim().replace(/[^\w$]/g, "")
    if (!name) return { problem: "block: a function's name or a line range like 12-40" }
    const def = new RegExp(`(function\\*?\\s+${name}\\b|\\b${name}\\s*[:=]\\s*(async\\s*)?(function|\\()|^\\s*(async\\s+)?def\\s+${name}\\b|\\bfn\\s+${name}\\b|\\bfunc\\s+${name}\\b|^\\s*(export\\s+)?(async\\s+)?(static\\s+)?${name}\\s*\\([^)]*\\)\\s*[:{])`)
    const start = lines.findIndex((l) => def.test(l))
    if (start < 0) return { problem: `no definition of ${name} in ${file}; give the block as a line range instead` }
    let end = start
    if (c === "#") {
      const indent = lines[start]!.search(/\S/)
      end = start + 1
      while (end < lines.length && (lines[end]!.trim() === "" || lines[end]!.search(/\S/) > indent)) end++
      while (end > start + 1 && lines[end - 1]!.trim() === "") end--
      end--
    } else {
      let depth = 0
      let opened = false
      for (end = start; end < lines.length; end++) {
        for (const ch of lines[end]!.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "")) {
          if (ch === "{") { depth++; opened = true }
          if (ch === "}") depth--
        }
        if (opened && depth <= 0) break
      }
      if (!opened || end >= lines.length) return { problem: `could not find where ${name} ends in ${file}; give the block as a line range instead` }
    }
    range = [start + 1, end + 1]
  }
  const [a, b] = range
  const out = [...lines.slice(0, a - 1), `${c} EVOLVE-BLOCK-START`, ...lines.slice(a - 1, b), `${c} EVOLVE-BLOCK-END`, ...lines.slice(b)]
  return { text: out.join("\n"), lines: range }
}

// --- the spec ------------------------------------------------------------------------------------------------------

export interface EvolveSpec {
  readonly workdir: string
  readonly file: string
  readonly initial: string
  readonly checks: readonly string[]
  readonly evaluator: string
  readonly scores: readonly { name: string; direction: string }[]
  readonly guards: readonly { name: string; direction: string; tolerance: number }[]
  readonly baseline: Readonly<Record<string, number>>
  readonly output: string
  readonly models: readonly { name: string; weight: number }[]
  readonly iterations: number
  readonly timeout_s: number
  readonly target: Readonly<Record<string, number>>
  readonly full_rewrite: boolean
  readonly held_out_dir: string | null
  readonly runner: readonly string[]
  readonly api_base: string
  readonly api_key: string
}

export function specOf(o: {
  workdir: string; file: string; initial: string; checks: readonly string[]; contract: Contract; output: string; models: readonly string[]
  iterations: number; heldOutDir?: string; runner: readonly string[]; bridge: { url: string; token: string }; fullRewrite?: boolean
}): EvolveSpec {
  const c = o.contract
  return {
    workdir: o.workdir,
    file: o.file,
    initial: o.initial,
    checks: [...o.checks],
    evaluator: c.evaluator,
    scores: c.scores.map((s) => ({ name: s.name, direction: s.direction })),
    guards: c.guards.map((g) => ({ name: g.name, direction: g.direction, tolerance: g.tolerance })),
    baseline: { ...(c.baseline?.values ?? {}) },
    output: o.output,
    models: o.models.map((name) => ({ name, weight: 1 })),
    iterations: o.iterations,
    timeout_s: Math.round(c.timeoutMs / 1000),
    target: { ...(c.stop.target ?? {}) },
    full_rewrite: o.fullRewrite ?? false,
    held_out_dir: o.heldOutDir ?? null,
    runner: [...o.runner],
    api_base: `${o.bridge.url}/v1`,
    api_key: o.bridge.token,
  }
}

// --- the bridge ----------------------------------------------------------------------------------------------------

export interface Generated {
  readonly text: string
  readonly tokens: number
  readonly cost: number
}

export interface Bridge {
  readonly url: string
  readonly token: string
  readonly calls: () => { calls: number; failed: number; tokens: number; cost: number }
  close(): Promise<void>
}

// An OpenAI-compatible /v1/chat/completions on 127.0.0.1, for one run: a random token, and every call answered by
// generate (a model id and the system and user text). Anything else is 404; a wrong token 401.
export async function startBridge(generate: (model: string, system: string, prompt: string) => Promise<Generated>): Promise<Bridge> {
  const token = randomBytes(24).toString("hex")
  const used = { calls: 0, failed: 0, tokens: 0, cost: 0 }
  const server: Server = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) return send(404, { error: { message: "not found" } })
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: { message: "wrong token" } })
    let raw = ""
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")))
    req.on("end", () => {
      void (async () => {
        try {
          const body = JSON.parse(raw) as { model?: string; messages?: { role: string; content: unknown }[] }
          const text = (m: { content: unknown }) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: { text?: string }) => p.text ?? "").join("") : "")
          const messages = body.messages ?? []
          const system = messages.filter((m) => m.role === "system").map(text).join("\n\n")
          const prompt = messages.filter((m) => m.role !== "system").map(text).join("\n\n")
          const g = await generate(String(body.model ?? ""), system, prompt)
          used.calls++
          used.tokens += g.tokens
          used.cost += g.cost
          send(200, {
            id: `mm-${used.calls}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content: g.text }, finish_reason: "stop" }],
            usage: { prompt_tokens: 0, completion_tokens: g.tokens, total_tokens: g.tokens },
          })
        } catch (err) {
          used.failed++
          send(500, { error: { message: err instanceof Error ? err.message : String(err) } })
        }
      })()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    calls: () => ({ ...used }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

// Why the evolved best may not be merged although it won on the visible corpus: invalid on the held-out cases, or worse
// there than today's code on the deciding score. The evolution never saw those cases, so this is where it shows
// whether it learned the task or the corpus. Undefined when it may go on to the gate.
export function heldOutProblem(c: Contract, held: Readonly<Record<string, number | string>> | null | undefined): string | undefined {
  if (!held) return undefined
  if (held.valid !== 1) return `the best candidate is invalid on the held-out cases (${held.error ?? "no valid result"})`
  const first = c.scores[0]
  const base = first && c.baseline?.heldOut?.[first.name]
  const now = first && held[first.name]
  if (base === undefined || typeof now !== "number") return undefined
  const worse = first!.direction === "min" ? now > base : now < base
  return worse ? `on the held-out cases the best candidate is worse than today's code (${first!.name} ${now} against ${base})` : undefined
}

// --- the run -------------------------------------------------------------------------------------------------------

export interface Progress {
  readonly evaluations: number
  readonly valid: number
  readonly best?: Readonly<Record<string, number>> // the best valid evaluation's metrics so far
}

export interface EvolveResult {
  readonly best: string // the best program's file
  readonly metrics: Readonly<Record<string, number>>
  readonly heldOut?: Readonly<Record<string, number | string>> | null
  readonly seconds: number
}

// What evals.jsonl says so far: how many candidates were measured, how many were valid, and the best by
// combined_score.
export function progressOf(evals: string): Progress {
  let evaluations = 0
  let valid = 0
  let best: Record<string, number> | undefined
  for (const line of evals.split("\n")) {
    if (!line.trim()) continue
    let row: Record<string, number>
    try {
      row = JSON.parse(line) as Record<string, number>
    } catch {
      continue
    }
    evaluations++
    if (row.valid === 1) {
      valid++
      if (!best || (row.combined_score ?? 0) > (best.combined_score ?? 0)) best = row
    }
  }
  return { evaluations, valid, ...(best ? { best } : {}) }
}

export interface Running {
  readonly done: Promise<{ result?: EvolveResult; problem?: string }>
  stop(): void
}

// The sidecar on a spec: `uv run --project evolver mm-evolve spec.json`, stdin closed (a child that reads stdin waits
// for an end that never comes). onProgress is called whenever evals.jsonl grew. stop() ends the process group.
export function runEvolver(spec: EvolveSpec, onProgress: (p: Progress) => void, opts: { uv?: string; dir?: string; pollMs?: number } = {}): Running {
  mkdirSync(spec.output, { recursive: true })
  const specPath = join(spec.output, "spec.json")
  writeFileSync(specPath, JSON.stringify(spec, null, 2))
  const child: ChildProcess = spawn(opts.uv ?? "uv", ["run", "--quiet", "--project", opts.dir ?? evolverDir(), "mm-evolve", specPath], { stdio: ["ignore", "pipe", "pipe"], detached: true })
  let tail = ""
  child.stdout?.on("data", (d: Buffer) => (tail = (tail + d.toString("utf8")).slice(-20_000)))
  child.stderr?.on("data", (d: Buffer) => (tail = (tail + d.toString("utf8")).slice(-20_000)))
  let seen = 0
  const evals = join(spec.output, "evals.jsonl")
  const poll = setInterval(() => {
    if (!existsSync(evals)) return
    const text = readFileSync(evals, "utf8")
    if (text.length === seen) return
    seen = text.length
    onProgress(progressOf(text))
  }, opts.pollMs ?? 5000)
  poll.unref?.()
  const done = new Promise<{ result?: EvolveResult; problem?: string }>((resolve) => {
    child.on("error", (err) => {
      clearInterval(poll)
      resolve({ problem: `the evolver did not start: ${err.message}` })
    })
    child.on("close", (code) => {
      clearInterval(poll)
      if (existsSync(evals)) onProgress(progressOf(readFileSync(evals, "utf8")))
      const out = join(spec.output, "result.json")
      if (code === 0 && existsSync(out)) {
        try {
          return resolve({ result: JSON.parse(readFileSync(out, "utf8")) as EvolveResult })
        } catch {
          // fall through: a result that cannot be read is no result
        }
      }
      resolve({ problem: `the evolver ended with code ${code}: ${tail.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}` })
    })
  })
  return {
    done,
    stop: () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM")
      } catch {
        child.kill("SIGTERM")
      }
    },
  }
}
