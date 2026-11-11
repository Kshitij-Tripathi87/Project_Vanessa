from __future__ import annotations

import json
from pathlib import Path

from pocket_copilot_voice.evaluate import evaluate

ROOT = Path(__file__).resolve().parents[1]


def test_evaluator_reports_perfect_scores_for_gold_as_predictions():
    gold = []
    with (ROOT / "evaluation" / "golden_eval.jsonl").open(encoding="utf-8") as handle:
        gold = [json.loads(line) for line in handle if line.strip()]
    predictions = [{"id": row["id"], "prediction": row["target"]} for row in gold]
    report = evaluate(gold, predictions)
    assert report["schema_valid_rate"] == 1.0
    assert report["safe_contract_rate"] == 1.0
    assert report["decision_accuracy"] == 1.0
    assert report["exact_output_match_rate"] == 1.0
    assert report["exact_action_match_rate"] == 1.0
