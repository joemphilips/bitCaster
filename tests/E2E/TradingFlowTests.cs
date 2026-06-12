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
    private const string TestNsec = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
    private IPlaywright? _playwright;
    private IBrowser? _browser;

    public async Task InitializeAsync()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        await Task.WhenAll(
            TestHelpers.WaitForService(httpClient, $"{TestPorts.MintUrl}/v1/info", "Mint"),
            TestHelpers.WaitForService(httpClient, $"{TestPorts.ServerUrl}/health", "Matching Engine"),
            TestHelpers.WaitForService(httpClient, $"{TestPorts.FrontendUrl}", "Frontend"));

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
    private static async Task SetupWalletAsync(IPage page, string? mintUrl = null)
    {
        await TestHelpers.SetupComplete(page, TestPorts.Vite, mintUrl ?? $"{TestPorts.MintUrl}");
        await SeedNostrSignerAsync(page);
    }

    private static Task SeedNostrSignerAsync(IPage page) =>
        page.EvaluateAsync($@"
            localStorage.setItem('bitcaster-settings', JSON.stringify({{
                state: {{
                    activeCategory: 'general',
                    baseCurrency: 'BTC',
                    language: 'en',
                    theme: 'dark',
                    nostrSignerMode: 'nsec',
                    nsecSecret: '{TestNsec}',
                    nostrProfile: null,
                    nostrProfileFetchStatus: 'idle',
                    relays: []
                }},
                version: 0
            }}));
        ");

    /// <summary>
    /// Inject a single proof directly into the IndexedDB store so
    /// <c>getBalance(activeMintUrl)</c> returns the requested amount without
    /// running the real mint flow. Must be called after navigation so the DB
    /// exists for the current origin.
    /// </summary>
    private static async Task SeedBalanceAsync(IPage page, int sats)
    {
        var mintUrl = $"{TestPorts.MintUrl}";
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
        await TestHelpers.GotoMarketsAsync(page, new PageGotoOptions
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
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);
        await SetupWalletAsync(page);
        await GoToFirstMarketDetailAsync(page);

        // Pick a Yes side from the outcomes — YesNoOutcomes renders clickable
        // buttons like "Yes 50¢" / "No 50¢" once the panel is visible.
        var yesSide = page.GetByRole(AriaRole.Button, new() { NameRegex = new Regex("^Yes\\s", RegexOptions.IgnoreCase) }).First;
        await Assertions.Expect(yesSide).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await yesSide.ClickAsync();

        // Choose a quick-amount so tradeAmount > 0 and walletReady is true.
        // QUICK_SHARE_PRESETS are [1, 5, 10, 50] shares (share-denominated since the
        // trade ticket moved to display-share denomination).
        var quickAmount = page.GetByRole(AriaRole.Button, new() { Name = "10" }).First;
        await Assertions.Expect(quickAmount).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await quickAmount.ClickAsync();

        var confirm = VisibleTradeConfirm(page);
        await Assertions.Expect(confirm).ToBeEnabledAsync(new() { Timeout = 5_000 });
        await confirm.ClickAsync();

        // Zero balance + 100 sat order → InsufficientBalanceModal opens.
        var modalHeader = page.GetByText("Insufficient Balance");
        try
        {
            await Assertions.Expect(modalHeader).ToBeVisibleAsync(new() { Timeout = 5_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                "Zero-balance trade confirm did not open Insufficient Balance modal.");
        }

        var topUpButton = page.GetByRole(AriaRole.Button, new() { Name = "Top Up" });
        await Assertions.Expect(topUpButton).ToBeVisibleAsync();
    }

    [Fact]
    public async Task BuySide_NoBalanceHint_InsufficientBalanceModal_StillAppears()
    {
        // The buy-side TradingPanel intentionally omits a wallet balance hint
        // (see TradingPanel.tsx: "Buy-side wallet balance is intentionally
        // omitted from this panel"). This test verifies:
        //   1. No "You have N sats" text is visible on the buy side.
        //   2. The InsufficientBalanceModal still opens when the order amount
        //      exceeds the seeded balance — confirming the balance is wired
        //      through to the modal even though the panel hides the hint.
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);
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

        // Verify that the buy-side panel does NOT show a wallet balance hint —
        // this is intentional UX (only the sell-side shows a share balance).
        var buyBalanceHint = page.GetByText(new Regex("You have.*sats", RegexOptions.IgnoreCase))
            .Filter(new() { Visible = true });
        await Assertions.Expect(buyBalanceHint).ToHaveCountAsync(0);

        // Type an amount in shares that exceeds the seeded balance (10,000 sats
        // = 100 shares at divisibility 100). 500 shares would cost 50,000 sats,
        // well past the funded 10,000 sats.
        var amountInput = VisibleTradeAmountInput(page);
        await Assertions.Expect(amountInput).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await amountInput.FillAsync("500");

        var confirm = VisibleTradeConfirm(page);
        await Assertions.Expect(confirm).ToBeEnabledAsync(new() { Timeout = 5_000 });
        await confirm.ClickAsync();

        // InsufficientBalanceModal must still open even though the panel
        // omits the inline balance hint.
        var modalHeader = page.GetByText("Insufficient Balance");
        try
        {
            await Assertions.Expect(modalHeader).ToBeVisibleAsync(new() { Timeout = 5_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                "Over-balance trade confirm did not open Insufficient Balance modal.");
        }

        // The modal's balance line must now report the seeded amount, not 0.
        var modalBalance = page.GetByText("10,000 sats").Filter(new() { Visible = true }).First;
        await Assertions.Expect(modalBalance).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    [Fact]
    public async Task SufficientBalance_PostsOrderWithEphemeralPubkey()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);
        await SetupWalletAsync(page);
        await GoToFirstMarketDetailAsync(page);
        await SeedBalanceAsync(page, 10_000);
        // Reload so the seeded proof is in IDB before useLiveQuery subscribes
        // — see BuySide_NoBalanceHint_InsufficientBalanceModal_StillAppears for the same pattern.
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

        // QUICK_SHARE_PRESETS are [1, 5, 10, 50] shares (share-denominated since the
        // trade ticket moved to display-share denomination).
        var quickAmount = page.GetByRole(AriaRole.Button, new() { Name = "10" })
            .Filter(new() { Visible = true }).First;
        await Assertions.Expect(quickAmount).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await quickAmount.ClickAsync();

        // The seeded order book is empty. A market order should now fail
        // before POSTing because there is no executable liquidity; use a limit
        // order for this regression guard, which only asserts submission shape.
        var limitOrder = page.GetByRole(AriaRole.Button, new() { Name = "Limit" })
            .Filter(new() { Visible = true }).First;
        await Assertions.Expect(limitOrder).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await limitOrder.ClickAsync();

        // This regression guard intercepts SubmitOrder and seeds a synthetic
        // proof that is good enough for balance display, but not spendable by
        // the mint. Disable maker pre-flight here so the test remains scoped
        // to the order request shape; pre-flight splitting has dedicated E2E
        // coverage in CliDaemonE2ETests.
        var preflightSplit = page.GetByRole(AriaRole.Checkbox, new() { Name = "Pre-flight split" })
            .Filter(new() { Visible = true }).First;
        await Assertions.Expect(preflightSplit).ToBeCheckedAsync(new() { Timeout = 5_000 });
        await preflightSplit.ClickAsync();
        await Assertions.Expect(preflightSplit).Not.ToBeCheckedAsync(new() { Timeout = 5_000 });

        var confirm = VisibleTradeConfirm(page);
        await Assertions.Expect(confirm).ToBeEnabledAsync(new() { Timeout = 5_000 });
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

    [Fact]
    public async Task ScoreTopUp_MintsRegularSats_PaysEngineFee_ThenPostsOrder()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);
        await SetupWalletAsync(page, TestPorts.FrontendUrl);

        string? capturedOrderBody = null;
        string? capturedScorePaymentBody = null;

        await page.RouteAsync("**/api/v1/participation-score", async route =>
        {
            if (route.Request.Method != "GET")
            {
                await route.ContinueAsync();
                return;
            }

            await route.FulfillAsync(new RouteFulfillOptions
            {
                Status = 200,
                ContentType = "application/json",
                Body = JsonSerializer.Serialize(new
                {
                    pubkey = "e2e-score-pubkey",
                    balance = 0,
                    purchasedTotal = 0,
                    consumedTotal = 0,
                    penaltyTotal = 0,
                    matchDebitScore = 500,
                    enabled = true,
                }),
            });
        });

        await page.RouteAsync("**/api/v1/participation-score/ecash", async route =>
        {
            capturedScorePaymentBody = route.Request.PostData;
            await route.FulfillAsync(new RouteFulfillOptions
            {
                Status = 200,
                ContentType = "application/json",
                Body = JsonSerializer.Serialize(new
                {
                    paymentId = Guid.NewGuid().ToString(),
                    status = "credited",
                    amountSats = 500,
                    creditedScore = 500,
                    creditedAt = DateTimeOffset.UtcNow,
                }),
            });
        });

        await page.RouteAsync("**/api/v1/*/orders", async route =>
        {
            if (route.Request.Method == "POST")
            {
                capturedOrderBody = route.Request.PostData;
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
                        baseAsset = "sat",
                        divisibility = 100,
                    }),
                });
            }
            else
            {
                await route.ContinueAsync();
            }
        });

        await GoToFirstMarketDetailAsync(page);

        var yesSide = page.GetByRole(AriaRole.Button, new() { NameRegex = new Regex("^Yes\\s", RegexOptions.IgnoreCase) })
            .Filter(new() { Visible = true }).First;
        await Assertions.Expect(yesSide).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await yesSide.ClickAsync();

        // QUICK_SHARE_PRESETS are [1, 5, 10, 50] shares (share-denominated since the
        // trade ticket moved to display-share denomination).
        var quickAmount = page.GetByRole(AriaRole.Button, new() { Name = "10" })
            .Filter(new() { Visible = true }).First;
        await Assertions.Expect(quickAmount).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await quickAmount.ClickAsync();

        var limitOrder = page.GetByRole(AriaRole.Button, new() { Name = "Limit" })
            .Filter(new() { Visible = true }).First;
        await Assertions.Expect(limitOrder).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await limitOrder.ClickAsync();

        var preflightSplit = page.GetByRole(AriaRole.Checkbox, new() { Name = "Pre-flight split" })
            .Filter(new() { Visible = true }).First;
        await Assertions.Expect(preflightSplit).ToBeCheckedAsync(new() { Timeout = 5_000 });
        await preflightSplit.ClickAsync();
        await Assertions.Expect(preflightSplit).Not.ToBeCheckedAsync(new() { Timeout = 5_000 });

        var confirm = VisibleTradeConfirm(page);
        await Assertions.Expect(confirm).ToBeEnabledAsync(new() { Timeout = 5_000 });
        await confirm.ClickAsync();

        await ClickTopUpAndContinueAsync(page, consoleMessages, "collateral top-up");
        try
        {
            await Assertions.Expect(page.GetByRole(AriaRole.Heading, new() { Name = "Top Up Engine Score" }))
                .ToBeVisibleAsync(new() { Timeout = 30_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                "Score modal did not appear after collateral top-up.");
        }

        await ClickTopUpAndContinueAsync(page, consoleMessages, "Score top-up");

        var deadline = DateTime.UtcNow.AddSeconds(45);
        while ((capturedScorePaymentBody is null || capturedOrderBody is null) && DateTime.UtcNow < deadline)
        {
            await Task.Delay(250);
        }

        if (capturedScorePaymentBody is null)
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                "Score ecash payment endpoint was not called after Score top-up.");
        }

        using (var scoreDoc = JsonDocument.Parse(capturedScorePaymentBody))
        {
            Assert.Equal(500, scoreDoc.RootElement.GetProperty("amountSats").GetInt32());
            Assert.StartsWith("cashu", scoreDoc.RootElement.GetProperty("proofsToken").GetString());
            Assert.True(scoreDoc.RootElement.TryGetProperty("paymentId", out _));
        }

        if (capturedOrderBody is null)
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                "Order was not posted after Score ecash payment.");
        }

        using var orderDoc = JsonDocument.Parse(capturedOrderBody);
        Assert.Equal(100, orderDoc.RootElement.GetProperty("amountSats").GetInt32());
        Assert.Equal("Outcome", orderDoc.RootElement.GetProperty("tokenSide").GetString());
        Assert.Matches(
            @"^(02|03)[0-9a-f]{64}$",
            orderDoc.RootElement.GetProperty("ephemeralPubkey").GetString()!);
    }

    private static async Task ClickTopUpAndContinueAsync(
        IPage page,
        IReadOnlyList<string> consoleMessages,
        string context)
    {
        var topUpButton = page.GetByTestId("insufficient-balance-top-up");
        try
        {
            await Assertions.Expect(topUpButton).ToBeVisibleAsync(new() { Timeout = 10_000 });
            await topUpButton.ClickAsync();
            var continueButton = page.GetByTestId("top-up-continue");
            await Assertions.Expect(continueButton).ToBeEnabledAsync(new() { Timeout = 10_000 });
            await continueButton.ClickAsync();
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                $"Could not start {context}.");
        }
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

    private static ILocator VisibleTradeAmountInput(IPage page) =>
        page.GetByTestId("trade-amount-input")
            .Filter(new() { Visible = true })
            .First;

    private static ILocator VisibleTradeConfirm(IPage page) =>
        page.GetByTestId("trade-confirm")
            .Filter(new() { Visible = true })
            .First;

    public async Task DisposeAsync()
    {
        if (_browser is not null)
            await _browser.CloseAsync();
        _playwright?.Dispose();
    }
}
