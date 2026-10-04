"""The decision server without torch: a fake classifier stands in for GLiNER2."""

import json
import threading
import unittest
import urllib.request
from collections.abc import Mapping
from http.server import ThreadingHTTPServer

from decider.server import YES_NO, Abandoned, decide, make_handler, render_state


class FakeClassifier:
    """Scores the first label 0.8 unless a rule for the task says otherwise; records what it was asked."""

    def __init__(self, rules: Mapping[str, Mapping[str, float]] | None = None) -> None:
        self.rules = dict(rules or {})
        self.calls: list[tuple[str, str, dict[str, str], str]] = []

    def probabilities(self, text: str, task: str, labels: Mapping[str, str], instruction: str) -> dict[str, float]:
        self.calls.append((text, task, dict(labels), instruction))
        if task in self.rules:
            return dict(self.rules[task])
        names = list(labels)
        return {n: (0.8 if i == 0 else 0.2 / (len(names) - 1)) for i, n in enumerate(names)}


QUESTIONS = {
    "role": {"type": "choice", "instructions": "Which role (pick one) fits?", "criteria": {"code": "writes code", "explore": "reads [only]"}},
    "harmful": {"type": "noul", "instructions": "This task asks for help to hurt people."},
    "risk": {"type": "score", "instructions": "How risky?", "criteria": ["read only", "changes files", "irreversible"]},
}


class DecideTest(unittest.TestCase):
    def test_every_question_type_is_answered(self) -> None:
        fake = FakeClassifier({"harmful": {"yes": 1.0, "no": 3.0}, "risk": {"0": 0.2, "1": 0.6, "2": 0.2}})
        out = decide(fake, {"state": {"text": "Add a flag", "job": "j1"}, "questions": QUESTIONS}, "gliner")
        answers = out["answers"]
        self.assertEqual(answers["role"]["choice"], "code")
        self.assertAlmostEqual(answers["role"]["confidence"], 0.8)
        self.assertAlmostEqual(answers["harmful"]["noul"], 0.25)
        self.assertAlmostEqual(answers["risk"]["score"], 1.0)
        self.assertAlmostEqual(answers["risk"]["confidence"], 0.6)
        self.assertEqual(out["model"], "gliner")

    def test_markers_are_stripped_and_noul_uses_yes_no(self) -> None:
        fake = FakeClassifier()
        decide(fake, {"state": "plain text", "questions": QUESTIONS}, "gliner")
        role, harmful, _ = fake.calls
        self.assertEqual(role[2]["explore"], "reads only")
        self.assertEqual(role[3], "Which role , pick one fits?")
        self.assertEqual(harmful[2], YES_NO)
        self.assertEqual(role[0], "plain text")

    def test_unknown_or_empty_questions_are_left_unanswered(self) -> None:
        out = decide(FakeClassifier(), {"state": "x", "questions": {"a": {"type": "vote"}, "b": {"type": "choice", "criteria": {}}}}, "g")
        self.assertEqual(out["answers"], {})

    def test_a_gone_client_stops_the_work(self) -> None:
        fake = FakeClassifier()
        with self.assertRaises(Abandoned):
            decide(fake, {"state": "x", "questions": QUESTIONS}, "gliner", alive=lambda: False)
        self.assertEqual(fake.calls, [])

    def test_state_text_puts_the_task_first(self) -> None:
        self.assertEqual(render_state({"other": 1, "text": "hello"}), "text: hello\nother: 1")
        self.assertEqual(render_state('{"task": "t", "a": [1, 2]}'), "task: t\na: [1,2]")


class HttpTest(unittest.TestCase):
    def test_the_wire_format_over_http(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(FakeClassifier(), "gliner"))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            with urllib.request.urlopen(f"{base}/health") as r:
                self.assertEqual(json.load(r)["status"], "ok")
            req = urllib.request.Request(
                f"{base}/v1/systemone",
                data=json.dumps({"model": "gliner", "state": "{}", "questions": QUESTIONS}).encode(),
                headers={"Content-Type": "application/json", "Authorization": "Bearer local"},
            )
            with urllib.request.urlopen(req) as r:
                body = json.load(r)
            self.assertEqual(set(body["answers"]), {"role", "harmful", "risk"})
            bad = urllib.request.Request(f"{base}/v1/systemone", data=b"[1]", headers={"Content-Type": "application/json"})
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(bad)
            self.assertEqual(ctx.exception.code, 400)
        finally:
            server.shutdown()


if __name__ == "__main__":
    unittest.main()
