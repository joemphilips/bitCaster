namespace BitCaster.InMemoryMatchingEngine.Endpoints;

public static class CommentEndpoints
{
    public static void MapCommentEndpoints(this WebApplication app)
    {
        app.MapGet("/api/v1/markets/{conditionId}/comments", (
            string conditionId,
            InMemoryCommentStore store) => Results.Ok(store.Get(conditionId)));
    }
}
