using Microsoft.Playwright;

namespace BitCaster.E2ETest;

/// <summary>
/// Phase 4.2 — markets-page header restructure. The "BTC" yellow chip leaking
/// next to the politics / crypto rows on the P6 staging review is replaced
/// by a dedicated sort row (Trending / Popular / New) above the tag chip
/// row. Sort buttons are mutually exclusive, default Trending; tag chips
/// stay multi-select and live in the second row only.
/// </summary>
public class MarketsPageHeaderTests : IAsyncLifetime
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

    private async Task SetupComplete(IPage page) =>
        await TestHelpers.SetupComplete(page, TestPorts.Vite);

    private async Task NavigateToMarkets(IPage page)
    {
        await SetupComplete(page);
        await page.GotoAsync($"http://localhost:{TestPorts.Vite}/markets", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var anyMarketTitle = page.GetByText("Will Bitcoin reach $100K");
        await Assertions.Expect(anyMarketTitle).ToBeVisibleAsync(new() { Timeout = 10_000 });
    }

    /// <summary>
    /// T4.2.a — sort row renders the three dimensions, Trending highlighted
    /// by default.
    /// </summary>
    [Fact]
    public async Task SortBar_RendersThreeButtons_TrendingDefault()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);
        await NavigateToMarkets(page);

        var sortBar = page.GetByTestId("market-sort-bar");
        await Assertions.Expect(sortBar).ToBeVisibleAsync(new() { Timeout = 5_000 });

        var trending = page.GetByTestId("market-sort-trending");
        var popular = page.GetByTestId("market-sort-popular");
        var fresh = page.GetByTestId("market-sort-new");

        await Assertions.Expect(trending).ToBeVisibleAsync();
        await Assertions.Expect(popular).ToBeVisibleAsync();
        await Assertions.Expect(fresh).ToBeVisibleAsync();

        try
        {
            await Assertions.Expect(trending).ToHaveAttributeAsync("aria-selected", "true");
            await Assertions.Expect(popular).ToHaveAttributeAsync("aria-selected", "false");
            await Assertions.Expect(fresh).ToHaveAttributeAsync("aria-selected", "false");
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Default sort selection was not 'Trending'.");
        }
    }

    /// <summary>
    /// T4.2.d — the tag chip row never carries the sort dimensions. The user
    /// reported "BTC" leaking into a yellow chip — locking the negative
    /// assertion (no `Trending|Popular|New` text inside the tag chip row)
    /// catches the regression even if a future refactor merges the bars.
    /// </summary>
    [Fact]
    public async Task TagBar_NeverRendersSortDimensions()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);
        await NavigateToMarkets(page);

        var tagBar = page.GetByTestId("market-tag-bar");
        await Assertions.Expect(tagBar).ToBeVisibleAsync(new() { Timeout = 5_000 });

        // No element inside the tag bar matches the sort dimensions by text.
        try
        {
            await Assertions.Expect(tagBar.GetByText("Trending", new() { Exact = true }))
                .ToHaveCountAsync(0);
            await Assertions.Expect(tagBar.GetByText("Popular", new() { Exact = true }))
                .ToHaveCountAsync(0);
            await Assertions.Expect(tagBar.GetByText("New", new() { Exact = true }))
                .ToHaveCountAsync(0);
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Sort dimension chip leaked into the tag bar (Row 2).");
        }
    }

    /// <summary>
    /// T4.2.b — clicking "New" highlights it and clears Trending. The actual
    /// list re-order is exercised by the hook unit tests; the Playwright
    /// case asserts the wiring (selection state moves between buttons).
    /// </summary>
    [Fact]
    public async Task ClickingNew_SwitchesActiveSelection()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);
        await NavigateToMarkets(page);

        var trending = page.GetByTestId("market-sort-trending");
        var fresh = page.GetByTestId("market-sort-new");
        await fresh.ClickAsync();

        try
        {
            await Assertions.Expect(fresh).ToHaveAttributeAsync("aria-selected", "true");
            await Assertions.Expect(trending).ToHaveAttributeAsync("aria-selected", "false");
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Sort selection did not move from Trending to New on click.");
        }
    }

    /// <summary>
    /// T4.2.c — clicking "Popular" likewise wins exclusivity. Companion of
    /// the New click test for symmetric coverage.
    /// </summary>
    [Fact]
    public async Task ClickingPopular_SwitchesActiveSelection()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);
        await NavigateToMarkets(page);

        var trending = page.GetByTestId("market-sort-trending");
        var popular = page.GetByTestId("market-sort-popular");
        await popular.ClickAsync();

        try
        {
            await Assertions.Expect(popular).ToHaveAttributeAsync("aria-selected", "true");
            await Assertions.Expect(trending).ToHaveAttributeAsync("aria-selected", "false");
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Sort selection did not move from Trending to Popular on click.");
        }
    }

    public Task DisposeAsync()
    {
        _browser?.DisposeAsync().GetAwaiter().GetResult();
        _playwright?.Dispose();
        return Task.CompletedTask;
    }
}
