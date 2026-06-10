using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Playwright;
using NBitcoin;

namespace BitCaster.E2ETest;

/// <summary>
/// Case A.6 from <c>docs/plans/E2E-Failure-Testing-Plan.md</c> (engine-side
/// catalog) — tab-close recovery.
///
/// <para>
/// Defends P03 (atomic-swap atomicity, expanded to "engine-as-relay")
/// and P07 (per-order ephemeral keypair reuse on retry). The user's tab
/// closes after a direct match has registered a Trade record; a fresh
/// browser context with the persisted <c>bitcaster-pending-trades</c>
/// localStorage is opened. The reopened context's swap-driver must:
/// </para>
///
/// <list type="number">
/// <item>resume from the persisted <c>pendingTrades[orderId]</c> entry
///       (no fresh ephemeral key issued — reuse within the same fill is
///       the protocol's design),</item>
/// <item>successfully <c>JoinTrade(tradeId)</c> against the engine's
///       TradeHub,</item>
/// <item>receive the engine's <c>TradeCreated</c> replay carrying the
///       same <c>buyerPubkey</c> as the persisted entry — proving the
///       engine and client agree on the per-order ephemeral pubkey
///       across the close/reopen boundary.</item>
/// </list>
///
/// <para>
/// Runs against the in-memory mock (Hubs/TradeHub.cs in
/// BitCaster.InMemoryMatchingEngine). The mock's TradeHub is byte-relay only:
/// it does not retain prior <c>SwapMessageReceived</c> payloads, so a recovery
/// test that drives all the way to <c>TradeStateChanged → Confirmed</c> is
/// structurally not achievable here. This test therefore narrows to the
/// recovery primitives the plan's A.6 row actually asserts.
/// </para>
///
/// <para>
/// The seller side is driven via REST from the test process (no second
/// browser) — its only role is to produce the matching fill the engine
/// uses to register the Trade record. The browser is reserved for the
/// recovering buyer, where the persistence + swap-driver invariants
/// actually live.
/// </para>
/// </summary>
[Collection(E2ECollections.LiveServiceMutation)] // Creates real orders/trades and observes shared SignalR state.
public class TabCloseRecoveryTests : IAsyncLifetime
{
    private const string TestNsec =
        "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
    private const string TestNostrPubkey =
        "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";
    private const string TestNcryptsec =
        "ncryptsec1qggxf7xvgcrpn0dwsy8uwxa5cv9vkts4khj8lmw7s5829066ehwzd4lu05g82psmatyqyyekwh4q3w5hsn5ldap9cf4ndhnrndessu938p32vshwt8dnmjlrle4nnuec4k4rhqhlumsednnapytahw07";
    private const string TestNcryptsecPassphrase = "test-passphrase";

    private IPlaywright? _playwright;
    private IBrowser? _browser;
    private HttpClient? _engineClient;

    public static IEnumerable<object[]> BrowserSignerModes()
    {
        yield return [BrowserNostrSignerMode.Nsec];
        yield return [BrowserNostrSignerMode.Ncryptsec];
        yield return [BrowserNostrSignerMode.Nip07];
    }

    public async Task InitializeAsync()
    {
        using var probe = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        await Task.WhenAll(
            TestHelpers.WaitForService(probe, $"{TestPorts.MintUrl}/v1/info", "Mint"),
            TestHelpers.WaitForService(probe, $"{TestPorts.ServerUrl}/health", "Matching Engine"),
            TestHelpers.WaitForService(probe, $"{TestPorts.FrontendUrl}", "Frontend"));

        _engineClient = new HttpClient
        {
            BaseAddress = new Uri($"{TestPorts.ServerUrl}"),
            Timeout = TimeSpan.FromSeconds(10),
        };

        _playwright = await Playwright.CreateAsync();
        _browser = await _playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
        {
            Headless = true,
        });
    }

    [Theory]
    [MemberData(nameof(BrowserSignerModes))]
    [Trait("Case", "A.6")]
    public async Task TabClose_RecoversPendingTradeAndRejoinsTradeHub(
        BrowserNostrSignerMode signerMode)
    {
        Assert.NotNull(_browser);
        Assert.NotNull(_engineClient);

        // -------- 1. Seed a fresh trade via REST -------------------------
        // The mock order endpoint does not require catalog registration.
        // Use a unique condition per theory row so prior rows/runs cannot
        // leave a resting order in the same in-memory book and contaminate the
        // expected maker/taker pubkeys.
        var conditionId = $"{Guid.NewGuid():N}{Guid.NewGuid():N}";
        const string outcome = "Yes";
        var marketId = $"{conditionId}-{outcome}";

        var seller = GenerateEphemeralKeyPair();
        var buyer = GenerateEphemeralKeyPair();

        // Resting Sell order — provides the maker side that the buyer's Buy
        // crosses. Mid-price 50; both orders match at 50.
        var sellerOrderId = await PostOrderAsync(marketId, outcome, "Sell", 50, 100, seller);

        // Crossing Buy from the buyer — produces a Complementary fill stamped with
        // a tradeId in the fill's AdditionalProperties dictionary, and the
        // mock registers a TradeRecord keyed on (sellerPubkey, buyerPubkey).
        var buyerOrderResp = await PostOrderAsyncRaw(marketId, outcome, "Buy", 50, 100, buyer);
        var tradeId = ExtractFirstTradeId(buyerOrderResp);
        Assert.True(tradeId.HasValue, $"Buyer order produced no fill with tradeId: {buyerOrderResp}");
        var buyerOrderId = ExtractOrderId(buyerOrderResp);

        // Cross-check the engine's recorded buyerPubkey against the one we
        // just registered, so the post-recovery assertion (step 6 below)
        // has a known-good baseline to compare against.
        Assert.Equal(buyer.Pubkey, ExtractTakerPubkey(buyerOrderResp));

        // -------- 2. Original buyer context — drives JoinTrade once ------
        var firstTradeCreated = await OpenContextAndCaptureTradeCreatedAsync(
            buyer, buyerOrderId, marketId, tradeId!.Value, signerMode, expectClose: true);

        // -------- 3. Persist & verify the recovery payload ---------------
        Assert.Equal(buyer.Pubkey, firstTradeCreated.BuyerPubkey);
        Assert.Equal(seller.Pubkey, firstTradeCreated.SellerPubkey);
        Assert.Equal(tradeId.Value.ToString(), firstTradeCreated.TradeId);

        // -------- 4. Reopen a fresh context with the same persisted state -
        // The wallet localStorage is identical (same nsec, same pendingTrades);
        // the in-memory `activeSwaps` store does NOT survive the close, so
        // the recovery is forced through the persisted-order → poller →
        // promote → joinTrade pipeline rather than any in-memory residue.
        var secondTradeCreated = await OpenContextAndCaptureTradeCreatedAsync(
            buyer, buyerOrderId, marketId, tradeId.Value, signerMode, expectClose: false);

        // -------- 5. Recovery assertions --------------------------------
        // P07 — same per-order ephemeral pubkey reused on the rejoin: the
        // engine's TradeRecord is immutable and the persisted pendingTrades
        // entry agrees with it.
        Assert.Equal(firstTradeCreated.TradeId, secondTradeCreated.TradeId);
        Assert.Equal(firstTradeCreated.BuyerPubkey, secondTradeCreated.BuyerPubkey);
        Assert.Equal(firstTradeCreated.SellerPubkey, secondTradeCreated.SellerPubkey);

        _ = sellerOrderId; // referenced only via the resting book; kept for diagnostics.
    }

    /// <summary>
    /// Open a fresh isolated browser context as the buyer, seed localStorage
    /// (settings nsec + wallet + pendingTrades), navigate to /markets so
    /// useTradeSettlement mounts, and capture the first <c>TradeCreated</c>
    /// SignalR frame the engine sends down the WebSocket. When
    /// <paramref name="expectClose"/> is true the context is closed before
    /// returning — the caller is exercising the tab-close recovery path on
    /// the next call.
    /// </summary>
    private async Task<TradeCreatedFrame> OpenContextAndCaptureTradeCreatedAsync(
        EphemeralKeyPair buyer,
        Guid buyerOrderId,
        string marketId,
        Guid tradeId,
        BrowserNostrSignerMode signerMode,
        bool expectClose)
    {
        Assert.NotNull(_browser);
        var context = await _browser!.NewContextAsync(new BrowserNewContextOptions
        {
            ServiceWorkers = ServiceWorkerPolicy.Block,
        });
        try
        {
            var page = await context.NewPageAsync();
            var consoleMessages = TestHelpers.AttachConsoleCapture(page);
            var sniffer = AttachTradeCreatedSniffer(page);

            await SeedBuyerLocalStorageAsync(page, buyer, buyerOrderId, marketId, signerMode);
            await NavigateToMarketsAsync(page);

            var received = await AwaitTradeCreatedAsync(
                sniffer, page, consoleMessages, tradeId);
            Assert.Equal(tradeId.ToString(), received.TradeId);
            return received;
        }
        finally
        {
            if (expectClose) await context.CloseAsync();
            else await context.DisposeAsync();
        }
    }

    /// <summary>
    /// Hook the SignalR WebSocket BEFORE navigation so we don't miss the
    /// <c>TradeCreated</c> invocation frame. SignalR's JSON protocol
    /// delimits messages with the ASCII Record-Separator (0x1e); we split
    /// on it and JSON-parse each segment looking for an invocation
    /// targeting <c>TradeCreated</c>.
    /// </summary>
    private static TradeCreatedSniffer AttachTradeCreatedSniffer(IPage page)
    {
        var tcs = new TaskCompletionSource<TradeCreatedFrame>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var frames = new System.Collections.Concurrent.ConcurrentQueue<string>();
        page.WebSocket += (_, ws) =>
        {
            if (!ws.Url.Contains("/hubs/trade")) return;
            ws.FrameReceived += (_, frame) =>
            {
                if (tcs.Task.IsCompleted || string.IsNullOrEmpty(frame.Text)) return;
                frames.Enqueue(frame.Text);
                var parsed = TryParseTradeCreated(frame.Text);
                if (parsed is not null) tcs.TrySetResult(parsed);
            };
            ws.FrameSent += (_, frame) =>
            {
                if (tcs.Task.IsCompleted || string.IsNullOrEmpty(frame.Text)) return;
                frames.Enqueue($"SENT: {frame.Text}");
            };
        };
        return new TradeCreatedSniffer(tcs, frames);
    }

    /// <summary>
    /// Navigate to <c>/markets</c> so AppRoutes mounts and
    /// useTradeSettlement wires up the trade-hub connection. The
    /// pendingTrades poller then re-promotes the persisted order, which
    /// kicks <c>JoinTrade</c>.
    /// </summary>
    private static async Task NavigateToMarketsAsync(IPage page) =>
        await page.GotoAsync(
            $"{TestPorts.FrontendUrl}/markets",
            new PageGotoOptions
            {
                WaitUntil = WaitUntilState.NetworkIdle,
                Timeout = 30_000,
            });

    /// <summary>
    /// Await the first <c>TradeCreated</c> frame on the sniffer with a
    /// 25 s budget. On timeout, dump the WebSocket frames so a stalled
    /// recovery is easy to triage (no frames = SignalR never connected;
    /// SENT but no recv = engine rejected; etc.).
    /// </summary>
    private static async Task<TradeCreatedFrame> AwaitTradeCreatedAsync(
        TradeCreatedSniffer sniffer,
        IPage page,
        IReadOnlyList<string> consoleMessages,
        Guid tradeId)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        cts.Token.Register(() => sniffer.Tcs.TrySetCanceled(cts.Token));
        try
        {
            return await sniffer.Tcs.Task;
        }
        catch (OperationCanceledException)
        {
            var dump = string.Join("\n", sniffer.Frames.Take(30));
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page, consoleMessages,
                $"Did not observe TradeCreated for tradeId={tradeId} within 25s. " +
                $"WS frames captured ({sniffer.Frames.Count}):\n{dump}");
        }
    }

    private sealed record TradeCreatedSniffer(
        TaskCompletionSource<TradeCreatedFrame> Tcs,
        System.Collections.Concurrent.ConcurrentQueue<string> Frames);

    /// <summary>
    /// Seed the three persisted stores the swap-driver depends on for
    /// recovery. Mirrors what the app would have written during the
    /// pre-close session.
    /// </summary>
    private static async Task SeedBuyerLocalStorageAsync(
        IPage page,
        EphemeralKeyPair buyer,
        Guid buyerOrderId,
        string marketId,
        BrowserNostrSignerMode signerMode)
    {
        if (signerMode == BrowserNostrSignerMode.Nip07)
            await InstallFakeNip07SignerAsync(page);

        // We must be on the same origin as Vite before localStorage writes
        // take effect. /setup is a stable wizard route that doesn't pull
        // the trade-hub stack on its own.
        await page.GotoAsync(
            $"{TestPorts.FrontendUrl}/setup",
            new PageGotoOptions { WaitUntil = WaitUntilState.DOMContentLoaded });

        var signerSettings = signerMode switch
        {
            BrowserNostrSignerMode.Nsec => $"""
                    nostrSignerMode: 'nsec',
                    nsecSecret: '{TestNsec}',
                """,
            BrowserNostrSignerMode.Ncryptsec => """
                    nostrSignerMode: 'none',
                    nsecSecret: null,
                """,
            BrowserNostrSignerMode.Nip07 => """
                    nostrSignerMode: 'nip07',
                    nsecSecret: null,
                """,
            _ => throw new ArgumentOutOfRangeException(nameof(signerMode), signerMode, null),
        };
        var mintUrl = $"{TestPorts.MintUrl}";
        var mnemonic = TestMnemonics.Get();

        await page.EvaluateAsync($@"
            localStorage.setItem('bitcaster-settings', JSON.stringify({{
                state: {{
                    activeCategory: 'nostr',
                    baseCurrency: 'BTC',
                    language: 'en',
                    theme: 'dark',
{signerSettings}
                    nostrProfile: null,
                    nostrProfileFetchStatus: 'idle',
                    relays: []
                }},
                version: 0
            }}));
            localStorage.setItem('bitcaster-wallet', JSON.stringify({{
                state: {{
                    mnemonic: '{mnemonic}',
                    setupComplete: true,
                    mints: [{{ url: '{mintUrl}' }}],
                    activeMintUrl: '{mintUrl}',
                    keysetCounters: {{}}
                }},
                version: 0
            }}));
            localStorage.setItem('bitcaster-pending-trades', JSON.stringify({{
                state: {{
                    byOrderId: {{
                        '{buyerOrderId}': {{
                            orderId: '{buyerOrderId}',
                            marketId: '{marketId}',
                            ephemeralPubkey: '{buyer.Pubkey}',
                            ephemeralPrivkey: '{buyer.Privkey}',
                            submittedAt: {DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}
                        }}
                    }}
                }},
                version: 0
            }}));
        ");

        if (signerMode == BrowserNostrSignerMode.Ncryptsec)
            await ConnectNcryptsecThroughSettingsAsync(page);
    }

    private static async Task InstallFakeNip07SignerAsync(IPage page)
    {
        await page.AddInitScriptAsync($$"""
            Object.defineProperty(window, 'nostr', {
              configurable: true,
              value: {
                async getPublicKey() {
                  return '{{TestNostrPubkey}}';
                },
                async signEvent(event) {
                  return {
                    ...event,
                    pubkey: '{{TestNostrPubkey}}',
                    id: '0'.repeat(64),
                    sig: '0'.repeat(128),
                  };
                },
              },
            });
        """);
    }

    private static async Task ConnectNcryptsecThroughSettingsAsync(IPage page)
    {
        await page.GotoAsync(
            $"{TestPorts.FrontendUrl}/settings?category=nostr",
            new PageGotoOptions
            {
                WaitUntil = WaitUntilState.NetworkIdle,
                Timeout = 30_000,
            });

        await page.GetByRole(AriaRole.Button, new() { Name = "Connect with Private Key" })
            .ClickAsync();
        await page.GetByPlaceholder("nsec1... or ncryptsec1...").FillAsync(TestNcryptsec);
        await page.GetByPlaceholder("Decrypt passphrase (NIP-49)")
            .FillAsync(TestNcryptsecPassphrase);
        await page.GetByRole(AriaRole.Button, new() { Name = "Decrypt & Connect" })
            .ClickAsync();

        await page.WaitForFunctionAsync(
            """
            () => {
              const raw = localStorage.getItem('bitcaster-settings');
              if (!raw) return false;
              const parsed = JSON.parse(raw);
              return parsed.state?.nostrSignerMode === 'nsec'
                && typeof parsed.state?.nsecSecret === 'string'
                && parsed.state.nsecSecret.startsWith('nsec1');
            }
            """,
            null,
            new PageWaitForFunctionOptions { Timeout = 10_000 });
    }

    /// <summary>
    /// SignalR JSON protocol: messages are delimited with ASCII Record-Separator
    /// 0x1e. Each segment is a JSON object; <c>{"type":1,...}</c> is an
    /// invocation. Returns the first <c>TradeCreated</c> argument tuple, or
    /// null if the frame doesn't carry one.
    /// </summary>
    private static TradeCreatedFrame? TryParseTradeCreated(string frameText)
    {
        if (string.IsNullOrEmpty(frameText)) return null;
        foreach (var segment in frameText.Split(''))
        {
            if (string.IsNullOrWhiteSpace(segment)) continue;
            try
            {
                using var doc = JsonDocument.Parse(segment);
                if (!doc.RootElement.TryGetProperty("type", out var typeProp)) continue;
                if (typeProp.GetInt32() != 1) continue;
                if (!doc.RootElement.TryGetProperty("target", out var target)) continue;
                if (target.GetString() != "TradeCreated") continue;
                if (!doc.RootElement.TryGetProperty("arguments", out var args)) continue;
                if (args.GetArrayLength() < 3) continue;
                return new TradeCreatedFrame(
                    TradeId: args[0].GetString() ?? string.Empty,
                    SellerPubkey: args[1].GetString() ?? string.Empty,
                    BuyerPubkey: args[2].GetString() ?? string.Empty);
            }
            catch (JsonException)
            {
                // Handshake/negotiation frames are not JSON; ignore.
            }
        }
        return null;
    }

    private sealed record TradeCreatedFrame(string TradeId, string SellerPubkey, string BuyerPubkey);

    // -----------------------------------------------------------------------
    // REST helpers
    // -----------------------------------------------------------------------

    private async Task<Guid> PostOrderAsync(
        string marketId, string outcome, string side, int price, long amountSats,
        EphemeralKeyPair signer)
    {
        var body = await PostOrderAsyncRaw(marketId, outcome, side, price, amountSats, signer);
        return ExtractOrderId(body);
    }

    private async Task<JsonElement> PostOrderAsyncRaw(
        string marketId, string outcome, string side, int price, long amountSats,
        EphemeralKeyPair signer)
    {
        Assert.NotNull(_engineClient);
        using var req = new HttpRequestMessage(
            HttpMethod.Post, $"/api/v1/{marketId}/orders");
        req.Headers.TryAddWithoutValidation(
            "Authorization", $"Nostr {BuildMockNip98Token(signer.Pubkey)}");
        req.Content = JsonContent.Create(new
        {
            outcomeId = outcome,
            side,
            price,
            amountSats,
            timeInForce = "GTC",
            ephemeralPubkey = signer.Pubkey,
        });
        var resp = await _engineClient!.SendAsync(req);
        var raw = await resp.Content.ReadAsStringAsync();
        if (!resp.IsSuccessStatusCode)
            throw new InvalidOperationException($"POST orders failed: {(int)resp.StatusCode} {raw}");
        return JsonDocument.Parse(raw).RootElement.Clone();
    }

    /// <summary>
    /// Build the base64-encoded JSON envelope the mock's
    /// <c>TryExtractPubkeyFromNip98</c> parses. Production NIP-98 tokens
    /// include a schnorr signature, but the mock parses the JSON for the
    /// pubkey only — keep the test surface minimal.
    /// </summary>
    private static string BuildMockNip98Token(string pubkey)
    {
        var json = JsonSerializer.Serialize(new
        {
            id = "00".PadLeft(64, '0'),
            pubkey,
            created_at = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            kind = 27235,
            tags = new object[0],
            content = string.Empty,
            sig = "00".PadLeft(128, '0'),
        });
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(json));
    }

    private static Guid ExtractOrderId(JsonElement root) =>
        Guid.Parse(root.GetProperty("orderId").GetString()!);

    private static Guid? ExtractFirstTradeId(JsonElement root)
    {
        if (!root.TryGetProperty("fills", out var fills)) return null;
        foreach (var fill in fills.EnumerateArray())
        {
            if (fill.TryGetProperty("tradeId", out var tid)
                && tid.ValueKind == JsonValueKind.String
                && Guid.TryParse(tid.GetString(), out var parsed))
            {
                return parsed;
            }
        }
        return null;
    }

    private static string ExtractTakerPubkey(JsonElement root) =>
        root.GetProperty("ephemeralPubkey").GetString() ?? string.Empty;

    // -----------------------------------------------------------------------
    // Ephemeral keypair generation (matches src/lib/ephemeral-key.ts)
    // -----------------------------------------------------------------------

    private sealed record EphemeralKeyPair(string Privkey, string Pubkey);

    public enum BrowserNostrSignerMode
    {
        Nsec,
        Ncryptsec,
        Nip07,
    }

    private static EphemeralKeyPair GenerateEphemeralKeyPair()
    {
        var key = new Key();
        var pub = key.PubKey.Compress(); // 33-byte compressed
        return new EphemeralKeyPair(
            Privkey: Convert.ToHexStringLower(key.ToBytes()),
            Pubkey: Convert.ToHexStringLower(pub.ToBytes()));
    }

    public async Task DisposeAsync()
    {
        _engineClient?.Dispose();
        if (_browser is not null)
            await _browser.CloseAsync();
        _playwright?.Dispose();
    }
}
