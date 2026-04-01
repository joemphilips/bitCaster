using Microsoft.Playwright;

namespace BitCaster.E2ETest;

/// <summary>
/// E2E interoperability tests between bitCaster and cashu.me wallets.
/// Tests bidirectional ecash token exchange: cashu.me ↔ bitCaster.
/// Both wallets use cashu-ts v3 with v1 keyset IDs.
///
/// Requires: mintd (8085), frontend (5173), cashu.me (3000).
/// </summary>
public class InteropTests : IAsyncLifetime
{
    private IPlaywright? _playwright;
    private IBrowser? _browser;

    private const int VitePort = 5173;
    private const int MintPort = 8085;
    private const int CashuMePort = 3000;

    private static List<string> AttachConsoleCapture(IPage page)
    {
        var messages = new List<string>();
        page.Console += (_, msg) => messages.Add($"[{msg.Type}] {msg.Text}");
        page.PageError += (_, error) => messages.Add($"[PAGE_ERROR] {error}");
        return messages;
    }

    private static async Task<Exception> BuildDiagnosticExceptionAsync(
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

    public async Task InitializeAsync()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        await WaitForService(httpClient, $"http://localhost:{MintPort}/v1/info", "Mint");
        await WaitForService(httpClient, $"http://localhost:{VitePort}", "Frontend");
        await WaitForService(httpClient, $"http://localhost:{CashuMePort}", "cashu.me");

        _playwright = await Playwright.CreateAsync();
        _browser = await _playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
        {
            Headless = true,
        });
    }

    private async Task<IBrowserContext> NewIsolatedContextAsync()
    {
        Assert.NotNull(_browser);
        var ctx = await _browser.NewContextAsync(new BrowserNewContextOptions
        {
            ServiceWorkers = ServiceWorkerPolicy.Block,
        });
        await ctx.GrantPermissionsAsync(["clipboard-read", "clipboard-write"],
            new() { Origin = $"http://localhost:{VitePort}" });
        await ctx.GrantPermissionsAsync(["clipboard-read", "clipboard-write"],
            new() { Origin = $"http://localhost:{CashuMePort}" });
        return ctx;
    }

    // =========================================================================
    // Unique mnemonics per test — must NOT overlap with DepositWithdrawTests
    // =========================================================================
    private const string MnemonicInterop1 = "seat balcony leader corn dragon vehicle report car book wear ring bus";
    private const string MnemonicInterop2 = "garment patch opera solar cruel page economy climb among pizza ecology abuse";
    private const string MnemonicCashuMe1 = "tray fluid rubber caught pause keen slice caution similar access beef attitude";
    private const string MnemonicCashuMe2 = "shaft firm spray night guard army brown tip caution diary leaf model";

    // =========================================================================
    // bitCaster helpers
    // =========================================================================

    /// <summary>
    /// Inject localStorage so bitCaster wallet is set up with a configured mint.
    /// Uses the direct mint URL so tokens are interoperable across wallets.
    /// </summary>
    private async Task SetupBitCasterWallet(IPage page, string mnemonic)
    {
        await page.GotoAsync($"http://localhost:{VitePort}/setup", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.DOMContentLoaded,
            Timeout = 30_000,
        });

        await page.EvaluateAsync($@"
            localStorage.setItem('bitcaster-wallet', JSON.stringify({{
                state: {{
                    mnemonic: '{mnemonic}',
                    setupComplete: true,
                    mints: [{{ url: 'http://localhost:{MintPort}', info: {{ name: 'Test Mint' }} }}],
                    activeMintUrl: 'http://localhost:{MintPort}',
                    keysetCounters: {{}},
                    mintConnectionStatuses: {{}}
                }},
                version: 0
            }}));
        ");
    }

    // =========================================================================
    // cashu.me helpers
    // =========================================================================

    /// <summary>
    /// Inject localStorage so cashu.me has the test mint configured.
    /// </summary>
    private async Task SetupCashuMe(IPage page, string mnemonic)
    {
        await page.GotoAsync($"http://localhost:{CashuMePort}", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.DOMContentLoaded,
            Timeout = 30_000,
        });

        var mintUrl = $"http://localhost:{MintPort}";
        await page.EvaluateAsync($@"
            localStorage.setItem('cashu.welcome.showWelcome', 'false');
            localStorage.setItem('cashu.welcome.termsAccepted', 'true');
            localStorage.setItem('cashu.mnemonic', JSON.stringify('{mnemonic}'));
            const mint = {{
                url: '{mintUrl}',
                keys: [],
                keysets: [],
                nickname: 'Test Mint'
            }};
            localStorage.setItem('cashu.mints', JSON.stringify([mint]));
            localStorage.setItem('cashu.activeMintUrl', JSON.stringify('{mintUrl}'));
            localStorage.setItem('cashu.activeUnit', JSON.stringify('sat'));
        ");

        await page.ReloadAsync(new PageReloadOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });
    }

    /// <summary>
    /// Deposit sats into cashu.me via Lightning. CDK mintd uses fakewallet which auto-pays.
    /// Flow: RECEIVE → Lightning → enter amount → Create Invoice → wait for "Paid!"
    /// </summary>
    private async Task CashuMeDepositViaLightning(IPage page, int amountSats, List<string> consoleMessages)
    {
        // Navigate to wallet page
        await page.GotoAsync($"http://localhost:{CashuMePort}", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Click RECEIVE button
        var receiveBtn = page.GetByText("RECEIVE");
        await Assertions.Expect(receiveBtn.First).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await receiveBtn.First.ClickAsync();

        // Click Lightning option in the ReceiveDialog
        var lightningOption = page.Locator(".action-row").GetByText("Lightning");
        try
        {
            await Assertions.Expect(lightningOption).ToBeVisibleAsync(new() { Timeout = 5_000 });
        }
        catch
        {
            throw await BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Lightning option not found in cashu.me ReceiveDialog");
        }
        await lightningOption.ClickAsync();

        // Enter amount on numeric keyboard
        // cashu.me's CreateInvoiceDialog has a numeric keyboard
        var digits = amountSats.ToString();
        foreach (var digit in digits)
        {
            var digitBtn = page.Locator($".q-dialog button:has-text('{digit}')").First;
            await digitBtn.ClickAsync();
        }

        // Click "Create Invoice"
        var createInvoiceBtn = page.GetByRole(AriaRole.Button, new() { Name = "Create Invoice" });
        try
        {
            await Assertions.Expect(createInvoiceBtn).ToBeVisibleAsync(new() { Timeout = 5_000 });
        }
        catch
        {
            throw await BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Create Invoice button not found in cashu.me");
        }
        await createInvoiceBtn.ClickAsync();

        // Wait for fakewallet to auto-pay. The invoice dialog may show "Paid!" briefly
        // before auto-closing (especially with WebSocket-based mint quote notifications).
        // Check for either "Paid!" or the balance updating to confirm receipt.
        var paidOrBalance = page.Locator($"text=/Paid|₿{amountSats}|{amountSats}/");
        try
        {
            await Assertions.Expect(paidOrBalance.First).ToBeVisibleAsync(new() { Timeout = 30_000 });
        }
        catch
        {
            throw await BuildDiagnosticExceptionAsync(page, consoleMessages,
                $"cashu.me Lightning invoice ({amountSats} sats) was not paid by fakewallet.");
        }

        // Close any open dialog
        await page.Keyboard.PressAsync("Escape");
        await page.WaitForTimeoutAsync(1000);
    }

    /// <summary>
    /// Generate an ecash token in cashu.me via the Send flow.
    /// Returns the cashuA token string extracted from the clipboard.
    /// </summary>
    private async Task<string> CashuMeSendEcashToken(IPage page, int amountSats, List<string> consoleMessages)
    {
        // Navigate to wallet page
        await page.GotoAsync($"http://localhost:{CashuMePort}", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Click SEND button
        var sendBtn = page.GetByText("SEND");
        await Assertions.Expect(sendBtn.First).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await sendBtn.First.ClickAsync();

        // cashu.me's SendDialog: click "Ecash" option
        var ecashOption = page.Locator(".action-row").GetByText("Ecash");
        try
        {
            await Assertions.Expect(ecashOption).ToBeVisibleAsync(new() { Timeout = 5_000 });
        }
        catch
        {
            throw await BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Ecash option not found in cashu.me SendDialog");
        }
        await ecashOption.ClickAsync();

        // Enter amount via numeric keyboard in the send ecash dialog
        var digits = amountSats.ToString();
        foreach (var digit in digits)
        {
            var digitBtn = page.Locator($".q-dialog button:has-text('{digit}')").First;
            await digitBtn.ClickAsync();
        }

        // Click "Send" to create the ecash token
        var confirmSendBtn = page.Locator(".q-dialog").GetByRole(AriaRole.Button, new() { Name = "Send" });
        await Assertions.Expect(confirmSendBtn.Last).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await confirmSendBtn.Last.ClickAsync();

        // Wait for token to be generated — look for "Copy" button which appears with the token
        var copyBtn = page.GetByRole(AriaRole.Button, new() { Name = "Copy" });
        try
        {
            await Assertions.Expect(copyBtn.First).ToBeVisibleAsync(new() { Timeout = 15_000 });
        }
        catch
        {
            throw await BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Copy button not found after cashu.me Send Ecash. Token may not have been generated.");
        }

        // Click Copy to get the token into clipboard, then read it
        await copyBtn.First.ClickAsync();
        var token = await page.EvaluateAsync<string>("navigator.clipboard.readText()");
        Assert.StartsWith("cashu", token, StringComparison.OrdinalIgnoreCase);
        return token;
    }

    // =========================================================================
    // Tests
    // =========================================================================

    [Fact]
    public async Task TokenExchange_CashuMeToBitCaster()
    {
        // Setup cashu.me
        await using var cashuMeCtx = await NewIsolatedContextAsync();
        var cashuMePage = await cashuMeCtx.NewPageAsync();
        var cashuMeConsole = AttachConsoleCapture(cashuMePage);
        await SetupCashuMe(cashuMePage, MnemonicCashuMe1);

        // Fund cashu.me via Lightning (fakewallet auto-pays)
        await CashuMeDepositViaLightning(cashuMePage, 200, cashuMeConsole);

        // Generate an ecash token in cashu.me
        var cashuMeToken = await CashuMeSendEcashToken(cashuMePage, 100, cashuMeConsole);

        // Setup bitCaster
        await using var bitCasterCtx = await NewIsolatedContextAsync();
        var bitCasterPage = await bitCasterCtx.NewPageAsync();
        var bitCasterConsole = AttachConsoleCapture(bitCasterPage);
        await SetupBitCasterWallet(bitCasterPage, MnemonicInterop1);

        // Navigate to bitCaster portfolio
        await bitCasterPage.GotoAsync($"http://localhost:{VitePort}/portfolio", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Deposit > Ecash > Paste the cashu.me token
        var depositBtn = bitCasterPage.GetByRole(AriaRole.Button, new() { Name = "Deposit" });
        await Assertions.Expect(depositBtn).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await depositBtn.ClickAsync();

        var ecashOption = bitCasterPage.GetByText("Ecash");
        await Assertions.Expect(ecashOption).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await ecashOption.ClickAsync();

        // Write cashu.me token to clipboard and click Paste
        await bitCasterPage.EvaluateAsync("text => navigator.clipboard.writeText(text)", cashuMeToken);

        var pasteBtn = bitCasterPage.GetByText("Paste");
        await Assertions.Expect(pasteBtn).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await pasteBtn.ClickAsync();

        // Wait for the paste to complete — the overlay closes on success (onDismiss called)
        var depositEcashHeading = bitCasterPage.GetByText("Deposit Ecash");
        try
        {
            await Assertions.Expect(depositEcashHeading).Not.ToBeVisibleAsync(new() { Timeout = 30_000 });
        }
        catch
        {
            throw await BuildDiagnosticExceptionAsync(bitCasterPage, bitCasterConsole,
                "Deposit Ecash overlay did not close after pasting cashu.me token. Likely receiveToken failed.");
        }

        // Verify balance by querying IndexedDB directly
        var dbInfo = await bitCasterPage.EvaluateAsync<string>(@"async () => {
            const dbs = await indexedDB.databases();
            const dbNames = dbs.map(d => d.name + ':v' + d.version);
            let balance = 0;
            let proofCount = 0;
            let error = null;
            try {
                const db = await new Promise((resolve, reject) => {
                    const req = indexedDB.open('bitcaster');
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                });
                const storeNames = Array.from(db.objectStoreNames);
                if (storeNames.includes('proofs')) {
                    const tx = db.transaction('proofs', 'readonly');
                    const store = tx.objectStore('proofs');
                    const proofs = await new Promise((resolve, reject) => {
                        const req = store.getAll();
                        req.onsuccess = () => resolve(req.result);
                        req.onerror = () => reject(req.error);
                    });
                    proofCount = proofs.length;
                    balance = proofs.reduce((sum, p) => sum + (p.amount || 0), 0);
                } else {
                    error = 'no proofs store, stores: ' + storeNames.join(',');
                }
                db.close();
            } catch (e) {
                error = e.message;
            }
            return JSON.stringify({ dbs: dbNames, proofCount, balance, error });
        }");
        var consoleLog = string.Join("\n", bitCasterConsole.TakeLast(20));
        Assert.True(dbInfo.Contains("\"balance\":100"),
            $"Expected balance 100 in IndexedDB. DB info: {dbInfo}\nConsole:\n{consoleLog}");
    }

    /// <summary>
    /// Deposit sats into bitCaster via Lightning (fakewallet auto-pays).
    /// Navigates to portfolio, creates invoice, waits for payment, closes overlay.
    /// </summary>
    private async Task BitCasterDepositViaLightning(IPage page, int amountSats, List<string> consoleMessages)
    {
        await page.GotoAsync($"http://localhost:{VitePort}/portfolio", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var depositBtn = page.GetByRole(AriaRole.Button, new() { Name = "Deposit" });
        await Assertions.Expect(depositBtn).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await depositBtn.ClickAsync();

        var lightningOption = page.GetByText("Lightning");
        await Assertions.Expect(lightningOption).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await lightningOption.ClickAsync();

        // Enter amount digit by digit
        var digits = amountSats.ToString();
        var firstDigitBtn = page.GetByRole(AriaRole.Button, new() { Name = digits[0].ToString(), Exact = true });
        await Assertions.Expect(firstDigitBtn).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await firstDigitBtn.ClickAsync();
        foreach (var digit in digits[1..])
        {
            await page.GetByRole(AriaRole.Button, new() { Name = digit.ToString(), Exact = true }).ClickAsync();
        }

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
            throw await BuildDiagnosticExceptionAsync(page, consoleMessages,
                $"BitCaster Lightning deposit ({amountSats} sats) was not paid by fakewallet.");
        }

        // Close the invoice display overlay
        var overlayCloseBtn = page.Locator(".fixed button").First;
        await overlayCloseBtn.ClickAsync(new() { Timeout = 5_000 });
        await Assertions.Expect(depositBtn).ToBeVisibleAsync(new() { Timeout = 10_000 });
    }

    /// <summary>
    /// Withdraw ecash token from bitCaster via Send Ecash flow.
    /// Returns the cashu token string.
    /// </summary>
    private async Task<string> BitCasterSendEcashToken(IPage page, int amountSats, List<string> consoleMessages)
    {
        var withdrawBtn = page.GetByRole(AriaRole.Button, new() { Name = "Withdraw" });
        await Assertions.Expect(withdrawBtn).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await withdrawBtn.ClickAsync();

        var ecashOption = page.GetByText("Ecash");
        await Assertions.Expect(ecashOption).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await ecashOption.ClickAsync();

        // Enter amount via numpad
        var digits = amountSats.ToString();
        var firstDigitBtn = page.GetByRole(AriaRole.Button, new() { Name = digits[0].ToString(), Exact = true });
        await Assertions.Expect(firstDigitBtn).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await firstDigitBtn.ClickAsync();
        foreach (var digit in digits[1..])
        {
            await page.GetByRole(AriaRole.Button, new() { Name = digit.ToString(), Exact = true }).ClickAsync();
        }

        // Click SEND
        var sendBtn = page.GetByRole(AriaRole.Button, new() { Name = "Send" });
        await Assertions.Expect(sendBtn).ToBeEnabledAsync(new() { Timeout = 5_000 });
        await sendBtn.ClickAsync();

        // Wait for token display — the "Send Ecash" heading appears with the QR code
        var sendEcashHeading = page.GetByText("Send Ecash");
        try
        {
            await Assertions.Expect(sendEcashHeading).ToBeVisibleAsync(new() { Timeout = 15_000 });
        }
        catch
        {
            throw await BuildDiagnosticExceptionAsync(page, consoleMessages,
                "BitCaster Send Ecash: token display not shown.");
        }

        // Extract token text directly from the truncated display element
        var token = await page.Locator(".font-mono.truncate").TextContentAsync(new() { Timeout = 5_000 });
        Assert.NotNull(token);
        Assert.StartsWith("cashu", token, StringComparison.OrdinalIgnoreCase);
        return token;
    }

    /// <summary>
    /// Receive an ecash token in cashu.me by pasting it.
    /// Flow: RECEIVE → Ecash → Paste (auto-reads clipboard) → Receive button.
    /// </summary>
    private async Task CashuMeReceiveEcashToken(IPage page, string token, List<string> consoleMessages)
    {
        // Navigate to wallet page
        await page.GotoAsync($"http://localhost:{CashuMePort}", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Write token to clipboard before clicking Paste (cashu.me auto-reads clipboard)
        await page.EvaluateAsync("text => navigator.clipboard.writeText(text)", token);

        // Click RECEIVE button
        var receiveBtn = page.GetByText("RECEIVE");
        await Assertions.Expect(receiveBtn.First).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await receiveBtn.First.ClickAsync();

        // Click Ecash option
        var ecashOption = page.Locator(".action-row").GetByText("Ecash");
        try
        {
            await Assertions.Expect(ecashOption).ToBeVisibleAsync(new() { Timeout = 5_000 });
        }
        catch
        {
            throw await BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Ecash option not found in cashu.me ReceiveDialog");
        }
        await ecashOption.ClickAsync();

        // The Paste button in ReceiveEcashDrawer auto-reads clipboard and opens ReceiveTokenDialog
        var pasteOption = page.Locator(".action-row").GetByText("Paste");
        try
        {
            await Assertions.Expect(pasteOption).ToBeVisibleAsync(new() { Timeout = 5_000 });
        }
        catch
        {
            throw await BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Paste option not found in cashu.me ReceiveEcashDrawer");
        }
        await pasteOption.ClickAsync();

        // ReceiveTokenDialog should appear with the token decoded.
        // Wait for the "Receive" button to be clickable, then click it.
        var confirmReceiveBtn = page.GetByRole(AriaRole.Button, new() { Name = "Receive", Exact = true });
        try
        {
            await Assertions.Expect(confirmReceiveBtn.Last).ToBeVisibleAsync(new() { Timeout = 15_000 });
        }
        catch
        {
            throw await BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Receive button not found in cashu.me ReceiveTokenDialog after pasting token.");
        }
        await confirmReceiveBtn.Last.ClickAsync();

        // Wait for the receive to complete — dialog closes and balance updates
        // Look for the "Received" success notification or balance update
        var receivedOrBalance = page.Locator("text=/Received|received/");
        try
        {
            await Assertions.Expect(receivedOrBalance.First).ToBeVisibleAsync(new() { Timeout = 30_000 });
        }
        catch
        {
            throw await BuildDiagnosticExceptionAsync(page, consoleMessages,
                "cashu.me did not show 'Received' notification after receiving bitCaster token.");
        }

        // Close any open dialog
        await page.Keyboard.PressAsync("Escape");
        await page.WaitForTimeoutAsync(1000);
    }

    [Fact]
    public async Task TokenExchange_BitCasterToCashuMe()
    {
        // Setup bitCaster and fund via Lightning
        await using var bitCasterCtx = await NewIsolatedContextAsync();
        var bitCasterPage = await bitCasterCtx.NewPageAsync();
        var bitCasterConsole = AttachConsoleCapture(bitCasterPage);
        await SetupBitCasterWallet(bitCasterPage, MnemonicInterop2);
        await BitCasterDepositViaLightning(bitCasterPage, 500, bitCasterConsole);

        // Wait for network to settle after deposit
        await bitCasterPage.WaitForLoadStateAsync(LoadState.NetworkIdle);

        // Generate ecash token from bitCaster
        var bitCasterToken = await BitCasterSendEcashToken(bitCasterPage, 100, bitCasterConsole);

        // Setup cashu.me and receive the token
        await using var cashuMeCtx = await NewIsolatedContextAsync();
        var cashuMePage = await cashuMeCtx.NewPageAsync();
        var cashuMeConsole = AttachConsoleCapture(cashuMePage);
        await SetupCashuMe(cashuMePage, MnemonicCashuMe2);

        await CashuMeReceiveEcashToken(cashuMePage, bitCasterToken, cashuMeConsole);

        // Verify cashu.me balance shows 100 sats
        var balanceText = cashuMePage.Locator("text=/100/");
        try
        {
            await Assertions.Expect(balanceText.First).ToBeVisibleAsync(new() { Timeout = 10_000 });
        }
        catch
        {
            throw await BuildDiagnosticExceptionAsync(cashuMePage, cashuMeConsole,
                "cashu.me did not show expected balance of 100 sats after receiving bitCaster token.");
        }
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
