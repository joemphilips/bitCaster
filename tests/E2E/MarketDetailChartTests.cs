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
            RecordVideoDir = ArtifactDirectory(),
            RecordVideoSize = new RecordVideoSize { Width = 390, Height = 844 },
        });
    }

    [Fact]
    public async Task MarketDetail_P34ChartTimeframeAndTopNCategoricalBooks_RenderWithArtifacts()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);
        var requestedTimeframes = new List<string>();

        await context.Tracing.StartAsync(new()
        {
            Screenshots = true,
            Snapshots = true,
            Sources = false,
        });

        await StubP34MarketAsync(page, requestedTimeframes);
        await page.RouteAsync("**/hubs/market/negotiate*", async route =>
        {
            await route.AbortAsync();
        });

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
            await Assertions.Expect(panels.Nth(0).GetByTestId("order-book-bid-row"))
                .ToHaveCountAsync(5);
            await Assertions.Expect(panels.Nth(0).GetByTestId("order-book-ask-row"))
                .ToHaveCountAsync(5);

            var tradingPanel = page.Locator("[data-trading-panel]")
                .Filter(new() { Visible = true })
                .First;
            await tradingPanel.GetByRole(AriaRole.Button, new() { Name = "Limit", Exact = true })
                .DispatchEventAsync("click");
            await tradingPanel.GetByTestId("buy-yes-Alice").ClickAsync();
            await Assertions.Expect(tradingPanel.GetByTestId("limit-price-input"))
                .ToHaveValueAsync("5000");

            await page.GetByRole(AriaRole.Button, new() { Name = "1H" }).ClickAsync();
            await Assertions.Expect(page.GetByTestId("latest-price-pill").Filter(new() { HasTextString = "Alice" }))
                .ToContainTextAsync("6%");
            Assert.Contains("1h", requestedTimeframes);

            var screenshotPath = ArtifactPath("p34-chart-timeframe-top-n-categorical-books.png");
            await page.ScreenshotAsync(new PageScreenshotOptions
            {
                Path = screenshotPath,
                FullPage = true,
            });
            Assert.True(File.Exists(screenshotPath), $"Expected screenshot artifact at {screenshotPath}");

            var tracePath = ArtifactPath("p34-chart-timeframe-top-n-categorical-books-trace.zip");
            await context.Tracing.StopAsync(new() { Path = tracePath });
            Assert.True(File.Exists(tracePath), $"Expected trace artifact at {tracePath}");
            await WriteArtifactManifestAsync(screenshotPath, tracePath);
        }
        catch
        {
            await StopTracingBestEffortAsync(context);
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                "P34 chart/timeframe/top-N orderbook browser assertion failed.");
        }
    }

    private static async Task StubP34MarketAsync(IPage page, List<string> requestedTimeframes)
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
                            volume24hSubunits = 0,
                            volume30dSubunits = 0,
                            liquiditySubunits = 30_000L,
                    ammBotBudgetSubunits = 30_000L,
                            traderCount = 3,
                            volumeLifetimeSubunits = 30_000L,
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
            var timeframe = ExtractQueryParameter(route.Request.Url, "timeframe") ?? "7d";
            requestedTimeframes.Add(timeframe);
            await route.FulfillAsync(new RouteFulfillOptions
            {
                Status = 200,
                ContentType = "application/json",
                Body = JsonSerializer.Serialize(new
                {
                    conditionId = ConditionId,
                    timeframe,
                    outcomes = new[]
                    {
                        PriceHistory("Alice", timeframe == "1h" ? 600 : 500),
                        PriceHistory("Bob", timeframe == "1h" ? 2_400 : 2_500),
                        PriceHistory("Carol", timeframe == "1h" ? 7_000 : 7_000),
                    },
                }),
            });
        });

        await page.RouteAsync("**/api/v1/**/orderbook", async route =>
        {
            var marketId = ExtractMarketId(route.Request.Url);
            await route.FulfillAsync(new RouteFulfillOptions
            {
                Status = 200,
                ContentType = "application/json",
                    Body = JsonSerializer.Serialize(new
                    {
                        marketId,
                    bids = Enumerable.Range(0, 6)
                        .Select(i => new { price = 400 - i * 10, amount = 10_000L - i * 100L })
                        .ToArray(),
                    asks = Enumerable.Range(0, 6)
                        .Select(i => new { price = 600 + i * 10, amount = 10_000L - i * 100L })
                        .ToArray(),
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
            new { timestamp = "2026-06-01T00:00:00Z", price, volumeSubunits = 10_000L, volumeSubunits = 10_000L, source = "initial" },
            new { timestamp = "2026-06-02T00:00:00Z", price, volumeSubunits = 10_000L, volumeSubunits = 10_000L, source = "fill" },
        },
    };

    private static string ExtractMarketId(string url)
    {
        var match = Regex.Match(url, @"/api/v1/([^/]+)/orderbook");
        return match.Success ? Uri.UnescapeDataString(match.Groups[1].Value) : $"{ConditionId}-Alice";
    }

    private static string? ExtractQueryParameter(string url, string name)
    {
        var uri = new Uri(url);
        var query = uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries);
        foreach (var part in query)
        {
            var pieces = part.Split('=', 2);
            if (pieces.Length == 2 && Uri.UnescapeDataString(pieces[0]) == name)
            {
                return Uri.UnescapeDataString(pieces[1]);
            }
        }

        return null;
    }

    private static string ArtifactPath(string fileName)
    {
        return Path.Combine(ArtifactDirectory(), fileName);
    }

    private static string ArtifactDirectory()
    {
        var dir = Environment.GetEnvironmentVariable("BITCASTER_E2E_ARTIFACT_DIR");
        if (string.IsNullOrWhiteSpace(dir))
        {
            dir = Path.Combine(Directory.GetCurrentDirectory(), "artifacts", "frontend-e2e");
        }
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static async Task WriteArtifactManifestAsync(string screenshotPath, string tracePath)
    {
        var manifestPath = ArtifactPath("p34-chart-timeframe-top-n-categorical-books-manifest.json");
        var manifest = new
        {
            scenario = "P34 mock-stack chart timeframe and top-N categorical orderbook",
            route = $"/markets/{ConditionId}",
            viewport = new { width = 390, height = 844 },
            artifacts = new[]
            {
                Path.GetFileName(screenshotPath),
                Path.GetFileName(tracePath),
            },
            assertions = new[]
            {
                "sat/10000 chart prices render as percentages, not inflated values",
                "timeframe button refetches chart history and updates latest price",
                "categorical market renders one orderbook panel per outcome",
                "orderbook tables cap visible bid/ask rows at five",
            },
            redactionConfirmation = "The fixture is route-stubbed and contains no wallet seed, nsec, Cashu token, bearer token, or LNBits admin key.",
        };
        await File.WriteAllTextAsync(
            manifestPath,
            JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }));
    }

    private static async Task StopTracingBestEffortAsync(IBrowserContext context)
    {
        try
        {
            await context.Tracing.StopAsync();
        }
        catch
        {
            // Diagnostics must not hide the test assertion failure.
        }
    }

    public async Task DisposeAsync()
    {
        if (_browser is not null)
            await _browser.CloseAsync();
        _playwright?.Dispose();
    }
}
