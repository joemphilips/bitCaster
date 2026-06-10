using Microsoft.Playwright;

namespace BitCaster.E2ETest;

/// <summary>
/// E2E interoperability tests between bitCaster and cashu.me wallets.
/// Tests bidirectional ecash token exchange: cashu.me ↔ bitCaster.
/// Both wallets use cashu-ts v3 with v1 keyset IDs.
///
/// Requires: mintd (8085), frontend (5273), cashu.me (3000).
/// </summary>
public class InteropTests : IAsyncLifetime
{
    private IPlaywright? _playwright;
    private IBrowser? _browser;

    public async Task InitializeAsync()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        await Task.WhenAll(
            TestHelpers.WaitForService(httpClient, $"{TestPorts.MintUrl}/v1/info", "Mint"),
            TestHelpers.WaitForService(httpClient, $"{TestPorts.FrontendUrl}", "Frontend"),
            TestHelpers.WaitForService(httpClient, $"{TestPorts.CashuMeUrl}", "cashu.me"));

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
            new() { Origin = $"{TestPorts.FrontendUrl}" });
        await ctx.GrantPermissionsAsync(["clipboard-read", "clipboard-write"],
            new() { Origin = $"{TestPorts.CashuMeUrl}" });
        return ctx;
    }

    // =========================================================================
    // bitCaster helpers
    // =========================================================================

    /// <summary>
    /// Inject localStorage so bitCaster wallet is set up with a configured mint.
    /// Uses the direct mint URL so tokens are interoperable across wallets.
    /// </summary>
    private async Task SetupBitCasterWallet(IPage page, string mnemonic)
    {
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
                    mints: [{{ url: '{TestPorts.MintUrl}', info: {{ name: 'Test Mint', nuts: {TestHelpers.CtfNutsJson} }} }}],
                    activeMintUrl: '{TestPorts.MintUrl}',
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
        await page.GotoAsync($"{TestPorts.CashuMeUrl}", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.DOMContentLoaded,
            Timeout = 30_000,
        });

        var mintUrl = $"{TestPorts.MintUrl}";
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
        await page.GotoAsync($"{TestPorts.CashuMeUrl}", new PageGotoOptions
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
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
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
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Create Invoice button not found in cashu.me");
        }
        await createInvoiceBtn.ClickAsync();

        // Wait until cashu.me's Dexie has persisted the minted proofs. The
        // InvoiceDetailDialog's "Paid!" text is transient (auto-closes fast on CI)
        // and the old regex text=/Paid|₿200|200/ matched the amount header the
        // dialog renders immediately on open — a no-op that let the test race
        // ahead before wallet.mint() had called addProofs().
        try
        {
            await WaitForCashuMeBalance(page, amountSats, timeoutMs: 30_000);
        }
        catch (Exception ex)
        {
            var balance = await ReadCashuMeBalanceAsync(page);
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                $"cashu.me Lightning invoice ({amountSats} sats) not completed: " +
                $"balance={balance} sats, wait error={ex.Message}");
        }

        // Close any open dialog (it may have already auto-closed on fast machines).
        await page.Keyboard.PressAsync("Escape");

        var finalBalance = await ReadCashuMeBalanceAsync(page);
        if (finalBalance < amountSats)
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                $"cashu.me Lightning invoice ({amountSats} sats) completed transiently, " +
                $"but persisted balance is only {finalBalance} sats.");
        }
    }

    private async Task EnsureCashuMeFunded(
        IPage page,
        int amountSats,
        List<string> consoleMessages)
    {
        var balance = await ReadCashuMeBalanceAsync(page);
        if (balance >= amountSats) return;

        await CashuMeDepositViaLightning(page, amountSats - Math.Max(balance, 0), consoleMessages);

        balance = await ReadCashuMeBalanceAsync(page);
        if (balance < amountSats)
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                $"cashu.me funding setup did not persist enough balance: {balance} sats, " +
                $"expected at least {amountSats} sats.");
        }
    }

    /// <summary>
    /// Inline JS that mirrors cashu.me's active balance calculation: proofs
    /// must be unreserved and belong to a keyset for the active mint/unit.
    /// Returns <c>-1</c> if local wallet state is not initialised. Shared by
    /// <see cref="ReadCashuMeBalanceAsync"/> and <see cref="WaitForCashuMeBalance"/>.
    /// </summary>
    private const string CashuMeReadBalanceJs = @"async () => {
        try {
            const db = await new Promise((resolve, reject) => {
                const req = indexedDB.open('db');
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            if (!Array.from(db.objectStoreNames).includes('proofs')) {
                db.close();
                return -1;
            }
            const parseMaybeJson = (raw) => {
                if (raw == null) return null;
                try { return JSON.parse(raw); } catch { return raw; }
            };
            const activeMintUrl = parseMaybeJson(localStorage.getItem('cashu.activeMintUrl'));
            const activeUnit = parseMaybeJson(localStorage.getItem('cashu.activeUnit')) || 'sat';
            const mints = parseMaybeJson(localStorage.getItem('cashu.mints')) || [];
            const activeMint = mints.find((m) => m.url === activeMintUrl);
            const keysetIds = new Set((activeMint?.keysets || [])
                .filter((k) => k.unit === activeUnit)
                .map((k) => k.id));
            if (keysetIds.size === 0) {
                db.close();
                return -1;
            }
            const tx = db.transaction('proofs', 'readonly');
            const proofs = await new Promise((resolve, reject) => {
                const req = tx.objectStore('proofs').getAll();
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            db.close();
            return proofs
                .filter((p) => !p.reserved && keysetIds.has(p.id))
                .reduce((sum, p) => sum + (p.amount || 0), 0);
        } catch (e) {
            return -1;
        }
    }";

    /// <summary>
    /// Wait (inside the browser, via <c>WaitForFunctionAsync</c>) until
    /// cashu.me's Dexie <c>db</c> → <c>proofs</c> table has a summed amount of
    /// at least <paramref name="expectedSats"/>. This is the only reliable
    /// completion signal after an invoice is paid — the UI's "Paid!" text
    /// flips on status change, but <c>proofsStore.addProofs()</c> runs afterwards.
    /// </summary>
    private static Task WaitForCashuMeBalance(IPage page, int expectedSats, int timeoutMs)
        => WaitForNumericConditionAsync(
            () => ReadCashuMeBalanceAsync(page),
            value => value >= expectedSats,
            timeoutMs,
            pollingMs: 200);

    /// <summary>
    /// One-shot read of the total balance from cashu.me's Dexie <c>db</c>
    /// database's <c>proofs</c> object store. Returns the summed <c>amount</c>,
    /// or <c>-1</c> if the database or store is missing.
    /// Used from catch blocks to enrich diagnostic messages.
    /// </summary>
    private static Task<int> ReadCashuMeBalanceAsync(IPage page)
        => page.EvaluateAsync<int>(CashuMeReadBalanceJs);

    private static async Task WaitForNumericConditionAsync(
        Func<Task<int>> readValue,
        Func<int, bool> predicate,
        int timeoutMs,
        int pollingMs)
    {
        using var cts = new CancellationTokenSource(timeoutMs);
        while (!cts.IsCancellationRequested)
        {
            var value = await readValue();
            if (predicate(value)) return;
            try
            {
                await Task.Delay(pollingMs, cts.Token);
            }
            catch (TaskCanceledException)
            {
                break;
            }
        }

        throw new TimeoutException($"Condition was not satisfied within {timeoutMs}ms.");
    }

    /// <summary>
    /// Generate an ecash token in cashu.me via the Send flow.
    /// Returns the cashuA token string extracted from the clipboard.
    /// </summary>
    private async Task<string> CashuMeSendEcashToken(IPage page, int amountSats, List<string> consoleMessages)
    {
        // Navigate to wallet page
        await page.GotoAsync($"{TestPorts.CashuMeUrl}", new PageGotoOptions
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
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
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

        // Click "Send" to create the ecash token — wait for enabled (balance must load first)
        var confirmSendBtn = page.Locator(".q-dialog").GetByRole(AriaRole.Button, new() { Name = "Send" });
        try
        {
            await Assertions.Expect(confirmSendBtn.Last).ToBeEnabledAsync(new() { Timeout = 15_000 });
        }
        catch
        {
            var diagBalance = await ReadCashuMeBalanceAsync(page);
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                $"Send button not enabled in cashu.me SendTokenDialog. " +
                $"IndexedDB balance at failure: {diagBalance} sats (expected >= {amountSats}).");
        }
        await confirmSendBtn.Last.ClickAsync();

        // Wait for token to be generated — look for "Copy" button which appears with the token
        var copyBtn = page.GetByRole(AriaRole.Button, new() { Name = "Copy" });
        try
        {
            await Assertions.Expect(copyBtn.First).ToBeVisibleAsync(new() { Timeout = 15_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
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
        var (cashuMeMnemonic, bitCasterMnemonic) = TestMnemonics.GetPair();

        // Setup cashu.me
        await using var cashuMeCtx = await NewIsolatedContextAsync();
        var cashuMePage = await cashuMeCtx.NewPageAsync();
        var cashuMeConsole = TestHelpers.AttachConsoleCapture(cashuMePage);
        await SetupCashuMe(cashuMePage, cashuMeMnemonic);

        // Fund cashu.me via Lightning (fakewallet auto-pays)
        await CashuMeDepositViaLightning(cashuMePage, 200, cashuMeConsole);

        // Generate an ecash token in cashu.me
        var cashuMeToken = await CashuMeSendEcashToken(cashuMePage, 100, cashuMeConsole);

        // Setup bitCaster
        await using var bitCasterCtx = await NewIsolatedContextAsync();
        var bitCasterPage = await bitCasterCtx.NewPageAsync();
        var bitCasterConsole = TestHelpers.AttachConsoleCapture(bitCasterPage);
        await SetupBitCasterWallet(bitCasterPage, bitCasterMnemonic);

        // Navigate to bitCaster portfolio
        await bitCasterPage.GotoAsync($"{TestPorts.FrontendUrl}/portfolio", new PageGotoOptions
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
            throw await TestHelpers.BuildDiagnosticExceptionAsync(bitCasterPage, bitCasterConsole,
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
        Assert.True(dbInfo.Contains("\"balance\":99"),
            $"Expected spendable balance 99 in IndexedDB after mint input fee. DB info: {dbInfo}\nConsole:\n{consoleLog}");
    }

    /// <summary>
    /// Deposit sats into bitCaster via Lightning (fakewallet auto-pays).
    /// Navigates to portfolio, creates invoice, waits for payment, closes overlay.
    /// </summary>
    private async Task BitCasterDepositViaLightning(IPage page, int amountSats, List<string> consoleMessages)
    {
        await page.GotoAsync($"{TestPorts.FrontendUrl}/portfolio", new PageGotoOptions
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

        await TestHelpers.WaitForBalanceTextAsync(
            page,
            amountSats,
            consoleMessages,
            $"BitCaster Lightning deposit ({amountSats} sats) did not credit the visible wallet balance.");
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
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
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
        await page.GotoAsync($"{TestPorts.CashuMeUrl}", new PageGotoOptions
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
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
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
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Paste option not found in cashu.me ReceiveEcashDrawer");
        }
        await pasteOption.ClickAsync();

        // ReceiveTokenDialog should appear with the token decoded.
        // Button text may be "Receive", "Receive (known mint)", or "Receive (adding mint)".
        // Scope to the dialog to avoid matching the main wallet's RECEIVE button.
        var confirmReceiveBtn = page.Locator(".q-dialog").GetByRole(AriaRole.Button, new() { NameRegex = new System.Text.RegularExpressions.Regex("^Receive") });
        try
        {
            await Assertions.Expect(confirmReceiveBtn.Last).ToBeEnabledAsync(new() { Timeout = 15_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Receive button not found/enabled in cashu.me ReceiveTokenDialog after pasting token.");
        }
        // Force click to bypass Quasar scroll-container pointer interception
        await confirmReceiveBtn.Last.ClickAsync(new() { Force = true });

        // Wait for the receive to complete — dialog closes and balance updates
        // Look for the "Received" success notification or balance update
        var receivedOrBalance = page.Locator("text=/Received|received/");
        try
        {
            await Assertions.Expect(receivedOrBalance.First).ToBeVisibleAsync(new() { Timeout = 30_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "cashu.me did not show 'Received' notification after receiving bitCaster token.");
        }

        // Close any open dialog
        await page.Keyboard.PressAsync("Escape");
        await page.WaitForTimeoutAsync(1000);
    }

    [Fact]
    public async Task TokenExchange_BitCasterToCashuMe()
    {
        var (bitCasterMnemonic, cashuMeMnemonic) = TestMnemonics.GetPair();

        // Setup bitCaster and fund via Lightning
        await using var bitCasterCtx = await NewIsolatedContextAsync();
        var bitCasterPage = await bitCasterCtx.NewPageAsync();
        var bitCasterConsole = TestHelpers.AttachConsoleCapture(bitCasterPage);
        await SetupBitCasterWallet(bitCasterPage, bitCasterMnemonic);
        await BitCasterDepositViaLightning(bitCasterPage, 500, bitCasterConsole);

        // Wait for network to settle after deposit
        await bitCasterPage.WaitForLoadStateAsync(LoadState.NetworkIdle);

        // Generate ecash token from bitCaster
        var bitCasterToken = await BitCasterSendEcashToken(bitCasterPage, 100, bitCasterConsole);

        // Setup cashu.me and receive the token
        await using var cashuMeCtx = await NewIsolatedContextAsync();
        var cashuMePage = await cashuMeCtx.NewPageAsync();
        var cashuMeConsole = TestHelpers.AttachConsoleCapture(cashuMePage);
        await SetupCashuMe(cashuMePage, cashuMeMnemonic);

        await CashuMeReceiveEcashToken(cashuMePage, bitCasterToken, cashuMeConsole);

        // Verify cashu.me shows the spendable balance after mint input fee.
        var balanceText = cashuMePage.Locator("text=/99/");
        try
        {
            await Assertions.Expect(balanceText.First).ToBeVisibleAsync(new() { Timeout = 10_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(cashuMePage, cashuMeConsole,
                "cashu.me did not show expected spendable balance of 99 sats after receiving bitCaster token.");
        }
    }

    // =========================================================================
    // Payment-request helpers (NIP-17)
    //
    // bitCaster creates a PaymentRequest with a Nostr transport pointing at
    // its own nprofile. cashu.me pays it from Send → Lightning (the
    // PayInvoiceDialog parses creq/bolt11) → SendTokenDialog → Pay button.
    // Both sides are forced onto the local nostr-rs-relay (`ws://localhost:7777`)
    // so the test does not depend on public relays being reachable from CI.
    // =========================================================================

    /// <summary>Local nostr-rs-relay exposed by docker-compose.yml.</summary>
    private const string LocalNostrRelayUrl = "ws://localhost:7777";

    /// <summary>
    /// Inject localStorage so bitCaster is wallet-configured AND forced onto
    /// the local nostr relay. The listener reads relays from
    /// <c>bitcaster-settings</c>, and <c>useDepositWithdrawState.onRequest</c>
    /// now embeds those same relays in the nprofile — so setting this field
    /// makes sender + recipient land on the same relay.
    /// </summary>
    private async Task SetupBitCasterWithLocalRelay(IPage page, string mnemonic)
    {
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
                    mints: [{{ url: '{TestPorts.MintUrl}', info: {{ name: 'Test Mint', nuts: {TestHelpers.CtfNutsJson} }} }}],
                    activeMintUrl: '{TestPorts.MintUrl}',
                    keysetCounters: {{}},
                    mintConnectionStatuses: {{}}
                }},
                version: 0
            }}));
            localStorage.setItem('bitcaster-settings', JSON.stringify({{
                state: {{
                    baseCurrency: 'BTC',
                    language: 'en',
                    theme: 'dark',
                    nostrSignerMode: 'none',
                    relays: [{{ url: '{LocalNostrRelayUrl}', connectionStatus: 'disconnected' }}],
                    nsecSecret: null
                }},
                version: 0
            }}));
        ");
    }

    private async Task ConfigureCashuMeLocalRelay(IPage page)
    {
        await page.EvaluateAsync($@"
            localStorage.setItem('cashu.nostr.relays', JSON.stringify(['{LocalNostrRelayUrl}']));
            localStorage.setItem('cashu.settings.defaultNostrRelays', JSON.stringify(['{LocalNostrRelayUrl}']));
        ");

        await page.ReloadAsync(new PageReloadOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });
    }

    /// <summary>
    /// Drive bitCaster through Portfolio → Deposit → Ecash → Request.
    /// Returns the encoded <c>creq...</c> string that a sender wallet can pay.
    /// Leaves the PaymentRequestDisplay view mounted so the happy-path test
    /// can observe the "Payment received!" transition; the reload variant
    /// closes + reloads explicitly.
    /// </summary>
    private async Task<string> BitCasterCreatePaymentRequest(IPage page, List<string> consoleMessages)
    {
        await page.GotoAsync($"{TestPorts.FrontendUrl}/portfolio", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var depositBtn = page.GetByRole(AriaRole.Button, new() { Name = "Deposit" });
        await Assertions.Expect(depositBtn).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await depositBtn.ClickAsync();

        var ecashOption = page.GetByText("Ecash");
        await Assertions.Expect(ecashOption).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await ecashOption.ClickAsync();

        var requestOption = page.GetByRole(AriaRole.Button, new() { Name = "Request" });
        try
        {
            await Assertions.Expect(requestOption).ToBeVisibleAsync(new() { Timeout = 5_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Request option not visible in bitCaster DepositEcash view.");
        }
        await requestOption.ClickAsync();

        // PaymentRequestDisplay renders the encoded request text in a
        // truncated (visual only) mono span. Read the full text via DOM.
        var requestHeading = page.GetByRole(AriaRole.Heading, new() { Name = "Payment Request" });
        try
        {
            await Assertions.Expect(requestHeading).ToBeVisibleAsync(new() { Timeout = 10_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "PaymentRequestDisplay did not mount after clicking Request in bitCaster.");
        }

        var creqLocator = page.Locator(".font-mono.truncate").First;
        var creq = (await creqLocator.TextContentAsync(new() { Timeout = 5_000 }))?.Trim();
        if (string.IsNullOrEmpty(creq) || !creq.StartsWith("creq", StringComparison.OrdinalIgnoreCase))
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                $"Payment request encoded string not readable from display: '{creq}'");
        }
        return creq;
    }

    private static Task WaitForBitCasterNip17Listener(IPage page)
        => page.WaitForFunctionAsync(
            @"(expectedRelay) => {
                const diagnostics = window.__BITCASTER_E2E__?.getNip17ListenerDiagnostics?.();
                return diagnostics?.active === true && diagnostics.relayKey === expectedRelay;
            }",
            arg: LocalNostrRelayUrl,
            new PageWaitForFunctionOptions { Timeout = 15_000, PollingInterval = 250 });

    private static Task<string> BitCasterNip17ListenerDiagnostics(IPage page)
        => page.EvaluateAsync<string>(
            @"() => JSON.stringify(window.__BITCASTER_E2E__?.getNip17ListenerDiagnostics?.() ?? null)");

    /// <summary>
    /// Pay a bitCaster-issued PaymentRequest from cashu.me. Flow:
    /// SEND → Lightning (opens PayInvoiceDialog) → paste creq into
    /// ParseInputComponent → SendTokenDialog auto-opens with the PR info →
    /// type <paramref name="amountSats"/> on the NumericKeyboard → click Pay.
    /// </summary>
    private async Task CashuMePayPaymentRequest(
        IPage page, string creq, int amountSats, List<string> consoleMessages)
    {
        await page.GotoAsync($"{TestPorts.CashuMeUrl}", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var sendBtn = page.GetByText("SEND");
        await Assertions.Expect(sendBtn.First).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await sendBtn.First.ClickAsync();

        var lightningOption = page.Locator(".action-row").GetByText("Lightning");
        try
        {
            await Assertions.Expect(lightningOption).ToBeVisibleAsync(new() { Timeout = 5_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "Lightning option not found in cashu.me SendDialog (for creq paste).");
        }
        await lightningOption.ClickAsync();

        // ParseInputComponent is the input inside PayInvoiceDialog. Set the
        // model value via clipboard + its Paste button so Vue's @update:model-value
        // fires decodeAndQuote → decodeRequest → handlePaymentRequest. The
        // pasteToParseDialog method reads from navigator.clipboard.
        await page.EvaluateAsync("text => navigator.clipboard.writeText(text)", creq);

        var parseInput = page.Locator(".q-dialog input, .q-dialog textarea").First;
        try
        {
            await Assertions.Expect(parseInput).ToBeVisibleAsync(new() { Timeout = 10_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                "cashu.me PayInvoiceDialog input not found after clicking Lightning.");
        }
        await parseInput.FillAsync(creq);
        // Blur to trigger the watch/update handler that parses the creq.
        await parseInput.PressAsync("Tab");

        // SendTokenDialog should auto-open once the creq is decoded. It shows
        // a numeric keypad + a Pay button (SendPaymentRequest when
        // sendData.paymentRequest is set).
        var digits = amountSats.ToString();
        foreach (var digit in digits)
        {
            var digitBtn = page.Locator($".q-dialog button:has-text('{digit}')").First;
            try
            {
                await Assertions.Expect(digitBtn).ToBeVisibleAsync(new() { Timeout = 15_000 });
            }
            catch
            {
                throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                    $"cashu.me numeric keypad digit '{digit}' not found — " +
                    "SendTokenDialog may not have opened after the creq paste.");
            }
            await digitBtn.ClickAsync();
        }

        // The Pay button label is "Pay via Nostr" (SendTokenDialog.actions.pay.label).
        // Match loosely by ^Pay to tolerate label drift.
        var payBtn = page.Locator(".q-dialog").GetByRole(AriaRole.Button,
            new() { NameRegex = new System.Text.RegularExpressions.Regex("^Pay") });
        try
        {
            await Assertions.Expect(payBtn.Last).ToBeEnabledAsync(new() { Timeout = 15_000 });
        }
        catch
        {
            var balanceDiag = await page.EvaluateAsync<string>(@"async () => {
                const db = await new Promise((resolve, reject) => {
                    const req = indexedDB.open('db');
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                });
                const tx = db.transaction('proofs', 'readonly');
                const proofs = await new Promise((resolve, reject) => {
                    const req = tx.objectStore('proofs').getAll();
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                });
                db.close();
                const parseMaybeJson = (raw) => {
                    if (raw == null) return null;
                    try { return JSON.parse(raw); } catch { return raw; }
                };
                const mints = parseMaybeJson(localStorage.getItem('cashu.mints')) || [];
                return JSON.stringify({
                    activeMintUrl: parseMaybeJson(localStorage.getItem('cashu.activeMintUrl')),
                    activeUnit: parseMaybeJson(localStorage.getItem('cashu.activeUnit')),
                    proofCount: proofs.length,
                    proofs: proofs.map(p => ({ id: p.id, amount: p.amount, reserved: p.reserved, quote: p.quote })),
                    mints: mints.map(m => ({
                        url: m.url,
                        keysets: (m.keysets || []).map(k => ({ id: k.id, unit: k.unit, active: k.active }))
                    }))
                });
            }");
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                $"cashu.me Pay button not enabled. Balance may be insufficient for {amountSats} sats. " +
                $"cashu.me balance diagnostic: {balanceDiag}");
        }
        await payBtn.Last.ClickAsync(new() { Force = true });
    }

    /// <summary>
    /// JS snippet that queries bitCaster's Dexie <c>bitcaster</c> database for
    /// the summed <c>amount</c> across every proof row. Returns <c>-1</c> if
    /// the database or store is missing. Mirrors
    /// <see cref="CashuMeReadBalanceJs"/> but against bitCaster's schema.
    /// </summary>
    private const string BitCasterReadBalanceJs = @"async () => {
        try {
            const db = await new Promise((resolve, reject) => {
                const req = indexedDB.open('bitcaster');
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            if (!Array.from(db.objectStoreNames).includes('proofs')) {
                db.close();
                return -1;
            }
            const tx = db.transaction('proofs', 'readonly');
            const proofs = await new Promise((resolve, reject) => {
                const req = tx.objectStore('proofs').getAll();
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            db.close();
            return proofs.reduce((sum, p) => sum + (p.amount || 0), 0);
        } catch (e) {
            return -1;
        }
    }";

    private static Task WaitForBitCasterBalance(IPage page, int expectedSats, int timeoutMs)
        => WaitForNumericConditionAsync(
            () => page.EvaluateAsync<int>(BitCasterReadBalanceJs),
            value => value >= expectedSats,
            timeoutMs,
            pollingMs: 250);

    /// <summary>
    /// bitCaster issues a PaymentRequest, cashu.me pays it via NIP-17, and
    /// bitCaster's continuous listener in <c>App.tsx::startNip17Listener</c>
    /// redeems the payload + updates balance. Regression guard for P5 item 5.
    /// </summary>
    [Fact]
    public async Task PaymentRequest_BitCasterInitiated_CashuMePays_BitCasterReceives()
    {
        var (cashuMeMnemonic, bitCasterMnemonic) = TestMnemonics.GetPair();
        const int payAmount = 100;
        const int minimumReceivedAfterInputFee = payAmount - 1;

        // cashu.me: fund via Lightning so it has ecash to pay the request.
        await using var cashuMeCtx = await NewIsolatedContextAsync();
        var cashuMePage = await cashuMeCtx.NewPageAsync();
        var cashuMeConsole = TestHelpers.AttachConsoleCapture(cashuMePage);
        await SetupCashuMe(cashuMePage, cashuMeMnemonic);
        await CashuMeDepositViaLightning(cashuMePage, 500, cashuMeConsole);
        // cashu.me's local-relay NIP-17 subscription can race its Lightning
        // minting flow in Chromium; fund first, then point outgoing payment
        // requests at the test relay.
        await ConfigureCashuMeLocalRelay(cashuMePage);
        await EnsureCashuMeFunded(cashuMePage, payAmount, cashuMeConsole);

        // bitCaster: create the PaymentRequest.
        await using var bitCasterCtx = await NewIsolatedContextAsync();
        var bitCasterPage = await bitCasterCtx.NewPageAsync();
        var bitCasterConsole = TestHelpers.AttachConsoleCapture(bitCasterPage);
        await SetupBitCasterWithLocalRelay(bitCasterPage, bitCasterMnemonic);
        var creq = await BitCasterCreatePaymentRequest(bitCasterPage, bitCasterConsole);
        await WaitForBitCasterNip17Listener(bitCasterPage);

        // cashu.me: pay the request — this publishes a NIP-17 gift wrap to
        // the local relay embedded in bitCaster's nprofile.
        await CashuMePayPaymentRequest(cashuMePage, creq, payAmount, cashuMeConsole);

        // bitCaster side: continuous listener should see the DM and redeem.
        // Check the UI status flip first (it's the product-visible outcome),
        // then confirm proofs actually landed in IndexedDB.
        var receivedBanner = bitCasterPage.GetByText("Payment received!");
        try
        {
            await Assertions.Expect(receivedBanner).ToBeVisibleAsync(new() { Timeout = 45_000 });
        }
        catch
        {
            var listenerDiagnostics = await BitCasterNip17ListenerDiagnostics(bitCasterPage);
            throw await TestHelpers.BuildDiagnosticExceptionAsync(bitCasterPage, bitCasterConsole,
                "bitCaster PaymentRequestDisplay never flipped to 'Payment received!' — " +
                $"NIP-17 DM not routed end-to-end. Listener: {listenerDiagnostics}");
        }

        try
        {
            await WaitForBitCasterBalance(bitCasterPage, minimumReceivedAfterInputFee, timeoutMs: 15_000);
        }
        catch
        {
            var balance = await bitCasterPage.EvaluateAsync<int>(BitCasterReadBalanceJs);
            throw await TestHelpers.BuildDiagnosticExceptionAsync(bitCasterPage, bitCasterConsole,
                $"bitCaster banner flipped but Dexie balance never reached {minimumReceivedAfterInputFee}: {balance}.");
        }
    }

    /// <summary>
    /// Reload-resilience variant — proves the continuous-subscribe fix. If
    /// bitCaster's NIP-17 subscription were still view-scoped, reloading
    /// before cashu.me pays would drop the DM. With the module-scope listener
    /// re-started from <c>App.tsx</c> on boot, the payment must still land.
    /// </summary>
    [Fact]
    public async Task PaymentRequest_BitCasterReloadsBeforePayment_StillReceives()
    {
        var (cashuMeMnemonic, bitCasterMnemonic) = TestMnemonics.GetPair();
        const int payAmount = 100;
        const int minimumReceivedAfterInputFee = payAmount - 1;

        await using var cashuMeCtx = await NewIsolatedContextAsync();
        var cashuMePage = await cashuMeCtx.NewPageAsync();
        var cashuMeConsole = TestHelpers.AttachConsoleCapture(cashuMePage);
        await SetupCashuMe(cashuMePage, cashuMeMnemonic);
        await CashuMeDepositViaLightning(cashuMePage, 500, cashuMeConsole);
        // cashu.me's local-relay NIP-17 subscription can race its Lightning
        // minting flow in Chromium; fund first, then point outgoing payment
        // requests at the test relay.
        await ConfigureCashuMeLocalRelay(cashuMePage);
        await EnsureCashuMeFunded(cashuMePage, payAmount, cashuMeConsole);

        await using var bitCasterCtx = await NewIsolatedContextAsync();
        var bitCasterPage = await bitCasterCtx.NewPageAsync();
        var bitCasterConsole = TestHelpers.AttachConsoleCapture(bitCasterPage);
        await SetupBitCasterWithLocalRelay(bitCasterPage, bitCasterMnemonic);
        var creq = await BitCasterCreatePaymentRequest(bitCasterPage, bitCasterConsole);
        await WaitForBitCasterNip17Listener(bitCasterPage);

        // The PaymentRequest lives in the creq string (Nostr transport +
        // pubkey + relays). Losing React state after reload must not prevent
        // the listener from redeeming a DM that arrives later.
        await bitCasterPage.ReloadAsync(new PageReloadOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });
        await WaitForBitCasterNip17Listener(bitCasterPage);

        await CashuMePayPaymentRequest(cashuMePage, creq, payAmount, cashuMeConsole);

        try
        {
            await WaitForBitCasterBalance(bitCasterPage, minimumReceivedAfterInputFee, timeoutMs: 45_000);
        }
        catch
        {
            var balance = await bitCasterPage.EvaluateAsync<int>(BitCasterReadBalanceJs);
            throw await TestHelpers.BuildDiagnosticExceptionAsync(bitCasterPage, bitCasterConsole,
                $"After bitCaster reload, NIP-17 payment not redeemed. Balance: {balance} " +
                $"(expected >= {minimumReceivedAfterInputFee}). Continuous listener may not be rehydrating on boot.");
        }
    }

    public async Task DisposeAsync()
    {
        if (_browser is not null)
            await _browser.CloseAsync();

        _playwright?.Dispose();
    }

}
