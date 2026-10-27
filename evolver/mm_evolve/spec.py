"""The run's spec, as the plugin writes it (src/evolver.ts): what evolves, what measures it, which models think."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Score:
    name: str
    direction: str  # "min" or "max"


@dataclass(frozen=True)
class Guard:
    name: str
    direction: str
    tolerance: float


@dataclass(frozen=True)
class Spec:
    workdir: str  # a copy of the project directory at the job's branch; candidates are measured in copies of it
    file: str  # the evolving file, relative to workdir
    initial: str  # that file with EVOLVE-BLOCK markers around what may change
    checks: list[str]  # the task's checks: hard constraints, a failing one scores 0
    evaluator: str  # the contract's evaluator command, printing one MM_SCORE line
    scores: list[Score]  # the first decides
    guards: list[Guard]
    baseline: dict[str, float]  # the contract's baseline on the visible corpus
    output: str  # where the run writes evals.jsonl, llm.jsonl and result.json
    models: list[dict] = field(default_factory=lambda: [{"name": "opencode-go/glm-5.3-flash", "weight": 1.0}])
    server: str = "http://127.0.0.1:4096"  # the OpenCode server the models are reached through
    iterations: int = 20
    timeout_s: float = 300.0  # per evaluator run
    target: dict[str, float] = field(default_factory=dict)  # the contract's stop.target
    full_rewrite: bool = False  # whole-program answers instead of diffs (cheap models often miss the diff format)
    held_out_dir: str | None = None  # measured once, for the best candidate only
    # The command prefix every candidate command runs under: the plugin's sandbox. "{dir}" is the candidate's
    # directory. Empty: unsandboxed, for tests only.
    runner: list[str] = field(default_factory=list)


def load(path: str | Path) -> Spec:
    raw = json.loads(Path(path).read_text())
    return Spec(
        **{
            **raw,
            "scores": [Score(**s) for s in raw["scores"]],
            "guards": [Guard(**g) for g in raw.get("guards", [])],
        }
    )
