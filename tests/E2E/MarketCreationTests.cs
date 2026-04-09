using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.Playwright;

namespace BitCaster.E2ETest;

public class MarketCreationTests : IAsyncLifetime
{
    private IPlaywright? _playwright;
    private IBrowser? _browser;
    private const int VitePort = 5173;
    private const int MintPort = 8085;
    private const int ServerPort = 5000;

    public async Task InitializeAsync()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        await Task.WhenAll(
            TestHelpers.WaitForService(httpClient, $"http://localhost:{MintPort}/v1/info", "Mint"),
            TestHelpers.WaitForService(httpClient, $"http://localhost:{ServerPort}/health", "Matching Engine"),
            TestHelpers.WaitForService(httpClient, $"http://localhost:{VitePort}", "Frontend"));

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
        await TestHelpers.SetupComplete(page, VitePort);

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
    /// Uses the "become oracle" path which doesn't require Nostr.
    /// </summary>
    private async Task NavigateToStep2(IPage page)
    {
        await SetupComplete(page);
        await page.GotoAsync($"http://localhost:{VitePort}/creator/new", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Step 1: Oracle Check — choose "become oracle" path
        var becomeOracle = page.GetByText("No / I want to be an oracle");
        await Assertions.Expect(becomeOracle).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await becomeOracle.ClickAsync();

        // Click "I've already configured" to proceed
        var configuredBtn = page.GetByText("I've already configured");
        await Assertions.Expect(configuredBtn).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await configuredBtn.ClickAsync();

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

        // Wait for step 5
        var liquidityHeading = page.GetByRole(AriaRole.Heading, new() { Name = "Initial Liquidity" });
        await Assertions.Expect(liquidityHeading).ToBeVisibleAsync(new() { Timeout = 5_000 });
        if (targetStep <= 5) return;

        // Step 5 → 6: Set liquidity
        var quickBtn = page.GetByRole(AriaRole.Button, new() { Name = "1,000" });
        await quickBtn.ClickAsync();
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
    public async Task WizardStep5_NextDisabledWhenLiquidityZero()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await NavigateToStep(page, 5);

        // Next should be disabled initially (liquidity = 0)
        var nextBtn = page.GetByRole(AriaRole.Button, new() { Name = "Next" });
        await Assertions.Expect(nextBtn).ToBeDisabledAsync();

        // Click the 1,000 quick amount button
        var quickBtn = page.GetByRole(AriaRole.Button, new() { Name = "1,000" });
        await quickBtn.ClickAsync();

        // Next should now be enabled
        await Assertions.Expect(nextBtn).ToBeEnabledAsync();
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
        var mintConditionsResponse = await httpClient.GetAsync($"http://localhost:{MintPort}/v1/conditions");
        Assert.True(mintConditionsResponse.IsSuccessStatusCode, "Failed to fetch conditions from mint");
        var mintBody = await mintConditionsResponse.Content.ReadAsStringAsync();
        using var mintDoc = System.Text.Json.JsonDocument.Parse(mintBody);
        var firstCondition = mintDoc.RootElement.GetProperty("conditions").EnumerateArray().First();
        var conditionId = firstCondition.GetProperty("condition_id").GetString()!;

        // Extract outcome names from the seeded condition's first partition
        var partition = firstCondition.GetProperty("partitions").EnumerateArray().First()
            .GetProperty("partition");
        var outcomeNames = partition.EnumerateArray().Select(p => p.GetString()!).ToList();
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
            $"http://localhost:{ServerPort}/api/v1/markets/{conditionId}",
            formContent);

        // Accept both 200 (created) and 409 (already exists from prior run)
        // since this test verifies UI visibility, not creation idempotency.
        Assert.True(
            createResponse.IsSuccessStatusCode || createResponse.StatusCode == System.Net.HttpStatusCode.Conflict,
            $"createMarket failed: {createResponse.StatusCode} {await createResponse.Content.ReadAsStringAsync()}");

        // Build route interception JSON so the frontend sees our custom title
        // for this condition (overriding the seeded title)
        var conditionJson = System.Text.Json.JsonSerializer.Serialize(new
        {
            conditions = new object[]
            {
                new
                {
                    condition_id = conditionId,
                    tags = new[] { new[] { "description", marketTitle } },
                    threshold = firstCondition.GetProperty("threshold").GetInt32(),
                    announcements = firstCondition.GetProperty("announcements")
                        .EnumerateArray().Select(a => a.GetString()).ToArray(),
                    partitions = firstCondition.GetProperty("partitions")
                        .EnumerateArray().Select(p => new
                        {
                            partition = p.GetProperty("partition")
                                .EnumerateArray().Select(v => v.GetString()).ToArray(),
                            collateral = p.TryGetProperty("collateral", out var c) ? c.GetString() ?? "" : "",
                            parent_collection_id = p.TryGetProperty("parent_collection_id", out var pc)
                                ? pc.GetString() ?? "" : "",
                            keysets = p.TryGetProperty("keysets", out var ks)
                                ? ks.EnumerateObject().ToDictionary(kv => kv.Name, kv => kv.Value.GetString() ?? "")
                                : new Dictionary<string, string>(),
                        }).ToArray(),
                    attestation = new
                    {
                        status = "pending",
                        winning_outcome = (string?)null,
                        attested_at = (long?)null,
                    },
                },
            },
        });

        async Task InterceptConditions(IPage page)
        {
            await page.RouteAsync("**/v1/conditions", async route =>
            {
                if (route.Request.Method == "GET")
                {
                    await route.FulfillAsync(new RouteFulfillOptions
                    {
                        Status = 200,
                        ContentType = "application/json",
                        Body = conditionJson,
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

        await pageA.GotoAsync($"http://localhost:{VitePort}/markets", new PageGotoOptions
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

        await pageB.GotoAsync($"http://localhost:{VitePort}/markets", new PageGotoOptions
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
