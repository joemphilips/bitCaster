using BitCaster.Server.Domain;

namespace BitCaster.Server.Endpoints;

public static class BookEndpoints
{
    public static void MapBookEndpoints(this WebApplication app)
    {
        app.MapGet("/api/v1/markets/{marketId}/orderbook", (
            string marketId,
            OrderBookManager bookManager) =>
        {
            var book = bookManager.Get(marketId);
            if (book is null)
                return Results.Ok(new OrderBookSnapshot(marketId, new()));

            return Results.Ok(book.GetSnapshot());
        });
    }
}
