using BitCaster.MatchingEngine.Contracts;
using BitCaster.MatchingEngine.Contracts.Domain;
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
            InMemoryOrderBookManager bookManager,
            IHubContext<MarketHub, IMarketHubClient> hubContext) =>
        {
            if (req.AmountSats <= 0)
                return Results.BadRequest("AmountSats must be positive.");

            if (marketId.Contains('|'))
                return Results.BadRequest("Compound marketId (containing '|') is invalid.");

            if (!IsValidCompressedPubkey(req.EphemeralPubkey))
                return Results.BadRequest("EphemeralPubkey must be a 66-char hex string (33-byte compressed secp256k1 pubkey).");

            var order = new Order(
                Guid.NewGuid(),
                marketId,
                req.Side,
                OrderType.Limit,
                new Probability(req.Price),
                new Sats(req.AmountSats),
                req.UserId,
                DateTimeOffset.UtcNow);

            bookManager.AddOrder(order);

            await hubContext.Clients.Group(marketId)
                .OrderBookUpdated(bookManager.GetSnapshot(marketId));

            return Results.Ok(new SubmitOrderResponse(
                req.EphemeralPubkey, new List<Fill>(), order.Id, order.AmountSats.Value, "resting"));
        });

        app.MapGet("/api/v1/{marketId}/orders/{orderId:guid}", (
            string marketId,
            Guid orderId,
            InMemoryOrderBookManager bookManager) =>
        {
            var order = bookManager.GetOrder(orderId);
            if (order is null || order.MarketId != marketId)
                return Results.NotFound();

            // Stub never matches, so every fetched order is still "resting".
            // Clients keep the same polling shape the real engine will use.
            var filled = order.AmountSats.Value - order.RemainingAmountSats.Value;
            return Results.Ok(new OrderStatusResponse(
                filledAmountSats: filled,
                fills: new List<Fill>(),
                marketId: order.MarketId,
                orderId: order.Id,
                remainingAmountSats: order.RemainingAmountSats.Value,
                status: "resting"));
        });

        app.MapDelete("/api/v1/orders/{id:guid}", async (
            Guid id,
            InMemoryOrderBookManager bookManager,
            IHubContext<MarketHub, IMarketHubClient> hubContext) =>
        {
            var marketId = bookManager.GetMarketIdForOrder(id);
            if (marketId is null || !bookManager.CancelOrder(id))
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
