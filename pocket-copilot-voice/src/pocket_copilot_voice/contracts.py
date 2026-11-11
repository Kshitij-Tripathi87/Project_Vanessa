from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

SCHEMA_DIR = Path(__file__).resolve().parent / "schemas"

ACTION_PARAMETERS: dict[str, set[str]] = {
    "get_service_status": set(),
    "list_services": {"state"},
    "get_recent_logs": {"window_minutes", "max_lines"},
    "get_metrics": {"metrics", "window_minutes"},
    "run_diagnostic": {"check"},
    "restart_service": {"reason"},
    "scale_service": {"replicas"},
    "deploy_release": {"version", "environment"},
    "rollback_release": {"version", "environment"},
    "create_incident": {"title", "severity", "description"},
    "acknowledge_alert": set(),
    "silence_alert": {"duration_minutes"},
}
PROPOSAL_REQUIRED_PARAMETERS: dict[str, set[str]] = {
    "get_service_status": set(),
    "list_services": set(),
    "get_recent_logs": {"window_minutes"},
    "get_metrics": {"metrics"},
    "run_diagnostic": {"check"},
    "restart_service": set(),
    "scale_service": {"replicas"},
    "deploy_release": {"version", "environment"},
    "rollback_release": {"version", "environment"},
    "create_incident": {"title", "severity"},
    "acknowledge_alert": set(),
    "silence_alert": {"duration_minutes"},
}


def load_schema(name: str) -> dict[str, Any]:
    path = SCHEMA_DIR / name
    with path.open("r", encoding="utf-8") as handle:
        schema = json.load(handle)
    Draft202012Validator.check_schema(schema)
    return schema


_ACTION_VALIDATOR = Draft202012Validator(load_schema("action.schema.json"))
_REQUEST_VALIDATOR = Draft202012Validator(load_schema("request.schema.json"))


def validate_action(value: dict[str, Any]) -> list[str]:
    errors = [error.message for error in sorted(_ACTION_VALIDATOR.iter_errors(value), key=lambda e: list(map(str, e.path)))]
    if errors:
        return errors
    decision = value["decision"]
    action = value["action"]
    if decision not in {"propose_action", "clarify"}:
        return []

    name = action["name"]
    params = set(action["parameters"])
    target = action["target"]
    missing = set(action["missing_slots"])
    unexpected_params = params - ACTION_PARAMETERS[name]
    if unexpected_params:
        errors.append(f"{name} contains unsupported parameter(s): {sorted(unexpected_params)}")

    if decision == "propose_action":
        absent = PROPOSAL_REQUIRED_PARAMETERS[name] - params
        if absent:
            errors.append(f"{name} proposal is missing required parameter(s): {sorted(absent)}")
        if missing:
            errors.append("propose_action must not contain missing_slots")
        if name in {"get_service_status", "get_recent_logs", "get_metrics", "run_diagnostic", "restart_service", "scale_service", "deploy_release", "rollback_release"}:
            if target["entity_type"] != "service" or not target["raw_mention"] or not target["canonical_name"]:
                errors.append(f"{name} requires a resolved service mention from the supplied catalog")
        elif name in {"acknowledge_alert", "silence_alert"}:
            if target["entity_type"] != "alert" or not target["raw_mention"] or not target["canonical_name"]:
                errors.append(f"{name} requires a resolved alert mention from the supplied catalog")
        elif name in {"list_services", "create_incident"}:
            if any(target[k] is not None for k in ("entity_type", "raw_mention", "canonical_name")):
                errors.append(f"{name} must not include a target")
    else:
        if not missing:
            errors.append("clarify must identify at least one missing slot")
    return errors


def validate_request(value: dict[str, Any]) -> list[str]:
    return [error.message for error in sorted(_REQUEST_VALIDATOR.iter_errors(value), key=lambda e: list(map(str, e.path)))]


def validate_record(record: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    errors.extend(f"input: {e}" for e in validate_request(record["input"]))
    errors.extend(f"target: {e}" for e in validate_action(record["target"]))
    action = record["target"].get("action")
    if action:
        target = action["target"]
        raw = target.get("raw_mention")
        if raw and raw.casefold() not in record["input"]["transcript"].casefold():
            errors.append("target.raw_mention is not an exact substring of the transcript")
        canonical = target.get("canonical_name")
        if canonical:
            candidates = record["input"]["entity_catalog"]
            matches = [entry for entry in candidates if entry["canonical_name"] == canonical and entry["entity_type"] == target["entity_type"]]
            if not matches:
                errors.append("target.canonical_name is not present in the supplied entity catalog")
            elif raw and raw.casefold() not in {canonical.casefold(), *(a.casefold() for a in matches[0]["aliases"])}:
                errors.append("target.raw_mention does not match the canonical entity or one of its cached aliases")
    return errors


def assert_action_valid(value: dict[str, Any]) -> None:
    errors = validate_action(value)
    if errors:
        raise ValueError("Invalid action output: " + "; ".join(errors))


def assert_request_valid(value: dict[str, Any]) -> None:
    errors = validate_request(value)
    if errors:
        raise ValueError("Invalid request input: " + "; ".join(errors))
