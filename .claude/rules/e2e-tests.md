---
paths:
  - "tests/E2E/**/*"
---

# E2E Tests

End-to-end tests live in `tests/E2E/` and use **Playwright** for browser automation and **xUnit** as the test runner. Tests assume all services are already running externally.

## Prerequisites

Start all services before running tests (3 terminals + seed):

```bash
# Terminal 1: Start mint and cashu.me (cashu.me is required for InteropTests)
docker compose up mintd cashu-me

# Terminal 2: Start in-memory matching engine
cd BitCaster.InMemoryMatchingEngine && dotnet run

# Terminal 3: Start frontend
cd bitCaster-app && npm install && npm run dev

# One-off: Seed test data into the mint
docker compose run --rm seed
```

> **Note:** `cashu-me` (port 3000) is required for `InteropTests.cs`. Other tests do not need it.

## Running Tests

```bash
# From repo root — runs all tests including E2E
dotnet test

# Run only E2E tests
dotnet test tests/E2E/
```

Tests will poll for service availability (30-second timeout) and fail with a clear error message if any service is unreachable.

## Stack

- `Microsoft.Playwright` v1.57.0 — headless Chromium browser automation
- `xunit` v2.9.3 — test framework with `IAsyncLifetime` for async setup/teardown
- Long-running test timeout: **120 seconds** (configured in `xunit.runner.json`)

## How It Works

1. `InitializeAsync` polls mint (`TestPorts.Mint`, default 8085), matching engine (`TestPorts.Server`, default 5000), frontend (`TestPorts.Vite`, default 5173), and cashu.me (`TestPorts.CashuMe`, default 3000, InteropTests only) until all respond (30-second timeout)
2. Playwright launches headless Chromium and navigates to the frontend
3. Tests use Playwright's locator API (accessibility queries preferred)
4. Each test gets a unique BIP-39 mnemonic via `TestMnemonics.Get()` to avoid "Blinded Message is already signed" collisions
5. `DisposeAsync` closes the Playwright browser — no processes to tear down

All port literals come from `TestPorts` in `tests/E2E/TestHelpers.cs`. It reads these env vars once at startup, falling back to the single-worktree defaults:

| Variable                    | Default | Property            |
| --------------------------- | ------- | ------------------- |
| `BITCASTER_E2E_VITE_PORT`   | 5173    | `TestPorts.Vite`    |
| `BITCASTER_E2E_SERVER_PORT` | 5000    | `TestPorts.Server`  |
| `BITCASTER_E2E_MINT_PORT`   | 8085    | `TestPorts.Mint`    |
| `BITCASTER_E2E_CASHU_PORT`  | 3000    | `TestPorts.CashuMe` |
| `BITCASTER_E2E_LNBITS_PORT` | 5002    | `TestPorts.LnBits`  |

## Running in parallel across worktrees

Multiple worktree sessions can run `dotnet test tests/E2E/` simultaneously against **one shared docker-compose backend**. Each worktree picks a slot number; slot `N` maps to vite `5173 + N*100` and engine `5000 + N*100`. Mint / cashu-me / lnbits / nostr-relay stay on their docker-compose ports for every slot.

```bash
# Terminal A — slot 0 (defaults: vite 5173, engine 5000)
./tools/worktree-services.sh --slot 0
dotnet test tests/E2E/ -- RunConfiguration.MaxCpuCount=7

# Terminal B — slot 1 (vite 5273, engine 5100)
./tools/worktree-services.sh --slot 1
dotnet test tests/E2E/ -- RunConfiguration.MaxCpuCount=7
```

`tools/worktree-services.sh` exports `PORT` and `ASPNETCORE_URLS` for the launched services, `BITCASTER_SERVER_URL` for the vite proxy (`/api` and `/hubs`), and the `BITCASTER_E2E_*PORT` vars above for the test process. Run `dotnet test` in the same shell so the exports are inherited. See `plans/parallel-e2e-worktrees.md` for the full slot contract and audit results.

## Key Files

- `tests/E2E/BitCaster.E2ETest.csproj` — project file with dependencies
- `tests/E2E/TestHelpers.cs` — shared helpers (`WaitForService`, `AttachConsoleCapture`, `TestMnemonics`, `TestPorts`)
- `tests/E2E/InteropTests.cs` — bidirectional ecash token exchange between bitCaster and cashu.me
- `tests/E2E/SettingsPageTests.cs` — settings page tests
- `tests/E2E/MarketDiscoveryTests.cs` — market discovery and trading overlay tests
- `tests/E2E/xunit.runner.json` — xUnit config (long-running test threshold)
- `docker-compose.yml` — mintd + cashu-me service definitions (repo root)
- `tools/worktree-services.sh` — slot-assigned launcher for engine + vite

## Writing New Tests

- Add test methods to existing test classes or create new ones following the same `IAsyncLifetime` pattern
- Use `Page.GetByRole()` and accessibility-based locators over CSS selectors
- The `Browser` instance is shared across tests in a class via `InitializeAsync`/`DisposeAsync`
- Use `TestHelpers.WaitForService` in `InitializeAsync` for health checks (do not duplicate)
- Use `TestMnemonics.Get()` for wallet mnemonics to avoid collisions across parallel tests
- **Never hardcode TCP ports.** Always go through `TestPorts.*` so parallel worktree runners can override them via the `BITCASTER_E2E_*PORT` env vars. New `const int VitePort = 5173;` style declarations defeat the slot model.
