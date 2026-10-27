#!/usr/bin/env python3
"""Check whether a Faster-Whisper model is cached without downloading or loading it."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Callable, Optional

CORE_FILES = ("config.json", "model.bin")
TOKENIZER_FILES = ("tokenizer.json", "vocabulary.txt")


def _is_real_file(value: object) -> bool:
    if not isinstance(value, (str, os.PathLike)):
        return False
    try:
        return Path(value).is_file()
    except (OSError, TypeError, ValueError):
        return False


def _directory_has_model_files(directory: Path) -> bool:
    return (
        all((directory / filename).is_file() for filename in CORE_FILES)
        and any((directory / filename).is_file() for filename in TOKENIZER_FILES)
    )


def inspect_model_cache(
    model: str,
    cache_lookup: Optional[Callable[[str, str], object]] = None,
) -> tuple[bool, str]:
    """Return (ready, reason) using local files/cache metadata only; never fetch network data."""
    value = str(model or "").strip()
    if not value:
        return False, "VOICE_MODEL is empty."

    path = Path(value).expanduser()
    if path.is_dir():
        if _directory_has_model_files(path):
            return True, "Configured local model directory is complete."
        return False, "Configured local model directory is missing required model files."

    if path.is_absolute() or "\\" in value:
        return False, "Configured local model path does not exist or is incomplete."

    if cache_lookup is None:
        try:
            from huggingface_hub import try_to_load_from_cache
        except ImportError:
            return False, "huggingface_hub is unavailable; rerun Vanessa setup to repair speech dependencies."
        cache_lookup = try_to_load_from_cache

    if "/" in value:
        repository = value
    else:
        repository = "Systran/faster-whisper-" + value

    try:
        core_found = all(
            _is_real_file(cache_lookup(repository, filename))
            for filename in CORE_FILES
        )
        tokenizer_found = any(
            _is_real_file(cache_lookup(repository, filename))
            for filename in TOKENIZER_FILES
        )
    except Exception:
        return False, "The local speech model cache could not be inspected."

    if core_found and tokenizer_found:
        return True, "Configured speech model is present in the local cache."
    return False, "Configured speech model is not cached or is missing required files."


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="Faster-Whisper model size, repository ID, or local model directory")
    args = parser.parse_args(argv)

    ready, reason = inspect_model_cache(args.model)
    if ready:
        print("[OK] Local speech model cache is ready.")
        return 0

    print("[Setup required] " + reason, file=sys.stderr)
    print("[Setup required] Run Launch-Vanessa.bat again while online to download or repair the configured model.", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
