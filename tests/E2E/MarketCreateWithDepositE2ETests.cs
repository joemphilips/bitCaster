using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Playwright;

namespace BitCaster.E2ETest;

/// <summary>
/// End-to-end coverage of the deposit step that lands on the wizard after
/// "Create Market" succeeds. Drives the full pipeline —
/// kormir-wasm DLC announcement → mint condition + partition → engine market
/// → DepositStep — and exercises both Lightning and ecash funding paths
/// against the in-memory mock's auto-credit timer.
///
/// The matching engine here is the in-memory stub at
/// <c>BitCaster.InMemoryMatchingEngine</c>; the deposit lifecycle (Requested
/// → Paid → Credited) is mock-driven by <c>DepositEndpoints</c> on a 2-second
/// cadence per step, so the polling UI converges in roughly 4–5 seconds.
/// </summary>
[Collection(E2ECollections.LiveServiceMutation)] // Registers markets through mint/engine and publishes to the local relay.
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

    public static IEnumerable<object[]> MarketUnitCases()
    {
        yield return ["sat", 100];
        yield return ["sat", 10000];
        yield return ["usd", 1000];
    }

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
        await TestHelpers.SetupComplete(page, TestPorts.Vite, TestPorts.MintUrl);
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

    private static async Task AssertWizardStartsAtGetStartedAsync(IPage page)
    {
        var heading = page.GetByRole(AriaRole.Heading, new() { Name = "Get Started" });
        await Assertions.Expect(heading).ToBeVisibleAsync(new() { Timeout = 10_000 });
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

    private static async Task SelectMarketUnitAsync(IPage page, string baseAsset, int divisibility)
    {
        var assetLabel = string.Equals(baseAsset, "usd", StringComparison.OrdinalIgnoreCase)
            ? "USD"
            : "sats";
        await page.GetByRole(AriaRole.Button, new() { Name = assetLabel }).ClickAsync();

        var denominator = page.Locator("select").First;
        await denominator.SelectOptionAsync(divisibility.ToString(CultureInfo.InvariantCulture));

        await Assertions.Expect(denominator)
            .ToHaveValueAsync(divisibility.ToString(CultureInfo.InvariantCulture));

        var selectedBaseAsset = await page.EvaluateAsync<string>("""
            JSON.parse(localStorage.getItem('bitcaster-market-draft') ?? '{}')
                ?.state?.draft?.stepOutcomes?.baseAsset ?? ''
        """);
        var selectedDivisibility = await page.EvaluateAsync<int>("""
            JSON.parse(localStorage.getItem('bitcaster-market-draft') ?? '{}')
                ?.state?.draft?.stepOutcomes?.divisibility ?? 0
        """);

        Assert.Equal(baseAsset, selectedBaseAsset);
        Assert.Equal(divisibility, selectedDivisibility);
    }

    private static async Task AdvanceStep4ToStep5_AcceptDefaultOutcomesAsync(
        IPage page,
        string baseAsset = "sat",
        int divisibility = 100)
    {
        await SelectMarketUnitAsync(page, baseAsset, divisibility);
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
    /// Review → DepositStep: fill description, click Create Market, wait for
    /// the kormir + mint + engine chain to land, return the new conditionId.
    /// The chain runs asynchronously — kormir publish, two mint POSTs, one
    /// engine POST — so the timeout is generous. On failure, the page state
    /// (URL, body text, console messages, error banner) is dumped so CI logs
    /// surface the root cause without a second debug round-trip.
    /// </summary>
    private static async Task<string> CreateMarketAndReadConditionIdAsync(
        IPage page,
        string title,
        string description,
        IReadOnlyList<string> console)
    {
        await page.GetByPlaceholder("Describe your market in detail")
            .FillAsync(description);

        var createBtn = page.GetByRole(AriaRole.Button, new() { Name = "Create Market" });
        await Assertions.Expect(createBtn).ToBeEnabledAsync(new() { Timeout = 5_000 });
        await createBtn.ClickAsync();

        var createdHeading = page.GetByRole(AriaRole.Heading, new() { Name = "Market created!" });
        try
        {
            await Assertions.Expect(createdHeading)
                .ToBeVisibleAsync(new() { Timeout = 60_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page, console,
                "DepositStep never rendered after clicking Create Market — the kormir publish + mint registerCondition + engine createMarket chain failed somewhere.");
        }

        var conditionId = await QueryConditionIdByTitleAsync(title);
        Assert.False(string.IsNullOrWhiteSpace(conditionId),
            "Created market did not appear in the catalogue query with a condition id");

        await page.GetByRole(AriaRole.Button, new() { Name = "Attract Traders" }).ClickAsync();
        await Assertions.Expect(page.GetByRole(AriaRole.Heading, new() { Name = "Fund the market maker" }))
            .ToBeVisibleAsync(new() { Timeout = 5_000 });
        return conditionId;
    }

    private static async Task<string> QueryConditionIdByTitleAsync(string title)
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        var deadline = DateTimeOffset.UtcNow.AddSeconds(15);
        while (DateTimeOffset.UtcNow < deadline)
        {
            var url =
                $"{TestPorts.ServerUrl}/api/v1/markets/query?state=All&search={Uri.EscapeDataString(title)}";
            using var response = await httpClient.GetAsync(url);
            if (response.IsSuccessStatusCode)
            {
                var body = await response.Content.ReadAsStringAsync();
                using var doc = System.Text.Json.JsonDocument.Parse(body);
                foreach (var market in doc.RootElement.GetProperty("markets").EnumerateArray())
                {
                    if (
                        market.TryGetProperty("title", out var titleProp) &&
                        string.Equals(titleProp.GetString(), title, StringComparison.Ordinal) &&
                        market.TryGetProperty("conditionId", out var conditionIdProp))
                    {
                        return conditionIdProp.GetString() ?? string.Empty;
                    }
                }
            }
            await Task.Delay(250);
        }
        return string.Empty;
    }

    private static async Task<(IPage Page, string ConditionId)> NavigateThroughWizardToDepositStepAsync(
        IBrowserContext context,
        string title,
        string description,
        string baseAsset = "sat",
        int divisibility = 100)
    {
        var (page, console) = await OpenWizardAsync(context);
        await AssertWizardStartsAtGetStartedAsync(page);
        await AdvanceStep2ToStep3_YesNoAsync(page);
        await AdvanceStep3ToStep4_FillBasicsAsync(page, title);
        await AdvanceStep4ToStep5_AcceptDefaultOutcomesAsync(page, baseAsset, divisibility);
        var conditionId = await CreateMarketAndReadConditionIdAsync(page, title, description, console);
        return (page, conditionId);
    }

    private static string UniqueTitle(string prefix) =>
        $"{prefix} {Guid.NewGuid().ToString()[..8]}";

    // -----------------------------------------------------------------------
    // Tests
    // -----------------------------------------------------------------------

    [Theory]
    [MemberData(nameof(MarketUnitCases))]
    public async Task CreatorCreatesMarket_NoAmmFunding_ContinuesWithoutPaymentControls(
        string baseAsset,
        int divisibility)
    {
        await using var context = await NewIsolatedContextAsync();
        var title = UniqueTitle($"E2E AMM TBD {baseAsset}");
        var (page, conditionId) = await NavigateThroughWizardToDepositStepAsync(
            context,
            title,
            "E2E AMM disabled continue path",
            baseAsset,
            divisibility);

        await Assertions.Expect(page.GetByTestId("amm-funding-tier-minimal"))
            .ToBeVisibleAsync();
        await Assertions.Expect(page.GetByTestId("amm-funding-tier-standard"))
            .ToBeVisibleAsync();
        await Assertions.Expect(page.GetByTestId("amm-funding-tier-deep"))
            .ToBeVisibleAsync();
        await Assertions.Expect(page.GetByTestId("tab-ln")).Not.ToBeVisibleAsync();
        await Assertions.Expect(page.GetByTestId("tab-ecash")).Not.ToBeVisibleAsync();
        await Assertions.Expect(page.GetByTestId("request-ln-invoice")).Not.ToBeVisibleAsync();
        await Assertions.Expect(page.GetByTestId("amount-input")).Not.ToBeVisibleAsync();
        await Assertions.Expect(page.GetByTestId("amm-funding-custom-budget")).ToBeVisibleAsync();

        await page.GetByTestId("amm-funding-tier-none").ClickAsync();
        var continueButton = page.GetByRole(AriaRole.Button, new() { Name = "Continue to your market" });
        await Assertions.Expect(continueButton).ToBeEnabledAsync();
        await continueButton.ClickAsync();
        await Assertions.Expect(page).ToHaveURLAsync(
            new Regex($"/markets/{Regex.Escape(conditionId)}$"));
    }

    [Fact]
    public async Task DepositStep_AmmFunding_ShowsPaidStateAndAutoNavigates()
    {
        await using var context = await NewIsolatedContextAsync();
        var title = UniqueTitle("E2E AMM Invoice");
        var (page, conditionId) = await NavigateThroughWizardToDepositStepAsync(
            context, title, "E2E AMM invoice modal path");

        await page.RouteAsync("**/api/v1/markets/*/deposit/*", async route =>
        {
            if (!string.Equals(route.Request.Method, "GET", StringComparison.OrdinalIgnoreCase))
            {
                await route.ContinueAsync();
                return;
            }

            var match = Regex.Match(
                route.Request.Url,
                @"/api/v1/markets/([^/]+)/deposit/([0-9a-fA-F-]+)");
            Assert.True(match.Success, $"Unexpected deposit status URL: {route.Request.Url}");
            var depositId = match.Groups[2].Value;
            var now = DateTimeOffset.UtcNow;
            await route.FulfillAsync(new RouteFulfillOptions
            {
                Status = 200,
                ContentType = "application/json",
                Body = JsonSerializer.Serialize(new
                {
                    amountSats = 1_000,
                    conditionId,
                    depositId,
                    expiresAt = now.AddMinutes(5),
                    failureReason = (string?)null,
                    method = "lightningInvoice",
                    requestedAt = now.AddSeconds(-3),
                    state = "paid",
                    updatedAt = now,
                }),
            });
        });

        await page.GetByTestId("amm-funding-tier-minimal").ClickAsync();
        await page.GetByTestId("confirm-amm-funding").ClickAsync();

        await Assertions.Expect(page.GetByRole(AriaRole.Heading, new() { Name = "Lightning Invoice" }))
            .ToBeVisibleAsync(new() { Timeout = 15_000 });
        var bolt11Display = page.GetByTestId("bolt11-display");
        await Assertions.Expect(bolt11Display)
            .ToBeVisibleAsync(new() { Timeout = 15_000 });
        await Assertions.Expect(bolt11Display)
            .ToContainTextAsync(new Regex("^lnbcrt\\d+n1", RegexOptions.IgnoreCase));
        await Assertions.Expect(page.GetByText("Payment received!"))
            .ToBeVisibleAsync(new() { Timeout = 10_000 });
        await Assertions.Expect(page).ToHaveURLAsync(
            new Regex($"/markets/{Regex.Escape(conditionId)}$"),
            new() { Timeout = 10_000 });
    }

    [Fact]
    public async Task DepositStep_CloseMidDeposit_MarketAppearsInMarketsList()
    {
        await using var context = await NewIsolatedContextAsync();
        var title = UniqueTitle("E2E Deposit Close");
        var (page, _) = await NavigateThroughWizardToDepositStepAsync(
            context, title, "E2E close-mid-deposit test");

        // Close the wizard before continuing to the market detail page.
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

}
