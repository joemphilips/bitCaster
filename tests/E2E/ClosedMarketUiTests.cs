using Microsoft.Playwright;

namespace BitCaster.E2ETest;

/// <summary>
/// Phase 4.1 + 4.5 — closed-market UI gating. Per ADR-010 a market closes
/// either when the oracle attestation lands or when the announcement
/// deadline passes; in both cases mintd marks the condition as no longer
/// `pending`. The frontend MUST drop the trade pane and any deposit /
/// payment-request affordances on the market-detail page in those states
/// (P4.5 mirrors the engine-side close — engine PR #23).
///
/// The mintd test seed only ships pending markets, so these tests
/// intercept <c>/v1/conditions</c> and return a synthetic closed condition.
/// The interception happens via Playwright route handlers so no docker
/// state mutates between runs.
/// </summary>
public class ClosedMarketUiTests : IAsyncLifetime
{
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

    private static string ConditionFixture(string conditionId, string title, string attestationStatus,
        string? winningOutcome)
    {
        var winning = winningOutcome is null ? "null" : $"\"{winningOutcome}\"";
        return $@"{{
            ""condition_id"": ""{conditionId}"",
            ""tags"": [[""description"", ""{title}""]],
            ""threshold"": 1,
            ""announcements"": [""ann""],
            ""partitions"": [{{
                ""partition"": [""YES"", ""NO""],
                ""collateral"": ""sat"",
                ""parent_collection_id"": ""0000000000000000000000000000000000000000000000000000000000000000"",
                ""keysets"": {{}}
            }}],
            ""attestation"": {{
                ""status"": ""{attestationStatus}"",
                ""winning_outcome"": {winning},
                ""attested_at"": null
            }}
        }}";
    }

    /// <summary>
    /// Wire <c>/v1/conditions</c> to return a list of two markets — one
    /// open (pending), one closed (caller-controlled status). Returns the
    /// condition IDs so the test can navigate to either. Also stubs the
    /// engine catalogue proxy (<c>/api/v1/markets/query</c>) so the detail
    /// page reads the matching engine `state` for lifecycle (Open / Closed)
    /// per ADR-009 Amendment 2026-05-04 — not mintd's attestation status.
    /// </summary>
    private static async Task<(string OpenId, string ClosedId)> StubConditions(
        IPage page, string closedStatus)
    {
        const string openId = "open0000000000000000000000000000000000000000000000000000000000000000";
        const string closedId = "closed00000000000000000000000000000000000000000000000000000000000000";

        await page.RouteAsync("**/v1/conditions", async route =>
        {
            var body = $@"{{
                ""conditions"": [
                    {ConditionFixture(openId, "P4.1 open market", "pending", null)},
                    {ConditionFixture(closedId, "P4.1 closed market", closedStatus, "YES")}
                ]
            }}";
            await route.FulfillAsync(new RouteFulfillOptions
            {
                Status = 200,
                ContentType = "application/json",
                Body = body,
            });
        });

        // Engine catalogue proxy. The detail page calls /api/v1/markets/query?ids=<conditionId>
        // for engine-authoritative `state`. Closed markets get `closed`; open ones get `open`.
        await page.RouteAsync("**/api/v1/markets/query**", async route =>
        {
            var url = route.Request.Url;
            var requestedId = url.Contains(closedId) ? closedId
                : url.Contains(openId) ? openId
                : openId;
            var entryState = requestedId == closedId ? "closed" : "open";
            var entryTitle = requestedId == closedId ? "P4.1 closed market" : "P4.1 open market";
            var body = $@"{{
                ""markets"": [{{
                    ""conditionId"": ""{requestedId}"",
                    ""outcomes"": [""YES"", ""NO""],
                    ""title"": ""{entryTitle}"",
                    ""thumbnailUrl"": null,
                    ""creatorPubkey"": null,
                    ""deadline"": null,
                    ""state"": ""{entryState}"",
                    ""createdAt"": ""2026-01-01T00:00:00Z"",
                    ""volume24hSats"": 0,
                    ""volume30dSats"": 0,
                    ""liquiditySats"": 25000,
                    ""traderCount"": 3,
                    ""volumeLifetimeSats"": 50000,
                    ""lastTradedPrice"": null,
                    ""categoryTags"": [],
                    ""lastSuccessfulRefreshAt"": ""2026-05-04T00:00:00Z""
                }}],
                ""nextCursor"": null,
                ""lastSuccessfulRefreshAt"": ""2026-05-04T00:00:00Z""
            }}";
            await route.FulfillAsync(new RouteFulfillOptions
            {
                Status = 200,
                ContentType = "application/json",
                Body = body,
            });
        });

        return (openId, closedId);
    }

    private async Task PrimeWalletAsync(IPage page)
    {
        var mintUrl = $"{TestPorts.MintUrl}";
        var mnemonic = TestMnemonics.Get();
        await page.GotoAsync($"{TestPorts.FrontendUrl}/setup", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.DOMContentLoaded,
            Timeout = 30_000,
        });
        await page.EvaluateAsync($@"
            localStorage.setItem('bitcaster-wallet', JSON.stringify({{
                state: {{
                    mnemonic: '{mnemonic}',
                    setupComplete: true,
                    mints: [{{
                        url: '{mintUrl}',
                        info: {{
                            name: 'Default Mint',
                            version: 'Nutshell/0.16.0',
                            nuts: {{ '4': {{ methods: [] }}, '5': {{ methods: [] }}, 'CTF': {{ supported: true }} }}
                        }},
                        keysets: [{{ id: '00abc123', unit: 'sat', active: true }}]
                    }}],
                    activeMintUrl: '{mintUrl}',
                    keysetCounters: {{}},
                    mintConnectionStatuses: {{ '{mintUrl}': 'connected' }}
                }},
                version: 0
            }}));
        ");
    }

    /// <summary>T4.1.a — open market keeps the trade pane visible.</summary>
    [Fact]
    public async Task OpenMarket_RendersTradePane()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        await PrimeWalletAsync(page);
        var (openId, _) = await StubConditions(page, "expired");

        await page.GotoAsync($"{TestPorts.FrontendUrl}/markets/{openId}", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var marketTitle = page.GetByText("P4.1 open market").First;
        await Assertions.Expect(marketTitle).ToBeVisibleAsync(new() { Timeout = 10_000 });

        // The trade panel renders an "Amount" / "Buy" / numeric-input cluster;
        // the most stable accessible label is the price-history control bar
        // sibling of the Trading Panel which carries `data-trading-panel`. The
        // panel is visible iff the gating predicate left it in the tree.
        var tradingPanel = page.Locator("[data-trading-panel]");
        try
        {
            await Assertions.Expect(tradingPanel.First).ToBeAttachedAsync(new() { Timeout = 5_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Trade panel missing on an open market.");
        }
    }

    /// <summary>
    /// T4.1.b — closed market hides the trade pane and surfaces the Closed
    /// badge near the order book.
    /// </summary>
    [Fact]
    public async Task ClosedMarket_HidesTradePane_ShowsClosedBadge()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        await PrimeWalletAsync(page);
        var (_, closedId) = await StubConditions(page, "expired");

        await page.GotoAsync($"{TestPorts.FrontendUrl}/markets/{closedId}", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var marketTitle = page.GetByText("P4.1 closed market").First;
        await Assertions.Expect(marketTitle).ToBeVisibleAsync(new() { Timeout = 10_000 });

        // No trading panel attached for closed markets.
        var tradingPanel = page.Locator("[data-trading-panel]");
        try
        {
            await Assertions.Expect(tradingPanel).ToHaveCountAsync(0, new() { Timeout = 5_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Trade panel still rendered on a closed market.");
        }

        // Closed badge appears next to the order book section.
        var closedBadge = page.GetByTestId("market-closed-badge");
        try
        {
            await Assertions.Expect(closedBadge.First).ToBeVisibleAsync(new() { Timeout = 5_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Closed badge missing from a closed market's order book.");
        }
    }

    /// <summary>
    /// T4.1.c / T4.5.a — same closed market, asserting that no deposit /
    /// payment-request affordances are mounted. Today the market-detail
    /// page never renders deposit controls (the bot-deposit affordance
    /// lives on the creator wizard / dashboard). The strict assertion is
    /// "no element with data-testid=market-detail-deposit exists" so the
    /// regression bites the moment any future change re-introduces a
    /// deposit overlay on closed markets.
    /// </summary>
    [Fact]
    public async Task ClosedMarket_HidesDepositAffordances()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        await PrimeWalletAsync(page);
        var (_, closedId) = await StubConditions(page, "expired");

        await page.GotoAsync($"{TestPorts.FrontendUrl}/markets/{closedId}", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var marketTitle = page.GetByText("P4.1 closed market").First;
        await Assertions.Expect(marketTitle).ToBeVisibleAsync(new() { Timeout = 10_000 });

        var depositAffordance = page.GetByTestId("market-detail-deposit");
        try
        {
            await Assertions.Expect(depositAffordance).ToHaveCountAsync(0, new() { Timeout = 3_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Deposit / payment-request control mounted on a closed market.");
        }
    }

    public Task DisposeAsync()
    {
        _browser?.DisposeAsync().GetAwaiter().GetResult();
        _playwright?.Dispose();
        return Task.CompletedTask;
    }
}
