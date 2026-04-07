using System.Collections.Concurrent;

namespace BitCaster.InMemoryMatchingEngine.Endpoints;

public static class ThumbnailEndpoints
{
    internal static readonly ConcurrentDictionary<string, (byte[] Data, string ContentType)> Thumbnails = new();
    internal const long MaxFileSizeBytes = 5 * 1024 * 1024; // 5 MB
    internal static readonly HashSet<string> AllowedContentTypes = ["image/jpeg", "image/png", "image/webp"];

    public static void MapThumbnailEndpoints(this WebApplication app)
    {
        app.MapGet("/api/v1/{conditionId}/thumbnail", (string conditionId) =>
        {
            if (!Thumbnails.TryGetValue(conditionId, out var entry))
                return Results.NotFound();

            return Results.File(entry.Data, entry.ContentType);
        });
    }
}
