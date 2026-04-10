using Microsoft.Playwright;

namespace BitCaster.E2ETest;

public class SettingsPageTests : IAsyncLifetime
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
    public async Task NavigateToSettings_ShowsSettingsHeading()
    {
        var frontendUrl = $"http://localhost:{TestPorts.Vite}";

        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await SetupComplete(page);
        await page.GotoAsync(frontendUrl, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Open the user menu dropdown, then click Settings
        var userMenuButton = page.GetByRole(AriaRole.Button, new() { Name = "Anon" });
        await userMenuButton.ClickAsync();
        var settingsButton = page.GetByRole(AriaRole.Button, new() { Name = "Settings" });
        await settingsButton.ClickAsync();

        // Assert the Settings heading is visible
        var heading = page.GetByRole(AriaRole.Heading, new() { Name = "Settings" });
        await Assertions.Expect(heading).ToBeVisibleAsync();
    }

    public async Task DisposeAsync()
    {
        if (_browser is not null)
            await _browser.CloseAsync();

        _playwright?.Dispose();
    }

}
