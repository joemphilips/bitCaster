using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Playwright;

namespace BitCaster.E2ETest;

/// <summary>
/// PR1 coverage for the order-submission flow on the market detail page.
///
/// Scope is limited to the wallet-required / balance-gate / happy-path
/// branches — notification UI, trade detail page, and atomic-swap execution
/// land in later PRs.
/// </summary>
public class TradingFlowTests : IAsyncLifetime
{
    private IPlaywright? _playwright;
    private IBrowser? _browser;

    public async Task InitializeAsync()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        await Task.WhenAll(
            TestHelpers.WaitForService(httpClient, $"http://localhost:{TestPorts.Mint}/v1/info", "Mint"),
            TestHelpers.WaitForService(httpClient, $"http://localhost:{TestPorts.Server}/health", "Matching Engine"),
            TestHelpers.WaitForService(httpClient, $"http://localhost:{TestPorts.Vite}", "Frontend"));

        _playwright = await Playwright.CreateAsync();
        _browser = await _playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
        {
            Headless = true,
        });
    }

    private async Task<IBrowserContext> NewIsolatedContextAsync()
    {
        Assert.NotNull(_browser);
        return await _browser.NewContextAsync(new BrowserNewContextOptions
        {
            ServiceWorkers = ServiceWorkerPolicy.Block,
        });
    }

    /// <summary>
    /// Seed the wallet store and point it at the real mint port so balance
    /// queries resolve against proofs we inject below.
    /// </summary>
    private static Task SetupWalletAsync(IPage page) =>
        TestHelpers.SetupComplete(page, TestPorts.Vite, $"http://localhost:{TestPorts.Mint}");

    /// <summary>
    /// Inject a single proof directly into the IndexedDB store so
    /// <c>getBalance(activeMintUrl)</c> returns the requested amount without
    /// running the real mint flow. Must be called after navigation so the DB
    /// exists for the current origin.
    /// </summary>
    private static async Task SeedBalanceAsync(IPage page, int sats)
    {
        var mintUrl = $"http://localhost:{TestPorts.Mint}";
        // Raw IDB write — we open without a version so we attach to whatever
        // schema Dexie has already materialized. But in CI, Dexie's lazy open
        // can still be in flight when we arrive here (useBalance() mounts,
        // kicks off Dexie.open, but the schema upgrade is async). If we open
        // first, IDB gives us a fresh DB at version 1 with NO `proofs` store,
        // the put throws, and the test sees 0 sats. So we poll the schema
        // until the `proofs` store exists before writing, and read the count
        // back afterwards so a silent failure surfaces as a clear error
        // rather than a generic "text not visible" timeout.
        var count = await page.EvaluateAsync<int>($@"
            async () => {{
                const openWithPoll = async () => {{
                    const deadline = Date.now() + 10_000;
                    while (Date.now() < deadline) {{
                        const req = indexedDB.open('bitcaster');
                        const db = await new Promise((resolve, reject) => {{
                            req.onsuccess = () => resolve(req.result);
                            req.onerror = () => reject(req.error);
                            req.onupgradeneeded = () => {{}};
                        }});
                        if (db.objectStoreNames.contains('proofs')) return db;
                        db.close();
                        await new Promise(r => setTimeout(r, 50));
                    }}
                    throw new Error('Dexie did not materialize `proofs` store within 10s');
                }};
                const db = await openWithPoll();
                const writeTx = db.transaction('proofs', 'readwrite');
                writeTx.objectStore('proofs').put({{
                    secret: 'e2e-seed-' + Date.now(),
                    id: 'keyset-00',
                    C: '02' + '00'.repeat(32),
                    amount: {sats},
                    mintUrl: '{mintUrl}',
                }});
                await new Promise((resolve, reject) => {{
                    writeTx.oncomplete = () => resolve();
                    writeTx.onerror = () => reject(writeTx.error);
                }});
                const readTx = db.transaction('proofs', 'readonly');
                const count = await new Promise((resolve, reject) => {{
                    const r = readTx.objectStore('proofs').count();
                    r.onsuccess = () => resolve(r.result);
                    r.onerror = () => reject(r.error);
                }});
                db.close();
                return count;
            }}
        ");
        if (count < 1)
        {
            throw new InvalidOperationException(
                $"SeedBalanceAsync: expected at least 1 proof in IDB after write, got {count}. " +
                "Dexie schema likely not ready at seed time.");
        }
    }

    private static async Task GoToFirstMarketDetailAsync(IPage page)
    {
        await page.GotoAsync($"http://localhost:{TestPorts.Vite}/markets", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var firstMarket = page.GetByText("Will Bitcoin reach $100K").First;
        await Assertions.Expect(firstMarket).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await firstMarket.ClickAsync();

        await Assertions.Expect(page).ToHaveURLAsync(
            new Regex(@"/markets/[a-f0-9]+"),
            new() { Timeout = 5_000 });
    }

    [Fact]
    public async Task InsufficientBalance_OpensTopUpModal_WhenBalanceIsZero()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await SetupWalletAsync(page);
        await GoToFirstMarketDetailAsync(page);

        // Pick a Yes side from the outcomes — YesNoOutcomes renders clickable
        // buttons like "Yes 50¢" / "No 50¢" once the panel is visible.
        var yesSide = page.GetByRole(AriaRole.Button, new() { NameRegex = new Regex("^Yes\\s", RegexOptions.IgnoreCase) }).First;
        await Assertions.Expect(yesSide).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await yesSide.ClickAsync();

        // Choose a quick-amount so tradeAmount > 0 and walletReady is true.
        var quickAmount = page.GetByRole(AriaRole.Button, new() { Name = "100" }).First;
        await Assertions.Expect(quickAmount).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await quickAmount.ClickAsync();

        var confirm = page.GetByRole(AriaRole.Button, new() { NameRegex = new Regex("^Buy\\s", RegexOptions.IgnoreCase) }).First;
        await Assertions.Expect(confirm).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await confirm.ClickAsync();

        // Zero balance + 100 sat order → InsufficientBalanceModal opens.
        var modalHeader = page.GetByText("Insufficient Balance");
        await Assertions.Expect(modalHeader).ToBeVisibleAsync(new() { Timeout = 5_000 });

        var topUpButton = page.GetByRole(AriaRole.Button, new() { Name = "Top Up" });
        await Assertions.Expect(topUpButton).ToBeVisibleAsync();
    }

    [Fact]
    public async Task BuySide_ShowsWalletBalanceHint_AfterSeed()
    {
        // Regression for P5 item 6 — the buy-side trade panel used to show
        // no balance hint, and the InsufficientBalanceModal reported
        // "You have 0 sats" because the proof-row mintUrl never matched the
        // normalized active mint URL. The fix is in `stores/proof-db.ts`
        // (normalizes on write + a one-shot migration in `App.tsx`) and a
        // live-balance wire-through to `<TradingPanel>`.
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await SetupWalletAsync(page);
        await GoToFirstMarketDetailAsync(page);
        await SeedBalanceAsync(page, 10_000);
        // Seed writes through raw indexedDB.open(), bypassing Dexie's change
        // broadcast. An already-subscribed useLiveQuery (from `useBalance()`
        // in the app shell) won't observe the write in CI. Reload so the app
        // boots with the seeded proof already in IDB — first liveQuery fetch
        // reads the populated store directly.
        await page.ReloadAsync(new PageReloadOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // MarketDetail renders two TradingPanel copies — one for mobile
        // (`lg:hidden`) and one for desktop (`hidden lg:block`). At Playwright's
        // default 1280×720 viewport the mobile copy has `display: none` but
        // comes first in DOM order, so a plain `.First` selector resolves to
        // the hidden one. Filter for visible so we target the desktop copy.
        var yesSide = page.GetByRole(AriaRole.Button, new() { NameRegex = new Regex("^Yes\\s", RegexOptions.IgnoreCase) })
            .Filter(new() { Visible = true }).First;
        await Assertions.Expect(yesSide).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await yesSide.ClickAsync();

        // Balance hint should reflect the seeded amount (live via useBalance).
        // i18next plain `{{count}}` does not add thousands separators, so the
        // literal rendered string is "You have 10000 sats".
        var balanceHint = page.GetByText("You have 10000 sats").Filter(new() { Visible = true }).First;
        await Assertions.Expect(balanceHint).ToBeVisibleAsync(new() { Timeout = 10_000 });

        // Quick-pick buttons top out at 5000 sats (QUICK_AMOUNTS in
        // TradingPanel.tsx); type a larger value directly to exceed the 10k
        // seeded balance. The amount input is a <input type="number">
        // sibling to the quick buttons.
        var amountInput = page.GetByPlaceholder("0").Filter(new() { Visible = true }).First;
        await Assertions.Expect(amountInput).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await amountInput.FillAsync("50000");

        var confirm = page.GetByRole(AriaRole.Button, new() { NameRegex = new Regex("^Buy\\s", RegexOptions.IgnoreCase) })
            .Filter(new() { Visible = true }).First;
        await Assertions.Expect(confirm).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await confirm.ClickAsync();

        var modalHeader = page.GetByText("Insufficient Balance");
        await Assertions.Expect(modalHeader).ToBeVisibleAsync(new() { Timeout = 5_000 });

        // The modal's "You have {{count}} sats" line must now report the
        // seeded balance, not 0 (pre-fix regression).
        var modalBalance = page.GetByText("10000 sats").Filter(new() { Visible = true }).First;
        await Assertions.Expect(modalBalance).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    [Fact]
    public async Task SufficientBalance_PostsOrderWithEphemeralPubkey()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);
        await SetupWalletAsync(page);
        // submitOrder -> generateNip98Header requires an NDK signer. Seed
        // bitcaster-settings with nostrSignerMode='nsec' + a deterministic
        // throwaway nsec; App.tsx's rehydrateNostrSigner() will install the
        // signer on the next navigation so the Authorization header can be
        // produced. Without this the outer try/catch in MarketDetailPage's
        // placeOrder swallows the "No Nostr signer configured" error and the
        // POST is never dispatched.
        const string nsec = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
        await page.EvaluateAsync($@"
            localStorage.setItem('bitcaster-settings', JSON.stringify({{
                state: {{
                    activeCategory: 'general',
                    baseCurrency: 'BTC',
                    language: 'en',
                    theme: 'dark',
                    nostrSignerMode: 'nsec',
                    nsecSecret: '{nsec}',
                    nostrProfile: null,
                    nostrProfileFetchStatus: 'idle',
                    relays: []
                }},
                version: 0
            }}));
        ");
        await GoToFirstMarketDetailAsync(page);
        await SeedBalanceAsync(page, 10_000);
        // Reload so the seeded proof is in IDB before useLiveQuery subscribes
        // — see BuySide_ShowsWalletBalanceHint_AfterSeed for the same pattern.
        await page.ReloadAsync(new PageReloadOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Capture outgoing order requests — must contain a well-formed
        // ephemeralPubkey per the new wire contract.
        string? capturedBody = null;
        await page.RouteAsync("**/api/v1/*/orders", async route =>
        {
            if (route.Request.Method == "POST")
            {
                capturedBody = route.Request.PostData;
                // Echo a plausible SubmitOrderResponse so the client code path
                // completes without errors.
                await route.FulfillAsync(new RouteFulfillOptions
                {
                    Status = 200,
                    ContentType = "application/json",
                    Body = JsonSerializer.Serialize(new
                    {
                        orderId = Guid.NewGuid().ToString(),
                        status = "resting",
                        remainingAmountSats = 100,
                        fills = Array.Empty<object>(),
                        ephemeralPubkey = ExtractEphemeralPubkey(route.Request.PostData),
                    }),
                });
            }
            else
            {
                await route.ContinueAsync();
            }
        });

        // Filter Visible to target the desktop TradingPanel copy — the mobile
        // copy is first in DOM order but hidden at the default 1280×720
        // viewport, and click dispatch on it does not propagate state.
        var yesSide = page.GetByRole(AriaRole.Button, new() { NameRegex = new Regex("^Yes\\s", RegexOptions.IgnoreCase) })
            .Filter(new() { Visible = true }).First;
        await Assertions.Expect(yesSide).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await yesSide.ClickAsync();

        var quickAmount = page.GetByRole(AriaRole.Button, new() { Name = "100" })
            .Filter(new() { Visible = true }).First;
        await Assertions.Expect(quickAmount).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await quickAmount.ClickAsync();

        var confirm = page.GetByRole(AriaRole.Button, new() { NameRegex = new Regex("^Buy\\s", RegexOptions.IgnoreCase) })
            .Filter(new() { Visible = true }).First;
        await confirm.ClickAsync();

        // Wait for the request to land.
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (capturedBody is null && DateTime.UtcNow < deadline)
        {
            await Task.Delay(100);
        }

        if (capturedBody is null)
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page, consoleMessages, "submitOrder never reached Playwright intercept");
        }
        using var doc = JsonDocument.Parse(capturedBody!);
        var pubkey = doc.RootElement.GetProperty("ephemeralPubkey").GetString();
        Assert.NotNull(pubkey);
        Assert.Matches(@"^(02|03)[0-9a-f]{64}$", pubkey!);
    }

    private static string ExtractEphemeralPubkey(string? body)
    {
        if (string.IsNullOrEmpty(body)) return "02" + new string('0', 64);
        try
        {
            using var doc = JsonDocument.Parse(body);
            return doc.RootElement.GetProperty("ephemeralPubkey").GetString()
                ?? ("02" + new string('0', 64));
        }
        catch
        {
            return "02" + new string('0', 64);
        }
    }

    public async Task DisposeAsync()
    {
        if (_browser is not null)
            await _browser.CloseAsync();
        _playwright?.Dispose();
    }
}
