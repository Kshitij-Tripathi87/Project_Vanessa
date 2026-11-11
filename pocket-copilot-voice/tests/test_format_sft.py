from __future__ import annotations

import json
from pathlib import Path

import pytest

from pocket_copilot_voice.format_sft import SYSTEM_PROMPTS, format_file, to_chat_record
from pocket_copilot_voice.generate import SYSTEM_PROMPT as SYSTEM_PROMPT_V1
from pocket_copilot_voice.generate import build_records
from pocket_copilot_voice.generate_v2 import SYSTEM_PROMPT_V2, build_records as build_records_v2

ROOT = Path(__file__).resolve().parents[1]


def test_chat_record_rebuilds_minimal_messages_for_v1():
    record = build_records(60, 7)[0]
    chat = to_chat_record(record)

    roles = [message["role"] for message in chat["messages"]]
    assert roles == ["system", "user", "assistant"]
    assert chat["messages"][0]["content"] == SYSTEM_PROMPT_V1
    assert json.loads(chat["messages"][1]["content"]) == record["input"]
    assert json.loads(chat["messages"][2]["content"]) == record["target"]
    assert chat["id"] == record["id"]
    assert chat["schema_version"] == "pocket-copilot.action/v1"


def test_chat_record_uses_v2_prompt_for_v2_rows():
    record = build_records_v2(60, 7)[0]
    chat = to_chat_record(record)

    assert chat["messages"][0]["content"] == SYSTEM_PROMPT_V2
    assert SYSTEM_PROMPTS["pocket-copilot.action/v2"] == SYSTEM_PROMPT_V2
    assert json.loads(chat["messages"][2]["content"]) == record["target"]


def test_system_prompt_can_be_omitted():
    record = build_records_v2(60, 7)[0]
    chat = to_chat_record(record, include_system_prompt=False)

    assert [message["role"] for message in chat["messages"]] == ["user", "assistant"]


def test_format_file_roundtrips_canonical_rows(tmp_path: Path):
    records = build_records(60, 11)[:5]
    source = tmp_path / "canonical.jsonl"
    source.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")

    target = tmp_path / "chat.jsonl"
    written, skipped = format_file(source, target)

    assert (written, skipped) == (5, 0)
    rows = [json.loads(line) for line in target.read_text(encoding="utf-8").splitlines()]
    assert len(rows) == 5
    for row, record in zip(rows, records):
        assert row["id"] == record["id"]
        assert json.loads(row["messages"][2]["content"]) == record["target"]


def test_format_file_rejects_invalid_contract(tmp_path: Path):
    record = build_records(60, 11)[0]
    record["target"]["authority"] = "host"
    source = tmp_path / "bad.jsonl"
    source.write_text(json.dumps(record) + "\n", encoding="utf-8")

    with pytest.raises(ValueError, match="invalid record"):
        format_file(source, tmp_path / "chat.jsonl")


def test_format_file_skips_invalid_when_asked(tmp_path: Path):
    good = build_records(60, 11)[0]
    bad = build_records(60, 11)[1]
    bad["target"]["execution_permitted"] = True
    source = tmp_path / "mixed.jsonl"
    source.write_text(json.dumps(good) + "\n" + json.dumps(bad) + "\n", encoding="utf-8")

    written, skipped = format_file(source, tmp_path / "chat.jsonl", skip_invalid=True)

    assert (written, skipped) == (1, 1)


def test_checked_in_chat_slice_is_consistent_with_canonical_data(tmp_path: Path):
    """The shipped canonical datasets must be convertible without errors."""
    source = ROOT / "data" / "generated" / "dev.jsonl"
    if not source.exists():
        pytest.skip("generated datasets are not present")

    target = tmp_path / "dev.chat.jsonl"
    written, skipped = format_file(source, target)

    assert written > 0
    assert skipped == 0
