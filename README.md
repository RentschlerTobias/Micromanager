# jev-dictator

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
./install.sh            # links src/plugin.ts into ~/.config/opencode/plugins/jev-dictator.ts
./install.sh --remove
```

Restart the OpenCode server afterwards (plugins load at start). Requires opencode v2 (tested with 2.0.18).

## Use

Pick the agent **micromanager** in OpenCode and tell it what you want. It works like oh-my-openagent's orchestrator, with
Jev and the plugin securing every task:

1. **The micromanager orchestrates.** It splits your request into small tasks, keeps a todo list and delegates each
   task with `delegate_task`: title, prompt, the files it may change, checks such as `npm test`, dependencies and a
   priority. The call returns at once. Independent tasks (no shared files) run in parallel in the background, each
   in its own worktree under `.jev-dictator/worktrees/`. A merge train brings them one at a time onto the session's
   branch `jev/<job>`. Your checkout is never touched.
2. **Jev and the plugin decide per task:**
   - **Guards.** A local check (G0, GLiNER on the CPU) looks at each delegation, at web content and at workers'
     permission requests. Keys and tokens are masked.
   - **The profile (N5).** One Jev request per task sets the role (`coder`, `-test`, `-write`, …), the
     difficulty and so the model, the risk, the skills, and rights that can only narrow the role's.
   - **Permissions (N13).** Workers' permission requests go to Jev first and to you only when Jev is not sure.
   - **Quality.** The plugin runs the checks itself, with fix rounds and, for a task that keeps failing, a fresh
     session on another model family. A review by another model family runs for risky or unchecked tasks, and
     tests first for bug fixes.
   - **Limits.** Loops and stalled models are stopped, and budgets cap tokens and requests.
3. **Reports come back.** When a task merges, is given up or needs you, its report goes to the micromanager: status,
   checks, the worker's summary and its follow-ups. Reports close together arrive as one. The micromanager decides what
   comes next, asks you what only you can decide (`answer_task` passes your answer on) and, at the end, tells you
   how to merge or discard the branch. Say "ulw" or "ultrawork" and it goes on until every todo is done.
   `notify-send` adds desktop notifications. `list_tasks` shows the tasks and their reports, and `stop_job`
   pauses the work.
4. **Large or unclear jobs.** `plan_job` lets a planner write a full plan with acceptance points, optionally
   after a planning session with you. You approve it, and `run_job` runs it.

Jobs and task notes live in `.jev-dictator/`, kept out of git through `.git/info/exclude`.

**Overview.** `job_status` shows an ASCII board of the job: each task with its state, role, model and what it does
or waits for, plus tokens, requests and cost. In a terminal, in the project:

```bash
node ~/Fun/Projects/Repos/jev-dictator/src/cli.ts status --watch   # redraws every 2 s; --all for every job
```

**Memory.** Workers report what they learned about the project (`LEARNED:`); Jev keeps the lasting, new facts in
`.opencode/memory/jev-project.md` (opencode-agent-memory's format) and picks the ones that help each task's brief.

Models come from a registry of the OpenCode Go models and your local ones (llama-swap, iGPU, NPU), local
first when they can do the task (`src/registry.ts`). Permission requests go to Jev first and to you when Jev is
not sure (`src/decide.ts`). Some phases of the design are still to come: see docs/plan.md.

Optional settings in `~/.config/opencode/jev-dictator.jsonc`:

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
  "budget": { "tokens": 4000000, "requests": 800, "cost": 5 }, // per job; tokens and requests are the defaults
  "notify": "jobs"        // desktop notifications: "jobs", "tasks" (also per task) or "off"
}
```

Hard rules (pushes, `sudo`, system installs, deleting tracked files, …) always go to you, whatever a preset says.

`./install.sh --skills` links the skills into OpenCode: `deliberate` (the facilitator's rules) and six leaf skills
for workers, adapted from mattpocock/skills and obra/superpowers (`skills/THIRD_PARTY.md`). The plugin names a
skill in a worker's brief only when that link is in place. The local GLiNER
decision server (`decider/`, see its README) answers guard questions on the CPU, and `npm run bench-guards`
measures them; the journal
`~/.local/state/jev-dictator/decisions.jsonl` feeds `npm run eval` and `npm run export-dataset`.

## Flow chart

`docs/flow.html` is a self-contained page (no server) that shows how the plugin decides: the model routing lane
(role → needs → model) and the permission lane (hard rules → deleted paths → Jev → the floors → allow / deny /
user). Open it in a browser and load `~/.local/state/jev-dictator/decisions.jsonl` with the button or by dropping
it on the page; over http a `decisions.jsonl` next to the page is picked up automatically. Each decision is
listed, and selecting one highlights the exact path it took through the chart. The journal holds `permission`
entries (from `src/decide.ts`) and `routing` entries (from the subagent hook in `src/plugin.ts`).

## Develop

```bash
npm install       # typescript + @types/node, for the type check only
npm test          # node's test runner, TypeScript runs as is
npm run typecheck
```
