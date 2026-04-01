using Microsoft.Playwright;

namespace BitCaster.E2ETest;

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
