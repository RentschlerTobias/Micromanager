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
2. `dictator_run`, after your go: the plugin runs one task at a time on the job's own branch `jev/<job>`, in a
   worktree under `.jev-dictator/worktrees/`. One decision request per task (N5) sets its role (`dictator-code`,
   `-test`, `-write`, …, rights per role in `src/roles.ts`), difficulty, risk and a profile that can only narrow
   the role's rights. The task then passes a pipeline (`src/pipelines.ts`):
   - **P1**: implement, checks, up to two fix rounds;
   - **P2**: the same, then a review by another model family (risky or untestable tasks);
   - **P3**: tests first, which must fail and are then frozen, then the implementation and a review (bug fixes,
     public interfaces);
   - **P9**: research by 1, 3 or 5 readers, a synthesis in `docs/research/`, and a citation check.

   The plugin runs the checks itself and commits each passed task. A destructive task waits for your go. Your
   checkout is never touched; you merge or discard the branch.
3. `dictator_status` shows a job at any time. Jobs and task notes live in `.jev-dictator/` (kept out of git
   through `.git/info/exclude`).

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
  "registry": [{ "id": "llamaswap/mimo", "disabled": true }]
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
