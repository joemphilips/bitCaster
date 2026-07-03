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
    private const string P30ConditionId = "b30ca000000000000000000000000000000000000000000000000000000000000";
    private const string TestNsec = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
    private const int SatShareFaceSubunits = 1_000_000;
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
    private static async Task SeedBalanceAsync(IPage page, int amountSubunits)
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
                    amount: {amountSubunits},
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
        // buttons with the outcome label plus its displayed probability once
        // the panel is visible.
        var yesSide = page.GetByRole(AriaRole.Button, new() { NameRegex = new Regex("^Yes\\s", RegexOptions.IgnoreCase) }).First;
        await Assertions.Expect(yesSide).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await yesSide.ClickAsync();

        // Choose a quick-amount so tradeAmount > 0 and walletReady is true.
        // QUICK_SHARE_PRESETS are [1, 5, 10, 50] shares (share-denominated since the
        // trade ticket moved to display-share denomination).
        var quickAmount = page.GetByRole(AriaRole.Button, new() { Name = "10" }).First;
        await Assertions.Expect(quickAmount).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await quickAmount.ClickAsync();

        // P29 disables market-order submission when there is no executable
        // orderbook depth. Use a limit order here so this test remains scoped
        // to balance gating rather than liquidity availability.
        await ClickVisibleLimitOrderAsync(page);

        var confirm = VisibleTradeConfirm(page);
        await Assertions.Expect(confirm).ToBeEnabledAsync(new() { Timeout = 5_000 });
        await confirm.ClickAsync();

        // Zero balance + limit buy collateral requirement → InsufficientBalanceModal opens.
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
        await SeedBalanceAsync(page, 10_000_000);
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
        // = 10,000,000 msat subunits). At the default 50% price, 500 shares
        // would cost 250,000 sats, well past the funded 10,000 sats.
        var amountInput = VisibleTradeAmountInput(page);
        await Assertions.Expect(amountInput).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await amountInput.FillAsync("500");

        // No-liquidity market orders are now disabled. Use a limit order so
        // the assertion remains about over-balance buy-side gating.
        await ClickVisibleLimitOrderAsync(page);

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
        await SeedBalanceAsync(page, 10_000_000);
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
                        remainingAmountSubunits = 10 * SatShareFaceSubunits,
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
        await ClickVisibleQuickSharePresetAsync(page, 10);

        // The seeded order book is empty. A market order should now fail
        // before POSTing because there is no executable liquidity; use a limit
        // order for this regression guard, which only asserts submission shape.
        await ClickVisibleLimitOrderAsync(page);

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
    public async Task CategoricalBuyNoMarketOrder_UsesComplementaryBidLiquidity()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);
        await SetupWalletAsync(page);
        var conditionId = NewP30ConditionId();
        await StubP30ComplementaryLiquidityMarketAsync(page, conditionId, bidPrice: 60, askPrice: 35);

        string? capturedOrderBody = null;
        string? capturedOrderUrl = null;
        await page.RouteAsync("**/api/v1/participation-score", async route =>
        {
            await route.FulfillAsync(new RouteFulfillOptions
            {
                Status = 200,
                ContentType = "application/json",
                Body = JsonSerializer.Serialize(new
                {
                    pubkey = "p30-score-pubkey",
                    balance = 0,
                    purchasedTotal = 0,
                    consumedTotal = 0,
                    penaltyTotal = 0,
                    matchDebitScore = 0,
                    enabled = false,
                }),
            });
        });
        await page.RouteAsync("**/api/v1/*/orders", async route =>
        {
            if (route.Request.Method == "POST")
            {
                capturedOrderUrl = route.Request.Url;
                capturedOrderBody = route.Request.PostData;
                await route.FulfillAsync(new RouteFulfillOptions
                {
                    Status = 200,
                    ContentType = "application/json",
                    Body = JsonSerializer.Serialize(new
                    {
                        orderId = Guid.NewGuid().ToString(),
                        status = "filled",
                        remainingAmountSubunits = 0,
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

        await page.GotoAsync($"{TestPorts.FrontendUrl}/markets/{conditionId}", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });
        await SeedBalanceAsync(page, 10_000_000);
        await page.ReloadAsync(new PageReloadOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var tradingPanel = page.Locator("[data-trading-panel]")
            .Filter(new() { Visible = true })
            .First;
        await tradingPanel.GetByTestId("buy-no-A").ClickAsync();
        await tradingPanel.GetByTestId("trade-amount-input").FillAsync("1");

        await Assertions.Expect(tradingPanel.GetByText("No executable liquidity"))
            .ToHaveCountAsync(0);
        await Assertions.Expect(tradingPanel.GetByTestId("trade-average-execution-price"))
            .ToContainTextAsync("40.00%");

        var confirm = VisibleTradeConfirm(page);
        await Assertions.Expect(confirm).ToBeEnabledAsync(new() { Timeout = 5_000 });
        await confirm.ClickAsync();

        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (capturedOrderBody is null && DateTime.UtcNow < deadline)
        {
            await Task.Delay(100);
        }

        if (capturedOrderBody is null || capturedOrderUrl is null)
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page, consoleMessages, "P30 Buy NO market order did not reach SubmitOrder.");
        }

        Assert.Contains($"/api/v1/{conditionId}-A/orders", capturedOrderUrl);
        using var orderDoc = JsonDocument.Parse(capturedOrderBody);
        Assert.Equal("A", orderDoc.RootElement.GetProperty("outcomeId").GetString());
        Assert.Equal("Complement", orderDoc.RootElement.GetProperty("tokenSide").GetString());
        Assert.Equal("Buy", orderDoc.RootElement.GetProperty("side").GetString());
        Assert.Equal("FAK", orderDoc.RootElement.GetProperty("timeInForce").GetString());
        Assert.Equal(99, orderDoc.RootElement.GetProperty("price").GetInt32());
        Assert.Equal(SatShareFaceSubunits, orderDoc.RootElement.GetProperty("amountSubunits").GetInt32());
    }

    [Fact]
    public async Task CategoricalBuyNoMarketOrder_IgnoresPublicAskOnlyLiquidity()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await SetupWalletAsync(page);
        var conditionId = NewP30ConditionId();
        await StubP30ComplementaryLiquidityMarketAsync(page, conditionId, bidPrice: null, askPrice: 35);

        await page.GotoAsync($"{TestPorts.FrontendUrl}/markets/{conditionId}", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var tradingPanel = page.Locator("[data-trading-panel]")
            .Filter(new() { Visible = true })
            .First;
        await tradingPanel.GetByTestId("buy-no-A").ClickAsync();
        await tradingPanel.GetByTestId("trade-amount-input").FillAsync("1");

        await Assertions.Expect(tradingPanel.GetByText("No executable liquidity"))
            .ToBeVisibleAsync(new() { Timeout = 5_000 });
        await Assertions.Expect(VisibleTradeConfirm(page))
            .ToBeDisabledAsync(new() { Timeout = 5_000 });
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
                        remainingAmountSubunits = 10 * SatShareFaceSubunits,
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
        await ClickVisibleQuickSharePresetAsync(page, 10);

        await ClickVisibleLimitOrderAsync(page);

        var preflightSplit = page.GetByRole(AriaRole.Checkbox, new() { Name = "Pre-flight split" })
            .Filter(new() { Visible = true }).First;
        await Assertions.Expect(preflightSplit).ToBeCheckedAsync(new() { Timeout = 5_000 });
        await preflightSplit.ClickAsync();
        await Assertions.Expect(preflightSplit).Not.ToBeCheckedAsync(new() { Timeout = 5_000 });

        var confirm = VisibleTradeConfirm(page);
        await Assertions.Expect(confirm).ToBeEnabledAsync(new() { Timeout = 5_000 });
        await confirm.ClickAsync();

        await ClickTopUpAndContinueAsync(page, consoleMessages, "collateral top-up");
        // P27 changed Score payment from a second modal to a submit preflight:
        // after collateral lands, regular sats are spent directly into Score
        // and the original order is retried.

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
        // Trade tickets are share-denominated: 10 displayed shares map to
        // 10 whole sat-share faces at the protocol boundary.
        Assert.Equal(10 * SatShareFaceSubunits, orderDoc.RootElement.GetProperty("amountSubunits").GetInt32());
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

    private static async Task ClickVisibleQuickSharePresetAsync(IPage page, int shares)
    {
        var quickAmount = page.Locator("[data-trading-panel]")
            .Filter(new() { Visible = true })
            .First
            .GetByRole(AriaRole.Button, new() { Name = $"+{shares}", Exact = true })
            .Filter(new() { Visible = true })
            .First;
        await Assertions.Expect(quickAmount).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await quickAmount.ClickAsync();
    }

    private static async Task ClickVisibleLimitOrderAsync(IPage page)
    {
        var limitOrder = page.Locator("[data-trading-panel]")
            .Filter(new() { Visible = true })
            .First
            .GetByRole(AriaRole.Button, new() { Name = "Limit", Exact = true })
            .Filter(new() { Visible = true }).First;
        await Assertions.Expect(limitOrder).ToBeVisibleAsync(new() { Timeout = 5_000 });
        // At the default E2E viewport, Playwright's auto-scroll can place the
        // already-visible toggle underneath the sticky desktop header. This is
        // a test viewport artifact, not a product regression: users can click
        // the visible control in the trading panel without auto-scrolling it
        // under the header.
        await limitOrder.DispatchEventAsync("click");
    }

    private static async Task StubP30ComplementaryLiquidityMarketAsync(
        IPage page,
        string conditionId,
        int? bidPrice,
        int? askPrice)
    {
        await SeedMockOrderBookAsync(conditionId, bidPrice, askPrice);

        await page.RouteAsync("**/api/v1/markets/query*", async route =>
        {
            await route.FulfillAsync(new RouteFulfillOptions
            {
                Status = 200,
                ContentType = "application/json",
                Body = JsonSerializer.Serialize(new
                {
                    markets = new[]
                    {
                        new
                        {
                            conditionId,
                            outcomes = new[] { "A", "B", "C" },
                            title = "P30 categorical liquidity market",
                            description = "Complementary liquidity regression fixture",
                            thumbnailUrl = (string?)null,
                            creatorPubkey = (string?)null,
                            deadline = "2026-12-31T00:00:00Z",
                            state = "open",
                            createdAt = "2026-06-01T00:00:00Z",
                            volume24hSubunits = 0,
                            volume30dSubunits = 0,
                            liquiditySubunits = 10_000L,
                    ammBotBudgetSubunits = 10_000L,
                            traderCount = 2,
                            volumeLifetimeSubunits = 0,
                            lastTradedPrice = 0.6m,
                            baseAsset = "sat",
                            divisibility = 100,
                            categoryTags = Array.Empty<string>(),
                            lastSuccessfulRefreshAt = "2026-06-14T00:00:00Z",
                        },
                    },
                    nextCursor = (string?)null,
                    lastSuccessfulRefreshAt = "2026-06-14T00:00:00Z",
                }),
            });
        });

        await page.RouteAsync("**/api/v1/markets/*/price-history*", async route =>
        {
            await route.FulfillAsync(new RouteFulfillOptions
            {
                Status = 200,
                ContentType = "application/json",
                Body = JsonSerializer.Serialize(new
                {
                    conditionId,
                    timeframe = "7d",
                    outcomes = new[]
                    {
                        new
                        {
                            outcomeId = "A",
                            data = new[]
                            {
                                new { timestamp = "2026-06-01T00:00:00Z", price = 60, volumeSubunits = 100L },
                            },
                        },
                    },
                }),
            });
        });

        await page.RouteAsync("**/api/v1/markets/*/comments", async route =>
        {
            await route.FulfillAsync(new RouteFulfillOptions
            {
                Status = 200,
                ContentType = "application/json",
                Body = JsonSerializer.Serialize(new
                {
                    conditionId,
                    comments = Array.Empty<object>(),
                }),
            });
        });
    }

    private static string NewP30ConditionId() =>
        ("b30ca" + Guid.NewGuid().ToString("N")).PadRight(64, '0')[..64];

    private static async Task SeedMockOrderBookAsync(string conditionId, int? bidPrice, int? askPrice)
    {
        if (bidPrice is { } bid)
            await SeedMockOrderAsync(conditionId, side: "Buy", price: bid);

        // A crossed bid/ask would immediately match in the mock CLOB, leaving
        // no resting liquidity for the quote preview. Seed the ask only when
        // it can coexist or when the scenario intentionally needs ask-only
        // public liquidity.
        if (askPrice is { } ask && (bidPrice is null || ask > bidPrice.Value))
            await SeedMockOrderAsync(conditionId, side: "Sell", price: ask);
    }

    private static async Task SeedMockOrderAsync(string conditionId, string side, int price)
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        var body = JsonSerializer.Serialize(new
        {
            outcomeId = "A",
            tokenSide = "Outcome",
            side,
            price,
            amountSubunits = SatShareFaceSubunits,
            timeInForce = "GTC",
            ephemeralPubkey = NewCompressedPubkey(),
            comment = (object?)null,
        });
        using var content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");
        using var response = await httpClient.PostAsync(
            $"{TestPorts.ServerUrl}/api/v1/{Uri.EscapeDataString($"{conditionId}-A")}/orders",
            content);
        if (!response.IsSuccessStatusCode)
        {
            var responseBody = await response.Content.ReadAsStringAsync();
            throw new InvalidOperationException(
                $"Failed to seed P30 mock orderbook: {(int)response.StatusCode} {responseBody}");
        }
    }

    private static string NewCompressedPubkey() =>
        "02" + Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");

    public async Task DisposeAsync()
    {
        if (_browser is not null)
            await _browser.CloseAsync();
        _playwright?.Dispose();
    }
}
