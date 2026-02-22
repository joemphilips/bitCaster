---
paths:
  - "tests/E2E/**/*"
---

# E2E Tests

End-to-end tests live in `tests/E2E/` and use **Playwright** for browser automation with **docker-compose** for service orchestration and **xUnit** as the test runner.

## Running Tests

```bash
# From repo root — runs all tests including E2E
dotnet test

# Run only E2E tests
dotnet test tests/E2E/

# First run is slow (~15 min) because Docker builds the cdk-mintd image via Nix
```

## Stack

- `Microsoft.Playwright` v1.57.0 — headless Chromium browser automation
- `docker-compose` — starts the mintd container (with healthcheck)
- `xunit` v2.9.3 — test framework with `IAsyncLifetime` for async setup/teardown
- Long-running test timeout: **1200 seconds** (configured in `xunit.runner.json`)

## How It Works

1. Test setup runs `docker compose up -d mintd` and polls `http://localhost:8085/v1/info` until healthy (15-min timeout for first build)
2. `dotnet run` launches BitCaster.Server as a child process on port 5000
3. `npx vite` launches the frontend dev server on port 5173
4. Playwright launches headless Chromium and navigates to the frontend
5. Tests use Playwright's locator API (accessibility queries preferred)
6. Teardown kills child processes and runs `docker compose down`

## Key Files

- `tests/E2E/BitCaster.E2ETest.csproj` — project file with dependencies
- `tests/E2E/SettingsPageTests.cs` — test class with docker-compose + Playwright setup
- `tests/E2E/xunit.runner.json` — xUnit config (long-running test threshold)
- `docker-compose.yml` — mintd service definition (repo root)

## Writing New Tests

- Add test methods to `SettingsPageTests.cs` or create new test classes following the same `IAsyncLifetime` pattern
- Use `Page.GetByRole()` and accessibility-based locators over CSS selectors
- The `Page` and `Browser` instances are shared across tests in a class via `InitializeAsync`/`DisposeAsync`
