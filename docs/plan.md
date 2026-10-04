# jev-dictator: an OpenCode orchestrator driven by Jev

Status (2026-10-04): Phase 0 (spike) and Phase 1 done, and Jev on permission requests works (part of the old
Phases 2 and 3). The design was reworked on 2026-10-03/04: [design.md](design.md) is now the design and
[design.html](design.html) its flow chart. Extended the same day by local vs cloud routing, censorship guards, decision backends (cloud Jev or
local GLiNER) and user overrides (design.md §19–§22). The next step is Phase A (spikes) below.

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
  dictator does not rely on the hub's permission rules for its own tools; it asks the user itself through
  OpenCode's `question` form when Jev says so (see "Questions and permissions").
- Sessions on a second server share `~/.local/share/opencode/opencode.db` (the spike's sessions were deleted
  afterwards).

## Design
The architecture, the job state, the planning session, Jev's decision nodes, the pipelines, the loop watchdog,
parallelism, the stack and the decision dataset are in [design.md](design.md). It replaces this file's earlier
sections "Architecture", "Jev's decisions", "Loops and parallelism", "Guardrails", "Memory and code knowledge"
and "Layout".

What is implemented (2026-10-04):
- **The role matrix** as OpenCode agents via `ctx.agent.transform` (`src/roles.ts`, `src/agents.ts`).
- **Model routing** on the dictator's `subagent` call (`src/routing.ts`, `src/hooks.ts`).
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

- **`dictator`** (primary) plans, classifies through the plugin and delegates. It has no edit or bash: only the
  dictator tools, read/grep/glob and graphify queries.
- An "ask" in this table is a question that goes through Jev first (section 2), not straight to the user.
- The reviewer answers in strict JSON `{verdict: PASS|FAIL, checks: [...], fixes: [...]}`.
- Prompts come in two variants per model family (lesson from OmO).

## Phases (each its own small commits, English)
0. **Spike**: done (results above).
1. Repo skeleton, role matrix, routing config, the dictator agent, install script: done. Jev client and
   permission decisions: done.

From here on, the phases follow design.md (§16 MVP cut, §17 spikes):
- **A. Spikes A1–A10.** A1 (chat-turn hook + steering) first; then A2, A3, A4, A7, A8 (local availability),
  A9 (GLiNER decision server), A10 (refusal detection), A6, A5. Each result picks the
  design or its named fallback.
- **B. Core:**
  - state, FSMs, agenda and rules fallback;
  - the integration branch;
  - the planner subagent writing plan JSON, with the DAG validated;
  - one task at a time on P1;
  - journal with state objects, eval harness, dataset export;
  - the model registry, decision backends per node (typesafe, gliner, rules), the policy / override layer;
  - the GLiNER decision server.
- **C. Planning session and gate:**
  - G0 local-first gate with the four guards (sensitive, refusal_likely, injection, harmful) and the guard
    bench;
  - the `deliberate` skill;
  - design tree validation, frontier, N2 / N2b / N2c, shortcuts, question caps, design checkpoint;
  - the facilitator on the session model;
  - the dictator read cap; the "answer yourself" line removed from the dictator prompt.
- **D. Classification and profile:**
  - N4 split until small;
  - N5+N5b in one request;
  - N6 with P1–P3 and P9;
  - profile narrowing in the evaluate hook;
  - skill vendoring + `install.sh --skills`;
  - brief and report;
  - caveman on outputs;
  - routing over the registry: locality, censorship, difficulty tier, live availability, per-device
    concurrency.
- **E. Quality loop:**
  - gates run by the plugin;
  - two-axis review;
  - improvement loop;
  - **the loop watchdog**;
  - N8 signatures;
  - the N9 ladder with handoff notes;
  - budgets including requests and tokens;
  - the `worker_refused` signature and the locality-aware ladder.
- **F. Parallelism:** parallel readers; then parallel writers in worktrees, the merge train into the integration
  branch, batch confirmation.
- **G. Flagged pipelines:** P0, P4–P8, Ralph; DCP. Each is switched on only with eval evidence.
- **H. Extras:** memory plugin, research extras (papers skill, context7, Serena, graphify).
- **J. Local decision model:** GLiNER shadow mode → retraining on Jev's answers, overrides and outcomes → a
  promotion gate per node, with demotion on rising overrides.
- **I. Visibility:** design.html / flow.html lanes from the journal, `/dictator status|log|stop`, otel, later
  wayfinder maps.

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
  - `/dictator stop`;
  - no push, worktrees cleaned up.
