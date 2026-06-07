using Microsoft.Playwright;

namespace BitCaster.E2ETest;

/// <summary>
/// Phase 4.4 — the Settings page must distinguish NUT-CTF-capable mints from
/// plain ecash mints by reading the <c>nuts.CTF</c> marker out of
/// <c>/v1/info</c>. The default mint advertises NUT-CTF on staging; a vanilla
/// mint that does not advertise the capability still gets the "Ecash only"
/// chip so the user can tell at a glance whether a mint can hold CTF
/// positions.
/// </summary>
public class MintCapabilitiesTests : IAsyncLifetime
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
    /// Seed localStorage with a configured wallet and a mint whose persisted
    /// info either includes or omits the <c>CTF</c> nut marker. Mirrors the
    /// pattern in <see cref="P4StagingRegressionTests"/> but parameterises the
    /// mint URL so we can install a non-CTF mint as the active one.
    /// </summary>
    private static async Task PrimeWalletAsync(
        IPage page,
        string mintUrl,
        bool withCtfNuts,
        string mintName)
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
                            name: '{mintName}',
                            description: 'capabilities-test mint',
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
    }

    /// <summary>
    /// T4.4.c — the staging mint advertises NUT-CTF, so the Settings page
    /// must omit the "Ecash only" chip on its row.
    /// </summary>
    [Fact]
    public async Task StagingMint_AdvertisingCtf_DoesNotRenderEcashOnlyBadge()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        var mintUrl = $"{TestPorts.MintUrl}";
        await PrimeWalletAsync(page, mintUrl, withCtfNuts: true, mintName: "Staging CTF Mint");

        await page.GotoAsync($"{TestPorts.FrontendUrl}/settings", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var mintRow = page.GetByText("Staging CTF Mint").First;
        await Assertions.Expect(mintRow).ToBeVisibleAsync(new() { Timeout = 10_000 });

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
    }

    /// <summary>
    /// T4.4.d — a mint that omits the NUT-CTF capability marker (a vanilla
    /// nutshell, for example) MUST surface the "Ecash only" chip so the user
    /// can tell it cannot hold conditional positions.
    /// </summary>
    [Fact]
    public async Task PlainMint_WithoutCtf_RendersEcashOnlyBadge()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        // Use a fake mint URL so App.tsx's rehydrate effect can't refresh
        // `info.nuts` from the live staging mint and accidentally swap the
        // marker in (the live mint advertises CTF). The "default mint" rule
        // only re-fetches the URL bound to `DEFAULT_MINT_URL`; any other URL
        // is treated as user-added and trusted from persisted state.
        var mintUrl = "http://localhost:9999";
        await PrimeWalletAsync(page, mintUrl, withCtfNuts: false, mintName: "Plain Mint");

        await page.GotoAsync($"{TestPorts.FrontendUrl}/settings", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var mintRow = page.GetByText("Plain Mint").First;
        await Assertions.Expect(mintRow).ToBeVisibleAsync(new() { Timeout = 10_000 });

        var ecashOnly = page.GetByText("Ecash only");
        try
        {
            await Assertions.Expect(ecashOnly.First).ToBeVisibleAsync(new() { Timeout = 5_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Plain (no-CTF) mint did not surface the 'Ecash only' badge.");
        }
    }

    public Task DisposeAsync()
    {
        _browser?.DisposeAsync().GetAwaiter().GetResult();
        _playwright?.Dispose();
        return Task.CompletedTask;
    }
}
