#!/usr/bin/env bash
set -euo pipefail

# Seed the CDK mint with test prediction markets.
# Pre-computed announcement TLV hex values are deterministic (hardcoded oracle keys,
# deterministic Schnorr signing) — see the original Rust source for derivation.

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
    '{threshold: 1, tags: [["description", $desc], ["n", $ticker]], announcements: [$tlv], condition_type: "enum"}')

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

  # Build partition array
  local partition_json
  partition_json=$(printf '%s\n' "${outcomes[@]}" | jq -R . | jq -s .)

  local part_body
  part_body=$(jq -n \
    --argjson partition "$partition_json" \
    '{collateral: "sat", partition: $partition, parent_collection_id: "0000000000000000000000000000000000000000000000000000000000000000"}')

  local part_resp
  part_resp=$(curl -sf -X POST "${MINT_URL}/v1/conditions/${condition_id}/partitions" \
    -H "Content-Type: application/json" \
    -d "$part_body") || {
    echo "  ERROR: Failed to register partition" >&2
    return 1
  }

  echo "  keysets: $(echo "$part_resp" | jq -c '.keysets')"
}

# Market 1: Will Bitcoin reach $100K before end of 2026?
seed_market \
  'Will Bitcoin reach $100K before end of 2026?' \
  "fdd824a59af215b155a4111437b4243980150796b6df7650da780484eca325c7babb478fd273fedfe41165a93b0c5d11677ba0b2c35cfd100896200d94190a9f10d681874f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aafdd822410001466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27000f4240fdd80609000203596573024e6f0d6274632d3130306b2d32303236" \
  "BTC" \
  "Yes" "No"

# Market 2: 2026 NBA Championship Winner
seed_market \
  "2026 NBA Championship Winner" \
  "fdd824c386e462cc53a396eb38a700872870882325db3e197bb8a864604866e1c9b19d4acf8f47febc7994419590fd56599ea4eb31c98f3925caf6f0382c5b4e629de0634f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aafdd8225f0001466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27000f4240fdd806260005064c616b6572730743656c746963730857617272696f7273054275636b73054f746865720e6e62612d6368616d702d32303236" \
  "NBA" \
  "Lakers" "Celtics" "Warriors" "Bucks" "Other"

# Market 3: Fed Q1 2026 Rate Decision
seed_market \
  "Fed Q1 2026 Rate Decision" \
  "fdd824c2f373b2356110fcc66b6f5106e0c437252dac6dbe8ee272ae3b6adcdf71d6ff60718ceeb7944920aae5e196167a3e4eaf73b58d28246bb54ee0258ce87ae1b5f44f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aafdd8225e0001466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27000f4240fdd8062300040b4375742035302b206270730a4375742032352062707304486f6c640448696b65106665642d726174652d71312d32303236" \
  "FED" \
  "Cut 50+ bps" "Cut 25 bps" "Hold" "Hike"

echo "Seeding complete."
