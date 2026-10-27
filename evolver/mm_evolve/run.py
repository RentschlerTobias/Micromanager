"""mm-evolve <spec.json>: one evolver run. Writes evals.jsonl and llm.jsonl as it goes and result.json at the end:
the best program, its metrics, its held-out measurement (taken once, for the best only, so the evolution never sees
the held-out cases), and what the run cost."""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from .evaluator import measure
from .spec import load


def config_for(spec):
    from openevolve.config import Config, LLMModelConfig

    from .llm import init_opencode_client

    cfg = Config()
    cfg.language = os.path.splitext(spec.file)[1].lstrip(".") or None
    models = [LLMModelConfig(name=m["name"], weight=float(m.get("weight", 1.0)), timeout=int(m.get("timeout", 300))) for m in spec.models]
    cfg.llm.models = models
    cfg.llm.evaluator_models = models
    cfg.llm.update_model_params({"init_client": init_opencode_client})
    cfg.diff_based_evolution = not spec.full_rewrite
    cfg.database.num_islands = 2
    cfg.evaluator.parallel_evaluations = 1  # one measurement at a time: parallel timings disturb each other
    cfg.evaluator.cascade_evaluation = False  # the checks are the cascade's first stage, inside measure()
    cfg.max_iterations = spec.iterations
    return cfg


def target_score(spec) -> float | None:
    """The contract's target on the deciding score, as a combined_score."""
    first = spec.scores[0]
    goal, base = spec.target.get(first.name), spec.baseline.get(first.name)
    if goal is None or base is None or goal == 0:
        return None
    return base / goal if first.direction == "min" else goal / base


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    if len(args) != 1:
        print("usage: mm-evolve <spec.json>", file=sys.stderr)
        return 2
    spec_path = str(Path(args[0]).resolve())
    spec = load(spec_path)
    out = Path(spec.output)
    out.mkdir(parents=True, exist_ok=True)
    os.environ["MM_EVOLVE_SPEC"] = spec_path
    os.environ["MM_EVOLVE_LLM_LOG"] = str(out / "llm.jsonl")
    os.environ.setdefault("MM_OPENCODE_SERVER", spec.server)
    os.environ.setdefault("MM_OPENCODE_DIR", spec.workdir)
    from openevolve import run_evolution

    started = time.time()
    res = run_evolution(spec.initial, str(Path(__file__).with_name("entry.py")), config_for(spec), iterations=spec.iterations, output_dir=str(out / "openevolve"), cleanup=False, target_score=target_score(spec))
    best = out / f"best{Path(spec.file).suffix}"
    best.write_text(res.best_code)
    held = measure(spec, str(best), "heldout", spec.held_out_dir) if spec.held_out_dir else None
    llm = [json.loads(l) for l in (out / "llm.jsonl").read_text().splitlines()] if (out / "llm.jsonl").exists() else []
    result = {
        "best": str(best),
        "metrics": res.metrics,
        "heldOut": held,
        "calls": len(llm),
        "failedCalls": sum(1 for c in llm if not c.get("ok")),
        "cost": round(sum(c.get("cost", 0) for c in llm), 6),
        "tokens": sum(c.get("tokens", 0) for c in llm),
        "seconds": round(time.time() - started),
    }
    (out / "result.json").write_text(json.dumps(result, indent=2))
    print(f"MM_EVOLVE {json.dumps(result)}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
