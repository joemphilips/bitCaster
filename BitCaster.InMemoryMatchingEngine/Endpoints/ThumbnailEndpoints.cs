using System.Collections.Concurrent;
using BitCaster.MatchingEngine.Contracts;

namespace BitCaster.InMemoryMatchingEngine.Endpoints;

public static class ThumbnailEndpoints
{
    private static readonly ConcurrentDictionary<string, (byte[] Data, string ContentType)> Thumbnails = new();
    private const long MaxFileSizeBytes = 5 * 1024 * 1024; // 5 MB
    private static readonly HashSet<string> AllowedContentTypes = ["image/jpeg", "image/png", "image/webp"];

    public static void MapThumbnailEndpoints(this WebApplication app)
    {
        app.MapPost("/api/v1/{conditionId}/thumbnail", async (string conditionId, HttpRequest request) =>
        {
            if (!request.HasFormContentType)
                return Results.BadRequest("Expected multipart/form-data");

            var form = await request.ReadFormAsync();
            var file = form.Files.GetFile("file");
            if (file is null || file.Length == 0)
                return Results.BadRequest("No file provided");

            if (file.Length > MaxFileSizeBytes)
                return Results.BadRequest($"File too large (max {MaxFileSizeBytes / 1024 / 1024} MB)");

            var contentType = file.ContentType ?? "application/octet-stream";
            if (!AllowedContentTypes.Contains(contentType))
                return Results.BadRequest($"Unsupported content type: {contentType}. Allowed: {string.Join(", ", AllowedContentTypes)}");

            using var ms = new MemoryStream();
            await file.CopyToAsync(ms);
            Thumbnails[conditionId] = (ms.ToArray(), contentType);

            var thumbnailUrl = $"/api/v1/{conditionId}/thumbnail";
            return Results.Ok(new UploadThumbnailResponse(conditionId: conditionId, thumbnailUrl: thumbnailUrl));
        });

        app.MapGet("/api/v1/{conditionId}/thumbnail", (string conditionId) =>
        {
            if (!Thumbnails.TryGetValue(conditionId, out var entry))
                return Results.NotFound();

            return Results.File(entry.Data, entry.ContentType);
        });
    }
}
