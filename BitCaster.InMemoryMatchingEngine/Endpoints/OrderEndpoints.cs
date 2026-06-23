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
            if (marketId.Contains('|', StringComparison.Ordinal))
                return Results.BadRequest("Invalid market ID format. Expected: {conditionId}-{outcomeName}");
            if (req.AmountSubunits <= 0)
                return Results.BadRequest("AmountSubunits must be positive.");

            if (!IsValidCompressedPubkey(req.EphemeralPubkey))
                return Results.BadRequest("EphemeralPubkey must be a 66-char hex string (33-byte compressed secp256k1 pubkey).");

            if (string.IsNullOrWhiteSpace(req.OutcomeId))
                return Results.BadRequest("OutcomeId is required.");
            if (req.OutcomeId.Contains('|', StringComparison.Ordinal))
                return Results.BadRequest("OutcomeId must be a primitive outcome name.");

            var resolvedRoute = ResolveOrderRoute(marketId, req);
            if (resolvedRoute is null)
                return Results.BadRequest("OutcomeId must match the primitive outcome segment of marketId.");

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

            SubmitResult result;
            try
            {
                result = bookManager.SubmitOrder(
                    resolvedRoute.InternalMarketId,
                    resolvedRoute.InternalOutcomeSetId,
                    req.Side,
                    req.Price,
                    req.AmountSubunits,
                    userId: takerUserId,
                    timeInForce: req.TimeInForce,
                    ephemeralPubkey: req.EphemeralPubkey);
            }
            catch (ArgumentException ex)
            {
                return Results.BadRequest(ex.Message);
            }

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
            // a tradeId. Complementary matches (Buy vs Sell) map seller/buyer
            // from side; mint buy/buy matches (Buy vs Buy splitter) carry
            // explicit settlement metadata.
            await EmitTradeCreatedForFills(
                tradeHub, trades, result.Fills, req.Side, req.EphemeralPubkey, marketId);

            var unit = UnitForMarket(marketId);
            return Results.Ok(new SubmitOrderResponse(
                baseAsset: unit.BaseAsset,
                divisibility: unit.Divisibility,
                ephemeralPubkey: req.EphemeralPubkey,
                fills: result.Fills,
                orderId: result.OrderId,
                remainingAmountSubunits: result.RemainingAmountSubunits,
                status: result.Status));
        });

        app.MapPost("/api/v1/conditions/{conditionId}/orders/batch", async (
            string conditionId,
            BatchSubmitOrdersRequest? req,
            HttpRequest httpRequest,
            InMemoryOrderBookManager bookManager,
            InMemoryTradeRegistry trades,
            InMemoryPriceHistoryStore priceHistory,
            IHubContext<MarketHub, IMarketHubClient> marketHub,
            IHubContext<TradeHub, ITradeHubClient> tradeHub) =>
        {
            if (req?.Orders is null)
                return Results.BadRequest("Batch submit requires an orders array.");
            if (req.Orders.Count == 0)
                return Results.BadRequest("Batch submit requires at least one order.");

            var takerUserId = Nip98PubkeyExtractor.TryExtract(httpRequest) ?? "anonymous";
            var results = new List<BatchSubmitOrderResult>();
            var duplicateEphemerals = req.Orders
                .Where(item => !string.IsNullOrWhiteSpace(item.EphemeralPubkey))
                .GroupBy(item => item.EphemeralPubkey, StringComparer.Ordinal)
                .Where(group => group.Count() > 1)
                .Select(group => group.Key)
                .ToHashSet(StringComparer.Ordinal);
            foreach (var (item, index) in req.Orders.Select((item, index) => (item, index)))
            {
                var unit = UnitForMarket(item.MarketId);
                if (MarketParts.TryParse(item.MarketId) is not { } parts ||
                    !string.Equals(parts.ConditionId, conditionId, StringComparison.Ordinal))
                {
                    return Results.BadRequest($"Order at index {index} does not belong to route conditionId.");
                }
                if (duplicateEphemerals.Contains(item.EphemeralPubkey))
                {
                    results.Add(BatchSubmitFailure(
                        index,
                        item,
                        unit,
                        BatchSubmitOrderErrorCode.DuplicateEphemeralPubkey,
                        "Duplicate EphemeralPubkey in batch."));
                    continue;
                }
                if (item.AmountSubunits <= 0 || !IsValidCompressedPubkey(item.EphemeralPubkey))
                {
                    results.Add(BatchSubmitFailure(
                        index,
                        item,
                        unit,
                        item.AmountSubunits <= 0
                            ? BatchSubmitOrderErrorCode.InvalidAmount
                            : BatchSubmitOrderErrorCode.InvalidEphemeralPubkey,
                        item.AmountSubunits <= 0
                            ? "AmountSubunits must be positive."
                            : "EphemeralPubkey must be a 66-char hex string (33-byte compressed secp256k1 pubkey)."));
                    continue;
                }

                var single = new SubmitOrderRequest(
                    amountSubunits: item.AmountSubunits,
                    comment: null,
                    ephemeralPubkey: item.EphemeralPubkey,
                    outcomeId: item.OutcomeId,
                    price: item.Price,
                    side: item.Side,
                    timeInForce: item.TimeInForce ?? TimeInForce.GTC,
                    tokenSide: item.TokenSide);
                var resolvedRoute = ResolveOrderRoute(item.MarketId, single);
                if (resolvedRoute is null)
                {
                    results.Add(BatchSubmitFailure(
                        index,
                        item,
                        unit,
                        BatchSubmitOrderErrorCode.InvalidOutcome,
                        "OutcomeId must match the primitive outcome segment of marketId."));
                    continue;
                }

                InMemoryOrderBookManager.SubmitOrderOutcome outcome;
                try
                {
                    outcome = bookManager.SubmitOrderIdempotent(
                        resolvedRoute.InternalMarketId,
                        resolvedRoute.InternalOutcomeSetId,
                        item.Side,
                        item.Price,
                        item.AmountSubunits,
                        userId: takerUserId,
                        timeInForce: item.TimeInForce ?? TimeInForce.GTC,
                        ephemeralPubkey: item.EphemeralPubkey);
                }
                catch (ArgumentException ex)
                {
                    results.Add(BatchSubmitFailure(
                        index,
                        item,
                        unit,
                        ex.ParamName == "ephemeralPubkey"
                            ? BatchSubmitOrderErrorCode.DuplicateEphemeralPubkey
                            : BatchSubmitOrderErrorCode.BookRejected,
                        ex.Message));
                    continue;
                }

                var result = outcome.Result;
                if (!outcome.Replayed)
                {
                    await marketHub.Clients.Group(item.MarketId)
                        .OrderBookUpdated(bookManager.GetSnapshot(item.MarketId));
                    foreach (var fill in result.Fills)
                    {
                        priceHistory.RecordFill(item.MarketId, fill);
                    }

                    await EmitTradeCreatedForFills(
                        tradeHub,
                        trades,
                        result.Fills,
                        item.Side,
                        item.EphemeralPubkey,
                        item.MarketId);
                }

                results.Add(new BatchSubmitOrderResult(
                    baseAsset: unit.BaseAsset,
                    clientOrderId: item.ClientOrderId,
                    divisibility: unit.Divisibility,
                    ephemeralPubkey: item.EphemeralPubkey,
                    errorCode: null,
                    errorMessage: null,
                    fills: result.Fills,
                    marketId: item.MarketId,
                    orderId: result.OrderId,
                    remainingAmountSubunits: result.RemainingAmountSubunits,
                    requestIndex: index,
                    status: result.Status,
                    success: true));
            }

            return Results.Ok(new BatchSubmitOrdersResponse(results));
        });

        app.MapPost("/api/v1/conditions/{conditionId}/orders/cancel-batch", async (
            string conditionId,
            BatchCancelOrdersRequest? req,
            InMemoryOrderBookManager bookManager,
            IHubContext<MarketHub, IMarketHubClient> hubContext) =>
        {
            if (req?.OrderIds is null)
                return Results.BadRequest("Batch cancel requires an orderIds array.");
            if (req.OrderIds.Count == 0)
                return Results.BadRequest("Batch cancel requires at least one order id.");

            var canceled = new List<Guid>();
            var notCanceled = new Dictionary<string, BatchCancelOrderFailure>();
            var duplicateIds = req.OrderIds
                .GroupBy(orderId => orderId)
                .Where(group => group.Count() > 1)
                .Select(group => group.Key)
                .ToHashSet();
            foreach (var orderId in req.OrderIds)
            {
                if (duplicateIds.Contains(orderId))
                {
                    notCanceled.TryAdd(orderId.ToString(), new BatchCancelOrderFailure(
                        BatchCancelOrderErrorCode.DuplicateOrderId,
                        "Duplicate order id in batch."));
                    continue;
                }
                var status = bookManager.GetOrderStatus(orderId);
                if (status is null ||
                    string.IsNullOrWhiteSpace(status.MarketId) ||
                    MarketParts.TryParse(status.MarketId) is not { } statusParts ||
                    !string.Equals(statusParts.ConditionId, conditionId, StringComparison.Ordinal) ||
                    !bookManager.CancelOrder(orderId, out var storedMarketId) ||
                    storedMarketId is null ||
                    !string.Equals(storedMarketId, status.MarketId, StringComparison.Ordinal))
                {
                    notCanceled[orderId.ToString()] = new BatchCancelOrderFailure(
                        BatchCancelOrderErrorCode.NotFoundOrNotActiveOrNotAuthorized,
                        "Order not found, inactive, or not cancellable by this user.");
                    continue;
                }

                canceled.Add(orderId);
                await hubContext.Clients.Group(storedMarketId)
                    .OrderBookUpdated(bookManager.GetSnapshot(storedMarketId));
            }

            return Results.Ok(new BatchCancelOrdersResponse(canceled, notCanceled));
        });

        app.MapGet("/api/v1/{marketId}/orders/{orderId:guid}", (
            string marketId,
            Guid orderId,
            InMemoryOrderBookManager bookManager) =>
        {
            var status = bookManager.GetOrderStatus(orderId);
            if (status is null || !PublicRouteMatchesInternalMarket(marketId, status.MarketId))
                return Results.NotFound();

            var unit = UnitForMarket(marketId);
            return Results.Ok(new OrderStatusResponse(
                baseAsset: unit.BaseAsset,
                divisibility: unit.Divisibility,
                filledAmountSubunits: status.FilledAmountSubunits,
                fills: status.Fills,
                marketId: marketId,
                orderId: status.OrderId,
                remainingAmountSubunits: status.RemainingAmountSubunits,
                status: status.Status,
                tokenSide: PublicTokenSideForInternalMarket(marketId, status.MarketId)));
        });

        app.MapDelete("/api/v1/{marketId}/orders/{orderId:guid}", async (
            string marketId,
            Guid orderId,
            InMemoryOrderBookManager bookManager,
            IHubContext<MarketHub, IMarketHubClient> hubContext) =>
        {
            if (!bookManager.CancelOrder(orderId, out var storedMarketId) ||
                storedMarketId is null ||
                !PublicRouteMatchesInternalMarket(marketId, storedMarketId))
            {
                return Results.NotFound();
            }

            await hubContext.Clients.Group(marketId)
                .OrderBookUpdated(bookManager.GetSnapshot(marketId));

            return Results.Ok();
        });
    }

    private static BatchSubmitOrderResult BatchSubmitFailure(
        int requestIndex,
        BatchSubmitOrderRequestItem item,
        (BaseAsset BaseAsset, int Divisibility) unit,
        BatchSubmitOrderErrorCode errorCode,
        string errorMessage) =>
        new(
            baseAsset: unit.BaseAsset,
            clientOrderId: item.ClientOrderId,
            divisibility: unit.Divisibility,
            ephemeralPubkey: string.IsNullOrWhiteSpace(item.EphemeralPubkey) ? null : item.EphemeralPubkey,
            errorCode: errorCode,
            errorMessage: errorMessage,
            fills: [],
            marketId: item.MarketId,
            orderId: null,
            remainingAmountSubunits: 0,
            requestIndex: requestIndex,
            status: "rejected",
            success: false);

    private sealed record ResolvedOrderRoute(string InternalMarketId, string InternalOutcomeSetId);

    private static ResolvedOrderRoute? ResolveOrderRoute(string publicMarketId, SubmitOrderRequest req)
    {
        var parts = MarketParts.TryParse(publicMarketId);
        if (parts is null || !string.Equals(req.OutcomeId, parts.OutcomeSetId, StringComparison.Ordinal))
            return null;

        var internalOutcomeSetId = req.TokenSide == TokenSide.Complement
            ? ResolveComplement(parts.ConditionId, parts.OutcomeSetId)
            : parts.OutcomeSetId;
        if (string.IsNullOrWhiteSpace(internalOutcomeSetId))
            return null;

        return new ResolvedOrderRoute(
            $"{parts.ConditionId}-{internalOutcomeSetId}",
            internalOutcomeSetId);
    }

    private static bool PublicRouteMatchesInternalMarket(string publicMarketId, string internalMarketId)
    {
        if (string.Equals(publicMarketId, internalMarketId, StringComparison.Ordinal))
            return true;

        var publicParts = MarketParts.TryParse(publicMarketId);
        var internalParts = MarketParts.TryParse(internalMarketId);
        if (publicParts is null || internalParts is null ||
            !string.Equals(publicParts.ConditionId, internalParts.ConditionId, StringComparison.Ordinal))
            return false;

        return string.Equals(
            ResolveComplement(publicParts.ConditionId, publicParts.OutcomeSetId),
            internalParts.OutcomeSetId,
            StringComparison.Ordinal);
    }

    private static TokenSide PublicTokenSideForInternalMarket(string publicMarketId, string internalMarketId)
    {
        if (string.Equals(publicMarketId, internalMarketId, StringComparison.Ordinal))
            return TokenSide.Outcome;

        var publicParts = MarketParts.TryParse(publicMarketId);
        var internalParts = MarketParts.TryParse(internalMarketId);
        if (publicParts is null || internalParts is null ||
            !string.Equals(publicParts.ConditionId, internalParts.ConditionId, StringComparison.Ordinal))
            return TokenSide.Outcome;

        return string.Equals(
            ResolveComplement(publicParts.ConditionId, publicParts.OutcomeSetId),
            internalParts.OutcomeSetId,
            StringComparison.Ordinal)
            ? TokenSide.Complement
            : TokenSide.Outcome;
    }

    private static string? ResolveComplement(string conditionId, string primitiveOutcome)
    {
        var outcomes = MarketEndpoints.TryGetRegisteredOutcomes(conditionId);
        if (outcomes is null || outcomes.Count == 0)
        {
            return primitiveOutcome.Equals("YES", StringComparison.OrdinalIgnoreCase) ? "NO" :
                primitiveOutcome.Equals("NO", StringComparison.OrdinalIgnoreCase) ? "YES" :
                null;
        }

        var complement = outcomes
            .Where(outcome => !string.Equals(outcome, primitiveOutcome, StringComparison.Ordinal))
            .Order(StringComparer.Ordinal)
            .ToArray();
        return complement.Length == 0 ? null : string.Join('|', complement);
    }

    /// <summary>
    /// For each fill that carries a <c>tradeId</c>, register the trade in the
    /// in-memory registry and broadcast <c>TradeCreated</c> to both order
    /// groups. The maker's ephemeral pubkey is on the fill itself; the
    /// taker's is the request's own ephemeral pubkey. Complementary side
    /// mapping (Polymarket CTF V2 Complementary path — Buy vs Sell): a
    /// Sell-side taker is the outcome-token seller (Alice); a Buy-side taker
    /// is the buyer (Bob). Mint buy/buy matches treat the resting maker as
    /// seller and the incoming taker as buyer.
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

            var (sellerPubkey, buyerPubkey) = fill.Path == MatchPath.Mint
                ? (fill.MakerEphemeralPubkey, takerEphemeralPubkey)
                : takerSide == OrderSide.Sell
                    ? (takerEphemeralPubkey, fill.MakerEphemeralPubkey)
                    : (fill.MakerEphemeralPubkey, takerEphemeralPubkey);

            // Skip fills against bootstrap orders (no maker ephemeral pubkey).
            if (string.IsNullOrEmpty(sellerPubkey) || string.IsNullOrEmpty(buyerPubkey))
                continue;

            var settlementMarketId = ReadString(fill, "settlementMarketId") ?? marketId;
            var outcomeFaceAmountSubunits = ReadLong(fill, "outcomeFaceAmountSubunits");
            var quotePaymentSubunits = ReadLong(fill, "quotePaymentSubunits");
            var settlementKind = ReadString(fill, "settlementKind");
            var sellerKeepOutcomeSetId = ReadString(fill, "sellerKeepOutcomeSetId");
            var sellerLockOutcomeSetId = ReadString(fill, "sellerLockOutcomeSetId");
            var baseAsset = ReadString(fill, "baseAsset");
            var divisibility = ReadInt(fill, "divisibility");
            var record = trades.Register(
                tradeId.Value,
                sellerPubkey,
                buyerPubkey,
                settlementMarketId,
                fill.AmountSubunits,
                outcomeFaceAmountSubunits,
                quotePaymentSubunits,
                settlementKind,
                sellerKeepOutcomeSetId,
                sellerLockOutcomeSetId,
                baseAsset,
                divisibility,
                fill.TokenSide is null ? null : TokenSideWireValue(fill.TokenSide.Value));
            await tradeHub.Clients.Group(TradeHub.GroupName(tradeId.Value))
                .TradeCreated(tradeId.Value, record.SellerPubkey, record.BuyerPubkey,
                    record.SellerLocktime, record.BuyerLocktime, record.MarketId, record.FillAmountSubunits,
                    record.OutcomeFaceAmountSubunits, record.QuotePaymentSubunits, record.SettlementKind,
                    record.SellerKeepOutcomeSetId, record.SellerLockOutcomeSetId,
                    record.BaseAsset, record.Divisibility, record.TokenSide);
            await tradeHub.Clients.Groups([
                    TradeHub.OrderGroupName(fill.MakerOrderId),
                    TradeHub.OrderGroupName(fill.TakerOrderId)
                ])
                .TradeCreated(tradeId.Value, record.SellerPubkey, record.BuyerPubkey,
                    record.SellerLocktime, record.BuyerLocktime, record.MarketId, record.FillAmountSubunits,
                    record.OutcomeFaceAmountSubunits, record.QuotePaymentSubunits, record.SettlementKind,
                    record.SellerKeepOutcomeSetId, record.SellerLockOutcomeSetId,
                    record.BaseAsset, record.Divisibility, record.TokenSide);
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

    private static int? ReadInt(Fill fill, string key)
    {
        if (!fill.AdditionalProperties.TryGetValue(key, out var raw) || raw is null)
            return null;
        return raw switch
        {
            int value => value,
            long value when value is >= int.MinValue and <= int.MaxValue => (int)value,
            JsonElement je when je.ValueKind == JsonValueKind.Number && je.TryGetInt32(out var value) => value,
            _ => null
        };
    }

    private static (BaseAsset BaseAsset, int Divisibility) UnitForMarket(string marketId)
    {
        var conditionId = MarketParts.TryParse(marketId)?.ConditionId;
        var market = conditionId is null ? null : MarketEndpoints.TryGetMarket(conditionId);
        return (market?.BaseAsset ?? BaseAsset.Sat, market?.Divisibility is > 1 ? market.Divisibility : MarketEndpoints.DefaultMarketDivisibility);
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

    private static string TokenSideWireValue(TokenSide tokenSide) =>
        tokenSide switch
        {
            TokenSide.Outcome => "Outcome",
            TokenSide.Complement => "Complement",
            _ => "Outcome"
        };
}
