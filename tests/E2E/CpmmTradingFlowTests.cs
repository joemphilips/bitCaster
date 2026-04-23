using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Playwright;

namespace BitCaster.E2ETest;

/// <summary>
/// Phase 1G — Frontend E2E coverage for the full CPMM buy flow against the
/// in-memory matching engine.
///
/// The scenarios are split in two:
///
/// <list type="bullet">
///   <item><b>Gap A (UI)</b> — after a pool flips to <c>Active</c> and bootstrap
///   orders are posted under the <c>cpmm:{marketId}</c> sentinel, the market
///   detail page must render the OrderBookSection populated from the initial
///   snapshot, proving the <c>liveMarketId</c> prop is wired through
///   <c>MarketDetail.tsx</c>.</item>
///   <item><b>Gap B (HTTP)</b> — a NIP-98 authenticated taker buying against a
///   CPMM-funded pool produces a filled order, decrements the engine reserve,
///   and surfaces a position via <c>GET /api/v1/users/{pubkey}/positions</c>.
///   We do not drive the browser confirm button for this assertion because the
///   frontend's CPMM branch calls <c>wallet.send()</c> against the mint to
///   build <c>lockedSatsProofs</c>, which requires real mint-issued proofs
///   that the existing <c>SeedBalanceAsync</c> helper does not provide. The
///   HTTP path is faithful to what <c>submitOrder()</c> in
///   <c>bitCaster-app/src/lib/markets.ts</c> would send on the wire.</item>
/// </list>
///
/// A dedicated test class keeps the CPMM-specific fixture orthogonal to
/// <see cref="TradingFlowTests"/> (which covers pre-CPMM UX branches like
/// insufficient-balance and ephemeral-pubkey wiring).
/// </summary>
public class CpmmTradingFlowTests : IAsyncLifetime
{
    private IPlaywright? _playwright;
    private IBrowser? _browser;
    private HttpClient _http = null!;

    // Deterministic throwaway nsec reused across P4/settings tests so the test
    // pubkey that the mock receives via NIP-98 is stable. The derived hex
    // pubkey below was produced via `nak key public` — documenting it inline
    // lets the positions assertion be a simple string compare.
    private const string TestNsec =
        "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
    private const string TestPubkeyHex =
        "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";

    public async Task InitializeAsync()
    {
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        await Task.WhenAll(
            TestHelpers.WaitForService(_http, $"http://localhost:{TestPorts.Mint}/v1/info", "Mint"),
            TestHelpers.WaitForService(_http, $"http://localhost:{TestPorts.Server}/health", "Matching Engine"),
            TestHelpers.WaitForService(_http, $"http://localhost:{TestPorts.Vite}", "Frontend"));

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

    /// <summary>
    /// Grab the first seeded condition from the mint and register a market on
    /// the matching engine. Returns the conditionId and the outcome list so
    /// the caller can build the per-outcome marketIds. Accepts 200 or 409 for
    /// idempotency against a persistent mint across test runs.
    /// </summary>
    private async Task<(string ConditionId, string[] Outcomes)> CreateYesNoMarketAsync()
    {
        var mintResp = await _http.GetAsync($"http://localhost:{TestPorts.Mint}/v1/conditions");
        mintResp.EnsureSuccessStatusCode();
        using var mintDoc = JsonDocument.Parse(await mintResp.Content.ReadAsStringAsync());

        // Prefer a condition whose first partition is binary Yes/No — the
        // OrderBookSection renders only for `market.type === 'yesno'`.
        string? conditionId = null;
        string[]? outcomes = null;
        foreach (var cond in mintDoc.RootElement.GetProperty("conditions").EnumerateArray())
        {
            var firstPartition = cond.GetProperty("partitions").EnumerateArray().FirstOrDefault();
            if (firstPartition.ValueKind == JsonValueKind.Undefined) continue;
            var names = firstPartition.GetProperty("partition")
                .EnumerateArray().Select(p => p.GetString()!).ToArray();
            if (names.Length == 2 && names.Contains("Yes") && names.Contains("No"))
            {
                conditionId = cond.GetProperty("condition_id").GetString();
                outcomes = names;
                break;
            }
        }
        Assert.NotNull(conditionId);
        Assert.NotNull(outcomes);

        var metadata = JsonSerializer.Serialize(new
        {
            title = "CPMM E2E Flow Market",
            description = "Phase 1G CPMM buy test",
            outcomes = outcomes.Select((n, i) => new { name = n, probability = i == 0 ? 50 : 50 }).ToArray(),
            liquiditySats = 1000,
            categoryTags = new[] { "crypto" },
        });
        var form = new MultipartFormDataContent();
        form.Add(new StringContent(metadata), "metadata");

        var createResp = await _http.PostAsync(
            $"http://localhost:{TestPorts.Server}/api/v1/markets/{conditionId}",
            form);
        Assert.True(
            createResp.IsSuccessStatusCode || createResp.StatusCode == System.Net.HttpStatusCode.Conflict,
            $"createMarket failed: {createResp.StatusCode} {await createResp.Content.ReadAsStringAsync()}");

        return (conditionId!, outcomes!);
    }

    /// <summary>
    /// Flip the CPMM pool to Active and post a resting Sell bootstrap order on
    /// "Yes" so the taker has a counterparty to match against. The reserve is
    /// sized large enough to cover the 100-sat test buy without tripping the
    /// capped-loss gate.
    /// </summary>
    private async Task<string> SimulateCpmmFundingAsync(string conditionId, string[] outcomes)
    {
        // The mock's CPMM state is keyed on the per-outcome market id;
        // "funding" a condition-level market conceptually applies to every
        // outcome, so we post a simulate-cpmm-funding call for the Yes market
        // (the only book the Phase 1G test touches).
        var yesMarketId = $"{conditionId}-Yes";

        // Bootstrap: a single resting Sell order at 50¢ with enough depth to
        // match the taker's 100-sat buy. The fill price is encoded in the
        // `price` field of the maker — 50 means 50% probability, a.k.a. the
        // midpoint where a symmetric CPMM pool opens.
        var body = new
        {
            declaredSats = 1000L,
            reservedSatsByOutcome = new Dictionary<string, long>
            {
                ["Yes"] = 5000L,
                ["No"] = 5000L,
            },
            bootstrapOrders = new[]
            {
                new { outcome = "Yes", side = "Sell", price = 50, amountSats = 1000L },
            },
        };

        var resp = await _http.PostAsJsonAsync(
            $"http://localhost:{TestPorts.Server}/api/v1/_dev/markets/{yesMarketId}/simulate-cpmm-funding",
            body);
        Assert.True(resp.IsSuccessStatusCode,
            $"simulate-cpmm-funding failed: {resp.StatusCode} {await resp.Content.ReadAsStringAsync()}");

        return yesMarketId;
    }

    [Fact]
    public async Task CpmmFundingFlow_CreatesMarket_FlipsToActive_SurfacesBootstrapBook()
    {
        // ── Gap B backend surface ───────────────────────────────────────────
        var (conditionId, outcomes) = await CreateYesNoMarketAsync();
        var yesMarketId = await SimulateCpmmFundingAsync(conditionId, outcomes);

        // Funding-status must read Active after the simulate call.
        var fundingResp = await _http.GetAsync(
            $"http://localhost:{TestPorts.Server}/api/v1/{yesMarketId}/funding-status");
        fundingResp.EnsureSuccessStatusCode();
        using var fundingDoc = JsonDocument.Parse(await fundingResp.Content.ReadAsStringAsync());
        Assert.Equal("Active", fundingDoc.RootElement.GetProperty("status").GetString());
        Assert.Equal(1000, fundingDoc.RootElement.GetProperty("declaredSats").GetInt64());

        // Engine pubkey must be a valid 33-byte compressed secp256k1 hex so
        // the frontend's validator in lib/markets.ts accepts it.
        var pubkeyResp = await _http.GetAsync(
            $"http://localhost:{TestPorts.Server}/api/v1/engine/pubkey");
        pubkeyResp.EnsureSuccessStatusCode();
        using var pubkeyDoc = JsonDocument.Parse(await pubkeyResp.Content.ReadAsStringAsync());
        var enginePubkey = pubkeyDoc.RootElement.GetProperty("pubkey").GetString()!;
        Assert.Matches("^(02|03)[0-9a-fA-F]{64}$", enginePubkey);

        // ── Gap A UI surface ────────────────────────────────────────────────
        // Intercept /v1/conditions so the frontend's market-list/detail calls
        // show our CPMM market front and center with a known title.
        var conditionJson = await BuildSingleConditionJsonAsync(conditionId);

        await using var context = await NewIsolatedContextAsync();
        var page = await context.NewPageAsync();
        await TestHelpers.SetupComplete(page, TestPorts.Vite, $"http://localhost:{TestPorts.Mint}");
        await InterceptConditions(page, conditionJson);

        await page.GotoAsync($"http://localhost:{TestPorts.Vite}/markets/{conditionId}", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        // OrderBookSection header ("Order Book") proves MarketDetail.tsx
        // rendered it — this is the Gap A assertion. Without the wiring
        // added in this phase the component never mounts on the detail page.
        var orderBookHeader = page.GetByRole(AriaRole.Heading, new() { Name = "Order Book" });
        await Assertions.Expect(orderBookHeader.First)
            .ToBeVisibleAsync(new() { Timeout = 15_000 });

        // The Asks header and the bootstrap maker's 50% price row should both
        // render — proves the snapshot returned by /orderbook was decoded and
        // the bootstrap sell sits on the book. OrderBookSection uses
        // `tracking-wider uppercase` as CSS styling, so the underlying DOM
        // text is the i18n value "Asks" (not "ASKS").
        var asksHeader = page.GetByText("Asks", new() { Exact = true }).First;
        await Assertions.Expect(asksHeader)
            .ToBeVisibleAsync(new() { Timeout = 10_000 });
        // Scope the price match to the ask row color class so it doesn't
        // collide with the spread indicator (which also renders a "%" suffix
        // but in a different color). `text-red-600` marks an ask row price.
        var ask50Pct = page.Locator(".text-red-600.font-mono", new() { HasText = "50%" }).First;
        await Assertions.Expect(ask50Pct)
            .ToBeVisibleAsync(new() { Timeout = 10_000 });
    }

    [Fact]
    public async Task CpmmFillFlow_SubmitsOrder_DecrementsReserve_RecordsPosition()
    {
        // ── Set up a funded pool with a resting CPMM sell so there's liquidity
        //    to match against ────────────────────────────────────────────────
        var (conditionId, outcomes) = await CreateYesNoMarketAsync();
        var yesMarketId = await SimulateCpmmFundingAsync(conditionId, outcomes);

        // Reserve before — used to assert the capped-loss gate actually ran.
        var reservesBefore = await GetReservesAsync(yesMarketId);
        Assert.Equal(5000, reservesBefore["Yes"]);

        // Snapshot position before — the mock's ApplyPositionDelta accrues
        // across runs within the same server process, so we assert the delta
        // rather than the absolute balance.
        var positionBefore = await GetPositionTokenAmountAsync(TestPubkeyHex, yesMarketId, "Yes");

        // ── Submit a buy via raw HTTP with a NIP-98 header minted from the
        //    test nsec. We skip the locked-proofs field because the mock does
        //    not validate it and the frontend's wallet.send() path is not
        //    exercisable without real mint-issued proofs — asserting the
        //    backend settlement contract is the goal here. ─────────────────
        const long amountSats = 100L;
        var orderUrl = $"http://localhost:{TestPorts.Server}/api/v1/{yesMarketId}/orders";
        var submitResp = await SubmitNip98OrderAsync(
            url: orderUrl,
            nsec: TestNsec,
            body: new
            {
                outcomeId = "Yes",
                side = "Buy",
                price = 99, // aggressive limit — crosses the 50% bootstrap ask
                amountSats,
                timeInForce = "GTC",
                ephemeralPubkey = "02" + new string('a', 64),
            });
        Assert.True(submitResp.IsSuccessStatusCode,
            $"submitOrder failed: {submitResp.StatusCode} {await submitResp.Content.ReadAsStringAsync()}");
        using var submitDoc = JsonDocument.Parse(await submitResp.Content.ReadAsStringAsync());

        // Capped-loss gate must NOT have rejected a 100-sat buy against a
        // 5000-sat reserve — otherwise the status would be a 400 BadRequest.
        // A GTC order fills entirely against the 1000-sat bootstrap sell.
        var status = submitDoc.RootElement.GetProperty("status").GetString();
        Assert.Equal("filled", status);

        var fills = submitDoc.RootElement.GetProperty("fills");
        Assert.True(fills.GetArrayLength() >= 1, "Expected at least one fill against the bootstrap maker.");
        var fill = fills[0];
        Assert.Equal(amountSats, fill.GetProperty("amountSats").GetInt64());

        // ── Assert reserves decremented by the fill size (capped-loss gate
        //    fired on the winning path). ─────────────────────────────────────
        var reservesAfter = await GetReservesAsync(yesMarketId);
        Assert.Equal(reservesBefore["Yes"] - amountSats, reservesAfter["Yes"]);

        // ── Assert the taker's position was accrued. The mock reads the
        //    pubkey from our NIP-98 token and writes a position keyed on the
        //    derived hex pubkey. ─────────────────────────────────────────────
        var positionsResp = await _http.GetAsync(
            $"http://localhost:{TestPorts.Server}/api/v1/users/{TestPubkeyHex}/positions");
        positionsResp.EnsureSuccessStatusCode();
        using var positionsDoc = JsonDocument.Parse(await positionsResp.Content.ReadAsStringAsync());
        var positions = positionsDoc.RootElement.GetProperty("positions");
        var yesPosition = positions.EnumerateArray()
            .FirstOrDefault(p => p.GetProperty("marketId").GetString() == yesMarketId
                && p.GetProperty("outcome").GetString() == "Yes");
        Assert.NotEqual(JsonValueKind.Undefined, yesPosition.ValueKind);
        Assert.Equal(positionBefore + amountSats, yesPosition.GetProperty("tokenAmount").GetInt64());
        Assert.Equal(positionBefore + amountSats, yesPosition.GetProperty("totalCostSats").GetInt64());
    }

    /// <summary>
    /// Read the user's current tokenAmount for a given market+outcome, or 0
    /// when no position exists yet. Used to assert position deltas across
    /// repeated test runs against a long-lived mock server.
    /// </summary>
    private async Task<long> GetPositionTokenAmountAsync(string pubkeyHex, string marketId, string outcome)
    {
        var resp = await _http.GetAsync(
            $"http://localhost:{TestPorts.Server}/api/v1/users/{pubkeyHex}/positions");
        resp.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
        var match = doc.RootElement.GetProperty("positions")
            .EnumerateArray()
            .FirstOrDefault(p => p.GetProperty("marketId").GetString() == marketId
                && p.GetProperty("outcome").GetString() == outcome);
        return match.ValueKind == JsonValueKind.Undefined
            ? 0L
            : match.GetProperty("tokenAmount").GetInt64();
    }

    /// <summary>
    /// POST a SubmitOrderRequest with a NIP-98 Authorization header minted
    /// from <paramref name="nsec"/>. Mirrors what
    /// <c>generateNip98Header()</c> produces on the frontend.
    /// </summary>
    private async Task<HttpResponseMessage> SubmitNip98OrderAsync(string url, string nsec, object body)
    {
        var authHeader = await MintNip98HeaderAsync(url, nsec, "POST");
        var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Headers.TryAddWithoutValidation("Authorization", authHeader);
        request.Content = JsonContent.Create(body);
        return await _http.SendAsync(request);
    }

    /// <summary>
    /// Produce a NIP-98 kind-27235 event via the <c>nak</c> CLI and encode it
    /// the way the frontend does — base64 of the JSON event. Using the CLI
    /// keeps the test dependency footprint small; we don't need a full
    /// secp256k1 library on the .NET side.
    /// </summary>
    private static async Task<string> MintNip98HeaderAsync(string url, string nsec, string method)
    {
        // Decode nsec → hex secret for `nak event --sec <hex>`.
        var secHex = await RunCaptureAsync("nak", new[] { "decode", nsec });
        secHex = secHex.Trim();

        var args = new[]
        {
            "event",
            "--sec", secHex,
            "--kind", "27235",
            "--content", "",
            "--tag", $"u={url}",
            "--tag", $"method={method}",
        };
        var eventJson = (await RunCaptureAsync("nak", args)).Trim();

        var token = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(eventJson));
        return $"Nostr {token}";
    }

    private static async Task<string> RunCaptureAsync(string file, string[] args)
    {
        var psi = new System.Diagnostics.ProcessStartInfo(file)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        using var proc = System.Diagnostics.Process.Start(psi)
            ?? throw new InvalidOperationException($"Failed to start {file}");
        var stdout = await proc.StandardOutput.ReadToEndAsync();
        var stderr = await proc.StandardError.ReadToEndAsync();
        await proc.WaitForExitAsync();
        if (proc.ExitCode != 0)
            throw new InvalidOperationException($"{file} {string.Join(' ', args)} failed: {stderr}");
        return stdout;
    }

    private async Task<Dictionary<string, long>> GetReservesAsync(string marketId)
    {
        var resp = await _http.GetAsync(
            $"http://localhost:{TestPorts.Server}/api/v1/{marketId}/funding-status");
        resp.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
        return doc.RootElement.GetProperty("reservedSatsByOutcome")
            .EnumerateObject()
            .ToDictionary(p => p.Name, p => p.Value.GetInt64());
    }

    /// <summary>
    /// Build a /v1/conditions response containing a single condition with our
    /// custom title so the frontend's detail page finds the market.
    /// </summary>
    private async Task<string> BuildSingleConditionJsonAsync(string conditionId)
    {
        var resp = await _http.GetAsync($"http://localhost:{TestPorts.Mint}/v1/conditions");
        resp.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
        var target = doc.RootElement.GetProperty("conditions")
            .EnumerateArray()
            .First(c => c.GetProperty("condition_id").GetString() == conditionId);

        var marketTitle = "CPMM E2E Flow Market";
        return JsonSerializer.Serialize(new
        {
            conditions = new object[]
            {
                new
                {
                    condition_id = conditionId,
                    tags = new[] { new[] { "description", marketTitle } },
                    threshold = target.GetProperty("threshold").GetInt32(),
                    announcements = target.GetProperty("announcements")
                        .EnumerateArray().Select(a => a.GetString()).ToArray(),
                    partitions = target.GetProperty("partitions")
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
    }

    private static async Task InterceptConditions(IPage page, string conditionJson)
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

    public async Task DisposeAsync()
    {
        _http?.Dispose();
        if (_browser is not null)
            await _browser.CloseAsync();
        _playwright?.Dispose();
    }
}
