using System.Diagnostics;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Playwright;

namespace BitCaster.E2ETest;

public class SettingsPageTests : IAsyncLifetime
{
    private DistributedApplication? _app;
    private IPlaywright? _playwright;
    private IBrowser? _browser;
    private Process? _viteProcess;
    private const int VitePort = 5173;

    public async Task InitializeAsync()
    {
        // Build the Aspire app from the AppHost project
        var builder = await DistributedApplicationTestingBuilder
            .CreateAsync<Projects.AppHost>();

        _app = await builder.BuildAsync();
        await _app.StartAsync();

        // Wait for mintd (Docker container) — can take 10+ minutes on first build.
        using var waitCts = new CancellationTokenSource(TimeSpan.FromMinutes(15));
        await _app.ResourceNotifications
            .WaitForResourceAsync("mintd", KnownResourceStates.Running, waitCts.Token);

        // AddViteApp's process doesn't reliably start in Aspire testing mode,
        // so we launch the Vite dev server manually.
        var frontendDir = Path.GetFullPath(
            Path.Combine(_app.Services.GetRequiredService<Aspire.Hosting.DistributedApplicationOptions>().ProjectDirectory!, "..", "bitCaster"));

        _viteProcess = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "npx",
                Arguments = $"vite --port {VitePort} --strictPort",
                WorkingDirectory = frontendDir,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            }
        };
        _viteProcess.Start();

        // Poll until the Vite dev server responds
        var frontendUrl = $"http://localhost:{VitePort}";
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        var deadline = DateTime.UtcNow.AddMinutes(2);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var response = await httpClient.GetAsync(frontendUrl);
                if (response.IsSuccessStatusCode)
                    break;
            }
            catch
            {
                // Not ready yet
            }
            await Task.Delay(TimeSpan.FromSeconds(2));
        }

        // Launch Playwright headless Chromium
        _playwright = await Playwright.CreateAsync();
        _browser = await _playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
        {
            Headless = true,
        });
    }

    [Fact]
    public async Task NavigateToSettings_ShowsSettingsHeading()
    {
        Assert.NotNull(_browser);

        var frontendUrl = $"http://localhost:{VitePort}";

        var page = await _browser.NewPageAsync();
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

        if (_viteProcess is not null && !_viteProcess.HasExited)
        {
            _viteProcess.Kill(entireProcessTree: true);
            await _viteProcess.WaitForExitAsync();
        }

        if (_app is not null)
            await _app.DisposeAsync();
    }
}
