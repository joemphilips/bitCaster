#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if matches=$(rg -n '\b(loginWithExtension|loginWithNsecOrNcryptsec|fetchAndStoreNostrProfile|rehydrateNostrSigner)\b' src \
  --glob '!src/lib/identityOps.ts' \
  --glob '!src/lib/nostr.ts' \
  --glob '!**/__tests__/**'); then
  echo "identity-ops boundary violation: signer/profile session operations must go through src/lib/identityOps.ts"
  echo "$matches"
  exit 1
fi

echo "identity-ops boundary gate: clean."
