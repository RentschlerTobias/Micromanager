"""An OpenEvolve LLM backend that generates through OpenCode (`opencode run`).

The evolver needs no API key of its own: OpenCode's provider auth applies, and so does its cost accounting. The
plugin's summarizer agent has no tools, so a mutation is plain text. Each call's cost goes to llm.jsonl next to the
run's other files, which is how the plugin charges the job's budget (spike, 2026-10-26).
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import time
from pathlib import Path

from openevolve.llm.base import LLMInterface

OPENCODE = os.environ.get("MM_OPENCODE_BIN", os.path.expanduser("~/.opencode/bin/opencode"))
AGENT = "summarizer"


def read_events(stdout: str) -> tuple[str, float, int]:
    """The text, the cost and the tokens of one `opencode run --format json` answer."""
    text, cost, tokens = [], 0.0, 0
    for line in stdout.splitlines():
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        part = e.get("part") or {}
        if e.get("type") == "text":
            text.append(part.get("text", ""))
        elif e.get("type") == "step_finish":
            cost += part.get("cost") or 0
            t = part.get("tokens") or {}
            tokens += (t.get("input") or 0) + (t.get("output") or 0) + (t.get("reasoning") or 0)
    return "".join(text), cost, tokens


class OpenCodeLLM(LLMInterface):
    def __init__(self, model_cfg=None):
        self.model = getattr(model_cfg, "name", None) or "opencode-go/glm-5.3-flash"
        self.timeout = getattr(model_cfg, "timeout", None) or 300
        self.system_message = getattr(model_cfg, "system_message", None)
        self.server = os.environ.get("MM_OPENCODE_SERVER", "http://127.0.0.1:4096")
        self.workdir = os.environ.get("MM_OPENCODE_DIR", os.getcwd())
        self.log = os.environ.get("MM_EVOLVE_LLM_LOG")

    async def generate(self, prompt: str, **kwargs) -> str:
        system = kwargs.pop("system_message", self.system_message) or ""
        return await self.generate_with_context(system, [{"role": "user", "content": prompt}], **kwargs)

    async def generate_with_context(self, system_message: str, messages: list[dict], **kwargs) -> str:
        user = "\n\n".join(m.get("content", "") for m in messages if m.get("role") == "user")
        prompt = f"{system_message}\n\n{user}" if system_message else user
        return await asyncio.get_running_loop().run_in_executor(None, self._call, prompt)

    def _call(self, prompt: str) -> str:
        cmd = [OPENCODE, "run", "--server", self.server, "--agent", AGENT, "--model", self.model, "--format", "json", "--title", "[evolve] mutation", prompt]
        started = time.time()
        # OpenCode places the session by the client's PWD, not its working directory (live run, 2026-10-26), and reads
        # stdin when it is no terminal: in OpenEvolve's worker processes it waited for an end of input that never came.
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=self.timeout, cwd=self.workdir, env={**os.environ, "PWD": self.workdir}, stdin=subprocess.DEVNULL)
        text, cost, tokens = read_events(r.stdout)
        if self.log:
            with open(Path(self.log), "a") as f:
                f.write(json.dumps({"at": time.time(), "model": self.model, "seconds": round(time.time() - started, 1), "cost": cost, "tokens": tokens, "ok": bool(text)}) + "\n")
        if not text:
            raise RuntimeError(f"no answer from opencode ({self.model}): {r.stderr[-300:]}")
        return text


def init_opencode_client(model_cfg):
    """OpenEvolve's init_client hook."""
    return OpenCodeLLM(model_cfg)
