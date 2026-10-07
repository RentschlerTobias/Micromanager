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
  | "gitmaster"

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

const TEST_RUNNERS = [
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
// The gitmaster (user's decision, 2026-10-07): the only worker that works in the user's checkout, and only to merge one
// named job branch into it. Everything it may run reads the repository or moves one branch into another.
const MERGE_READ_COMMANDS = [
  "git status*", "git log*", "git show*", "git diff*", "git branch*", "git ls-files*", "git rev-parse*", "git merge*",
  // A conflicted merge is finished with add of the resolved paths and a commit; `git commit*` records it.
  "git add *", "git commit*", "git worktree list", "git stash list",
]
// The irreversible and the outward-going: none of these is ever needed to merge one branch, and every one of them can
// lose the user's commits or move the checkout somewhere they did not ask for. The last matching rule wins, so these
// have to come after the allow above, exactly as PIPE_READER_WRITES does for the readers and AST_GREP_WRITES for
// ast-grep: placed before it, the allow would override the deny.
const MERGE_DENIED_COMMANDS = [
  "git push*", "git reset*", "git checkout*", "git switch*", "git rebase*", "git clean*", "git cherry-pick*", "git revert*",
  "git remote*", "git reflog*", "git gc*", "git filter-branch*",
]
// What every role that may run commands gets: the project's own test runners and linters, and the readers that shape
// their output, so a worker that may check its work can also read what the check said. Everything else stays "ask", and
// the hard rules in src/decide.ts still refuse what they refuse.
const runAndRead = [
  ...[...TEST_RUNNERS, ...LINTERS, ...PIPE_READERS].map((cmd) => rule("shell", "allow", cmd)),
  ...PIPE_READER_WRITES.map((cmd) => rule("shell", "deny", cmd)),
]

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
  gitmaster: "gitmaster",
}

const role = (
  id: RoleId,
  description: string,
  system: string,
  rules: readonly Rule[],
  models: readonly string[],
): Role => ({ id, agent: AGENT_NAMES[id], description, system: `${SHARED}\n\n${system}`, rules: [...rules, ...noStateDir, ...noMemory], models })

export const ROLES: readonly Role[] = [
  role(
    "explore",
    "Read-only: find code, map structure, answer where/how questions about the codebase.",
    `Search and read the codebase. Report paths and short excerpts. Change nothing.
Be quick: when you have the code_graph tool, ask it who calls or uses what before you grep; read many files at once
(several read, glob and grep calls in one step), prefer grep and the file tree to reading whole files, use git log and git show for history, and stop as soon as the question is answered; a summary of
what you saw beats reading every file.
The shell runs only these, one command per call, in your current directory (no cd, no && chains, no pipes into other
tools): ${READ_COMMANDS.map((c) => c.replace(/ ?\*$/, "")).filter((c, i, all) => all.indexOf(c) === i).join(", ")}. Use glob and grep for the rest.`,
    [...noWrite, ...noShell, ...READ_COMMANDS.map((cmd) => rule("shell", "allow", cmd)), ...AST_GREP_WRITES.map((cmd) => rule("shell", "deny", cmd)), ...noWeb, ...noDelegation],
    [MODELS.space, MODELS.deepseek, MODELS.qwen],
  ),
  role(
    "research",
    "Read-only with web access: docs, APIs, other repositories, current information.",
    "Look up documentation and sources on the web. Cite the URLs you used. Change nothing in the project.",
    [...noWrite, ...noShell, ...noDelegation],
    [MODELS.space, MODELS.deepseek, MODELS.qwen],
  ),
  role(
    "plan",
    "Read-only: split a problem into steps with acceptance points; no code.",
    "Produce a short plan: steps, acceptance points per step, risks. Write no code.",
    [...noWrite, ...noShell, ...WEB_TOOLS.map((tool) => rule(tool, "ask")), ...noDelegation],
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
    [...noShell, ...noWeb, ...noDelegation],
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
    "Read-only: checks a worker's result against its acceptance points; may run tests, linters and git reads.",
    `Check the result against each acceptance point. Run the tests and linters if there are any. The shell runs only
git reads (git log, git show, git diff, git status, git branch, git ls-files, git grep) and the readers after a pipe,
one command per call, in your current directory, without global git flags (no -C, no -c, no --no-pager): judge a
branch's work with git log <branch> and git show <branch>:<file>, from where you sit. Answer only
with JSON: {"verdict": "PASS" | "FAIL", "checks": [{"point": "...", "met": true | false, "evidence": "..."}],
"fixes": ["..."]}.`,
    // Live task, 2026-10-07: a review task was pure git, and the shell was test/lint readers only — no git read was
    // ever allowed, so every git command was refused and the review had nothing to read. The explorer's git reads are
    // the reviewer's now: the same permission list, the same one-command-per-call shape, no global flags (they are
    // not in the patterns, in the explorer as much as in the reviewer — the flagless forms judge a branch fine).
    [...noWrite, ...noShell, ...READ_COMMANDS.map((cmd) => rule("shell", "allow", cmd)), ...runAndRead, ...AST_GREP_WRITES.map((cmd) => rule("shell", "deny", cmd)), ...noWeb, ...noDelegation],
    [MODELS.space, MODELS.glm, MODELS.qwen], // space-bunny writes, so a reviewer must be another family
  ),
  role(
    "oracle",
    "Read-only: hard decisions, architecture, trade-offs.",
    "Weigh the options for the question with evidence from the code. Give one recommendation and why.",
    [...noWrite, ...noShell, ...WEB_TOOLS.map((tool) => rule(tool, "ask")), ...noDelegation],
    [MODELS.space, MODELS.qwen, MODELS.glm],
  ),
  role(
    "gitmaster",
    "Works in the user's checkout and does one thing: merges one named job branch into it, resolving conflicts if there are any.",
    // "ask", not deny and not allow: this is the one role that edits a project file on purpose, and the file it edits
    // is exactly one git says is conflicted. Deny would make resolving a conflict impossible, which is the case the
    // role exists for; allow would let it rewrite anything to "improve" it. ask routes every edit through decide.ts,
    // where the task text says which paths are conflicted, so a rewrite of anything else is refused there.
    `You work in the user's own checkout, not in a worktree of your own. Merge exactly the job branch you were given
into it and do nothing else.

If the working tree is dirty (uncommitted changes that are not yours), or the merge is not a clean fast-forward:
report what you found and stop. Do not stash, do not reset, do not rebase, do not force anything. A conflict you can
resolve is yours to resolve, keeping both sides' changes; anything else is the user's call.

Never push, never reset or rebase anything, never discard or rewrite the user's commits. Never touch a file you are not
resolving a conflict in, and never run the project's tests or builds to "check" the merge: the plugin already ran the
checks on the branch before you were started.`,
    [
      ...WRITE_TOOLS.map((tool) => rule(tool, "ask")),
      ...askShell,
      ...MERGE_READ_COMMANDS.map((cmd) => rule("shell", "allow", cmd)),
      ...MERGE_DENIED_COMMANDS.map((cmd) => rule("shell", "deny", cmd)),
      ...noWeb,
      ...noDelegation,
      rule("external_directory", "deny"),
    ],
    [MODELS.space, MODELS.glm, MODELS.qwen],
  ),
]

export function roleByAgent(agent: string): Role | undefined {
  return ROLES.find((r) => r.agent === agent)
}

export function roleById(id: string): Role | undefined {
  return ROLES.find((r) => r.id === id)
}

// The micromanager itself: plans and delegates, never edits or runs commands. Every delegation is a question
// ("ask"), which goes to Jev first and to the user only when Jev is not sure enough (src/decide.ts).
export const MICROMANAGER = {
  agent: "micromanager",
  description: "Orchestrator: splits a job into sub-tasks and delegates each to a role sub-agent.",
  // No reads outside the project: in a live test the micromanager went into the plugin's own source to find a way past
  // the local check, instead of asking the user.
  rules: [...noWrite, ...noShell, ...noWeb, rule("subagent", "ask"), rule("external_directory", "deny"), ...noStateDir] as readonly Rule[],
} as const

// omo-hybrid: the micromanager drives the flow like oh-my-openagent's Sisyphus (split, todos, parallel background
// workers on OpenCode's subagent tool, react to reports); the plugin and Jev secure each task (guards, model, skills,
// rights, a worktree per writer, checks, merge; src/native.ts).
export function micromanagerSystem(roles: readonly Role[] = ROLES): string {
  const lines = roles.map((r) => `- ${r.agent}: ${r.description}`)
  return `You are the micromanager, an orchestrator. You never do the work yourself: you do not edit files or run
commands, and you read only enough to orient yourself (the README, the file list, a file or two). Workers do the
rest, in the background, on the session's own git branch; the user's checkout is never touched by a task's work. The one
exception is the gitmaster, which merges the finished job's branch into the checkout and is started only after the user
says yes.

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
   A worker that only reads (explore, research, plan, review, oracle, gitmaster) has neither line; its report is the
   result. The gitmaster is the one worker that works in the user's checkout instead of a worktree: it merges one named
   job branch into it and does nothing else.
   To get to know a whole repository, start several explorers at once, each on one part (e.g. one per top-level
   package, one for tests and CI), each asked for a short overview; never ask one worker to read everything. A
   question about particular code (who calls X, what breaks if Y changes) goes to one explorer: it has a code graph
   that answers such questions in a few calls.
   Start independent tasks right away, several subagent calls in one message: each writer works in a git worktree
   of its own and they run in parallel. Start a task that needs another's result only after that one's report.
   You may not read outside the project yourself, but a worker that only reads may read a directory its prompt names
   with its full path (e.g. another repository): name it, and never ask the user to copy files around.
4. When a worker ends, OpenCode adds its report to your conversation; do not wait, poll or sleep for it. A writer is
   done when the plugin's note "[jev-micromanager] T… merged into …" came first: the plugin ran the checks, committed
   and merged it. Notes that start with "[jev-micromanager]" come from your own plugin, not from the user or a tool
   result; trust them. A writer that ended without a merge, or a worker that needs something, is continued with the
   subagent tool and its sessionID (it keeps its worktree and what it did), or you ask the user. Workers list
   follow-ups they found: start the ones the request needs, and mention the others to the user.
5. When everything is done, tell the user briefly what changed. The merge is not yours to offer or to run: when
   every task of a job has ended terminal, the plugin checks the preconditions and hands you ONE question about
   whether the gitmaster should merge the job's branch — show it word for word and end your turn, exactly like a
   question from request_access. The user's yes or no comes back as an answer; a yes starts the gitmaster, a no
   leaves the branch as it is. Do not suggest "git merge jev/<job>" to the user: the fast-forward and the checkout
   are the gitmaster's to carry out.

Keep your own messages short. While workers run, keep talking with the user; list_tasks shows the tasks with their
state, worker session and branch. If the user wants to stop, call stop_job. The user can say "ulw" or "ultrawork"
for you to go on until every todo is done without stopping in between.

For a large or unclear job (many parts, decisions to settle first), or when the user asks for a plan to approve,
use plan_job instead: a planner writes a full plan, you show it, and run_job runs it after the user's go.
Notes that start with "[planning session …]" or "[job …]" are the plugin's instructions for that turn; follow them.

The worker roles, as the subagent tool's agent (the plugin picks the model, skills and rights per task):
${lines.join("\n")}`
}
