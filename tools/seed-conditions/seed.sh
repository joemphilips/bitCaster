#!/usr/bin/env bash
set -euo pipefail

# Seed the CDK mint with test prediction markets.
# Pre-computed announcement TLV hex values are generated through the DDK/kormir
# bitcaster_create_enum example so they match the mint's canonical DLC verifier.

MINT_URL="${MINT_URL:-http://mintd:8085}"
MAX_RETRIES=30
RETRY_INTERVAL=2

# Wait for mint to be reachable
echo "Waiting for mint at ${MINT_URL}..."
for i in $(seq 1 "$MAX_RETRIES"); do
  if curl -sf "${MINT_URL}/v1/info" > /dev/null 2>&1; then
    echo "Mint is ready."
    break
  fi
  if [ "$i" -eq "$MAX_RETRIES" ]; then
    echo "ERROR: Mint not reachable after $((MAX_RETRIES * RETRY_INTERVAL))s" >&2
    exit 1
  fi
  sleep "$RETRY_INTERVAL"
done

seed_market() {
  local description="$1"
  local hex_tlv="$2"
  local ticker="$3"
  shift 3
  local outcomes=("$@")

  echo "Seeding: ${description}"

  # Register condition
  local cond_body
  cond_body=$(jq -n \
    --arg desc "$description" \
    --arg tlv "$hex_tlv" \
    --arg ticker "$ticker" \
    '{threshold: 1, tags: [["description", $desc], ["n", $ticker]], announcements: [$tlv], condition_type: "enum", collateral: "sat"}')

  local cond_resp
  cond_resp=$(curl -sf -X POST "${MINT_URL}/v1/conditions" \
    -H "Content-Type: application/json" \
    -d "$cond_body") || {
    echo "  ERROR: Failed to register condition" >&2
    return 1
  }

  local condition_id
  condition_id=$(echo "$cond_resp" | jq -r '.condition_id')
  echo "  condition_id: ${condition_id}"

  echo "  keysets: $(echo "$cond_resp" | jq -c '.keysets')"
}

# Market 1: Will Bitcoin reach $100K before end of 2026?
seed_market \
  'Will Bitcoin reach $100K before end of 2026?' \
  "fdd824a5db7cdfde16d27ffe3485d49ab949bfd8909f441680b5271b205ca66d31c67eeb69b34e45c7812e4eb86379f0c0e5291c01a926bf73f4c19e520784e5facda2134f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aafdd822410001466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f276b49d200fdd80609000203596573024e6f0d6274632d3130306b2d32303236" \
  "BTC" \
  "Yes" "No"

# Market 2: 2026 NBA Championship Winner
seed_market \
  "2026 NBA Championship Winner" \
  "fdd824c39209b64628d118f1d5b71902f84aa7d4489349a70406c3694651053f687b65afc23954e1a6537003db94a495725c9888b9b344949b16c9182257d9a2a97dba3f4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aafdd8225f0001466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f276b49d200fdd806260005064c616b6572730743656c746963730857617272696f7273054275636b73054f746865720e6e62612d6368616d702d32303236" \
  "NBA" \
  "Lakers" "Celtics" "Warriors" "Bucks" "Other"

# Market 3: Fed Q1 2026 Rate Decision
seed_market \
  "Fed Q1 2026 Rate Decision" \
  "fdd824c224ce39545ab8f017263bd877c1ecaa9be081a4f1e5c4d47075cead54080b84b20eba86afedaa02645525280d8e3c520c3db37ce9ba889e9141411f40d12b1e794f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aafdd8225e0001466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f276b49d200fdd8062300040b4375742035302b206270730a4375742032352062707304486f6c640448696b65106665642d726174652d71312d32303236" \
  "FED" \
  "Cut 50+ bps" "Cut 25 bps" "Hold" "Hike"

echo "Seeding complete."
