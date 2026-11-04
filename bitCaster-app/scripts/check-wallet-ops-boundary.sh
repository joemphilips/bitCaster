#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

command -v rg >/dev/null || { echo "wallet-ops boundary gate: ripgrep is required." >&2; exit 2; }

fail=0

if matches=$(rg -n '(s\.|\.)(_?(addMint|addMintWithoutActivating|removeMint|setActiveMint))\s*\(' src \
  --glob '!src/stores/wallet.ts' \
  --glob '!src/lib/walletOps.ts' \
  --glob '!**/__tests__/**'); then
  echo "wallet-ops boundary violation: raw wallet store mutators must go through src/lib/walletOps.ts"
  echo "$matches"
  fail=1
else
  status=$?
  if [[ "$status" -ne 1 ]]; then
    echo "wallet-ops boundary gate: source search failed (status $status)." >&2
    exit "$status"
  fi
fi

if matches=$(rg -n '\b(decodeToken|receiveToken|ensureMintRegistered)\b' src \
  --glob '!src/lib/cashu.ts' \
  --glob '!src/lib/walletOps.ts' \
  --glob '!**/__tests__/**'); then
  echo "wallet-ops boundary violation: ingress token helpers must go through src/lib/walletOps.ts"
  echo "$matches"
  fail=1
else
  status=$?
  if [[ "$status" -ne 1 ]]; then
    echo "wallet-ops boundary gate: source search failed (status $status)." >&2
    exit "$status"
  fi
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi

echo "wallet-ops boundary gate: clean."
