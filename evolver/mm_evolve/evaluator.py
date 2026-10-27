"""A fitness contract as OpenEvolve's evaluator.

Every candidate is measured in a fresh copy of the project: its checks first (the hard constraints; one failing scores
0), then the contract's evaluator, whose MM_SCORE line must hold every score, keep every guard within its tolerance of
the baseline and say valid. combined_score is the first score's improvement over the baseline as a ratio (2.0: twice
as good), so OpenEvolve's selection follows the contract's direction. Each evaluation is appended to evals.jsonl,
which the plugin reads for progress.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from .spec import Spec, load

LINE = "MM_SCORE "


def parse_score(stdout: str) -> dict | None:
    """The last MM_SCORE line as a dict; None when there is none or it is no JSON object."""
    for line in reversed(stdout.splitlines()):
        if line.strip().startswith(LINE):
            try:
                value = json.loads(line.strip()[len(LINE):])
            except json.JSONDecodeError:
                return None
            return value if isinstance(value, dict) else None
    return None


def worse(direction: str, base: float, now: float) -> float:
    """How much worse now is than base, relative to base (absolute when base is 0); negative is better."""
    d = now - base if direction == "min" else base - now
    return d if base == 0 else d / abs(base)


def combined(spec: Spec, values: dict[str, float], baseline: dict[str, float] | None = None) -> float:
    first = spec.scores[0]
    base, now = (baseline if baseline is not None else spec.baseline).get(first.name), values.get(first.name)
    if base is None or now is None:
        return 0.0
    if first.direction == "min":
        return base / now if now > 0 else base / 1e-9
    return now / base if base > 0 else now


def judge(spec: Spec, score: dict | None, code: int, timed_out: bool, baseline: dict[str, float] | None = None) -> dict:
    """An evaluator run as metrics: invalid (0) on a timeout, an exit code, no line, valid false, a missing score or a
    broken guard. baseline: what it is compared with (the quick stage has its own)."""
    base = baseline if baseline is not None else spec.baseline
    if timed_out:
        return {"combined_score": 0.0, "valid": 0.0, "error": "the evaluator timed out"}
    if code != 0:
        return {"combined_score": 0.0, "valid": 0.0, "error": f"the evaluator exited {code}"}
    if score is None:
        return {"combined_score": 0.0, "valid": 0.0, "error": "no MM_SCORE line"}
    values = {k: v for k, v in (score.get("scores") or {}).items() if isinstance(v, (int, float))}
    if score.get("valid") is False:
        return {"combined_score": 0.0, "valid": 0.0, "error": "the evaluator said invalid", **values}
    missing = [s.name for s in spec.scores if s.name not in values]
    if missing:
        return {"combined_score": 0.0, "valid": 0.0, "error": f"missing {', '.join(missing)}", **values}
    broken = [g.name for g in spec.guards if g.name in base and g.name in values and worse(g.direction, base[g.name], values[g.name]) > g.tolerance]
    if broken:
        return {"combined_score": 0.0, "valid": 0.0, "error": f"guard broken: {', '.join(broken)}", **values}
    return {"combined_score": combined(spec, values, base), "valid": 1.0, **values}


def _run(spec: Spec, command: str, cwd: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess | None:
    """A command in the candidate's directory, under the spec's runner (the sandbox); None on a timeout."""
    prefix = [p.replace("{dir}", cwd) for p in spec.runner]
    argv = [*prefix, "sh", "-c", command]
    try:
        return subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=spec.timeout_s, env={**os.environ, **(env or {})})
    except subprocess.TimeoutExpired:
        return None


def measure(spec: Spec, program_path: str, corpus: str = "visible", corpus_dir: str | None = None) -> dict:
    """One candidate: copied into a fresh copy of the project, checked, then measured."""
    d = tempfile.mkdtemp(prefix="mm-evolve-")
    try:
        shutil.copytree(spec.workdir, d, dirs_exist_ok=True, symlinks=True)
        shutil.copy(program_path, os.path.join(d, spec.file))
        for check in spec.checks:
            r = _run(spec, check, d)
            if r is None or r.returncode != 0:
                return {"combined_score": 0.0, "valid": 0.0, "error": f"check failed: {check}"}
        env = {"MM_CORPUS": corpus, **({"MM_CORPUS_DIR": corpus_dir} if corpus_dir else {})}
        # The cascade: a slow evaluator's quick stage first. A candidate no better than today's code there scores
        # below every one that went on (half its quick ratio), so the full minutes go to the promising ones only.
        if spec.quick_evaluator and corpus == "visible":
            q = _run(spec, spec.quick_evaluator, d, {**env, "MM_STAGE": "quick"})
            quick = judge(spec, parse_score(q.stdout) if q else None, q.returncode if q else -1, q is None, spec.quick_baseline)
            if quick["valid"] != 1.0 or quick["combined_score"] <= 1.0:
                return {**quick, "combined_score": quick["combined_score"] * 0.5, "stage": 1.0}
        r = _run(spec, spec.evaluator, d, env)
        if r is None:
            return judge(spec, None, -1, True)
        return judge(spec, parse_score(r.stdout), r.returncode, False)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def evaluate(program_path: str) -> dict:
    """OpenEvolve's entry point: the spec is named by MM_EVOLVE_SPEC, since the evaluator runs in worker processes."""
    spec = load(os.environ["MM_EVOLVE_SPEC"])
    started = time.time()
    metrics = measure(spec, program_path)
    row = {"at": time.time(), "seconds": round(time.time() - started, 2), **{k: v for k, v in metrics.items() if k != "error"}, **({"error": metrics["error"]} if "error" in metrics else {})}
    with open(Path(spec.output) / "evals.jsonl", "a") as f:
        f.write(json.dumps(row) + "\n")
    return {k: v for k, v in metrics.items() if isinstance(v, (int, float))}
