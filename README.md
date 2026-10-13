# jev-micromanager

An OpenCode (v2) plugin that orchestrates sub-agents, with [TypeSafe Jev](https://typesafe.ai) making the
decisions:
- which role a sub-task gets, with which rights and tools,
- which model and skills it uses,
- how hard and how risky it is,
- whether a sub-agent's question or permission request is answered by Jev or goes to the user.

Status: the `omo-hybrid` branch: an oh-my-openagent-style orchestrator with Jev as the decision model; `main` keeps
the fully code-driven design. The design is [docs/design.md](docs/design.md), its flow chart
[docs/design.html](docs/design.html), the phases and research [docs/plan.md](docs/plan.md).

## Install

```bash
./install.sh            # links src/plugin.ts into ~/.config/opencode/plugins/jev-micromanager.ts
./install.sh --remove
```

Restart the OpenCode server afterwards (plugins load at start). Requires opencode v2 (tested with 2.0.18).

## Use

Pick the agent **micromanager** in OpenCode and tell it what you want. It works like oh-my-openagent's orchestrator, with
Jev and the plugin securing every task:

1. **The micromanager orchestrates.** It splits your request into small tasks, keeps a todo list and starts a worker
   per task with OpenCode's own `subagent` tool, in the background: the role as agent (`coder`, `tester`, `writer`,
   `explorer`, …), a short title, and a prompt that ends with `Files:` (what it may change) and `Checks:` (e.g.
   `npm test`) for a worker that writes. The call returns at once; the workers show up in OpenCode as the
   micromanager's child sessions, and the micromanager stays free to talk with you.
2. **Each writer works in its own git worktree** under `.jev-micromanager/worktrees/`, branched off the session's
   branch `jev/<job>`: OpenCode starts the child in your checkout, and the plugin moves it into the worktree before
   its first step. Your checkout is never touched. Readers work on the session branch and change nothing.

   Git always materialises a worktree of the **repository root**, so if your project is a subdirectory of a larger
   repository the worker keeps its offset: the plugin records it as `rel` and runs the worker *and its checks* in
   `<worktree>/<rel>`, where its files are. A check naming one of your files resolves there, not at the root. The
   job also records whether your working tree has uncommitted changes, because no worker can see them — a task that
   needs them cannot pass, and you are told so rather than finding out from a confused worker.
3. **Isolation fails loud.** A session that is a child of a micromanager session but is not a claimed worker has its
   write tools denied, with a journal record naming the job, session, directory and reason. Reads stay allowed so the
   situation stays diagnosable. A role agent you pick by hand in your own checkout is not a child and is untouched.
4. **Jev and the plugin secure each task:**
   - **Guards.** A check looks at each delegation, at web content and at workers' permission requests. Keys and
     tokens are masked.
   - **Model and skills.** The plugin routes each role to its model and names the skills in the worker's brief.
   - **Permissions (N13).** Workers' permission requests go to Jev. What Jev is not sure about, what it says only
     you can decide, and what a hard rule sends to you is **paused, not refused**: the worker waits, and the
     micromanager is woken with the request (`A1`, `A2`, …), what it is for and why it was not decided. It answers a
     request that clearly serves the task itself with `answer_permission` (`once`, `job` for the same request for the
     rest of the job, or `refuse`), and puts anything else to you. You answer in your own words — "yes", "yes always",
     "no" (also "ja", "ja immer", "nein") — and the plugin reads that from your turn, so a hard rule only ever opens
     on your word, never on the micromanager's. Nobody answering within 10 minutes refuses it, and the worker carries
     on without it as before; a desktop notification says a worker waits. `external_directory` is layered: a path
     inside the job's own worktrees is allowed, a path the task itself names is allowed, and anything else is
     paused for you the same way.
     `~/.ssh`, `~/.config`, `/etc`, your home directory and another job's worktree are never allowed at any layer.
   - **A writer's worktree is its sandbox.** A shell command a writer runs in its own task worktree is allowed without
     Jev when it stays there: no path outside the worktree or `/tmp`, no home directory, no program that reaches past
     the tree (`kill`, `systemctl`, `curl`, `ssh`, publishing, …) and no git command that moves shared refs (`commit`,
     `checkout`, `stash`, `reset`, …). The hard rules still come first. Asking Jev there turned a worker's own
     verification — tests, a render, a screenshot — into refusals; replayed against the journal, 85% of the refusals
     in task worktrees no longer happen.
   - **Writers can ask.** A writer has two tools of its own: `explore` starts an explorer that reads the writer's
     directory, its uncommitted change included, and `research` starts a researcher with the web. The writer waits for
     the answer, which comes back as the tool's result. A helper is no task of the job: no worktree, no merge, no place
     on the micromanager's list, no helper of its own, at most three per task. The permission hook, the guards, the
     watchdog and the journal (`"kind":"helper"`) treat it like any worker. Its session is a top-level one whose title
     starts with the writer's task: OpenCode 2.0.18's plugin API drops `parentID`, so it cannot be nested.
   - **Readers read.** Explorer, researcher, planner, reviewer and oracle run `git log`/`diff`/`show`, `ls` and the
     like without asking, and any chain or pipe of reading programs passes the read-only check; a command that writes
     is refused with the reason, not a bare "Permission denied". No worker may put up a question: nobody answers one
     in a background session.
   - **Checks are gated too.** A check is a string a model wrote, and the plugin runs it in a shell, so every check
     goes through the same hard rules as a permission request: pushes, `sudo`, system installs and destructive
     deletions are refused before the task or its worktree exists. A writer with no checks at all is refused as well.
   - **Checks and merge.** A writer ends by calling `finish_task`: the plugin runs the checks in the worktree; on
     a failure the worker gets the output and fixes it, on a pass the plugin commits and a merge train brings the
     commit onto `jev/<job>` (rebased and checked again when another task got there first).
   - **A task that changed nothing does not merge.** A gate that passes over an empty diff verified nothing, so it is
     reported as unverified instead. Failing checks come back at most twice; then the worker stops and says the
     check is the likely problem, because an unsatisfiable one otherwise burns the whole session.
   - **Limits.** The watchdog stops loops and stalled workers; every 60 steps Jev reviews a worker's progress. A
     command that ran and did not fail is progress, so a worker verifying its work is not mistaken for a stuck one.
5. **Reports come back.** The plugin's note "T… merged into …" lands in the micromanager's session, then OpenCode
   adds the worker's report and wakes the micromanager. It decides what comes next, continues a worker by its
   session when something is left (it keeps its worktree), asks you what only you can decide and, at the end, merges
   or discards the branch itself. Say "ulw" or "ultrawork" and it goes on until every todo is done.

   **The same work is not delegated twice.** A writer on files another writer of the job is changing, whose title
   or brief is about the same thing, is refused: a running one is to be steered (`steer_task`), and one that stopped
   before its merge is to be continued by its session, so its change is kept (live run, 2026-10-07: three workers in
   turn removed the same element from the same slide, each one starting over). A line `Replaces: T5` in the prompt
   starts over on purpose: T5 is cancelled and its worktree goes. A reader whose brief is nearly that of one still
   running is refused the same way. **A worker's own work ends with it:** when it ends or is stopped, its running
   helpers are interrupted and its paused permission requests are dropped, and the micromanager is told they need no
   answer any more.

   The controls, all for the micromanager:

   | tool | what it does |
   |---|---|
   | `list_tasks` | the tasks with their worker sessions, branches and stages |
   | `steer_task` | a note to a worker that is still running, without interrupting it |
   | `stop_task` | stop one task and leave the rest of the job running; the worktree is kept |
   | `merge_job` | fast-forward the job branch into your checkout — the one write it may make there. Shows what would land, refuses on a dirty checkout or unfinished tasks |
   | `discard_job` | give the branch and worktrees back to git; lists what it removes first |
   | `request_access` | vouch that a worker needs a path outside the project, for the permission path to see |
   | `stop_job` | stop the whole job; `run_job` resumes it |

6. **Large or unclear jobs.** `plan_job` lets a planner write a full plan with acceptance points, optionally
   after a planning session with you. You approve it, and `run_job` runs it.

Jobs and task notes live in `.jev-micromanager/`, kept out of git through the repository's `.git/info/exclude` — found
with `git rev-parse --git-common-dir`, so it works when the project is a subdirectory of a larger repository and when
it is itself a worktree.

**Overview.** `job_status` shows an ASCII board of the job: each task with its state, role, model and what it does
or waits for, plus tokens, requests and cost. In a terminal, in the project:

```bash
node ~/Fun/Projects/Repos/jev-micromanager/src/cli.ts status --watch   # redraws every 2 s; --all for every job
```

**Memory.** In planned jobs (`plan_job`), workers report what they learned about the project (`LEARNED:`); Jev keeps the lasting, new facts in
`.opencode/memory/jev-project.md` (opencode-agent-memory's format) and picks the ones that help each task's brief.

Models come from a registry of the OpenCode Go models and your local ones (llama-swap, iGPU, NPU), local
first when they can do the task (`src/registry.ts`).

**Model choice.** `opencode-go/space-bunny` leads every role's chain (your choice, 2026-10-07: strong on code and
free), and the three paid cloud models sit behind it as the fallbacks — `glm-5.3-flash`, `qwen3.8-flash`,
`deepseek-v4.1-flash`. Two paths pick the model and they do not read the same thing: the native path
(`chooseModel` in `src/routing.ts`) takes the first entry of the role's chain, and the runner's router
(`route` in `src/registry.ts`) picks from the registry by tier, where the order of `DEFAULT_REGISTRY` decides.
A review is the exception both paths honour: a reviewer never checks the work of its own model family, so a review
of space-bunny's work goes to `glm-5.3-flash` — unless nothing else in the chain is available, in which case the
rule is relaxed rather than handed a model that cannot run, and the reason says so.

**When space-bunny stops being free.** It will very likely not be called that any more, and a renamed or withdrawn
model must not break every role at once. So the chain is walked, not read at its first entry: before a delegation the
plugin asks the host's catalog (`ctx.catalog`) whether the model exists, and takes the first entry of the chain that
does. A skip is journalled as a `routing` record whose reason names what was unavailable, so the change is visible
rather than silent. If *nothing* in the chain is available the first entry is used anyway — a call against a missing
model fails loudly, which beats quietly substituting something the role never asked for.

Set a chain yourself with `decisions.N5.model`, or one model per role in the config's `registry`; see the settings
below.

Permission requests go to Jev first and to you when Jev is not sure (`src/decide.ts`). Some phases of the design
are still to come: see docs/plan.md.

Optional settings in `~/.config/opencode/jev-micromanager.jsonc`:

```jsonc
{
  // presets per decision: "auto" (the decision model), "ask" (always you), "rule", or "fixed:<value>"
  "decisions": {
    "N5.model": "fixed:opencode-go/deepseek-v4.1-flash", // every worker on one model
    "N13.shell": "fixed:allow"                            // shell commands of workers without asking
  },
  // models to add or change by id
  "registry": [{ "id": "llamaswap/mimo", "disabled": true }],
  "parallel": 3,          // tasks of one job at the same time (1: one after another)
  "perModel": 2,          // sessions of one cloud model at the same time; a local model serves one
  "budget": { "tokens": 4000000, "requests": 800, "cost": 5 }, // optional limits per job; none by default
  "notify": "jobs"        // desktop notifications: "jobs", "tasks" (also per task) or "off"
}
```

Hard rules (pushes, `sudo`, system installs, deleting tracked files, …) always go to you, whatever a preset says.

`./install.sh --skills` links the skills into OpenCode: `deliberate` (the facilitator's rules) and six leaf skills
for workers, adapted from mattpocock/skills and obra/superpowers (`skills/THIRD_PARTY.md`). The plugin names a
skill in a worker's brief only when that link is in place. The local GLiNER
decision server (`decider/`, see its README) answers guard questions on the CPU, and `npm run bench-guards`
measures them; the journal
`~/.local/state/jev-micromanager/decisions.jsonl` feeds `npm run eval` and `npm run export-dataset`.

## Flow chart

`docs/flow.html` is a self-contained page (no server) that shows how the plugin decides: the model routing lane
(role → needs → model) and the permission lane (hard rules → deleted paths → Jev → the floors → allow / deny /
user). Open it in a browser and load `~/.local/state/jev-micromanager/decisions.jsonl` with the button or by dropping
it on the page; over http a `decisions.jsonl` next to the page is picked up automatically. Each decision is
listed, and selecting one highlights the exact path it took through the chart.

## Observability

`ctx.app` has no `log` method on this host, so `ctx.app?.log?.()` is undefined and nothing the plugin logs reaches
`opencode.log`. **The journal is the channel that persists**, and it is worth knowing what to look for:

```bash
J=~/.local/state/jev-micromanager/decisions.jsonl
grep '"kind":"plugin"' $J | tail -1 | jq     # one per server start
```

That record is written before anything can fail and carries the version, the project directory, the repository root,
the `rel` offset, and the tool names and agents the delegation hook recognises. A healthy first minute is one such
line, then silence until you delegate. After the first delegation you should see a `routing` entry whose `agent` is
whoever made the call and whose `prompt` starts `[jev-micromanager] task T1 · job …`, plus a task with a `worktree`
in the job file. `delegation-unrecognised` means a delegation the hook will not route; `isolation-denied` means the
backstop caught a worker that was not placed in a worktree.

The journal also holds `permission` entries (from `src/decide.ts`), `routing` (delegations), `finish`, `watchdog`,
`checkpoint` and `graph`.

## Develop

```bash
npm install       # typescript + @types/node, for the type check only
npm test          # node's test runner, TypeScript runs as is
npm run typecheck
```

Two things to know when changing the delegation path. A delegation is recognised by its **target** — a `subagent`
call aimed at one of this plugin's role agents — not by which agent made it, because the agent is a property of the
session and switching it silently skipped every later delegation (live test, 2026-10-06: ten workers wrote into the
user's checkout with no task, no worktree and no error). And plugins load when the OpenCode server starts, so a change
to `src/plugin.ts` needs a restart before anything observes it.
