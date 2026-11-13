#!/usr/bin/env bash
# Fetch the exact llama.cpp revision the Vanessa Android inference runtime is built against.
#
# The Android module compiles llama.cpp through CMake and JNI. Nothing about that source is
# vendored, so a clean checkout has no native runtime and `assembleDebug` would otherwise
# succeed while silently shipping an APK without local inference. This script materialises
# the pinned revision into .toolchain/llama.cpp (gitignored) so the build is reproducible.
#
# Usage:
#   ./scripts/fetch-llama-cpp.sh                 # clone or verify the pinned revision
#   ./scripts/fetch-llama-cpp.sh /some/other/dir # use an alternate destination
#
# Then build:
#   cd apps/android && ./gradlew :app:assembleDebug \
#       -PllamaCppDir="$(cd ../.. && pwd)/.toolchain/llama.cpp"
set -euo pipefail

# Pinned upstream revision (tag b12164). Change only with a real-device inference result.
LLAMA_CPP_COMMIT="67107ac34f62882d8b53ea41ad68010ea635b9be"
LLAMA_CPP_REPO="https://github.com/ggml-org/llama.cpp.git"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${1:-$repo_root/.toolchain/llama.cpp}"

verify() {
    [[ -f "$target/include/llama.h" && -f "$target/CMakeLists.txt" ]]
}

if [[ -d "$target/.git" ]]; then
    current="$(git -C "$target" rev-parse HEAD 2>/dev/null || true)"
    if [[ "$current" == "$LLAMA_CPP_COMMIT" ]]; then
        echo "llama.cpp already at pinned revision $LLAMA_CPP_COMMIT"
        verify || { echo "checkout is incomplete: missing include/llama.h or CMakeLists.txt" >&2; exit 1; }
        echo "LLAMA_CPP_DIR=$target"
        exit 0
    fi
    echo "checkout at '${current:-unknown}', expected $LLAMA_CPP_COMMIT; refetching" >&2
    rm -rf "$target"
fi

mkdir -p "$(dirname "$target")"
git init -q "$target"
git -C "$target" remote add origin "$LLAMA_CPP_REPO"
# Shallow fetch of one commit keeps this a ~100 MB download instead of the full history.
git -C "$target" fetch --depth 1 origin "$LLAMA_CPP_COMMIT"
git -C "$target" checkout -q FETCH_HEAD

verify || { echo "fetch completed but the checkout is incomplete" >&2; exit 1; }
actual="$(git -C "$target" rev-parse HEAD)"
[[ "$actual" == "$LLAMA_CPP_COMMIT" ]] || { echo "revision mismatch: $actual" >&2; exit 1; }

echo "llama.cpp ready at $actual"
echo "LLAMA_CPP_DIR=$target"
