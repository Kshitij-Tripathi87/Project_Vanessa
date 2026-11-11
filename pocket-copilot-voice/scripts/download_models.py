#!/usr/bin/env python3
"""
Download GGUF models from Hugging Face for benchmarking using Python API.

Models:
- Qwen3-0.6B-GGUF (ggml-org)
- Qwen2.5-0.5B-Instruct-GGUF (Qwen)
- LFM2-350M-GGUF (LiquidAI)
- LFM2-700M-GGUF (LiquidAI)
- Llama-3.2-1B-Instruct-GGUF (bartowski)

Usage:
    python scripts/download_models.py --models-dir models
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from huggingface_hub import hf_hub_download

# Model download configs: (hf_repo, local_dir, filename_pattern)
MODELS = [
    {
        "name": "qwen3-0.6b",
        "repo": "ggml-org/Qwen3-0.6B-GGUF",
        "filenames": ["Qwen3-0.6B-Q4_0.gguf", "Qwen3-0.6B-Q8_0.gguf"],
    },
    {
        "name": "qwen2.5-0.5b",
        "repo": "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
        "filenames": ["Qwen2.5-0.5B-Instruct-Q4_0.gguf", "Qwen2.5-0.5B-Instruct-Q4_K_M.gguf"],
    },
    {
        "name": "lfm2-350m",
        "repo": "LiquidAI/LFM2-350M-GGUF",
        "filenames": ["LFM2-350M-Q4_0.gguf", "LFM2-350M-Q4_K_M.gguf"],
    },
    {
        "name": "lfm2-700m",
        "repo": "LiquidAI/LFM2-700M-GGUF",
        "filenames": ["LFM2-700M-Q4_0.gguf", "LFM2-700M-Q4_K_M.gguf"],
    },
    {
        "name": "llama-3.2-1b",
        "repo": "bartowski/Llama-3.2-1B-Instruct-GGUF",
        "filenames": ["Llama-3.2-1B-Instruct-Q4_0.gguf", "Llama-3.2-1B-Instruct-Q4_K_M.gguf"],
    },
]


def download_model(repo: str, local_dir: Path, filenames: list[str], token: str | None = None) -> bool:
    """Download model files using hf_hub_download."""
    local_dir.mkdir(parents=True, exist_ok=True)
    
    all_success = True
    for filename in filenames:
        try:
            print(f"  Downloading {filename}...")
            hf_hub_download(
                repo_id=repo,
                filename=filename,
                local_dir=local_dir,
                local_dir_use_symlinks=False,
                token=token,
            )
            print(f"  [OK] {filename}")
        except Exception as e:
            print(f"  [FAIL] {filename}: {e}")
            all_success = False
    
    return all_success


def main() -> None:
    parser = argparse.ArgumentParser(description="Download GGUF models from Hugging Face")
    parser.add_argument("--models-dir", type=Path, default=Path("models"), help="Output directory")
    parser.add_argument("--model", choices=[m["name"] for m in MODELS] + ["all"], default="all")
    parser.add_argument("--token", help="Hugging Face token (for gated models)")
    args = parser.parse_args()
    
    models_to_download = MODELS if args.model == "all" else [m for m in MODELS if m["name"] == args.model]
    
    print(f"Downloading {len(models_to_download)} model(s) to {args.models_dir}")
    
    for model in models_to_download:
        print(f"\n{model['name']} from {model['repo']}")
        local_dir = args.models_dir / model["name"]
        success = download_model(model["repo"], local_dir, model["filenames"], args.token)
        if not success:
            print(f"Some files failed for {model['name']}")
    
    print("\nDone. Verify files:")
    for model in models_to_download:
        local_dir = args.models_dir / model["name"]
        files = list(local_dir.glob("*.gguf"))
        if files:
            for f in files:
                size_mb = f.stat().st_size / 1024**2
                print(f"  {model['name']}: {f.name} ({size_mb:.1f} MB)")
        else:
            print(f"  {model['name']}: NO FILES FOUND")


if __name__ == "__main__":
    main()