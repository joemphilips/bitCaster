using System.Text.RegularExpressions;
using Microsoft.Playwright;

namespace BitCaster.E2ETest;

/// <summary>
/// Regression coverage for the trade-panel top-up entry point. These tests use
/// the seeded sat market from the docker-compose E2E stack rather than creating
/// a fully-funded USD AMM market: the regression we need to pin is that an
/// under-funded buy opens the reusable TopUpOverlay with both Lightning and
/// ecash payment paths available, and that the trade-panel copy is unit-aware.
/// </summary>
public class EcashFirstPaymentTests : IAsyncLifetime
{
    private const string TestNsec = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";

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

    public async Task DisposeAsync()
    {
        if (_browser is not null)
            await _browser.CloseAsync();
        _playwright?.Dispose();
    }

    private async Task<IBrowserContext> NewIsolatedContextAsync()
    {
        Assert.NotNull(_browser);
        return await _browser.NewContextAsync(new BrowserNewContextOptions
        {
            ServiceWorkers = ServiceWorkerPolicy.Block,
        });
    }

    private static async Task SetupWalletAsync(IPage page)
    {
        await TestHelpers.SetupComplete(page, TestPorts.Vite, TestPorts.MintUrl);
        await page.EvaluateAsync($@"
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
    }

    private static async Task GoToSeededSatMarketAsync(IPage page)
    {
        await TestHelpers.GotoMarketsAsync(page, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var firstSeededMarket = page.GetByText("Will Bitcoin reach $100K").First;
        await Assertions.Expect(firstSeededMarket).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await firstSeededMarket.ClickAsync();

        await Assertions.Expect(page).ToHaveURLAsync(
            new Regex(@"/markets/[a-f0-9]+"),
            new() { Timeout = 5_000 });
    }

    private static async Task SelectUnderfundedLimitBuyAsync(IPage page)
    {
        var tradingPanel = page.Locator("[data-trading-panel]")
            .Filter(new() { Visible = true })
            .First;

        var yesSide = tradingPanel.GetByRole(AriaRole.Button, new()
            {
                NameRegex = new Regex("^Yes\\s", RegexOptions.IgnoreCase),
            })
            .First;
        await Assertions.Expect(yesSide).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await yesSide.ClickAsync();

        var limitOrder = tradingPanel.GetByRole(AriaRole.Button, new() { Name = "Limit", Exact = true })
            .Filter(new() { Visible = true })
            .First;
        await Assertions.Expect(limitOrder).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await limitOrder.DispatchEventAsync("click");

        var amountInput = tradingPanel.GetByTestId("trade-amount-input");
        await Assertions.Expect(amountInput).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await amountInput.FillAsync("1");

        var limitPriceInput = tradingPanel.GetByTestId("limit-price-input");
        await Assertions.Expect(limitPriceInput).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await limitPriceInput.FillAsync("0.4");
        await limitPriceInput.BlurAsync();
    }

    private static ILocator VisibleTradeConfirm(IPage page) =>
        page.GetByTestId("trade-confirm")
            .Filter(new() { Visible = true })
            .First;

    private static async Task OpenTradeTopUpOverlayAsync(IPage page, IReadOnlyList<string> consoleMessages)
    {
        await SelectUnderfundedLimitBuyAsync(page);

        var confirm = VisibleTradeConfirm(page);
        try
        {
            await Assertions.Expect(confirm).ToHaveTextAsync(
                new Regex("Top up .+ wallet", RegexOptions.IgnoreCase),
                new() { Timeout = 5_000 });
            await Assertions.Expect(confirm).ToBeEnabledAsync(new() { Timeout = 5_000 });
            await confirm.ClickAsync();
            await Assertions.Expect(page.GetByTestId("top-up-method-lightning"))
                .ToBeVisibleAsync(new() { Timeout = 5_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                "Under-funded trade did not expose the unit-aware top-up action or open TopUpOverlay.");
        }
    }

    [Fact]
    public async Task InsufficientBuy_OpensTopUpOverlay_WithLightningAndEcashMethods()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        await SetupWalletAsync(page);
        await GoToSeededSatMarketAsync(page);

        await OpenTradeTopUpOverlayAsync(page, consoleMessages);

        await Assertions.Expect(page.GetByTestId("top-up-method-lightning"))
            .ToBeVisibleAsync(new() { Timeout = 5_000 });
        await Assertions.Expect(page.GetByTestId("top-up-method-ecash"))
            .ToBeVisibleAsync(new() { Timeout = 5_000 });

        await page.GetByTestId("top-up-method-ecash").ClickAsync();
        await Assertions.Expect(page.GetByTestId("top-up-ecash-input"))
            .ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    [Fact]
    public async Task InsufficientBuy_LightningContinueRequiresAmountCoveringDeficit()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        await SetupWalletAsync(page);
        await GoToSeededSatMarketAsync(page);
        await OpenTradeTopUpOverlayAsync(page, consoleMessages);

        var amountInput = page.GetByTestId("top-up-amount-input");
        var continueButton = page.GetByTestId("top-up-continue");

        await amountInput.FillAsync("0");
        await Assertions.Expect(continueButton).ToBeDisabledAsync(new() { Timeout = 5_000 });

        await amountInput.FillAsync("1000");
        await Assertions.Expect(continueButton).ToBeEnabledAsync(new() { Timeout = 5_000 });
    }
}
