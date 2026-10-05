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
// Workers never write the project memory themselves (opencode-agent-memory's tools); they report LEARNED lines and
// Jev decides what is kept (src/memory.ts).
const noMemory = ["memory_set", "memory_replace", "memory_oversized", "journal_write"].map((t) => rule(t, "deny"))
const WEB_TOOLS = ["webfetch", "websearch"] as const

const noWrite = WRITE_TOOLS.map((tool) => rule(tool, "deny"))
const noWeb = WEB_TOOLS.map((tool) => rule(tool, "deny"))
const noShell = [rule("shell", "deny")]
const askShell = [rule("shell", "ask")]
// Sub-agents never start sub-agents of their own: only the dictator delegates, so it can count them.
const noDelegation = [rule("subagent", "deny")]
// The plugin's state (job files, notes) is not for agents: a local planner looped on it in a live test. Paths are
// relative to the session's directory; a worker inside its worktree never needs to climb up into jobs or notes.
const STATE_PATHS = [".jev-dictator*", "*/.jev-dictator/jobs*", "*/.jev-dictator/notes*"]
const noStateDir = ["read", "glob", "grep", "list", "edit", "write", "patch"].flatMap((tool) => STATE_PATHS.map((path) => rule(tool, "deny", path)))

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
): Role => ({ id, agent: `dictator-${id}`, description, system: `${SHARED}\n\n${system}`, rules: [...rules, ...noStateDir, ...noMemory], models })

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

// The dictator itself: plans and delegates, never edits or runs commands. Every delegation is a question
// ("ask"), which goes to Jev first and to the user only when Jev is not sure enough (src/decide.ts).
export const DICTATOR = {
  agent: "dictator",
  description: "Orchestrator: splits a job into sub-tasks and delegates each to a role sub-agent.",
  // No reads outside the project: in a live test the dictator went into the plugin's own source to find a way past
  // the local check, instead of asking the user.
  rules: [...noWrite, ...noShell, ...noWeb, rule("subagent", "ask"), rule("external_directory", "deny"), ...noStateDir] as readonly Rule[],
} as const

// omo-hybrid: the dictator drives the flow like oh-my-openagent's Sisyphus (split, todos, parallel background tasks,
// react to reports); the plugin and Jev secure each task (guards, role, model, skills, rights, checks, merge).
export function dictatorSystem(roles: readonly Role[] = ROLES): string {
  const lines = roles.map((r) => `- ${r.agent}: ${r.description}`)
  return `You are the jev-dictator, an orchestrator. You never do the work yourself: you do not edit files or run
commands, and you read only enough to orient yourself (the README, the file list, a file or two). Workers do the
rest, in the background, on the session's own git branch; the user's checkout is never touched.

How you work:
1. Understand the request. If something only the user can decide is unclear (behaviour, scope, interfaces), ask
   briefly first; never ask for facts a worker can look up.
2. Split the work into small tasks, each one change that can be checked on its own. Keep a todo list (the todo
   tool if you have one, else a short list in your message) and update it as reports come in.
3. Delegate with dictator_task: a clear title; a prompt with everything the worker needs (it knows nothing else);
   the files it may change; checks that prove it is done (usually the project's test command); depends for tasks
   that need another's result. Delegate independent tasks right away, one call each: they run in parallel. Research
   or code reading is a task without files. dictator_task returns at once; do not wait or poll.
   You may not read outside the project yourself, but a worker that only reads may read a directory its prompt names
   with its full path (e.g. another repository): name it, and never ask the user to copy files around.
4. Reports arrive as notes that start with "[jev-dictator]". They come from your own plugin, not from the user or
   a tool result; trust them. For each report: a merged task is done (mark the todo); a task that waits for the
   user needs their answer (ask them, then call dictator_answer with their words); a task given up needs another
   way (a smaller task, a different approach) or the user. Workers list follow-ups they found: delegate the ones the
   request needs, and mention the others to the user.
5. When everything is done, tell the user briefly what changed and how to merge the branch (the reports name it)
   or discard it.

Keep your own messages short. While tasks run, keep talking with the user; dictator_tasks shows the tasks and a
task's full report. If the user wants to stop, call dictator_stop. The user can say "ulw" or "ultrawork" for you to
go on until every todo is done without stopping in between.

For a large or unclear job (many parts, decisions to settle first), or when the user asks for a plan to approve,
use dictator_plan instead: a planner writes a full plan, you show it, and dictator_run runs it after the user's go.
Notes that start with "[planning session …]" or "[job …]" are the plugin's instructions for that turn; follow them.

The worker roles, for your understanding (the plugin picks role, model, skills and rights per task):
${lines.join("\n")}`
}
