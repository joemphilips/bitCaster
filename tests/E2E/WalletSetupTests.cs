using Microsoft.Playwright;

namespace BitCaster.E2ETest;

public class WalletSetupTests : IAsyncLifetime
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
    /// Helper: create a new page in PWA standalone mode by emulating the media feature.
    /// </summary>
    private async Task<IPage> NewPwaPageAsync()
    {
        Assert.NotNull(_browser);
        var context = await _browser.NewContextAsync();
        var page = await context.NewPageAsync();
        // Override matchMedia for display-mode: standalone
        await page.AddInitScriptAsync(@"
            window.matchMedia = (query) => ({
                matches: query === '(display-mode: standalone)',
                media: query,
                onchange: null,
                addListener: () => {},
                removeListener: () => {},
                addEventListener: () => {},
                removeEventListener: () => {},
                dispatchEvent: () => true,
            });
        ");
        return page;
    }

    /// <summary>
    /// Helper: create a new page in normal browser mode (not PWA).
    /// </summary>
    private async Task<IPage> NewBrowserPageAsync()
    {
        Assert.NotNull(_browser);
        var context = await _browser.NewContextAsync();
        var page = await context.NewPageAsync();
        // Override matchMedia so display-mode: standalone returns false
        await page.AddInitScriptAsync(@"
            window.matchMedia = (query) => ({
                matches: false,
                media: query,
                onchange: null,
                addListener: () => {},
                removeListener: () => {},
                addEventListener: () => {},
                removeEventListener: () => {},
                dispatchEvent: () => true,
            });
        ");
        return page;
    }

    /// <summary>
    /// Navigate through steps 1-3 (Welcome → PWA → Choice) and click "Create New Wallet".
    /// Returns the 12 seed words scraped from the DOM.
    /// </summary>
    private static async Task<string[]> NavigateToSeedDisplayAsync(IPage page)
    {
        // Step 1 (Welcome): click "Next"
        var nextBtn = page.GetByRole(AriaRole.Button, new() { Name = "Next" });
        await Assertions.Expect(nextBtn).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await nextBtn.ClickAsync();

        // Step 2 (PWA): click "Next →"
        var pwaNextBtn = page.GetByRole(AriaRole.Button, new() { Name = "Next →" });
        await Assertions.Expect(pwaNextBtn).ToBeEnabledAsync(new() { Timeout = 5_000 });
        await pwaNextBtn.ClickAsync();

        // Step 3 (Choice): click "Create New Wallet"
        var createBtn = page.GetByText("Create New Wallet");
        await Assertions.Expect(createBtn).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await createBtn.ClickAsync();

        // Step 4 (Seed Display): scrape 12 seed words
        await page.WaitForSelectorAsync("text=Your Seed Phrase", new() { Timeout = 5_000 });
        var wordElements = await page.QuerySelectorAllAsync(".font-mono.font-semibold");
        Assert.Equal(12, wordElements.Count);
        var seedWords = new string[12];
        for (int i = 0; i < 12; i++)
        {
            seedWords[i] = (await wordElements[i].TextContentAsync())?.Trim() ?? "";
        }
        return seedWords;
    }

    /// <summary>
    /// Check "I have saved my seed phrase" checkbox using JavaScript click to avoid
    /// Playwright timeout when the checkbox DOM element disappears (component switches to SeedVerification).
    /// </summary>
    private static async Task CheckSeedSavedAsync(IPage page)
    {
        await page.EvaluateAsync("document.querySelector('input[type=\"checkbox\"]').click()");
        // Wait for verification UI to appear
        await Assertions.Expect(page.GetByText("Verify Your Seed Phrase")).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    /// <summary>
    /// Complete the 3-step seed verification (words #3, #7, #12).
    /// </summary>
    private static async Task CompleteSeedVerificationAsync(IPage page, string[] seedWords)
    {
        // Step 1: word #3
        await Assertions.Expect(page.GetByText("Enter word #3")).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await page.GetByPlaceholder("Word #3").FillAsync(seedWords[2]);
        var nextBtn = page.GetByRole(AriaRole.Button, new() { Name = "Next" });
        await Assertions.Expect(nextBtn).ToBeEnabledAsync(new() { Timeout = 2_000 });
        await nextBtn.ClickAsync();

        // Step 2: word #7
        await Assertions.Expect(page.GetByText("Enter word #7")).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await page.GetByPlaceholder("Word #7").FillAsync(seedWords[6]);
        var nextBtn2 = page.GetByRole(AriaRole.Button, new() { Name = "Next" });
        await Assertions.Expect(nextBtn2).ToBeEnabledAsync(new() { Timeout = 2_000 });
        await nextBtn2.ClickAsync();

        // Step 3: word #12
        await Assertions.Expect(page.GetByText("Enter word #12")).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await page.GetByPlaceholder("Word #12").FillAsync(seedWords[11]);
        var continueBtn = page.GetByRole(AriaRole.Button, new() { Name = "Continue" });
        await Assertions.Expect(continueBtn).ToBeEnabledAsync(new() { Timeout = 2_000 });
        await continueBtn.ClickAsync();
    }

    /// <summary>
    /// Fill 12 seed word inputs one by one (for recover flow).
    /// </summary>
    private static async Task FillSeedWordsAsync(IPage page, string[] words)
    {
        var inputs = page.Locator("input[type='text']");
        for (int i = 0; i < 12; i++)
        {
            await inputs.Nth(i).FillAsync(words[i]);
        }
    }

    [Fact]
    public async Task CreateNewWallet_CompletesSetupAndRedirects()
    {
        var page = await NewPwaPageAsync();

        // Navigate to / → expect redirect to /setup
        await page.GotoAsync($"http://localhost:{VitePort}/", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });
        await Assertions.Expect(page).ToHaveURLAsync(new System.Text.RegularExpressions.Regex(@"/setup"));

        var seedWords = await NavigateToSeedDisplayAsync(page);

        // Check "I have saved my seed phrase" → triggers verification
        await CheckSeedSavedAsync(page);

        // Complete seed verification
        await CompleteSeedVerificationAsync(page, seedWords);

        // Step 5 (Mint Setup): default mint should appear
        await Assertions.Expect(page.GetByText("Connect to a Mint")).ToBeVisibleAsync(new() { Timeout = 10_000 });

        // Wait for "Connected" status
        await Assertions.Expect(page.GetByText("Connected")).ToBeVisibleAsync(new() { Timeout = 15_000 });

        // Click "Finish Setup"
        var finishBtn = page.GetByRole(AriaRole.Button, new() { Name = "Finish Setup" });
        await Assertions.Expect(finishBtn).ToBeEnabledAsync(new() { Timeout = 5_000 });
        await finishBtn.ClickAsync();

        // Assert URL is /markets
        await Assertions.Expect(page).ToHaveURLAsync(new System.Text.RegularExpressions.Regex(@"/markets"), new() { Timeout = 15_000 });
    }

    [Fact]
    public async Task PwaNotInstalled_BlocksStep2()
    {
        var page = await NewBrowserPageAsync();

        await page.GotoAsync($"http://localhost:{VitePort}/setup", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Step 1 → click "Next"
        var nextBtn = page.GetByRole(AriaRole.Button, new() { Name = "Next" });
        await Assertions.Expect(nextBtn).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await nextBtn.ClickAsync();

        // Step 2 (PWA): "Next →" should be disabled
        var pwaNextBtn = page.GetByRole(AriaRole.Button, new() { Name = "Next →" });
        await Assertions.Expect(pwaNextBtn).ToBeDisabledAsync(new() { Timeout = 5_000 });
    }

    [Fact]
    public async Task SeedVerification_WrongWordBlocksContinue()
    {
        var page = await NewPwaPageAsync();
        await page.GotoAsync($"http://localhost:{VitePort}/setup", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var seedWords = await NavigateToSeedDisplayAsync(page);

        // Check "I have saved my seed phrase" → triggers verification
        await CheckSeedSavedAsync(page);

        // Verification sub-step #1: "Enter word #3"
        await Assertions.Expect(page.GetByText("Enter word #3")).ToBeVisibleAsync(new() { Timeout = 5_000 });

        // Enter wrong word → "Next" should be disabled
        var input = page.GetByPlaceholder("Word #3");
        await input.FillAsync("wrongword");
        var nextVerifyBtn = page.GetByRole(AriaRole.Button, new() { Name = "Next" });
        await Assertions.Expect(nextVerifyBtn).ToBeDisabledAsync(new() { Timeout = 2_000 });

        // Enter correct word → "Next" becomes enabled
        await input.FillAsync(seedWords[2]);
        await Assertions.Expect(nextVerifyBtn).ToBeEnabledAsync(new() { Timeout = 2_000 });
        await nextVerifyBtn.ClickAsync();

        // Verification sub-step #2 appears: "Enter word #7"
        await Assertions.Expect(page.GetByText("Enter word #7")).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    [Fact]
    public async Task RecoverWallet_WithValidSeedAndRedirects()
    {
        var page = await NewPwaPageAsync();
        await page.GotoAsync($"http://localhost:{VitePort}/setup", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Get Started → Next (PWA) → Recover Wallet
        await page.GetByRole(AriaRole.Button, new() { Name = "Next" }).ClickAsync();
        await page.GetByRole(AriaRole.Button, new() { Name = "Next →" }).ClickAsync();
        await page.GetByText("Recover Wallet").First.ClickAsync();

        // Step 4 (Seed Input): fill each word individually
        await Assertions.Expect(page.GetByText("Enter Your Seed Phrase")).ToBeVisibleAsync(new() { Timeout = 5_000 });
        var words = new[] { "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
                            "abandon", "abandon", "abandon", "abandon", "abandon", "about" };
        await FillSeedWordsAsync(page, words);

        // "Recover Wallet" button should be enabled (valid checksum)
        var recoverBtn = page.GetByRole(AriaRole.Button, new() { Name = "Recover Wallet" });
        await Assertions.Expect(recoverBtn).ToBeEnabledAsync(new() { Timeout = 5_000 });
        await recoverBtn.ClickAsync();

        // Step 5: wait for mint connected → "Finish Setup"
        await Assertions.Expect(page.GetByText("Connected")).ToBeVisibleAsync(new() { Timeout = 15_000 });
        var finishBtn = page.GetByRole(AriaRole.Button, new() { Name = "Finish Setup" });
        await Assertions.Expect(finishBtn).ToBeEnabledAsync(new() { Timeout = 5_000 });
        await finishBtn.ClickAsync();

        // Assert URL is /markets
        await Assertions.Expect(page).ToHaveURLAsync(new System.Text.RegularExpressions.Regex(@"/markets"), new() { Timeout = 15_000 });
    }

    [Fact]
    public async Task RecoverWallet_InvalidChecksumShowsError()
    {
        var page = await NewPwaPageAsync();
        await page.GotoAsync($"http://localhost:{VitePort}/setup", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        await page.GetByRole(AriaRole.Button, new() { Name = "Next" }).ClickAsync();
        await page.GetByRole(AriaRole.Button, new() { Name = "Next →" }).ClickAsync();
        await page.GetByText("Recover Wallet").First.ClickAsync();

        // Fill 12 valid BIP-39 words but with invalid checksum
        await Assertions.Expect(page.GetByText("Enter Your Seed Phrase")).ToBeVisibleAsync(new() { Timeout = 5_000 });
        var words = new[] { "zoo", "zoo", "zoo", "zoo", "zoo", "zoo",
                            "zoo", "zoo", "zoo", "zoo", "zoo", "abandon" };
        await FillSeedWordsAsync(page, words);

        // "Recover Wallet" should be disabled and error shown
        var recoverBtn = page.GetByRole(AriaRole.Button, new() { Name = "Recover Wallet" });
        await Assertions.Expect(recoverBtn).ToBeDisabledAsync(new() { Timeout = 5_000 });
        await Assertions.Expect(page.GetByText("Invalid mnemonic")).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    [Fact]
    public async Task FirstTimeSetup_ShowsLoadingPageBeforeMarkets()
    {
        var page = await NewPwaPageAsync();

        // Intercept /v1/conditions to delay the response
        var tcs = new TaskCompletionSource<bool>();
        await page.RouteAsync("**/v1/conditions", async route =>
        {
            await tcs.Task;
            await route.FulfillAsync(new RouteFulfillOptions
            {
                ContentType = "application/json",
                Body = """{"conditions":[]}""",
            });
        });

        await page.GotoAsync($"http://localhost:{VitePort}/setup", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.DOMContentLoaded,
            Timeout = 30_000,
        });

        var seedWords = await NavigateToSeedDisplayAsync(page);

        // Check "I have saved" → verify words → advance
        await CheckSeedSavedAsync(page);
        await CompleteSeedVerificationAsync(page, seedWords);

        // Wait for mint to connect (mint API is not intercepted, only /v1/conditions is)
        await Assertions.Expect(page.GetByText("Connected")).ToBeVisibleAsync(new() { Timeout = 15_000 });

        // Click "Finish Setup"
        await page.GetByRole(AriaRole.Button, new() { Name = "Finish Setup" }).ClickAsync();

        // Assert the "Now Loading" page is shown
        await Assertions.Expect(page.GetByText("Finance wants to be free")).ToBeVisibleAsync(new() { Timeout = 5_000 });

        // Release the delayed conditions response
        tcs.SetResult(true);

        // Assert auto-navigation to /markets
        await Assertions.Expect(page).ToHaveURLAsync(new System.Text.RegularExpressions.Regex(@"/markets"), new() { Timeout = 15_000 });
    }

    [Fact]
    public async Task SetupComplete_NoRedirectToSetup()
    {
        Assert.NotNull(_browser);
        var page = await _browser.NewPageAsync();

        // Set setupComplete in localStorage before navigating
        await page.GotoAsync($"http://localhost:{VitePort}/setup", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.DOMContentLoaded,
            Timeout = 30_000,
        });
        await page.EvaluateAsync(@"
            localStorage.setItem('bitcaster-wallet', JSON.stringify({
                state: {
                    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
                    setupComplete: true,
                    mints: [],
                    activeMintUrl: 'http://localhost:3338',
                    keysetCounters: {}
                },
                version: 0
            }));
        ");

        // Navigate to /markets
        await page.GotoAsync($"http://localhost:{VitePort}/markets", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // Assert URL remains /markets (no redirect to /setup)
        await Assertions.Expect(page).ToHaveURLAsync(new System.Text.RegularExpressions.Regex(@"/markets"), new() { Timeout = 5_000 });
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
