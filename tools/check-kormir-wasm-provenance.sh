#!/usr/bin/env bash
#
# Verify that bitCaster-app/src/lib/kormir-wasm-pkg was built from the
# current dlcdevkit submodule sources.
#
# Exit 0 when the bundle matches the recorded source fingerprint.
# Exit 1 with a clear message when the bundle is stale or the fingerprint
# file is missing.
#
# The fingerprint is written by tools/build-kormir-wasm.sh each time a
# rebuild succeeds.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
DDK_DIR="$REPO_ROOT/dlcdevkit"
OUT_DIR="$REPO_ROOT/bitCaster-app/src/lib/kormir-wasm-pkg"
FINGERPRINT_FILE="$OUT_DIR/.source-fingerprint"

if [ ! -f "$FINGERPRINT_FILE" ]; then
    echo "error: kormir-wasm-pkg is stale: rebuild with tools/build-kormir-wasm.sh" >&2
    echo "       (fingerprint file missing: $FINGERPRINT_FILE)" >&2
    exit 1
fi

# Compute current tree hashes for kormir and kormir-wasm directories
CURRENT="$(git -C "$DDK_DIR" rev-parse HEAD:kormir HEAD:kormir-wasm)"
RECORDED="$(cat "$FINGERPRINT_FILE")"

if [ "$CURRENT" = "$RECORDED" ]; then
    echo "kormir-wasm-pkg provenance OK"
    exit 0
else
    echo "error: kormir-wasm-pkg is stale: rebuild with tools/build-kormir-wasm.sh" >&2
    echo "" >&2
    echo "  Recorded fingerprint:" >&2
    echo "$RECORDED" | sed 's/^/    /' >&2
    echo "" >&2
    echo "  Current source fingerprint:" >&2
    echo "$CURRENT" | sed 's/^/    /' >&2
    exit 1
fi
