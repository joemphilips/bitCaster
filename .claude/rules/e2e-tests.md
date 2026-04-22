---
paths:
  - "tests/E2E/**/*"
---

# E2E Tests

`tests/E2E/` — **Playwright** (headless Chromium) + **xUnit** runner. Tests assume services are already running; see Local Dev in `../../AGENTS.md`.

## Running

```bash
docker compose run --rm seed      # one-off: inject test data into mintd
dotnet test tests/E2E/            # or: dotnet test (from repo root)
```

Services are polled for health (30s timeout) before tests start; any unreachable service fails with a clear error. `cashu-me` (port 3000) is only needed for `InteropTests.cs`.

## Stack

- `Microsoft.Playwright` 1.57.0
- `xunit` 2.9.3 with `IAsyncLifetime` for async setup/teardown
- Long-running test timeout **120s** (`xunit.runner.json`)
- Each test gets a unique BIP-39 mnemonic via `TestMnemonics.Get()` to avoid "Blinded Message is already signed" collisions

## Port Overrides (parallel worktrees)

All port literals come from `TestPorts` in `tests/E2E/TestHelpers.cs`, read once from env vars at startup:

| Variable                    | Default | Property            |
| --------------------------- | ------- | ------------------- |
| `BITCASTER_E2E_VITE_PORT`   | 5173    | `TestPorts.Vite`    |
| `BITCASTER_E2E_SERVER_PORT` | 5000    | `TestPorts.Server`  |
| `BITCASTER_E2E_MINT_PORT`   | 8085    | `TestPorts.Mint`    |
| `BITCASTER_E2E_CASHU_PORT`  | 3000    | `TestPorts.CashuMe` |
| `BITCASTER_E2E_LNBITS_PORT` | 5002    | `TestPorts.LnBits`  |

Multiple worktree sessions can run E2E in parallel against **one shared docker-compose backend**. Slot `N` maps to vite `5173 + N*100` and engine `5000 + N*100`; mint / cashu-me / lnbits / nostr-relay stay on their docker ports for every slot. Slot allocation is the user's responsibility — a collision is a bind failure.

```bash
# Terminal A — slot 0 (defaults: vite 5173, engine 5000)
./tools/worktree-services.sh --slot 0
dotnet test tests/E2E/ -- RunConfiguration.MaxCpuCount=7

# Terminal B — slot 1 (vite 5273, engine 5100)
./tools/worktree-services.sh --slot 1
dotnet test tests/E2E/ -- RunConfiguration.MaxCpuCount=7
```

`tools/worktree-services.sh` exports `PORT`, `ASPNETCORE_URLS`, `BITCASTER_SERVER_URL` (vite proxy for `/api` and `/hubs`), and the `BITCASTER_E2E_*PORT` vars. Run `dotnet test` in the same shell so exports are inherited.

## Key Files

- `tests/E2E/TestHelpers.cs` — `WaitForService`, `AttachConsoleCapture`, `TestMnemonics`, `TestPorts`
- `tests/E2E/InteropTests.cs` — bidirectional ecash exchange with cashu.me
- `tests/E2E/SettingsPageTests.cs`, `MarketDiscoveryTests.cs`
- `tests/E2E/xunit.runner.json` — long-running test threshold
- `tools/worktree-services.sh` — slot-assigned launcher for engine + vite

## Staging Backend Health Checks

The staging backend (`backend-bitcaster-staging`) is VNet-restricted — **403 from public internet is expected**, not a failure. The App Service SKU does not support `az webapp ssh --command`. Rely on Azure resource status (`az webapp show`) and Application Insights for health verification.

## Writing Tests

- Follow the `IAsyncLifetime` pattern; the `Browser` instance is shared across tests in a class.
- Use `Page.GetByRole()` and other accessibility locators — not CSS selectors.
- Use `TestHelpers.WaitForService` for health checks (don't duplicate).
- Use `TestMnemonics.Get()` for wallet mnemonics.
- **Never hardcode TCP ports.** Always go through `TestPorts.*` — a new `const int VitePort = 5173;` defeats the slot model.
- **Raw IndexedDB access: open without a version.** Dexie (`BitcasterDB` in `src/stores/proof-db.ts`) maps `.version(N)` → IDB version `N*10`. A test that runs `indexedDB.open('bitcaster', 1)` after the app has loaded throws `VersionError` (requested < existing). Open with no version — Dexie has already created the stores.
- **Scope locators when the profile is rehydrated.** Once a persisted nsec rehydrates, the app bar shows the user's displayName, so `GetByText("DisplayName")` resolves to two elements. In settings/profile tests, scope to `GetByRole(AriaRole.Main).GetByText(...)` to avoid strict-mode violations.
- **TradingPanel locators: filter Visible.** `MarketDetail.tsx` renders two TradingPanel copies — mobile (`lg:hidden`) and desktop (`hidden lg:block`). At Playwright's default 1280×720 viewport, the mobile copy is `display: none` but comes first in DOM order, so `.First` selects the hidden element. Use `.Filter(new() { Visible = true }).First` for any TradingPanel button / balance hint / amount input.
