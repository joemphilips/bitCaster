using System.Text.Json;
using BitCaster.MatchingEngine.Contracts;
using BitCaster.MatchingEngine.Contracts.Hubs;
using BitCaster.InMemoryMatchingEngine.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace BitCaster.InMemoryMatchingEngine.Endpoints;

public static class OrderEndpoints
{
    public static void MapOrderEndpoints(this WebApplication app)
    {
        app.MapPost("/api/v1/{marketId}/orders", async (
            string marketId,
            SubmitOrderRequest req,
            HttpRequest httpRequest,
            InMemoryOrderBookManager bookManager,
            InMemoryTradeRegistry trades,
            InMemoryPriceHistoryStore priceHistory,
            InMemoryCommentStore comments,
            IHubContext<MarketHub, IMarketHubClient> marketHub,
            IHubContext<TradeHub, ITradeHubClient> tradeHub) =>
        {
            if (req.AmountSats <= 0)
                return Results.BadRequest("AmountSats must be positive.");

            if (!IsValidCompressedPubkey(req.EphemeralPubkey))
                return Results.BadRequest("EphemeralPubkey must be a 66-char hex string (33-byte compressed secp256k1 pubkey).");

            if (string.IsNullOrWhiteSpace(req.OutcomeId))
                return Results.BadRequest("OutcomeId is required.");

            // Identify the taker. The mock parses NIP-98 without verifying the
            // signature — sufficient for dev/E2E, unsafe in prod (enforced by
            // keeping this helper scoped to the mock project).
            var takerUserId = Nip98PubkeyExtractor.TryExtract(httpRequest) ?? "anonymous";
            if (req.Comment is not null)
            {
                if (req.Comment.Kind != NostrKind1EventKind._1)
                    return Results.BadRequest("Comment event must be kind 1.");
                if (!string.Equals(req.Comment.Pubkey, takerUserId, StringComparison.Ordinal))
                    return Results.BadRequest("Comment pubkey must match the authenticated NIP-98 pubkey.");
                if (req.Comment.Content.Length > 280)
                    return Results.BadRequest("Comment content must be at most 280 characters.");
            }

            var result = bookManager.SubmitOrder(
                marketId,
                req.OutcomeId,
                req.Side,
                req.Price,
                req.AmountSats,
                userId: takerUserId,
                timeInForce: req.TimeInForce,
                ephemeralPubkey: req.EphemeralPubkey);

            await marketHub.Clients.Group(marketId)
                .OrderBookUpdated(bookManager.GetSnapshot(marketId));

            foreach (var fill in result.Fills)
            {
                priceHistory.RecordFill(marketId, fill);
                if (MarketParts.TryParse(marketId) is { } parts)
                    comments.RecordFill(parts.ConditionId, fill);
            }

            if (req.Comment is not null &&
                MarketParts.TryParse(marketId) is { } commentParts)
            {
                comments.RecordComment(commentParts.ConditionId, result.OrderId, req.Comment);
            }

            // Register trades + replay TradeCreated for any fill that carries
            // a tradeId. Direct matches map seller/buyer from side; binary
            // complementary buy/buy matches carry explicit settlement metadata.
            await EmitTradeCreatedForFills(
                tradeHub, trades, result.Fills, req.Side, req.EphemeralPubkey, marketId);

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

        app.MapDelete("/api/v1/{marketId}/orders/{orderId:guid}", async (
            string marketId,
            Guid orderId,
            InMemoryOrderBookManager bookManager,
            IHubContext<MarketHub, IMarketHubClient> hubContext) =>
        {
            if (!bookManager.CancelOrder(orderId, out var storedMarketId) ||
                storedMarketId is null ||
                storedMarketId != marketId)
            {
                return Results.NotFound();
            }

            await hubContext.Clients.Group(marketId)
                .OrderBookUpdated(bookManager.GetSnapshot(marketId));

            return Results.Ok();
        });
    }

    /// <summary>
    /// For each fill that carries a <c>tradeId</c>, register the trade in the
    /// in-memory registry and broadcast <c>TradeCreated</c> to both order
    /// groups. The maker's ephemeral pubkey is on the fill itself; the
    /// taker's is the request's own ephemeral pubkey. Direct side mapping: a
    /// Sell-side taker is the outcome-token seller (Alice); a Buy-side taker
    /// is the buyer (Bob). Complementary buy/buy matches treat the resting
    /// maker as seller and the incoming taker as buyer.
    /// </summary>
    private static async Task EmitTradeCreatedForFills(
        IHubContext<TradeHub, ITradeHubClient> tradeHub,
        InMemoryTradeRegistry trades,
        IEnumerable<Fill> fills,
        OrderSide takerSide,
        string takerEphemeralPubkey,
        string marketId)
    {
        foreach (var fill in fills)
        {
            var tradeId = TryReadTradeId(fill);
            if (tradeId is null) continue;

            var (sellerPubkey, buyerPubkey) = fill.Path == MatchPath.Complementary
                ? (fill.MakerEphemeralPubkey, takerEphemeralPubkey)
                : takerSide == OrderSide.Sell
                    ? (takerEphemeralPubkey, fill.MakerEphemeralPubkey)
                    : (fill.MakerEphemeralPubkey, takerEphemeralPubkey);

            // Skip fills against bootstrap orders (no maker ephemeral pubkey).
            if (string.IsNullOrEmpty(sellerPubkey) || string.IsNullOrEmpty(buyerPubkey))
                continue;

            var settlementMarketId = ReadString(fill, "settlementMarketId") ?? marketId;
            var outcomeFaceAmountSats = ReadLong(fill, "outcomeFaceAmountSats");
            var quotePaymentSats = ReadLong(fill, "quotePaymentSats");
            var settlementKind = ReadString(fill, "settlementKind");
            var sellerKeepOutcomeSetId = ReadString(fill, "sellerKeepOutcomeSetId");
            var sellerLockOutcomeSetId = ReadString(fill, "sellerLockOutcomeSetId");
            var record = trades.Register(
                tradeId.Value,
                sellerPubkey,
                buyerPubkey,
                settlementMarketId,
                fill.AmountSats,
                outcomeFaceAmountSats,
                quotePaymentSats,
                settlementKind,
                sellerKeepOutcomeSetId,
                sellerLockOutcomeSetId);
            await tradeHub.Clients.Group(TradeHub.GroupName(tradeId.Value))
                .TradeCreated(tradeId.Value, record.SellerPubkey, record.BuyerPubkey,
                    record.SellerLocktime, record.BuyerLocktime, record.MarketId, record.FillAmountSats,
                    record.OutcomeFaceAmountSats, record.QuotePaymentSats, record.SettlementKind,
                    record.SellerKeepOutcomeSetId, record.SellerLockOutcomeSetId);
            await tradeHub.Clients.Groups([
                    TradeHub.OrderGroupName(fill.MakerOrderId),
                    TradeHub.OrderGroupName(fill.TakerOrderId)
                ])
                .TradeCreated(tradeId.Value, record.SellerPubkey, record.BuyerPubkey,
                    record.SellerLocktime, record.BuyerLocktime, record.MarketId, record.FillAmountSats,
                    record.OutcomeFaceAmountSats, record.QuotePaymentSats, record.SettlementKind,
                    record.SellerKeepOutcomeSetId, record.SellerLockOutcomeSetId);
        }
    }

    private static string? ReadString(Fill fill, string key)
    {
        if (!fill.AdditionalProperties.TryGetValue(key, out var raw) || raw is null)
            return null;
        return raw switch
        {
            string value => value,
            JsonElement je when je.ValueKind == JsonValueKind.String => je.GetString(),
            _ => null
        };
    }

    private static long? ReadLong(Fill fill, string key)
    {
        if (!fill.AdditionalProperties.TryGetValue(key, out var raw) || raw is null)
            return null;
        return raw switch
        {
            long value => value,
            int value => value,
            JsonElement je when je.ValueKind == JsonValueKind.Number && je.TryGetInt64(out var value) => value,
            _ => null
        };
    }

    private static Guid? TryReadTradeId(Fill fill)
    {
        if (fill.TradeId is { } typed) return typed;
        if (!fill.AdditionalProperties.TryGetValue("tradeId", out var raw) || raw is null)
            return null;
        return raw switch
        {
            Guid g => g,
            string s when Guid.TryParse(s, out var parsed) => parsed,
            JsonElement je when je.ValueKind == JsonValueKind.String
                                && Guid.TryParse(je.GetString(), out var p) => p,
            _ => null,
        };
    }

    // A 33-byte compressed secp256k1 pubkey renders as 66 hex chars, starting
    // with 02 or 03. We're not verifying the point is on-curve here because
    // the mock engine is only a byte relay.
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
