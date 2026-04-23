using System.Text.Json;
using BitCaster.MatchingEngine.Contracts;
using BitCaster.MatchingEngine.Contracts.Dev;
using BitCaster.MatchingEngine.Contracts.Hubs;
using BitCaster.InMemoryMatchingEngine.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace BitCaster.InMemoryMatchingEngine.Endpoints;

/// <summary>
/// Endpoints that surface the mock's <see cref="InMemoryCpmmState"/> to
/// frontend clients and Phase 1G E2E tests. Mirrors the subset of the real
/// engine's CPMM API that the PWA actually consumes today — engine pubkey,
/// funding-status, user positions, and a dev-only simulate-funding flow.
///
/// <para>
/// <b>MOCK ONLY — never reference from the production ApiService.</b> The
/// positions handler skips the path-pubkey vs NIP-98 claim match that the
/// real engine enforces (P03), and the NIP-98 helper below only parses the
/// token, never verifies the Schnorr signature (P04). Both shortcuts are
/// acceptable because <c>BitCaster.InMemoryMatchingEngine</c> is dev/E2E
/// scaffolding that is never deployed to staging or prod — ApiService runs
/// a real <c>Nip98AuthenticationHandler</c> with full verification.
/// </para>
/// </summary>
public static class CpmmEndpoints
{
    public static void MapCpmmEndpoints(this WebApplication app)
    {
        // ------------------------------------------------------------------
        // GET /api/v1/engine/pubkey
        //   Public. Returns the engine's deterministic fake pubkey so the
        //   frontend can P2PK-lock Cashu proofs on CPMM-bound orders.
        // ------------------------------------------------------------------
        app.MapGet("/api/v1/engine/pubkey", () =>
            Results.Ok(new EngineInfoResponse(pubkey: InMemoryCpmmState.EnginePubkey)));

        // ------------------------------------------------------------------
        // GET /api/v1/{marketId}/funding-status
        //   Public. Returns AwaitingFunding / Active / Frozen + per-outcome
        //   reserves. The frontend polls this to decide whether the trade UI
        //   is enabled or if "Awaiting liquidity" banner should be shown.
        // ------------------------------------------------------------------
        app.MapGet("/api/v1/{marketId}/funding-status", (
            string marketId,
            InMemoryCpmmState cpmm) =>
        {
            var pool = cpmm.TryGetPool(marketId);
            if (pool is null) return Results.NotFound($"No CPMM pool for market {marketId}");

            var reserves = new Dictionary<string, long>(pool.Reserves);
            var response = new FundingStatusResponse(
                declaredSats: pool.DeclaredSats,
                lastUpdatedAt: pool.LastUpdatedAt,
                marketId: pool.MarketId,
                reservedSatsByOutcome: reserves,
                status: MapStatus(pool.Status));
            return Results.Ok(response);
        });

        // ------------------------------------------------------------------
        // GET /api/v1/users/{pubkey}/positions
        //   Returns every (marketId, outcome) the caller holds tokens in.
        //   The real engine enforces `authedPubkey == pathPubkey` via NIP-98;
        //   the mock has no auth stack, so we return positions for the path
        //   pubkey directly. Safe because the mock is dev-only — this
        //   endpoint is never compiled into the production ApiService.
        // ------------------------------------------------------------------
        app.MapGet("/api/v1/users/{pubkey}/positions", (
            string pubkey,
            InMemoryCpmmState cpmm) =>
        {
            if (!IsValidHexPubkey(pubkey))
                return Results.BadRequest("Invalid pubkey format (expected 64-char hex).");

            var records = cpmm.GetPositions(pubkey);
            var dtos = records
                .Select(r => new PositionDto(
                    lastUpdated: r.LastUpdated,
                    marketId: r.MarketId,
                    outcome: r.Outcome,
                    tokenAmount: r.TokenAmount,
                    totalCostSats: r.TotalCostSats))
                .ToList();
            return Results.Ok(new PositionsResponse(positions: dtos, userPubkey: pubkey));
        });

        // ------------------------------------------------------------------
        // POST /api/v1/_dev/markets/{marketId}/simulate-cpmm-funding
        //   Dev-only. Flips the pool to Active with explicit reserves and
        //   optionally posts bootstrap maker orders under the
        //   `cpmm:{marketId}` sentinel user id. Compresses the real engine's
        //   LN-deposit → mint-swap → reserve-seeding flow into a single call
        //   so the E2E can reach a tradeable state in O(1).
        // ------------------------------------------------------------------
        app.MapPost("/api/v1/_dev/markets/{marketId}/simulate-cpmm-funding", async (
            string marketId,
            SimulateCpmmFundingRequest req,
            InMemoryCpmmState cpmm,
            InMemoryOrderBookManager bookManager,
            IHubContext<MarketHub, IMarketHubClient> hubContext) =>
        {
            if (req.ReservedSatsByOutcome is null || req.ReservedSatsByOutcome.Count == 0)
                return Results.BadRequest("reservedSatsByOutcome must contain at least one outcome.");

            foreach (var (outcome, amount) in req.ReservedSatsByOutcome)
            {
                if (amount <= 0)
                    return Results.BadRequest($"Reserve for outcome '{outcome}' must be positive.");
            }

            cpmm.MarkActive(marketId, req.DeclaredSats, req.ReservedSatsByOutcome);

            var bootstrapIds = new List<Guid>();
            var affectedMarkets = new HashSet<string>();
            if (req.BootstrapOrders is not null)
            {
                foreach (var bo in req.BootstrapOrders)
                {
                    if (bo.Price < 1 || bo.Price > 99)
                        return Results.BadRequest($"Bootstrap order price {bo.Price} out of [1,99].");
                    if (bo.AmountSats <= 0)
                        return Results.BadRequest("Bootstrap order amountSats must be positive.");

                    var bootstrapMarketId = $"{marketId.Split('-', 2)[0]}-{bo.Outcome}";
                    var side = bo.Side == CpmmBootstrapOrderSide.Buy ? OrderSide.Buy : OrderSide.Sell;
                    var result = bookManager.SubmitOrder(
                        bootstrapMarketId,
                        bo.Outcome,
                        side,
                        bo.Price,
                        bo.AmountSats,
                        userId: $"cpmm:{marketId}",
                        timeInForce: TimeInForce.GTC,
                        ephemeralPubkey: null);
                    bootstrapIds.Add(result.OrderId);
                    affectedMarkets.Add(bootstrapMarketId);
                }
            }

            // Push a fresh snapshot to each affected market's SignalR group so
            // already-subscribed clients see the bootstrap orderbook without
            // reloading.
            foreach (var m in affectedMarkets)
            {
                await hubContext.Clients.Group(m)
                    .OrderBookUpdated(bookManager.GetSnapshot(m));
            }

            var response = new SimulateCpmmFundingResponse(
                bootstrapOrderIds: bootstrapIds,
                declaredSats: req.DeclaredSats,
                marketId: marketId,
                reservedSatsByOutcome: new Dictionary<string, long>(req.ReservedSatsByOutcome),
                status: SimulateCpmmFundingResponseStatus.Active);
            return Results.Ok(response);
        });
    }

    private static FundingStatusResponseStatus MapStatus(InMemoryCpmmState.PoolStatus s) => s switch
    {
        InMemoryCpmmState.PoolStatus.Active => FundingStatusResponseStatus.Active,
        InMemoryCpmmState.PoolStatus.Frozen => FundingStatusResponseStatus.Frozen,
        _ => FundingStatusResponseStatus.AwaitingFunding,
    };

    private static bool IsValidHexPubkey(string? hex)
    {
        if (string.IsNullOrEmpty(hex) || hex.Length != 64) return false;
        for (var i = 0; i < hex.Length; i++)
        {
            var c = hex[i];
            var isHex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
            if (!isHex) return false;
        }
        return true;
    }

    /// <summary>
    /// Extract the caller's pubkey from a NIP-98 <c>Authorization: Nostr &lt;base64&gt;</c>
    /// header without verifying the Schnorr signature. Safe for the mock
    /// because the mock is never production — but this helper is the reason
    /// it must NOT be compiled into the real ApiService. Kept inline so the
    /// mock has no NIP-98 auth package dependency.
    /// </summary>
    internal static string? TryExtractPubkeyFromNip98(HttpRequest request)
    {
        if (!request.Headers.TryGetValue("Authorization", out var values)) return null;
        var raw = values.ToString();
        if (string.IsNullOrEmpty(raw)) return null;
        const string scheme = "Nostr ";
        if (!raw.StartsWith(scheme, StringComparison.OrdinalIgnoreCase)) return null;
        var token = raw[scheme.Length..].Trim();
        try
        {
            var bytes = Convert.FromBase64String(token);
            using var doc = JsonDocument.Parse(bytes);
            if (doc.RootElement.TryGetProperty("pubkey", out var pk))
                return pk.GetString();
        }
        catch
        {
            // malformed token → treat as anonymous
        }
        return null;
    }
}
