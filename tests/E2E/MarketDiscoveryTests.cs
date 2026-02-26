using Microsoft.Playwright;

namespace BitCaster.E2ETest;

public class MarketDiscoveryTests : IAsyncLifetime
{
    private IPlaywright? _playwright;
    private IBrowser? _browser;
    private const int VitePort = 5173;
    private const int MintPort = 8085;
    private const int ServerPort = 5000;

    public async Task InitializeAsync()
    {
        // Verify all external services are reachable before launching Playwright
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        await WaitForService(httpClient, $"http://localhost:{MintPort}/v1/info", "Mint (port 8085)");
        await WaitForService(httpClient, $"http://localhost:{ServerPort}/health", "Matching Engine (port 5000)");
        await WaitForService(httpClient, $"http://localhost:{VitePort}", "Frontend (port 5173)");

        // Launch Playwright headless Chromium
        _playwright = await Playwright.CreateAsync();
        _browser = await _playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
        {
            Headless = true,
        });
    }

    [Fact]
    public async Task NavigateToMarkets_ShowsSeededMarketCards()
    {
        Assert.NotNull(_browser);

        var page = await _browser.NewPageAsync();
        await page.GotoAsync($"http://localhost:{VitePort}/markets", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Seeded market cards should be visible
        var btcMarket = page.GetByText("Will Bitcoin reach $100K");
        await Assertions.Expect(btcMarket).ToBeVisibleAsync(new() { Timeout = 10_000 });

        var nbaMarket = page.GetByText("2026 NBA Championship Winner");
        await Assertions.Expect(nbaMarket).ToBeVisibleAsync();

        var fedMarket = page.GetByText("Fed Q1 2026 Rate Decision");
        await Assertions.Expect(fedMarket).ToBeVisibleAsync();
    }

    [Fact]
    public async Task ClickBuyYes_OpensTradingOverlay()
    {
        Assert.NotNull(_browser);

        var page = await _browser.NewPageAsync();
        await page.GotoAsync($"http://localhost:{VitePort}/markets", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Wait for cards to load, then click Buy YES on the first card
        var buyYesButton = page.GetByRole(AriaRole.Button, new() { Name = "Buy YES" }).First;
        await Assertions.Expect(buyYesButton).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await buyYesButton.ClickAsync();

        // Trading overlay should appear with amount input and BUY button
        var amountInput = page.GetByRole(AriaRole.Spinbutton);
        await Assertions.Expect(amountInput).ToBeVisibleAsync(new() { Timeout = 5_000 });

        var confirmButton = page.GetByRole(AriaRole.Button, new() { NameRegex = new("^BUY") });
        await Assertions.Expect(confirmButton).ToBeVisibleAsync();
    }

    [Fact]
    public async Task MintUnavailable_ShowsErrorState()
    {
        Assert.NotNull(_browser);

        // This test verifies the error state when mint is down.
        // We navigate with a broken proxy to simulate unavailability.
        var page = await _browser.NewPageAsync();

        // Block the mint API to simulate failure
        await page.RouteAsync("**/v1/conditions", route => route.AbortAsync());

        await page.GotoAsync($"http://localhost:{VitePort}/markets", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Should show error message
        var errorText = page.GetByText("Failed to load markets");
        await Assertions.Expect(errorText).ToBeVisibleAsync(new() { Timeout = 10_000 });

        // Should show retry button
        var retryButton = page.GetByRole(AriaRole.Button, new() { Name = "Retry" });
        await Assertions.Expect(retryButton).ToBeVisibleAsync();
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
