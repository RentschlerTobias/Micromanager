# jev-decider

A local decision server for micromanager: GLiNER2 on the CPU behind the TypeSafe Jev wire format
(`POST /v1/systemone {model, state, questions}`), so the plugin talks to it with the same client as to the cloud
Jev. It answers choice, noul and score questions; see `decider/server.py` for the mapping. The 4060 stays free
for llama-swap and the NPU for Whisper.

```bash
uv run jev-decider --port 8781 --model fastino/GLiNER2.5-multi-Decide   # or a fine-tuned checkpoint directory
curl -s localhost:8781/health
python3 -m unittest discover -s tests -t .                               # tests need no torch
```

`POST /v1/entities {texts, labels, threshold}` returns the spans of each label in each text, for the names and
addresses `src/redact.ts` swaps for placeholders. The decision checkpoint is trained to classify and finds few of them
(2026-10-27: no name in a German invoice line at 0.5); `--entity-model <checkpoint>` serves the endpoint from an
extraction checkpoint instead, loaded on its first request.

The zero-shot model is only a starting point: in Phase A it scored about 0.5 on every guard. Guards need a
fine-tune on our own labels (`npm run export-dataset -- --target gliner` in the repo root) before the plugin lets
them decide anything; until then a guard "yes" only asks the user.
