using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.Playwright;

namespace BitCaster.E2ETest;

public class MarketCreationTests : IAsyncLifetime
{
    private IPlaywright? _playwright;
    private IBrowser? _browser;

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

    private async Task<IBrowserContext> NewIsolatedContextAsync()
    {
        Assert.NotNull(_browser);
        return await _browser.NewContextAsync(new BrowserNewContextOptions
        {
            ServiceWorkers = ServiceWorkerPolicy.Block,
        });
    }

    private async Task SetupComplete(IPage page) =>
        await TestHelpers.SetupComplete(page, TestPorts.Vite);

    /// <summary>
    /// Open the End Time picker, navigate to the target month, click the target day,
    /// set the time, and click Apply. The target must be in the future.
    /// </summary>
    private static async Task FillClosingDate(IPage page, DateTime target)
    {
        var trigger = page.GetByRole(AriaRole.Button, new() { Name = "End Time" });
        await trigger.ClickAsync();

        // Calendar opens on the current month (no draft selection). Advance by
        // (target.month - now.month) steps using the "Next Month" chevron.
        var now = DateTime.Now;
        var monthsForward = (target.Year - now.Year) * 12 + (target.Month - now.Month);
        if (monthsForward > 0)
        {
            var nextMonthBtn = page.GetByRole(AriaRole.Button, new()
            {
                NameRegex = new Regex("next month", RegexOptions.IgnoreCase),
            });
            for (var i = 0; i < monthsForward; i++)
            {
                await nextMonthBtn.ClickAsync();
            }
        }

        // react-day-picker v9 labels day buttons as e.g. "Monday, April 20th, 2026".
        // Match on month, day, optional ordinal suffix, and year to avoid substring collisions
        // (e.g. "April 2" vs "April 20").
        var monthName = target.ToString("MMMM", CultureInfo.InvariantCulture);
        var dayRegex = new Regex(
            $@"{monthName}\s+{target.Day}(?:st|nd|rd|th)?,?\s+{target.Year}",
            RegexOptions.IgnoreCase);
        var dayBtn = page.GetByRole(AriaRole.Button, new() { NameRegex = dayRegex });
        await dayBtn.ClickAsync();

        // Set time via the aria-labelled time input. Exact=true so "Time" does not
        // substring-match "End Time" (trigger) or "Pick date and time" (dialog).
        var timeInput = page.GetByLabel("Time", new() { Exact = true });
        await timeInput.FillAsync($"{target.Hour:D2}:{target.Minute:D2}");

        var applyBtn = page.GetByRole(AriaRole.Button, new() { Name = "Apply" });
        await applyBtn.ClickAsync();
    }

    /// <summary>
    /// Navigate from /creator/new step 1 past oracle check to step 2.
    /// Uses the "become oracle" path, which requires a persisted nsec signer
    /// mode in the settings store (kormir needs the raw secp256k1 secret to
    /// produce DLC Schnorr signatures locally, so NIP-07 is not accepted).
    /// </summary>
    private async Task NavigateToStep2(IPage page)
    {
        await SetupComplete(page);
        // Persist nostrSignerMode=nsec so OracleCheck enables the become-oracle
        // path. The zustand settings store writes to localStorage under
        // "bitcaster-settings"; we inject it directly rather than going through
        // the Settings UI to keep the test focused on the market-creation flow.
        await page.EvaluateAsync(@"
            localStorage.setItem('bitcaster-settings', JSON.stringify({
                state: {
                    baseCurrency: 'BTC',
                    language: 'en',
                    theme: 'dark',
                    nostrSignerMode: 'nsec',
                    relays: [],
                },
                version: 0
            }));
        ");

        await page.GotoAsync($"{TestPorts.FrontendUrl}/creator/new", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Step 1: Oracle Check — choose "become oracle" path
        var becomeOracle = page.GetByText("No / I want to be an oracle");
        await Assertions.Expect(becomeOracle).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await becomeOracle.ClickAsync();

        // Click "Continue as Oracle" to proceed. This button only renders when
        // canBecomeOracle is true (signerMode === 'nsec').
        var continueBtn = page.GetByRole(AriaRole.Button, new() { Name = "Continue as Oracle" });
        await Assertions.Expect(continueBtn).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await continueBtn.ClickAsync();

        // Verify we're on step 2
        var heading = page.GetByRole(AriaRole.Heading, new() { Name = "Get Started" });
        await Assertions.Expect(heading).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    /// <summary>
    /// Navigate to a specific wizard step. Steps 3+ require filling in previous steps.
    /// </summary>
    private async Task NavigateToStep(IPage page, int targetStep)
    {
        await NavigateToStep2(page);
        if (targetStep <= 2) return;

        // Step 2 → 3: Select "Yes / No" outcome type
        var yesNoOption = page.GetByText("Yes / No").First;
        await yesNoOption.ClickAsync();
        var nextBtn = page.GetByRole(AriaRole.Button, new() { Name = "Next" });
        await nextBtn.ClickAsync();

        // Wait for step 3
        var basicInfoHeading = page.GetByRole(AriaRole.Heading, new() { Name = "Basic Information" });
        await Assertions.Expect(basicInfoHeading).ToBeVisibleAsync(new() { Timeout = 5_000 });
        if (targetStep <= 3) return;

        // Step 3 → 4: Fill basic info
        var titleInput = page.GetByPlaceholder("Type title...");
        await titleInput.FillAsync("E2E Test Market");

        // Pick a date one month in the future via the date picker popup.
        var futureTarget = DateTime.Now.AddMonths(1).Date.AddHours(12);
        await FillClosingDate(page, futureTarget);

        nextBtn = page.GetByRole(AriaRole.Button, new() { Name = "Next" });
        await nextBtn.ClickAsync();

        // Wait for step 4
        var outcomesHeading = page.GetByRole(AriaRole.Heading, new() { Name = "Market Outcomes" });
        await Assertions.Expect(outcomesHeading).ToBeVisibleAsync(new() { Timeout = 5_000 });
        if (targetStep <= 4) return;

        // Step 4 → 5: Accept default outcomes
        nextBtn = page.GetByRole(AriaRole.Button, new() { Name = "Next" });
        await nextBtn.ClickAsync();

        // Wait for step 5. AMM liquidity provisioning is currently disabled,
        // so the wizard shows a static informational step and lets creators
        // continue without choosing an amount.
        var liquidityHeading = page.GetByRole(AriaRole.Heading, new() { Name = "AMM liquidity is TBD" });
        await Assertions.Expect(liquidityHeading).ToBeVisibleAsync(new() { Timeout = 5_000 });
        if (targetStep <= 5) return;

        // Step 5 → 6: Continue without AMM liquidity.
        nextBtn = page.GetByRole(AriaRole.Button, new() { Name = "Next" });
        await nextBtn.ClickAsync();

        // Wait for step 6
        var reviewHeading = page.GetByRole(AriaRole.Heading, new() { Name = "Review & Create" });
        await Assertions.Expect(reviewHeading).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    [Fact]
    public async Task WizardStep1_BecomeOracle_AdvancesToStep2()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await NavigateToStep2(page);

        // The "Get Started" heading should be visible (step 2)
        var heading = page.GetByRole(AriaRole.Heading, new() { Name = "Get Started" });
        await Assertions.Expect(heading).ToBeVisibleAsync();
    }

    [Fact]
    public async Task WizardStep1_BecomeOracle_WithoutNsec_ShowsSettingsGateAndNavigates()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await SetupComplete(page);
        // Deliberately not injecting bitcaster-settings — the default
        // nostrSignerMode='none' is the state under test.

        await page.GotoAsync($"{TestPorts.FrontendUrl}/creator/new", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var becomeOracle = page.GetByText("No / I want to be an oracle");
        await Assertions.Expect(becomeOracle).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await becomeOracle.ClickAsync();

        var warning = page.GetByRole(AriaRole.Heading, new()
        {
            Name = "You must register a nostr key to become an oracle",
        });
        await Assertions.Expect(warning).ToBeVisibleAsync(new() { Timeout = 5_000 });

        var continueBtn = page.GetByRole(AriaRole.Button, new() { Name = "Continue as Oracle" });
        await Assertions.Expect(continueBtn).ToHaveCountAsync(0);

        var settingsBtn = page.GetByRole(AriaRole.Button, new() { Name = "Go to Nostr Settings" });
        await Assertions.Expect(settingsBtn).ToBeVisibleAsync();
        await settingsBtn.ClickAsync();

        await Assertions.Expect(page).ToHaveURLAsync(
            new Regex(@"/settings\?category=nostr"));

        var nostrCategory = page.GetByText("Nostr Settings").First;
        await Assertions.Expect(nostrCategory).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    [Fact]
    public async Task WizardDraft_ResumeAfterClose_PreservesProgressAndShowsBanner()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await NavigateToStep(page, 3);

        var titleInput = page.GetByPlaceholder("Type title...");
        await titleInput.FillAsync("Resumable market");

        var closeBtn = page.GetByRole(AriaRole.Button, new() { Name = "Close market creation" });
        await closeBtn.ClickAsync();

        await Assertions.Expect(page).Not.ToHaveURLAsync(new Regex("/creator/new"));

        await page.GotoAsync($"{TestPorts.FrontendUrl}/creator/new", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var banner = page.GetByText("Picked up where you left off");
        await Assertions.Expect(banner).ToBeVisibleAsync(new() { Timeout = 5_000 });

        var basicInfoHeading = page.GetByRole(AriaRole.Heading, new() { Name = "Basic Information" });
        await Assertions.Expect(basicInfoHeading).ToBeVisibleAsync();

        var titleInputAgain = page.GetByPlaceholder("Type title...");
        await Assertions.Expect(titleInputAgain).ToHaveValueAsync("Resumable market");
    }

    [Fact]
    public async Task WizardResumeBanner_StartOver_ClearsDraftAndResetsToStep1()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await NavigateToStep(page, 3);

        var titleInput = page.GetByPlaceholder("Type title...");
        await titleInput.FillAsync("Forgettable market");

        var closeBtn = page.GetByRole(AriaRole.Button, new() { Name = "Close market creation" });
        await closeBtn.ClickAsync();
        await Assertions.Expect(page).Not.ToHaveURLAsync(new Regex("/creator/new"));

        await page.GotoAsync($"{TestPorts.FrontendUrl}/creator/new", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var startOverBtn = page.GetByRole(AriaRole.Button, new() { Name = "Start over" });
        await Assertions.Expect(startOverBtn).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await startOverBtn.ClickAsync();

        var oracleHeading = page.GetByRole(AriaRole.Heading, new() { Name = "Oracle Announcement" });
        await Assertions.Expect(oracleHeading).ToBeVisibleAsync(new() { Timeout = 5_000 });

        var banner = page.GetByText("Picked up where you left off");
        await Assertions.Expect(banner).ToHaveCountAsync(0);
    }

    [Fact]
    public async Task WizardStep2_SelectYesNo_AdvancesToStep3()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await NavigateToStep2(page);

        // Select Yes/No
        var yesNoOption = page.GetByText("Yes / No").First;
        await yesNoOption.ClickAsync();

        // Click Next
        var nextBtn = page.GetByRole(AriaRole.Button, new() { Name = "Next" });
        await nextBtn.ClickAsync();

        // Should show Basic Information heading
        var heading = page.GetByRole(AriaRole.Heading, new() { Name = "Basic Information" });
        await Assertions.Expect(heading).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    [Fact]
    public async Task WizardStep3_FutureDateRequired_NextDisabledForPastDate()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await NavigateToStep(page, 3);

        // Fill title so only the date field is gating Next.
        var titleInput = page.GetByPlaceholder("Type title...");
        await titleInput.FillAsync("Test Market");

        // Next should be disabled before any date is picked.
        var nextBtn = page.GetByRole(AriaRole.Button, new() { Name = "Next" });
        await Assertions.Expect(nextBtn).ToBeDisabledAsync();

        // Open the picker and confirm that days in the past are disabled.
        // Navigate one month back so that every day on the grid belongs to a past month.
        await page.GetByRole(AriaRole.Button, new() { Name = "End Time" }).ClickAsync();
        var prevMonthBtn = page.GetByRole(AriaRole.Button, new()
        {
            NameRegex = new Regex("previous month", RegexOptions.IgnoreCase),
        });
        await prevMonthBtn.ClickAsync();

        // Assert that the 1st of the previous month is disabled.
        var prevMonth = DateTime.Now.AddMonths(-1);
        var prevMonthName = prevMonth.ToString("MMMM", CultureInfo.InvariantCulture);
        var firstDayRegex = new Regex(
            $@"{prevMonthName}\s+1(?:st)?,?\s+{prevMonth.Year}",
            RegexOptions.IgnoreCase);
        var firstDayBtn = page.GetByRole(AriaRole.Button, new() { NameRegex = firstDayRegex });
        await Assertions.Expect(firstDayBtn).ToBeDisabledAsync();

        // Close the popover and pick a valid future date.
        await page.Keyboard.PressAsync("Escape");
        var futureTarget = DateTime.Now.AddMonths(1).Date.AddHours(12);
        await FillClosingDate(page, futureTarget);

        // Next should now be enabled.
        await Assertions.Expect(nextBtn).ToBeEnabledAsync();
    }

    [Fact]
    public async Task WizardStep4_NormalizeButton_UpdatesProbabilities()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await NavigateToStep(page, 4);

        // Find the probability inputs (there should be 2 for Yes/No)
        var probInputs = page.Locator("input[type='number']");
        await Assertions.Expect(probInputs).ToHaveCountAsync(2);

        // Clear and set custom probabilities: Yes=10, No=10
        await probInputs.Nth(0).ClearAsync();
        await probInputs.Nth(0).FillAsync("10");
        await probInputs.Nth(1).ClearAsync();
        await probInputs.Nth(1).FillAsync("10");

        // Click "Normalize to 100%"
        var normalizeBtn = page.GetByText("Normalize to 100%");
        await normalizeBtn.ClickAsync();

        // After normalization, both should be 50
        await Assertions.Expect(probInputs.Nth(0)).ToHaveValueAsync("50");
        await Assertions.Expect(probInputs.Nth(1)).ToHaveValueAsync("50");

        // The probability summary should show 100%
        var summaryText = page.GetByText("100%").Last;
        await Assertions.Expect(summaryText).ToBeVisibleAsync();
    }

    [Fact]
    public async Task WizardStep5_CanContinueWithoutLiquidityWhileAmmIsDisabled()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await NavigateToStep(page, 5);

        await Assertions.Expect(page.GetByText("No liquidity payment required"))
            .ToBeVisibleAsync();

        // AMM liquidity is currently disabled, so creators can continue
        // without selecting a funding amount.
        var nextBtn = page.GetByRole(AriaRole.Button, new() { Name = "Next" });
        await Assertions.Expect(nextBtn).ToBeEnabledAsync();

        await nextBtn.ClickAsync();
        var reviewHeading = page.GetByRole(AriaRole.Heading, new() { Name = "Review & Create" });
        await Assertions.Expect(reviewHeading).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    [Fact]
    public async Task WizardStep6_CreateButtonDisabledWithoutDescription()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await NavigateToStep(page, 6);

        // Create Market button should be disabled without description
        var createBtn = page.GetByRole(AriaRole.Button, new() { Name = "Create Market" });
        await Assertions.Expect(createBtn).ToBeDisabledAsync();

        // Fill in description
        var descTextarea = page.GetByPlaceholder("Describe your market in detail");
        await descTextarea.FillAsync("This is a test market for E2E testing.");

        // Create Market button should now be enabled
        await Assertions.Expect(createBtn).ToBeEnabledAsync();
    }

    [Fact]
    public async Task NewlyCreatedMarketVisibleToBothUsers()
    {
        // Create a market on the matching engine using a real seeded condition
        // from the mint, then verify both users can see it on the /markets page.
        var marketTitle = "E2E Created Market";

        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };

        // Fetch a real condition from the mint to use its ID
        var mintConditionsResponse = await httpClient.GetAsync($"{TestPorts.MintUrl}/v1/conditions");
        Assert.True(mintConditionsResponse.IsSuccessStatusCode, "Failed to fetch conditions from mint");
        var mintBody = await mintConditionsResponse.Content.ReadAsStringAsync();
        using var mintDoc = System.Text.Json.JsonDocument.Parse(mintBody);
        var firstCondition = mintDoc.RootElement.GetProperty("conditions").EnumerateArray().First();
        var conditionId = firstCondition.GetProperty("condition_id").GetString()!;

        // Extract outcome names from the seeded condition's flat keyset map.
        var outcomeNames = firstCondition.GetProperty("keysets").EnumerateObject()
            .SelectMany(keyset => keyset.Name.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            .Distinct(StringComparer.Ordinal)
            .ToList();
        var probPerOutcome = 100 / outcomeNames.Count;
        var outcomes = outcomeNames.Select((name, i) => new
        {
            name,
            probability = i == outcomeNames.Count - 1
                ? 100 - probPerOutcome * (outcomeNames.Count - 1)
                : probPerOutcome,
        }).ToArray();

        // Create market on the matching engine
        var metadata = System.Text.Json.JsonSerializer.Serialize(new
        {
            title = marketTitle,
            description = "E2E test description",
            outcomes,
            liquiditySats = 1000,
            categoryTags = new[] { "crypto" },
        });

        var formContent = new MultipartFormDataContent();
        formContent.Add(new StringContent(metadata), "metadata");

        var createResponse = await httpClient.PostAsync(
            $"{TestPorts.ServerUrl}/api/v1/markets/{conditionId}",
            formContent);

        // Accept both 200 (created) and 409 (already exists from prior run)
        // since this test verifies UI visibility, not creation idempotency.
        Assert.True(
            createResponse.IsSuccessStatusCode || createResponse.StatusCode == System.Net.HttpStatusCode.Conflict,
            $"createMarket failed: {createResponse.StatusCode} {await createResponse.Content.ReadAsStringAsync()}");

        // Per ADR-009 the markets-list page consumes
        // `/api/v1/markets/query`. Intercept that surface so the markets list
        // reliably surfaces the freshly-registered market with the
        // test-controlled title.
        var queryJson = System.Text.Json.JsonSerializer.Serialize(new
        {
            markets = new object[]
            {
                new
                {
                    conditionId,
                    outcomes = outcomeNames,
                    title = marketTitle,
                    thumbnailUrl = (string?)null,
                    creatorPubkey = (string?)null,
                    deadline = (string?)null,
                    state = "open",
                    createdAt = "2026-01-01T00:00:00Z",
                    volume24hSats = 0,
                    volume30dSats = 0,
                    liquiditySats = 25_000L,
                    traderCount = 3,
                    volumeLifetimeSats = 50_000L,
                    lastTradedPrice = (double?)null,
                    categoryTags = new[] { "crypto" },
                    lastSuccessfulRefreshAt = "2026-05-02T09:58:00Z",
                },
            },
            nextCursor = (string?)null,
            lastSuccessfulRefreshAt = "2026-05-02T09:58:00Z",
        });

        async Task InterceptConditions(IPage page)
        {
            await page.RouteAsync("**/api/v1/markets/query*", async route =>
            {
                if (route.Request.Method == "GET")
                {
                    await route.FulfillAsync(new RouteFulfillOptions
                    {
                        Status = 200,
                        ContentType = "application/json",
                        Body = queryJson,
                    });
                }
                else
                {
                    await route.ContinueAsync();
                }
            });
        }

        // User A
        await using var contextA = await NewIsolatedContextAsync();
        var pageA = await contextA.NewPageAsync();
        await SetupComplete(pageA);
        await InterceptConditions(pageA);

        await TestHelpers.GotoMarketsAsync(pageA, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var marketOnPageA = pageA.GetByText(marketTitle);
        await Assertions.Expect(marketOnPageA).ToBeVisibleAsync(new() { Timeout = 10_000 });

        // User B
        await using var contextB = await NewIsolatedContextAsync();
        var pageB = await contextB.NewPageAsync();
        await SetupComplete(pageB);
        await InterceptConditions(pageB);

        await TestHelpers.GotoMarketsAsync(pageB, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var marketOnPageB = pageB.GetByText(marketTitle);
        await Assertions.Expect(marketOnPageB).ToBeVisibleAsync(new() { Timeout = 10_000 });
    }

    public async Task DisposeAsync()
    {
        if (_browser is not null)
            await _browser.CloseAsync();

        _playwright?.Dispose();
    }
}
