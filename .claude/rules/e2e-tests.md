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

1. `InitializeAsync` polls mint (port 8085), matching engine (port 5000), frontend (port 5173), and cashu.me (port 3000, InteropTests only) until all respond (30-second timeout)
2. Playwright launches headless Chromium and navigates to the frontend
3. Tests use Playwright's locator API (accessibility queries preferred)
4. Each test gets a unique BIP-39 mnemonic via `TestMnemonics.Get()` to avoid "Blinded Message is already signed" collisions
5. `DisposeAsync` closes the Playwright browser — no processes to tear down

## Key Files

- `tests/E2E/BitCaster.E2ETest.csproj` — project file with dependencies
- `tests/E2E/TestHelpers.cs` — shared helpers (`WaitForService`, `AttachConsoleCapture`, `TestMnemonics`)
- `tests/E2E/InteropTests.cs` — bidirectional ecash token exchange between bitCaster and cashu.me
- `tests/E2E/SettingsPageTests.cs` — settings page tests
- `tests/E2E/MarketDiscoveryTests.cs` — market discovery and trading overlay tests
- `tests/E2E/xunit.runner.json` — xUnit config (long-running test threshold)
- `docker-compose.yml` — mintd + cashu-me service definitions (repo root)

## Writing New Tests

- Add test methods to existing test classes or create new ones following the same `IAsyncLifetime` pattern
- Use `Page.GetByRole()` and accessibility-based locators over CSS selectors
- The `Browser` instance is shared across tests in a class via `InitializeAsync`/`DisposeAsync`
- Use `TestHelpers.WaitForService` in `InitializeAsync` for health checks (do not duplicate)
- Use `TestMnemonics.Get()` for wallet mnemonics to avoid collisions across parallel tests
