// Every permission request goes to Jev first. Jev answers it itself when it is sure enough for the request's
// risk and nothing says the user must decide; everything else goes to the user unchanged.
//
// Order: hard rules (never automatic) -> Jev -> floors per risk class. Without Jev (no key, an error) the
// request goes to the user: nothing is decided on a guess.

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { isAbsolute, join } from "node:path"

import type { Decision, Jev, Question } from "./jev.ts"
import { DICTATOR, roleByAgent } from "./roles.ts"

export interface PermissionRequest {
  readonly sessionID: string
  readonly agent: string // the agent asking: "micromanager", "coder", …
  readonly action: string // "shell", "edit", "subagent", "external_directory", …
  readonly resources: readonly string[] // commands, paths, or the sub-agent to start
  readonly directory?: string
  readonly task?: string // what the asking agent is working on, when known
}

export type Verdict = "allow" | "deny" | "user"

export interface Outcome {
  readonly verdict: Verdict
  readonly reason: string
  readonly confidence?: number
  readonly probability?: number // Jev's probability of the chosen option, logged next to its confidence
  readonly risk?: number
  readonly needsUser?: number
  readonly latencyMs?: number
}

export interface Floors {
  readonly read: number // reading, searching, docs on the web
  readonly write: number // changes inside the project, running commands, starting a worker
  readonly needsUser: number // at or above: the user decides
  readonly risk: number // Jev's risk score (0 read … 2 irreversible) at or above: the user decides
}

// write 0.85: live a test sub-agent's pytest runs scored 0.82, so 0.92 sent every test run to the user; the
// destructive cases are caught before (hard rules) and beside it (needs_user, risk).
export const DEFAULT_FLOORS: Floors = { read: 0.8, write: 0.85, needsUser: 0.5, risk: 1.5 }

const READ_ACTIONS = new Set(["read", "glob", "grep", "list", "webfetch", "websearch", "lsp", "skill", "question"])

// Never decided by Jev, whatever it says.
const ALWAYS_USER: readonly { readonly test: (r: PermissionRequest) => boolean; readonly why: string }[] = [
  { test: (r) => r.action === "external_directory", why: "access outside the project" },
  { test: (r) => r.action === "read" && r.resources.some((p) => /(^|\/)\.env(\.|$)/.test(p) && !p.endsWith(".example")), why: "a .env file" },
  {
    test: (r) =>
      r.action === "shell" &&
      r.resources.some((c) =>
        /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f)|\bsudo\b|\bmkfs|\bdd\s+if=|\bchmod\s+-R|\bcurl\b[^|]*\|\s*(ba|z)?sh|\bwget\b[^|]*\|\s*(ba|z)?sh/.test(c) ||
          removesOutside(c),
      ),
    why: "a destructive or irreversible command",
  },
  { test: (r) => r.action === "shell" && r.resources.some(installsIntoSystem), why: "installs software into the system" },
]

// Package installs outside the project's own environment (a venv, node_modules) change the machine.
export function installsIntoSystem(command: string): boolean {
  if (/\b(pacman|yay|paru|apt(-get)?|dnf|brew|snap|flatpak)\s+(-S\b|install\b)/.test(command)) return true
  if (/\bnpm\s+(i|install)\s+(-g|--global)\b/.test(command) || /\b(cargo|go)\s+install\b/.test(command)) return true
  for (const match of command.matchAll(/(\S*?)\b(pip3?|python3?\s+-m\s+pip)\s+install\b/g)) {
    const prefix = match[1] ?? ""
    if (!/venv|\.venv|\/env\//.test(prefix) && !/\buv\s+pip\b/.test(command)) return true
  }
  return false
}

// `rm -r`/`rm -f` on an absolute path, the home directory, a parent directory or a bare wildcard; a relative
// path inside the project (a cache, a build directory) is left to Jev.
// The targets of each `rm -r`/`rm -f` in a command line (an empty list: an `rm` without a target).
export function rmTargets(command: string): string[][] {
  const out: string[][] = []
  for (const match of command.matchAll(/\brm\s+((?:-[a-zA-Z]+(?:\s+|$))+)([^;&|]*)/g)) {
    if (!/[rRf]/.test(match[1] ?? "")) continue
    out.push((match[2] ?? "").trim().split(/\s+/).filter(Boolean))
  }
  return out
}

const OUTSIDE = (t: string) => /^(\/|~|\$HOME|\.\.|\*$|\.$|\.\/?\*?$)/.test(t) || t.includes("/../")

export function removesOutside(command: string): boolean {
  return rmTargets(command).some((targets) => targets.length === 0 || targets.some(OUTSIDE))
}

// What git and the file system say about a path the command wants to delete (relative to the project).
export interface PathFacts {
  readonly path: string
  readonly exists: boolean
  readonly tracked: boolean | undefined // undefined: not a git repository, so nobody knows
  readonly ignored: boolean | undefined
}

export type Inspect = (directory: string, paths: readonly string[]) => PathFacts[]

export const inspectPaths: Inspect = (directory, paths) => {
  const git = (args: string[]): { ok: boolean; out: string } => {
    try {
      return { ok: true, out: execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }) }
    } catch {
      return { ok: false, out: "" }
    }
  }
  const repo = git(["rev-parse", "--is-inside-work-tree"]).out.trim() === "true"
  return paths.map((path) => ({
    path,
    exists: existsSync(isAbsolute(path) ? path : join(directory, path)),
    tracked: repo ? git(["ls-files", "--", path]).out.trim() !== "" : undefined,
    ignored: repo ? git(["check-ignore", "-q", "--", path]).ok : undefined,
  }))
}

function relevanceFacts(facts: readonly PathFacts[]): string {
  const say = (f: PathFacts) =>
    `- ${f.path}: ${f.exists ? "exists" : "does not exist"}, ${f.tracked ? "under version control" : "not under version control"}, ${f.ignored ? "ignored by git (.gitignore)" : "not ignored by git"}`
  return `Paths the command deletes:\n${facts.map(say).join("\n")}`
}

export function hardRule(request: PermissionRequest): string | undefined {
  return ALWAYS_USER.find((rule) => rule.test(request))?.why
}

const READ_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "wc", "sort", "uniq", "grep", "rg", "which", "type", "echo", "printf", "pwd", "file",
  "stat", "du", "df", "tree", "diff", "cut", "tr", "basename", "dirname", "realpath", "env", "date", "true",
])
const READ_GIT = /^git\s+(status|diff|log|show|branch|ls-files|rev-parse|remote\s+-v|blame)\b/
const VERSION = /^\S+\s+(--version|-V|version)\b/

// A shell request that only reads: every command of it is a known reading program (a pipe or a list of
// commands arrives as several resources).
export function readsOnly(commands: readonly string[]): boolean {
  return commands.length > 0 && commands.every((raw) => {
    const command = raw.trim().replace(/\s+\d?>\s*\/dev\/null|\s+2>&1/g, "")
    const program = command.split(/\s+/)[0] ?? ""
    if (program === "find") return !/\s-(delete|exec|execdir|ok|fprint)\b/.test(command)
    return READ_PROGRAMS.has(program) || READ_GIT.test(command) || VERSION.test(command)
  })
}

export function riskClass(request: PermissionRequest): "read" | "write" {
  if (READ_ACTIONS.has(request.action)) return "read"
  return request.action === "shell" && readsOnly(request.resources) ? "read" : "write"
}

function describe(request: PermissionRequest): string {
  const what =
    request.action === "subagent"
      ? `wants to start the sub-agent ${request.resources.join(", ")}`
      : `wants permission for "${request.action}" on: ${request.resources.join(" | ")}`
  const role = roleByAgent(request.agent)
  const lines = [
    `A coding agent in OpenCode (agent "${request.agent}") ${what}.`,
    role ? `Its role is "${role.id}": ${role.description}` : "",
    request.agent === DICTATOR.agent ? `It is the orchestrator: ${DICTATOR.description}` : "",
    request.directory ? `Project directory: ${request.directory}` : "",
    request.task ? `What it is working on:\n${request.task}` : "",
  ]
  return lines.filter(Boolean).join("\n")
}

export const RELEVANCE_QUESTION: Question = {
  type: "score",
  instructions: "How much do the paths this command deletes matter?",
  criteria: [
    "regenerable: a cache, build output or temporary files",
    "project files that cannot simply be regenerated",
    "user data, or files that matter outside the project",
  ],
}

export const PERMISSION_QUESTIONS: Record<string, Question> = {
  answer: {
    type: "choice",
    instructions: "Should this request be allowed?",
    criteria: { allow: "Allow it: it fits the task and is safe to do.", deny: "Deny it: it does not fit the task or is unsafe." },
  },
  needs_user: {
    type: "noul",
    instructions: "Only the user can decide this: a matter of taste, money, data outside the project, or an effect that cannot be undone.",
  },
  risk: {
    type: "score",
    instructions: "How risky is this action?",
    criteria: ["read only", "changes files in the project", "irreversible or outside the project"],
  },
}

export function judge(decision: Decision, request: PermissionRequest, floors: Floors = DEFAULT_FLOORS): Outcome {
  const answer = decision.answers.answer
  const needs = decision.answers.needs_user
  const risk = decision.answers.risk
  if (answer?.type !== "choice" || needs?.type !== "noul" || risk?.type !== "score") {
    return { verdict: "user", reason: "Jev left a question unanswered", latencyMs: decision.latencyMs }
  }
  const base = {
    confidence: answer.confidence,
    probability: answer.probabilities[answer.choice],
    risk: risk.score,
    needsUser: needs.noul,
    latencyMs: decision.latencyMs,
  }
  if (needs.noul >= floors.needsUser) return { ...base, verdict: "user", reason: "Jev: the user must decide this" }
  const relevance = decision.answers.path_relevance
  if (relevance?.type === "score" && relevance.score >= 0.5) {
    return { ...base, verdict: "user", reason: `Jev: the deleted paths matter (${relevance.score.toFixed(2)})` }
  }
  if (risk.score >= floors.risk) return { ...base, verdict: "user", reason: "Jev: too risky to decide alone" }
  const cls = riskClass(request) === "read" && risk.score < 0.5 ? "read" : "write"
  const floor = cls === "read" ? floors.read : floors.write
  if (answer.confidence < floor) {
    return { ...base, verdict: "user", reason: `Jev unsure (${answer.confidence.toFixed(2)} < ${floor} for ${cls})` }
  }
  return { ...base, verdict: answer.choice === "allow" ? "allow" : "deny", reason: `Jev: ${answer.choice} (${cls})` }
}

// preset: the user's policy for this kind of request ("N13.shell": "fixed:allow", design.md §22). It applies after
// the hard rules and the deleted-path check, which it can never switch off, and replaces Jev.
export async function decide(
  jev: Jev | undefined,
  request: PermissionRequest,
  floors: Floors = DEFAULT_FLOORS,
  inspect: Inspect = inspectPaths,
  preset?: "allow" | "deny" | "user",
): Promise<Outcome> {
  const rule = hardRule(request)
  if (rule) return { verdict: "user", reason: `always the user: ${rule}` }
  // Deleting inside the project: first what the paths are; files under version control are the user's call.
  const deleted = request.action === "shell" ? request.resources.flatMap((c) => rmTargets(c).flat()) : []
  let facts: PathFacts[] = []
  if (deleted.length > 0) {
    if (!request.directory) return { verdict: "user", reason: "deletes files, and the project directory is unknown" }
    facts = inspect(request.directory, deleted)
    const kept = facts.find((f) => f.tracked !== false)
    if (kept) {
      const why = kept.tracked === undefined ? "not a git repository" : "under version control"
      return { verdict: "user", reason: `deletes ${kept.path} (${why})` }
    }
  }
  if (preset) return { verdict: preset, reason: `preset by the user's policy (${preset})` }
  if (!jev) return { verdict: "user", reason: "no Jev key" }
  try {
    const state = facts.length > 0 ? `${describe(request)}\n${relevanceFacts(facts)}` : describe(request)
    const questions = facts.length > 0 ? { ...PERMISSION_QUESTIONS, path_relevance: RELEVANCE_QUESTION } : PERMISSION_QUESTIONS
    return judge(await jev.ask(state, questions), request, floors)
  } catch (err) {
    return { verdict: "user", reason: `Jev failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
