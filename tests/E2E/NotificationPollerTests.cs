using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Playwright;

namespace BitCaster.E2ETest;

/// <summary>
/// PR3 coverage for the order-status poller + NotificationBell wiring.
///
/// The InMemoryMatchingEngine never produces fills on its own, so these
/// tests use Playwright route interception to return fabricated
/// <c>OrderStatusResponse</c> payloads. That's enough to
/// exercise the full client pipeline:
///
///   submit order → pendingTrades store populated → poller GET fires →
///   terminal status detected → notification appended → bell badge updates.
/// </summary>
public class NotificationPollerTests : IAsyncLifetime
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

    [Fact]
    public async Task Poller_FiresFillNotification_WhenEngineReportsFilledStatus()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();

        // Seed a pending trade directly into localStorage before the app
        // boots — avoids the full order-submission flow, which TradingFlowTests
        // already covers. The poller picks up whatever is in the store.
        const string orderId = "11111111-1111-1111-1111-111111111111";
        const string marketId = "deadbeefcafebabe-Yes";
        const string nsecHex = "0000000000000000000000000000000000000000000000000000000000000001";

        await page.AddInitScriptAsync($@"
            window.localStorage.setItem('bitcaster-settings', JSON.stringify({{
                state: {{
                    nostrSignerMode: 'nsec',
                    nsecSecret: '{nsecHex}',
                    relays: []
                }},
                version: 0
            }}));
            window.localStorage.setItem('bitcaster-pending-trades', JSON.stringify({{
                state: {{
                    byOrderId: {{
                        '{orderId}': {{
                            orderId: '{orderId}',
                            marketId: '{marketId}',
                            ephemeralPubkey: '02' + 'a'.repeat(64),
                            ephemeralPrivkey: 'b'.repeat(64),
                            submittedAt: Date.now(),
                        }}
                    }}
                }},
                version: 0
            }}));
        ");

        // Intercept the status GET and return a terminal "filled" response.
        await page.RouteAsync($"**/api/v1/{marketId}/orders/{orderId}", async route =>
        {
            await route.FulfillAsync(new RouteFulfillOptions
            {
                Status = 200,
                ContentType = "application/json",
                Body = JsonSerializer.Serialize(new
                {
                    orderId,
                    marketId,
                    status = "filled",
                    remainingAmountSats = 0,
                    filledAmountSats = 100,
                    fills = new[]
                    {
                        new
                        {
                            id = Guid.NewGuid().ToString(),
                            takerOrderId = orderId,
                            makerOrderId = Guid.NewGuid().ToString(),
                            amountSats = 100,
                            executionPrice = 50,
                            path = "Complementary",
                            filledAt = DateTime.UtcNow.ToString("O"),
                        }
                    },
                }),
            });
        });

        await TestHelpers.GotoMarketsAsync(page, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // The bell is rendered by AppShell on every screen except /setup and
        // /creator/new — so it's reachable on /markets. Aria-label is the
        // canonical accessibility handle set by NotificationBell.
        var bell = page.GetByRole(AriaRole.Button, new() { Name = "Notifications" });
        await Assertions.Expect(bell).ToBeVisibleAsync(new() { Timeout = 5_000 });

        // The poller's first tick fires on mount, so the badge should light
        // up within a second or two; give it a generous window.
        var badge = bell.GetByText(new Regex(@"^\d+$"));
        await Assertions.Expect(badge).ToBeVisibleAsync(new() { Timeout = 15_000 });
        await Assertions.Expect(badge).ToHaveTextAsync("1", new() { Timeout = 5_000 });

        // Opening the panel should surface the fill copy.
        await bell.ClickAsync();
        var fillEntry = page.GetByText(new Regex("Order filled.*100 sats.*Yes"));
        await Assertions.Expect(fillEntry).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    [Fact]
    public async Task Poller_FiresPartialFillNotification_WhenEngineReportsMintReservation()
    {
        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();

        const string orderId = "22222222-2222-2222-2222-222222222222";
        const string marketId = "deadbeefcafebabe-Yes";
        const string nsecHex = "0000000000000000000000000000000000000000000000000000000000000001";

        await page.AddInitScriptAsync($@"
            window.localStorage.setItem('bitcaster-settings', JSON.stringify({{
                state: {{
                    nostrSignerMode: 'nsec',
                    nsecSecret: '{nsecHex}',
                    relays: []
                }},
                version: 0
            }}));
            window.localStorage.setItem('bitcaster-pending-trades', JSON.stringify({{
                state: {{
                    byOrderId: {{
                        '{orderId}': {{
                            orderId: '{orderId}',
                            marketId: '{marketId}',
                            ephemeralPubkey: '02' + 'a'.repeat(64),
                            ephemeralPrivkey: 'b'.repeat(64),
                            submittedAt: Date.now(),
                        }}
                    }}
                }},
                version: 0
            }}));
        ");

        await page.RouteAsync($"**/api/v1/{marketId}/orders/{orderId}", async route =>
        {
            await route.FulfillAsync(new RouteFulfillOptions
            {
                Status = 200,
                ContentType = "application/json",
                Body = JsonSerializer.Serialize(new
                {
                    orderId,
                    marketId,
                    status = "partially_filled",
                    remainingAmountSats = 100,
                    filledAmountSats = 100,
                    fills = new[]
                    {
                        new
                        {
                            id = Guid.NewGuid().ToString(),
                            takerOrderId = Guid.NewGuid().ToString(),
                            makerOrderId = orderId,
                            amountSats = 100,
                            executionPrice = 50,
                            path = "Mint",
                            filledAt = DateTime.UtcNow.ToString("O"),
                            tradeId = Guid.NewGuid().ToString(),
                        }
                    },
                }),
            });
        });

        await TestHelpers.GotoMarketsAsync(page, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var bell = page.GetByRole(AriaRole.Button, new() { Name = "Notifications" });
        await Assertions.Expect(bell).ToBeVisibleAsync(new() { Timeout = 5_000 });
        var badge = bell.GetByText(new Regex(@"^\d+$"));
        await Assertions.Expect(badge).ToHaveTextAsync("1", new() { Timeout = 15_000 });

        await bell.ClickAsync();
        var fillEntry = page.GetByText(new Regex("Partial fill.*100 sats filled.*Yes.*100 remaining"));
        await Assertions.Expect(fillEntry).ToBeVisibleAsync(new() { Timeout = 5_000 });
    }

    public async Task DisposeAsync()
    {
        if (_browser is not null)
            await _browser.CloseAsync();
        _playwright?.Dispose();
    }
}
