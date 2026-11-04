#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

command -v rg >/dev/null || { echo "identity-ops boundary gate: ripgrep is required." >&2; exit 2; }

if matches=$(rg -n '\b(loginWithExtension|loginWithNsecOrNcryptsec|fetchAndStoreNostrProfile|rehydrateNostrSigner)\b' src \
  --glob '!src/lib/identityOps.ts' \
  --glob '!src/lib/nostr.ts' \
  --glob '!**/__tests__/**'); then
  echo "identity-ops boundary violation: signer/profile session operations must go through src/lib/identityOps.ts"
  echo "$matches"
  exit 1
else
  status=$?
  if [[ "$status" -ne 1 ]]; then
    echo "identity-ops boundary gate: source search failed (status $status)." >&2
    exit "$status"
  fi
fi

echo "identity-ops boundary gate: clean."
