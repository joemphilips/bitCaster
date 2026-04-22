using Microsoft.Playwright;

namespace BitCaster.E2ETest;

public class PortfolioTests : IAsyncLifetime
{
    private IPlaywright? _playwright;
    private IBrowser? _browser;

    public async Task InitializeAsync()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        await Task.WhenAll(
            TestHelpers.WaitForService(httpClient, $"http://localhost:{TestPorts.Mint}/v1/info", "Mint"),
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

    /// <summary>
    /// P5 item 4: an Anon user (no Nostr signer, no cached profile)
    /// must see a "Connect Nostr" CTA beneath their profile card on
    /// /portfolio so they can discover the Nostr settings flow. Clicking
    /// it must deep-link to /settings?category=nostr with the Nostr
    /// category expanded.
    /// </summary>
    [Fact]
    public async Task AnonUser_ShowsConnectNostrCta_NavigatesToNostrSettings()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        var mnemonic = TestMnemonics.Get();
        var mintUrl = $"http://localhost:{TestPorts.Mint}";

        await page.GotoAsync($"http://localhost:{TestPorts.Vite}/setup", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.DOMContentLoaded,
            Timeout = 30_000,
        });
        // Setup wallet with no Nostr signer — Anon state.
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
                    activeCategory: 'general',
                    baseCurrency: 'BTC',
                    language: 'en',
                    theme: 'dark',
                    nostrSignerMode: 'none',
                    relays: []
                }},
                version: 0
            }}));
        ");

        await page.GotoAsync($"http://localhost:{TestPorts.Vite}/portfolio", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // The CTA is a PrimaryGradientButton with text "Connect Nostr".
        var ctaButton = page.GetByRole(AriaRole.Button, new() { Name = "Connect Nostr" });
        try
        {
            await Assertions.Expect(ctaButton).ToBeVisibleAsync(new() { Timeout = 10_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                "Connect Nostr CTA was not visible on /portfolio in Anon state.");
        }

        await ctaButton.ClickAsync();

        // Must end up on /settings with category=nostr expanded.
        await page.WaitForURLAsync(url =>
            url.Contains("/settings") && url.Contains("category=nostr"),
            new() { Timeout = 10_000 });

        // The Nostr category's signer-mode buttons should render once the
        // category is open — either "Connect with NIP-07 Extension" or the
        // "Use Private Key (nsec)" picker.
        var nsecButton = page.GetByRole(AriaRole.Button, new() { Name = "Use Private Key (nsec)" });
        var nip07Button = page.GetByRole(AriaRole.Button, new() { Name = "Connect with NIP-07 Extension" });
        await Assertions
            .Expect(nsecButton.Or(nip07Button).First)
            .ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    /// <summary>
    /// A connected Nostr user must NOT see the Connect CTA (otherwise it
    /// would sit redundantly above their own profile).
    /// </summary>
    [Fact]
    public async Task NostrConnectedUser_HidesConnectNostrCta()
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
                    activeCategory: 'general',
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

        await page.GotoAsync($"http://localhost:{TestPorts.Vite}/portfolio", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var ctaButton = page.GetByRole(AriaRole.Button, new() { Name = "Connect Nostr" });
        await Assertions.Expect(ctaButton).Not.ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    public async Task DisposeAsync()
    {
        if (_browser is not null)
            await _browser.CloseAsync();

        _playwright?.Dispose();
    }
}
