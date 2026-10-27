import json
from dataclasses import replace
from pathlib import Path

from mm_evolve.evaluator import combined, judge, measure, parse_score
from mm_evolve.llm import read_events
from mm_evolve.run import target_score
from mm_evolve.spec import Guard, Score, Spec, load


def spec(tmp: Path, **extra) -> Spec:
    base = dict(
        workdir=str(tmp / "work"), file="value.txt", initial=str(tmp / "initial.txt"), checks=["test -s value.txt"],
        evaluator='echo "MM_SCORE {\\"scores\\":{\\"ms\\":$(cat value.txt),\\"hits\\":$(cat hits.txt)}}"',
        scores=[Score("ms", "min")], guards=[Guard("hits", "max", 0.0)], baseline={"ms": 100.0, "hits": 10.0}, output=str(tmp / "out"),
    )
    return Spec(**{**base, **extra})


def project(tmp: Path) -> None:
    (tmp / "work").mkdir()
    (tmp / "work" / "value.txt").write_text("100\n")
    (tmp / "work" / "hits.txt").write_text("10\n")


def test_the_last_score_line_counts_and_junk_is_none():
    assert parse_score('x\nMM_SCORE {"scores":{"ms":5}}\nMM_SCORE {"scores":{"ms":4}}\n') == {"scores": {"ms": 4}}
    assert parse_score("MM_SCORE {oops") is None
    assert parse_score('{"scores":{"ms":1}}') is None


def test_the_hard_constraints_and_the_guards_score_zero(tmp_path):
    s = spec(tmp_path)
    assert judge(s, {"scores": {"ms": 50, "hits": 10}}, 0, False) == {"combined_score": 2.0, "valid": 1.0, "ms": 50, "hits": 10}
    assert judge(s, None, 0, True)["error"] == "the evaluator timed out"
    assert judge(s, {"scores": {"ms": 1}}, 1, False)["error"] == "the evaluator exited 1"
    assert judge(s, None, 0, False)["error"] == "no MM_SCORE line"
    assert judge(s, {"valid": False, "scores": {"ms": 1}}, 0, False)["combined_score"] == 0.0
    assert judge(s, {"scores": {"hits": 10}}, 0, False)["error"] == "missing ms"
    assert judge(s, {"scores": {"ms": 10, "hits": 9}}, 0, False)["error"] == "guard broken: hits"


def test_the_score_follows_the_contract_direction():
    up = spec(Path("/x"), scores=[Score("rate", "max")], baseline={"rate": 4.0})
    assert combined(up, {"rate": 6.0}) == 1.5
    assert combined(spec(Path("/x")), {"ms": 25.0}) == 4.0
    assert combined(spec(Path("/x")), {}) == 0.0
    assert target_score(spec(Path("/x"), target={"ms": 50.0})) == 2.0
    assert target_score(replace(up, target={"rate": 8.0})) == 2.0
    assert target_score(spec(Path("/x"))) is None


def test_a_candidate_is_checked_and_measured_in_a_copy_of_the_project(tmp_path):
    project(tmp_path)
    s = spec(tmp_path)
    good = tmp_path / "good.txt"
    good.write_text("40\n")
    assert measure(s, str(good)) == {"combined_score": 2.5, "valid": 1.0, "ms": 40, "hits": 10}
    empty = tmp_path / "empty.txt"
    empty.write_text("")
    assert measure(s, str(empty))["error"] == "check failed: test -s value.txt"
    assert (tmp_path / "work" / "value.txt").read_text() == "100\n", "the project copy is untouched"
    # The runner prefix (the plugin's sandbox) wraps every command, with the candidate's directory filled in.
    wrapped = spec(tmp_path, runner=["env", "MM_DIR={dir}"])
    assert measure(wrapped, str(good))["valid"] == 1.0


def test_the_held_out_corpus_reaches_the_evaluator_only_when_asked(tmp_path):
    project(tmp_path)
    s = spec(tmp_path, evaluator='echo "MM_SCORE {\\"scores\\":{\\"ms\\":$(ls $MM_CORPUS_DIR | wc -l),\\"hits\\":10},\\"corpus\\":\\"$MM_CORPUS\\"}"', checks=[])
    held = tmp_path / "held"
    held.mkdir()
    for n in "ab":
        (held / n).write_text(n)
    got = measure(s, str(tmp_path / "work" / "value.txt"), "heldout", str(held))
    assert got["ms"] == 2 and got["valid"] == 1.0


def test_an_opencode_answer_is_read_with_its_cost():
    lines = [
        {"type": "step_start", "part": {}},
        {"type": "text", "part": {"text": "<<<<<<< SEARCH\n"}},
        {"type": "text", "part": {"text": "x\n>>>>>>> REPLACE"}},
        {"type": "step_finish", "part": {"cost": 0.0012, "tokens": {"input": 100, "output": 20, "reasoning": 5}}},
    ]
    assert read_events("\n".join(json.dumps(l) for l in lines) + "\nnot json") == ("<<<<<<< SEARCH\nx\n>>>>>>> REPLACE", 0.0012, 125)


def test_a_spec_file_is_read_back(tmp_path):
    path = tmp_path / "spec.json"
    path.write_text(json.dumps({"workdir": "/w", "file": "a.js", "initial": "/i.js", "checks": [], "evaluator": "node b.js", "scores": [{"name": "ms", "direction": "min"}], "guards": [{"name": "hits", "direction": "max", "tolerance": 0.05}], "baseline": {"ms": 9}, "output": "/o", "iterations": 3}))
    s = load(path)
    assert s.scores == [Score("ms", "min")] and s.guards == [Guard("hits", "max", 0.05)] and s.iterations == 3 and s.runner == []


def test_the_bridge_replaces_the_opencode_backend(tmp_path):
    from mm_evolve.run import config_for

    via_cli = config_for(spec(tmp_path))
    assert via_cli.llm.models[0].init_client is not None
    via_bridge = config_for(spec(tmp_path, api_base="http://127.0.0.1:5555/v1", api_key="t0k"))
    m = via_bridge.llm.models[0]
    assert (m.api_base, m.api_key, getattr(m, "init_client", None)) == ("http://127.0.0.1:5555/v1", "t0k", None)
    assert via_bridge.diff_based_evolution is True and config_for(spec(tmp_path, full_rewrite=True)).diff_based_evolution is False
