# Worktree services: slot-collision safety

## Problem

`tools/worktree-services.sh` has no guard against another worktree already
owning the requested slot's ports. Current failure mode when slot N is taken:

1. The dotnet engine tries to `bind(":${SERVER_PORT}")`, gets `EADDRINUSE`,
   and the child dies.
2. Vite starts fine (different port), so the script keeps running and looks
   healthy — the bind error is buried deep in stdout and nothing exits non-zero.
3. Tests launched in the same shell read `BITCASTER_E2E_SERVER_PORT=5100`,
   then talk to the *other* worktree's engine. If that worktree is on older
   code, tests fail with errors that look like bugs in the code under test
   (missing response fields, `KeyNotFoundException`, etc.).
4. A naive `pkill -f worktree-services` or `pkill -f InMemoryMatchingEngine`
   takes down *every* worktree's processes, because the pattern has no slot
   scope.

See the actual-trade PR1 post-mortem in the conversation log for the full
walkthrough.

## Fixes (all in `tools/worktree-services.sh`)

### 1. Pre-flight port check

Before `dotnet run` / `npm run dev`, probe both ports with `ss -ltn`. If either
is busy, abort with a message that names the slot and suggests `--slot N+1`:

```bash
for p in "$SERVER_PORT" "$VITE_PORT"; do
  if ss -ltn "sport = :$p" | grep -q LISTEN; then
    echo "[slot ${SLOT}] port $p is in use — another worktree likely owns this slot." >&2
    echo "Try: $0 --slot $((SLOT + 1))" >&2
    exit 1
  fi
done
```

### 2. Fail-fast on engine bind

Today the script `&`s the engine then immediately `&`s vite. If the engine
dies silently, vite still starts and points at nothing. Wait for
`http://localhost:$SERVER_PORT/health` to return 200 (up to 10s) before
launching vite — or kill vite and `exit 1` if it doesn't.

### 3. Per-slot pidfile + `--stop` subcommand

Write spawned child PIDs to `/tmp/bitcaster-worktree-slot-${SLOT}.pid`. A new
`--stop` mode reads that file so cleanups are scoped to one slot, not every
worktree on the machine.

### 4. Doc note in `.claude/rules/e2e-tests.md`

Add a troubleshooting entry: "If contract tests fail with `KeyNotFoundException`
on a field you just added, run `ss -ltn | grep 51` to confirm the engine on
your slot is yours — a slot collision yields exactly this symptom."

## Scope

All four fixes are small (~20-30 lines total). Land together — splitting buys
nothing since they all touch the same script and rule file.

## Non-goals

- Automatic slot selection. The current manual model is fine; the bug is that
  collisions fail silently, not that they happen.
- Re-architecting the shared docker-compose backend. Out of scope.
