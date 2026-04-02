using System.Collections.Concurrent;
using BitCaster.MatchingEngine.Contracts;

namespace BitCaster.InMemoryMatchingEngine.Endpoints;

public static class MetadataEndpoints
{
    private static readonly ConcurrentDictionary<string, HashSet<string>> MarketLikes = new();

    public static void MapMetadataEndpoints(this WebApplication app)
    {
        app.MapGet("/api/v1/{marketId}/metadata", (string marketId, string? userId) =>
        {
            var likes = MarketLikes.GetValueOrDefault(marketId);
            var likeCount = likes?.Count ?? 0;
            var isLiked = userId is not null && (likes?.Contains(userId) ?? false);

            return Results.Ok(new MarketMetadataSnapshot(
                likeCount: likeCount,
                isLiked: isLiked,
                marketId: marketId,
                totalVolumeSats: 0,
                totalTrades: 0,
                uniqueTraderCount: 0,
                totalLiquiditySats: 0));
        });

        app.MapPost("/api/v1/{marketId}/like", (string marketId, ToggleLikeRequest req) =>
        {
            var likes = MarketLikes.GetOrAdd(marketId, _ => new HashSet<string>());
            bool isLiked;
            lock (likes)
            {
                if (!likes.Add(req.UserId))
                {
                    likes.Remove(req.UserId);
                    isLiked = false;
                }
                else
                {
                    isLiked = true;
                }
            }

            return Results.Ok(new ToggleLikeResponse(likeCount: likes.Count, isLiked: isLiked));
        });
    }
}
