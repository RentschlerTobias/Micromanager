# jev-dictator: an OpenCode orchestrator driven by Jev

Status (2026-10-01): Phase 0 (spike) and Phase 1 done; Phase 2 next.

## Context
An OpenCode plugin that orchestrates sub-agents the way oh-my-openagent (OmO) does: it splits a job into
sub-tasks and runs sub-agents asynchronously in the background. For each sub-task it does the following:
- choose the subagent role (explore, research, code, test, …), which sets its rights and default tools,
- grade its difficulty and detect the tools and skills it needs,
- pick the model,
- review the result and improve it in a loop.

Guardrails and a cap on parallel tasks come with it.

The decisions are made by **TypeSafe Jev** (System One): a model that returns typed answers (a choice, a score,
a yes/no) with calibrated probabilities in about 100 ms, instead of text. That makes it the natural part for:
- routing (role, model, skills),
- grading (difficulty, risk),
- **answering the questions and permission requests** of the sub-agents: Jev answers the confident, low-risk
  ones itself and passes everything else to the user.

The plugin is self-contained: plain OpenCode, a TUI, Jev's API. It has no tie to any other project. Ideas from
the oc-voice project (session board, permission phrasing, Jev client) are reused as concepts, not as code
dependencies.

Decisions (user, 2026-10-01):
- **Own OpenCode v2 plugin** in its own repo (`~/Fun/Projects/Repos/jev-dictator`), not OmO itself.
- **Models: OpenCode Go only**, for now three: glm-5.3-flash, qwen3.8-flash, deepseek-v4.1-flash (local
  models later).
- **Worker starts are confirmed by the user** for now (each worker individually, in the TUI); Jev's
  confidence can take over later.
- **Jev decides which skills a worker loads.**

## Research (deep search)
- **OmO / oh-my-openagent** (formerly oh-my-opencode):
  - Agents:
    - Sisyphus: orchestrator.
    - Prometheus: planner, interviews the user.
    - Metis: finds gaps in the plan.
    - Momus: strict plan gate, read-only.
    - Oracle: architecture, read-only.
    - Explore: code search.
    - Librarian: docs and other repos.
    - Hephaestus: deep coding.
    - Sisyphus-Junior: executes a category's task.
  - **Categories** are model presets with fallback chains: quick, deep, ultrabrain, visual-engineering,
    writing, unspecified-low/high.
  - Background tasks: `delegate_task` / `background_output` / `background_cancel`. Each runs in its own
    session.
  - Concurrency per model > per provider > default (2–5). A task times out after 30 min.
  - A task counts as done when its session is idle, its messages are stable for 3 polls, or its TODO list is
    empty.
  - Loops: "ultrawork" (`ulw`) and the "Ralph loop" (keep going until done, verifying itself). A todo enforcer
    and a small "Kibitzer" model that reads earlier work and warns before a repeated mistake.
  - Lesson: **prompts per model family** (Claude: long, about mechanics; GPT: short, about principles).
- **opencode-model-router**: tiers fast/medium/heavy.
  - Keyword taxonomy, e.g. search/read → fast; feature/refactor/tests → medium; architecture/security/debug
    after 3 failures → heavy.
  - Cost ratios go into the system prompt. Escalation fast→medium→heavy with caps on attempts and cost.
- **opencode-squad**: PDCA loop.
  - An explicit SELF/DELEGATE verdict; executor + reviewer per model, the reviewer answers PASS/FAIL as JSON.
  - At most 3 iterations, then escalate to the user. Capability numbers (intel · code · agentic · $/M) guide
    routing.
- **Mission Control / Ensemble / OpenCode-Team / opencode-workflow**: one git worktree per agent, a DAG plan, a
  merge train with test gate and rollback, a shared task board.
- **awesome-opencode**, relevant entries:
  - graphify (code knowledge graph, 12 tools)
  - Opencode Mem, Agent Memory, Honcho (memory)
  - Dynamic Context Pruning, Magic Context (context)
  - CC Safety Net (destructive commands), Envsitter Guard (.env)
  - Background Agents, opencode-arise (async)
- **OpenAPPA**: deterministic guardrail.
  - It tracks a data-flow label (audience × trust) across tool calls; the label only narrows, never widens.
  - When it blocks, it returns a "remedy plan" with an allowed alternative instead of a bare refusal.
  - Sanitizers mask secrets, "authorities" give one-time approvals.
  - MIT licensed. A model for a later guardrail stage, not a must for v1.
- **Jev in agent harnesses**: confidence-gated routing is the documented pattern:
  - act on cheap read-only decisions above a high confidence,
  - ask on costly ones,
  - hand over to a person or a strong model when confidence is low.

  A working Jev client exists in the oc-voice project (`decision/systemone.py`); its request shape is reused.
- **OpenCode** (agents, plugins):
  - Agents are markdown files in `~/.config/opencode/agents/` (frontmatter: mode, model, temperature,
    permission, steps).
  - Plugins live in `~/.config/opencode/plugins/`, with custom tools via `tool()`, hooks such as
    `tool.execute.before`/`after`, `session.idle`, `permission.asked`, and an SDK client (`session.create`/`prompt`).
  - The docs describe v1; whether v2.0.18 behaves the same is checked in Phase 0.
- **OpenCode Go models the router may use** (user, 2026-10-01; no Kimi, no Grok, no glm-5.3 / deepseek-v4-pro,
  whose flash variants are cheaper and better):
  - For now only three (user, 2026-10-01, after a price/benchmark search):
    - **glm-5.3-flash**: $0.15/$0.50 per 1M tokens; best agentic coding (DeepSWE 63.4); slow, text only.
    - **qwen3.8-flash**: $0.30/$0.94; best tool use (Toolathlon 73.5); the only one with image/video input.
    - **deepseek-v4.1-flash**: $0.15/$0.60 at night, twice that at peak; fastest, most requests per month,
      verbose.
  - Left out:
    - mimo-v2.6-flash: drafts only in tests.
    - gpt-6-luna: 3–4× the price.
    - longcat-2.0: no solid benchmarks.
    - The rest: 10–100× the price.
  - Three families, so a reviewer from another family is always available. There is no stronger tier to
    escalate to: escalation means switching to another of the three.
  - Sources: ocgo-pricing.all-the.rest · regolo.ai (DeepSeek V4 Flash vs Qwen3.8-Flash vs GLM-5.3-Flash) ·
    artificialanalysis.ai · computingforgeeks.com (MiMo V2.6) · benchlm.ai

Sources: github.com/code-yeongyu/oh-my-openagent · glukhov.org/ai-devtools/opencode/oh-my-opencode-agents ·
lzw.me/docs/opencodedocs/code-yeongyu/oh-my-opencode/advanced/background-tasks · github.com/marco-jardim/opencode-model-router ·
github.com/GFN-CIS/opencode-squad · github.com/nigel-dev/opencode-mission-control · github.com/hueyexe/opencode-ensemble ·
github.com/awesome-opencode/awesome-opencode · github.com/javargasm/opencode-graphify · openappa.com ·
typesafe.ai/blog/introducing-system-one-models-and-jev · opencode.ai/docs/plugins · opencode.ai/docs/agents

## Phase 0 results (spike against a separate hub on :4097, opencode 2.0.18, 2026-10-01)
- **v1 plugins (`export const X = async ({client}) => ({tool, event, …})`) are not loaded by v2.** v2 plugins
  are: `export default define({ id, setup: async (ctx) => … })` from `@opencode-ai/plugin/v2/promise`, placed in
  `~/.config/opencode/plugins/`. setup runs when a project location is first used.
- At runtime `ctx` offers much more than the typed SDK (1.18.32) shows:
  - `tool{list, transform, hook}`
  - `session{create, get, prompt, wait, interrupt, switchAgent, switchModel, generate, command, synthetic,
    update, move, context, hook}`
  - `event{subscribe}`, `permission{hook, list, get, reply}`
  - `worktree{list, create, remove, refresh}`
  - `generate{text}` (a cheap model call, e.g. for classification)
  - `model`, `provider`, `agent{list, get, transform}`, `storage{get, set, remove, scan}`
  - `location`, `rpc`, `mcp`, `skill`, `command`, `websearch`, `vcs`, `shell`
- **Custom tools work** via `ctx.tool.transform(draft => draft.add({id, name, description, input, output,
  options, execute}))`.
  - `input` must be a schema of the server's own Effect instance. One from the local `effect` package fails
    with "root: Expected object". Building it from a built-in tool's schema works (`read.input.mapFields(() =>
    ({prompt: str, model: str}))`).
  - `execute(args, ctx)` gets `{sessionID, agent, messageID, id, progress, signal}`.
  - The model called the tool, and the arguments arrived parsed.
  - Still open: the matching `output` schema (`read.output` rejected the return value).
- v2 has a built-in `subagent` tool, and tool `options.codemode` (built-in tools set `false`).
- **Markdown agents in `~/.config/opencode/agents/` were not loaded** by v2 (agents seen: build, general,
  explore, compaction, title, summary, plan) → the role matrix is defined in code via `ctx.agent.transform`.
- **A session permission rule `{action: "spike_spawn", effect: "ask"}` did not make the hub ask** → the
  dictator does not rely on the hub's permission rules for its own tools; it asks the user itself through
  OpenCode's `question` form when Jev says so (see "Questions and permissions").
- Sessions on a second server share `~/.local/share/opencode/opencode.db` (the spike's sessions were deleted
  afterwards).


## Architecture
```
user (OpenCode TUI) ──► dictator session (agent "dictator")
                            │  tools: plan · spawn_worker · worker_status · worker_output · worker_cancel · review · recall
                            ▼
                     plugin "jev-dictator" (v2 plugin in the hub) ◄──► TypeSafe Jev (typed decisions)
                            │  ctx.session.create / prompt / wait · ctx.worktree · ctx.event · ctx.storage · ctx.skill
                            ▼
                     worker sessions (agent per role, model per routing) ──► reviewer sessions (another family)
                            │  questions / permission requests
                            ▼
                     Jev answers (confident, low risk) ── or ──► the user, as a question form in the TUI
```
- **Plugin** (`plugin/` in this repo, installed into `~/.config/opencode/plugins/` by `install.sh`):
  - Holds the job and worker state in `ctx.storage`, so a restarted hub picks the job up again.
  - A queue enforces concurrency.
  - Routing reads `~/.config/opencode/jev-dictator.jsonc`.
  - It listens to `ctx.event` for workers going idle, failing, asking questions or asking for permissions.
- **Jev client** in the plugin (TypeScript):
  - The request shape is the same as in oc-voice's `decision/systemone.py`: state + typed questions → typed
    answers with probabilities.
  - The API key comes from the keyring (`secret-tool lookup service typesafe key jev`) or
    `JEV_API_KEY`; never in a config file.
  - The state sent to Jev is redacted: no secrets, paths shortened, file contents cut.
  - **Fallback without Jev** (no key, timeout, error): a cheap OpenCode model via `ctx.generate.text`
    (deepseek-v4.1-flash) answers the same questions as JSON. Its answers carry no calibrated confidence, so
    everything it decides goes to the user.

## Jev's decisions

### 1. Classification per sub-task (role → model → skills)
The dictator agent writes the plan (1–6 sub-tasks with acceptance points and "depends on"). For each sub-task
the plugin asks Jev in **one** request:
- `role` (choice): explore, research, plan, code, test, visual, write, debug, review, oracle.
- `difficulty` (score 0–1).
- `needs` (yes/no each): web, vision, code_graph, memory, long_context, run_tests.
- `risk` (yes/no): destructive or external effects.
- `self_or_delegate`: does the dictator do a trivial step itself?
- `skills`: one score per catalog skill.

Below `confidence_floor` for the role, the sub-task gets the next safer role (code → plan, research → explore)
or the dictator asks the user.

**The model** comes from role × needs (× time of day):
- Each role has a first model and one fallback.
- vision → qwen3.8-flash (the only one with image input).
- Mass and search work prefers deepseek-v4.1-flash at night (half price).
- Difficulty does not pick a stronger model (there is none among the three). It raises the step limit and the
  review depth: hard sub-tasks always get a reviewer and run tests.
- After 2 failed reviews the worker switches to its fallback model, once.

**The skills:**
- The plugin keeps a catalog from `ctx.skill` (name, description, path): `~/.config/opencode/skills/` and the
  project's `.opencode/skills/`.
- A worker loads at most 3 skills above `skill_floor` at its start. A skill can be tied to roles (e.g.
  `omarchy` only for code/debug, never for review).
- The worker's own `skill` tool stays allowed; what it loads itself is logged.
- With an empty catalog this step is skipped. When the dictator misses a skill for a recurring kind of task,
  it suggests writing one.

### 2. Questions and permissions (Jev answers or the user does)
OpenCode's `question` form has fixed options, and permission requests are allow/deny. Both are typed choices,
so they fit Jev exactly. When a worker asks:
1. The plugin catches it (`ctx.event`: question / permission asked) before the user sees it.
2. Jev gets the worker's sub-task, its acceptance points, the question with its options (or the permission
   with tool, command, path) and the job's rules. It answers:
   - `answer` (choice among the options)
   - `risk` (score)
   - `needs_user` (yes/no, e.g. matters of taste, money, anything outside the project)
3. **Jev answers itself** only if all of these hold:
   - its confidence is at or above the floor for the risk class,
   - `needs_user` is below its floor,
   - no hard rule applies.

   The floors per risk class:

   | risk class | examples | floor |
   |---|---|---|
   | read | read/grep outside the worktree, webfetch of docs | 0.80 |
   | write | edit inside the worktree, run tests, install a dev dependency | 0.92 |
   | always the user | delete outside the worktree, git push/merge, network writes, secrets, money, anything denied by the role | never automatic |

4. Otherwise the plugin passes the question on unchanged; it shows in the TUI as usual. When it has a guess, it
   adds Jev's suggestion and confidence to the question text ("Jev suggests 'yes' (0.71)").
5. Every automatic answer is logged: job, worker, question, chosen option, confidence. `/dictator log` shows
   them, so the user can see what Jev decided. A setting per job: "Jev answers nothing" (everything to the user).

Worker starts use the same path: for now the user confirms each one (decision). The confirmation shows role,
model, difficulty and skills ("Start worker 'write tests' as tester with glm-5.3-flash (medium), skills:
pytest? yes/no"). Later the read-only roles can be confirmed by Jev.

## Role matrix
Defined in the plugin via `ctx.agent.transform`, because v2 does not load agent markdown files. Rights are the
OpenCode permission per tool: allow / ask / deny. Write rights apply only inside the worker's worktree.

| role → agent | job | read/grep/glob | edit/write | bash | web | graphify / memory | model → fallback (opencode-go/…) |
|---|---|---|---|---|---|---|---|
| explore → `explorer` | find code, map structure | allow | deny | deny | deny | allow | deepseek-v4.1-flash → qwen3.8-flash |
| research → `researcher` | docs, web, other repos | allow | deny | deny | allow | allow | deepseek-v4.1-flash → qwen3.8-flash |
| plan → `planner` | split, acceptance points, no code | allow | deny | deny | ask | allow | qwen3.8-flash → glm-5.3-flash |
| code → `coder` | implement, refactor | allow | allow | ask | deny | allow | glm-5.3-flash → qwen3.8-flash |
| test → `tester` | write + run tests | allow | allow (tests only) | allow: test runners · ask: rest | deny | allow | glm-5.3-flash → deepseek-v4.1-flash |
| visual → `visual` | UI, CSS, screenshots | allow | allow | ask | deny | allow | qwen3.8-flash (image input) |
| write → `writer` | docs, README, commit text | allow | allow (*.md, docs/) | deny | deny | allow | deepseek-v4.1-flash → qwen3.8-flash |
| debug → `debugger` | reproduce, find the cause | allow | ask | ask | ask | allow | glm-5.3-flash → qwen3.8-flash |
| review → `reviewer` | check against acceptance points | allow | deny | allow: tests/lint only | deny | allow | another family than the worker: qwen3.8-flash for GLM/DeepSeek, glm-5.3-flash for Qwen |
| oracle → `oracle` | hard decisions, architecture | allow | deny | deny | ask | allow | qwen3.8-flash → glm-5.3-flash |

- **`dictator`** (primary) plans, classifies through the plugin and delegates. It has no edit or bash: only the
  dictator tools, read/grep/glob and graphify queries.
- An "ask" in this table is a question that goes through Jev first (section 2), not straight to the user.
- The reviewer answers in strict JSON `{verdict: PASS|FAIL, checks: [...], fixes: [...]}`.
- Prompts come in two variants per model family (lesson from OmO).

## Loops and parallelism
- **Improvement loop** per worker:
  1. The worker finishes.
  2. The reviewer checks against the acceptance points and runs tests when there are any.
  3. FAIL → the fixes go back into the same worker session.
  4. At most 2 rounds, then the fallback model, then the user ("worker 'tests' failed 3 times: continue or
     cancel?").
  5. Results are merged only after PASS.
- **Parallelism**:
  - At most 3 workers at a time per job, at most 2 per model. Each worker times out after 30 min.
  - Each job has a budget of worker starts (default 6).
  - Independent sub-tasks of the DAG run in parallel.
  - Workers that write run in their own git worktree (`ctx.worktree.create`). A merge needs PASS and the
    user's yes; nothing is pushed.

## Guardrails
- Hard rules in `tool.hook` that Jev cannot override:
  - Denied commands: `git push --force`, `rm -rf` outside the worktree, `curl | sh`, `sudo`.
  - Writes only inside the worker's worktree. `.env*` and keyring files are never readable.
- Jev's `risk` above its floor: the sub-task runs read-only (plan role) first, or the user is asked.
- Untrusted content (web pages, tool output) is never followed as instructions. Jev screens a worker's question
  for injection ("ignore your rules …") before it answers it; a hit goes to the user.
- Kill switch: `/dictator stop` cancels every worker and empties the queue.
- Later stage: OpenAPPA-like data-flow labels (content from a webfetch may not flow into bash arguments without
  a check).

## Memory and code knowledge (Jev decides when)
- **graphify** (`opencode-graphify`): dictator, explorer and oracle may query it. It is built per repo on
  request and rebuilt when stale.
- **Memory**: a small store in the plugin (`ctx.storage`, per project): facts the user confirms and lessons from
  failed reviews (the OmO "Kibitzer" idea), exposed as `recall` / `remember`. Opencode Mem or Honcho are tried
  later, if this is not enough.
- **When**: Jev's `needs` answers. With `code_graph` the worker gets "query graphify first", with `memory` a
  `recall` runs before the sub-task, so the context stays small.
- **Context**: Dynamic Context Pruning for long worker sessions, tried in Phase 4.

## Layout
- In the OpenCode TUI: the dictator session; workers are child sessions (OpenCode's child-session navigation).
- `/dictator` command:
  - `status`: job → workers with role, model, status (queued / working / review / PASS / FAIL)
  - `log`: Jev's automatic answers
  - `stop`
- With herdr (optional): one tab per job, the dictator on the left, worker TUIs split on the right. Nothing in
  the plugin depends on it.

## Phases (each its own small commits, English)
0. **Spike**: done (results above).
   - Open: the output schema for custom tools.
   - Open: catching a worker's question/permission event before the user sees it (`ctx.permission.hook`,
     question events).
   - A small model bench (5 tasks × the three models) for the routing table.
1. Repo skeleton (plugin, `install.sh`, bun tests) + role matrix via `ctx.agent.transform` + routing config +
   the dictator with `spawn_worker` (sequential), worker starts confirmed by the user in the TUI.
2. Jev client (keyring key, redaction, model fallback) + classification (role, difficulty, needs, risk,
   skills) + skill catalog.
3. Questions and permissions through Jev (floors per risk class, hard rules, log, suggestion text).
4. Queue + concurrency + worktrees + status/output/cancel + timeouts + the `/dictator` command; Dynamic
   Context Pruning.
5. Reviewer + improvement loop + fallback model + the question to the user after 3 failures.
6. graphify + memory store (`recall` / `remember`) + the hints Jev chooses.
7. Guardrail hardening: path allowlist, command denylist, budgets, injection screening, kill switch.

## Verification
- Phase 0: a spike against a separate hub. The dictator agent calls `spawn_worker`, and the worker session runs
  on the routed model.
- bun tests:
  - routing (classification → role, model, skills)
  - queue and concurrency
  - Jev answering or passing on per risk class, with a fake Jev
  - hard rules never overridden
- Live per phase: a test job in a throwaway repo ("write a README and a test"). Check:
  - two workers confirmed in the TUI,
  - a worker question answered by Jev and one passed to the user,
  - a review FAIL → fix → PASS,
  - `/dictator stop`,
  - no push, worktrees cleaned up.
