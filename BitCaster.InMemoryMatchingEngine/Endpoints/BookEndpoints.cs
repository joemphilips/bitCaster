namespace BitCaster.InMemoryMatchingEngine.Endpoints;

public static class BookEndpoints
{
    public static void MapBookEndpoints(this WebApplication app)
    {
        app.MapGet("/api/v1/markets/{marketId}/orderbook", (
            string marketId,
            InMemoryOrderBookManager bookManager) =>
        {
            return Results.Ok(bookManager.GetSnapshot(marketId));
        });
    }
}
