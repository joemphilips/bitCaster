#!/usr/bin/env bash
#
# Build kormir-wasm into bitCaster-app.
#
# Produces an ES-module wasm package under
#   bitCaster-app/src/lib/kormir-wasm-pkg/
# which is imported dynamically by src/lib/kormir.ts so the browser only
# downloads the wasm bundle when the oracle flow is entered.
#
# Prerequisites:
#   * rustup with the wasm32-unknown-unknown target installed:
#       rustup target add wasm32-unknown-unknown
#   * wasm-pack:
#       curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
#
# The generated pkg/ directory is committed to the repository so CI and
# other developers do not need to install a Rust toolchain just to build
# the frontend. Rerun this script whenever the dlcdevkit/ submodule is
# updated.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
DDK_DIR="$REPO_ROOT/dlcdevkit"
OUT_DIR="$REPO_ROOT/bitCaster-app/src/lib/kormir-wasm-pkg"

MODE="${1:---release}"

if [ ! -d "$DDK_DIR/kormir-wasm" ]; then
    echo "error: dlcdevkit submodule is not initialized at $DDK_DIR" >&2
    echo "       run: git submodule update --init --recursive" >&2
    exit 1
fi

if ! command -v wasm-pack >/dev/null 2>&1; then
    echo "error: wasm-pack is not installed" >&2
    echo "       install with: curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh" >&2
    exit 1
fi

# secp256k1-sys / secp256k1-zkp-sys compile C code for wasm32. They rely on
# clang finding freestanding headers (stddef.h, stdint.h, …). Some clang
# distributions — notably Nix's split clang / clang-lib packages — do not
# place these headers where clang looks by default, so we point clang at the
# resource dir explicitly. Also silence printf in secp256k1-zkp-sys, which
# declares printf without including <stdio.h> under wasm32.
if [ -z "${CFLAGS_wasm32_unknown_unknown:-}" ] && command -v clang >/dev/null 2>&1; then
    RESOURCE_DIR="$(clang -print-resource-dir 2>/dev/null || true)"
    if [ -n "$RESOURCE_DIR" ] && [ ! -f "$RESOURCE_DIR/include/stddef.h" ]; then
        # Fallback: scan Nix store for a matching clang-lib package.
        FALLBACK="$(find /nix/store -maxdepth 4 -name stddef.h -path '*/clang/*/include/*' 2>/dev/null | head -n 1 || true)"
        if [ -n "$FALLBACK" ]; then
            RESOURCE_DIR="$(dirname "$(dirname "$FALLBACK")")"
        fi
    fi
    if [ -n "$RESOURCE_DIR" ] && [ -f "$RESOURCE_DIR/include/stddef.h" ]; then
        export CFLAGS_wasm32_unknown_unknown="-isystem $RESOURCE_DIR/include -Dprintf(...)="
        echo "Using clang resource dir: $RESOURCE_DIR"
    fi
fi

echo "Building kormir-wasm ($MODE) -> $OUT_DIR"
cd "$DDK_DIR"
wasm-pack build ./kormir-wasm \
    "$MODE" \
    --target web \
    --out-dir "$OUT_DIR" \
    --out-name kormir_wasm

# Drop wasm-pack's generated package.json; we consume the files via a
# relative path from bitCaster-app/src/lib/kormir.ts, not as an npm package.
rm -f "$OUT_DIR/package.json" "$OUT_DIR/.gitignore" "$OUT_DIR/README.md" "$OUT_DIR/LICENSE"

echo "Done. Generated files:"
ls -la "$OUT_DIR"

# Record source fingerprint so tools/check-kormir-wasm-provenance.sh can verify
# that the bundle matches the current dlcdevkit sources.
git -C "$DDK_DIR" rev-parse HEAD:kormir HEAD:kormir-wasm > "$OUT_DIR/.source-fingerprint"
echo "Source fingerprint written to $OUT_DIR/.source-fingerprint"
