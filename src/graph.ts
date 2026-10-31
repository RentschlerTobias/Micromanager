// The code graph an explorer starts from: graphify's graph of the session worktree (graphify-out/), built from the
// tree-sitter AST without an LLM, so its call and import edges need no checking. `graphify update` re-extracts only
// what changed, so a later explorer of the same session waits seconds at most (jev-tutor, 92 files: 3.6 s cold).
//
// The worktree lives under .micromanager/, which the user's checkout already ignores; a .gitignore inside
// graphify-out/ keeps it out of the worktree's own git status too, so no commit of the session picks it up.

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { exec as defaultExec, type Exec } from "./integration.ts"

export const GRAPH_DIR = "graphify-out"

export interface Graph {
  readonly commit: string // the worktree's HEAD the graph was built from
}

// Builds or updates the graph of dir; undefined when graphify is missing or fails (the explorer then works without).
export async function updateGraph(dir: string, run: Exec = defaultExec): Promise<Graph | undefined> {
  const head = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: dir })
  if (head.code !== 0) return undefined
  // --force: the graph follows the code, also when a refactor removed symbols (graphify keeps the bigger graph otherwise).
  const r = await run("graphify", ["update", ".", "--force"], { cwd: dir, timeoutMs: 120_000 })
  if (r.code !== 0 || r.timedOut || !existsSync(join(dir, GRAPH_DIR, "graph.json"))) return undefined
  const ignore = join(dir, GRAPH_DIR, ".gitignore")
  if (!existsSync(ignore)) {
    mkdirSync(join(dir, GRAPH_DIR), { recursive: true })
    writeFileSync(ignore, "*\n")
  }
  return { commit: head.stdout.trim() }
}

// One build per worktree and commit: explorers started in one message share it.
export class Graphs {
  readonly #run: Exec
  readonly #builds = new Map<string, { commit: string; graph: Promise<Graph | undefined> }>()

  constructor(run: Exec = defaultExec) {
    this.#run = run
  }

  async get(dir: string): Promise<Graph | undefined> {
    const head = (await this.#run("git", ["rev-parse", "--short", "HEAD"], { cwd: dir })).stdout.trim()
    const known = this.#builds.get(dir)
    if (known && known.commit === head) return known.graph
    const graph = updateGraph(dir, this.#run)
    this.#builds.set(dir, { commit: head, graph })
    return graph
  }
}

export const GRAPH_ACTIONS = ["explain", "path", "affected", "query"] as const
export type GraphAction = (typeof GRAPH_ACTIONS)[number]
const MAX_OUTPUT = 12_000

// One question to the graph of dir, as the code_graph tool answers it.
export async function queryGraph(dir: string, action: string, symbol: string, to = "", run: Exec = defaultExec): Promise<string> {
  if (!(GRAPH_ACTIONS as readonly string[]).includes(action)) return `Unknown action "${action}"; use one of ${GRAPH_ACTIONS.join(", ")}.`
  if (!symbol.trim()) return "Name a symbol (or words, for query)."
  if (action === "path" && !to.trim()) return "path needs both symbol and to."
  const args = action === "path" ? ["path", symbol, to] : action === "query" ? ["query", symbol, "--budget", "3000"] : [action, symbol]
  const r = await run("graphify", args, { cwd: dir, timeoutMs: 60_000 })
  const out = `${r.stdout}${r.code !== 0 ? `\n${r.stderr}` : ""}`.trim() || "(no answer)"
  return out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n[cut at ${MAX_OUTPUT} characters; ask about a narrower symbol]` : out
}

// The lines of an explorer's brief that point it at the graph.
export function graphBrief(graph: Graph): string {
  return `A code graph of this directory (commit ${graph.commit}) is ready. ${GRAPH_DIR}/GRAPH_REPORT.md maps the modules and
their central symbols. For any question about who calls, uses or imports what, ask the code_graph tool first, before
grep or reading files: its call and import edges come from the syntax tree of every file, so one call replaces a
search through the code. Read code only to explain what you found; edges marked INFERRED are guesses to check.`
}
