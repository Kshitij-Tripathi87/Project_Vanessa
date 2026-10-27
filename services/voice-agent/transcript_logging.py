"""Privacy-preserving formatting for local speech-recognition diagnostics."""

from __future__ import annotations

import os
import re


def _clean_field(value: object, limit: int) -> str:
    # Keep log lines single-line and bounded to avoid accidental log injection.
    cleaned = re.sub(r"[\x00-\x1f\x7f]+", " ", str(value or "unknown"))
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:limit] or "unknown"


def format_transcript_log(
    event: str,
    transcript: str,
    language: str | None = None,
    *,
    include_content: bool | None = None,
) -> str:
    """Return a safe transcript log line, excluding content unless opted in.

    Runtime callers normally omit include_content and must deliberately set
    VANESSA_LOG_TRANSCRIPTS=true to persist transcript text for local debugging.
    """
    raw_text = transcript if isinstance(transcript, str) else ""
    event_name = _clean_field(event, 80)
    language_name = _clean_field(language, 32)
    if include_content is None:
        include_content = os.environ.get("VANESSA_LOG_TRANSCRIPTS", "false").strip().lower() in {
            "1", "true", "yes", "on"
        }

    if include_content:
        preview = _clean_field(raw_text, 500) if raw_text else ""
        truncated = "…" if len(raw_text) > 500 else ""
        return (
            f"{event_name}: transcript content "
            f"(characters={len(raw_text)}, language={language_name}): '{preview}{truncated}'"
        )

    return f"{event_name}: transcript received (characters={len(raw_text)}, language={language_name})"
