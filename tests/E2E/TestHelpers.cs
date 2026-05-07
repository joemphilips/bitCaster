using Microsoft.Playwright;
using NBitcoin;

namespace BitCaster.E2ETest;

/// <summary>
/// Resolves per-worktree service ports from environment variables so multiple
/// worktree processes can run E2E tests in parallel against the same shared
/// docker-compose backend. Defaults preserve the single-worktree workflow.
///
/// See <c>bitCaster/plans/parallel-e2e-worktrees.md</c> for the slot model.
/// </summary>
public static class TestPorts
{
    public static readonly int Vite = GetInt("BITCASTER_E2E_VITE_PORT", 5173);
    public static readonly int Mint = GetInt("BITCASTER_E2E_MINT_PORT", 8085);
    public static readonly int Server = GetInt("BITCASTER_E2E_SERVER_PORT", 5000);
    public static readonly int CashuMe = GetInt("BITCASTER_E2E_CASHU_PORT", 3000);
    public static readonly int LnBits = GetInt("BITCASTER_E2E_LNBITS_PORT", 5002);

    private static int GetInt(string name, int @default) =>
        int.TryParse(Environment.GetEnvironmentVariable(name), out var v) ? v : @default;
}

/// <summary>
/// Generates random BIP-39 mnemonics for E2E tests. Each call to Get() returns
/// a fresh random mnemonic so tests never collide with previous runs against
/// a persistent mint (avoids "Blinded Message already signed" errors).
/// </summary>
public static class TestMnemonics
{
    /// <summary>
    /// Get a random valid BIP-39 12-word mnemonic.
    /// </summary>
    public static string Get()
    {
        var mnemonic = new Mnemonic(Wordlist.English, WordCount.Twelve);
        return mnemonic.ToString();
    }

    /// <summary>
    /// Get two unique random mnemonics (e.g., for interop tests needing separate wallets).
    /// </summary>
    public static (string First, string Second) GetPair() => (Get(), Get());
}

/// <summary>
/// Shared helpers for E2E tests. Extracted to avoid duplication across test classes.
/// </summary>
public static class TestHelpers
{
    /// <summary>
    /// Convenience overload for callers that only customise navigation options.
    /// </summary>
    public static Task<IResponse?> GotoMarketsAsync(
        IPage page,
        PageGotoOptions? options) =>
        GotoMarketsAsync(page, string.Empty, options);

    /// <summary>
    /// Navigate to the markets index through the configured Vite test port.
    /// Keeping this route in one place makes local/staging E2E URL overrides
    /// less error-prone.
    /// </summary>
    public static Task<IResponse?> GotoMarketsAsync(
        IPage page,
        string query = "",
        PageGotoOptions? options = null)
    {
        var suffix = string.IsNullOrWhiteSpace(query)
            ? string.Empty
            : query.StartsWith('?') ? query : $"?{query}";
        return page.GotoAsync(
            $"http://localhost:{TestPorts.Vite}/markets{suffix}",
            options ?? new PageGotoOptions
            {
                WaitUntil = WaitUntilState.DOMContentLoaded,
                Timeout = 30_000,
            });
    }

    /// <summary>
    /// Attach console and page error capture to a page, returning the shared message list.
    /// </summary>
    public static List<string> AttachConsoleCapture(IPage page)
    {
        var messages = new List<string>();
        page.Console += (_, msg) => messages.Add($"[{msg.Type}] {msg.Text}");
        page.PageError += (_, error) => messages.Add($"[PAGE_ERROR] {error}");
        return messages;
    }

    /// <summary>
    /// Build a diagnostic exception with page state for CI debugging.
    /// </summary>
    public static async Task<Exception> BuildDiagnosticExceptionAsync(
        IPage page, IReadOnlyList<string> consoleMessages, string context)
    {
        string? errorBanner = null;
        try { errorBanner = await page.Locator(".bg-red-900").TextContentAsync(new() { Timeout = 1_000 }); }
        catch { /* no error banner visible */ }

        var bodyText = await page.Locator("body").InnerTextAsync(new() { Timeout = 5_000 });
        var url = page.Url;

        return new Exception(
            $"{context}\n" +
            $"URL: {url}\n" +
            $"Error banner: {errorBanner ?? "(none)"}\n" +
            $"Console ({consoleMessages.Count} messages):\n{string.Join("\n", consoleMessages.TakeLast(30))}\n" +
            $"Page text (first 2000 chars): {bodyText[..Math.Min(bodyText.Length, 2000)]}");
    }

    /// <summary>
    /// Inject localStorage so wallet is set up. When <paramref name="mintUrl"/>
    /// is supplied, the wallet is also pointed at that mint (so balance queries
    /// resolve against real proofs); otherwise a placeholder URL is used — fine
    /// for tests that only need <c>setupComplete=true</c>.
    /// </summary>
    public static async Task SetupComplete(IPage page, int vitePort, string? mintUrl = null)
    {
        var mnemonic = TestMnemonics.Get();
        var activeMint = mintUrl ?? "http://localhost:3338";
        var mintsJson = mintUrl is null ? "[]" : $"[{{ url: '{mintUrl}' }}]";
        await page.GotoAsync($"http://localhost:{vitePort}/setup", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.DOMContentLoaded,
            Timeout = 30_000,
        });
        await page.EvaluateAsync($@"
            localStorage.setItem('bitcaster-wallet', JSON.stringify({{
                state: {{
                    mnemonic: '{mnemonic}',
                    setupComplete: true,
                    mints: {mintsJson},
                    activeMintUrl: '{activeMint}',
                    keysetCounters: {{}}
                }},
                version: 0
            }}));
        ");
    }

    /// <summary>
    /// Poll a URL until it returns a success status code (30-second timeout).
    /// </summary>
    public static async Task WaitForService(HttpClient httpClient, string url, string serviceName)
    {
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var response = await httpClient.GetAsync(url);
                if (response.IsSuccessStatusCode)
                    return;
            }
            catch
            {
                // Not ready yet
            }
            await Task.Delay(TimeSpan.FromSeconds(1));
        }

        throw new InvalidOperationException(
            $"{serviceName} is not reachable at {url}. " +
            "Start all services before running E2E tests. See AGENTS.md for the 3-terminal workflow.");
    }
}
