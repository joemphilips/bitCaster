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
        await Task.WhenAll(
            TestHelpers.WaitForService(httpClient, $"http://localhost:{MintPort}/v1/info", "Mint"),
            TestHelpers.WaitForService(httpClient, $"http://localhost:{VitePort}", "Frontend"));

        _playwright = await Playwright.CreateAsync();
        _browser = await _playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
        {
            Headless = true,
        });
    }

    /// <summary>
    /// Create a new browser context with service workers blocked for test isolation.
    /// </summary>
    private async Task<IBrowserContext> NewIsolatedContextAsync()
    {
        Assert.NotNull(_browser);
        return await _browser.NewContextAsync(new BrowserNewContextOptions
        {
            ServiceWorkers = ServiceWorkerPolicy.Block,
        });
    }

    /// <summary>
    /// Inject localStorage so wallet is set up with a configured mint.
    /// The mint URL points directly to localhost:8085 where mintd runs.
    /// Service workers are blocked at the context level, so no manual unregistration needed.
    /// </summary>
    private async Task SetupCompleteWithMint(IPage page, string? mnemonic = null)
    {
        mnemonic ??= TestMnemonics.Get();

        await page.GotoAsync($"http://localhost:{VitePort}/setup", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.DOMContentLoaded,
            Timeout = 30_000,
        });

        // Use the frontend URL as mint URL so cashu-ts requests go through
        // the nginx/Vite proxy (/v1/ → mintd). This avoids cross-origin issues
        // in Docker where the browser is on localhost:5173 but mint is on localhost:8085.
        await page.EvaluateAsync($@"
            localStorage.setItem('bitcaster-wallet', JSON.stringify({{
                state: {{
                    mnemonic: '{mnemonic}',
                    setupComplete: true,
                    mints: [{{ url: 'http://localhost:{VitePort}', info: {{ name: 'Test Mint' }} }}],
                    activeMintUrl: 'http://localhost:{VitePort}',
                    keysetCounters: {{}},
                    mintConnectionStatuses: {{}}
                }},
                version: 0
            }}));
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
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();

        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

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
        try
        {
            await Assertions.Expect(invoiceText.First).ToBeVisibleAsync(new() { Timeout = 15_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages, "Invoice not found.");
        }

        // With fakewallet, the quote is auto-paid, so we should see "Payment received!"
        var paymentReceived = page.GetByText("Payment received!");
        await Assertions.Expect(paymentReceived).ToBeVisibleAsync(new() { Timeout = 30_000 });
    }

    [Fact]
    public async Task WithdrawSendEcash_GeneratesToken()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();

        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        await SetupCompleteWithMint(page);

        // First deposit some sats so we have a balance to withdraw.
        // DepositViaMint ends on the portfolio page, so no need to navigate again.
        // Navigating again would cause a full page reload, resetting the in-memory
        // cashu-ts keyset counter to 0 and triggering "Blinded Message is already signed".
        await DepositViaMint(page, 500, consoleMessages);

        // After deposit, wait for network activity and React re-renders to settle
        await page.WaitForLoadStateAsync(LoadState.NetworkIdle);

        // Click Withdraw button
        var withdrawBtn = page.GetByRole(AriaRole.Button, new() { Name = "Withdraw" });
        await Assertions.Expect(withdrawBtn).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await withdrawBtn.ClickAsync();

        // Select Ecash — wait for method chooser to appear
        var ecashOption = page.GetByText("Ecash");
        await Assertions.Expect(ecashOption).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await ecashOption.ClickAsync();

        // Wait for numpad to appear, then enter amount "100"
        var numpad1 = page.GetByRole(AriaRole.Button, new() { Name = "1", Exact = true });
        await Assertions.Expect(numpad1).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await numpad1.ClickAsync();
        await page.GetByRole(AriaRole.Button, new() { Name = "0", Exact = true }).ClickAsync();
        await page.GetByRole(AriaRole.Button, new() { Name = "0", Exact = true }).ClickAsync();

        // Click SEND
        var sendBtn = page.GetByRole(AriaRole.Button, new() { Name = "Send" });
        await Assertions.Expect(sendBtn).ToBeEnabledAsync(new() { Timeout = 5_000 });
        await sendBtn.ClickAsync();

        // Token display should appear with a cashu token
        var tokenText = page.Locator("text=/cashu/i");
        try
        {
            await Assertions.Expect(tokenText.First).ToBeVisibleAsync(new() { Timeout = 15_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages, "WithdrawSendEcash: Cashu token not found.");
        }
    }

    [Fact]
    public async Task MethodChooser_NavigationAndClose()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
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
    private async Task DepositViaMint(IPage page, int amountSats, List<string>? consoleMessages = null)
    {
        consoleMessages ??= TestHelpers.AttachConsoleCapture(page);

        await NavigateToPortfolio(page);

        var depositBtn = page.GetByRole(AriaRole.Button, new() { Name = "Deposit" });
        await Assertions.Expect(depositBtn).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await depositBtn.ClickAsync();

        // Wait for method chooser, then select Lightning
        var lightningOption = page.GetByText("Lightning");
        await Assertions.Expect(lightningOption).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await lightningOption.ClickAsync();

        // Enter amount digit by digit — wait for numpad to be visible first
        var digits = amountSats.ToString();
        var firstDigitBtn = page.GetByRole(AriaRole.Button, new() { Name = digits[0].ToString(), Exact = true });
        await Assertions.Expect(firstDigitBtn).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await firstDigitBtn.ClickAsync();
        foreach (var digit in digits[1..])
        {
            await page.GetByRole(AriaRole.Button, new() { Name = digit.ToString(), Exact = true }).ClickAsync();
        }

        // Create invoice
        var createBtn = page.GetByRole(AriaRole.Button, new() { Name = "Create Invoice" });
        await Assertions.Expect(createBtn).ToBeEnabledAsync(new() { Timeout = 5_000 });
        await createBtn.ClickAsync();

        // Wait for auto-payment via fakewallet
        var paymentReceived = page.GetByText("Payment received!");
        try
        {
            await Assertions.Expect(paymentReceived).ToBeVisibleAsync(new() { Timeout = 30_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages, $"DepositViaMint({amountSats}): Payment not received.");
        }

        // Close the invoice display overlay — click the X button inside the overlay
        var overlayCloseBtn = page.Locator(".fixed button").First;
        await overlayCloseBtn.ClickAsync(new() { Timeout = 5_000 });

        // Wait for overlay to close
        await Assertions.Expect(depositBtn).ToBeVisibleAsync(new() { Timeout = 10_000 });
    }

    public async Task DisposeAsync()
    {
        if (_browser is not null)
            await _browser.CloseAsync();

        _playwright?.Dispose();
    }

}
