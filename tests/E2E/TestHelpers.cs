using Microsoft.Playwright;

namespace BitCaster.E2ETest;

/// <summary>
/// Thread-safe pool of unique, valid BIP-39 12-word mnemonics for E2E tests.
/// Each call to Get() returns the next mnemonic so parallel tests never collide.
/// </summary>
public static class TestMnemonics
{
    // All entries are valid BIP-39 12-word English mnemonics with correct checksums.
    private static readonly string[] Pool =
    [
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
        "legal winner thank year wave sausage worth useful legal winner thank yellow",
        "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
        "ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic",
        "eye survey guilt napkin crystal cup whisper salt luggage manage unveil loyal",
        "cattle gold bind busy sound reduce tone addict baby spend february strategy",
        "half depart obvious quality work element tank gorilla view sugar picture humble",
        "seat balcony leader corn dragon vehicle report car book wear ring bus",
        "tray fluid rubber caught pause keen slice caution similar access beef attitude",
        "vessel ladder alter error federal sibling chat ability sun glass valve picture",
        "scheme spot photo card baby mountain device kick cradle pact join borrow",
        "cable inject sheriff boil unit web rural manual stool boss summer sausage",
        "antique brush concert promote vibrant vacuum crash taxi equip hover apart allow",
        "kiwi post sad banner harbor same zoo ancient document illegal half divide",
        "pen oval crime render wedding club sunny such jazz program tube crush",
        "bright execute bronze between pulp ticket mule approve click photo cradle skirt",
        "bar reduce enable music weird powder abandon doctor wrap risk yellow comfort",
        "glide crack sure alcohol fuel sound mass cave august expect body critic",
        "target switch home forum vote level clay rotate regular arrive orient squeeze",
        "trash cheese elder before story penalty hello viable style intact noble depth",
        "arrive lava rule exchange case boost catalog chef pond praise fat bench",
        "square organ aim local gold risk disorder fit equip keep glow decade",
        "style wash hockey bird sorry patient focus bike crime secret palace elephant",
    ];

    private static int _counter = -1;

    /// <summary>
    /// Get a unique mnemonic. Thread-safe; each call returns the next in the pool.
    /// </summary>
    public static string Get()
    {
        var index = Interlocked.Increment(ref _counter);
        if (index >= Pool.Length)
            throw new InvalidOperationException(
                $"TestMnemonics pool exhausted ({Pool.Length} mnemonics). Add more to TestHelpers.cs.");
        return Pool[index];
    }

    /// <summary>
    /// Get two unique mnemonics (e.g., for interop tests needing separate wallets).
    /// </summary>
    public static (string First, string Second) GetPair() => (Get(), Get());
}

/// <summary>
/// Shared helpers for E2E tests. Extracted to avoid duplication across test classes.
/// </summary>
public static class TestHelpers
{
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
    /// Inject localStorage so wallet is set up (no mint connection).
    /// Use this for tests that only need setupComplete=true without a real mint URL.
    /// </summary>
    public static async Task SetupComplete(IPage page, int vitePort)
    {
        var mnemonic = TestMnemonics.Get();
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
                    mints: [],
                    activeMintUrl: 'http://localhost:3338',
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
