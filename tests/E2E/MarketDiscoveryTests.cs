using System.Diagnostics;
using Microsoft.Playwright;

namespace BitCaster.E2ETest;

public class MarketDiscoveryTests : IAsyncLifetime
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

        // 2. Seed conditions into the mint
        var seedProcess = Process.Start(new ProcessStartInfo
        {
            FileName = "docker",
            Arguments = "compose run --rm seed",
            WorkingDirectory = RepoRoot,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        });
        if (seedProcess is not null)
            await seedProcess.WaitForExitAsync();

        // 3. Start BitCaster.InMemoryMatchingEngine
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

        // 4. Start Vite dev server
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

        // 5. Launch Playwright headless Chromium
        _playwright = await Playwright.CreateAsync();
        _browser = await _playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
        {
            Headless = true,
        });
    }

    [Fact]
    public async Task NavigateToMarkets_ShowsSeededMarketCards()
    {
        Assert.NotNull(_browser);

        var page = await _browser.NewPageAsync();
        await page.GotoAsync($"http://localhost:{VitePort}/markets", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Seeded market cards should be visible
        var btcMarket = page.GetByText("Will Bitcoin reach $100K");
        await Assertions.Expect(btcMarket).ToBeVisibleAsync(new() { Timeout = 10_000 });

        var nbaMarket = page.GetByText("2026 NBA Championship Winner");
        await Assertions.Expect(nbaMarket).ToBeVisibleAsync();

        var fedMarket = page.GetByText("Fed Q1 2026 Rate Decision");
        await Assertions.Expect(fedMarket).ToBeVisibleAsync();
    }

    [Fact]
    public async Task ClickBuyYes_OpensTradingOverlay()
    {
        Assert.NotNull(_browser);

        var page = await _browser.NewPageAsync();
        await page.GotoAsync($"http://localhost:{VitePort}/markets", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Wait for cards to load, then click Buy YES on the first card
        var buyYesButton = page.GetByRole(AriaRole.Button, new() { Name = "Buy YES" }).First;
        await Assertions.Expect(buyYesButton).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await buyYesButton.ClickAsync();

        // Trading overlay should appear with amount input and BUY button
        var amountInput = page.GetByRole(AriaRole.Spinbutton);
        await Assertions.Expect(amountInput).ToBeVisibleAsync(new() { Timeout = 5_000 });

        var confirmButton = page.GetByRole(AriaRole.Button, new() { NameRegex = new("^BUY") });
        await Assertions.Expect(confirmButton).ToBeVisibleAsync();
    }

    [Fact]
    public async Task MintUnavailable_ShowsErrorState()
    {
        Assert.NotNull(_browser);

        // This test verifies the error state when mint is down.
        // We navigate with a broken proxy to simulate unavailability.
        var page = await _browser.NewPageAsync();

        // Block the mint API to simulate failure
        await page.RouteAsync("**/v1/conditions", route => route.AbortAsync());

        await page.GotoAsync($"http://localhost:{VitePort}/markets", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Should show error message
        var errorText = page.GetByText("Failed to load markets");
        await Assertions.Expect(errorText).ToBeVisibleAsync(new() { Timeout = 10_000 });

        // Should show retry button
        var retryButton = page.GetByRole(AriaRole.Button, new() { Name = "Retry" });
        await Assertions.Expect(retryButton).ToBeVisibleAsync();
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
