using System.Text.Json;
using Microsoft.Playwright;

namespace BitCaster.E2ETest;

public class MarketMetadataDisplayTests : IAsyncLifetime
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

    private async Task SetupComplete(IPage page) =>
        await TestHelpers.SetupComplete(page, TestPorts.Vite);

    [Fact]
    public async Task MarketCards_DisplayMetadataFromMatchingEngine()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await SetupComplete(page);

        // The markets-list page reads visible metrics and state from the
        // catalogue proxy. Intercept the endpoint with known values so we can
        // verify the card renders the catalogue-derived values. The deprecated per-market
        // /api/v1/{id}/metadata fetch is no longer issued from this page; for
        // backward compat we leave a stub in place that returns deterministic
        // values in case any future feature re-introduces a per-card detail
        // fetch.
        await page.RouteAsync("**/api/v1/markets/query*", async route =>
        {
            await route.FulfillAsync(new RouteFulfillOptions
            {
                ContentType = "application/json",
                Body = JsonSerializer.Serialize(new
                {
                    markets = new[]
                    {
                        new
                        {
                            conditionId = "metadata-display-test",
                            outcomes = new[] { "YES", "NO" },
                            title = "Will Bitcoin reach $100K",
                            thumbnailUrl = (string?)null,
                            creatorPubkey = (string?)null,
                            deadline = (string?)null,
                            state = "open",
                            createdAt = "2026-01-01T00:00:00Z",
                            volume24hSubunits = 50_000L,
                            volume30dSubunits = 200_000L,
                            liquiditySubunits = 150_000L,
                            traderCount = 100,
                            volumeLifetimeSubunits = 750_000L,
                            lastTradedPrice = (double?)null,
                            categoryTags = new[] { "crypto" },
                            lastSuccessfulRefreshAt = "2026-05-02T09:58:00Z",
                        },
                    },
                    nextCursor = (string?)null,
                    lastSuccessfulRefreshAt = "2026-05-02T09:58:00Z",
                }),
            });
        });

        await TestHelpers.GotoMarketsAsync(page, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // The card displays lifetime volume from the catalogue. 750_000 sats
        // renders as "750.0K" via the formatBtc helper used in MarketCard.tsx.
        var btcMarket = page.GetByText("Will Bitcoin reach $100K");
        await Assertions.Expect(btcMarket).ToBeVisibleAsync(new() { Timeout = 10_000 });

        var volumeBadge = page.GetByText("750.0K", new() { Exact = false });
        await Assertions.Expect(volumeBadge.First).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    [Fact]
    public async Task MarketCards_GracefulDegradation_WhenMetadataUnavailable()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await SetupComplete(page);

        // Block the metadata API to simulate matching engine down
        await page.RouteAsync("**/api/v1/*/metadata", async route => await route.AbortAsync());

        await TestHelpers.GotoMarketsAsync(page, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Market cards should still render without crashing
        var btcMarket = page.GetByText("Will Bitcoin reach $100K");
        await Assertions.Expect(btcMarket).ToBeVisibleAsync(new() { Timeout = 10_000 });

        // Other seeded markets should also be visible
        var nbaMarket = page.GetByText("2026 NBA Championship Winner");
        await Assertions.Expect(nbaMarket).ToBeVisibleAsync();
    }

    [Fact]
    public async Task MarketDetail_DisplaysMetadata()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await SetupComplete(page);

        // Intercept the removed metadata endpoint in case a regression
        // reintroduces the call; the detail page should render current
        // catalogue metrics instead.
        await page.RouteAsync("**/api/v1/*/metadata", async route =>
        {
            await route.FulfillAsync(new RouteFulfillOptions
            {
                ContentType = "application/json",
                Body = JsonSerializer.Serialize(new
                {
                    marketId = "test",
                    totalVolumeSubunits = 75000,
                    totalTrades = 25,
                    totalLiquiditySubunits = 200000,
                }),
            });
        });

        await TestHelpers.GotoMarketsAsync(page, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Click on the Bitcoin market card to navigate to detail
        var btcMarket = page.GetByText("Will Bitcoin reach $100K").First;
        await Assertions.Expect(btcMarket).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await btcMarket.ClickAsync();

        // Should navigate to market detail page
        await Assertions.Expect(page).ToHaveURLAsync(
            new System.Text.RegularExpressions.Regex(@"/markets/[a-f0-9]+"),
            new() { Timeout = 5_000 });

        // Market heading should be visible
        var heading = page.GetByRole(AriaRole.Heading, new() { Name = "Will Bitcoin reach" });
        await Assertions.Expect(heading).ToBeVisibleAsync(new() { Timeout = 10_000 });

        // Verify the detail header renders current catalogue metrics. The old
        // unique-trader metric was removed from the contract and UI surfaces.
        await Assertions.Expect(page.GetByLabel("Volume").First)
            .ToContainTextAsync("sats", new() { Timeout = 5_000 });
        await Assertions.Expect(page.GetByLabel("Liquidity").First)
            .ToContainTextAsync("sats", new() { Timeout = 5_000 });
    }

    [Fact]
    public async Task BookmarkButton_TogglesAndPersistsLocally()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await SetupComplete(page);

        // The bookmark flow must never call the matching engine.
        var likeCalls = new List<string>();
        await page.RouteAsync("**/api/v1/*/like", async route =>
        {
            likeCalls.Add(route.Request.Url);
            await route.AbortAsync();
        });

        await TestHelpers.GotoMarketsAsync(page, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Wait for seeded market cards to render
        var btcMarket = page.GetByText("Will Bitcoin reach $100K");
        await Assertions.Expect(btcMarket).ToBeVisibleAsync(new() { Timeout = 10_000 });

        // Click through to the detail page — bookmark button is in the header
        await btcMarket.First.ClickAsync();
        await Assertions.Expect(page).ToHaveURLAsync(
            new System.Text.RegularExpressions.Regex(@"/markets/[a-f0-9]+"),
            new() { Timeout = 5_000 });

        // Capture the market id from the URL so we can verify it lands in localStorage
        var url = page.Url;
        var marketId = url.Split('/').Last();

        var bookmarkButton = page.GetByTitle("Bookmark").First;
        await Assertions.Expect(bookmarkButton).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await Assertions.Expect(bookmarkButton).ToHaveAttributeAsync("aria-pressed", "false");

        var bookmarkIcon = bookmarkButton.Locator("svg");
        await Assertions.Expect(bookmarkIcon).ToHaveAttributeAsync("fill", "none");

        // Toggle bookmark on
        await bookmarkButton.ClickAsync();
        await Assertions.Expect(bookmarkButton).ToHaveAttributeAsync("aria-pressed", "true", new() { Timeout = 5_000 });
        await Assertions.Expect(bookmarkButton).ToHaveAttributeAsync("title", "Remove bookmark");
        await Assertions.Expect(bookmarkIcon).ToHaveAttributeAsync("fill", "currentColor", new() { Timeout = 5_000 });

        // Bookmark must persist to localStorage (Zustand persist middleware)
        var storedAfterBookmark = await page.EvaluateAsync<string?>("() => localStorage.getItem('bitcaster-bookmarks')");
        Assert.NotNull(storedAfterBookmark);
        Assert.Contains(marketId, storedAfterBookmark);

        // Toggle bookmark off
        await page.GetByTitle("Remove bookmark").First.ClickAsync();
        await Assertions.Expect(bookmarkButton).ToHaveAttributeAsync("aria-pressed", "false", new() { Timeout = 5_000 });
        await Assertions.Expect(bookmarkIcon).ToHaveAttributeAsync("fill", "none", new() { Timeout = 5_000 });

        var storedAfterUnbookmark = await page.EvaluateAsync<string?>("() => localStorage.getItem('bitcaster-bookmarks')");
        Assert.NotNull(storedAfterUnbookmark);
        Assert.DoesNotContain(marketId, storedAfterUnbookmark);

        // The matching engine like endpoint must never have been hit
        Assert.Empty(likeCalls);
    }

    public async Task DisposeAsync()
    {
        if (_browser is not null)
            await _browser.CloseAsync();

        _playwright?.Dispose();
    }

}
