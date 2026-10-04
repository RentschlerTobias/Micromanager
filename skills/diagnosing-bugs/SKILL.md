---
name: diagnosing-bugs
description: Diagnosis loop for hard bugs and performance regressions. Use when a jev-dictator task is a bug with an unknown cause, or something is broken, throwing, failing or slow.
license: MIT
metadata:
  source: https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/diagnosing-bugs/SKILL.md
  adapted: for a jev-dictator worker; what it would ask the user goes into the report; no human-in-the-loop script
---

# Diagnosing Bugs

A discipline for hard bugs. Skip phases only when explicitly justified. You work alone in one task: where the
original would ask the user, you stop and report `STATUS: NEEDS_CONTEXT` with exactly what you need.

When exploring the codebase, read `GLOSSARY.md` (if it exists) and check ADRs in the area you're touching.

## Redact

Redact every secret in commands, outputs and captured artifacts you show: write `<REDACTED>` in its place. Build
loops against env vars, so the credential stays in the environment. Quote only the lines that carry the signal.

## Phase 1: Build a feedback loop

**This is the skill.** If you have a **tight** pass/fail signal for the bug (one that goes red on _this_ bug), you
will find the cause. Without one, no amount of staring at code will save you. Spend most of your effort here.

Ways to construct one, in roughly this order:
1. **Failing test** at whatever seam reaches the bug: unit, integration, e2e.
2. **HTTP script** against a running dev server.
3. **CLI invocation** with a fixture input, diffing stdout against a known-good snapshot.
4. **Headless browser script** that drives the UI and asserts on DOM, console or network.
5. **Replay a captured trace** through the code path in isolation.
6. **Throwaway harness**: a minimal subset of the system that exercises the bug path with one call.
7. **Property / fuzz loop** for "sometimes wrong output".
8. **Bisection harness** (`git bisect run`) when the bug appeared between two known states.
9. **Differential loop**: the same input through old vs new version, diff the outputs.

Then tighten it: faster (narrow the scope), sharper (assert the specific symptom), more deterministic (pin time,
seed randomness, isolate the filesystem). For flaky bugs, raise the reproduction rate until it is debuggable.

**If you cannot build a loop**, stop and report `STATUS: NEEDS_CONTEXT`: list what you tried and what you need
(an environment that reproduces it, a redacted artifact, or permission for temporary instrumentation). Do not
hypothesise without a loop.

**Done** when you can name **one command** you have **already run**, that drives the real bug path and asserts the
reported symptom (red-capable), gives the same verdict every run, takes seconds, and runs unattended.

## Phase 2: Reproduce and minimise

Run the loop and watch it go red with the failure the task describes, not a nearby one. Then cut inputs, callers,
config and steps one at a time, re-running after each cut, until every remaining element is load-bearing.

## Phase 3: Hypothesise

Write **3–5 ranked, falsifiable hypotheses** before testing any: "If X is the cause, then changing Y makes the bug
disappear." A hypothesis without a prediction is discarded. Put the ranked list in your report.

## Phase 4: Instrument

Each probe maps to one prediction; change one variable at a time. Prefer a debugger or REPL, then targeted logs at
the boundaries that tell hypotheses apart. Tag every debug log with a unique prefix such as `[DEBUG-a4f2]`. For
performance, measure a baseline first and bisect; logs are usually the wrong tool.

## Phase 5: Fix and regression test

Write the regression test before the fix, at a seam that exercises the real bug pattern. Watch it fail, fix, watch it
pass, then re-run the Phase 1 loop on the original scenario. If no correct seam exists, say so in the report: that is
a finding.

## Phase 6: Cleanup

- The original repro no longer reproduces.
- The regression test passes, or the missing seam is reported.
- Every `[DEBUG-...]` line is removed (grep the prefix); throwaway harnesses are deleted.
- The report states the hypothesis that turned out right.
