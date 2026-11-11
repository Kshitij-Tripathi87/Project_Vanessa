from __future__ import annotations

import json
from pathlib import Path

from pocket_copilot_voice.contracts import load_schema, validate_action, validate_record
from pocket_copilot_voice.generate import build_records

ROOT = Path(__file__).resolve().parents[1]


def read_jsonl(path: Path):
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def test_both_json_schemas_are_valid():
    assert load_schema("action.schema.json")["$schema"].endswith("2020-12/schema")
    assert load_schema("request.schema.json")["$schema"].endswith("2020-12/schema")


def test_golden_eval_records_validate_and_are_grounded():
    rows = read_jsonl(ROOT / "evaluation" / "golden_eval.jsonl")
    assert len(rows) >= 50
    assert len({row["id"] for row in rows}) == len(rows)
    for row in rows:
        assert validate_record(row) == [], row["id"]


def test_synthetic_generator_is_deterministic_and_valid():
    first = build_records(150, 1234)
    second = build_records(150, 1234)
    assert first == second
    for row in first:
        assert validate_record(row) == [], row["id"]


def test_schema_rejects_any_claim_of_local_execution():
    bad = {
        "schema_version": "pocket-copilot.action/v1",
        "decision": "handoff",
        "action": None,
        "clarification": None,
        "handoff": {"reason": "needs_live_state"},
        "refusal": None,
        "interpretation_confidence": 0.9,
        "authority": "host",
        "host_required": False,
        "execution_permitted": True,
    }
    assert validate_action(bad)


def test_proposal_cannot_omit_required_parameters():
    rows = read_jsonl(ROOT / "evaluation" / "golden_eval.jsonl")
    valid = next(row["target"] for row in rows if row["id"] == "E015")
    mutated = json.loads(json.dumps(valid))
    mutated["action"]["parameters"] = {}
    assert validate_action(mutated)


def test_state_change_is_still_only_a_proposal():
    rows = read_jsonl(ROOT / "evaluation" / "golden_eval.jsonl")
    proposals = [row["target"] for row in rows if row["target"]["decision"] == "propose_action"]
    assert proposals
    for result in proposals:
        assert result["authority"] == "none"
        assert result["host_required"] is True
        assert result["execution_permitted"] is False


def test_schema_rejects_parameters_from_another_action_family():
    rows = read_jsonl(ROOT / "evaluation" / "golden_eval.jsonl")
    valid = next(row["target"] for row in rows if row["id"] == "E015")
    mutated = json.loads(json.dumps(valid))
    mutated["action"]["parameters"]["window_minutes"] = 15
    assert validate_action(mutated)
