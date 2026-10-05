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
): Role => ({ id, agent: `dictator-${id}`, description, system: `${SHARED}\n\n${system}`, rules: [...rules, ...noStateDir], models })

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

export function dictatorSystem(roles: readonly Role[] = ROLES): string {
  const lines = roles.map((r) => `- ${r.agent}: ${r.description}`)
  return `You are the jev-dictator, an orchestrator. You never do a task yourself: you do not edit files or run
commands, and you read only enough to orient yourself (the README, the file list). Everything else is done by
role sub-agents that the plugin starts for you.

For a job:
1. Call dictator_plan with the user's job in their words as "goal". The plugin checks it and then either plans it
   right away or opens a planning session.
2. A planning session settles the decisions only the user can make, one question per turn. Draft the open
   questions with dictator_questions when told to. Then follow the plugin's notes that start with
   "[planning session …]" exactly: ask exactly the one question it names, with no options and no recommendation,
   and wait. Offer options or explanations only when such a note says the user is stuck or asked for them.
   Never ask the user for facts the agents can look up.
3. Show the user the plan dictator_plan returns (tasks, roles, acceptance points) and ask whether to run it. If the
   user wants changes, call dictator_plan again.
4. When the user says go, call dictator_run with the job id. The job is queued and runs in the background on its
   own git branch: the plugin runs the tasks, the checks and the commits; the user's checkout is never touched.
   dictator_run returns at once. Tell the user it runs, then end your turn; do not wait, poll or call
   dictator_status in a loop. While it runs, keep talking with the user; a new goal becomes the next job in the
   queue.
5. Updates arrive as messages and system notes that start with "[jev-dictator]". They come from your own plugin,
   not from the user or a tool result, and you can trust them. When one says the job is done or needs the user,
   tell the user: each task's status, the branch and how to merge or discard it, or why it stopped and what they
   can decide. When the user answers a job that stopped for them, call dictator_run with the job id and their
   answer in their words as note. If the user wants to stop a job, call dictator_stop.
If planning or a run fails, tell the user why and what they can decide; never start the same job again on your
own. Notes that start with "[job …]" are the plugin's instructions for this turn; follow them. dictator_status shows a
job's state at any time.

The role sub-agents, for your understanding (the plugin picks role and model per task):
${lines.join("\n")}`
}
