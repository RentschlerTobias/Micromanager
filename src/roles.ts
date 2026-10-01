// The role matrix: what a sub-agent may do and which model it runs on.
//
// A role is an OpenCode agent the dictator delegates to with the built-in `subagent` tool. Its rights are
// permission rules (action, resource, effect) appended to the base agent's rules; in OpenCode the last
// matching rule wins, so a role's "deny" overrides the base's "allow *".

export type Effect = "allow" | "ask" | "deny"

export interface Rule {
  readonly action: string
  readonly resource: string
  readonly effect: Effect
}

export type RoleId =
  | "explore"
  | "research"
  | "plan"
  | "code"
  | "test"
  | "visual"
  | "write"
  | "debug"
  | "review"
  | "oracle"

export interface Role {
  readonly id: RoleId
  readonly agent: string // the OpenCode agent id, prefixed so it never clashes with built-in agents
  readonly description: string // shown to the dictator when it picks a sub-agent
  readonly system: string
  readonly rules: readonly Rule[]
  readonly models: readonly string[] // first model, then the fallback
}

// The only models routed to for now (user, 2026-10-01): coding, tool use + images, fast + cheap.
export const MODELS = {
  glm: "opencode-go/glm-5.3-flash",
  qwen: "opencode-go/qwen3.8-flash",
  deepseek: "opencode-go/deepseek-v4.1-flash",
} as const

// The model family, so a reviewer never checks its own family's work.
export function family(model: string): string {
  return (model.split("/").pop() ?? model).split(/[-.]/)[0] ?? model
}

const rule = (action: string, effect: Effect, resource = "*"): Rule => ({ action, resource, effect })
const WRITE_TOOLS = ["edit", "write", "patch"] as const
const WEB_TOOLS = ["webfetch", "websearch"] as const

const noWrite = WRITE_TOOLS.map((tool) => rule(tool, "deny"))
const noWeb = WEB_TOOLS.map((tool) => rule(tool, "deny"))
const noShell = [rule("shell", "deny")]
const askShell = [rule("shell", "ask")]
// Sub-agents never start sub-agents of their own: only the dictator delegates, so it can count them.
const noDelegation = [rule("subagent", "deny")]

const TEST_RUNNERS = [
  "pytest*", "python -m pytest*", "python3 -m pytest*", "uv run pytest*", "uv run python -m pytest*",
  "npm test*", "npx vitest*", "node --test*", "cargo test*", "go test*",
]
const LINTERS = ["ruff *", "uv run ruff*", "uv run pyright*", "npx tsc*", "npx eslint*"]

const SHARED = `You are a sub-agent of the jev-dictator. You get one sub-task with acceptance points.
Do only that sub-task. When you finish, answer with: what you did, which files you changed (if any), and for
each acceptance point whether it is met. If something blocks you, say what and stop; do not guess.`

const role = (
  id: RoleId,
  description: string,
  system: string,
  rules: readonly Rule[],
  models: readonly string[],
): Role => ({ id, agent: `dictator-${id}`, description, system: `${SHARED}\n\n${system}`, rules, models })

export const ROLES: readonly Role[] = [
  role(
    "explore",
    "Read-only: find code, map structure, answer where/how questions about the codebase.",
    "Search and read the codebase. Report paths and short excerpts. Change nothing.",
    [...noWrite, ...noShell, ...noWeb, ...noDelegation],
    [MODELS.deepseek, MODELS.qwen],
  ),
  role(
    "research",
    "Read-only with web access: docs, APIs, other repositories, current information.",
    "Look up documentation and sources on the web. Cite the URLs you used. Change nothing in the project.",
    [...noWrite, ...noShell, ...noDelegation],
    [MODELS.deepseek, MODELS.qwen],
  ),
  role(
    "plan",
    "Read-only: split a problem into steps with acceptance points; no code.",
    "Produce a short plan: steps, acceptance points per step, risks. Write no code.",
    [...noWrite, ...noShell, ...WEB_TOOLS.map((tool) => rule(tool, "ask")), ...noDelegation],
    [MODELS.qwen, MODELS.glm],
  ),
  role(
    "code",
    "Implements and refactors code.",
    "Implement the sub-task with the smallest change that meets the acceptance points. Match the surrounding code.",
    [...askShell, ...noWeb, ...noDelegation],
    [MODELS.glm, MODELS.qwen],
  ),
  role(
    "test",
    "Writes and runs tests.",
    "Write or update tests for the sub-task and run them. Report the exact results.",
    [...askShell, ...TEST_RUNNERS.map((cmd) => rule("shell", "allow", cmd)), ...noWeb, ...noDelegation],
    [MODELS.glm, MODELS.deepseek],
  ),
  role(
    "visual",
    "UI, CSS, layouts, screenshots (has image input).",
    "Work on the user interface. When given screenshots, describe what you see before changing anything.",
    [...askShell, ...noWeb, ...noDelegation],
    [MODELS.qwen],
  ),
  role(
    "write",
    "Docs, README, comments, commit and PR texts.",
    "Write clear, short English prose. Change only documentation files unless told otherwise.",
    [...noShell, ...noWeb, ...noDelegation],
    [MODELS.deepseek, MODELS.qwen],
  ),
  role(
    "debug",
    "Reproduces a failure and finds its cause; edits only with approval.",
    "Reproduce the failure, find the root cause, and explain it with evidence. Propose the fix before applying it.",
    [...WRITE_TOOLS.map((tool) => rule(tool, "ask")), ...askShell, ...WEB_TOOLS.map((tool) => rule(tool, "ask")), ...noDelegation],
    [MODELS.glm, MODELS.qwen],
  ),
  role(
    "review",
    "Read-only: checks a worker's result against its acceptance points; may run tests and linters.",
    `Check the result against each acceptance point. Run the tests and linters if there are any. Answer only
with JSON: {"verdict": "PASS" | "FAIL", "checks": [{"point": "...", "met": true | false, "evidence": "..."}],
"fixes": ["..."]}.`,
    [...noWrite, ...noShell, ...[...TEST_RUNNERS, ...LINTERS].map((cmd) => rule("shell", "allow", cmd)), ...noWeb, ...noDelegation],
    [MODELS.qwen, MODELS.glm], // the router picks the one of another family than the worker
  ),
  role(
    "oracle",
    "Read-only: hard decisions, architecture, trade-offs.",
    "Weigh the options for the question with evidence from the code. Give one recommendation and why.",
    [...noWrite, ...noShell, ...WEB_TOOLS.map((tool) => rule(tool, "ask")), ...noDelegation],
    [MODELS.qwen, MODELS.glm],
  ),
]

export function roleByAgent(agent: string): Role | undefined {
  return ROLES.find((r) => r.agent === agent)
}

export function roleById(id: string): Role | undefined {
  return ROLES.find((r) => r.id === id)
}

// The dictator itself: plans and delegates, never edits or runs commands. Every delegation asks the user
// first (decision 2026-10-01: each worker is confirmed individually).
export const DICTATOR = {
  agent: "dictator",
  description: "Orchestrator: splits a job into sub-tasks and delegates each to a role sub-agent.",
  rules: [...noWrite, ...noShell, ...noWeb, rule("subagent", "ask")] as readonly Rule[],
} as const

export function dictatorSystem(roles: readonly Role[] = ROLES): string {
  const lines = roles.map((r) => `- ${r.agent}: ${r.description}`)
  return `You are the jev-dictator, an orchestrator. You do not edit files or run commands yourself.

For a job:
1. Read enough of the codebase to understand it (read, glob, grep).
2. Split the job into 1-6 sub-tasks. Each has a role, acceptance points, and the sub-tasks it depends on.
3. Delegate each sub-task with the subagent tool to the matching role agent:
${lines.join("\n")}
   Put the sub-task and its acceptance points into the prompt. The model is chosen for you; do not set one.
   The user confirms each delegation; if they decline, re-plan or ask what they want.
4. Run sub-tasks one after another for now, in dependency order.
5. When all are done, give a short summary: what each sub-agent did and whether its acceptance points are met.

Trivial questions about the job you answer yourself without delegating.`
}
