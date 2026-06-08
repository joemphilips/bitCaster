using Microsoft.Playwright;

namespace BitCaster.E2ETest;

/// <summary>
/// Regression coverage for Phase 6 i18n parity. The `/creator/new` flow used to
/// be hardcoded English regardless of language preference; this test fixes
/// the Japanese path so a future "I added a new English literal" PR fails CI
/// before the user notices the regression.
///
/// Strategy: seed `i18nextLng = 'ja'` in localStorage before navigating, then
/// assert the Japanese label for each step's hero string renders. The vitest
/// parity guard at `bitCaster-app/src/i18n/__tests__/parity.test.ts` covers
/// the missing-key case; this test covers the wired-up case.
/// </summary>
public class I18nCreatorTests : IAsyncLifetime
{
    private const string TestNsec =
        "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";

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
        if (_browser is not null) await _browser.DisposeAsync();
        _playwright?.Dispose();
    }

    private async Task<IBrowserContext> NewIsolatedJaContextAsync()
    {
        Assert.NotNull(_browser);
        return await _browser.NewContextAsync(new BrowserNewContextOptions
        {
            ServiceWorkers = ServiceWorkerPolicy.Block,
        });
    }

    private async Task SeedJaLocaleAndSetup(IPage page, bool configureNsecSigner = false)
    {
        // First navigate to /setup so we land on the same origin as localStorage.
        await TestHelpers.SetupComplete(page, TestPorts.Vite);
        // i18next-browser-languagedetector reads `i18nextLng` from localStorage
        // (see `bitCaster-app/src/i18n/index.ts`). Seed it BEFORE the next nav
        // so the app boots in Japanese.
        await page.EvaluateAsync("localStorage.setItem('i18nextLng', 'ja')");
        if (configureNsecSigner)
        {
            await page.EvaluateAsync($@"
                localStorage.setItem('bitcaster-settings', JSON.stringify({{
                    state: {{
                        baseCurrency: 'BTC',
                        language: 'ja',
                        theme: 'dark',
                        nostrSignerMode: 'nsec',
                        nsecSecret: '{TestNsec}',
                        relays: [],
                    }},
                    version: 0
                }}));
            ");
        }
    }

    [Fact]
    public async Task CreatorNew_RendersJapanese_NostrKeyGate()
    {
        await using var context = await NewIsolatedJaContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        try
        {
            await SeedJaLocaleAndSetup(page);
            await page.GotoAsync($"{TestPorts.FrontendUrl}/creator/new", new PageGotoOptions
            {
                WaitUntil = WaitUntilState.NetworkIdle,
                Timeout = 30_000,
            });

            await Assertions.Expect(page.GetByRole(AriaRole.Heading, new() { Name = "オラクルになるには、Nostrキーを登録する必要があります" }))
                .ToBeVisibleAsync(new() { Timeout = 10_000 });
            await Assertions.Expect(page.GetByText("自分のNostrキーを登録")).ToBeVisibleAsync();
            await Assertions.Expect(page.GetByRole(AriaRole.Button, new() { Name = "Nostrキーを作成" })).ToBeVisibleAsync();
        }
        catch (Exception ex)
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages, $"CreatorNew_RendersJapanese_NostrKeyGate: {ex.Message}");
        }
    }

    [Fact]
    public async Task CreatorNew_WithNsec_RendersJapanese_GetStartedStep()
    {
        await using var context = await NewIsolatedJaContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        try
        {
            await SeedJaLocaleAndSetup(page, configureNsecSigner: true);
            await page.GotoAsync($"{TestPorts.FrontendUrl}/creator/new", new PageGotoOptions
            {
                WaitUntil = WaitUntilState.NetworkIdle,
                Timeout = 30_000,
            });

            // Step 1 — assert the market-type choice copy is in Japanese.
            await Assertions.Expect(page.GetByRole(AriaRole.Heading, new() { Name = "始める" }))
                .ToBeVisibleAsync(new() { Timeout = 10_000 });
            await Assertions.Expect(page.GetByText("作成するマーケットの種類を選んでください。")).ToBeVisibleAsync();
            await Assertions.Expect(page.GetByText("YES / NO")).ToBeVisibleAsync();
            await Assertions.Expect(page.GetByText("カテゴリカル")).ToBeVisibleAsync();
            await Assertions.Expect(page.GetByText("数値")).ToBeVisibleAsync();
        }
        catch (Exception ex)
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages, $"CreatorNew_WithNsec_RendersJapanese_GetStartedStep: {ex.Message}");
        }
    }

    [Fact]
    public async Task CreatorNew_NoEnglishLeakage_OnGetStartedStep()
    {
        // Defense-in-depth: walk the same step and assert the English source
        // strings DO NOT appear, so a future regression where someone adds a
        // hardcoded English literal next to a translated one fails this test.
        await using var context = await NewIsolatedJaContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        try
        {
            await SeedJaLocaleAndSetup(page, configureNsecSigner: true);
            await page.GotoAsync($"{TestPorts.FrontendUrl}/creator/new", new PageGotoOptions
            {
                WaitUntil = WaitUntilState.NetworkIdle,
                Timeout = 30_000,
            });

            // Wait for the JA hero text so we know the page is hydrated before
            // asserting English absence (otherwise a slow render would silently
            // pass the negative assertion).
            await Assertions.Expect(page.GetByRole(AriaRole.Heading, new() { Name = "始める" }))
                .ToBeVisibleAsync(new() { Timeout = 10_000 });

            await Assertions.Expect(page.GetByText("Get Started", new() { Exact = true })).Not.ToBeVisibleAsync();
            await Assertions.Expect(page.GetByText("Choose the type of market you want to create.", new() { Exact = true })).Not.ToBeVisibleAsync();
            await Assertions.Expect(page.GetByText("Oracle Announcement", new() { Exact = true })).Not.ToBeVisibleAsync();
            await Assertions.Expect(page.GetByText("Yes, use an existing announcement", new() { Exact = true })).Not.ToBeVisibleAsync();
            await Assertions.Expect(page.GetByText("No / I want to be an oracle", new() { Exact = true })).Not.ToBeVisibleAsync();
        }
        catch (Exception ex)
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages, $"CreatorNew_NoEnglishLeakage_OnGetStartedStep: {ex.Message}");
        }
    }
}
