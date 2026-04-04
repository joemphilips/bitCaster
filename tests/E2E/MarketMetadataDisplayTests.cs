using System.Text.Json;
using Microsoft.Playwright;

namespace BitCaster.E2ETest;

public class MarketMetadataDisplayTests : IAsyncLifetime
{
    private IPlaywright? _playwright;
    private IBrowser? _browser;
    private const int VitePort = 5173;
    private const int MintPort = 8085;
    private const int ServerPort = 5000;

    public async Task InitializeAsync()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        await WaitForService(httpClient, $"http://localhost:{MintPort}/v1/info", "Mint (port 8085)");
        await WaitForService(httpClient, $"http://localhost:{ServerPort}/health", "Matching Engine (port 5000)");
        await WaitForService(httpClient, $"http://localhost:{VitePort}", "Frontend (port 5173)");

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

    private async Task SetupComplete(IPage page)
    {
        await page.GotoAsync($"http://localhost:{VitePort}/setup", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.DOMContentLoaded,
            Timeout = 30_000,
        });
        await page.EvaluateAsync(@"
            localStorage.setItem('bitcaster-wallet', JSON.stringify({
                state: {
                    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
                    setupComplete: true,
                    mints: [],
                    activeMintUrl: 'http://localhost:3338',
                    keysetCounters: {}
                },
                version: 0
            }));
        ");
    }

    [Fact]
    public async Task MarketCards_DisplayMetadataFromMatchingEngine()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await SetupComplete(page);

        // Intercept metadata API calls and return known values
        await page.RouteAsync("**/api/v1/*/metadata", async route =>
        {
            await route.FulfillAsync(new RouteFulfillOptions
            {
                ContentType = "application/json",
                Body = JsonSerializer.Serialize(new
                {
                    marketId = "test",
                    totalVolumeSats = 50000,
                    totalTrades = 15,
                    uniqueTraderCount = 42,
                    totalLiquiditySats = 100000,
                    likeCount = 7,
                    isLiked = false,
                }),
            });
        });

        await page.GotoAsync($"http://localhost:{VitePort}/markets", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Wait for seeded market cards to render
        var btcMarket = page.GetByText("Will Bitcoin reach $100K");
        await Assertions.Expect(btcMarket).ToBeVisibleAsync(new() { Timeout = 10_000 });

        // Verify that metadata values are displayed (42 traders should appear)
        var traderCount = page.GetByText("42");
        await Assertions.Expect(traderCount.First).ToBeVisibleAsync(new() { Timeout = 5_000 });

        // Verify like count is displayed
        var likeCount = page.GetByText("7");
        await Assertions.Expect(likeCount.First).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    [Fact]
    public async Task MarketCards_GracefulDegradation_WhenMetadataUnavailable()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await SetupComplete(page);

        // Block the metadata API to simulate matching engine down
        await page.RouteAsync("**/api/v1/*/metadata", async route => await route.AbortAsync());

        await page.GotoAsync($"http://localhost:{VitePort}/markets", new PageGotoOptions
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

        // Intercept metadata API calls with known values
        await page.RouteAsync("**/api/v1/*/metadata", async route =>
        {
            await route.FulfillAsync(new RouteFulfillOptions
            {
                ContentType = "application/json",
                Body = JsonSerializer.Serialize(new
                {
                    marketId = "test",
                    totalVolumeSats = 75000,
                    totalTrades = 25,
                    uniqueTraderCount = 100,
                    totalLiquiditySats = 200000,
                    likeCount = 12,
                    isLiked = false,
                }),
            });
        });

        await page.GotoAsync($"http://localhost:{VitePort}/markets", new PageGotoOptions
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

        // Verify trader count is displayed on detail page
        var traderCount = page.GetByText("100");
        await Assertions.Expect(traderCount.First).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    [Fact]
    public async Task LikeButton_TogglesOnClick()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await SetupComplete(page);

        // Intercept metadata — start with isLiked=false, likeCount=3
        await page.RouteAsync("**/api/v1/*/metadata", async route =>
        {
            await route.FulfillAsync(new RouteFulfillOptions
            {
                ContentType = "application/json",
                Body = JsonSerializer.Serialize(new
                {
                    marketId = "test",
                    totalVolumeSats = 10000,
                    totalTrades = 5,
                    uniqueTraderCount = 10,
                    totalLiquiditySats = 50000,
                    likeCount = 3,
                    isLiked = false,
                }),
            });
        });

        // Track like API calls
        var likeCalls = new List<string>();
        await page.RouteAsync("**/api/v1/*/like", async route =>
        {
            var request = route.Request;
            var body = request.PostData ?? "";
            likeCalls.Add(body);

            // First call: like (3 → 4)
            // Second call: unlike (4 → 3)
            var isFirstCall = likeCalls.Count == 1;
            await route.FulfillAsync(new RouteFulfillOptions
            {
                ContentType = "application/json",
                Body = JsonSerializer.Serialize(new
                {
                    likeCount = isFirstCall ? 4 : 3,
                    isLiked = isFirstCall,
                }),
            });
        });

        await page.GotoAsync($"http://localhost:{VitePort}/markets", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Wait for market cards to render
        var btcMarket = page.GetByText("Will Bitcoin reach $100K");
        await Assertions.Expect(btcMarket).ToBeVisibleAsync(new() { Timeout = 10_000 });

        // Verify initial like count is 3 and heart is not filled (not rose-500)
        var likeButtons = page.GetByTitle("Like");
        var firstLikeButton = likeButtons.First;
        await Assertions.Expect(firstLikeButton).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await Assertions.Expect(firstLikeButton).ToContainTextAsync("3");

        // Verify the heart SVG is not filled initially
        var heartIcon = firstLikeButton.Locator("svg");
        await Assertions.Expect(heartIcon).ToHaveAttributeAsync("fill", "none");

        // Click the like button
        await firstLikeButton.ClickAsync();

        // Verify the API was called with a userId in the body
        Assert.Single(likeCalls);
        Assert.Contains("userId", likeCalls[0]);

        // Verify the like count updated to 4 and heart is filled
        await Assertions.Expect(firstLikeButton).ToContainTextAsync("4", new() { Timeout = 5_000 });
        await Assertions.Expect(heartIcon).ToHaveAttributeAsync("fill", "currentColor", new() { Timeout = 5_000 });

        // Click again to unlike
        await firstLikeButton.ClickAsync();

        // Verify toggled back to 3 and heart is unfilled
        await Assertions.Expect(firstLikeButton).ToContainTextAsync("3", new() { Timeout = 5_000 });
        await Assertions.Expect(heartIcon).ToHaveAttributeAsync("fill", "none", new() { Timeout = 5_000 });
    }

    public async Task DisposeAsync()
    {
        if (_browser is not null)
            await _browser.CloseAsync();

        _playwright?.Dispose();
    }

    private static async Task WaitForService(HttpClient httpClient, string url, string serviceName)
    {
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var response = await httpClient.GetAsync(url);
                if (response.IsSuccessStatusCode)
                    return;
            }
            catch
            {
                // Not ready yet
            }
            await Task.Delay(TimeSpan.FromSeconds(1));
        }

        throw new InvalidOperationException(
            $"{serviceName} is not reachable at {url}. " +
            "Start all services before running E2E tests. See AGENTS.md for the 3-terminal workflow.");
    }
}
