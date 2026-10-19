---
name: receiving-code-review
description: Use when a micromanager fix round brings review findings, before changing anything - requires checking each finding against the code, not blind implementation or performative agreement.
license: MIT
metadata:
  source: https://github.com/obra/superpowers/blob/8ca22dba9a94f28898bbce59f2537ff4d87c747d/skills/receiving-code-review/SKILL.md
  adapted: for a micromanager worker; findings come from a reviewer of another model family through the plugin
---

# Receiving Code Review

Review findings ask for technical evaluation, not agreement. Verify before implementing.

## For each finding

1. **Read** all findings first; they may be related.
2. **Restate** what each one asks for, in your own words.
3. **Verify** it against the code: is it true here? Run the input or command it names.
4. **Decide**: correct for this codebase, or wrong? The reviewer saw only the diff and the task.
5. **Fix** the correct ones one at a time, blocking issues first, then simple fixes, then complex ones; run the
   checks after each.

## When a finding is wrong

Do not implement it. Say why in your report under `OPEN`, with evidence: the command, the line, the reason
(it breaks existing behaviour, the reviewer lacks context, the feature is unused, it contradicts a decision in the
brief). If you cannot tell whether a finding is right, say what you would need to check it.

## When it is unclear

If a finding is unclear, fix nothing that depends on it and report `STATUS: NEEDS_CONTEXT` naming the unclear
items. Partial understanding means a wrong fix.

## No performance

No "You're absolutely right!", no thanks, no praise. State what you changed and where, or why you did not.
