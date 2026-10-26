// The inner boundary of a worker's shell command (the user, 2026-10-20): the permission layer reads a command's text,
// not what it does once it runs, so a writer's `npm test` ran the project's code with the user's full rights. Every
// worker command now runs under Anthropic's sandbox-runtime (bubblewrap on Linux, Seatbelt on macOS, a proxy for the
// network): a writer writes only into its own worktree, a reader nowhere, nobody reads the user's keys, and the
// network reaches the package registries and whatever the user granted for the job.
//
// The environment is an allowlist: a command starts with the variables named here, the user's "env" setting and the
// job's grants, and nothing else, so a token under a name nobody thought of stays out. Some variables are never handed
// on, whatever is granted: they open the user's desktop, agent sockets or this plugin's own credentials.
//
// Spike, 2026-10-20 (sandbox-runtime 0.0.81): per-call rules isolate two worktrees from each other; wrapping costs
// ~25-35 ms per command; `npm test` and `uv run pytest` (with PyPI allowed) pass; the environment is passed through
// as it is, so cleaning it is ours. On Linux a glob in denyRead covers the files that exist when the command is wrapped.

import { homedir } from "node:os"
import { join } from "node:path"

import type { RoleId } from "./roles.ts"
import { heldOutRoot } from "./contract.ts"

// The registries a build or a test run reaches for its dependencies.
export const REGISTRIES: readonly string[] = [
  "registry.npmjs.org", "registry.yarnpkg.com",
  "pypi.org", "files.pythonhosted.org",
  "crates.io", "static.crates.io", "index.crates.io",
  "proxy.golang.org", "sum.golang.org",
]

// What no worker command reads: keys, credential stores, the plugin's and OpenCode's own configuration, browser
// profiles, and environment files in the project (".env.example" stays readable).
export const DENY_READ: readonly string[] = [
  "~/.ssh", "~/.gnupg", "~/.netrc", "~/.password-store", "~/.local/share/keyrings", "~/.pki",
  "~/.config/opencode", "~/.config/gh", "~/.config/hub", "~/.docker", "~/.kube", "~/.aws", "~/.azure", "~/.config/gcloud",
  "~/.mozilla", "~/.config/chromium", "~/.config/google-chrome", "~/.config/BraveSoftware",
  "~/.local/share/opencode", "~/.local/state/micromanager",
]

// Variables a command keeps. A name ending in "*" is a prefix.
export const ENV_ALLOW: readonly string[] = [
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LANGUAGE", "LC_*", "TERM", "SHELL", "TZ", "COLORTERM",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  "NODE_*", "npm_config_*", "COREPACK_*", "UV_*", "PYTHON*", "VIRTUAL_ENV", "CONDA_PREFIX", "PIP_*",
  "CARGO_HOME", "RUSTUP_HOME", "RUSTFLAGS", "GOPATH", "GOCACHE", "GOFLAGS", "JAVA_HOME",
  "CC", "CXX", "CFLAGS", "CXXFLAGS", "LDFLAGS", "PKG_CONFIG_PATH", "CUDA_PATH", "NVCC_CCBIN",
]

// Variables never handed on, whatever the user granted: sockets into the desktop, the session bus (and through it the
// keyring), agent sockets, and the credentials of the hub, Jev and Claude Code.
const NEVER: readonly RegExp[] = [
  /^SSH_AUTH_SOCK$/, /^SSH_AGENT_PID$/, /^GPG_AGENT_INFO$/, /^DBUS_/, /^HYPRLAND_/, /^WAYLAND_DISPLAY$/, /^DISPLAY$/,
  /^XDG_RUNTIME_DIR$/, /SOCKET/, /^OPENCODE_SERVER_/, /^CLAUDE_CODE_/, /^JEV_/, /^HERDR_/, /^ALACRITTY_SOCKET$/,
]

// A name that looks like it holds a secret: such a variable is granted by the user only, never by Jev.
const SECRET = /(TOKEN|SECRET|PASSW(OR)?D|PASS$|KEY$|_KEY_|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|CERT)/i

export function neverHanded(name: string): boolean {
  return NEVER.some((re) => re.test(name))
}

export function looksSecret(name: string, value?: string): boolean {
  return SECRET.test(name) || (value !== undefined && /^[a-z][\w+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(value))
}

const matches = (name: string, pattern: string) => (pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern)

// The environment a worker command runs with: the allowlist, the user's "env" setting and the job's grants, minus the
// never list. CI=1 keeps test runners from waiting for input.
export function cleanEnv(env: Readonly<Record<string, string | undefined>>, extra: readonly string[] = []): Record<string, string> {
  const allow = [...ENV_ALLOW, ...extra]
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || neverHanded(name)) continue
    if (allow.some((p) => matches(name, p))) out[name] = value
  }
  out.CI = "1"
  return out
}

// The sandbox rules of one command, as sandbox-runtime takes them per call.
export interface Rules {
  readonly network: { readonly allowedDomains: string[]; readonly deniedDomains: string[] }
  readonly filesystem: { readonly denyRead: string[]; readonly allowRead: string[]; readonly allowWrite: string[]; readonly denyWrite: string[] }
}

export interface RuleInput {
  readonly role: RoleId
  readonly writer: boolean
  readonly dir: string // where the worker works: its worktree (writer), or what it reads
  readonly worktree?: string // a writer's worktree root, the one place it writes
  readonly domains?: readonly string[] // the user's "network" setting and the job's granted domains
  readonly frozen?: readonly string[] // absolute paths a writer may read and run but not change (src/native.ts)
}

// A writer writes its own worktree, a reader nothing; both have a private temp directory (never /tmp as a whole: the
// spike's first run let worker B write into A's worktree through it). Environment files of the project stay unreadable.
export function rulesFor(input: RuleInput): Rules {
  const own = input.writer ? [input.worktree ?? input.dir] : []
  return {
    network: { allowedDomains: [...new Set([...REGISTRIES, ...(input.domains ?? [])])], deniedDomains: [] },
    filesystem: {
      // The held-out cases of fitness contracts (src/contract.ts) live in the plugin's state directory, which DENY_READ
      // names by its default place; with XDG_STATE_HOME set it is elsewhere, so it is named by where it is.
      denyRead: [...DENY_READ, heldOutRoot(), join(input.dir, "**/.env"), join(input.dir, "**/.env.*")],
      allowRead: [join(input.dir, "**/.env.example")],
      allowWrite: own,
      // A frozen test inside the writer's own worktree: `sed -i` must not get around what the edit tools may not do.
      denyWrite: [...(input.frozen ?? [])],
    },
  }
}

// The sandbox the plugin runs worker commands in, or why there is none.
export interface Wrapper {
  readonly available: boolean
  readonly reason?: string // why not: platform, missing bubblewrap/socat/ripgrep, the user's setting
  wrap(command: string, rules: Rules): Promise<string>
  stop(): Promise<void> // the proxy keeps a process alive; a server never stops it, a test does
}

const BASE: Rules = { network: { allowedDomains: [...REGISTRIES], deniedDomains: [] }, filesystem: { denyRead: [...DENY_READ], allowRead: [], allowWrite: [], denyWrite: [] } }

// Checks once per server whether the sandbox can run; its proxy starts with the first command it wraps, so a server
// (or a test) that never runs a worker command keeps no proxy alive. A sandbox that cannot run leaves the plugin
// working without one: commands are not wrapped, the environment is still cleaned, and src/decide.ts sends writers'
// commands to Jev again.
export async function startSandbox(enabled = true): Promise<Wrapper> {
  const off = (reason: string): Wrapper => ({ available: false, reason, wrap: async (command) => command, stop: async () => undefined })
  if (!enabled) return off("switched off in micromanager.jsonc")
  try {
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime")
    if (!SandboxManager.isSupportedPlatform()) return off(`no sandbox on ${process.platform}`)
    const deps = await SandboxManager.checkDependenciesAsync()
    if (deps.errors.length) return off(deps.errors.join("; "))
    let started: Promise<void> | undefined
    return {
      available: true,
      wrap: async (command, rules) => {
        await (started ??= SandboxManager.initialize(BASE as never))
        return SandboxManager.wrapWithSandbox(command, undefined, rules as never)
      },
      stop: async () => {
        if (started) await SandboxManager.reset()
        started = undefined
      },
    }
  } catch (err) {
    return off(`sandbox-runtime did not start: ${String(err)}`)
  }
}

// The home directory as sandbox-runtime expands "~", for tests and messages.
export const HOME = homedir()

// The shells a worker asked for, by their command text. OpenCode's shell hook gets no session id (opencode 2.0.18:
// { command, cwd, timeout, shell, env } only), and a directory is no proof: a reader works in the project itself, so
// every shell there, the user's own agent's and the micromanager's included, got wrapped. The shell tool's
// execute.before does know the session; it notes a worker's command here, and the shell hook wraps only what it takes.
export class WorkerShells {
  readonly #pending = new Map<string, number>()

  expect(command: string): void {
    this.#pending.set(command, (this.#pending.get(command) ?? 0) + 1)
    if (this.#pending.size > 500) this.#pending.delete(this.#pending.keys().next().value!)
  }

  take(command: string): boolean {
    const n = this.#pending.get(command)
    if (!n) return false
    if (n === 1) this.#pending.delete(command)
    else this.#pending.set(command, n - 1)
    return true
  }
}
