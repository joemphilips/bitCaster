using System.Diagnostics;
using Microsoft.Playwright;

namespace BitCaster.E2ETest;

public class SettingsPageTests : IAsyncLifetime
{
    private IPlaywright? _playwright;
    private IBrowser? _browser;
    private Process? _viteProcess;
    private Process? _serverProcess;
    private const int VitePort = 5173;
    private const int MintPort = 8085;
    private const int ServerPort = 5000;

    private static string RepoRoot =>
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));

    public async Task InitializeAsync()
    {
        // 1. Start mintd via docker compose
        var composeUp = Process.Start(new ProcessStartInfo
        {
            FileName = "docker",
            Arguments = "compose up -d mintd",
            WorkingDirectory = RepoRoot,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        });
        if (composeUp is not null)
            await composeUp.WaitForExitAsync();

        // Poll until mintd is healthy
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        var mintUrl = $"http://localhost:{MintPort}/v1/info";
        var deadline = DateTime.UtcNow.AddMinutes(15);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var response = await httpClient.GetAsync(mintUrl);
                if (response.IsSuccessStatusCode)
                    break;
            }
            catch
            {
                // Not ready yet
            }
            await Task.Delay(TimeSpan.FromSeconds(2));
        }

        // 2. Start BitCaster.InMemoryMatchingEngine
        var serverDir = Path.Combine(RepoRoot, "BitCaster.InMemoryMatchingEngine");
        _serverProcess = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "dotnet",
                Arguments = "run --no-launch-profile",
                WorkingDirectory = serverDir,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                Environment =
                {
                    ["ASPNETCORE_URLS"] = $"http://localhost:{ServerPort}",
                },
            }
        };
        _serverProcess.Start();

        // 3. Start Vite dev server
        var frontendDir = Path.Combine(RepoRoot, "bitCaster");
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
        var viteDeadline = DateTime.UtcNow.AddMinutes(2);
        while (DateTime.UtcNow < viteDeadline)
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

        // 4. Launch Playwright headless Chromium
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

        if (_serverProcess is not null && !_serverProcess.HasExited)
        {
            _serverProcess.Kill(entireProcessTree: true);
            await _serverProcess.WaitForExitAsync();
        }

        // Tear down docker compose services
        var composeDown = Process.Start(new ProcessStartInfo
        {
            FileName = "docker",
            Arguments = "compose down",
            WorkingDirectory = RepoRoot,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        });
        if (composeDown is not null)
            await composeDown.WaitForExitAsync();
    }
}
