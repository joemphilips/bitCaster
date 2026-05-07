using Microsoft.Playwright;

namespace BitCaster.E2ETest;

public class MarketDiscoveryTests : IAsyncLifetime
{
    private IPlaywright? _playwright;
    private IBrowser? _browser;

    public async Task InitializeAsync()
    {
        // Verify all external services are reachable before launching Playwright
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        await Task.WhenAll(
            TestHelpers.WaitForService(httpClient, $"http://localhost:{TestPorts.Mint}/v1/info", "Mint"),
            TestHelpers.WaitForService(httpClient, $"http://localhost:{TestPorts.Server}/health", "Matching Engine"),
            TestHelpers.WaitForService(httpClient, $"http://localhost:{TestPorts.Vite}", "Frontend"));

        // Launch Playwright headless Chromium
        _playwright = await Playwright.CreateAsync();
        _browser = await _playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
        {
            Headless = true,
        });
    }

    /// <summary>
    /// Create a new browser context with service workers blocked for test isolation.
    /// </summary>
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
    public async Task NavigateToMarkets_ShowsSeededMarketCards()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await SetupComplete(page);
        await TestHelpers.GotoMarketsAsync(page, new PageGotoOptions
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
    public async Task NavigateToMarkets_WithSearch_ShowsMatchingSeededMarketOnly()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await SetupComplete(page);
        await TestHelpers.GotoMarketsAsync(page, "?search=NBA", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var nbaMarket = page.GetByText("2026 NBA Championship Winner");
        await Assertions.Expect(nbaMarket).ToBeVisibleAsync(new() { Timeout = 10_000 });

        var btcMarket = page.GetByText("Will Bitcoin reach $100K");
        await Assertions.Expect(btcMarket).ToHaveCountAsync(0);
    }

    [Fact]
    public async Task ClickBuyYes_NavigatesToMarketDetail()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await SetupComplete(page);
        await TestHelpers.GotoMarketsAsync(page, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Wait for cards to load, then click Buy YES on the first card
        var buyYesButton = page.GetByRole(AriaRole.Button, new() { Name = "Buy YES" }).First;
        await Assertions.Expect(buyYesButton).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await buyYesButton.ClickAsync();

        // Should navigate to market detail page
        await Assertions.Expect(page).ToHaveURLAsync(new System.Text.RegularExpressions.Regex(@"/markets/[a-f0-9]+"), new() { Timeout = 5_000 });

        // The market detail page shows the market title as an h1 heading
        var heading = page.GetByRole(AriaRole.Heading, new() { Name = "Will Bitcoin reach" });
        await Assertions.Expect(heading).ToBeVisibleAsync(new() { Timeout = 10_000 });
    }

    [Fact]
    public async Task NewUser_SeesMarketsWithoutWalletSetup()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        // No SetupComplete — fresh user with no wallet
        await page.GotoAsync($"http://localhost:{TestPorts.Vite}/", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Should NOT be redirected to /setup — should see markets
        await Assertions.Expect(page).Not.ToHaveURLAsync(new System.Text.RegularExpressions.Regex(@"/setup"));

        // Market cards should be visible
        var btcMarket = page.GetByText("Will Bitcoin reach $100K");
        await Assertions.Expect(btcMarket).ToBeVisibleAsync(new() { Timeout = 10_000 });
    }

    [Fact]
    public async Task NewUser_ClickBuyYes_ShowsWalletRequiredModal()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        // No wallet setup
        await TestHelpers.GotoMarketsAsync(page, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Click Buy YES on a market card
        var buyYesButton = page.GetByRole(AriaRole.Button, new() { Name = "Buy YES" }).First;
        await Assertions.Expect(buyYesButton).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await buyYesButton.ClickAsync();

        // Should show wallet required modal
        var modalHeading = page.GetByText("Wallet Required");
        await Assertions.Expect(modalHeading).ToBeVisibleAsync(new() { Timeout = 5_000 });

        var createButton = page.GetByRole(AriaRole.Button, new() { Name = "Create Wallet" });
        await Assertions.Expect(createButton).ToBeVisibleAsync();
    }

    [Fact]
    public async Task NewUser_WalletModal_CreateButton_NavigatesToSetup()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await TestHelpers.GotoMarketsAsync(page, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Trigger wallet required modal via Buy YES
        var buyYesButton = page.GetByRole(AriaRole.Button, new() { Name = "Buy YES" }).First;
        await Assertions.Expect(buyYesButton).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await buyYesButton.ClickAsync();

        // Click "Create Wallet" in the modal
        var createButton = page.GetByRole(AriaRole.Button, new() { Name = "Create Wallet" });
        await Assertions.Expect(createButton).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await createButton.ClickAsync();

        // Should navigate to /setup
        await Assertions.Expect(page).ToHaveURLAsync(new System.Text.RegularExpressions.Regex(@"/setup"), new() { Timeout = 5_000 });
    }

    [Fact]
    public async Task NewUser_CanBrowseMarketDetail()
    {
        Assert.NotNull(_browser);
        // Use mobile viewport so the sticky bottom trade bar is visible
        await using var context = await _browser.NewContextAsync(new BrowserNewContextOptions
        {
            ServiceWorkers = ServiceWorkerPolicy.Block,
            ViewportSize = new ViewportSize { Width = 390, Height = 844 },
        });
        var page = await context.NewPageAsync();
        // No wallet setup
        await TestHelpers.GotoMarketsAsync(page, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Click on a market card (not the Buy button) to navigate to detail
        var btcMarket = page.GetByText("Will Bitcoin reach $100K").First;
        await Assertions.Expect(btcMarket).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await btcMarket.ClickAsync();

        // Should navigate to market detail
        await Assertions.Expect(page).ToHaveURLAsync(new System.Text.RegularExpressions.Regex(@"/markets/[a-f0-9]+"), new() { Timeout = 5_000 });

        // Market heading should be visible
        var heading = page.GetByRole(AriaRole.Heading, new() { Name = "Will Bitcoin reach" });
        await Assertions.Expect(heading).ToBeVisibleAsync(new() { Timeout = 10_000 });

        // Mobile sticky bar should show wallet CTA
        var walletCta = page.GetByText("Create Wallet to Trade");
        await Assertions.Expect(walletCta).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    [Fact]
    public async Task EngineUnavailable_ShowsErrorState()
    {
        await using var context = await NewIsolatedContextAsync();
        // This test verifies the error state when the matching engine is down.
        // Pre-Phase 2 the markets-list page hit mintd directly; per ADR-009
        // it now consumes the engine's `/api/v1/markets/query` catalogue
        // proxy, so a 5xx / aborted call from the engine is the failure mode
        // that surfaces the empty-state UI.
        var page = await context.NewPageAsync();
        await SetupComplete(page);

        // Block the engine markets-query proxy to simulate failure
        await page.RouteAsync("**/api/v1/markets/query*", route => route.AbortAsync());

        await TestHelpers.GotoMarketsAsync(page, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Should show error message
        var errorText = page.GetByText("Failed to load markets");
        await Assertions.Expect(errorText).ToBeVisibleAsync(new() { Timeout = 10_000 });

        // Should show retry button.
        var retryButton = page.GetByRole(AriaRole.Button, new() { Name = "Retry" });
        await Assertions.Expect(retryButton).ToBeVisibleAsync();
    }

    public async Task DisposeAsync()
    {
        if (_browser is not null)
            await _browser.CloseAsync();

        _playwright?.Dispose();
    }

}
