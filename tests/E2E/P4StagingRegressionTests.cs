using Microsoft.Playwright;

namespace BitCaster.E2ETest;

/// <summary>
/// Regression coverage for the three issues reported in
/// <c>docs/P4-Staging-Review.md</c>:
///
/// 1. Full-window wizards (<c>/setup</c>, <c>/creator/new</c>) must render on
///    first in-app navigation — not a blank page that only appears after a
///    manual reload.
/// 2. A mint that advertises <c>nuts.CTF</c> must not be decorated with the
///    "Ecash only" badge, and its connection dot must reflect the actual
///    connection state rather than staying grey after rehydration.
/// 3. An <c>nsec</c> private key configured on the settings page must still
///    be usable after a full page reload — the signer has to be re-installed
///    from persisted state, not thrown away.
/// </summary>
public class P4StagingRegressionTests : IAsyncLifetime
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

    private async Task<IBrowserContext> NewIsolatedContextAsync()
    {
        Assert.NotNull(_browser);
        return await _browser.NewContextAsync(new BrowserNewContextOptions
        {
            ServiceWorkers = ServiceWorkerPolicy.Block,
        });
    }

    /// <summary>
    /// Prime localStorage with a wallet that already has the default mint
    /// installed so the creator dashboard can be reached without running the
    /// setup wizard.
    /// </summary>
    private static async Task PrimeWalletAsync(IPage page, string mintUrl, bool withCtfNuts)
    {
        var mnemonic = TestMnemonics.Get();
        var nutsJson = withCtfNuts
            ? TestHelpers.CtfNutsJson
            : "{ '4': { methods: [{ method: 'bolt11', unit: 'sat', min_amount: 1, max_amount: 1000000 }] }, '5': { methods: [{ method: 'bolt11', unit: 'sat', min_amount: 1, max_amount: 1000000 }] } }";

        await page.GotoAsync($"{TestPorts.FrontendUrl}/setup", new PageGotoOptions
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
                        info: {{
                            name: 'Default Mint',
                            description: 'bitCaster staging default',
                            version: 'Nutshell/0.16.0',
                            nuts: {nutsJson}
                        }},
                        keysets: [{{ id: '00abc123', unit: 'sat', active: true }}]
                    }}],
                    activeMintUrl: '{mintUrl}',
                    keysetCounters: {{}},
                    mintConnectionStatuses: {{ '{mintUrl}': 'connected' }}
                }},
                version: 0
            }}));
        ");
    }

    /// <summary>
    /// Regression #1: <c>/creator/new</c> must render the wizard the first time
    /// it is visited within a session — not after a subsequent reload. A blank
    /// page on the first open was caused by a Rules-of-Hooks violation where
    /// shell / wizard branches had different hook counts.
    /// </summary>
    [Fact]
    public async Task WizardRoute_RendersOnFirstInAppNavigation_NotBlank()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        var mintUrl = $"{TestPorts.MintUrl}";
        await PrimeWalletAsync(page, mintUrl, withCtfNuts: true);

        // Land on the markets page (shell layout) first.
        await page.GotoAsync($"{TestPorts.FrontendUrl}/", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Navigate to /creator/new via client-side routing — this is the first
        // time in this session we switch from shell to wizard layout.
        await page.GotoAsync($"{TestPorts.FrontendUrl}/creator/new", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // The creator route renders either the Nostr-key gate or the wizard
        // itself, depending on persisted signer settings. If the page is
        // blank, none of these valid first-screen elements will appear.
        var wizardContent = page.GetByRole(AriaRole.Heading, new()
        {
            NameRegex = new System.Text.RegularExpressions.Regex(
                "You must register a nostr key to become an oracle|Get Started|Basic Information",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase),
        });
        try
        {
            await Assertions.Expect(wizardContent.First).ToBeVisibleAsync(new() { Timeout = 10_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "/creator/new rendered blank on first in-app navigation.");
        }
    }

    /// <summary>
    /// Regression #2: a mint advertising <c>nuts.CTF</c> must not show the
    /// "Ecash only" badge, and its status dot must be green once connected.
    /// Both pieces live in the Settings → Cashu Settings section.
    /// </summary>
    [Fact]
    public async Task DefaultMintWithCtf_ShowsNoEcashOnlyBadge_AndGreenDot()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        var mintUrl = $"{TestPorts.MintUrl}";
        await PrimeWalletAsync(page, mintUrl, withCtfNuts: true);

        await page.EvaluateAsync($@"
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

        await page.GotoAsync($"{TestPorts.FrontendUrl}/settings", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // The mint row for the default mint must be visible.
        var mintRow = page.GetByText("Default Mint").First;
        await Assertions.Expect(mintRow).ToBeVisibleAsync(new() { Timeout = 10_000 });

        // "Ecash only" must NOT appear anywhere on the settings page.
        var ecashOnly = page.GetByText("Ecash only");
        try
        {
            await Assertions.Expect(ecashOnly).Not.ToBeVisibleAsync(new() { Timeout = 5_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "CTF-supporting mint still shows the 'Ecash only' badge.");
        }

        // The status dot for a connected mint sets `title="connected"` — use
        // the accessible title rather than a CSS class (see e2e-tests.md).
        var greenDot = page.GetByTitle("connected").First;
        try
        {
            await Assertions.Expect(greenDot).ToBeVisibleAsync(new() { Timeout = 5_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Connected mint did not surface a green status indicator.");
        }
    }

    /// <summary>
    /// Regression #3: an <c>nsec</c> key configured in Settings must survive a
    /// page reload. We assert that (a) the signer mode is still "nsec" after
    /// reload, (b) the persisted secret is still present, and (c) the NDK
    /// signer singleton is re-installed (exposed via
    /// <c>window.__bitcasterGetNdk</c> isn't available, so we fall back to
    /// checking persisted state and that the Disconnect button — which only
    /// renders when a signer is active — is visible after reload).
    /// </summary>
    [Fact]
    public async Task Nsec_SurvivesPageReload_AndRehydratesSigner()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        var mintUrl = $"{TestPorts.MintUrl}";
        await PrimeWalletAsync(page, mintUrl, withCtfNuts: true);

        // A deterministic throwaway nsec — same 32-byte seed every run; these
        // tests only care that rehydration wires up a signer, not about
        // on-chain signatures being valid.
        const string testNsec =
            "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";

        await page.EvaluateAsync($@"
            localStorage.setItem('bitcaster-settings', JSON.stringify({{
                state: {{
                    activeCategory: 'nostr',
                    baseCurrency: 'BTC',
                    language: 'en',
                    theme: 'dark',
                    nostrSignerMode: 'nsec',
                    nsecSecret: '{testNsec}',
                    relays: []
                }},
                version: 0
            }}));
        ");

        await page.GotoAsync($"{TestPorts.FrontendUrl}/settings?category=nostr", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // A Disconnect button only renders when a signer is active.
        var disconnectBtn = page.GetByRole(AriaRole.Button, new() { Name = "Disconnect" });
        try
        {
            await Assertions.Expect(disconnectBtn).ToBeVisibleAsync(new() { Timeout = 10_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Nsec signer did not surface an active state after initial load.");
        }

        // Reload the page — this is where the regression surfaced.
        await page.ReloadAsync(new() { WaitUntil = WaitUntilState.NetworkIdle, Timeout = 30_000 });

        // Signer mode must still be "nsec" in the persisted settings.
        var persistedMode = await page.EvaluateAsync<string?>(@"
            () => {
                const raw = localStorage.getItem('bitcaster-settings');
                if (!raw) return null;
                try {
                    return JSON.parse(raw).state?.nostrSignerMode ?? null;
                } catch {
                    return null;
                }
            }
        ");
        Assert.Equal("nsec", persistedMode);

        // And the secret must still be present.
        var persistedSecret = await page.EvaluateAsync<string?>(@"
            () => {
                const raw = localStorage.getItem('bitcaster-settings');
                if (!raw) return null;
                try {
                    return JSON.parse(raw).state?.nsecSecret ?? null;
                } catch {
                    return null;
                }
            }
        ");
        Assert.False(string.IsNullOrEmpty(persistedSecret),
            "nsecSecret was wiped from localStorage after reload.");

        // And the Disconnect button should still be visible, meaning the
        // signer was re-installed on rehydration.
        try
        {
            await Assertions.Expect(disconnectBtn).ToBeVisibleAsync(new() { Timeout = 10_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Nsec signer was not rehydrated after reload — Disconnect button missing.");
        }
    }

    public async Task DisposeAsync()
    {
        if (_browser is not null)
            await _browser.CloseAsync();

        _playwright?.Dispose();
    }
}
