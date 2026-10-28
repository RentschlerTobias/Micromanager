// Every permission request goes to Jev first. Jev answers it itself when it is sure enough for the request's
// risk and nothing says the user must decide; everything else goes to the user unchanged.
//
// Order: hard rules (never automatic) -> the job's own area -> Jev -> floors per risk class. Without Jev (no key,
// an error) the request goes to the user: nothing is decided on a guess.
//
// A shell request that only reads inside the job's own worktree skips Jev entirely (readsOnlyInside): a worker
// cannot change anything with it, and its own confidence on `git status --porcelain` (0.75) sits below the read
// floor (0.80), so asking only turned inspection into denials. A writer's command that stays in its own task worktree
// skips Jev too (staysInWorktree), and a reader's command that does not only read is refused without asking.
//
// external_directory is layered, not a blanket "never":
//   1. a hard rule no layer can pass: the user's keys and credential stores, their home itself, the system
//      directories, the secret files inside ~/.config, another job's branch in the repository's own git data. The
//      user's `allowOutside` setting is the one thing that lifts it, and only for the paths it names (below);
//   2. the job's own area: any worktree under <project>/.jev-micromanager/worktrees/, this job's integration
//      worktree included. Path-based, never a substring: `worktrees-old` is not `worktrees`;
//   3. task-vouched: a path the task text names with its full path, for a read only (a named path is a vouch for
//      reading it, not for changing it);
//   4. everything else is the user, as it always was.

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, normalize } from "node:path"

import type { Decision, Jev, Question } from "./jev.ts"
import { WRITERS } from "./profile.ts"
import { MICROMANAGER, roleByAgent } from "./roles.ts"
import { stateDir } from "./store.ts"

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

// Never decided by Jev, whatever it says. The user's allowOutside is passed to every test, so a path the user named
// falls through to the layers below instead of stopping here.
const ALWAYS_USER: readonly { readonly test: (r: PermissionRequest, allowed: readonly string[]) => boolean; readonly why: string }[] = [
  {
    test: (r, allowed) => r.action === "external_directory" && r.resources.some((p) => forbiddenOutside(p, allowed)),
    why: "a path no layer may allow",
  },
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
// Directories outside the project that no layer may allow, each named with what it holds. These are refused whole
// because nearly everything inside them is a secret, so a per-file rule would be theatre: .ssh, .aws and .gnupg are
// private keys, .netrc and the keyring are logins, .password-store is a password database.
//
// ~/.config is deliberately NOT on this list. It holds application configuration as much as tokens — 61 application
// directories on the user's own machine and not one file matching the names the old whole-directory ban claimed to
// protect — and refusing it whole made a real task impossible (2026-10-07: a worker could not read
// ~/.config/omarchy/shell.json for the plugin id that decides whether a system service restarts in a loop). What is
// refused there is the secret files themselves, below, at the granularity that actually protects them.
const FORBIDDEN_OUTSIDE: readonly { readonly dir: string; readonly what: string }[] = [
  { dir: join(HOME, ".ssh"), what: "the user's keys in ~/.ssh" },
  { dir: join(HOME, ".aws"), what: "the user's AWS credentials in ~/.aws" },
  { dir: join(HOME, ".gnupg"), what: "the user's GPG keys in ~/.gnupg" },
  { dir: join(HOME, ".password-store"), what: "the user's password store in ~/.password-store" },
  { dir: join(HOME, ".local", "share", "keyrings"), what: "the user's keyring in ~/.local/share/keyrings" },
  { dir: join(HOME, ".netrc"), what: "the user's login credentials in ~/.netrc" },
  // The system itself. /var and /sys stay whole on purpose: they are read-mostly, so refusing them costs a worker
  // little (nothing a task needs lives only there, and a reading tool asks about a file it names), while narrowing
  // them to a file list would mean guessing at every package's and the kernel's own state files.
  { dir: "/etc", what: "the system directory /etc" },
  { dir: "/usr", what: "the system directory /usr" },
  { dir: "/boot", what: "the system directory /boot" },
  { dir: "/var", what: "the system directory /var" },
  { dir: "/proc", what: "the system directory /proc" },
  { dir: "/sys", what: "the system directory /sys" },
]

// The secret files inside ~/.config, matched case-insensitively against the LAST path segment only. The segment is the
// point: `*token*` is a rule about a file's own name (huggingface_token, .netrc_token, a service-token.json), not about
// a directory that happens to contain the word somewhere in its parents — a directory called token-store is a config
// directory, and refusing it would reproduce the bug this list replaces.
const SECRET_IN_CONFIG: readonly RegExp[] = [
  /^auth\.json$/, // opencode's own stored credentials
  /^credentials(\..*)?$/, // ~/.aws/credentials' shape, and the git-credential-store default
  /^\.credentials$/, // python keyring's file of the same name
  /^hosts\.yml$/, // the GitHub CLI's token store
  /^logins\.json$/, // a Firefox profile's saved logins
  /^key[34]\.db$/, // Firefox's own key databases
  /\.kdbx$/, // keepass databases
  /token/, // huggingface_token, *-token.json, .token
  /_token$/, // the explicit spelling of the same, kept so the rule reads as one rule per convention
  /\.secret$/, // *.secret, and npm's own .npmrc-adjacent secrets
  /^secrets\./, // secrets.json, secrets.yaml, secrets.toml
]

// Another job's worktree metadata and branches live under .git/; a worker never reaches them, whatever its task says.
const GIT_DATA = /(^|\/)\.git\/(worktrees|refs)\//

// What the journal and the refusal messages call the user's own setting, so every layer words it the same way.
export const ALLOW_OUTSIDE_REASON = "the user's allowOutside setting"

// What the journal says when the user opened one refused path for one job, and when they turned it down. Both name the
// user on purpose: a record that only said "allowed" or "denied" would read as though nothing had ever been wrong,
// and an operator reading the journal after the fact could not tell a rule from an exception to it.
export const GRANT_OUTSIDE_REASON = "the user opened this path for this job"
export const REFUSED_OUTSIDE_REASON = "the user refused this path for this job"

// The user's own `allowOutside` setting: absolute paths or path prefixes the user has decided a worker may reach, even
// where the rules above refuse. Matching is on whole segments like every other path rule here, so an entry never opens
// a sibling that merely shares its name (/home/u/.config-x is not /home/u/.config), and the entries are compared
// through the same normalisation, so `~`, a trailing slash and `..` cannot smuggle a path past a rule.
export function allowedOutside(resource: string, allowed: readonly string[] = []): boolean {
  const path = normalizeOutside(resource)
  if (path.length === 0 || path === ".") return false
  return allowed.some((entry) => {
    const base = normalizeOutside(entry)
    return base.length > 0 && under(path, base)
  })
}

// `~` expanded, a trailing `/*` or `/` dropped, `..` resolved lexically. No filesystem access: a path that does not
// exist yet has to be classified the same way as one that does.
//
// Exported because a grant the user gave is remembered as a path, and the only thing that may decide whether a later
// request is "the same path" is the same normalisation the rules use. A second copy here would drift from it.
export function normalizeOutside(path: string): string {
  const trimmed = path.trim()
  const bare = trimmed.replace(/\/+$/, "").replace(/(?<=[^/])\/\*+$/, "")
  const expanded = bare === "~" ? HOME : bare.startsWith("~/") ? join(HOME, bare.slice(2)) : bare
  return expanded.length === 0 ? trimmed : normalize(expanded)
}

function under(path: string, base: string): boolean {
  if (base === "/") return path.startsWith("/")
  return path === base || path.startsWith(`${base}/`)
}

// The user's own `allowOutside`, checked first: it is the one thing that lifts the rules below, and it is only ever the
// user's own list, never a task's or a vouch's. A refusal that survives it survives everything.
export function forbiddenOutside(resource: string, allowed: readonly string[] = []): boolean {
  if (allowedOutside(resource, allowed)) return false
  const path = normalizeOutside(resource)
  if (path === "/") return true // the whole file system
  if (path.length === 0 || path === ".") return false
  // The home directory itself stays refused whatever the per-path rules above say: a request for `~` is a request to
  // sweep everything in it at once, and the rules for its subdirectories are no answer to that. Naming `~` in
  // allowOutside is the one way past it, and only because the user wrote it down.
  if (path === HOME) return true
  if (FORBIDDEN_OUTSIDE.some((f) => under(path, f.dir))) return true
  // ~/.config is not refused whole; its secret files are, by name, last segment only.
  if (under(path, join(HOME, ".config")) && SECRET_IN_CONFIG.some((pattern) => pattern.test(basename(path).toLowerCase()))) return true
  return GIT_DATA.test(path)
}

// Why a refusal is written down with, or undefined when nothing refuses the path: what the rule protects, and for a
// secret file the file's own name, so a worker is told which file was the problem rather than being told about a whole
// directory. undefined rather than a wrong sentence, so a caller cannot put a reason on a path no rule refused.
export function forbiddenOutsideWhat(resource: string): string | undefined {
  const path = normalizeOutside(resource)
  if (path === "/") return "the whole file system"
  if (path === HOME) return "the home directory itself"
  const dir = FORBIDDEN_OUTSIDE.find((f) => under(path, f.dir))
  if (dir) return dir.what
  const config = join(HOME, ".config")
  if (under(path, config)) {
    const name = basename(path).toLowerCase()
    if (SECRET_IN_CONFIG.some((pattern) => pattern.test(name))) return `${name}, a credential file in ~/.config`
  }
  if (GIT_DATA.test(path)) return "another job's branches and worktree metadata in the repository's own git data"
  return undefined
}

export function hardRule(request: PermissionRequest, allowed: readonly string[] = []): string | undefined {
  return ALWAYS_USER.find((rule) => rule.test(request, allowed))?.why
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
const GIT_READS = new Set([
  "status", "diff", "log", "show", "branch", "ls-files", "rev-parse", "blame", "ls-tree", "cat-file", "merge-base",
  "describe", "for-each-ref", "shortlog", "rev-list", "diff-tree", "whatchanged", "name-rev", "var", "count-objects",
  "show-ref", "check-ignore", "check-attr", "grep",
])
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
  const rest = tokens.slice(at + 1)
  if (sub === "remote" || sub === "branch") return rest.every((token) => token.startsWith("-"))
  if (sub === "worktree") return rest[0] === "list"
  if (sub === "reflog") return rest.length === 0 || rest[0] === "show" || rest[0]!.startsWith("-")
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

// The task worktree a directory lies in (<project>/.micromanager/worktrees/<job>--T<id>, or .jev-micromanager in a
// project from before the rename), or undefined. Only a task's
// own worktree, never the job's integration worktree: that one is the merge train's target and the readers' tree, so
// nothing may change it outside a merge. A project inside a larger repository works in <worktree>/<rel>; the area is
// the whole worktree either way.
const TASK_WORKTREE = /^(.*\/\.(?:jev-)?micromanager\/worktrees\/[^/]+--T[\w.]+)(?:\/|$)/

export function taskWorktree(directory: string | undefined): string | undefined {
  return directory ? normalizeOutside(directory).match(TASK_WORKTREE)?.[1] : undefined
}

// Programs whose effect reaches past the worktree whatever their arguments say: other processes, services, the
// network, the desktop, the user's accounts.
const BEYOND_WORKTREE = new Set([
  "kill", "pkill", "killall", "systemctl", "journalctl", "loginctl", "crontab", "at", "docker", "podman", "ssh", "scp",
  "sftp", "rsync", "curl", "wget", "nc", "ncat", "socat", "shutdown", "reboot", "poweroff", "mount", "umount", "chown",
  "su", "doas", "xdg-open", "open", "notify-send", "hyprctl", "gh", "flatpak", "snap",
])
// git inside a worktree: reading, and changing the working tree and the index. The refs, the stash and the config are
// shared with the user's checkout and every other worktree, so commit, checkout, branch, reset, stash, fetch, … stay Jev's.
// `branch` and `remote` are left to gitReads, which tells `git branch` from `git branch -D x` by the arguments.
const GIT_IN_WORKTREE = new Set([...[...GIT_READS].filter((sub) => sub !== "branch" && sub !== "remote"), "add", "restore", "rm", "mv", "apply", "grep", "check-ignore", "ls-tree", "cat-file"])
const PUBLISH = /\b(npm|pnpm|yarn|cargo|twine|gem|poetry|uv)\s+(publish|upload|login|adduser)\b/
// Paths outside the worktree that a command may still name: scratch space and the standard streams.
const SCRATCH = ["/tmp", "/dev/null", "/dev/stdout", "/dev/stderr"]

// A command a writer runs in its own task worktree that stays there: every path it names is inside the worktree or
// scratch space, it names no home directory, and no step is a program that acts beyond the tree (processes, services,
// network, publishing) or a git command that moves shared refs. What it does is the worker's business: the worktree is a
// throwaway checkout, and only the task's checks and the merge train bring its content anywhere. This judges the command
// line, not what a program does once it runs, exactly as the test-runner allow rules do: running the project's own code
// is what a writer is for.
//
// cwd is the directory the worker runs in, which for a project below the repository root is <worktree>/<rel>: a `..`
// there can stay in the worktree (`../.venv/bin/python`), so a relative path is resolved against it. A `cd` anywhere in
// the request makes that guess unsafe, and then any `..` leaves the fast path.
export function staysInWorktree(request: PermissionRequest, worktree: string, cwd: string = worktree): boolean {
  if (request.action !== "shell" || request.resources.length === 0) return false
  const area = normalizeOutside(worktree)
  if (area.length === 0) return false
  const allowed = (path: string) => under(path, area) || SCRATCH.some((dir) => path === dir || under(path, dir))
  const moves = request.resources.some((command) => segments(command).some((segment) => /^cd(\s|$)/.test(segment)))
  // One argument as a path, or undefined when it is none. A lone "/" or "//" is a division or a comment in inline code
  // (`node -e '… r) / f'`, live run 2026-10-13) or a pattern (`grep -E "^ /"`), never a path a command works in.
  const pathOf = (token: string): string | undefined => {
    const value = token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token
    const bare = value.replace(/^['"(]+|['",;)]+$/g, "")
    if (/^\/+$/.test(bare)) return undefined
    if (isAbsolute(bare)) return normalizeOutside(bare)
    if (/(^|\/)\.\.(\/|$)/.test(bare)) return moves ? "/" : normalize(join(cwd, bare))
    return undefined
  }
  return request.resources.every((command) => {
    if (PUBLISH.test(command)) return false
    if (/(^|[\s"'=:])(~|\$\{?HOME\b)/.test(command)) return false
    return segments(command).every((segment) => {
      const tokens = unwrap(segment.split(/\s+/).filter(Boolean))
      const program = (tokens[0] ?? "").replace(/^.*\//, "")
      if (BEYOND_WORKTREE.has(program) || program.startsWith("omarchy")) return false
      if (program === "git") {
        const at = gitSubcommand(tokens)
        if (!GIT_IN_WORKTREE.has(tokens[at] ?? "") && !gitReads(tokens, at)) return false
      }
      // The program itself may live anywhere (/usr/bin/python3); its arguments may not.
      return tokens.slice(1).every((token) => {
        const path = pathOf(token)
        return path === undefined || allowed(path)
      })
    })
  })
}

export function riskClass(request: PermissionRequest): "read" | "write" {
  if (READ_ACTIONS.has(request.action)) return "read"
  return request.action === "shell" && readsOnly(request.resources) ? "read" : "write"
}

// The job's own area: any worktree under <directory>/.micromanager/worktrees/ (src/store.ts stateDir), this job's integration worktree
// included. Compared segment by segment, so a sibling that merely starts with the same name is outside.
export function inJobArea(directory: string | undefined, path: string): boolean {
  if (!directory) return false
  const area = normalizeOutside(join(directory, stateDir(directory), "worktrees"))
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

// Layer 2 and 3 of the external_directory policy: the job's own area is mechanical, the user's own allowOutside is
// their standing decision, everything else is the user unless the task names the path and nothing is written to it.
// Vouching for a path is not vouching for a write.
//
// The allowOutside reason names the setting on purpose. A record that said only "allowed" would leave an operator
// asking whether anything was wrong with the request; this one says the user's own policy opened it.
export function externalVerdict(request: PermissionRequest, allowed: readonly string[] = []): Outcome | undefined {
  if (request.action !== "external_directory" || request.resources.length === 0) return undefined
  if (request.resources.every((path) => inJobArea(request.directory, path))) {
    return { verdict: "allow", reason: "inside the job's own worktrees" }
  }
  if (request.resources.every((path) => allowedOutside(path, allowed))) {
    return { verdict: "allow", reason: ALLOW_OUTSIDE_REASON }
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
//
// allowed: the user's own `allowOutside` setting, the paths they decided a worker may reach. It is threaded into the
// hard rules (forbiddenOutside) and into the external_directory layers, never asked about: it is a decision the user
// already made in the config, not one for Jev to re-litigate per request. Default empty: with no setting, a caller's
// behaviour is exactly what it was before the setting existed.
export async function decide(
  jev: Jev | undefined,
  request: PermissionRequest,
  floors: Floors = DEFAULT_FLOORS,
  inspect: Inspect = inspectPaths,
  preset?: "allow" | "deny" | "user",
  root: string | undefined = request.directory,
  allowed: readonly string[] = [],
  // Whether the worker's commands run in the sandbox (src/sandbox.ts). Without it a writer's command in its worktree
  // is no longer allowed on its text alone: what the program does is unchecked, so Jev is asked as before.
  sandboxed = true,
): Promise<Outcome> {
  const rule = hardRule(request, allowed)
  if (rule) return { verdict: "user", reason: `always the user: ${rule}` }
  // A read-only command inside the job's own worktree: it changes nothing and names no path outside, and Jev's own
  // confidence on these sits under the read floor, so asking it only turned a worker's inspection into a denial.
  // A preset that sends this kind of request to the user still wins: it is the user's own decision.
  const presetRules = preset === "user" || preset === "deny"
  if (!presetRules && request.action !== "external_directory" && root !== undefined && readsOnlyInside(request, root)) {
    return { verdict: "allow", reason: "read-only command inside the job's worktree" }
  }
  // A writer's own task worktree is its sandbox. Asking Jev there turned a worker's verification into denials (live
  // runs: 478 "Jev unsure" refusals on writes, among them `npm test`, a render, a screenshot and `git restore` in a
  // worktree nobody else uses), and a worker that cannot check its work cannot finish it. Deleting a tracked file there
  // is allowed too: git has it, and the task's diff shows it before anything merges.
  const role = roleByAgent(request.agent)?.id
  if (!presetRules && request.action === "shell" && role !== undefined) {
    const worktree = WRITERS.has(role) ? taskWorktree(root) : undefined
    if (sandboxed && worktree && staysInWorktree(request, worktree, root)) {
      return { verdict: "allow", reason: "a command inside the task's own worktree" }
    }
    // A reader's shell asks about every command its rules do not list, so that a chain of reading programs reaches the
    // read-only check above instead of a flat deny. What does not read is refused here, with the reason, and Jev is
    // not asked to decide whether a role that only reads may write.
    if (!WRITERS.has(role) && !readsOnly(request.resources)) {
      return { verdict: "deny", reason: `a ${request.agent} only reads, and this command changes something; run read-only commands only (no writing redirects, no sed -i), or report what you needed it for` }
    }
  }
  const outside = presetRules ? undefined : externalVerdict(request, allowed)
  if (outside) return outside
  // Layer 3: anything else outside the project is the user's, as it was before the layers existed (a preset never
  // reached this far either: an ask outside the project was never the policy's to answer).
  // A preset still wins over allowOutside, as it does over the job area and the task's own paths: the user wrote both,
  // and a per-request policy is the narrower word.
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
