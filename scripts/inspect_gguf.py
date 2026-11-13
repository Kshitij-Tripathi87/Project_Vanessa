#!/usr/bin/env python3
"""Inspect a GGUF model without loading it: header, key metadata, tokenizer, chat template.

Reads only the GGUF metadata block plus a full-file SHA-256, so it stays cheap on
multi-gigabyte artifacts. Used as the Android model freeze gate: the release must be
able to state the exact model identity instead of trusting a filename.

Usage:
    python scripts/inspect_gguf.py <model.gguf> [--json]

Exit codes:
    0  header and metadata parsed
    2  not a readable GGUF file
"""

from __future__ import annotations

import hashlib
import json
import struct
import sys

GGUF_MAGIC = b"GGUF"

# GGUF metadata value tags, in the order the format assigns them.
SCALAR = {
    0: ("<B", 1),   # UINT8
    1: ("<b", 1),   # INT8
    2: ("<H", 2),   # UINT16
    3: ("<h", 2),   # INT16
    4: ("<I", 4),   # UINT32
    5: ("<i", 4),   # INT32
    6: ("<f", 4),   # FLOAT32
    7: ("<?", 1),   # BOOL
    10: ("<Q", 8),  # UINT64
    11: ("<q", 8),  # INT64
    12: ("<d", 8),  # FLOAT64
}
TAG_STRING = 8
TAG_ARRAY = 9

# Metadata worth reporting for a release manifest. Everything else is counted only.
INTERESTING = (
    "general.architecture",
    "general.name",
    "general.basename",
    "general.size_label",
    "general.file_type",
    "general.quantization_version",
    "general.alignment",
    "tokenizer.ggml.model",
    "tokenizer.ggml.pre",
    "tokenizer.ggml.tokens",
    "tokenizer.ggml.merges",
    "tokenizer.ggml.bos_token_id",
    "tokenizer.ggml.eos_token_id",
    "tokenizer.ggml.padding_token_id",
    "tokenizer.ggml.add_bos_token",
    "tokenizer.ggml.add_eos_token",
    "tokenizer.chat_template",
)
# Per-architecture suffixes reported when present.
ARCH_SUFFIXES = (
    "block_count",
    "context_length",
    "embedding_length",
    "feed_forward_length",
    "attention.head_count",
    "attention.head_count_kv",
    "rope.freq_base",
    "vocab_size",
)


class Reader:
    def __init__(self, stream):
        self._stream = stream

    def read(self, count: int) -> bytes:
        data = self._stream.read(count)
        if len(data) != count:
            raise ValueError("unexpected end of GGUF metadata")
        return data

    def unpack(self, fmt: str, size: int):
        return struct.unpack(fmt, self.read(size))[0]

    def string(self) -> str:
        length = self.unpack("<Q", 8)
        if length > 64 * 1024 * 1024:
            raise ValueError("implausible GGUF string length")
        return self.read(length).decode("utf-8", errors="replace")

    def value(self, tag: int):
        if tag in SCALAR:
            fmt, size = SCALAR[tag]
            return self.unpack(fmt, size)
        if tag == TAG_STRING:
            return self.string()
        if tag == TAG_ARRAY:
            element_tag = self.unpack("<I", 4)
            count = self.unpack("<Q", 8)
            if count > 1 << 32:
                raise ValueError("implausible GGUF array length")
            # Token tables hold ~150k entries; keep a few samples but consume every
            # element, or the stream desynchronises and later keys fail to parse.
            if element_tag == TAG_STRING:
                sample = [self.string() for _ in range(min(count, 8))]
                for _ in range(count - len(sample)):
                    self.read(self.unpack("<Q", 8))
                return {"array_length": count, "sample": sample}
            if element_tag == TAG_ARRAY:
                for _ in range(count):
                    self.value(TAG_ARRAY)
                return {"array_length": count, "sample": []}
            fmt, size = SCALAR.get(element_tag, (None, None))
            if fmt is None:
                raise ValueError(f"unsupported GGUF array element tag {element_tag}")
            sample = [self.unpack(fmt, size) for _ in range(min(count, 8))]
            for _ in range(count - len(sample)):
                self.read(size)
            return {"array_length": count, "sample": sample}
        raise ValueError(f"unsupported GGUF value tag {tag}")


def inspect(path: str) -> dict:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)

    with open(path, "rb") as stream:
        reader = Reader(stream)
        if reader.read(4) != GGUF_MAGIC:
            raise ValueError("not a GGUF file (bad magic)")
        version = reader.unpack("<I", 4)
        if version not in (2, 3):
            raise ValueError(f"unsupported GGUF version {version} (expected 2 or 3)")
        tensor_count = reader.unpack("<Q", 8)
        kv_count = reader.unpack("<Q", 8)

        metadata: dict = {}
        for _ in range(kv_count):
            key = reader.string()
            tag = reader.unpack("<I", 4)
            value = reader.value(tag)
            if key in INTERESTING or key.rsplit(".", 1)[-1] in ARCH_SUFFIXES:
                if isinstance(value, str) and len(value) > 4096:
                    metadata[key] = {
                        "chars": len(value),
                        "sha256": hashlib.sha256(value.encode("utf-8")).hexdigest(),
                    }
                elif isinstance(value, dict) and value.get("array_length", 0) > 8:
                    metadata[key] = {
                        "array_length": value["array_length"],
                        "sample": value["sample"][:4],
                    }
                else:
                    metadata[key] = value

    import os

    architecture = metadata.get("general.architecture")
    return {
        "path": path,
        "bytes": os.path.getsize(path),
        "sha256": digest.hexdigest(),
        "gguf_version": version,
        "tensor_count": tensor_count,
        "metadata_kv_count": kv_count,
        "architecture": architecture,
        "chat_template": "present" if "tokenizer.chat_template" in metadata else "missing",
        "metadata": metadata,
    }


def main(argv: list[str]) -> int:
    # Token tables contain non-ASCII byte-level tokens; the default Windows console
    # codepage cannot encode them and would abort the report with a UnicodeError.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    if len(argv) < 2:
        print(__doc__.strip().splitlines()[0], file=sys.stderr)
        print("usage: inspect_gguf.py <model.gguf> [--json]", file=sys.stderr)
        return 2
    try:
        report = inspect(argv[1])
    except (OSError, ValueError, struct.error) as error:
        print(f"invalid GGUF: {error}", file=sys.stderr)
        return 2

    if "--json" in argv:
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0

    print(f"path          {report['path']}")
    print(f"bytes         {report['bytes']:,}")
    print(f"sha256        {report['sha256']}")
    print(f"gguf version  {report['gguf_version']}")
    print(f"tensors       {report['tensor_count']:,}")
    print(f"metadata kvs  {report['metadata_kv_count']:,}")
    print(f"architecture  {report['architecture']}")
    print(f"chat template {report['chat_template']}")
    print("metadata:")
    for key in sorted(report["metadata"]):
        value = report["metadata"][key]
        if isinstance(value, dict) and "array_length" in value:
            # Token/merge tables: report the size, not the (very long) samples.
            print(f"  {key} = <array of {value['array_length']}>")
        else:
            text = str(value)
            print(f"  {key} = {text if len(text) <= 120 else text[:117] + '...'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
