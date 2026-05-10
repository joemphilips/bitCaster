using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.Playwright;

namespace BitCaster.E2ETest;

/// <summary>
/// End-to-end coverage of the deposit step that lands on the wizard after
/// "Create Market" succeeds (CPMM Phase 5). Drives the full pipeline —
/// kormir-wasm DLC announcement → mint condition + partition → engine market
/// → DepositStep — and exercises both Lightning and ecash funding paths
/// against the in-memory mock's auto-credit timer.
///
/// The matching engine here is the in-memory stub at
/// <c>BitCaster.InMemoryMatchingEngine</c>; the deposit lifecycle (Requested
/// → Paid → Credited) is mock-driven by <c>DepositEndpoints</c> on a 2-second
/// cadence per step, so the polling UI converges in roughly 4–5 seconds.
/// </summary>
public class MarketCreateWithDepositE2ETests : IAsyncLifetime
{
    private IPlaywright? _playwright;
    private IBrowser? _browser;

    /// <summary>
    /// Deterministic throwaway nsec — the wizard's "become oracle" path needs
    /// a real secp256k1 secret so kormir-wasm can produce the DLC Schnorr
    /// signatures locally. Public-relay collisions are not a concern; the
    /// announcements only flow through the local docker-compose
    /// <c>nostr-relay</c>.
    /// </summary>
    private const string TestNsec =
        "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";

    /// <summary>
    /// Local docker-compose nostr-rs-relay (port 7777). Configured into
    /// <c>bitcaster-settings.relays</c> so kormir's publish step has a
    /// reachable destination.
    /// </summary>
    private const string LocalRelayUrl = "ws://localhost:7777";

    public async Task InitializeAsync()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        await Task.WhenAll(
            TestHelpers.WaitForService(httpClient, $"{TestPorts.MintUrl}/v1/info", "Mint"),
            TestHelpers.WaitForService(httpClient, $"{TestPorts.ServerUrl}/health", "Matching Engine"),
            TestHelpers.WaitForService(httpClient, $"{TestPorts.FrontendUrl}", "Frontend"));

        _playwright = await Playwright.CreateAsync();
        _browser = await _playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
        {
            Headless = true,
        });
    }

    public async Task DisposeAsync()
    {
        if (_browser is not null)
            await _browser.CloseAsync();
        _playwright?.Dispose();
    }

    private async Task<IBrowserContext> NewIsolatedContextAsync()
    {
        Assert.NotNull(_browser);
        return await _browser.NewContextAsync(new BrowserNewContextOptions
        {
            ServiceWorkers = ServiceWorkerPolicy.Block,
        });
    }

    // -----------------------------------------------------------------------
    // Settings / wallet seed
    // -----------------------------------------------------------------------

    /// <summary>
    /// Seed wallet + bitcaster-settings so the wizard can run end-to-end:
    /// the user has a wallet, an nsec-mode signer, and a configured relay
    /// where kormir-wasm can publish the announcement.
    /// </summary>
    private static async Task SeedWizardEnvironmentAsync(IPage page)
    {
        await TestHelpers.SetupComplete(page, TestPorts.Vite);
        await page.EvaluateAsync($@"
            localStorage.setItem('bitcaster-settings', JSON.stringify({{
                state: {{
                    baseCurrency: 'BTC',
                    language: 'en',
                    theme: 'dark',
                    nostrSignerMode: 'nsec',
                    nsecSecret: '{TestNsec}',
                    nostrProfile: null,
                    nostrProfileFetchStatus: 'idle',
                    relays: [{{ url: '{LocalRelayUrl}' }}]
                }},
                version: 0
            }}));
        ");
    }

    // -----------------------------------------------------------------------
    // Wizard navigation — broken into focused per-step helpers
    // -----------------------------------------------------------------------

    private static async Task<(IPage Page, List<string> Console)> OpenWizardAsync(IBrowserContext context)
    {
        var page = await context.NewPageAsync();
        var console = TestHelpers.AttachConsoleCapture(page);
        await SeedWizardEnvironmentAsync(page);
        await page.GotoAsync($"{TestPorts.FrontendUrl}/creator/new", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });
        return (page, console);
    }

    private static async Task AdvanceStep1ToStep2_BecomeOracleAsync(IPage page)
    {
        var becomeOracle = page.GetByText("No / I want to be an oracle");
        await Assertions.Expect(becomeOracle).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await becomeOracle.ClickAsync();

        var continueBtn = page.GetByRole(AriaRole.Button, new() { Name = "Continue as Oracle" });
        await Assertions.Expect(continueBtn).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await continueBtn.ClickAsync();

        var heading = page.GetByRole(AriaRole.Heading, new() { Name = "Get Started" });
        await Assertions.Expect(heading).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    private static async Task AdvanceStep2ToStep3_YesNoAsync(IPage page)
    {
        var yesNoOption = page.GetByText("Yes / No").First;
        await yesNoOption.ClickAsync();
        await page.GetByRole(AriaRole.Button, new() { Name = "Next" }).ClickAsync();
        var heading = page.GetByRole(AriaRole.Heading, new() { Name = "Basic Information" });
        await Assertions.Expect(heading).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    private static async Task AdvanceStep3ToStep4_FillBasicsAsync(IPage page, string title)
    {
        await page.GetByPlaceholder("Type title...").FillAsync(title);
        var futureTarget = DateTime.Now.AddMonths(1).Date.AddHours(12);
        await PickClosingDateAsync(page, futureTarget);
        await page.GetByRole(AriaRole.Button, new() { Name = "Next" }).ClickAsync();
        var heading = page.GetByRole(AriaRole.Heading, new() { Name = "Market Outcomes" });
        await Assertions.Expect(heading).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    private static async Task AdvanceStep4ToStep5_AcceptDefaultOutcomesAsync(IPage page)
    {
        await page.GetByRole(AriaRole.Button, new() { Name = "Next" }).ClickAsync();
        var heading = page.GetByRole(AriaRole.Heading, new() { Name = "Initial Liquidity" });
        await Assertions.Expect(heading).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    private static async Task AdvanceStep5ToStep6_PickQuickLiquidityAsync(IPage page)
    {
        await page.GetByRole(AriaRole.Button, new() { Name = "1,000" }).ClickAsync();
        await page.GetByRole(AriaRole.Button, new() { Name = "Next" }).ClickAsync();
        var heading = page.GetByRole(AriaRole.Heading, new() { Name = "Review & Create" });
        await Assertions.Expect(heading).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    /// <summary>
    /// Open the End Time picker, advance to <paramref name="target"/>, fill
    /// the time, and Apply. Simplified mirror of the helper in
    /// <c>MarketCreationTests</c>.
    /// </summary>
    private static async Task PickClosingDateAsync(IPage page, DateTime target)
    {
        await page.GetByRole(AriaRole.Button, new() { Name = "End Time" }).ClickAsync();

        var monthsForward = (target.Year - DateTime.Now.Year) * 12
            + (target.Month - DateTime.Now.Month);
        if (monthsForward > 0)
        {
            var nextMonthBtn = page.GetByRole(AriaRole.Button, new()
            {
                NameRegex = new Regex("next month", RegexOptions.IgnoreCase),
            });
            for (var i = 0; i < monthsForward; i++) await nextMonthBtn.ClickAsync();
        }

        var monthName = target.ToString("MMMM", CultureInfo.InvariantCulture);
        var dayRegex = new Regex(
            $@"{monthName}\s+{target.Day}(?:st|nd|rd|th)?,?\s+{target.Year}",
            RegexOptions.IgnoreCase);
        await page.GetByRole(AriaRole.Button, new() { NameRegex = dayRegex }).ClickAsync();

        await page.GetByLabel("Time", new() { Exact = true })
            .FillAsync($"{target.Hour:D2}:{target.Minute:D2}");
        await page.GetByRole(AriaRole.Button, new() { Name = "Apply" }).ClickAsync();
    }

    /// <summary>
    /// Step 6 → DepositStep: fill description, click Create Market, wait for
    /// the kormir + mint + engine chain to land, return the new conditionId.
    /// The chain runs asynchronously — kormir publish, two mint POSTs, one
    /// engine POST — so the timeout is generous. On failure, the page state
    /// (URL, body text, console messages, error banner) is dumped so CI logs
    /// surface the root cause without a second debug round-trip.
    /// </summary>
    private static async Task<string> CreateMarketAndReadConditionIdAsync(
        IPage page,
        string description,
        IReadOnlyList<string> console)
    {
        await page.GetByPlaceholder("Describe your market in detail")
            .FillAsync(description);

        var createBtn = page.GetByRole(AriaRole.Button, new() { Name = "Create Market" });
        await Assertions.Expect(createBtn).ToBeEnabledAsync(new() { Timeout = 5_000 });
        await createBtn.ClickAsync();

        var conditionIdEl = page.GetByTestId("condition-id");
        try
        {
            await Assertions.Expect(conditionIdEl)
                .ToBeVisibleAsync(new() { Timeout = 60_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page, console,
                "DepositStep never rendered after clicking Create Market — the kormir publish + mint registerCondition/registerPartition + engine createMarket chain failed somewhere.");
        }

        var text = await conditionIdEl.InnerTextAsync();
        // The component renders "Market created\n<conditionId>". The id is the
        // last non-empty line.
        var conditionId = text.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(s => s.Trim())
            .Last(s => s.Length > 0 && s != "Market created");
        Assert.False(string.IsNullOrWhiteSpace(conditionId),
            "DepositStep rendered with an empty condition id");
        return conditionId;
    }

    private static async Task<(IPage Page, string ConditionId)> NavigateThroughWizardToDepositStepAsync(
        IBrowserContext context,
        string title,
        string description)
    {
        var (page, console) = await OpenWizardAsync(context);
        await AdvanceStep1ToStep2_BecomeOracleAsync(page);
        await AdvanceStep2ToStep3_YesNoAsync(page);
        await AdvanceStep3ToStep4_FillBasicsAsync(page, title);
        await AdvanceStep4ToStep5_AcceptDefaultOutcomesAsync(page);
        await AdvanceStep5ToStep6_PickQuickLiquidityAsync(page);
        var conditionId = await CreateMarketAndReadConditionIdAsync(page, description, console);
        return (page, conditionId);
    }

    private static string UniqueTitle(string prefix) =>
        $"{prefix} {Guid.NewGuid().ToString()[..8]}";

    // -----------------------------------------------------------------------
    // Tests
    // -----------------------------------------------------------------------

    [Fact]
    public async Task DepositStep_LightningHappyPath_CreditsAndContinuesToMarket()
    {
        await using var context = await NewIsolatedContextAsync();
        var title = UniqueTitle("E2E Deposit LN");
        var (page, conditionId) = await NavigateThroughWizardToDepositStepAsync(
            context, title, "E2E happy-path Lightning deposit");

        // Lightning tab is the default; click Request Lightning invoice.
        await page.GetByTestId("tab-ln").ClickAsync();
        await page.GetByTestId("request-ln-invoice").ClickAsync();

        var bolt11 = page.GetByTestId("bolt11-display");
        await Assertions.Expect(bolt11).ToBeVisibleAsync(new() { Timeout = 10_000 });
        var bolt11Text = await bolt11.InnerTextAsync();
        Assert.False(string.IsNullOrWhiteSpace(bolt11Text),
            "bolt11-display rendered without an invoice string");

        // The mock walks Requested → Paid → Credited on a ~2s cadence per
        // step; give it generous headroom for the polling UI to converge.
        await Assertions.Expect(page.GetByTestId("deposit-credited"))
            .ToBeVisibleAsync(new() { Timeout = 15_000 });

        await page.GetByTestId("continue-to-market").ClickAsync();
        await Assertions.Expect(page).ToHaveURLAsync(
            new Regex($"/markets/{Regex.Escape(conditionId)}$"));
    }

    [Fact]
    public async Task DepositStep_EcashFlow_CreditsAndContinuesToMarket()
    {
        await using var context = await NewIsolatedContextAsync();
        var title = UniqueTitle("E2E Deposit EC");
        var (page, conditionId) = await NavigateThroughWizardToDepositStepAsync(
            context, title, "E2E happy-path ecash deposit");

        await page.GetByTestId("tab-ecash").ClickAsync();
        // Plausible-shape token; the mock skips proof verification.
        await page.GetByTestId("ecash-token-input")
            .FillAsync("cashuBoMockedTokenForE2eDepositTest");
        await page.GetByTestId("submit-ecash").ClickAsync();

        // Ecash starts at Paid in the mock (Requested is skipped) and reaches
        // Credited ~2s later — same headroom as the Lightning path.
        await Assertions.Expect(page.GetByTestId("deposit-credited"))
            .ToBeVisibleAsync(new() { Timeout = 15_000 });

        await page.GetByTestId("continue-to-market").ClickAsync();
        await Assertions.Expect(page).ToHaveURLAsync(
            new Regex($"/markets/{Regex.Escape(conditionId)}$"));
    }

    [Fact]
    public async Task DepositStep_AmountValidation_ClampsZeroToMinimumAndKeepsButtonEnabled()
    {
        // The implementation prevents 0-sat deposit requests via input
        // clamping (Math.max(1, parseInt(...))). The user-protective
        // invariant — you cannot dispatch a request for 0 sats — holds via a
        // different mechanism than disabling the button. We assert both
        // sides of that invariant.
        await using var context = await NewIsolatedContextAsync();
        var title = UniqueTitle("E2E Deposit Amt");
        var (page, _) = await NavigateThroughWizardToDepositStepAsync(
            context, title, "E2E amount-validation test");

        var amountInput = page.GetByTestId("amount-input");
        await amountInput.ClearAsync();
        await amountInput.FillAsync("0");

        // Clamp: state can never go below 1 — the value attribute reflects
        // React state.
        await Assertions.Expect(amountInput).ToHaveValueAsync("1");

        // Because the clamp keeps amount at 1, the request button stays
        // enabled. If the implementation ever drops the clamp in favour of a
        // disabled-button check, this assertion is the canary.
        await Assertions.Expect(page.GetByTestId("request-ln-invoice"))
            .ToBeEnabledAsync();
    }

    [Fact]
    public async Task DepositStep_CloseMidDeposit_MarketAppearsInMarketsList()
    {
        await using var context = await NewIsolatedContextAsync();
        var title = UniqueTitle("E2E Deposit Close");
        var (page, _) = await NavigateThroughWizardToDepositStepAsync(
            context, title, "E2E close-mid-deposit test");

        await page.GetByTestId("request-ln-invoice").ClickAsync();
        await Assertions.Expect(page.GetByTestId("bolt11-display"))
            .ToBeVisibleAsync(new() { Timeout = 10_000 });

        // Close the wizard before the auto-credit timer reaches Credited.
        await page.GetByRole(AriaRole.Button, new() { Name = "Close market creation" })
            .ClickAsync();
        await Assertions.Expect(page).Not.ToHaveURLAsync(new Regex("/creator/new"));

        // The market is registered on the mint (registerCondition) and on
        // the engine (createMarket), even though the deposit never landed.
        // /markets reads conditions from the mint and surfaces each one
        // tagged with its description; our unique title must be visible.
        await TestHelpers.GotoMarketsAsync(page,
            new PageGotoOptions { WaitUntil = WaitUntilState.NetworkIdle, Timeout = 30_000 });
        await Assertions.Expect(page.GetByText(title))
            .ToBeVisibleAsync(new() { Timeout = 15_000 });
    }

    [Fact(Skip = "Pending funded bot inventory/full-stack settlement harness")]
    public async Task BotAsCounterparty_FullTradeSettlement()
    {
        // Placeholder: a full bot-as-counterparty trade-settlement E2E
        // now has StrategyLoop/TradeDriver wiring, but still needs a harness
        // that provisions funded bot inventory and drives the real bot as the
        // counterparty. When that harness lands, drop the [Skip] string and
        // assert the browser-visible trade reaches the settlement-complete
        // state against the real bot.
        await Task.CompletedTask;
    }
}
