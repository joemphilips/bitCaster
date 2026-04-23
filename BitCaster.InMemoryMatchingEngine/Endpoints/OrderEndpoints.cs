using BitCaster.MatchingEngine.Contracts;
using BitCaster.MatchingEngine.Contracts.Hubs;
using BitCaster.InMemoryMatchingEngine.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace BitCaster.InMemoryMatchingEngine.Endpoints;

public static class OrderEndpoints
{
    /// <summary>
    /// Sentinel prefix for CPMM bootstrap orders. Mirrors the real engine's
    /// convention (<c>CpmmBootstrap.cs</c>). When a fill's maker order was
    /// posted under this prefix, the mock treats the fill as a CPMM trade
    /// and auto-settles against <see cref="InMemoryCpmmState"/>.
    /// </summary>
    private const string CpmmUserPrefix = "cpmm:";

    public static void MapOrderEndpoints(this WebApplication app)
    {
        app.MapPost("/api/v1/{marketId}/orders", async (
            string marketId,
            SubmitOrderRequest req,
            HttpRequest httpRequest,
            InMemoryOrderBookManager bookManager,
            InMemoryCpmmState cpmm,
            IHubContext<MarketHub, IMarketHubClient> hubContext) =>
        {
            if (req.AmountSats <= 0)
                return Results.BadRequest("AmountSats must be positive.");

            if (marketId.Contains('|'))
                return Results.BadRequest("Compound marketId (containing '|') is invalid.");

            if (!IsValidCompressedPubkey(req.EphemeralPubkey))
                return Results.BadRequest("EphemeralPubkey must be a 66-char hex string (33-byte compressed secp256k1 pubkey).");

            if (string.IsNullOrWhiteSpace(req.OutcomeId))
                return Results.BadRequest("OutcomeId is required.");

            // Identify the taker. The mock parses NIP-98 without verifying the
            // signature — sufficient for dev/E2E, unsafe in prod (enforced by
            // keeping this helper scoped to the mock project).
            var takerUserId = CpmmEndpoints.TryExtractPubkeyFromNip98(httpRequest) ?? "anonymous";

            var result = bookManager.SubmitOrder(
                marketId,
                req.OutcomeId,
                req.Side,
                req.Price,
                req.AmountSats,
                userId: takerUserId,
                timeInForce: req.TimeInForce,
                ephemeralPubkey: req.EphemeralPubkey);

            // Auto-settle any CPMM-maker fills: for each fill whose maker
            // order's UserId begins with "cpmm:", decrement the engine's CTF
            // reserve by the fill size (capped-loss gate) and accrue the
            // taker's position. Mirrors the real engine's
            // CpmmSettlementService.SettleAsync + AccruePositionsForFill.
            foreach (var fill in result.Fills)
            {
                var makerOwner = bookManager.GetOrderOwner(fill.MakerOrderId);
                if (makerOwner is null || !makerOwner.StartsWith(CpmmUserPrefix, StringComparison.Ordinal))
                    continue;

                // Reserve tokens == fill sats (mock uses 1:1 for simplicity; the
                // real engine derives token count from the CPMM curve).
                var tokenAmount = fill.AmountSats;
                var (outcomeResult, _) = cpmm.TryConsumeReserve(marketId, req.OutcomeId, tokenAmount);
                if (outcomeResult != InMemoryCpmmState.ReserveResult.Success)
                {
                    return Results.BadRequest(new
                    {
                        error = "InsufficientCpmmReserve",
                        detail = outcomeResult.ToString(),
                        marketId,
                        outcome = req.OutcomeId,
                        tokenAmount,
                    });
                }

                // Accrue the taker's position only — skip the sentinel maker
                // (tracking the engine as a counterparty is meaningless).
                if (!takerUserId.StartsWith(CpmmUserPrefix, StringComparison.Ordinal)
                    && takerUserId != "anonymous")
                {
                    cpmm.ApplyPositionDelta(
                        userPubkey: takerUserId,
                        marketId: marketId,
                        outcome: req.OutcomeId,
                        deltaTokens: tokenAmount,
                        deltaCostSats: fill.AmountSats);
                }
            }

            await hubContext.Clients.Group(marketId)
                .OrderBookUpdated(bookManager.GetSnapshot(marketId));

            return Results.Ok(new SubmitOrderResponse(
                ephemeralPubkey: req.EphemeralPubkey,
                fills: result.Fills,
                orderId: result.OrderId,
                remainingAmountSats: result.RemainingAmountSats,
                status: result.Status));
        });

        app.MapGet("/api/v1/{marketId}/orders/{orderId:guid}", (
            string marketId,
            Guid orderId,
            InMemoryOrderBookManager bookManager) =>
        {
            var status = bookManager.GetOrderStatus(orderId);
            if (status is null || status.MarketId != marketId)
                return Results.NotFound();

            return Results.Ok(new OrderStatusResponse(
                filledAmountSats: status.FilledAmountSats,
                fills: status.Fills,
                marketId: status.MarketId,
                orderId: status.OrderId,
                remainingAmountSats: status.RemainingAmountSats,
                status: status.Status));
        });

        app.MapDelete("/api/v1/orders/{id:guid}", async (
            Guid id,
            InMemoryOrderBookManager bookManager,
            IHubContext<MarketHub, IMarketHubClient> hubContext) =>
        {
            if (!bookManager.CancelOrder(id, out var marketId) || marketId is null)
                return Results.NotFound();

            await hubContext.Clients.Group(marketId)
                .OrderBookUpdated(bookManager.GetSnapshot(marketId));

            return Results.Ok();
        });
    }

    // A 33-byte compressed secp256k1 pubkey renders as 66 hex chars, starting
    // with 02 or 03. We're not verifying the point is on-curve here — the
    // mock engine is a byte relay, and the real engine can do full validation.
    private static bool IsValidCompressedPubkey(string? hex)
    {
        if (string.IsNullOrEmpty(hex) || hex.Length != 66) return false;
        if (hex[0] != '0' || (hex[1] != '2' && hex[1] != '3')) return false;
        for (var i = 0; i < hex.Length; i++)
        {
            var c = hex[i];
            var isHex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
            if (!isHex) return false;
        }
        return true;
    }

}
