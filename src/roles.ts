// The role matrix: what a sub-agent may do and which model it runs on.
//
// A role is an OpenCode agent the micromanager delegates to with the built-in `subagent` tool. Its rights are
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
  readonly description: string // shown to the micromanager when it picks a sub-agent
  readonly system: string
  readonly rules: readonly Rule[]
  readonly models: readonly string[] // first model, then the fallback
}

// The only models routed to for now (user, 2026-10-01): coding, tool use + images, fast + cheap.
//
// space-bunny leads every chain since 2026-10-07 (the user's choice): strong on code and free, so it is the first
// model every role gets and the others are its fallback. The three cloud models stay registered because they are
// what the fallbacks use, and because `review` needs a second family — see there.
export const MODELS = {
  space: "opencode-go/space-bunny",
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
// Sub-agents never start sub-agents of their own: only the micromanager delegates, so it can count them.
const noDelegation = [rule("subagent", "deny")]
// The plugin's state (job files, notes) is not for agents: a local planner looped on it in a live test. Paths are
// relative to the session's directory; a worker inside its worktree never needs to climb up into jobs or notes.
const STATE_PATHS = [".jev-micromanager*", "*/.jev-micromanager/jobs*", "*/.jev-micromanager/notes*"]
const noStateDir = ["read", "glob", "grep", "list", "edit", "write", "patch"].flatMap((tool) => STATE_PATHS.map((path) => rule(tool, "deny", path)))

export const TEST_RUNNERS = [
  "pytest*", "python -m pytest*", "python3 -m pytest*", "uv run pytest*", "uv run python -m pytest*",
  "npm test*", "npx vitest*", "node --test*", "cargo test*", "go test*",
]
// What an explorer may run: git history and the file tree, nothing that changes anything (live test: without them a
// worker spent ten turns reading .git/ files to piece the history together). OpenCode passes each command of a chain
// as its own resource, so "git log*" does not let "git log; rm" through.
const READ_COMMANDS = [
  "git log*", "git show*", "git status*", "git diff*", "git branch*", "git ls-files*", "git grep*",
  "ls", "ls *", "tree", "tree *", "wc *",
  // Structural search; the code graph has its own tool (code_graph, src/graph.ts).
  "ast-grep run *",
]
// ast-grep run rewrites files with these; the last matching rule wins, so they beat the allow above. "sg" stays out:
// on Linux it is also the group command of shadow-utils.
const AST_GREP_WRITES = ["ast-grep * -U*", "ast-grep * --update-all*", "ast-grep * -r *", "ast-grep * --rewrite*", "ast-grep * -i*", "ast-grep * --interactive*"]
const LINTERS = ["ruff *", "uv run ruff*", "uv run pyright*", "npx tsc*", "npx eslint*"]
// Commands that change nothing and only read what the previous segment of a chain produced. OpenCode passes each command
// of a chain as its own resource, so without these a worker that may run the type-checker is refused at the first `grep`
// after it -- and, told the refusal ends its task, it gave up work it had already finished another way (live run,
// 2026-10-07: `uv run pyright | grep | sed | cut | sort | uniq` on a coder).
const PIPE_READERS = [
  "grep*", "egrep*", "rg*", "sed*", "cut*", "sort*", "uniq*", "head*", "tail*", "wc*", "tr*", "cat*", "jq*", "column*",
  "diff*", "cmp*", "xargs grep*",
]
// The forms of those that do write. The last matching rule wins, so these have to come after the allow, exactly as
// AST_GREP_WRITES does for ast-grep: placed before it, the allow would override the deny and `sed -i` would run.
const PIPE_READER_WRITES = ["sed -i*", "sed --in-place*", "sort -o*", "sort --output*", "tee*"]
// What every role that may run commands gets: the project's own test runners and linters, and the readers that shape
// their output, so a worker that may check its work can also read what the check said. Everything else stays "ask", and
// the hard rules in src/decide.ts still refuse what they refuse.
const runAndRead = [
  ...[...TEST_RUNNERS, ...LINTERS, ...PIPE_READERS].map((cmd) => rule("shell", "allow", cmd)),
  ...PIPE_READER_WRITES.map((cmd) => rule("shell", "deny", cmd)),
]
// What every role that only reads gets on the shell. The listed commands run without asking; everything else is asked,
// so it reaches the permission hook, where a command that only reads (src/decide.ts readsOnly, which knows a writing
// redirect and `sed -i` from a read) is allowed and anything else is refused with a reason. A flat deny on "*" did
// neither: live runs refused 97 reading chains (`ls -la && echo --- && find src`) with a bare "Permission denied", and a
// reviewer could not run `git diff` on the change it was asked to review.
const readShell = [
  ...askShell,
  ...READ_COMMANDS.map((cmd) => rule("shell", "allow", cmd)),
  ...AST_GREP_WRITES.map((cmd) => rule("shell", "deny", cmd)),
]
// Nobody sits at a background worker, so a question it puts up is never answered and the worker hangs on it (live runs:
// coders called it four times). What a worker cannot decide goes into its report.
const noQuestion = [rule("question", "deny")]

// What a reader is told about its shell, so it knows what runs instead of finding out from refusals.
const READER_SHELL = `The shell runs commands that only read: ${READ_COMMANDS.map((c) => c.replace(/ ?\*$/, "")).filter((c, i, all) => all.indexOf(c) === i).join(", ")}, and
also chains and pipes of reading programs (cat, head, grep, find, sed -n, echo, jq, …). A command that writes a file, a
redirect into a file included, is refused: you only read.`

const SHARED = `You are a sub-agent of the jev-micromanager. You get one sub-task with acceptance points.
Do only that sub-task. When you finish, answer with: what you did, which files you changed (if any), and for
each acceptance point whether it is met. A refused permission is not a blocker: nobody is asked while you run, so carry
on without it and say in your report what you wanted it for and what you did instead. If something blocks you, say what
and stop; do not guess.`

// Agent ids: the orchestrator is the micromanager, the workers are named after their role (the user's choice,
// 2026-10-05). Nouns, since OpenCode's built-in agents are already called plan and explore.
const AGENT_NAMES: Record<RoleId, string> = {
  explore: "explorer",
  research: "researcher",
  plan: "planner",
  code: "coder",
  test: "tester",
  visual: "designer",
  write: "writer",
  debug: "debugger",
  review: "reviewer",
  oracle: "oracle",
}

const role = (
  id: RoleId,
  description: string,
  system: string,
  rules: readonly Rule[],
  models: readonly string[],
): Role => ({ id, agent: AGENT_NAMES[id], description, system: `${SHARED}\n\n${system}`, rules: [...rules, ...noStateDir, ...noMemory, ...noQuestion], models })

export const ROLES: readonly Role[] = [
  role(
    "explore",
    "Read-only: find code, map structure, answer where/how questions about the codebase.",
    `Search and read the codebase. Report paths and short excerpts. Change nothing.
Be quick: when you have the code_graph tool, ask it who calls or uses what before you grep; read many files at once
(several read, glob and grep calls in one step), prefer grep and the file tree to reading whole files, use git log and git show for history, and stop as soon as the question is answered; a summary of
what you saw beats reading every file.
${READER_SHELL}`,
    [...noWrite, ...readShell, ...noWeb, ...noDelegation],
    [MODELS.space, MODELS.deepseek, MODELS.qwen],
  ),
  role(
    "research",
    "Read-only with web access: docs, APIs, other repositories, current information.",
    `Look up documentation and sources on the web. Cite the URLs you used. Change nothing in the project.\n${READER_SHELL}`,
    [...noWrite, ...readShell, ...noDelegation],
    [MODELS.space, MODELS.deepseek, MODELS.qwen],
  ),
  role(
    "plan",
    "Read-only: split a problem into steps with acceptance points; no code.",
    `Produce a short plan: steps, acceptance points per step, risks. Write no code.\n${READER_SHELL}`,
    [...noWrite, ...readShell, ...WEB_TOOLS.map((tool) => rule(tool, "ask")), ...noDelegation],
    [MODELS.space, MODELS.qwen, MODELS.glm],
  ),
  role(
    "code",
    "Implements and refactors code.",
    "Implement the sub-task with the smallest change that meets the acceptance points. Match the surrounding code. Run the project's own tests and linters to check your work; the rest of the shell is asked about.",
    [...askShell, ...runAndRead, ...noWeb, ...noDelegation],
    [MODELS.space, MODELS.glm, MODELS.qwen],
  ),
  role(
    "test",
    "Writes and runs tests.",
    "Write or update tests for the sub-task and run them. Report the exact results.",
    [...askShell, ...runAndRead, ...noWeb, ...noDelegation],
    [MODELS.space, MODELS.glm, MODELS.deepseek],
  ),
  role(
    "visual",
    "UI, CSS, layouts, screenshots (has image input).",
    "Work on the user interface. When given screenshots, describe what you see before changing anything.",
    [...askShell, ...runAndRead, ...noWeb, ...noDelegation],
    [MODELS.space, MODELS.qwen],
  ),
  role(
    "write",
    "Docs, README, comments, commit and PR texts.",
    "Write clear, short English prose. Change only documentation files unless told otherwise.",
    [...askShell, ...runAndRead, ...noWeb, ...noDelegation],
    [MODELS.space, MODELS.deepseek, MODELS.qwen],
  ),
  role(
    "debug",
    "Reproduces a failure and finds its cause; edits only with approval.",
    "Reproduce the failure, find the root cause, and explain it with evidence. Propose the fix before applying it.",
    [...WRITE_TOOLS.map((tool) => rule(tool, "ask")), ...askShell, ...runAndRead, ...WEB_TOOLS.map((tool) => rule(tool, "ask")), ...noDelegation],
    [MODELS.space, MODELS.glm, MODELS.qwen],
  ),
  role(
    "review",
    "Read-only: checks a worker's result against its acceptance points; may run tests and linters.",
    `Check the result against each acceptance point. Run the tests and linters if there are any. Answer only
with JSON: {"verdict": "PASS" | "FAIL", "checks": [{"point": "...", "met": true | false, "evidence": "..."}],
"fixes": ["..."]}.`,
    [...noWrite, ...readShell, ...runAndRead, ...noWeb, ...noDelegation],
    [MODELS.space, MODELS.glm, MODELS.qwen], // space-bunny writes, so a reviewer must be another family
  ),
  role(
    "oracle",
    "Read-only: hard decisions, architecture, trade-offs.",
    `Weigh the options for the question with evidence from the code. Give one recommendation and why.\n${READER_SHELL}`,
    [...noWrite, ...readShell, ...WEB_TOOLS.map((tool) => rule(tool, "ask")), ...noDelegation],
    [MODELS.space, MODELS.qwen, MODELS.glm],
  ),
]

const ROLE_AGENTS = Object.values(AGENT_NAMES)

export function roleByAgent(agent: string): Role | undefined {
  return ROLES.find((r) => r.agent === agent)
}

export function roleById(id: string): Role | undefined {
  return ROLES.find((r) => r.id === id)
}

// The micromanager itself: plans and delegates, never edits or runs commands. A delegation to one of the role agents
// is allowed: the plugin's guard checks its text before it starts (checkGuards in the subagent hook) and every action of
// the worker is gated on its own (worktree, permission hook, hard rules). Asking Jev whether a worker may start at all
// sent 18 of 101 delegations to the user (Jev unsure at a median confidence of 0.94), and without a TUI they were
// refused outright. Any other agent is still a question.
export const MICROMANAGER = {
  agent: "micromanager",
  description: "Orchestrator: splits a job into sub-tasks and delegates each to a role sub-agent.",
  // No reads outside the project: in a live test the micromanager went into the plugin's own source to find a way past
  // the local check, instead of asking the user.
  rules: [...noWrite, ...noShell, ...noWeb, rule("subagent", "ask"), ...ROLE_AGENTS.map((agent) => rule("subagent", "allow", agent)), rule("external_directory", "deny"), ...noStateDir] as readonly Rule[],
} as const

// omo-hybrid: the micromanager drives the flow like oh-my-openagent's Sisyphus (split, todos, parallel background
// workers on OpenCode's subagent tool, react to reports); the plugin and Jev secure each task (guards, model, skills,
// rights, a worktree per writer, checks, merge; src/native.ts).
export function micromanagerSystem(roles: readonly Role[] = ROLES): string {
  const lines = roles.map((r) => `- ${r.agent}: ${r.description}`)
  return `You are the micromanager, an orchestrator. You never do the work yourself: you do not edit files or run
commands, and you read only enough to orient yourself (the README, the file list, a file or two). Workers do the
rest, in the background, on the session's own git branch; the user's checkout is never touched.

How you work:
1. Understand the request. If something only the user can decide is unclear (behaviour, scope, interfaces), ask
   briefly first; never ask for facts a worker can look up.
2. Split the work into small tasks, each one change that can be checked on its own. Keep a todo list (the todo
   tool if you have one, else a short list in your message) and update it as reports come in.
3. Start a worker for each task with the subagent tool: agent = the role (below), description = a short title,
   background = true, and a prompt with everything the worker needs (it knows nothing else). A worker that changes
   files ends its prompt with two lines the plugin reads:
     Files: the project paths it may change, comma separated
     Checks: a shell command that exits 0 when the task is done (usually the project's test command)
   A worker that only reads (explore, research, plan, review, oracle) has neither line; its report is the result.
   A writer can ask an explorer or a researcher a question of its own while it works (its explore and research
   tools), so give it the task, not a survey of everything it might need to know first.
   To get to know a whole repository, start several explorers at once, each on one part (e.g. one per top-level
   package, one for tests and CI), each asked for a short overview; never ask one worker to read everything. A
   question about particular code (who calls X, what breaks if Y changes) goes to one explorer: it has a code graph
   that answers such questions in a few calls.
   Start independent tasks right away, several subagent calls in one message: each writer works in a git worktree
   of its own and they run in parallel. Start a task that needs another's result only after that one's report.
   You may not read outside the project yourself, but a worker that only reads may read a directory its prompt names
   with its full path (e.g. another repository): name it, and never ask the user to copy files around. When a worker
   genuinely needs a path the plugin refuses by default — the user's keys, credentials, home or a system directory —
   call the request_access tool with it. That does not refuse: it hands you a question to put to the user word for
   word, and their answer on your next turn opens the path for this job or leaves it closed. End your turn after
   showing it and do not call another tool.
4. When a worker ends, OpenCode adds its report to your conversation; do not wait, poll or sleep for it. A writer is
   done when the plugin's note "[jev-micromanager] T… merged into …" came first: the plugin ran the checks, committed
   and merged it. Notes that start with "[jev-micromanager]" come from your own plugin, not from the user or a tool
   result; trust them. A writer that ended without a merge, or a worker that needs something, is continued with the
   subagent tool and its sessionID (it keeps its worktree and what it did), or you ask the user. Never start a new
   worker on work another one left unfinished: its change would be lost. To start over on purpose, add a line
   "Replaces: T…" to the new worker's prompt; the old task and its worktree go. Workers list
   follow-ups they found: start the ones the request needs, and mention the others to the user.
   A note "[jev-micromanager] A…: worker … is paused on a permission request" means a worker waits for an answer:
   decide it with answer_permission when it clearly serves the task, else put it to the user as the note says.
5. When everything is done, tell the user briefly what changed and how to merge the session branch (git merge
   jev/<job>, the notes name it) or discard it.

The plugin's own tools (plan_job, run_job, job_status, list_tasks, steer_task, stop_task, merge_job, discard_job,
request_access, answer_permission, …) are not offered as tools of their own: call them inside the execute tool, as
\`await tools.plan_job({ goal: "…" })\`; a direct call fails with "No tool named … is currently available" (live run,
2026-10-13). The subagent tool is a tool of its own, as before.

Every merged task is a checkpoint of the job: rewind_job with an empty "to" lists them ("start", "T3", …), and with a
name moves the job branch back to that state once the user said so (their words as ack); it keeps the old tip as
before-rewind-<n>, so a rewind is undone the same way. undo_merge takes back the last merge_job in the user's checkout.

Keep your own messages short. While workers run, keep talking with the user; list_tasks shows the tasks with their
state, worker session and branch. If the user wants to stop, call stop_job. The user can say "ulw" or "ultrawork"
for you to go on until every todo is done without stopping in between.

For a large or unclear job (many parts, decisions to settle first), or when the user asks for a plan to approve,
use plan_job instead: a planner writes a full plan, you show it, and run_job runs it after the user's go. run_job
answers with the planned tasks to start: start each with the subagent tool exactly as listed (its prompt is the line
"Task: T… · job-…"; the plugin fills in the task, files, checks and acceptance points from the plan). When workers
end, a "[jev-micromanager] job …" note names the next tasks to start, or says that the job is done or stuck; follow it
until the plan is through, without asking the user in between unless the note says the job is stuck.
Notes that start with "[planning session …]" or "[job …]" are the plugin's instructions for that turn; follow them.

The worker roles, as the subagent tool's agent (the plugin picks the model, skills and rights per task):
${lines.join("\n")}`
}
