# Parallel-Safe E2E Tests Across Worktrees

## Problem

When several Claude Code worktree sessions are running side-by-side on the same
machine, each one wants to run `dotnet test tests/E2E/` against the docker-compose
backend. Today only one can: every test class hardcodes `const int VitePort = 5173;`
(plus `MintPort`, `ServerPort`, `CashuMePort`, `LnBitsPort`), and the matching engine
+ Vite dev server both try to bind the same fixed ports. Two concurrent runs fight
over the same TCP ports and over the same in-process state, even though the heavy
shared services (mintd, cashu-me, lnbits, nostr-relay) would otherwise be safe to
share.

## Goal

Allow N worktrees to run `tests/E2E/` concurrently against **one shared
docker-compose backend** with no flakes, no port collisions, and no test-code
changes beyond per-class port constants. Per-worktree code (`bitCaster-app`,
`BitCaster.InMemoryMatchingEngine`) keeps running locally, on per-worktree ports
chosen by a "slot" number.

Non-goals:

- Changing `docker-compose.yml`. The shared backend stays as-is.
- Changing test logic / assertions / route interception. Only port literals move.
- Touching `BitCaster.MatchingEngine.E2E` (the engine E2E suite runs against
  AppHost, not docker-compose, and is out of scope).
- Fixing any pre-existing flake. This plan is purely about parallelism; if a test
  was flaky before, it stays flaky after.

## What's already safe (audit results)

After reading every file in `bitCaster/tests/E2E/`:

- **Per-test browser contexts.** Every test calls `_browser.NewContextAsync(...)`,
  so localStorage / IndexedDB / cookies are isolated per test, even within one
  process.
- **Random mnemonics per test.** `TestMnemonics.Get()` (`tests/E2E/TestHelpers.cs:16`)
  returns a fresh BIP-39 each call, so the mint never sees a reused blinding factor.
  This is the existing fix for "Blinded Message is already signed".
- **Conflict-tolerant market creation.** The two tests that POST to
  `/api/v1/markets/{conditionId}` accept `200 || 409`:
  - `tests/E2E/MarketCreationTests.cs:481-483` (`NewlyCreatedMarketVisibleToBothUsers`)
  - `tests/E2E/PaymentEndpointTests.cs:67-69` (`CreatePaymentRequest_AndSimulatePayment_Succeeds`)
- **Engine E2E uses unique IDs.** `BitCaster.MatchingEngine.E2E/Tests/OrderBookApiTests.cs:14`
  already uses `$"test-market-{Guid.NewGuid():N}"`. (Not in scope but mentioned for
  completeness.)
- **InMemoryMatchingEngine state is per-process.** `MarketEndpoints.Markets`,
  `LiquidityEndpoints.Pools`, `ThumbnailEndpoints.Thumbnails`, and
  `LnBitsWalletManager._wallets` are all in-memory dictionaries scoped to the
  running process. Each worktree gets its own engine process, so cross-worktree
  pollution is impossible by construction.
- **LNBits wallet creation is gated.** `BitCaster.InMemoryMatchingEngine/Endpoints/MarketEndpoints.cs:133`
  only creates wallets if `Markets.TryAdd` succeeds, so even within one engine
  process two parallel POSTs for the same conditionId only create one wallet.
- **Cross-worktree LNBits.** Two engines ask LNBits to create accounts named
  e.g. `<cid>-Yes`. LNBits returns two distinct wallet IDs; each engine remembers
  its own. Top-ups and pays target a specific `wallet.Id`, so they never cross.

## Real blockers (what this plan fixes)

1. **Hardcoded TCP ports.** 98 occurrences across 8 test files of literal `5173 /
   8085 / 5000 / 3000 / 5002`. Two worktrees can't both bind 5173 / 5000.
2. **No slot allocation** for the per-worktree engine + Vite dev server.
3. **Vite proxy hardcodes `http://localhost:5000`.** `bitCaster-app/vite.config.ts:79-87`
   sends `/api` and `/hubs` to a fixed engine URL. A worktree on engine port 5100
   currently has no way to override that without editing the file.

That's it. Everything else is already isolated.

## Design

### Slot model

Each worktree picks a slot index (0, 1, 2, ...). The slot maps deterministically
to a port pair:

| Slot | Vite (`PORT`) | Engine (`ASPNETCORE_URLS`) |
|-----:|--------------:|---------------------------:|
|    0 |          5173 |                       5000 |
|    1 |          5273 |                       5100 |
|    2 |          5373 |                       5200 |
|    N | 5173 + N\*100 |              5000 + N\*100 |

Slot 0 is the existing single-worktree default — zero behavior change for the
current workflow.

Mint / cashu-me / lnbits / nostr-relay stay at their docker-compose ports
(8085 / 3000 / 5002 / 7777) for every slot, because docker-compose only binds them
once.

### Environment-variable contract

Both the launched services and the test process read the same env vars. Defaults
preserve current behavior:

| Variable                       | Default | Read by                          |
| ------------------------------ | ------- | -------------------------------- |
| `BITCASTER_E2E_VITE_PORT`      | 5173    | tests                            |
| `BITCASTER_E2E_SERVER_PORT`    | 5000    | tests                            |
| `BITCASTER_E2E_MINT_PORT`      | 8085    | tests                            |
| `BITCASTER_E2E_CASHU_PORT`     | 3000    | tests                            |
| `BITCASTER_E2E_LNBITS_PORT`    | 5002    | tests                            |
| `PORT`                         | 5173    | `vite.config.ts` (already wired) |
| `ASPNETCORE_URLS`              | (none)  | `BitCaster.InMemoryMatchingEngine` (built-in) |
| `BITCASTER_SERVER_URL`         | (none)  | `vite.config.ts` (new override)  |

### Code changes

#### Change 1 — `tests/E2E/TestHelpers.cs`: add `TestPorts`

Append a small static class that resolves env vars once at startup:

```csharp
public static class TestPorts
{
    public static readonly int Vite    = GetInt("BITCASTER_E2E_VITE_PORT",   5173);
    public static readonly int Mint    = GetInt("BITCASTER_E2E_MINT_PORT",   8085);
    public static readonly int Server  = GetInt("BITCASTER_E2E_SERVER_PORT", 5000);
    public static readonly int CashuMe = GetInt("BITCASTER_E2E_CASHU_PORT",  3000);
    public static readonly int LnBits  = GetInt("BITCASTER_E2E_LNBITS_PORT", 5002);

    private static int GetInt(string name, int @default) =>
        int.TryParse(Environment.GetEnvironmentVariable(name), out var v) ? v : @default;
}
```

Static fields, not properties — env vars are read once per test process, which
matches their semantics (a single `dotnet test` invocation has one slot).

#### Change 2 — replace per-class port constants

Across `tests/E2E/`:

- `MarketCreationTests.cs`
- `MarketDiscoveryTests.cs`
- `MarketMetadataDisplayTests.cs`
- `DepositWithdrawTests.cs`
- `WalletSetupTests.cs`
- `SettingsPageTests.cs`
- `InteropTests.cs`
- `PaymentEndpointTests.cs`

Delete the `private const int VitePort = 5173;` (and `MintPort` / `ServerPort` /
`CashuMePort` / `LnBitsPort`) declarations and replace every reference with
`TestPorts.Vite` / `TestPorts.Mint` / etc. `TestHelpers.SetupComplete` already
takes a `vitePort` parameter — keep that signature, callers just pass
`TestPorts.Vite`.

This is mechanical, low-risk, and grep-able. Defaults preserve current behavior:
running `dotnet test` with no env vars set behaves identically to today.

#### Change 3 — `bitCaster-app/vite.config.ts`: `BITCASTER_SERVER_URL` override

Currently `vite.config.ts:74-87`:

```ts
"/api":  { target: process.env.services__apiservice__http__0 ?? "http://localhost:5000", ... },
"/hubs": { target: "http://localhost:5000", ... },
```

Add a single resolved variable that takes precedence over the existing fallbacks:

```ts
const serverTarget =
  process.env.BITCASTER_SERVER_URL
  ?? process.env.services__apiservice__http__0
  ?? "http://localhost:5000";
```

Use `serverTarget` for both `/api` and `/hubs`. The Aspire fallback stays in place
so the AppHost workflow is unchanged. `PORT` is already supported on line 70.

#### Change 4 — `tools/worktree-services.sh`

Thin shell wrapper. Inputs: `--slot N` (or `WORKTREE_SLOT` env var). Computes
ports, exports env vars, exec's the engine and Vite, and cleans up children on
exit.

```bash
#!/usr/bin/env bash
set -euo pipefail

SLOT="${WORKTREE_SLOT:-0}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --slot) SLOT="$2"; shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done

VITE_PORT=$((5173 + SLOT * 100))
SERVER_PORT=$((5000 + SLOT * 100))

export PORT="$VITE_PORT"
export ASPNETCORE_URLS="http://+:${SERVER_PORT}"
export BITCASTER_SERVER_URL="http://localhost:${SERVER_PORT}"

# These are read by the test process when the user later runs `dotnet test`
# in the same shell.
export BITCASTER_E2E_VITE_PORT="$VITE_PORT"
export BITCASTER_E2E_SERVER_PORT="$SERVER_PORT"

cleanup() { jobs -p | xargs -r kill 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "[slot $SLOT] starting matching engine on :${SERVER_PORT}"
dotnet run --project BitCaster.InMemoryMatchingEngine &

echo "[slot $SLOT] starting vite on :${VITE_PORT}"
( cd bitCaster-app && npm run dev ) &

# Wait for both children. Failure of either triggers cleanup via trap.
wait
```

The script intentionally does not start docker-compose — that's the user's
responsibility, and is shared across all slots.

After it exits (Ctrl-C), the user runs tests in the same shell so the
`BITCASTER_E2E_*` exports are inherited:

```bash
dotnet test tests/E2E/ -- RunConfiguration.MaxCpuCount=7
```

Or, if they prefer a clean separation, they can `source tools/worktree-services.sh
--slot 1` style — but the simpler "run-then-test in the same shell" pattern
matches existing dev habits.

#### Change 5 — documentation

Two doc touchpoints, each with a different audience:

**a) `AGENTS.md` — top-level dev workflow.** Add a short subsection under "Local
Dev" titled "Running multiple worktrees in parallel" that:

1. Names the slot model (slot 0 = current default).
2. Shows the two-worktree example: terminal A on slot 0, terminal B on slot 1,
   both pointing at one `docker compose up`.
3. Points to `tools/worktree-services.sh` and to `.claude/rules/e2e-tests.md`
   for the test-side contract.

Three sentences plus a code block. Keep it brief — the script is the API.

**b) `.claude/rules/e2e-tests.md` — E2E-specific rules.** This file has
`paths: tests/E2E/**/*` in its frontmatter, so Claude auto-loads it whenever
it touches a test file. Update it to:

1. Replace the hardcoded "port 8085 / 5000 / 5173 / 3000" references in the
   "How It Works" section with `TestPorts.*` (and cite the env-var names).
2. Add a "Running in parallel across worktrees" subsection that mirrors the
   AGENTS.md block but scoped to the test runner (slot model, env var
   contract, a one-liner for running `dotnet test tests/E2E/` in a slotted
   shell).
3. Add a bullet to "Writing New Tests" that says: **never introduce new
   hardcoded ports; always go through `TestPorts`**.

Both files must be updated in the same commit as the code change so future
agents and humans can't miss the slot contract.

## Files to Change

- `bitCaster/tests/E2E/TestHelpers.cs` — add `TestPorts` class.
- `bitCaster/tests/E2E/MarketCreationTests.cs`
- `bitCaster/tests/E2E/MarketDiscoveryTests.cs`
- `bitCaster/tests/E2E/MarketMetadataDisplayTests.cs`
- `bitCaster/tests/E2E/DepositWithdrawTests.cs`
- `bitCaster/tests/E2E/WalletSetupTests.cs`
- `bitCaster/tests/E2E/SettingsPageTests.cs`
- `bitCaster/tests/E2E/InteropTests.cs`
- `bitCaster/tests/E2E/PaymentEndpointTests.cs`
- `bitCaster/bitCaster-app/vite.config.ts` — add `BITCASTER_SERVER_URL` override.
- `bitCaster/tools/worktree-services.sh` — new helper script (executable).
- `bitCaster/AGENTS.md` — new "Running multiple worktrees in parallel" subsection
  under "Local Dev".
- `bitCaster/.claude/rules/e2e-tests.md` — swap hardcoded port references for
  `TestPorts.*` + env var names, add a "Running in parallel across worktrees"
  subsection, add a "never hardcode ports" bullet under "Writing New Tests".
  Rules file has `paths: tests/E2E/**/*` so it auto-loads whenever Claude
  edits a test file, making it the right place for the slot contract.

No new test packages. No `docker-compose.yml` changes. No `BitCaster.InMemoryMatchingEngine`
code changes (it already honors `ASPNETCORE_URLS`). No new test infrastructure.

## Verification Plan

### V1. Single-worktree regression (defaults unchanged)

The most important check: prove the no-env-vars-set path still works exactly like
today.

```bash
cd bitCaster
docker compose up -d mintd seed cashu-me lnbits-init nostr-relay
dotnet run --project BitCaster.InMemoryMatchingEngine &
( cd bitCaster-app && npm run dev ) &
# wait for :5173 and :5000
dotnet test tests/E2E/ -- RunConfiguration.MaxCpuCount=7
```

Acceptance: same pass count as before this change. No env vars set.

### V2. Two-worktree concurrent run

From two worktrees against the same shared docker-compose:

```bash
# Terminal A — worktree A
cd <worktree-A>/bitCaster
./tools/worktree-services.sh --slot 0   # vite:5173 + engine:5000
# (in the same shell after Ctrl-C, or in a sibling shell with the same env)
dotnet test tests/E2E/ -- RunConfiguration.MaxCpuCount=4
```

```bash
# Terminal B — worktree B
cd <worktree-B>/bitCaster
./tools/worktree-services.sh --slot 1   # vite:5273 + engine:5100
dotnet test tests/E2E/ -- RunConfiguration.MaxCpuCount=4
```

Acceptance: both `dotnet test` invocations finish green at the same time. Run
the experiment twice with start order swapped to confirm there's no first-mover
advantage.

### V3. Stress run on shared-backend hot paths

While V2 is in flight, in a third terminal on slot 2 hammer the tests that touch
the shared backend most:

```bash
./tools/worktree-services.sh --slot 2 &
for i in $(seq 1 5); do
  dotnet test tests/E2E/ \
    --filter "FullyQualifiedName~InteropTests|FullyQualifiedName~PaymentEndpointTests|FullyQualifiedName~MarketCreationTests" \
    -- RunConfiguration.MaxCpuCount=4 || { echo "FAIL on iter $i"; break; }
done
```

This validates LNBits wallet creation under contention, mint condition reuse,
and cashu.me cross-context isolation.

### V4. Negative checks

After V2/V3:

- `docker compose logs lnbits | grep -i "first_install\|409\|conflict"` — no auth
  conflicts, no unexpected duplicates.
- `docker compose logs mintd | grep -i "blinded message"` — no double-sign errors.
- Each worktree's matching engine log contains its own `Created LNBits wallet`
  lines and they don't reference each other's wallet IDs.
- `lsof -i :5173 -i :5000 -i :5273 -i :5100` shows the expected one-process-per-port
  binding.

### V5. CI smoke

CI uses slot 0 implicitly (no env vars set). Push the branch, open a draft PR,
confirm CI is green. CI is a single-worktree run, so this is really a regression
check on Change 1 + Change 2 + Change 3.

## Risks

- **`BITCASTER_E2E_*` env vars leak between shells.** Users who set them in
  `~/.bashrc` or who source the helper script and forget will run "default"
  workflows on a non-default slot. Mitigation: the helper script `export`s only
  in its own subshell when invoked normally; document the contract in AGENTS.md;
  the variable names are namespaced.
- **The Aspire fallback `services__apiservice__http__0` could be set to an
  unexpected value if the user runs Aspire AppHost in the same shell.** The new
  precedence (`BITCASTER_SERVER_URL` first) avoids this for the worktree flow;
  the AppHost flow is unchanged when `BITCASTER_SERVER_URL` is not set.
- **Vite dev server warm-up time scales with worktree count.** Three concurrent
  Vite instances each compile their own dependency graph. CPU spike but
  functionally fine; don't preempt with `nice`.
- **Slot collisions.** If two users on the same machine both pick slot 1, they
  collide on 5273 / 5100 and one will fail to bind. Acceptable: slot allocation
  is the user's responsibility. A future iteration could write a lock file under
  `/tmp/bitcaster-slot-N.lock` but that's overkill for now.
- **`tools/build-kormir-wasm.sh` outputs.** The frontend's `kormir-wasm-pkg/`
  is a checked-in artifact (per `bitCaster/AGENTS.md`); each worktree picks it
  up from its own checkout and there's no shared cache. No interaction with
  this plan.

## Not Doing (and Why)

- **Auto-detect slot from working directory hash.** Tempting (no `--slot` flag
  needed) but produces collisions that are hard to debug, and means
  `lsof` output doesn't tell you which slot a process belongs to. Explicit
  `--slot N` is honest.
- **Move shared services into per-worktree compose stacks.** Would force a full
  mintd / lnbits / cashu-me boot per worktree (~30 s + RAM). The whole point of
  the user's request was to share these.
- **Migrate `MarketCreationTests.NewlyCreatedMarketVisibleToBothUsers` to use a
  unique conditionId.** It already tolerates 409 and the per-context route
  interception keeps the assertion correct. Changing it would mean inventing
  fake conditions in the mint, which is more work than the parallel-safety win
  is worth.
- **Add a `Collection` attribute to xUnit test classes for tighter parallelism
  control.** Defaults already parallelize across classes within a process; per
  worktree is the dimension we care about. Not needed.
- **Touch `BitCaster.MatchingEngine.E2E`.** Out of scope — that suite uses
  AppHost, not docker-compose, and the prompt is specifically about the
  docker-compose-backed `tests/E2E/` suite.
