using System.Text.Json;
using Microsoft.Playwright;

namespace BitCaster.E2ETest;

/// <summary>
/// Phase 2 frontend wiring (P6 staging fixes, ADR-009). Verifies the
/// markets-list page consumes the engine catalogue proxy
/// (<c>GET /api/v1/markets/query</c>) — sort-dimension and tag-filter
/// selections forward verbatim as <c>?sort=</c> / <c>?tag=</c> parameters,
/// the HMAC-signed cursor advances pagination, and the liked-markets
/// portfolio surface uses the <c>?ids=</c> bulk-fetch path.
///
/// Tests intercept the engine endpoint with <see cref="IPage.RouteAsync"/>
/// so the assertions run regardless of the in-memory mock's current
/// state — what's under test here is the wiring on the frontend side.
/// </summary>
public class MarketQueryProxyTests : IAsyncLifetime
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

    private static string CatalogueResponse(params (string Id, string Title, string[] CategoryTags)[] markets)
    {
        var entries = markets.Select(m => new
        {
            conditionId = m.Id,
            outcomes = new[] { "YES", "NO" },
            title = m.Title,
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
            categoryTags = m.CategoryTags,
            lastSuccessfulRefreshAt = "2026-05-02T09:58:00Z",
        }).ToArray();
        return JsonSerializer.Serialize(new
        {
            markets = entries,
            nextCursor = (string?)null,
            lastSuccessfulRefreshAt = "2026-05-02T09:58:00Z",
        });
    }

    private async Task SetupComplete(IPage page) =>
        await TestHelpers.SetupComplete(page, TestPorts.Vite);

    /// <summary>
    /// T2.f.a — the markets list calls /api/v1/markets/query and renders the
    /// API-provided titles. The deprecated mintd-direct path
    /// (/v1/conditions) MUST NOT be used.
    /// </summary>
    [Fact]
    public async Task MarketsList_ConsumesEngineQueryProxy()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        var queryUrls = new List<string>();
        await page.RouteAsync("**/api/v1/markets/query*", async route =>
        {
            queryUrls.Add(route.Request.Url);
            await route.FulfillAsync(new RouteFulfillOptions
            {
                Status = 200,
                ContentType = "application/json",
                Body = CatalogueResponse(
                    ("aaaa00", "Engine-routed Market A", new[] { "crypto" }),
                    ("bbbb01", "Engine-routed Market B", new[] { "politics" })),
            });
        });

        var conditionsHits = 0;
        await page.RouteAsync("**/v1/conditions", async route =>
        {
            conditionsHits++;
            await route.ContinueAsync();
        });

        await SetupComplete(page);
        await TestHelpers.GotoMarketsAsync(page, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        try
        {
            var marketA = page.GetByText("Engine-routed Market A");
            await Assertions.Expect(marketA).ToBeVisibleAsync(new() { Timeout = 10_000 });
            await Assertions.Expect(page.Locator("[aria-label='Volume'], [title='Volume']").First)
                .ToBeVisibleAsync(new() { Timeout = 10_000 });
            await Assertions.Expect(page.Locator("[aria-label='Liquidity'], [title='Liquidity']").First)
                .ToBeVisibleAsync(new() { Timeout = 10_000 });
            await Assertions.Expect(page.Locator("[aria-label='Traders'], [title='Traders']").First)
                .ToBeVisibleAsync(new() { Timeout = 10_000 });
            await Assertions.Expect(page.GetByText(new System.Text.RegularExpressions.Regex("^Volume$"))).ToHaveCountAsync(0);
            await Assertions.Expect(page.GetByText(new System.Text.RegularExpressions.Regex("^Liquidity$"))).ToHaveCountAsync(0);
            await Assertions.Expect(page.GetByText(new System.Text.RegularExpressions.Regex("^Traders$"))).ToHaveCountAsync(0);
            Assert.NotEmpty(queryUrls);
            // Detail-page mintd contract is intact, but we never navigated to
            // the detail page — so the markets-list flow MUST NOT have hit
            // /v1/conditions. The brand-motto splash also routes through the
            // engine query, so this is a strict equality.
            Assert.Equal(0, conditionsHits);
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                $"Markets list did not render engine response (queryUrls={queryUrls.Count}, conditionsHits={conditionsHits}).");
        }
    }

    /// <summary>
    /// T2.f.b — clicking the 'New' sort button forwards `?sort=New` to the
    /// engine. Confirms the SortBar is wired to the API query parameter post
    /// Phase-2.
    /// </summary>
    [Fact]
    public async Task MarketsList_SortSelector_ForwardsQueryParameter()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        var queryUrls = new List<string>();
        await page.RouteAsync("**/api/v1/markets/query*", async route =>
        {
            queryUrls.Add(route.Request.Url);
            await route.FulfillAsync(new RouteFulfillOptions
            {
                Status = 200,
                ContentType = "application/json",
                Body = CatalogueResponse(("aaaa00", "Sort wiring market", new[] { "crypto" })),
            });
        });

        await SetupComplete(page);
        await TestHelpers.GotoMarketsAsync(page, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var sortNew = page.GetByTestId("market-sort-new");
        await Assertions.Expect(sortNew).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await sortNew.ClickAsync();

        try
        {
            await Assertions.Expect(sortNew).ToHaveAttributeAsync("aria-selected", "true");
            await PollUntilAsync(
                () => queryUrls.Any(u => u.Contains("sort=New")),
                timeout: TimeSpan.FromSeconds(5),
                description: "engine query with sort=New");
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                $"Sort selector did not forward sort=New (queryUrls={string.Join(',', queryUrls)})");
        }
    }

    /// <summary>
    /// Search text in the shell navigates to `/markets?search=...` and
    /// forwards the same query to the catalogue API.
    /// </summary>
    [Fact]
    public async Task ShellSearch_ForwardsSearchQueryParameter()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        var queryUrls = new List<string>();
        await page.RouteAsync("**/api/v1/markets/query*", async route =>
        {
            queryUrls.Add(route.Request.Url);
            await route.FulfillAsync(new RouteFulfillOptions
            {
                Status = 200,
                ContentType = "application/json",
                Body = CatalogueResponse(("search01", "Bitcoin oracle search result", new[] { "crypto" })),
            });
        });

        await SetupComplete(page);
        await TestHelpers.GotoMarketsAsync(page, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var searchBox = page.GetByPlaceholder("Search markets...").First;
        await Assertions.Expect(searchBox).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await searchBox.FillAsync("bitcoin oracle");

        try
        {
            await Assertions.Expect(page).ToHaveURLAsync(
                new System.Text.RegularExpressions.Regex(@"\/markets\?search=bitcoin%20oracle"),
                new() { Timeout = 5_000 });
            await PollUntilAsync(
                () => queryUrls.Any(u => u.Contains("search=bitcoin+oracle") || u.Contains("search=bitcoin%20oracle")),
                timeout: TimeSpan.FromSeconds(5),
                description: "engine query with search=bitcoin oracle");
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                $"Search box did not forward search=bitcoin oracle (queryUrls={string.Join(',', queryUrls)})");
        }
    }

    /// <summary>
    /// T2.f.c — the liked-markets portfolio surface fetches via the engine's
    /// `?ids=` bulk-fetch surface. Seed two bookmarks via localStorage and
    /// assert the resulting query carries both IDs in a single call.
    /// </summary>
    [Fact]
    public async Task LikedMarkets_UsesIdsBulkFetch()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        var idsCalls = new List<string>();
        await page.RouteAsync("**/api/v1/markets/query*", async route =>
        {
            var url = route.Request.Url;
            if (url.Contains("ids="))
                idsCalls.Add(url);
            await route.FulfillAsync(new RouteFulfillOptions
            {
                Status = 200,
                ContentType = "application/json",
                Body = CatalogueResponse(
                    ("liked01", "Liked Market One", new[] { "crypto" }),
                    ("liked02", "Liked Market Two", new[] { "politics" })),
            });
        });

        await SetupComplete(page);
        await TestHelpers.GotoMarketsAsync(page, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.DOMContentLoaded,
            Timeout = 30_000,
        });

        // Seed the bookmark store directly. `useBookmarkStore` persists under
        // the `bitcaster-bookmarks` localStorage key with `state.markets` as
        // an array of conditionIds.
        await page.EvaluateAsync(@"
            localStorage.setItem('bitcaster-bookmarks', JSON.stringify({
                state: { markets: ['liked01', 'liked02'] },
                version: 0
            }));
        ");

        await page.GotoAsync($"{TestPorts.FrontendUrl}/portfolio", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        try
        {
            var likedOne = page.GetByText("Liked Market One");
            await Assertions.Expect(likedOne.First).ToBeVisibleAsync(new() { Timeout = 10_000 });
            Assert.NotEmpty(idsCalls);
            Assert.Contains(idsCalls, u => u.Contains("liked01") && u.Contains("liked02"));
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                $"Liked-markets surface did not bulk-fetch via ?ids= (idsCalls={idsCalls.Count}).");
        }
    }

    /// <summary>
    /// T2.f.d — the page advances through the HMAC-signed cursor when the
    /// engine returns one. First response carries `nextCursor`; the page
    /// surfaces a Load More affordance whose click triggers a follow-up
    /// query with `?cursor=`.
    /// </summary>
    [Fact]
    public async Task MarketsList_PaginationCursor_AdvancesToNextPage()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);

        var firstPage = JsonSerializer.Serialize(new
        {
            markets = new[]
            {
                new
                {
                    conditionId = "page1aa",
                    outcomes = new[] { "YES", "NO" },
                    title = "Page 1 Market",
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
            nextCursor = "OPAQUE-PAGE-2-CURSOR",
            lastSuccessfulRefreshAt = "2026-05-02T09:58:00Z",
        });

        var secondPage = CatalogueResponse(("page2bb", "Page 2 Market", new[] { "crypto" }));

        var seenCursors = new List<string>();
        await page.RouteAsync("**/api/v1/markets/query*", async route =>
        {
            var url = route.Request.Url;
            if (url.Contains("cursor=OPAQUE-PAGE-2-CURSOR"))
            {
                seenCursors.Add(url);
                await route.FulfillAsync(new RouteFulfillOptions
                {
                    Status = 200,
                    ContentType = "application/json",
                    Body = secondPage,
                });
                return;
            }

            await route.FulfillAsync(new RouteFulfillOptions
            {
                Status = 200,
                ContentType = "application/json",
                Body = firstPage,
            });
        });

        await SetupComplete(page);
        await TestHelpers.GotoMarketsAsync(page, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var pageOne = page.GetByText("Page 1 Market");
        await Assertions.Expect(pageOne).ToBeVisibleAsync(new() { Timeout = 10_000 });

        // Trigger pagination by scrolling to the bottom — the Phase 4
        // markets list calls onLoadMore on scroll. If a Load More button is
        // present we click it instead.
        await page.EvaluateAsync("window.scrollTo(0, document.body.scrollHeight)");

        // Give the lazy-load IntersectionObserver a beat to fire. Use the
        // cursor capture as the actual readiness signal so a slow CI run
        // doesn't flake.
        try
        {
            await PollUntilAsync(
                () => seenCursors.Count > 0,
                timeout: TimeSpan.FromSeconds(8),
                description: "follow-up query with cursor=OPAQUE-PAGE-2-CURSOR");
        }
        catch
        {
            // The current MarketDiscovery surface may not auto-trigger
            // onLoadMore from a scroll in a headless viewport. Ensure the
            // hook is at least functional by invoking it directly through
            // the dev tools — fall back to asserting the engine response
            // shape was honoured (cursor was carried).
            throw await TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages,
                $"Pagination cursor never advanced (seenCursors={seenCursors.Count}). The page may not surface a load-more affordance in headless mode.");
        }
    }

    private static async Task PollUntilAsync(Func<bool> predicate, TimeSpan timeout, string description)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (predicate()) return;
            await Task.Delay(100);
        }
        throw new TimeoutException($"Timed out waiting for: {description}");
    }

    public Task DisposeAsync()
    {
        _browser?.DisposeAsync().GetAwaiter().GetResult();
        _playwright?.Dispose();
        return Task.CompletedTask;
    }
}
