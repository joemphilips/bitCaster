using Microsoft.Playwright;

namespace BitCaster.E2ETest;

public class DepositWithdrawTests : IAsyncLifetime
{
    private IPlaywright? _playwright;
    private IBrowser? _browser;
    private const int VitePort = 5173;
    private const int MintPort = 8085;

    public async Task InitializeAsync()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        await WaitForService(httpClient, $"http://localhost:{MintPort}/v1/info", "Mint (port 8085)");
        await WaitForService(httpClient, $"http://localhost:{VitePort}", "Frontend (port 5173)");

        _playwright = await Playwright.CreateAsync();
        _browser = await _playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
        {
            Headless = true,
        });
    }

    /// <summary>
    /// Inject localStorage so wallet is set up with a configured mint.
    /// The mint URL points directly to localhost:8085 where mintd runs.
    /// Also unregisters PWA service workers to ensure the dev server's latest code is used.
    /// </summary>
    private async Task SetupCompleteWithMint(IPage page)
    {
        await page.GotoAsync($"http://localhost:{VitePort}/setup", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.DOMContentLoaded,
            Timeout = 30_000,
        });

        // Unregister service workers to avoid stale cached content
        await page.EvaluateAsync(@"
            navigator.serviceWorker.getRegistrations().then(regs =>
                Promise.all(regs.map(r => r.unregister()))
            )
        ");

        await page.EvaluateAsync(@"
            localStorage.setItem('bitcaster-wallet', JSON.stringify({
                state: {
                    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
                    setupComplete: true,
                    mints: [{ url: 'http://localhost:8085', info: { name: 'Test Mint' } }],
                    activeMintUrl: 'http://localhost:8085',
                    keysetCounters: {},
                    mintConnectionStatuses: {}
                },
                version: 0
            }));
        ");
    }

    /// <summary>
    /// Navigate to Portfolio page after setup.
    /// </summary>
    private async Task NavigateToPortfolio(IPage page)
    {
        await page.GotoAsync($"http://localhost:{VitePort}/portfolio", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });
    }

    [Fact]
    public async Task DepositLightning_CreatesInvoiceAndShowsQR()
    {
        Assert.NotNull(_browser);
        var page = await _browser.NewPageAsync();
        await SetupCompleteWithMint(page);
        await NavigateToPortfolio(page);

        // Click Deposit button
        var depositBtn = page.GetByRole(AriaRole.Button, new() { Name = "Deposit" });
        await Assertions.Expect(depositBtn).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await depositBtn.ClickAsync();

        // Method chooser should appear — select Lightning
        var lightningOption = page.GetByText("Lightning");
        await Assertions.Expect(lightningOption).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await lightningOption.ClickAsync();

        // Numpad should be visible — enter amount "100"
        // Use Exact=true to avoid matching "1D", "1W", "1M" time range buttons
        var numpad1 = page.GetByRole(AriaRole.Button, new() { Name = "1", Exact = true });
        var numpad0 = page.GetByRole(AriaRole.Button, new() { Name = "0", Exact = true });
        await Assertions.Expect(numpad1).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await numpad1.ClickAsync();
        await numpad0.ClickAsync();
        await numpad0.ClickAsync();

        // Click CREATE INVOICE
        var createInvoiceBtn = page.GetByRole(AriaRole.Button, new() { Name = "Create Invoice" });
        await Assertions.Expect(createInvoiceBtn).ToBeEnabledAsync(new() { Timeout = 5_000 });
        await createInvoiceBtn.ClickAsync();

        // Invoice display should appear with a bolt11 string (starts with lnbc or lntb)
        // Wait for the invoice to appear — the mint may take a moment
        var invoiceText = page.Locator("text=/ln(bc|tb)/i");
        await Assertions.Expect(invoiceText.First).ToBeVisibleAsync(new() { Timeout = 15_000 });

        // With fakewallet, the quote is auto-paid, so we should see "Payment received!"
        var paymentReceived = page.GetByText("Payment received!");
        await Assertions.Expect(paymentReceived).ToBeVisibleAsync(new() { Timeout = 30_000 });
    }

    [Fact]
    public async Task WithdrawSendEcash_GeneratesToken()
    {
        Assert.NotNull(_browser);
        var page = await _browser.NewPageAsync();
        await SetupCompleteWithMint(page);

        // First deposit some sats so we have a balance to withdraw
        await DepositViaMint(page, 500);

        await NavigateToPortfolio(page);

        // Click Withdraw button
        var withdrawBtn = page.GetByRole(AriaRole.Button, new() { Name = "Withdraw" });
        await Assertions.Expect(withdrawBtn).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await withdrawBtn.ClickAsync();

        // Select Ecash
        var ecashOption = page.GetByText("Ecash");
        await Assertions.Expect(ecashOption).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await ecashOption.ClickAsync();

        // Enter amount "100" via numpad (Exact=true to avoid matching time range buttons)
        await page.GetByRole(AriaRole.Button, new() { Name = "1", Exact = true }).ClickAsync();
        await page.GetByRole(AriaRole.Button, new() { Name = "0", Exact = true }).ClickAsync();
        await page.GetByRole(AriaRole.Button, new() { Name = "0", Exact = true }).ClickAsync();

        // Click SEND
        var sendBtn = page.GetByRole(AriaRole.Button, new() { Name = "Send" });
        await Assertions.Expect(sendBtn).ToBeEnabledAsync(new() { Timeout = 5_000 });
        await sendBtn.ClickAsync();

        // Token display should appear with a cashu token
        var tokenText = page.Locator("text=/cashu/i");
        await Assertions.Expect(tokenText.First).ToBeVisibleAsync(new() { Timeout = 15_000 });
    }

    [Fact]
    public async Task MethodChooser_NavigationAndClose()
    {
        Assert.NotNull(_browser);
        var page = await _browser.NewPageAsync();
        await SetupCompleteWithMint(page);
        await NavigateToPortfolio(page);

        // Open deposit overlay
        var depositBtn = page.GetByRole(AriaRole.Button, new() { Name = "Deposit" });
        await Assertions.Expect(depositBtn).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await depositBtn.ClickAsync();

        // Verify chooser shows both options
        await Assertions.Expect(page.GetByText("Ecash")).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await Assertions.Expect(page.GetByText("Lightning")).ToBeVisibleAsync(new() { Timeout = 5_000 });

        // Select Ecash → deposit-ecash view (has a back button)
        await page.GetByText("Ecash").ClickAsync();
        await Assertions.Expect(page.GetByText("Paste")).ToBeVisibleAsync(new() { Timeout = 5_000 });

        // Click back button (first button in header) → should return to chooser
        var overlayButtons = page.Locator(".fixed button").First;
        await overlayButtons.ClickAsync();
        await Assertions.Expect(page.GetByText("Ecash")).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await Assertions.Expect(page.GetByText("Lightning")).ToBeVisibleAsync(new() { Timeout = 5_000 });

        // Close the overlay via the X button (first button in chooser header)
        var closeBtn = page.Locator(".fixed button").First;
        await closeBtn.ClickAsync();

        // Overlay should be dismissed — deposit button should be visible again
        await Assertions.Expect(depositBtn).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    /// <summary>
    /// Helper: deposit sats into the wallet by going through the deposit-lightning flow.
    /// Uses fakewallet's auto-pay to complete the mint quote instantly.
    /// </summary>
    private async Task DepositViaMint(IPage page, int amountSats)
    {
        await NavigateToPortfolio(page);

        var depositBtn = page.GetByRole(AriaRole.Button, new() { Name = "Deposit" });
        await Assertions.Expect(depositBtn).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await depositBtn.ClickAsync();

        // Select Lightning
        await page.GetByText("Lightning").ClickAsync();

        // Enter amount digit by digit (Exact=true to avoid matching time range buttons like "1D")
        foreach (var digit in amountSats.ToString())
        {
            await page.GetByRole(AriaRole.Button, new() { Name = digit.ToString(), Exact = true }).ClickAsync();
        }

        // Create invoice
        var createBtn = page.GetByRole(AriaRole.Button, new() { Name = "Create Invoice" });
        await Assertions.Expect(createBtn).ToBeEnabledAsync(new() { Timeout = 5_000 });
        await createBtn.ClickAsync();

        // Wait for auto-payment via fakewallet
        var paymentReceived = page.GetByText("Payment received!");
        await Assertions.Expect(paymentReceived).ToBeVisibleAsync(new() { Timeout = 30_000 });

        // Close the invoice display
        var closeButtons = await page.GetByRole(AriaRole.Button).AllAsync();
        await closeButtons[0].ClickAsync();

        // Wait for overlay to close
        await Assertions.Expect(depositBtn).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    public async Task DisposeAsync()
    {
        if (_browser is not null)
            await _browser.CloseAsync();

        _playwright?.Dispose();
    }

    private static async Task WaitForService(HttpClient httpClient, string url, string serviceName)
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
