"""Convert canonical Pocket Co-pilot JSONL rows into chat-format SFT rows.

Canonical rows already carry ``input`` and ``target``. They do not repeat the
system prompt, because doing so on every row wastes tokens for a small model.
This module rebuilds a minimal system/user/assistant chat record on demand,
picking the system prompt that matches the row's ``schema_version``.

Usage:

    pocket-copilot-format-sft \\
        --input data/generated/train.jsonl \\
        --output data/generated/train.chat.jsonl
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Iterable

from .contracts import validate_record as validate_record_v1
from .contracts_v2 import validate_action_v2, validate_request_v2
from .generate import SYSTEM_PROMPT as SYSTEM_PROMPT_V1
from .generate_v2 import SYSTEM_PROMPT_V2

SYSTEM_PROMPTS = {
    "pocket-copilot.action/v1": SYSTEM_PROMPT_V1,
    "pocket-copilot.action/v2": SYSTEM_PROMPT_V2,
}

SUPPORTED_VERSIONS = tuple(SYSTEM_PROMPTS)


def compact_json(value: Any) -> str:
    """Serialize a value deterministically and without incidental whitespace."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def record_version(record: dict[str, Any]) -> str:
    try:
        return record["target"]["schema_version"]
    except (KeyError, TypeError) as exc:  # pragma: no cover - defensive
        raise ValueError(f"record {record.get('id', '<no id>')} has no target.schema_version") from exc


def validate_canonical_record(record: dict[str, Any]) -> list[str]:
    version = record_version(record)
    if version == "pocket-copilot.action/v1":
        return validate_record_v1(record)
    if version == "pocket-copilot.action/v2":
        errors = [f"input: {e}" for e in validate_request_v2(record["input"])]
        errors.extend(f"target: {e}" for e in validate_action_v2(record["target"]))
        return errors
    return [f"unsupported schema_version: {version}"]


def to_chat_record(record: dict[str, Any], *, include_system_prompt: bool = True) -> dict[str, Any]:
    """Build one chat-format row from a canonical ``input``/``target`` record."""
    version = record_version(record)
    if version not in SYSTEM_PROMPTS:
        raise ValueError(f"record {record.get('id', '<no id>')} uses unsupported schema_version {version}")

    messages: list[dict[str, str]] = []
    if include_system_prompt:
        messages.append({"role": "system", "content": SYSTEM_PROMPTS[version]})
    messages.append({"role": "user", "content": compact_json(record["input"])})
    messages.append({"role": "assistant", "content": compact_json(record["target"])})

    chat_record: dict[str, Any] = {"messages": messages}
    for key in ("id", "split"):
        if key in record:
            chat_record[key] = record[key]
    chat_record["schema_version"] = version
    return chat_record


def iter_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_number}: invalid JSON ({exc.msg})") from exc


def format_file(
    input_path: Path,
    output_path: Path,
    *,
    include_system_prompt: bool = True,
    skip_invalid: bool = False,
) -> tuple[int, int]:
    """Write chat rows for ``input_path``; return ``(written, skipped)``."""
    written = 0
    skipped = 0
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="\n") as handle:
        for record in iter_jsonl(input_path):
            errors = validate_canonical_record(record)
            if errors:
                if skip_invalid:
                    skipped += 1
                    continue
                raise ValueError(f"invalid record {record.get('id', '<no id>')}: " + "; ".join(errors))
            handle.write(
                json.dumps(
                    to_chat_record(record, include_system_prompt=include_system_prompt),
                    ensure_ascii=False,
                    sort_keys=True,
                )
                + "\n"
            )
            written += 1
    return written, skipped


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert canonical Pocket Co-pilot JSONL into chat-format SFT JSONL."
    )
    parser.add_argument("--input", type=Path, required=True, help="Canonical JSONL with input/target rows.")
    parser.add_argument("--output", type=Path, required=True, help="Destination chat-format JSONL.")
    parser.add_argument(
        "--no-system-prompt",
        action="store_true",
        help="Omit the system message (for trainers that prepend it themselves).",
    )
    parser.add_argument(
        "--skip-invalid",
        action="store_true",
        help="Drop rows that fail contract validation instead of failing the run.",
    )
    args = parser.parse_args()

    written, skipped = format_file(
        args.input,
        args.output,
        include_system_prompt=not args.no_system_prompt,
        skip_invalid=args.skip_invalid,
    )
    print(f"Wrote {written} chat rows to {args.output.resolve()}" + (f" ({skipped} skipped)" if skipped else ""))


if __name__ == "__main__":
    main()
