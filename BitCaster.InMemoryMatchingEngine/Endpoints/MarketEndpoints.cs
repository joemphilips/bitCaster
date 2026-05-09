using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.RegularExpressions;
using BitCaster.MatchingEngine.Contracts;

namespace BitCaster.InMemoryMatchingEngine.Endpoints;

public static partial class MarketEndpoints
{
    private sealed record MarketRecord(CreateMarketResponse Response, DateTimeOffset CreatedAt);

    private static readonly ConcurrentDictionary<string, MarketRecord> Markets = new();

    // Pubkey (hex) -> set of conditionIds created by that pubkey. Inner dictionary is used
    // as a concurrent set (byte value is a placeholder).
    private static readonly ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> CreatorIndex = new();

    private static readonly JsonSerializerOptions MetadataJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    [GeneratedRegex("^[0-9a-f]{64}$")]
    private static partial Regex PubkeyHexRegex();

    public static void MapMarketEndpoints(this WebApplication app)
    {
        app.MapPost("/api/v1/markets/{conditionId}", async (
            string conditionId,
            HttpRequest request,
            IHttpClientFactory httpClientFactory) =>
        {
            if (!request.HasFormContentType)
                return Results.BadRequest("Expected multipart/form-data");

            var form = await request.ReadFormAsync();

            // Parse metadata JSON
            var metadataStr = form["metadata"].FirstOrDefault();
            if (string.IsNullOrWhiteSpace(metadataStr))
                return Results.BadRequest("Missing 'metadata' field");

            CreateMarketRequest? metadata;
            try
            {
                metadata = JsonSerializer.Deserialize<CreateMarketRequest>(metadataStr, MetadataJsonOptions);
            }
            catch (JsonException ex)
            {
                return Results.BadRequest($"Invalid metadata JSON: {ex.Message}");
            }

            if (metadata is null)
                return Results.BadRequest("Metadata deserialized to null");

            // Validate required fields
            if (string.IsNullOrWhiteSpace(metadata.Title))
                return Results.BadRequest("Title is required");
            if (string.IsNullOrWhiteSpace(metadata.Description))
                return Results.BadRequest("Description is required");
            if (metadata.Outcomes is null || metadata.Outcomes.Count < 2)
                return Results.BadRequest("At least 2 outcomes are required");

            var probSum = metadata.Outcomes.Sum(o => o.Probability);
            if (probSum != 100)
                return Results.BadRequest($"Outcome probabilities must sum to 100 (got {probSum})");

            // Validate thumbnail before committing any state
            var thumbnailFile = form.Files.GetFile("thumbnail");
            string? thumbnailUrl = null;
            byte[]? thumbnailBytes = null;
            string? thumbnailContentType = null;
            if (thumbnailFile is not null && thumbnailFile.Length > 0)
            {
                if (thumbnailFile.Length > ThumbnailEndpoints.MaxFileSizeBytes)
                    return Results.BadRequest($"Thumbnail too large (max {ThumbnailEndpoints.MaxFileSizeBytes / 1024 / 1024} MB)");

                thumbnailContentType = thumbnailFile.ContentType ?? "application/octet-stream";
                if (!ThumbnailEndpoints.AllowedContentTypes.Contains(thumbnailContentType))
                    return Results.BadRequest($"Unsupported thumbnail type: {thumbnailContentType}");

                using var ms = new MemoryStream((int)thumbnailFile.Length);
                await thumbnailFile.CopyToAsync(ms);
                thumbnailBytes = ms.ToArray();
                thumbnailUrl = $"/api/v1/{conditionId}/thumbnail";
            }

            // Validate condition exists in mint
            try
            {
                var mintClient = httpClientFactory.CreateClient("mint");
                var mintResponse = await mintClient.GetAsync("/v1/conditions");
                if (mintResponse.IsSuccessStatusCode)
                {
                    var body = await mintResponse.Content.ReadAsStringAsync();
                    using var doc = JsonDocument.Parse(body);
                    var conditions = doc.RootElement.GetProperty("conditions");
                    var found = false;
                    foreach (var c in conditions.EnumerateArray())
                    {
                        if (c.GetProperty("condition_id").GetString() == conditionId)
                        {
                            found = true;
                            break;
                        }
                    }
                    if (!found)
                        return Results.BadRequest($"Condition {conditionId} not found in mint");
                }
            }
            catch
            {
                // Mint unreachable — skip validation in dev
            }

            // Build per-outcome market IDs and CPMM pools
            var marketsCreated = new List<string>();
            var liquidityPerOutcome = (metadata.LiquiditySats ?? 0) / metadata.Outcomes.Count;
            var poolEntries = new List<(string MarketId, LiquidityStateResponse Pool)>();
            foreach (var outcome in metadata.Outcomes)
            {
                var marketId = $"{conditionId}-{outcome.Name}";
                marketsCreated.Add(marketId);

                var reserveA = liquidityPerOutcome * outcome.Probability / 100;
                var reserveB = liquidityPerOutcome - reserveA;

                poolEntries.Add((marketId, new LiquidityStateResponse(
                    marketId: marketId,
                    reserveA: reserveA,
                    reserveB: reserveB,
                    impliedProbability: outcome.Probability,
                    totalLiquiditySats: liquidityPerOutcome,
                    activeOrders: 0)));
            }

            var response = new CreateMarketResponse(
                conditionId: conditionId,
                marketsCreated: marketsCreated,
                thumbnailUrl: thumbnailUrl);

            var record = new MarketRecord(response, DateTimeOffset.UtcNow);

            // Atomically check-and-insert to avoid TOCTOU race
            if (!Markets.TryAdd(conditionId, record))
                return Results.Conflict($"Market already exists for condition {conditionId}");

            // Commit side-effect state only after market is registered
            foreach (var (marketId, pool) in poolEntries)
                LiquidityEndpoints.Pools[marketId] = pool;

            if (thumbnailBytes is not null)
                ThumbnailEndpoints.Thumbnails[conditionId] = (thumbnailBytes, thumbnailContentType!);

            return Results.Ok(response);
        });

        app.MapGet("/api/v1/creators/{pubkey}/markets", (string pubkey) =>
        {
            if (string.IsNullOrWhiteSpace(pubkey) || !PubkeyHexRegex().IsMatch(pubkey))
                return Results.BadRequest("pubkey must be a 64-character lowercase hex string");

            var entries = new List<CreatorMarketEntry>();
            if (CreatorIndex.TryGetValue(pubkey, out var conditionIds))
            {
                foreach (var conditionId in conditionIds.Keys)
                {
                    if (!Markets.TryGetValue(conditionId, out var record))
                        continue;

                    // The in-memory engine never produces fills, so volume is always 0.
                    entries.Add(new CreatorMarketEntry(
                        conditionId: conditionId,
                        createdAt: record.CreatedAt,
                        totalVolumeSats: 0));
                }
            }

            // Deterministic ordering: most recently created first.
            entries.Sort((a, b) => b.CreatedAt.CompareTo(a.CreatedAt));

            var response = new CreatorMarketsResponse(
                markets: entries,
                pubkey: pubkey);
            return Results.Ok(response);
        });
    }
}
