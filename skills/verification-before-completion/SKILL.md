---
name: verification-before-completion
description: Use when about to report a micromanager task as done, fixed or passing - requires running the verification commands and reading their output before any success claim; evidence before assertions always.
license: MIT
metadata:
  source: https://github.com/obra/superpowers/blob/8ca22dba9a94f28898bbce59f2537ff4d87c747d/skills/verification-before-completion/SKILL.md
  adapted: for a micromanager worker; the evidence goes into the report's EVIDENCE line
---

# Verification Before Completion

**Core principle:** evidence before claims, always. The plugin runs the task's checks after you anyway; a report that
claims more than you ran costs a fix round.

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you haven't run the verification command in this answer, you cannot claim it passes.

## The gate

Before `STATUS: DONE` or any claim of success:
1. **Identify** the command that proves the claim (the acceptance point's "checked with" command, if it has one).
2. **Run** the full command, fresh.
3. **Read** the full output: exit code, number of failures.
4. **Verify**: does the output confirm the claim? If not, report the actual state with the evidence.
5. Only then claim it, and put the command and its result in `EVIDENCE`.

## What a claim needs

| Claim | Requires | Not sufficient |
|-------|----------|----------------|
| Tests pass | test output: 0 failures | an earlier run, "should pass" |
| Linter clean | linter output: 0 errors | a partial check |
| Build succeeds | build command: exit 0 | linter passing |
| Bug fixed | the original symptom tested: passes | code changed, assumed fixed |
| Regression test works | red-green cycle seen | it passes once |
| Acceptance met | each point checked, one by one | tests passing |

## Red flags: stop

- "should", "probably", "seems to";
- satisfaction before verification ("Done!", "Perfect!");
- a partial check taken for the whole;
- any wording that implies success without a command you ran in this answer.

If you cannot run the command (no shell in this task), say so in `EVIDENCE` and use `DONE_WITH_CONCERNS`.
