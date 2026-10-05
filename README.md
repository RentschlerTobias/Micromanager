# jev-dictator

An OpenCode (v2) plugin that orchestrates sub-agents, with [TypeSafe Jev](https://typesafe.ai) making the
decisions:
- which role a sub-task gets, with which rights and tools,
- which model and skills it uses,
- how hard and how risky it is,
- whether a sub-agent's question or permission request is answered by Jev or goes to the user.

Status: design agreed, implementation in phases. The design is [docs/design.md](docs/design.md), its flow chart
[docs/design.html](docs/design.html), the phases and research [docs/plan.md](docs/plan.md).

## Install

```bash
./install.sh            # links src/plugin.ts into ~/.config/opencode/plugins/jev-dictator.ts
./install.sh --remove
```

Restart the OpenCode server afterwards (plugins load at start). Requires opencode v2 (tested with 2.0.18).

## Use

Pick the agent **dictator** in OpenCode and give it a job. The dictator never works on the code itself:
1. `dictator_plan`: a local check (G0) looks at the job first. If the job leaves decisions open, a planning
   session asks you about them, one open question per turn and without suggested answers. Answer in your own
   words, or use "skip", "wait what", "back to D2", "light" / "normal" / "frequent" and "stop". It ends in a
   checkpoint you confirm. Then a planner sub-agent reads the project and splits the job into small tasks with
   acceptance points and checks; tasks the decision model finds too big are split once more (N4). The plugin
   validates the plan, and the dictator shows it to you.
2. `dictator_run`, after your go: the job is queued and runs in the background on its own branch `jev/<job>`, in
   a worktree under `.jev-dictator/worktrees/`; the call returns at once and you can keep talking with the dictator.
   Independent tasks (no shared files) run in parallel, each in its own worktree, and a merge train brings them onto
   the job's branch one at a time. One decision request per task (N5) sets its role (`dictator-code`, `-test`,
   `-write`, …, rights per role in `src/roles.ts`), difficulty, risk and a profile that can only narrow the role's
   rights. The task then passes a pipeline (`src/pipelines.ts`):
   - **P1**: implement, checks, fix rounds;
   - **P2**: the same, then two reviews by other model families in parallel: one against the acceptance points,
     one against the repository's standards; only findings with evidence and confidence 80 or more block;
   - **P3**: tests first, which must fail and are then frozen, then the implementation and the reviews (bug fixes,
     public interfaces);
   - **P9**: research by 1, 3 or 5 readers, a synthesis in `docs/research/`, and a citation check.

   A task that keeps failing climbs a ladder: fix rounds in the same session, then a fresh session on another
   model family with a handoff note, then an escalation. A task that is too hard as planned does not stop the job:
   the others go on and the planner rewrites the unfinished part (at most twice). Unclear specs, outside
   dependencies, conflicting reviews, refusals and used-up budgets come to you. A worker that refuses on safety
   grounds gets one try on a local uncensored model, never for a job the local check flagged as harmful.

   Workers report work outside their task as `FOLLOWUP` lines, and reviewers report it as "outside". The decision
   model (N7) turns what the job needs into new tasks with a priority. What only you can decide, or what is out of
   scope, is listed at the end under "found but not done".

   The plugin runs the checks itself and commits each passed task. A destructive task waits for your go. Your
   checkout is never touched; you merge or discard the branch.
3. Updates come to the dictator's session: progress as quiet messages, and a note that wakes the dictator when a
   job is done or needs you. With `notify-send` installed you also get a desktop notification. When a job stops for
   you, answer the dictator; it resumes the job with your answer (`dictator_run` with a note). `dictator_status`
   shows the queue and a job at any time; `dictator_stop` pauses the running job, and `dictator_run` resumes it.
   Jobs and task notes live in `.jev-dictator/` (kept out of git through `.git/info/exclude`).

Guards: a local check (G0, GLiNER on the CPU) looks at the goal, at new tasks a worker found, and at workers'
permission requests. Web content and research notes are checked for prompt injection before a model reads them.
Keys and tokens are masked in every prompt and tool result of the plugin's sessions.

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
