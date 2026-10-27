"""A local decision server: GLiNER2 behind the TypeSafe Jev wire format, on the CPU (design.md §20).

POST /v1/systemone {model, state, questions} -> {model, answers, latency_ms}
POST /v1/entities {texts, labels, threshold} -> {entities: [[{label, text, start, end, score}], …], latency_ms}
GET  /health -> {status: "ok", model}

Each question is its own forward pass, so a question's scores never depend on which others ride along:
- choice -> a single-label task over the criteria (option id -> meaning);
- noul   -> a yes/no task; the answer is P(yes) normalised over yes and no;
- score  -> a single-label task over the rubric levels "0", "1", …; the score is the probability-weighted level.

The entity endpoint finds the spans of each label in each text (names and addresses for src/redact.ts); long texts
are read in overlapping chunks.

The classifier is injected, so tests run without torch; the real one loads GLiNER2 lazily on the first request.
"""

from __future__ import annotations

import argparse
import json
import select
import socket
import threading
import time
from collections.abc import Callable, Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Protocol

YES_NO = {"yes": "Yes, the statement is true for this text.", "no": "No, the statement is false for this text."}
FIRST = ("text", "utterance", "task", "question")


class Classifier(Protocol):
    def probabilities(self, text: str, task: str, labels: Mapping[str, str], instruction: str) -> dict[str, float]: ...


class EntityFinder(Protocol):
    def entities(self, text: str, labels: list[str], threshold: float) -> list[dict[str, Any]]: ...


def render_state(state: Any) -> str:
    """The text GLiNER reads: task text first, so a short window keeps it. src/dataset.ts renderState matches."""
    if isinstance(state, str):
        try:
            state = json.loads(state)
        except ValueError:
            return state
    if not isinstance(state, dict):
        return str(state)
    order = sorted(state.items(), key=lambda kv: FIRST.index(kv[0]) if kv[0] in FIRST else len(FIRST))
    return "\n".join(f"{k}: {v if isinstance(v, str) else json.dumps(v, separators=(',', ':'))}" for k, v in order)


def safe(value: str) -> str:
    """GLiNER2 rejects its own marker characters in labels and instructions."""
    return value.replace("(", ", ").replace(")", "").replace("[", "").replace("]", "")


def normalise(probs: Mapping[str, float]) -> dict[str, float]:
    total = sum(probs.values()) or 1.0
    return {k: v / total for k, v in probs.items()}


def answer(classifier: Classifier, text: str, qid: str, question: Mapping[str, Any]) -> dict[str, Any] | None:
    kind = question.get("type")
    instruction = safe(str(question.get("instructions", "")))
    if kind == "choice":
        criteria = {str(k): safe(str(v)) for k, v in dict(question.get("criteria", {})).items()}
        if not criteria:
            return None
        probs = normalise(classifier.probabilities(text, qid, criteria, instruction))
        choice = max(probs, key=lambda k: probs[k])
        return {"choice": choice, "confidence": probs[choice], "probabilities": probs}
    if kind == "noul":
        probs = normalise(classifier.probabilities(text, qid, YES_NO, instruction))
        return {"noul": probs.get("yes", 0.0)}
    if kind == "score":
        levels = [safe(str(c)) for c in question.get("criteria", [])]
        if len(levels) < 2:
            return None
        probs = normalise(classifier.probabilities(text, qid, {str(i): c for i, c in enumerate(levels)}, instruction))
        score = sum(int(k) * p for k, p in probs.items())
        return {"score": score, "confidence": max(probs.values()), "probabilities": probs}
    return None


class Abandoned(Exception):
    """The client went away; the rest of its questions are not worth the CPU."""


def client_gone(sock: socket.socket) -> bool:
    """True when the peer closed the connection (readable, and a peek returns nothing)."""
    try:
        readable, _, _ = select.select([sock], [], [], 0)
        return bool(readable) and sock.recv(1, socket.MSG_PEEK) == b""
    except OSError:
        return True


def decide(classifier: Classifier, body: Mapping[str, Any], model: str, alive: Callable[[], bool] = lambda: True) -> dict[str, Any]:
    t0 = time.perf_counter()
    text = render_state(body.get("state", ""))
    questions = body.get("questions") or {}
    answers: dict[str, Any] = {}
    for qid, question in dict(questions).items():
        if not alive():
            raise Abandoned
        if isinstance(question, Mapping):
            result = answer(classifier, text, str(qid), question)
            if result is not None:
                answers[str(qid)] = result
    return {"model": model, "answers": answers, "latency_ms": (time.perf_counter() - t0) * 1000}


def extract(finder: Any, body: Mapping[str, Any], alive: Callable[[], bool] = lambda: True) -> dict[str, Any]:
    """The spans of each label in each text. Labels go to GLiNER2 without its marker characters and come back as asked."""
    t0 = time.perf_counter()
    texts = body.get("texts")
    labels = body.get("labels")
    threshold = body.get("threshold", 0.5)
    if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
        raise ValueError("texts must be a list of strings")
    if not isinstance(labels, list) or not labels or not all(isinstance(lbl, str) and lbl.strip() for lbl in labels):
        raise ValueError("labels must be a non-empty list of strings")
    if not isinstance(threshold, (int, float)) or not 0 < threshold < 1:
        raise ValueError("threshold must be a number between 0 and 1")
    asked = {safe(lbl): lbl for lbl in labels}
    out: list[list[dict[str, Any]]] = []
    for text in texts:
        if not alive():
            raise Abandoned
        spans = finder.entities(text, list(asked), float(threshold)) if text.strip() else []
        out.append([
            {"label": asked.get(str(s.get("label")), str(s.get("label"))), "text": s.get("text"), "start": s.get("start"), "end": s.get("end"), "score": s.get("score")}
            for s in spans
        ])
    return {"entities": out, "latency_ms": (time.perf_counter() - t0) * 1000}


class GlinerClassifier:
    """GLiNER2 on the CPU, loaded on first use; one forward pass at a time."""

    def __init__(self, model: str, threads: int | None = None, entity_model: str | None = None) -> None:
        self.model_id = model
        # The decision model is trained to classify and finds few names; an extraction checkpoint can serve the entity
        # endpoint instead, loaded on its first request.
        self.entity_model_id = entity_model or model
        self._threads = threads
        self._clf: Any = None
        self._extractor: Any = None
        self._entity_extractor: Any = None
        self._lock = threading.Lock()

    def preload(self) -> None:
        """Loads the model now, so the first request does not pay for it (2-3 s on the CPU)."""
        with self._lock:
            self._load()

    def _load(self) -> Any:
        if self._clf is None:
            import torch
            from gliner2 import AutoExtractor
            from gliner2.classification import Classifier as GClassifier

            if self._threads:
                torch.set_num_threads(self._threads)
            extractor = AutoExtractor.from_pretrained(self.model_id)
            extractor.to("cpu")
            self._extractor = extractor
            self._clf = GClassifier(extractor, device="cpu")
        return self._clf

    def probabilities(self, text: str, task: str, labels: Mapping[str, str], instruction: str) -> dict[str, float]:
        from gliner2.classification import ClassificationSchema

        with self._lock:
            clf = self._load()
            schema = ClassificationSchema.from_dict(
                {"tasks": {task: {"labels": dict(labels), "min_labels": 1, "max_labels": 1, "instruction": instruction}}}
            )
            return dict(clf.classify(text, schema).probabilities(task))


    def _load_entities(self) -> Any:
        if self._entity_extractor is None:
            if self.entity_model_id == self.model_id:
                self._load()
                self._entity_extractor = self._extractor
            else:
                from gliner2 import AutoExtractor

                extractor = AutoExtractor.from_pretrained(self.entity_model_id)
                extractor.to("cpu")
                self._entity_extractor = extractor
        return self._entity_extractor

    def entities(self, text: str, labels: list[str], threshold: float) -> list[dict[str, Any]]:
        with self._lock:
            result = self._load_entities().extract_entities_long(text, labels, threshold=threshold, include_confidence=True, include_spans=True)
        found = result.get("entities", {}) if isinstance(result, dict) else {}
        return [
            {"label": label, "text": span.get("text"), "start": span.get("start"), "end": span.get("end"), "score": span.get("confidence")}
            for label, spans in found.items()
            for span in spans or []
            if isinstance(span, dict)
        ]


def make_handler(classifier: Classifier, model: str) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, payload: Mapping[str, Any]) -> None:
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:  # noqa: N802 (http.server naming)
            if self.path == "/health":
                self._send(200, {"status": "ok", "model": model})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            path = self.path.rstrip("/")
            if path not in ("/v1/systemone", "/systemone", "/v1/entities"):
                self._send(404, {"error": "not found"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length) or b"{}")
                if not isinstance(body, dict):
                    raise ValueError("body is not an object")
            except ValueError as exc:
                self._send(400, {"error": f"bad request: {exc}"})
                return
            alive = lambda: not client_gone(self.connection)  # noqa: E731
            if path == "/v1/entities":
                if not hasattr(classifier, "entities"):
                    self._send(501, {"error": "this server finds no entities"})
                    return
                try:
                    self._send(200, extract(classifier, body, alive=alive))
                except ValueError as exc:
                    self._send(400, {"error": f"bad request: {exc}"})
                except (Abandoned, BrokenPipeError):
                    return
                except Exception as exc:  # a model error must not kill the server
                    self._send(500, {"error": f"{type(exc).__name__}: {exc}"})
                return
            try:
                self._send(200, decide(classifier, body, model, alive=alive))
            except (Abandoned, BrokenPipeError):
                return  # the client timed out and left; nobody reads the answer
            except Exception as exc:  # a model error must not kill the server
                self._send(500, {"error": f"{type(exc).__name__}: {exc}"})

        def log_message(self, format: str, *args: Any) -> None:  # quiet; systemd keeps errors
            return

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8781)
    parser.add_argument("--model", default="fastino/GLiNER2.5-multi-Decide", help="a model id or a fine-tuned checkpoint directory")
    parser.add_argument("--entity-model", default=None, help="the checkpoint for /v1/entities (names and addresses); default: --model")
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--no-preload", action="store_true", help="load the model on the first request instead of at start")
    args = parser.parse_args()
    classifier = GlinerClassifier(args.model, args.threads, args.entity_model)
    if not args.no_preload:
        classifier.preload()
    server = ThreadingHTTPServer((args.host, args.port), make_handler(classifier, "gliner"))
    print(f"jev-decider on http://{args.host}:{args.port} ({args.model}, CPU)", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
