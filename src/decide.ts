// Every permission request goes to Jev first. Jev answers it itself when it is sure enough for the request's
// risk and nothing says the user must decide; everything else goes to the user unchanged.
//
// Order: hard rules (never automatic) -> the job's own area -> Jev -> floors per risk class. Without Jev (no key,
// an error) the request goes to the user: nothing is decided on a guess.
//
// A shell request that only reads inside the job's own worktree skips Jev entirely (readsOnlyInside): a worker
// cannot change anything with it, and its own confidence on `git status --porcelain` (0.75) sits below the read
// floor (0.80), so asking only turned inspection into denials.
//
// external_directory is layered, not a blanket "never":
//   1. a hard rule that no layer can pass: the user's keys and credentials, their home itself, the system
//      directories, another job's branch in the repository's own git data;
//   2. the job's own area: any worktree under <project>/.jev-micromanager/worktrees/, this job's integration
//      worktree included. Path-based, never a substring: `worktrees-old` is not `worktrees`;
//   3. task-vouched: a path the task text names with its full path, for a read only (a named path is a vouch for
//      reading it, not for changing it);
//   4. everything else is the user, as it always was.

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, normalize } from "node:path"

import type { Decision, Jev, Question } from "./jev.ts"
import { WRITERS } from "./profile.ts"
import { MICROMANAGER, roleByAgent } from "./roles.ts"

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
  { test: (r) => r.action === "external_directory" && r.resources.some(forbiddenOutside), why: "a path no layer may allow" },
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

const HOME = homedir()
// Paths outside the project that no layer may allow: the user's keys, credentials and config, and the system.
const FORBIDDEN_OUTSIDE: readonly string[] = [
  join(HOME, ".ssh"), join(HOME, ".aws"), join(HOME, ".gnupg"), join(HOME, ".config"),
  join(HOME, ".local", "share", "keyrings"), join(HOME, ".netrc"),
  "/etc", "/usr", "/boot", "/var", "/proc", "/sys",
]
// Another job's worktree metadata and branches live under .git/; a worker never reaches them, whatever its task says.
const GIT_DATA = /(^|\/)\.git\/(worktrees|refs)\//

// `~` expanded, a trailing `/*` or `/` dropped, `..` resolved lexically. No filesystem access: a path that does not
// exist yet has to be classified the same way as one that does.
function normalizeOutside(path: string): string {
  const trimmed = path.trim()
  const bare = trimmed.replace(/\/+$/, "").replace(/(?<=[^/])\/\*+$/, "")
  const expanded = bare === "~" ? HOME : bare.startsWith("~/") ? join(HOME, bare.slice(2)) : bare
  return expanded.length === 0 ? trimmed : normalize(expanded)
}

function under(path: string, base: string): boolean {
  if (base === "/") return path.startsWith("/")
  return path === base || path.startsWith(`${base}/`)
}

export function forbiddenOutside(resource: string): boolean {
  const path = normalizeOutside(resource)
  if (path === "/") return true // the whole file system
  if (path.length === 0 || path === ".") return false
  return path === HOME || FORBIDDEN_OUTSIDE.some((f) => under(path, f)) || GIT_DATA.test(path)
}

export function hardRule(request: PermissionRequest): string | undefined {
  return ALWAYS_USER.find((rule) => rule.test(request))?.why
}

const READ_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "wc", "sort", "uniq", "grep", "rg", "which", "type", "echo", "printf", "pwd", "file",
  "stat", "du", "df", "tree", "diff", "cut", "tr", "basename", "dirname", "realpath", "env", "date", "true",
  // Reading programs a worker reaches for constantly (a live run denied 67 read-only commands without these).
  "sed", "awk", "jq", "md5sum", "sha256sum", "xxd", "od", "column", "comm", "nl", "fold", "tac", "expr", "seq",
])
// A reading program with a writing form: `sed -i` rewrites the file, `awk -i inplace` (gawk) does the same,
// `find -delete`/`-exec` change or run things, and `sort -o` writes its output to a file. The flag decides, not the
// program.
const MUTATING: readonly [string, RegExp][] = [
  ["sed", /(^|\s)-{1,2}(i\b|i\.\w|in-place\b)/],
  ["awk", /(^|\s)-{1,2}(i\b|in-place\b)/],
  ["find", /(^|\s)-(delete|exec|execdir|ok|fprint)\w*/],
  ["sort", /(^|\s)-{1,2}(o\S*|output)/],
]
// git's read subcommands. Everything else (add, commit, checkout, reset, stash, push, fetch, …) writes, so an
// unknown subcommand is a write: the list is a whitelist, not a blacklist.
const GIT_READS = new Set(["status", "diff", "log", "show", "branch", "ls-files", "rev-parse", "blame"])
// Global git flags that carry a value: the subcommand only starts after them.
const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"])
const VERSION = /^\S+\s+(--version|-V|version)\b/
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const REDIRECT = /(^|\s)(\d?>>?|&>)\s*(\/dev\/null|&\d|\d)/
// A redirect to a real path writes it, so it belongs to a write even when the program only reads.
const WRITING_REDIRECT = /(^|\s)(\d?>>?|&>)\s*(?!\/dev\/null\b|&\d\b|\d\b)\S/

// Wrappers that only run the command behind them. Their own arguments are dropped so the wrapped command decides:
// `timeout 120 pytest` is a write (pytest reads nothing), `timeout 120 git status` a read. `env` is in the list
// because `env rm -rf …` runs rm; a bare `env` prints the environment and stays a read.
const TIMEOUT_VALUE_FLAGS = new Set(["-k", "--kill-after", "-s", "--signal"])
const WRAPPERS: Record<string, (args: readonly string[]) => number> = {
  timeout: (args) => {
    let i = 1
    while (i < args.length && (args[i] ?? "").startsWith("-")) i += TIMEOUT_VALUE_FLAGS.has(args[i]!) ? 2 : 1
    return i + 1 // the duration, then the command
  },
  nohup: (args) => (args[1]?.startsWith("--") ? 2 : 1),
  nice: (args) => (args[1] === "-n" ? 3 : args[1]?.startsWith("-") ? 2 : 1),
  stdbuf: (args) => (args[1] && /^-[ioe]$/.test(args[1]) ? 3 : args[1]?.startsWith("-") ? 2 : 1),
  env: (args) => {
    let i = 1
    while (i < args.length && (ENV_ASSIGNMENT.test(args[i] ?? "") || (args[i] ?? "").startsWith("-"))) i++
    return i
  },
}

// The command that actually runs, behind any wrapper and any leading VAR=value assignments.
function unwrap(tokens: readonly string[]): readonly string[] {
  let rest = tokens
  for (;;) {
    while (rest.length > 0 && ENV_ASSIGNMENT.test(rest[0] ?? "")) rest = rest.slice(1)
    const program = (rest[0] ?? "").replace(/^.*\//, "")
    const consumed = WRAPPERS[program]?.(rest) ?? 0
    if (consumed <= 0 || consumed >= rest.length) return rest
    rest = rest.slice(consumed)
  }
}

// Where git's subcommand starts, behind the global flags: `git -C /repo status`, `git --no-pager diff`,
// `git -c user.name=x commit`.
function gitSubcommand(tokens: readonly string[]): number {
  let i = 1 // tokens[0] is git
  while (i < tokens.length && (tokens[i] ?? "").startsWith("-")) {
    i += GIT_VALUE_FLAGS.has(tokens[i]!) && !(tokens[i] ?? "").includes("=") ? 2 : 1
  }
  return i
}

// git reads when its subcommand only reads. `remote` and `branch` read while they only look: `git branch new`
// creates one and `git remote add` writes, so a bare word behind them is a write.
function gitReads(tokens: readonly string[], at: number): boolean {
  const sub = tokens[at] ?? ""
  if (sub === "remote" || sub === "branch") return tokens.slice(at + 1).every((token) => token.startsWith("-"))
  return GIT_READS.has(sub)
}

// One `&&`, `||`, `;` or `|` step of a command line: every step has to read for the line to read. Splitting after the
// redirects are stripped, so `2>&1` is not an `&&`.
export function segments(command: string): string[] {
  return command
    .trim()
    .split(/(?:&&|\|\||;|\|)/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function readsSegment(segment: string): boolean {
  // A command substitution can hide anything, so a line that carries one is not classified as a read.
  if (/\$\(|`/.test(segment)) return false
  if (WRITING_REDIRECT.test(segment)) return false
  const command = segment.replace(REDIRECT, "$1$2$3")
  const tokens = unwrap(command.split(/\s+/).filter(Boolean))
  const program = (tokens[0] ?? "").replace(/^.*\//, "")
  if (program === "git") {
    const at = gitSubcommand(tokens)
    return at < tokens.length && gitReads(tokens, at)
  }
  const mutating = MUTATING.find(([name]) => name === program)
  if (mutating) return !mutating[1].test(command)
  return READ_PROGRAMS.has(program) || VERSION.test(command)
}

// A shell request that only reads: every resource, and every step inside each resource, is a known reading program
// (OpenCode passes a pipe or a chain as several resources, one segment each).
export function readsOnly(commands: readonly string[]): boolean {
  return commands.length > 0 && commands.every((raw) => {
    const parts = segments(raw)
    return parts.length > 0 && parts.every(readsSegment)
  })
}

// Every absolute path the command mentions, after the same lexical normalisation readsOnly uses.
export function absolutePaths(command: string): string[] {
  return command
    .split(/\s+/)
    .map((token) => normalizeOutside(token.replace(/^--?[\w-]+=/, "")))
    .filter((token) => isAbsolute(token))
}

// A read that stays inside the job's own area: nothing can change, and the paths it names cannot leave the
// worktree, so it needs no Jev and no user. Relative paths are the worker's own directory by definition.
export function readsOnlyInside(request: PermissionRequest, root: string): boolean {
  if (request.action !== "shell") return false
  const area = normalizeOutside(root)
  if (area.length === 0) return false
  return (
    readsOnly(request.resources) &&
    request.resources.every((command) => absolutePaths(command).every((path) => under(path, area)))
  )
}

export function riskClass(request: PermissionRequest): "read" | "write" {
  if (READ_ACTIONS.has(request.action)) return "read"
  return request.action === "shell" && readsOnly(request.resources) ? "read" : "write"
}

// The job's own area: any worktree under <directory>/.jev-micromanager/worktrees/, this job's integration worktree
// included. Compared segment by segment, so a sibling that merely starts with the same name is outside.
export function inJobArea(directory: string | undefined, path: string): boolean {
  if (!directory) return false
  const area = normalizeOutside(join(directory, ".jev-micromanager", "worktrees"))
  return under(normalizeOutside(path), area)
}

// The absolute paths a task text names, `~` expanded. A named file vouches for its directory too, as the plugin's own
// reader rule does (src/plugin.ts namedInTask): a task that says "…/src/main.py" is about that directory.
const TASK_PATH = /(?:^|[\s"'`(<[])((?:~|\/)[\w.@+~-]*(?:\/[\w.@+-]+)*)/g
const NAMED_FILE = /\.[a-z0-9]{1,5}$/i

export function taskNamesPath(task: string | undefined, path: string): boolean {
  if (!task) return false
  const want = normalizeOutside(path)
  if (want.length === 0) return false
  return [...task.matchAll(TASK_PATH)]
    .map((match) => normalizeOutside(match[1] ?? ""))
    .flatMap((named) => (NAMED_FILE.test(named) ? [named, dirname(named)] : [named]))
    .some((named) => want === named || under(want, named))
}

// OpenCode asks for external_directory the same way whether a path is read or written, and riskClass() calls the
// action a write because it is not one of the reading tools. So what decides is the asking agent's role: the roles
// that change files are not reading, every other one is (the same split the plugin makes at its own layer).
function readsOutside(request: PermissionRequest): boolean {
  if (riskClass(request) === "read") return true
  return !WRITERS.has(roleByAgent(request.agent)?.id ?? "code")
}

// Layer 2 and 3 of the external_directory policy: the job's own area is mechanical, everything else is the user
// unless the task names the path and nothing is written to it. Vouching for a path is not vouching for a write.
export function externalVerdict(request: PermissionRequest): Outcome | undefined {
  if (request.action !== "external_directory" || request.resources.length === 0) return undefined
  if (request.resources.every((path) => inJobArea(request.directory, path))) {
    return { verdict: "allow", reason: "inside the job's own worktrees" }
  }
  if (readsOutside(request) && request.resources.every((path) => taskNamesPath(request.task, path))) {
    return { verdict: "allow", reason: "a read of a directory the task names" }
  }
  return undefined
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
    request.agent === MICROMANAGER.agent ? `It is the orchestrator: ${MICROMANAGER.description}` : "",
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
//
// root: the job's worktree (or the project root), where a read needs nobody. It defaults to the request's own
// directory so a caller that knows nothing more still gets the fast path.
export async function decide(
  jev: Jev | undefined,
  request: PermissionRequest,
  floors: Floors = DEFAULT_FLOORS,
  inspect: Inspect = inspectPaths,
  preset?: "allow" | "deny" | "user",
  root: string | undefined = request.directory,
): Promise<Outcome> {
  const rule = hardRule(request)
  if (rule) return { verdict: "user", reason: `always the user: ${rule}` }
  // A read-only command inside the job's own worktree: it changes nothing and names no path outside, and Jev's own
  // confidence on these sits under the read floor, so asking it only turned a worker's inspection into a denial.
  // A preset that sends this kind of request to the user still wins: it is the user's own decision.
  const presetRules = preset === "user" || preset === "deny"
  if (!presetRules && request.action !== "external_directory" && root !== undefined && readsOnlyInside(request, root)) {
    return { verdict: "allow", reason: "read-only command inside the job's worktree" }
  }
  const outside = presetRules ? undefined : externalVerdict(request)
  if (outside) return outside
  // Layer 3: anything else outside the project is the user's, as it was before the layers existed (a preset never
  // reached this far either: an ask outside the project was never the policy's to answer).
  if (request.action === "external_directory") {
    return { verdict: "user", reason: "always the user: access outside the project" }
  }
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
