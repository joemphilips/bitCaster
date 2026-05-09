using Microsoft.Playwright;

namespace BitCaster.E2ETest;

/// <summary>
/// E2E tests for the creator dashboard at <c>/creator</c>.
///
/// The dashboard reads created markets from the client-side
/// <c>bitcaster-creator-markets</c> Zustand store (persisted to localStorage)
/// and enriches entries with volume from
/// <c>GET /api/v1/creators/{pubkey}/markets</c>. These tests seed the store
/// directly instead of running the whole 6-step wizard — the wizard flow has
/// its own coverage in <c>MarketCreationTests</c>.
/// </summary>
public class CreatorDashboardTests : IAsyncLifetime
{
    private IPlaywright? _playwright;
    private IBrowser? _browser;

    public async Task InitializeAsync()
    {
        // Verify all external services are reachable before launching Playwright
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

    /// <summary>
    /// Inject a single stored creator market into the Zustand persist key so
    /// the dashboard can render a non-empty state without running the wizard.
    /// Must be called on a page that has already navigated under the Vite origin
    /// so localStorage is writable.
    /// </summary>
    private static async Task SeedCreatorMarketsAsync(
        IPage page,
        string conditionId,
        string title,
        bool selfOracle = false)
    {
        var oracleJson = selfOracle
            ? @",
                        oracle: {
                            type: 'self',
                            eventId: 'seeded_creator_market_event',
                            outcomes: ['Yes', 'No']
                        }"
            : "";

        await page.EvaluateAsync($@"
            localStorage.setItem('bitcaster-creator-markets', JSON.stringify({{
                state: {{
                    markets: [{{
                        conditionId: '{conditionId}',
                        title: '{title}',
                        thumbnailUrl: null,
                        createdAt: '2026-04-10T00:00:00.000Z',
                        creatorFeePercent: 0.02
                        {oracleJson}
                    }}]
                }},
                version: 0
            }}));
        ");
    }

    [Fact]
    public async Task NavigateToCreator_ShowsDashboardHeaderAndEmptyState()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await SetupComplete(page);

        await page.GotoAsync($"{TestPorts.FrontendUrl}/creator", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Header is visible. `Exact = true` is important — a substring match
        // also hits the "Loading your markets…" heading during initial load,
        // which trips Playwright's strict-mode check.
        var heading = page.GetByRole(AriaRole.Heading, new() { Name = "Your Markets", Exact = true });
        await Assertions.Expect(heading).ToBeVisibleAsync();

        // Create Market CTA (header button) is visible
        var createButton = page.GetByRole(AriaRole.Button, new() { Name = "Create Market" }).First;
        await Assertions.Expect(createButton).ToBeVisibleAsync();

        // Empty-state heading is visible because no markets are seeded
        var emptyHeading = page.GetByRole(AriaRole.Heading, new() { Name = "Create your first market" });
        await Assertions.Expect(emptyHeading).ToBeVisibleAsync();

        // Stats grid labels are present
        await Assertions.Expect(page.GetByText("Active Markets")).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("Total Volume")).ToBeVisibleAsync();
    }

    [Fact]
    public async Task ClickCreateMarketCta_NavigatesToWizard()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await SetupComplete(page);

        await page.GotoAsync($"{TestPorts.FrontendUrl}/creator", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Click the first "Create Market" button (header CTA)
        var createButton = page.GetByRole(AriaRole.Button, new() { Name = "Create Market" }).First;
        await Assertions.Expect(createButton).ToBeVisibleAsync();
        await createButton.ClickAsync();

        // Should navigate to the wizard at /creator/new
        await Assertions.Expect(page).ToHaveURLAsync(
            new System.Text.RegularExpressions.Regex(@"/creator/new"),
            new() { Timeout = 5_000 });
    }

    [Fact]
    public async Task SeededCreatorMarket_IsRenderedInMyMarkets()
    {
        const string conditionId = "deadbeefcafe00000000000000000000000000000000000000000000000000ab";
        const string title = "Seeded Creator Market";

        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await SetupComplete(page);

        // First navigate to /creator so the Vite origin is active, then seed
        // localStorage and reload so the Zustand persist hydrate picks it up.
        await page.GotoAsync($"{TestPorts.FrontendUrl}/creator", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });
        await SeedCreatorMarketsAsync(page, conditionId, title);
        await page.ReloadAsync(new PageReloadOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Header + seeded market title should be visible
        var heading = page.GetByRole(AriaRole.Heading, new() { Name = "Your Markets" });
        await Assertions.Expect(heading).ToBeVisibleAsync();

        var seededTitle = page.GetByText(title);
        await Assertions.Expect(seededTitle).ToBeVisibleAsync(new() { Timeout = 10_000 });

        // Empty state should NOT be shown
        var emptyHeading = page.GetByRole(AriaRole.Heading, new() { Name = "Create your first market" });
        await Assertions.Expect(emptyHeading).Not.ToBeVisibleAsync();
    }

    [Fact]
    public async Task SeededSelfOracleMarket_ShowsCloseMarketControl()
    {
        const string conditionId = "deadc0de000000000000000000000000000000000000000000000000000000ab";
        const string title = "Seeded Self Oracle Market";

        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await SetupComplete(page);

        await page.GotoAsync($"{TestPorts.FrontendUrl}/creator", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });
        await SeedCreatorMarketsAsync(page, conditionId, title, selfOracle: true);
        await page.ReloadAsync(new PageReloadOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        await Assertions.Expect(page.GetByText(title)).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await Assertions.Expect(page.GetByLabel("Winning outcome for Seeded Self Oracle Market")).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByRole(AriaRole.Button, new() { Name = "Close market" })).ToBeVisibleAsync();
    }

    [Fact]
    public async Task AnalyticsTab_ShowsComingSoonPlaceholder()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await SetupComplete(page);

        await page.GotoAsync($"{TestPorts.FrontendUrl}/creator", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var analyticsTab = page.GetByRole(AriaRole.Button, new() { Name = "Analytics" });
        await Assertions.Expect(analyticsTab).ToBeVisibleAsync();
        await analyticsTab.ClickAsync();

        var comingSoon = page.GetByRole(AriaRole.Heading, new() { Name = "Analytics coming soon" });
        await Assertions.Expect(comingSoon).ToBeVisibleAsync();
    }

    [Fact]
    public async Task NoWallet_ShowsWalletPrompt()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        // No SetupComplete — no wallet / no mnemonic
        await page.GotoAsync($"{TestPorts.FrontendUrl}/creator", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Header still renders
        var heading = page.GetByRole(AriaRole.Heading, new() { Name = "Your Markets" });
        await Assertions.Expect(heading).ToBeVisibleAsync();

        // Amber wallet prompt is visible
        var walletPrompt = page.GetByText("Set up a wallet to start creating markets");
        await Assertions.Expect(walletPrompt).ToBeVisibleAsync();
    }

    public async Task DisposeAsync()
    {
        if (_browser is not null)
            await _browser.CloseAsync();

        _playwright?.Dispose();
    }
}
