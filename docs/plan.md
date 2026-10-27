# micromanager: an OpenCode orchestrator driven by Jev

Status (2026-10-04): Phase 0 (spike) and Phase 1 done, and Jev on permission requests works (part of the old
Phases 2 and 3). The design was reworked on 2026-10-03/04: [design.md](design.md) is now the design and
[design.html](design.html) its flow chart. Extended the same day by local vs cloud routing, censorship guards, decision backends (cloud Jev or
local GLiNER) and user overrides (design.md §19–§22). Phases A (spikes), B (core), C (planning session and gate) and D (classification and profile) are done (results
below); the next step is Phase E.

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
- **Own OpenCode v2 plugin** in its own repo (`~/Fun/Projects/Repos/micromanager`), not OmO itself.
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

**Research 2026-10-03 (orchestration, loops, ecosystem).** It shaped design.md:
- **State models:**
  - Magentic-One: a task ledger with a fact sheet, and a progress ledger asking satisfied / in loop / progress.
    A stall counter triggers a replan.
  - Task Master: task fields, a complexity score with an expansion threshold, next-task order.
  - LLMCompiler: greedy DAG dispatch.
  - spec-kit / Kiro: `[P]` markers and dependency waves.
  - OpenHands: stuck patterns.
- **Loops:**
  - Ralph: a fresh context per item, tests as backpressure, a hard cap.
  - superpowers subagent-driven development: status codes, fix rounds, model escalation.
  - opencode-squad PDCA: max 3 rounds.
  - "Progress mirage": self-judged progress is unreliable, so ground "done" outside the model.
  - Reviews from another model family.
- **Ecosystem** (v2-checked, see design.md §13):
  - Many awesome-opencode plugins are v1 and do not load in OpenCode v2.
  - Usable as is: cc-safety-net, DCP, opencode-agent-memory, otel, shell-strategy, and MCP servers (Serena,
    context7, ast-grep).
  - opencode-research-papers is v1.
- **Planning:**
  - vibe-wise `learn`: the user reasons, the agent gives feedback.
  - mattpocock `grilling`: a design tree with a frontier; facts are looked up by agents.
  - mattpocock engineering skills: tdd, diagnosing-bugs, two-axis code-review, to-tickets.
- **Jev:**
  - Several questions per request, answered in parallel and in isolation; no multi-select type.
  - Open-Jev's JSONL row format fits our journal, for training a local Jev.

**Local models and GLiNER, 2026-10-04:**
- **The local fleet**, from `~/Models/bench/ROSTER.md`:
  - llama-swap `:8000` on the RTX 4060: gpt-oss-20b unc, Ornith-1.5 unc / stock, MiMo, Qwen3.5-4B unc. One
    model at a time; a swap takes 1–2 min.
  - `qwen3.8-u` 27B unc, resident on the iGPU (`:8092`).
  - FLM on the NPU (`:52625`): qwen3 4B models and gpt-oss-20b.
  - Every local model runs with 16k context.
- **oc-voice's GLiNER verdict:** LoRA fine-tunes of GLiNER2.5-Decide match or beat cloud Jev on guards
  (injection and harmful at recall 1.0 / fpr 0.0) but reach 0.85 against 0.98 on intent. So the backend is chosen
  per question family.
- **GLiNER does not run on the NPU.**

Sources are listed at the end of design.md.


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
  micromanager does not rely on the hub's permission rules for its own tools; it asks the user itself through
  OpenCode's `question` form when Jev says so (see "Questions and permissions").
- Sessions on a second server share `~/.local/share/opencode/opencode.db` (the spike's sessions were deleted
  afterwards).

## Phase A results (spikes against private standalone servers, opencode 2.0.18, 2026-10-04)
**Setup.**
- A spike plugin in its own `XDG_CONFIG_HOME`, so neither the micromanager plugin nor the user's hub was
  touched.
- `opencode run --standalone` in a throwaway git project.
- Every session was deleted afterwards.

**Plugin context (v2 runtime).** `ctx` has app, location, options, agent, aisdk, command, event, experimental,
generate, model, provider, integration, mcp, permission, plugin, reference, rpc, skill, storage, tool, vcs,
websearch, worktree, session, shell.
- **`ctx.session`:** `hook, create, get, switchAgent, switchModel, prompt, generate, command, synthetic, interrupt,
  update, move, wait, context`. Its arguments follow the server API, e.g. `wait({ sessionID })`.
- **Hook names found in the binary:**
  - session: `prompt`, `context`, `compaction`, `generate`, `title`, `model.request`, `http.request`,
    `http.response`, `retry`;
  - tool: `execute.before`, `execute.after`;
  - permission: `evaluate`;
  - shell: `create.before`.
- **`ctx.shell`** only has a hook; there is no way to run a command through it.

**A1 user turns and steering.**
- `session.hook("prompt")` gets `{sessionID, messageID, prompt: {text, files, agents, skills}, metadata,
  delivery}` for every user turn and may rewrite it.
- **Steering through the user text failed.** deepseek-v4.1-flash called an appended "note from the plugin" an
  injection and ignored it.
- **Steering through the system prompt worked.** `session.hook("context")` gets `{sessionID, model, system,
  messages, options, agent, tools}`, where `system` is an array of `{type: "text", text}`. A pushed system block
  was followed (the reply ended with the requested token).
- **`session.synthetic({sessionID, text, resume: false})`** also worked: the child answered with the injected
  secret word.

**A2 workers.**
- `session.create({parentID, title, agent: "explore", model: {providerID, id}})` created the child in about
  10 ms, with that agent and model.
- `prompt({sessionID, text})` then `wait({sessionID})` returned when the child was done; `context({sessionID})`
  returned its messages.

**A3 custom tools.**
- With no `output` schema, `execute` returns `{content}`.
- With an output schema, it returns `{output, content}`. The input schema reused as output schema worked.
- The model reached both through the `execute` code-mode tool.

**A4.**
- `session.interrupt({sessionID})` stopped a long child at once ("Step interrupted").
- **Worktrees:**
  - `worktree.list/create/remove({projectID, …})`, where `projectID` comes from `ctx.location.project.id`.
  - The worktree is created in `~/.local/share/opencode/worktree/<project>/<name>`.
  - `branch` must be an existing branch, otherwise the HEAD is detached; `from` is the directory of a registered
    worktree, not a git ref.
  - The project config's `commands.start` runs after create.
- `ctx.event.subscribe(cb)` returned but delivered no events in a standalone run.

**A5.**
- `permission.hook("evaluate")` fires for allow and ask (deny short-circuits before it). Setting `effect = "deny"`
  with a message blocked the read.
- `session.create({permissions: [{action: "read", resource: "*", effect: "deny"}]})` removed `read` from the
  child's toolset. The child then read the file with `grep`, so profiles must deny tool groups.

**A6.**
- `cc-safety-net@2.5.2` (no dependencies; `checkCommand({command, cwd})` → `allow` or `deny` with `ruleId`)
  imported fine from a plugin file symlinked into the plugins directory. `import.meta.url` is the real path.
- **It denies:** force push, `reset --hard`, `clean -f`, `checkout --`, `rm -rf` outside the cwd, `find -delete`,
  `dd` to a device, `.env` reads, dynamic `curl | sh`.
- **It allows:** `rm -rf node_modules`, and `sudo pacman -S` (our own rule catches that).

**A7.** The task: read a file, compute with bash, answer.
- **Correct, each tool once:** glm-5.3-flash, qwen3.8-flash, deepseek-v4.1-flash, `ornith-u` on the 4060 (17 s,
  one extra shell call), `qwen3.8-u` on the iGPU (125 s). Reasoning and tool results stayed in every later turn's
  context.
- **`qwen3:4b` on the NPU** (107 s) answered correctly but skipped the bash tool.

**A8.**
- llama-swap reports `loaded` / `unloaded` per model and the running model's state.
- llama-vulkan reports `/health`, `/props` (n_ctx 16384) and `/slots` (4 slots with `is_processing`).
- FLM lists only its catalog.
- **Swap times:** cold to warm, with the file in the page cache: ornith 17.1 s, mimo 12.0 s, ornith-u 19.4 s.
- **Warm replies:** 0.8–7.9 s.

**A9.** GLiNER2 on the CPU, 8 threads, four G0 guards per request, 13 cases:
- **Speed:** about 370 ms per request, 2–3 s load.
- **Zero-shot `GLiNER2.5-multi-Decide`:** about 0.5 everywhere, useless.
- **oc-voice fine-tune `multi-decide-g2`:**
  - injection: 1.0 on both attacks;
  - harmful: 1.0 on all three harmful cases, but also 1.0 on a port scan of the user's own LAN and 0.53 on
    harm-reduction;
  - `refusal_likely`: unknown to it (0.0);
  - `sensitive`: right on bank data and credentials, with false positives;
  - credential rotation: also flagged as injection.

**A10.** Only the swap time was measured. The refusal probe set comes from the user's own bench cases; the
`worker_refused` patterns are calibrated on it.

**Decisions from Phase A.**
- **GLiNER runs on the CPU.** The NPU is reserved for Whisper V3 Turbo plus at most one small quick-tier LLM.
- **Workers are plugin sessions.** Profiles are session permissions per tool group, plus the evaluate hook.
- **Steering** goes through system blocks and synthetic messages.
- **The watchdog** reads tool and context hooks.
- **Gates** run through `child_process`.
- **G0 on GLiNER** only asks the user until our guard fine-tune passes the bench.

**Side finding.** A private standalone server sometimes hung at start, before it loaded any plugin. The spike
harness detects an empty log after 40 s and retries.

## Design
The architecture, the job state, the planning session, Jev's decision nodes, the pipelines, the loop watchdog,
parallelism, the stack and the decision dataset are in [design.md](design.md). It replaces this file's earlier
sections "Architecture", "Jev's decisions", "Loops and parallelism", "Guardrails", "Memory and code knowledge"
and "Layout".

What is implemented (2026-10-04):
- **The role matrix** as OpenCode agents via `ctx.agent.transform` (`src/roles.ts`, `src/agents.ts`).
- **Model routing** on the micromanager's `subagent` call (`src/routing.ts`, `src/hooks.ts`).
- **The Jev client** (`src/jev.ts`):
  - the key from `JEV_API_KEY` or the keyring,
  - redaction,
  - retries on 429/529.
- **Permission decisions** (`src/decide.ts`): hard rules → deleted-path facts from git → Jev → floors per risk
  class. Without Jev, everything goes to the user.
- **The decision journal** (`src/journal.ts`, `permission` and `routing` entries) and the flow page
  `docs/flow.html`.

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

- **`micromanager`** (primary) plans, classifies through the plugin and delegates. It has no edit or bash: only the
  micromanager tools, read/grep/glob and graphify queries.
- An "ask" in this table is a question that goes through Jev first (section 2), not straight to the user.
- The reviewer answers in strict JSON `{verdict: PASS|FAIL, checks: [...], fixes: [...]}`.
- Prompts come in two variants per model family (lesson from OmO).

## Phases (each its own small commits, English)
0. **Spike**: done (results above).
1. Repo skeleton, role matrix, routing config, the micromanager agent, install script: done. Jev client and
   permission decisions: done.

From here on, the phases follow design.md (§16 MVP cut, §17 spikes):
- **A. Spikes A1–A10: done 2026-10-04** (results above; A10 waits for the user's refusal probe set). Order was A1
  (chat-turn hook + steering) first; then A2, A3, A4, A7, A8 (local availability),
  A9 (GLiNER decision server), A10 (refusal detection), A6, A5. Each result picks the
  design or its named fallback.
- **B. Core: done 2026-10-04** (results below the phase list):
  - state, FSMs, agenda and rules fallback;
  - the integration branch;
  - the planner subagent writing plan JSON, with the DAG validated;
  - one task at a time on P1;
  - journal with state objects, eval harness, dataset export;
  - the model registry, decision backends per node (typesafe, gliner, rules), the policy / override layer;
  - the GLiNER decision server.
- **C. Planning session and gate: done 2026-10-04** (results below the phase list):
  - G0 local-first gate with the four guards (sensitive, refusal_likely, injection, harmful) and the guard
    bench;
  - the `deliberate` skill;
  - design tree validation, frontier, N2 / N2b / N2c, shortcuts, question caps, design checkpoint;
  - the facilitator on the session model;
  - the micromanager read cap; the "answer yourself" line removed from the micromanager prompt.
- **D. Classification and profile: done 2026-10-04** (results below the phase list):
  - N4 split until small;
  - N5+N5b in one request;
  - N6 with P1–P3 and P9;
  - profile narrowing in the evaluate hook;
  - skill vendoring + `install.sh --skills`;
  - brief and report;
  - caveman on outputs;
  - routing over the registry: locality, censorship, difficulty tier, live availability. Per-device concurrency
    is only "local readers take turns" so far; batching tasks by model belongs to Phase F.
- **E. Quality loop: done 2026-10-05** (results below the phase list):
  - gates run by the plugin;
  - two-axis review;
  - improvement loop;
  - **the loop watchdog** (done early, 2026-10-04);
  - N8 signatures;
  - the N9 ladder with handoff notes;
  - budgets including requests and tokens;
  - the `worker_refused` signature and the locality-aware ladder.

  Added on the user's request: the task queue (priorities, follow-ups that become tasks, replan), background runs
  with updates and notifications, and guardrails past the goal.
- **F. Parallelism: done 2026-10-05** (results below):
  - parallel readers;
  - parallel writers in worktrees;
  - the merge train into the integration branch;
  - batch confirmation.
- **G. Flagged pipelines:** P0, P4–P8, Ralph; DCP. Each is switched on only with eval evidence.
- **H. Extras:** memory plugin, research extras (papers skill, context7, Serena, graphify).
- **J. Local decision model:** GLiNER shadow mode → retraining on Jev's answers, overrides and outcomes → a
  promotion gate per node, with demotion on rising overrides.
- **I. Visibility:** design.html / flow.html lanes from the journal, `/micromanager status|log|stop`, otel, later
  wayfinder maps.

### Phase B results (2026-10-04)
**What exists now:**
- `src/state.ts`, `plan.ts`, `agenda.ts`: job and task FSMs, plan parsing and validation, agenda.
- `src/store.ts`: job files.
- `src/policy.ts`: overrides and chat shortcuts.
- `src/registry.ts`: models, availability, router.
- `src/backends.ts`: decision backends, shadow mode.
- `src/dataset.ts`, `eval.ts`, `cli.ts`: the training rows and the eval harness.
- `src/integration.ts`, `brief.ts`, `runner.ts`, `tools.ts`: the job branch, briefs and reports, the P1 runner,
  the micromanager tools.
- `decider/`: the GLiNER server.
- Tests: 63 TypeScript tests, 5 Python tests.

**Live, in a throwaway project** (private standalone server with the real plugin, cloud model by preset):
- The micromanager called `plan_job`. The planner made 2 tasks with 3 checks.
- `run_job` ran both on `jev/<job>` in `.jev-micromanager/worktrees/<job>`. Both checks passed on the first
  try, and each task became a commit.
- The user's checkout stayed untouched, and `npm test` in the worktree passed.

**Findings:**
- **Permission prompts of plugin-started workers are not answered in headless `opencode run`.** `--auto` only
  covers the run's own session. A worker whose shell command Jev was unsure about (0.17) waited until it was
  stopped.
  - The fix used: permission presets per action (`"N13.shell": "fixed:allow"`). A preset applies after the hard
    rules and the deleted-path check and replaces Jev.
  - Still to check in Phase C: how these prompts reach the user in the TUI.
- **Job state lives in files, not in `ctx.storage`.** `ctx.storage` was not verified; the file is readable and
  needs no copy.
- **The integration worktree lives inside the project** (`.jev-micromanager/worktrees/`), so workers trigger no
  `external_directory` ask. It starts from the last commit, so the user's uncommitted changes are not part of a
  job.
- **Planners write verify commands** that the plugin runs with `sh -c` at low priority. The planner chose sound
  checks (an import check, `npm test`).

### Phase C results (2026-10-04)
**What exists now:**
- `src/catalog.ts`: the question wordings and floors.
- `src/gate.ts`: G0 with the four guards. A flagged guard asks the user; an unchecked job stays local.
- `src/session.ts`: the design tree, frontier, one question per turn, shortcuts, caps and checkpoint.
- **Runner:** `start`, `continueJob`, `questions`, `answer`.
- **Plugin:**
  - `plan_questions`;
  - the prompt hook reads the user's turns and pins;
  - the context hook adds the micromanager's instruction as a system block;
  - the micromanager's reads are capped at 12 per session.
- `skills/deliberate` with `install.sh --skills`.
- `bench/guard_cases.json` and `npm run bench-guards`.
- Tests: 77 TypeScript tests, 6 Python tests.

**Live, in a throwaway project** (real plugin, the GLiNER server on the CPU at low priority, cloud Jev for
N1 / N2 / N2b / N2c, workers on a cloud model by preset):
- G0 ran locally (about 0.5 s) and flagged nothing. N1 gave complexity 3 and open decisions 0.73, so a planning
  session started.
- The micromanager drafted 5 decisions. Over 5 turns it asked one open question each time; the user's words were
  stored as answers, "skip" turned one question into an assumption, and Jev picked the order (N2b).
- The checkpoint showed the decisions apart from the assumption, which was marked as a proposal. After
  "confirm" the planner wrote 2 tasks with 7 acceptance points carrying every decision, and "go" ran both tasks
  to commits.
- The result matched the decisions, and its 10 tests passed.

**Guard bench with the oc-voice fine-tune** (16 cases, floor 0.5):
- injection: recall 100 %, false positives 7 %;
- harmful: recall 100 %, false positives 8 %;
- refusal_likely: recall 0 %, false positives 17 %;
- sensitive: recall 33 %, false positives 23 %.

So our own fine-tune is needed before a guard may decide alone (Phase J).

**Fixed during the live test:**
- **A firm answer was read as "asks for options".** It scored settles 0.93 and asks_options 0.71, and the
  micromanager explained options. A clear decision now wins.
- **The micromanager re-sent the goal mid-session and after "confirm", which started new jobs.** A goal now
  continues the session's unfinished job.
- **The draft listed possible answers inside its questions, and one asked question gave example answers.** The
  draft and ask instructions now forbid options and examples.
- **The decision server kept working on requests whose client had timed out.** It now drops them (it checks the
  connection between questions). The client waits 5 s instead of 2 s, and the bench reports "no answers"
  instead of 0 %.

**Open:**
- **How a worker's permission prompt reaches the user in the TUI.** Headless runs need presets. In the run
  above, `--auto` also approved the micromanager reading files outside the project when it got confused; in the TUI
  that is an ask.
- **Transliteration:** "Straße" became "strae" (ß dropped). It is consistent with "drop what has no ASCII
  equivalent", but a review stage (Phase E) should question such details.

### Phase D results (2026-10-04)
**What exists now:**
- `src/profile.ts`: N5 + N5b in one request per task. The role matrix is the upper bound; a task that needs shell or
  web never keeps a role without it; contradictions cost confidence. The profile narrows rights per tool group,
  as the worker session's own permission rules and again in the evaluate hook.
- `src/pipelines.ts`: N6 by rules over the N5 answers (§8.1), "pipeline P2" pins it.
  - P1: implement, gate, fix rounds.
  - P2: plus a review by another model family, at most 3 rounds; findings block only with evidence.
  - P3: a test session writes the tests first; anything else it writes is undone; the tests must fail, are
    frozen (content hashes), then the implementation and a review. No red, or tests that already pass: P2.
  - P9: 1, 3 or 5 readers with their own angles, in parallel in the cloud and one after another on a local
    model; a synthesis in `docs/research/`; a citation check by code.
  - Destructive risk and "ask me about everything" wait for the user's go; an injection-flagged task is blocked.
- N4 in `src/plan.ts` and the runner: too big and splittable → the planner writes the parts, code re-validates
  (parent's files only, every point covered, no split that only adds coordination); two levels at most.
- `skills/`: six leaf skills adapted from mattpocock/skills and obra/superpowers (MIT, `skills/THIRD_PARTY.md`);
  `src/skills.ts` names them by rule or by N5, and only when the OpenCode link is ours.
- Briefs carry skills, lessons and shared-point notes; reports and reader notes are caveman.
- `run()` reconciles a run that ended mid-task.
- Tests: 116 TypeScript tests.

**Live, cloud workers by preset (deepseek-v4.1-flash), cloud Jev, GLiNER for G0:**
- **Run 1** (a stats module, tests, README; before Phase D): 3 of 4 tasks committed, 8 tests green, no watchdog
  signal. The planner gave "run the test suite" to oracle, which has no shell; that worker then asked for a path
  outside its worktree and waited for an answer nobody could give.
- **Run 2** (a median bug and a new `percentile`, the same goal twice):
  - N4 split nothing.
  - N5 made the bug fix and the new function P3. Both red stages failed before the change, both reviews passed.
    The README task ran as P1. Jev itself moved the verification task from oracle to review (0.79).
  - The run was cut off once inside T4 (a harness timeout); `run_job` resumed it with T4 started again.
  - Result: 4 commits, 13 tests green, `median` no longer mutates the caller's array, `percentile` throws
    `RangeError` in all three cases.

**Fixed during the live tests:**
- **Sessions the runner starts never wait on the user.** A worker or reviewer asking for anything outside its
  directory is denied with a note; any request that would go to the user is denied with "report NEEDS_CONTEXT",
  so the job stops and the micromanager asks in its own session. This answers Phase C's open point for the TUI too.
- **The micromanager tried to get past the gate.** G0 flagged the goal as injection (0.59). The micromanager called
  `plan_job` with "continue", then `run_job`, then read the plugin's own source outside the project,
  before it asked. The gate's result now says only the user can answer; the micromanager is denied
  `external_directory`.
- **Shared acceptance points** are marked per task in the brief and the review prompt. A reviewer of the median
  fix had asked for the percentile tests of the next task.
- **"Another family" compared different names** (`qwen3` from the model id, `qwen` in the registry).
- **A failing `session.wait()` leaked the 20-minute timer.**

**Open:**
- **G0 is not stable on the same text:** the identical goal scored injection 0.59 in one run and 2e-8 in the
  next. Phase J's fine-tune and the guard bench need a repeat-run check.
- **N5 sees the whole job text,** so a new-function task in a job that also fixes a bug was classified as a bug fix
  too. Harmless here (P3 either way); the state could carry the job goal more weakly.
- **The code-mode `execute` tool** lists every tool, `run_job` included, to role agents. Whether its nested
  calls pass the evaluate hook is not verified; the narrowed-rights deny in the hook is the safety net.
- **`glob` with `hidden: true`** shows file names under `.jev-micromanager/`; reads are denied.

### Phase E and F results (2026-10-05)
**What exists now:**
- **E0 (spike, private server):**
  - A tool called through the code-mode `execute` tool carries the caller's agent, so the micromanager tools'
    agent check refuses role agents. Calls without an agent and calls from runner sessions are refused now too.
  - `tool.execute.after` is awaited, also when async, and can rewrite the result the model sees.
  - `session.synthetic` with `resume` starts a turn in an idle session and is steered into a busy one. Models
    took its text for an injection, so updates go in as system blocks.
- **E1 the task queue** (`src/state.ts`, `src/plan.ts`, `src/agenda.ts`, the runner's `#discover` and `#replan`):
  - priorities;
  - `FOLLOWUP` lines and reviewers' `outside` items through N7: a new task, dropped as already planned, or the
    "later" list;
  - a replan when stalled.
- **E2 background runs** (`src/scheduler.ts`):
  - `run_job` queues and returns;
  - progress as quiet messages, and the end as a system note plus a wake-up;
  - `notify-send`;
  - `stop_job`;
  - `run_job` with the user's answer as a note.
- **E2b guardrails:**
  - G0 on follow-ups and workers' permission requests;
  - injection checks on web results and research notes;
  - secrets masked in every prompt and in runner sessions' tool results;
  - G0 scored twice;
  - `bench-guards --repeat`.
- **E3 the ladder:**
  - N8 signatures;
  - rung 2 on another family with a handoff note;
  - rung 3 typed by N9 (too_hard replans, the rest asks the user);
  - token, request and cost budgets per job, and tokens per session by N5's tier.
- **E4:** a spec review and a standards review in parallel; confidence ≥ 80 with evidence blocks.
- **E5:** `worker_refused` reroutes once to a local uncensored model.
- **F:** parallel tasks in their own worktrees, N10 batch confirmation, a merge train, per-model slots.
- **A stalled session** (no change in 4 minutes) is interrupted and treated like a watchdog stop.
- Tests: 151 TypeScript tests.

**Live on a private `opencode serve`** (cloud only: local models off, routing over glm / qwen / deepseek; cloud
Jev; GLiNER for G0):
- **Run 1** (slugify with umlaut transliteration, tests, README; one task at a time, before the parallel and
  follow-up fixes):
  - "go" returned in 4 s. While the job ran, the micromanager answered a status question in 8 s.
  - All three tasks passed. Counters were exact (49k tokens and 21 requests after three tasks).
  - The two reviewers ran in parallel on glm and qwen.
  - It found two bugs, both fixed (see below).
- **Run 2** (two independent helpers and a suite check; parallel 3, the new code):
  - N10 confirmed T1 and T2 as independent (0.97 each). They started 0.1 s apart in their own worktrees, and the
    train merged T2, then rebased and merged T1.
  - "stop" through the micromanager paused the job in T3 and removed T3's worktree. "go on" resumed it, and reconcile
    started T3 again.
  - The end woke the micromanager through the system note. It reported the tasks, the branch and how to merge,
    without calling the note an injection.
  - No follow-up was reported twice.

**Fixed during the live tests:**
- **Workers reported the job's next tasks as follow-ups**, which became duplicate tasks. The brief now lists the
  other tasks, N7 asks "already planned", and the rule without Jev looks at open tasks' files.
- **The review hang of Phase D:** a reviewer's provider stream started and never completed, so the session waited
  until the 20-minute timeout. Now a session is stalled after 4 minutes without change, and a stalled reviewer
  gets one more try on another family.
- **A user's stop woke the micromanager a second time.** It is a quiet note now.
- **Found in the code while building F:** a task blocked on NEEDS_CONTEXT could never continue, and the user's
  answer never reached it. A parallel task that stopped an already stopped job broke its resume phase.

**Open:**
- **TUI:** the live runs used a private server and `opencode run --server`. How synthetic messages and progress
  notes look in the TUI is still to see in a run of the user's own.
- **Not exercised live:** budgets, the ladder's rung 2 and 3, worker_refused and the injection checks on web
  results. Tests cover them with fakes.
- **Reviewers' shell:** reviewers tried `git diff` and were denied (their bash is tests/lint only). They fell
  back to reading files, and the review prompt carries the diff.
- **Routing:** with every task on one family (deepseek won every worker role here), "another family" for review
  works, but the ladder's rung 2 needs the registry to offer more than one family per tier.

### omo-hybrid (2026-10-05)
On the user's decision, the micromanager moves toward oh-my-openagent: the LLM drives the flow, Jev and the plugin code
secure each task. The fully code-driven state stays on `main`, and the day's other work on `e-open`.

**What changed:**
- **`delegate_task`** delegates one task (title, prompt, files, dependencies, priority, checks) into the session's
  rolling job and returns at once. Tasks delegated while the job runs are picked up by the same run; independent
  tasks run in parallel in worktrees, and the merge train brings them onto the session's branch.
- **Each task's report** (status, checks, the worker's summary, follow-ups) goes to the micromanager. Reports close
  together arrive as one system note and one wake-up. At the end the micromanager is woken for the summary; "ulw" or
  "ultrawork" tells it to go on with its todos.
- **A task that needs the user** waits without stopping the others; `answer_task` passes the answer on, also
  while the job runs. `list_tasks` lists the tasks or shows one task's full report.
- **The micromanager prompt** is Sisyphus-like: split, todos, delegate in parallel, react to reports, short messages.
  `plan_job` / `run_job` stay for large jobs.
- **Lighter per task:**
  - P3 only for bug fixes;
  - a review only from risk public_api up, or without checks;
  - the standards axis only for data or security risk.
- **Opt-in nodes:** N9 (typing an escalation) and N10 (batch confirmation). N7's Jev request is not used for
  delegated tasks; the micromanager decides on follow-ups.
- **Also on this branch:**
  - routing breaks ties by the role matrix (code goes to glm, plan to qwen);
  - N5 classifies the task without the job's goal (is_bug_fix 0.91 → 0.08 on the Phase D case);
  - the N7 bench (`npm run bench-n7`).

**Live** (private `opencode serve`, cloud only, a blog project: slugify with umlauts, readingTime, excerpt, the
README):
- **Run 1:**
  - The micromanager delegated four parallel tasks in 35 s, but with prose as checks, which no worker could pass.
  - The workers said so, and the micromanager recognised its own mistake from the reports and set about fixing it.
  - Fixed after the run: checks must be shell commands; answers reach a running job; no progress messages in a
    rolling job.
- **Run 2:**
  - Four parallel tasks with `npm test` as the check, all merged without a fix round (code on glm, the README on
    deepseek). The branch's suite: 13 of 13.
  - The micromanager acknowledged each report briefly, sent a read-only reviewer over the whole branch on its own, and
    ended with a summary and `git merge jev/<job>`.

**Open:**
- A run in the user's TUI on a real repo.
- The micromanager reaches the plugin's tools through the code-mode `execute` tool; that works, but every call costs
  an extra turn.

### Spike: built-in background subagents in worktrees (2026-10-05)
The question: can the micromanager use OpenCode's own `subagent` tool (`background: true`: returns at once, the parent
is notified with the report, the child shows in the TUI) while each worker still runs in its own git worktree?
Private standalone server, spike plugin in its own `XDG_CONFIG_HOME`, deepseek-v4.1-flash, a throwaway repo with two
worktrees; the sessions were deleted afterwards.

**Findings:**
- **The plugin's `ctx.session.create` drops `parentID`.** It passes on only id, title, agent, model, metadata,
  permissions and location (seen in the binary; `parent_id` stays empty in `session_v2`). So the runner's worker
  sessions were never real children of the micromanager, although `#plannerSession` and `#workerSession` pass
  `parentID`.
- **The `subagent` tool only continues real children:** a session from `ctx.session.create`, passed as `sessionID`,
  fails with "Session … is not a child of the current session".
- **The core `Session.create` puts a child in its parent's directory** (`parent.location ?? input.location`).
- **`ctx.session.move({sessionID, directory})` works.** It queues a move in the session's inbox, ahead of the
  pending prompt, so the move is applied before the turn runs.

**What works:** the micromanager calls `subagent` as usual. The child is created in the checkout, and the plugin
moves it in the `session.hook("prompt")` of its first turn (text starts with "You are a subagent spawned by another
session.") into the task's worktree, before any tool runs.
- One background worker: `pwd` was the worktree, the branch the task branch, the file landed only there; the
  parent got the report through OpenCode's own notification.
- Two background workers in one message, each moved to its own worktree: both isolated (`a.txt` only in the first,
  `b.txt` only in the second).
- Continuing the first worker through `subagent` with its `sessionID` stayed in its worktree (it appended to its own
  file). `parentID` stays set after the move.

**Not tested:** how a moved child looks in the TUI (headless only); a move while the child already runs.

**Consequence:** built-in background subagents and per-task worktrees fit together. The plugin keeps its worktrees,
checks and merge train; OpenCode runs, shows and reports the workers. The hook needs to know which worktree belongs to
which call: `execute.before` on `subagent` sees the micromanager's call before the child exists, so it can make the
worktree and remember it for the next child prompt of that parent.

### Native workers (2026-10-05)
The micromanager now starts its workers with OpenCode's own `subagent` tool, in the background, and the plugin keeps
each writer in its own worktree (`src/native.ts`). The micromanager stays free while workers run, the workers show as
its child sessions, and OpenCode wakes it with each worker's report.

**The flow:**
1. The micromanager calls `subagent` with a role agent, a title and a prompt ending in `Files:` and `Checks:` lines
   (readers have neither).
2. `execute.before` (awaited; a throw becomes the tool's error, which the micromanager reads):
   - the guards look at the delegation;
   - the task goes into the session's job (`rolling`);
   - a writer gets a worktree off the session branch `jev/<job>`;
   - the prompt becomes the worker's brief, with a header naming task and job;
   - the routed model goes into the call, and `background` is forced on.
   Delegations of one message come at the same time; they run one after another per session.
3. The child's first prompt hook (text starts with "You are a subagent spawned by another session.") finds the task
   by the header and moves the child into its directory; the watchdog and Jev's permission rules apply to it as to
   the runner's workers.
4. A writer ends with `finish_task` (a plugin tool only writers see; workers reach it through code-mode `execute`):
   the checks run in the worktree. A failure goes back to the worker with the output; a pass commits, and the merge
   train rebases onto the session branch (checks again when it moved) and fast-forwards it. A conflict goes back to
   the worker.
5. On the merge, a quiet note "[micromanager] T… merged into …" goes into the micromanager's session; OpenCode's
   notification with the worker's report follows and wakes it.
6. When the worker's run ends (`session.wait`, started from its first context hook): a merged writer's worktree is
   removed; a writer that did not get through `finish_task` (or was stopped by the watchdog) is reported, its change
   kept in its worktree. The micromanager continues a worker with `subagent` and its `sessionID`; a merged writer then
   gets a new task in a fresh worktree at the same place, since the session keeps its directory.

`delegate_task` and `answer_task` are gone; `list_tasks`, `stop_job` (now also for the session's workers) and the
planned jobs (`plan_job` / `run_job` on the runner) stay. The runner's rolling-job code is no longer used by the
plugin; it is still tested and can go in a cleanup.

**Not carried over to native workers (yet):** N5's per-task profile (role change, narrowed rights, skills picked by
Jev), the plugin's fix rounds and model-family fallback, the review stage, the red-test stage for bug fixes,
`LEARNED` lines for the project memory, and the guard's "sensitive" flag that keeps a task on local models (moot while
`cloudOnly` is on). The micromanager covers some of it (a reviewer worker, continuing a worker),
the rest needs its own decision.

### A live run against a real project (2026-10-06), and what it changed (2026-10-07)
A full session on a Quarto deck project inside a monorepo, with the micromanager orchestrating ~21 tasks. The work
itself largely succeeded — ten reader tasks reported, five writers merged clean commits, the merge train behaved. The
*plumbing* did not, and the defects were all of one kind: **a layer that silently did not engage.**

| defect | how it showed | fix |
|---|---|---|
| worktree isolation skipped for every delegation | ten workers wrote into the user's checkout; no task, no worktree, no checks, no error; the job file held no writer task at all | recognition by delegation **target** instead of calling agent, plus a `parentID` backstop that denies writes to an unclaimed child of a micromanager session |
| checks ran in the wrong directory | two correct tasks failed their gates nine times because a relative path in `Checks:` resolved at the monorepo root | `rel` computed and persisted; worker and gate cwd resolve through it (§11 of design.md) |
| read-only shell misclassified as a write | 67 of 185 worker shell requests escalated to the user — `sed`, `git -C`, one non-read command poisoning a whole batch | classifier extended per segment; a read inside a worktree is allowed outright |
| `external_directory` was always the user | a worker blocked on its very first `ls -l` of the directory it was sent to read | layered policy (§12 of design.md) |
| `.git/info/exclude` never written | the user saw `?? .jev-micromanager/` | resolved via `git rev-parse --git-common-dir` |
| watchdog counted working commands as no progress | a writer stopped after eight calls of reading one source file, before writing anything | a command that ran and did not fail is progress; only a *failing* one counts (§10.1) |
| the gate ran model-written strings unvalidated | `curl … \| sh` was a valid acceptance point | every check goes through the hard rules before the task exists (§9) |
| a task with no checks, or an empty diff, merged | a worker that changed nothing reported success | at least one check; a passing gate over an empty diff is unverified, not merged |
| native gate had no retry cap | a structurally unsatisfiable check burned a whole session | `FIX_ROUNDS` on both paths |
| `stop_job` could not interrupt a check | all checks of a job ran regardless | `runGate` takes the cancel signal |
| stale task state | five tasks showed `running` forever; `attempts`, `workersUsed` and every counter stayed 0 | `reconcileJob` on load, without clobbering a live runner |

Two lessons worth keeping, both of them about **failing visibly**. A guard that returns early on an unexpected input
is indistinguishable from a guard that passed; every one of the rows above was silent. And a rule that cannot be
evaluated truthfully — "a check must be able to fail", asked of the check text — is worse than no rule, because it
forces a guess: it was written, rejected by the tests (`npm test` is a read), and removed with the reason recorded in
`src/plan.ts`. Ask the question where the answer is true instead, which here meant the real diff.

The one remaining from that list, since the run made it concrete: **native workers have no per-task profile** (N5), so
a writer's rights are the role's defaults rather than what the decision model would narrow them to. The permission
path compensates for most of it — the hard rules and the classifier now run for native workers too — but the
`skillsFor` and role-change parts of N5 are still only on the runner's path.

**Live** (private `opencode serve`, cloud only, glm-5.3-flash as micromanager, a small Node project; slugify and
readingTime with tests):
- The worker was moved into its worktree before its first step, wrote its files, called `finish_task` through
  `execute`, and the plugin merged it (checks passed). The merge note came before OpenCode's report, and OpenCode
  woke the micromanager, which went on by itself.
- Found: two `subagent` calls in one message made the session branch at the same time, and the second failed
  ("a branch named jev/… already exists"); the micromanager started that task after the first one's merge instead.
  Fixed: delegations of a session run one after another.
- Run 2 after the fix (excerpt and wordCount, "in parallel"): both workers started from one message, each in its
  own worktree. The second to finish was rebased onto the first and its checks ran again; both merged, `npm test` on
  the branch 10 of 10. The micromanager acknowledged each merge and ended with the summary and `git merge jev/<job>`.
  Fixed after it: the merge note named the commit from before the rebase.
- A new worktree's first model turn came about 30 s after the move: the server starts an instance (and the plugin)
  for each new directory.

**Live, 2026-10-27: trial picks, the user's pick and look** (private `opencode serve`, glm-5.3-flash as micromanager,
a one-page site with a slugify module graded by eight cases):
- A `best` trial of the slugify task: T5 passed first (8/8) and was held; T3 passed (8/8) inside the window; the tie
  went to a review by claude-haiku-5-5 (a third family), which preferred T3's single lookup table; T3 merged, T5 is
  `lost_on_quality`, the original attempt T2 was stopped when the window closed. Found: the window was half of T5's
  12 s, so 6 s, and the slower attempt never had a chance; fixed with a two-minute floor (184c551).
- A `user` trial of the hero (designers T1 on qwen, T4 on mimo): both called `look` and checked their page at several
  widths, both passed and were held with no deadline; when the second ended, the comparison page and the pick form
  came. Answered with Combine ("the layout and ring of T4, with the leaf mark of T1"): T4 was continued with T1's
  diff, looked again, and merged; the result has both.
- Found and fixed on the way: restoring placeholders wrote every field of a tool's input back, and the question
  tool's input is frozen, so every form failed (9de11a2); variables like CLAUDE_CODE_SESSION_ID, EDITOR and MANPAGER
  became known secrets and their values placeholders in paths (ce0f81d, bc88a9f); bare digit runs became card numbers
  (the card commit after it); a worker adopted after a restart and continued by its session had its request parked
  with nobody to answer (afd473d); a combination's rows now say `combined` and `chosenBy: user`.

## Verification
- **Per phase: tests** with a fake Jev:
  - the FSMs refuse illegal jumps;
  - the agenda order;
  - the rules fallback without Jev;
  - the N5 combination and the role-matrix upper bound;
  - the watchdog signatures on recorded event streams (including a read loop and a restart);
  - hard rules never overridden;
  - dataset rows validate against the Open-Jev schema.
- **Live per phase:** a test job in a throwaway repo ("write a README and a test"). Check:
  - a planning session that asks one question per turn and recommends nothing;
  - a split into small tasks;
  - a worker question answered by Jev and one passed to the user;
  - a review FAIL → fix → PASS;
  - a forced loop that the watchdog interrupts;
  - a sensitive task that never reaches the cloud;
  - a refusal_likely task routed to a local uncensored model, while a harmful one goes to the user;
  - a user override that skips a node and shows up as a label in the journal;
  - `/micromanager stop`;
  - no push, worktrees cleaned up.
