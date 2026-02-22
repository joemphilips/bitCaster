# E2E Tests

End-to-end tests live in `tests/E2E/` and use **Playwright** for browser automation with **.NET Aspire Testing** for service orchestration and **xUnit** as the test runner.

## Running Tests

```bash
# From repo root — runs all tests including E2E
dotnet test

# Run only E2E tests
dotnet test tests/E2E/

# First run is slow (~15 min) because Aspire builds the cdk-mintd Docker image via Nix
```

## Stack

- `Microsoft.Playwright` v1.57.0 — headless Chromium browser automation
- `Aspire.Hosting.Testing` v13.1.1 — spins up the full Aspire app (mint + server + frontend)
- `xunit` v2.9.3 — test framework with `IAsyncLifetime` for async setup/teardown
- Long-running test timeout: **1200 seconds** (configured in `xunit.runner.json`)

## How It Works

1. `DistributedApplicationTestingBuilder` starts the Aspire AppHost (mint, server, frontend)
2. Test setup polls `http://localhost:5173` until the Vite dev server is ready (2-min timeout)
3. Playwright launches headless Chromium and navigates to the frontend
4. Tests use Playwright's locator API (accessibility queries preferred)

## Key Files

- `tests/E2E/BitCaster.E2ETest.csproj` — project file with dependencies
- `tests/E2E/SettingsPageTests.cs` — test class with Aspire + Playwright setup
- `tests/E2E/xunit.runner.json` — xUnit config (long-running test threshold)

## Writing New Tests

- Add test methods to `SettingsPageTests.cs` or create new test classes following the same `IAsyncLifetime` pattern
- Use `Page.GetByRole()` and accessibility-based locators over CSS selectors
- The `Page` and `Browser` instances are shared across tests in a class via `InitializeAsync`/`DisposeAsync`
