---
name: code-review
description: Review a change along two axes, Spec (does it do what the task asked?) and Standards (does it follow the repo's documented standards?). Use when a jev-dictator note starts with "[jev-dictator] review of task".
license: MIT
metadata:
  source: https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/code-review/SKILL.md
  adapted: for a jev-dictator reviewer, which reviews both axes itself; the plugin gives the diff and the spec, and wants JSON
---

# Code Review

You review one task's change. The plugin gives you the task, its acceptance points (the spec) and the diff, and it has
already run the checks. Do the review yourself; never start other agents. Answer in the JSON format the note asks for.

## Spec axis

- Acceptance points the change misses or only half meets.
- Behaviour the change adds that the task did not ask for (scope creep).
- Points that look met but where the implementation looks wrong.

Quote the acceptance point for each finding.

## Standards axis

Anything the repo documents about how code is written (`CODING_STANDARDS.md`, `CONTRIBUTING.md`, an AGENTS or
CLAUDE file). On top of that, this smell baseline (Fowler, _Refactoring_, ch. 3). The repo overrides it, and each
smell is a judgement call, never a hard violation; skip what tooling enforces:

- **Mysterious Name**: a name that does not reveal what it does or holds. → rename it.
- **Duplicated Code**: the same logic shape in more than one hunk or file. → extract the shared shape.
- **Feature Envy**: a function that reaches into another object's data more than its own. → move it there.
- **Data Clumps**: the same few fields or params travel together. → bundle them into one type.
- **Primitive Obsession**: a primitive standing in for a domain concept. → give the concept its own small type.
- **Repeated Switches**: the same switch or if-cascade on the same type recurs. → one map or polymorphism.
- **Shotgun Surgery**: one logical change forces scattered edits. → gather what changes together.
- **Divergent Change**: one module edited for unrelated reasons. → split it.
- **Speculative Generality**: abstraction or hooks for needs the task does not have. → delete it.
- **Message Chains**: long `a.b().c().d()` navigation. → hide the walk behind one method.
- **Middle Man**: something that mostly delegates onward. → call the real target.
- **Refused Bequest**: an implementer that ignores most of what it inherits. → composition instead.

## Evidence

A finding blocks the task only with evidence: a file and line, a command and its output, or a concrete input that
breaks it. A finding without evidence is advisory; mark the point as met and put the advice under "fixes". Keep the
two axes apart: a change can meet the spec and break the standards, or the other way round.
