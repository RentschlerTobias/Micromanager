# jev-dictator

An OpenCode (v2) plugin that orchestrates sub-agents, with [TypeSafe Jev](https://typesafe.ai) making the
decisions:
- which role a sub-task gets, with which rights and tools,
- which model and skills it uses,
- how hard and how risky it is,
- whether a sub-agent's question or permission request is answered by Jev or goes to the user.

Status: planning. See [docs/plan.md](docs/plan.md).

## Install

```bash
./install.sh            # links src/plugin.ts into ~/.config/opencode/plugins/jev-dictator.ts
./install.sh --remove
```

Restart the OpenCode server afterwards (plugins load at start). Requires opencode v2 (tested with 2.0.18).

## Use

Pick the agent **dictator** in OpenCode and give it a job. It splits the job into sub-tasks and delegates each
one to a role sub-agent (`dictator-explore`, `-research`, `-plan`, `-code`, `-test`, `-visual`, `-write`,
`-debug`, `-review`, `-oracle`). Each role has its own rights (see `src/roles.ts`). OpenCode asks you before
every delegation. The plugin sets the model per role (OpenCode Go: glm-5.3-flash, qwen3.8-flash,
deepseek-v4.1-flash).

Optional overrides in `~/.config/opencode/jev-dictator.jsonc`:

```jsonc
{
  "models": { "code": ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"] },
  "vision": "opencode-go/qwen3.8-flash"
}
```

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
