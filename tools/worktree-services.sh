#!/usr/bin/env bash
# Launch the per-worktree Vite dev server on a slot-assigned port so multiple
# worktrees can run against the same shared docker-compose backend.
#
# Slot model (see bitCaster/plans/parallel-e2e-worktrees.md):
#
#   Slot 0 (default) -> vite 5273
#   Slot 1            -> vite 5373
#   Slot N            -> vite 5273 + N*100
#
# Docker-compose services (mintd, cashu-me, lnbits, nostr-relay, seed) are
# shared across all slots and NOT started by this script — run
# `docker compose up -d` separately.
#
# Usage:
#   ./tools/worktree-services.sh               # slot 0 (or $WORKTREE_SLOT)
#   ./tools/worktree-services.sh --slot 1
#   WORKTREE_SLOT=2 ./tools/worktree-services.sh
#
# After Ctrl-C, the exported port env var remains in the shell. For a clean
# shell, `source` this script instead of executing it.

set -euo pipefail

SLOT="${WORKTREE_SLOT:-0}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --slot)
      SLOT="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,25p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if ! [[ "$SLOT" =~ ^[0-9]+$ ]]; then
  echo "slot must be a non-negative integer, got: $SLOT" >&2
  exit 2
fi

VITE_PORT=$((5273 + SLOT * 100))

# Ports consumed by the services launched here.
export PORT="$VITE_PORT"

# Resolve repo root so the script works regardless of caller CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "[slot ${SLOT}] vite=${VITE_PORT}"
echo "[slot ${SLOT}] docker-compose backend is shared — start separately with 'docker compose up -d'"

cleanup() {
  # Kill child jobs started from this shell. `|| true` keeps set -e happy on
  # an already-exited child.
  local pids
  pids=$(jobs -p || true)
  if [[ -n "$pids" ]]; then
    kill $pids 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "[slot ${SLOT}] starting vite dev server on :${VITE_PORT}"
(
  cd "${REPO_ROOT}/bitCaster-app"
  npm run dev
) &

# Wait on the child. On exit, cleanup() kills any remaining child via trap.
wait
