#!/usr/bin/env bash
#
# Enum-discipline grep gate. Codified by `.claude/skills/bitcaster-coding-guideline/SKILL.md`.
#
# Fails the build when frontend code under `src/` (excluding `generated/`,
# canonical normalisers, and tests) compares a wire-crossing-enum-shaped
# value with a string literal — the anti-pattern that produced the P7
# staging regression `attestation.status !== 'pending'` (false-positive
# Closed for newly-created markets with no attestation yet).
#
# The replacement is a total-mapping exhaustive switch with `assertNever` on
# the default branch (see `lib/enumDiscipline.ts`). Adding a new variant
# upstream then becomes a TypeScript compile error at every consumer instead
# of a silent runtime branch flip.
#
# Scope: only flags the shared-wire enums catalogued in the skill — the
# `MarketCatalogueEntry.state` ('open' | 'closed') and the mintd
# `attestation.status` ('pending' | 'attested' | 'expired' | 'violation').
# Other local string unions (e.g. `PositionStatus = 'active' | 'closed'`) do
# NOT cross the wire and are out of scope here. When a new shared enum is
# added to the OpenAPI spec, append the literals below in the same PR.
#
# This gate is intentionally a grep over filename-bound contexts rather than
# a full ESLint custom rule — the rule needs type information to know which
# variables are typed as `MarketState` / `AttestationStatus` / etc., which
# `eslint-plugin-typescript-rules` does not currently provide here. Type-
# aware enforcement is a fast-follow.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SRC_DIR="${APP_DIR}/src"

# Canonical-normaliser files that legitimately contain literal comparisons
# at the ingress boundary (Rule 2: normalise once, then internal). The grep
# excludes them from the scan.
ALLOWLIST_REGEX='/(generated|__tests__|mintdIngress\.ts|enumDiscipline\.ts)/?'

# Patterns that look like a `attestation.status` or `state` field is being
# compared to a banned literal. Each pattern is tried with `===` and `!==`.
# Whitespace inside the comparison is permitted; lookbehind is not needed
# because the literal anchors the match.
declare -a PATTERNS=(
  # `<X>.state === 'open'` and friends. `<X>` is a simple identifier; this
  # catches the load-bearing detail-page / market-card / catalogue consumers
  # without false-positiving on unrelated code that happens to mention the
  # word "state".
  "\\.state[[:space:]]*(===|!==)[[:space:]]*['\"](open|closed)['\"]"
  # `attestation.status === 'pending'` etc. — the literal P7 regression.
  "attestation\\.status[[:space:]]*(===|!==)[[:space:]]*['\"](pending|attested|expired|violation)['\"]"
  # Generic `<X>.attestationStatus === '…'` for any normalised consumer that
  # forgot to switch.
  "attestationStatus[[:space:]]*(===|!==)[[:space:]]*['\"](pending|attested|expired|violation)['\"]"
  # `<X>.status === 'pending'` / `'attested'` / `'expired'` / `'violation'`.
  # The four mintd-attestation variants are distinctive enough that any
  # `.status` field compared to one of them is almost certainly the
  # attestation field — the load-bearing P7 regression literal.
  "\\.status[[:space:]]*(===|!==)[[:space:]]*['\"](attested|expired|violation)['\"]"
  "\\.status[[:space:]]*(===|!==)[[:space:]]*['\"]pending['\"]"
)

found=0
for pattern in "${PATTERNS[@]}"; do
  while IFS= read -r match; do
    if [[ -z "${match}" ]]; then
      continue
    fi
    if [[ "${match}" =~ ${ALLOWLIST_REGEX} ]]; then
      continue
    fi
    if [[ ${found} -eq 0 ]]; then
      echo "enum-discipline gate: banned string-literal comparisons found." >&2
      echo "Use an exhaustive switch over the generated union with assertNever." >&2
      echo "See .claude/skills/bitcaster-coding-guideline/SKILL.md (Rule 3)." >&2
      echo "" >&2
    fi
    echo "  ${match}" >&2
    found=1
  done < <(grep -RInE "${pattern}" "${SRC_DIR}" \
              --include='*.ts' --include='*.tsx' \
              --exclude-dir='generated' \
              --exclude-dir='__tests__' 2>/dev/null || true)
done

if [[ ${found} -eq 1 ]]; then
  exit 1
fi

echo "enum-discipline gate: clean."
