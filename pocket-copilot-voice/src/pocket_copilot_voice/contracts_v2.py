from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

# Prefer the schemas bundled with the package so an installed wheel works; fall
# back to the repository-level schemas directory for source checkouts.
_PACKAGE_SCHEMA_DIR = Path(__file__).resolve().parent / "schemas"
_REPO_SCHEMA_DIR = Path(__file__).resolve().parent.parent.parent / "schemas"
SCHEMA_DIR = _PACKAGE_SCHEMA_DIR if _PACKAGE_SCHEMA_DIR.is_dir() else _REPO_SCHEMA_DIR

# ─── Loaders ────────────────────────────────────────────────────────────────

def load_schema(name: str) -> dict[str, Any]:
    path = SCHEMA_DIR / name
    if not path.is_file():
        path = _REPO_SCHEMA_DIR / name
    with path.open("r", encoding="utf-8") as handle:
        schema = json.load(handle)
    Draft202012Validator.check_schema(schema)
    return schema


# ─── Validators ─────────────────────────────────────────────────────────────

_REQUEST_V2_VALIDATOR = Draft202012Validator(load_schema("request.v2.schema.json"))
_ACTION_V2_VALIDATOR = Draft202012Validator(load_schema("action.v2.schema.json"))
_ENVELOPE_V2_VALIDATOR = Draft202012Validator(load_schema("proposal_envelope.v2.schema.json"))
_MANIFEST_V2_VALIDATOR = Draft202012Validator(load_schema("capability_manifest.v2.schema.json"))

# Legacy v1 validators (for backward compatibility)
_REQUEST_V1_VALIDATOR = Draft202012Validator(load_schema("request.schema.json"))
_ACTION_V1_VALIDATOR = Draft202012Validator(load_schema("action.schema.json"))


# ─── Validation functions ───────────────────────────────────────────────────

def validate_request_v2(value: dict[str, Any]) -> list[str]:
    return [
        error.message
        for error in sorted(
            _REQUEST_V2_VALIDATOR.iter_errors(value),
            key=lambda e: list(map(str, e.path))
        )
    ]


def validate_action_v2(value: dict[str, Any]) -> list[str]:
    errors = [
        error.message
        for error in sorted(
            _ACTION_V2_VALIDATOR.iter_errors(value),
            key=lambda e: list(map(str, e.path))
        )
    ]
    if errors:
        return errors

    # Additional semantic validation
    decision = value["decision"]

    # Invariant checks
    if value.get("authority") != "none":
        errors.append("authority must be 'none'")
    if value.get("host_required") is not True:
        errors.append("host_required must be true")
    if value.get("execution_permitted") is not False:
        errors.append("execution_permitted must be false")

    if decision == "invoke_capability":
        inv = value.get("invocation")
        if not inv:
            errors.append("invoke_capability requires invocation object")
        else:
            # missing_arguments must be empty for invoke_capability
            if inv.get("missing_arguments"):
                errors.append("invoke_capability must have empty missing_arguments")
            # capability_id format
            cap_id = inv.get("capability_id", "")
            if not cap_id or "." not in cap_id:
                errors.append("capability_id must be namespaced (e.g., filesystem.search)")

    elif decision == "delegate_task":
        dep = value.get("delegation")
        if not dep:
            errors.append("delegate_task requires delegation object")
        else:
            if not dep.get("original_request"):
                errors.append("delegation.original_request is required")

    elif decision == "clarify":
        clar = value.get("clarification")
        if not clar:
            errors.append("clarify requires clarification object")
        else:
            if not clar.get("question"):
                errors.append("clarification.question is required")
            if not clar.get("missing_argument_names") and clar.get("reason") == "missing_required_argument":
                errors.append("missing_required_argument reason requires missing_argument_names")

    elif decision == "refuse":
        ref = value.get("refusal")
        if not ref:
            errors.append("refuse requires refusal object")
        else:
            if not ref.get("code") or not ref.get("message"):
                errors.append("refusal must have code and message")

    elif decision == "no_action":
        # All sub-objects must be null
        for field in ("invocation", "delegation", "clarification", "refusal"):
            if value.get(field) is not None:
                errors.append(f"{field} must be null for no_action")

    return errors


def validate_envelope_v2(value: dict[str, Any]) -> list[str]:
    return [
        error.message
        for error in sorted(
            _ENVELOPE_V2_VALIDATOR.iter_errors(value),
            key=lambda e: list(map(str, e.path))
        )
    ]


def validate_manifest_v2(value: dict[str, Any]) -> list[str]:
    return [
        error.message
        for error in sorted(
            _MANIFEST_V2_VALIDATOR.iter_errors(value),
            key=lambda e: list(map(str, e.path))
        )
    ]


# Legacy v1 validation (unchanged)
def validate_request(value: dict[str, Any]) -> list[str]:
    return [
        error.message
        for error in sorted(
            _REQUEST_V1_VALIDATOR.iter_errors(value),
            key=lambda e: list(map(str, e.path))
        )
    ]


def validate_action(value: dict[str, Any]) -> list[str]:
    # Reuse existing v1 validation logic from contracts.py
    from .contracts import validate_action as _validate_action_v1
    return _validate_action_v1(value)


# ─── Assertion helpers ──────────────────────────────────────────────────────

def assert_request_v2_valid(value: dict[str, Any]) -> None:
    errors = validate_request_v2(value)
    if errors:
        raise ValueError("Invalid request v2: " + "; ".join(errors))


def assert_action_v2_valid(value: dict[str, Any]) -> None:
    errors = validate_action_v2(value)
    if errors:
        raise ValueError("Invalid action v2: " + "; ".join(errors))


def assert_envelope_v2_valid(value: dict[str, Any]) -> None:
    errors = validate_envelope_v2(value)
    if errors:
        raise ValueError("Invalid envelope v2: " + "; ".join(errors))


def assert_manifest_v2_valid(value: dict[str, Any]) -> None:
    errors = validate_manifest_v2(value)
    if errors:
        raise ValueError("Invalid manifest v2: " + "; ".join(errors))


# ─── Utility ────────────────────────────────────────────────────────────────

def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)