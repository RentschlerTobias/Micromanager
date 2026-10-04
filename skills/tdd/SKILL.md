---
name: tdd
description: Test-driven development. Use when a jev-dictator task is built test-first, the brief mentions frozen tests or a red stage, or you fix a bug and need a regression test.
license: MIT
metadata:
  source: https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/tdd/SKILL.md
  adapted: for a jev-dictator worker; the seams come from the brief, nobody is asked; tests.md and mocking.md unchanged
---

# Test-Driven Development

TDD is the red → green loop. This skill is the reference that makes that loop produce tests worth keeping: what a good
test is, where tests go, the anti-patterns, and the rules of the loop. Consult every section before and during the
loop, not after.

When exploring the codebase, read `GLOSSARY.md` (if it exists) so test names and interface vocabulary match the
project's domain language, and respect ADRs in the area you're touching.

## What a good test is

Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests
shouldn't. A good test reads like a specification: "user can checkout with valid cart" tells you exactly what
capability exists, and it survives refactors because it doesn't care about internal structure.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## Seams: where tests go

A **seam** is the public boundary you test at: the interface where you observe behavior without reaching inside.
Tests live at seams, never against internals.

**Test only at the seams the brief names.** The task's acceptance points and its description say what the public
interface is. Test there. If the brief names no seam and the interface is unclear, do not invent one: report
`STATUS: NEEDS_CONTEXT` and say which seam you would need decided.

## Anti-patterns

- **Implementation-coupled**: mocks internal collaborators, tests private methods, or verifies through a side
  channel (querying the database instead of using the interface). The tell: the test breaks when you refactor but
  behavior hasn't changed.
- **Tautological**: the assertion recomputes the expected value the way the code does (`expect(add(a, b)).toBe(a + b)`,
  a snapshot derived by hand the same way, a constant asserted equal to itself), so it passes by construction and
  can never disagree with the code. Expected values must come from an independent source of truth: a known-good
  literal, a worked example, the spec.
- **Imagined behavior**: tests for things the acceptance points do not ask for. Test what the task promises, nothing
  speculative.

## Rules of the loop

- **Red before green.** Write the failing test first, run it, and see it fail for the right reason: the missing
  behavior, not a typo or an import error. Then write only enough code to pass it.
- **Frozen tests stay frozen.** When the brief says tests are frozen, the plugin checks their content: make them
  pass by changing the code, never the tests. If a frozen test is wrong, report it (`STATUS: BLOCKED`) instead of
  editing it.
- **One slice at a time.** One seam, one test, one minimal implementation per cycle.
- **Refactoring is not part of the loop.** It belongs to the review stage, not the red → green cycle.
