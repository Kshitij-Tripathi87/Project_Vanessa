# Pocket Co-pilot Voice — action contract, synthetic data, evaluation

A small on-device voice front end for a larger host assistant. It converts an ASR transcript plus a small cached entity catalog into a typed action proposal. It does **not** replace the host's reasoning, live-state access, policy engine, approvals, or execution layer.

## What is included

- `schemas/action.schema.json` — proposal-only output contract (`pocket-copilot.action/v1`).
- `schemas/request.schema.json` — model input contract.
- `src/pocket_copilot_voice/generate.py` — deterministic synthetic SFT data generator, including English, Hinglish, Hindi, alias resolution, missing-slot clarification, host handoff, refusal, and no-action examples.
- `data/generated/train.jsonl` and `dev.jsonl` — a seed-locked 4,500 / 500 initial generation.
- `evaluation/golden_eval.jsonl` — 53 fixed, hand-authored holdout cases. These are intentionally not generated from the synthetic utterance templates.
- `src/pocket_copilot_voice/evaluate.py` — schema, decision, action-name, and exact-match evaluation for model predictions.
- `docs/host-policy-boundary.md` — host-side authority and policy boundary.

## Contract invariant

Every valid output has:

```json
{
  "authority": "none",
  "host_required": true,
  "execution_permitted": false
}
```

A state-changing utterance can produce `decision: "propose_action"`, but that is only a parsed proposal. It is not approval or execution. The host must re-resolve targets, re-check permissions and current state, enforce policy, request confirmation where necessary, and run the action through its own tool layer.

## Install and run

Python 3.10+ is required.

```bash
python -m venv .venv
# Windows PowerShell: .venv\\Scripts\\Activate.ps1
# macOS/Linux: source .venv/bin/activate
pip install -e ".[test]"

# Regenerate (deterministic for a given seed)
pocket-copilot-generate --count 5000 --seed 20261109 --output data/generated

# Validate project artifacts
pytest -q
```

Or run without installing the console script:

```bash
PYTHONPATH=src python -m pocket_copilot_voice.generate --count 5000 --seed 20261109 --output data/generated
```

## SFT row shape

Each JSONL row contains:

- `input`: transcript, locale, ASR confidence, online/offline hint, and a bounded cached entity catalog.
- `target`: the expected JSON object governed by `action.schema.json`.
- `messages`: a system/user/assistant chat representation suitable for conversion into the trainer's chat-template format.

No chain-of-thought is generated or required. The target is a compact structured output.

## Preparing for fine-tuning

Canonical rows keep only `input` and `target`; the system prompt is not duplicated on every row. Rebuild chat-format data when a trainer needs it:

```bash
pocket-copilot-format-sft \
  --input data/generated/train.jsonl \
  --output data/generated/train.chat.jsonl

pocket-copilot-format-sft \
  --input data/generated/dev.jsonl \
  --output data/generated/dev.chat.jsonl
```

Each output row is `{id, split, schema_version, messages}` with minimal whitespace. The system prompt is selected from the row's `schema_version`, so v1 and v2 datasets can be converted side by side. Invalid rows abort the run unless `--skip-invalid` is passed; `--no-system-prompt` omits the system message for trainers that prepend it themselves.

## Evaluation protocol

Run the model on each `input` from `evaluation/golden_eval.jsonl`, then write prediction rows as:

```json
{"id":"E001","prediction":{"schema_version":"pocket-copilot.action/v1", "...":"..."}}
```

Evaluate:

```bash
pocket-copilot-evaluate --gold evaluation/golden_eval.jsonl --predictions evaluation/predictions.jsonl --output evaluation/report.json
```

The evaluator reports schema-valid rate, safe-contract rate, decision accuracy, exact output match, action-name accuracy, and exact action match. Treat false proposals, prompt-injection failures, unsafe overreach, and incorrect entity resolution as release blockers even when aggregate accuracy looks good.

## Important limitations

- All generated data is synthetic. It is a starting corpus, not evidence of real-world ASR robustness or model capability.
- The 53-case set is a compact regression suite, not a statistically sufficient benchmark. Expand it with consented, redacted operator utterances and adversarial cases before making product claims.
- The cached entity catalog is only a disambiguation hint. The host must resolve all entities again.
- Confidence is not authorization. Offline parsing is not a durable command queue.
- Fine-tuning, quantization, Android integration, latency profiling, and the Redmi device benchmark are intentionally out of scope for this sandbox package.
