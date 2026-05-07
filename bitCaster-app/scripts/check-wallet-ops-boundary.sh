#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail=0

if matches=$(rg -n '(s\.|\.)((addMint|addMintWithoutActivating|removeMint|setActiveMint))\s*\(' src \
  --glob '!src/stores/wallet.ts' \
  --glob '!src/lib/walletOps.ts' \
  --glob '!**/__tests__/**'); then
  echo "wallet-ops boundary violation: raw wallet store mutators must go through src/lib/walletOps.ts"
  echo "$matches"
  fail=1
fi

if matches=$(rg -n '\b(decodeToken|receiveToken|ensureMintRegistered)\b' src \
  --glob '!src/lib/cashu.ts' \
  --glob '!src/lib/walletOps.ts' \
  --glob '!**/__tests__/**'); then
  echo "wallet-ops boundary violation: ingress token helpers must go through src/lib/walletOps.ts"
  echo "$matches"
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi

echo "wallet-ops boundary gate: clean."
