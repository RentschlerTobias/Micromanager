# mm-evolver

micromanager's evolver (docs/design.md §26): [OpenEvolve](https://github.com/algorithmicsuperintelligence/openevolve)
run against a fitness contract (src/contract.ts). The plugin starts it with a spec; it is not meant to be run by hand,
except to try it out.

- **Models through OpenCode.** Every mutation is one `opencode run --agent summarizer --model …` against the server the
  spec names, so the evolver needs no API key of its own and OpenCode counts what it costs. Each call goes to
  `llm.jsonl` with its cost and tokens.
- **The contract measures.** A candidate is copied into a fresh copy of the project; the task's checks run first (one
  failing scores 0), then the contract's evaluator, whose `MM_SCORE` line must hold every score, say valid and keep every
  guard within its tolerance of the baseline. `combined_score` is the first score's improvement over the baseline as a
  ratio. Each evaluation goes to `evals.jsonl`.
- **Held-out cases** are measured once, for the best candidate, after the evolution: it never sees them.
- **Sandbox.** The spec's `runner` is the command prefix every candidate command runs under (the plugin's sandbox);
  empty only in tests.

```bash
uv sync                                   # OpenEvolve 0.4.0, pinned
uv run mm-evolve spec.json                # writes evals.jsonl, llm.jsonl, best.<ext> and result.json to spec.output
uv run pytest
```

A spec (see `mm_evolve/spec.py`):

```json
{
  "workdir": "/path/to/a/copy/of/the/project", "file": "search.js", "initial": "/path/to/search.js.with-markers",
  "checks": ["node test/search.test.js"], "evaluator": "node bench.js",
  "scores": [{ "name": "ms", "direction": "min" }], "guards": [{ "name": "correct", "direction": "max", "tolerance": 0 }],
  "baseline": { "ms": 200, "correct": 2 }, "output": "/path/to/out", "server": "http://127.0.0.1:4096",
  "iterations": 20, "held_out_dir": "/path/outside/the/project", "models": [{ "name": "opencode-go/glm-5.3-flash", "weight": 1 }]
}
```

The `EVOLVE-BLOCK-START` / `EVOLVE-BLOCK-END` comments in `initial` mark what may change.
