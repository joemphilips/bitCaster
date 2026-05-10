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

    private async Task SeedJaLocaleAndSetup(IPage page)
    {
        // First navigate to /setup so we land on the same origin as localStorage.
        await TestHelpers.SetupComplete(page, TestPorts.Vite);
        // i18next-browser-languagedetector reads `i18nextLng` from localStorage
        // (see `bitCaster-app/src/i18n/index.ts`). Seed it BEFORE the next nav
        // so the app boots in Japanese.
        await page.EvaluateAsync("localStorage.setItem('i18nextLng', 'ja')");
    }

    [Fact]
    public async Task CreatorNew_RendersJapanese_OracleStep()
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

            // Step 1 (oracle check) — assert the hero copy is in Japanese.
            // From en.json: marketCreation.oracleAnnouncement = "Oracle Announcement"
            // From ja.json: marketCreation.oracleAnnouncement = "オラクルアナウンスメント"
            await Assertions.Expect(page.GetByText("オラクルアナウンスメント")).ToBeVisibleAsync(new() { Timeout = 10_000 });
            // The two CTA buttons.
            await Assertions.Expect(page.GetByText("はい、既存のアナウンスメントを使用する")).ToBeVisibleAsync();
            await Assertions.Expect(page.GetByText("いいえ / オラクルになりたい")).ToBeVisibleAsync();
        }
        catch (Exception ex)
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages, $"CreatorNew_RendersJapanese_OracleStep: {ex.Message}");
        }
    }

    [Fact]
    public async Task CreatorNew_NoEnglishLeakage_OnOracleStep()
    {
        // Defense-in-depth: walk the same step and assert the English source
        // strings DO NOT appear, so a future regression where someone adds a
        // hardcoded English literal next to a translated one fails this test.
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

            // Wait for the JA hero text so we know the page is hydrated before
            // asserting English absence (otherwise a slow render would silently
            // pass the negative assertion).
            await Assertions.Expect(page.GetByText("オラクルアナウンスメント")).ToBeVisibleAsync(new() { Timeout = 10_000 });

            await Assertions.Expect(page.GetByText("Oracle Announcement", new() { Exact = true })).Not.ToBeVisibleAsync();
            await Assertions.Expect(page.GetByText("Yes, use an existing announcement", new() { Exact = true })).Not.ToBeVisibleAsync();
            await Assertions.Expect(page.GetByText("No / I want to be an oracle", new() { Exact = true })).Not.ToBeVisibleAsync();
        }
        catch (Exception ex)
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages, $"CreatorNew_NoEnglishLeakage_OnOracleStep: {ex.Message}");
        }
    }
}
