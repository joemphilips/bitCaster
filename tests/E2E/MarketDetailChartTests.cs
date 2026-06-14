using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Playwright;

namespace BitCaster.E2ETest;

public class MarketDetailChartTests : IAsyncLifetime
{
    private const string ConditionId = "a29ca000000000000000000000000000000000000000000000000000000000000";
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
            ViewportSize = new ViewportSize { Width = 390, Height = 844 },
        });
    }

    [Fact]
    public async Task MarketDetail_NonDefaultDenominatorChartAndCategoricalBooks_RenderWithScreenshotArtifact()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        await StubP29MarketAsync(page);

        await TestHelpers.SetupComplete(page, TestPorts.Vite);
        await page.GotoAsync($"{TestPorts.FrontendUrl}/markets/{ConditionId}", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        try
        {
            await Assertions.Expect(page.GetByRole(AriaRole.Heading, new() { Name = "P29 denominator chart market" }))
                .ToBeVisibleAsync(new() { Timeout = 10_000 });
            await Assertions.Expect(page.GetByTestId("price-chart-uplot"))
                .ToBeVisibleAsync(new() { Timeout = 10_000 });

            await Assertions.Expect(page.GetByTestId("latest-price-pill").Filter(new() { HasTextString = "Alice" }))
                .ToContainTextAsync("5%");
            await Assertions.Expect(page.GetByText("500%")).ToHaveCountAsync(0);

            var panels = page.GetByTestId("order-book-panel");
            await Assertions.Expect(panels).ToHaveCountAsync(3);
            await Assertions.Expect(panels.Nth(0).GetByRole(AriaRole.Heading, new() { Name = "Alice" }))
                .ToBeVisibleAsync();
            await Assertions.Expect(panels.Nth(1).GetByRole(AriaRole.Heading, new() { Name = "Bob" }))
                .ToBeVisibleAsync();
            await Assertions.Expect(panels.Nth(2).GetByRole(AriaRole.Heading, new() { Name = "Carol" }))
                .ToBeVisibleAsync();

            var tradingPanel = page.Locator("[data-trading-panel]")
                .Filter(new() { Visible = true })
                .First;
            await tradingPanel.GetByRole(AriaRole.Button, new() { Name = "Limit", Exact = true })
                .DispatchEventAsync("click");
            await tradingPanel.GetByTestId("buy-yes-Alice").ClickAsync();
            await Assertions.Expect(tradingPanel.GetByTestId("limit-price-input"))
                .ToHaveValueAsync("5000");

            var screenshotPath = ArtifactPath("p29-non-default-denominator-chart.png");
            await page.ScreenshotAsync(new PageScreenshotOptions
            {
                Path = screenshotPath,
                FullPage = true,
            });
            Assert.True(File.Exists(screenshotPath), $"Expected screenshot artifact at {screenshotPath}");
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                "P29 non-default denominator chart/orderbook browser assertion failed.");
        }
    }

    private static async Task StubP29MarketAsync(IPage page)
    {
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
                            conditionId = ConditionId,
                            outcomes = new[] { "Alice", "Bob", "Carol" },
                            title = "P29 denominator chart market",
                            description = "Frontend-owned chart scaling fixture",
                            thumbnailUrl = (string?)null,
                            creatorPubkey = (string?)null,
                            deadline = "2026-12-31T00:00:00Z",
                            state = "open",
                            createdAt = "2026-06-01T00:00:00Z",
                            volume24hSats = 0,
                            volume30dSats = 0,
                            liquiditySats = 30_000L,
                            traderCount = 3,
                            volumeLifetimeSats = 30_000L,
                            lastTradedPrice = 0.05m,
                            baseAsset = "sat",
                            divisibility = 10_000,
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
                    conditionId = ConditionId,
                    timeframe = "7d",
                    outcomes = new[]
                    {
                        PriceHistory("Alice", 500),
                        PriceHistory("Bob", 2_500),
                        PriceHistory("Carol", 7_000),
                    },
                }),
            });
        });

        await page.RouteAsync("**/api/v1/*/orderbook", async route =>
        {
            var marketId = ExtractMarketId(route.Request.Url);
            await route.FulfillAsync(new RouteFulfillOptions
            {
                Status = 200,
                ContentType = "application/json",
                Body = JsonSerializer.Serialize(new
                {
                    marketId,
                    bids = new[] { new { price = 400, amount = 10_000L } },
                    asks = new[] { new { price = 600, amount = 10_000L } },
                    spread = 200,
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
                    conditionId = ConditionId,
                    comments = Array.Empty<object>(),
                }),
            });
        });
    }

    private static object PriceHistory(string outcomeId, int price) => new
    {
        outcomeId,
        data = new[]
        {
            new { timestamp = "2026-06-01T00:00:00Z", price, volumeSats = 10_000L },
            new { timestamp = "2026-06-02T00:00:00Z", price, volumeSats = 10_000L },
        },
    };

    private static string ExtractMarketId(string url)
    {
        var match = Regex.Match(url, @"/api/v1/([^/]+)/orderbook");
        return match.Success ? Uri.UnescapeDataString(match.Groups[1].Value) : $"{ConditionId}-Alice";
    }

    private static string ArtifactPath(string fileName)
    {
        var dir = Environment.GetEnvironmentVariable("BITCASTER_E2E_ARTIFACT_DIR");
        if (string.IsNullOrWhiteSpace(dir))
        {
            dir = Path.Combine(Directory.GetCurrentDirectory(), "artifacts", "frontend-e2e");
        }
        Directory.CreateDirectory(dir);
        return Path.Combine(dir, fileName);
    }

    public async Task DisposeAsync()
    {
        if (_browser is not null)
            await _browser.CloseAsync();
        _playwright?.Dispose();
    }
}
