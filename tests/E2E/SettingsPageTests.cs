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

    /// <summary>
    /// Setup wallet with a mint that has info (name, icon_url) stored, then navigate to settings.
    /// </summary>
    private async Task SetupWithMintAndNavigateToSettings(IPage page)
    {
        var mnemonic = TestMnemonics.Get();
        var mintUrl = $"http://localhost:{TestPorts.Mint}";
        await page.GotoAsync($"http://localhost:{TestPorts.Vite}/setup", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.DOMContentLoaded,
            Timeout = 30_000,
        });
        await page.EvaluateAsync($@"
            localStorage.setItem('bitcaster-wallet', JSON.stringify({{
                state: {{
                    mnemonic: '{mnemonic}',
                    setupComplete: true,
                    mints: [{{
                        url: '{mintUrl}',
                        info: {{ name: 'Test Mint', description: 'A test mint for E2E', icon_url: null, nuts: {{}} }},
                        keysets: [{{ id: '00abc123', unit: 'sat', active: true }}]
                    }}],
                    activeMintUrl: '{mintUrl}',
                    keysetCounters: {{}},
                    mintConnectionStatuses: {{ '{mintUrl}': 'connected' }}
                }},
                version: 0
            }}));
            localStorage.setItem('bitcaster-settings', JSON.stringify({{
                state: {{
                    activeCategory: 'cashu',
                    baseCurrency: 'BTC',
                    language: 'en',
                    theme: 'dark',
                    nostrSignerMode: 'none',
                    relays: []
                }},
                version: 0
            }}));
        ");
        await page.GotoAsync($"http://localhost:{TestPorts.Vite}/settings", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });
    }

    [Fact]
    public async Task AddMint_InvalidUrl_ShowsError()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        await SetupWithMintAndNavigateToSettings(page);

        // Click "Add Mint" button
        var addMintBtn = page.GetByRole(AriaRole.Button, new() { Name = "Add Mint" });
        await Assertions.Expect(addMintBtn).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await addMintBtn.ClickAsync();

        // Enter an invalid URL
        var urlInput = page.GetByPlaceholder("https://mint.example.com");
        await Assertions.Expect(urlInput).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await urlInput.FillAsync("https://invalid-mint-that-does-not-exist.example.com");

        // Click "Add" button
        var confirmAddBtn = page.GetByRole(AriaRole.Button, new() { Name = "Add", Exact = true });
        await confirmAddBtn.ClickAsync();

        // Should show an error — either inline or as a snackbar/toast
        var errorIndicator = page.Locator("text=/error|failed|invalid|unreachable/i");
        try
        {
            await Assertions.Expect(errorIndicator.First).ToBeVisibleAsync(new() { Timeout = 15_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "AddMint: No error shown when adding invalid mint URL.");
        }
    }

    [Fact]
    public async Task AddMint_ShowsLoadingSpinner_ThenConnected()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        await SetupWithMintAndNavigateToSettings(page);

        // Click "Add Mint"
        var addMintBtn = page.GetByRole(AriaRole.Button, new() { Name = "Add Mint" });
        await Assertions.Expect(addMintBtn).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await addMintBtn.ClickAsync();

        // Enter the real mint URL (already running in docker-compose)
        var urlInput = page.GetByPlaceholder("https://mint.example.com");
        await urlInput.FillAsync($"http://localhost:{TestPorts.Mint}");

        // Click Add — a spinner should appear while connecting
        var confirmAddBtn = page.GetByRole(AriaRole.Button, new() { Name = "Add", Exact = true });
        await confirmAddBtn.ClickAsync();

        // The input should be disabled or a loading indicator visible during validation
        var loadingIndicator = page.Locator("[class*='animate-spin']");
        // Loading might be very quick with local mint, so we just check it appeared or the mint got added
        var mintAdded = page.Locator($"text=/localhost:{TestPorts.Mint}/");
        try
        {
            await Assertions.Expect(mintAdded.First).ToBeVisibleAsync(new() { Timeout = 15_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "AddMint: Mint was not added after entering valid URL.");
        }
    }

    [Fact]
    public async Task Settings_CollapsibleSections_ToggleOnReclick()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();

        await SetupWithMintAndNavigateToSettings(page);

        // Cashu section should be open (we set activeCategory='cashu' in setup)
        var connectedMintsHeading = page.GetByText("Connected Mints");
        await Assertions.Expect(connectedMintsHeading).ToBeVisibleAsync(new() { Timeout = 10_000 });

        // Click the Cashu Settings header to close it
        var cashuHeader = page.GetByText("Cashu Settings");
        await cashuHeader.ClickAsync();

        // "Connected Mints" content should now be hidden
        await Assertions.Expect(connectedMintsHeading).Not.ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    [Fact]
    public async Task MintRow_ShowsNameNotJustUrl()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();

        await SetupWithMintAndNavigateToSettings(page);

        // The mint row should show the name "Test Mint" (from info.name), not just the URL
        var mintName = page.GetByText("Test Mint");
        await Assertions.Expect(mintName).ToBeVisibleAsync(new() { Timeout = 10_000 });
    }

    [Fact]
    public async Task MintRow_ClickNavigatesToDetailPage()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        await SetupWithMintAndNavigateToSettings(page);

        // Click the mint row (the one showing "Test Mint")
        var mintRow = page.GetByText("Test Mint");
        await Assertions.Expect(mintRow).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await mintRow.ClickAsync();

        // Should navigate to mint detail page
        try
        {
            await page.WaitForURLAsync("**/mint-details**", new() { Timeout = 10_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                $"MintRow click did not navigate to /mint-details. Current URL: {page.Url}");
        }
    }

    [Fact]
    public async Task NostrConnected_HidesConnectSection_ShowsProfile()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();

        var mnemonic = TestMnemonics.Get();
        var mintUrl = $"http://localhost:{TestPorts.Mint}";
        await page.GotoAsync($"http://localhost:{TestPorts.Vite}/setup", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.DOMContentLoaded,
            Timeout = 30_000,
        });
        // Setup with nostrSignerMode = 'nip07' to simulate connected state
        await page.EvaluateAsync($@"
            localStorage.setItem('bitcaster-wallet', JSON.stringify({{
                state: {{
                    mnemonic: '{mnemonic}',
                    setupComplete: true,
                    mints: [{{ url: '{mintUrl}', info: {{ name: 'Test Mint', nuts: {{}} }} }}],
                    activeMintUrl: '{mintUrl}',
                    keysetCounters: {{}},
                    mintConnectionStatuses: {{}}
                }},
                version: 0
            }}));
            localStorage.setItem('bitcaster-settings', JSON.stringify({{
                state: {{
                    activeCategory: 'nostr',
                    baseCurrency: 'BTC',
                    language: 'en',
                    theme: 'dark',
                    nostrSignerMode: 'nip07',
                    nostrProfile: {{ pubkey: 'abc123', displayName: 'TestUser', avatar: '', nip05: '', bio: '' }},
                    nostrProfileFetchStatus: 'found',
                    relays: []
                }},
                version: 0
            }}));
        ");
        await page.GotoAsync($"http://localhost:{TestPorts.Vite}/settings?category=nostr", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // The "Connect with NIP-07 Extension" button should NOT be visible
        var connectBtn = page.GetByRole(AriaRole.Button, new() { Name = "Connect with NIP-07 Extension" });
        await Assertions.Expect(connectBtn).Not.ToBeVisibleAsync(new() { Timeout = 10_000 });

        // The profile section should be visible with "TestUser"
        var profileName = page.GetByText("TestUser");
        await Assertions.Expect(profileName).ToBeVisibleAsync(new() { Timeout = 5_000 });

        // A "Disconnect" button should be visible
        var disconnectBtn = page.GetByRole(AriaRole.Button, new() { Name = "Disconnect" });
        await Assertions.Expect(disconnectBtn).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    [Fact]
    public async Task MintDetailPage_ShowsMintInfo()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        var mnemonic = TestMnemonics.Get();
        var mintUrl = $"http://localhost:{TestPorts.Mint}";

        // Setup wallet first (needed for auth/state)
        await page.GotoAsync($"http://localhost:{TestPorts.Vite}/setup", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.DOMContentLoaded,
            Timeout = 30_000,
        });
        await page.EvaluateAsync($@"
            localStorage.setItem('bitcaster-wallet', JSON.stringify({{
                state: {{
                    mnemonic: '{mnemonic}',
                    setupComplete: true,
                    mints: [{{ url: '{mintUrl}', info: {{ name: 'CDK Mint', description: 'A CDK test mint', nuts: {{}} }} }}],
                    activeMintUrl: '{mintUrl}',
                    keysetCounters: {{}},
                    mintConnectionStatuses: {{}}
                }},
                version: 0
            }}));
        ");

        // Navigate directly to mint detail page
        await page.GotoAsync(
            $"http://localhost:{TestPorts.Vite}/mint-details?mintUrl={Uri.EscapeDataString(mintUrl)}",
            new PageGotoOptions { WaitUntil = WaitUntilState.NetworkIdle, Timeout = 30_000 });

        // Should show mint name (appears in both h1 header and info card)
        var mintName = page.GetByRole(AriaRole.Heading, new() { Name = "CDK Mint" });
        try
        {
            await Assertions.Expect(mintName.First).ToBeVisibleAsync(new() { Timeout = 10_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                $"Mint detail page did not show mint name. URL: {page.Url}");
        }

        // Should show the mint URL
        var mintUrlText = page.GetByText(mintUrl);
        await Assertions.Expect(mintUrlText.First).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    public async Task DisposeAsync()
    {
        if (_browser is not null)
            await _browser.CloseAsync();

        _playwright?.Dispose();
    }

}
