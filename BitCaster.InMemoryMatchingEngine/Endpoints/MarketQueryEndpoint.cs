using System.Text.Json;
using BitCaster.MatchingEngine.Contracts;

namespace BitCaster.InMemoryMatchingEngine.Endpoints;

/// <summary>
/// Stub for the engine's catalogue proxy (`GET /api/v1/markets/query`,
/// ADR-009). The real engine merges its own `MarketRegistration` projection
/// with the mintd-mirror snapshot; this mock skips the projection layer and
/// returns mintd's `/v1/conditions` re-shaped as catalogue entries so the
/// frontend dev/E2E flow works against the seeded test data.
///
/// Sort, pagination, rate-limiting, and HMAC-signed cursors are deliberately
/// not implemented — the mock hands back every condition that survives the
/// `?ids=` / `?state=` filters in a single response with `nextCursor = null`.
/// Tests that need to exercise the cursor edge cases mock the endpoint
/// directly via Playwright `RouteAsync`.
/// </summary>
public static class MarketQueryEndpoint
{
    private static readonly JsonSerializerOptions ConditionsJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
    };

    public static void MapMarketQueryEndpoint(this WebApplication app)
    {
        app.MapGet("/api/v1/markets/query", async (
            HttpRequest request,
            IHttpClientFactory httpClientFactory) =>
        {
            var ids = ParseIdsFilter(request.Query["ids"]);
            if (ids is { Count: > 100 })
                return Results.BadRequest("ids exceeds the 100-id cap");

            var state = ParseStateFilter(request.Query["state"]);
            if (state is null)
                return Results.BadRequest("state must be one of: Open, Closed, All");

            var refreshedAt = DateTimeOffset.UtcNow;
            var conditions = await TryReadConditionsAsync(httpClientFactory);
            var entries = conditions
                .Where(c => MatchesIdsFilter(c, ids))
                .Where(c => MatchesStateFilter(c, state.Value))
                .Select(c => ToCatalogueEntry(c, refreshedAt))
                .ToList();

            var response = new MarketCatalogueResponse(
                lastSuccessfulRefreshAt: refreshedAt,
                markets: entries,
                // Mock has no pagination: every result fits in a single page.
                // NSwag-generated DTOs don't honour the OpenAPI `nullable: true`
                // for string fields, so we pass `null!` to satisfy the C#
                // nullability checker; on the wire it serialises as `null`.
                nextCursor: null!);
            return Results.Ok(response);
        });
    }

    private static HashSet<string>? ParseIdsFilter(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        return raw
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .ToHashSet();
    }

    private enum StateFilter { Open, Closed, All }

    private static StateFilter? ParseStateFilter(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return StateFilter.Open;
        return raw.Trim().ToLowerInvariant() switch
        {
            "open" => StateFilter.Open,
            "closed" => StateFilter.Closed,
            "all" => StateFilter.All,
            _ => null,
        };
    }

    private static bool MatchesIdsFilter(MintdConditionDto c, HashSet<string>? ids) =>
        ids is null || ids.Contains(c.ConditionId);

    private static bool MatchesStateFilter(MintdConditionDto c, StateFilter filter)
    {
        var open = string.Equals(c.AttestationStatus, "pending", StringComparison.OrdinalIgnoreCase);
        return filter switch
        {
            StateFilter.Open => open,
            StateFilter.Closed => !open,
            _ => true,
        };
    }

    private static MarketCatalogueEntry ToCatalogueEntry(MintdConditionDto c, DateTimeOffset refreshedAt)
    {
        var open = string.Equals(c.AttestationStatus, "pending", StringComparison.OrdinalIgnoreCase);
        return new MarketCatalogueEntry(
            categoryTags: c.CategoryTags,
            conditionId: c.ConditionId,
            createdAt: refreshedAt,
            // NSwag generates these reference-typed fields as non-nullable
            // even though the OpenAPI spec marks them nullable; pass `null!`
            // so C# compiles and the JSON serialiser still emits `null`.
            creatorPubkey: null!,
            deadline: null,
            lastSuccessfulRefreshAt: refreshedAt,
            lastTradedPrice: null,
            outcomes: c.Outcomes,
            state: open ? MarketCatalogueEntryState.Open : MarketCatalogueEntryState.Closed,
            thumbnailUrl: null!,
            title: c.Title,
            volume24hSats: 0,
            volume30dSats: 0);
    }

    private static async Task<List<MintdConditionDto>> TryReadConditionsAsync(IHttpClientFactory factory)
    {
        try
        {
            var client = factory.CreateClient("mint");
            using var response = await client.GetAsync("/v1/conditions");
            if (!response.IsSuccessStatusCode) return new();
            var body = await response.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("conditions", out var raw)) return new();
            var conditions = new List<MintdConditionDto>();
            foreach (var c in raw.EnumerateArray())
                conditions.Add(MintdConditionDto.FromJson(c));
            return conditions;
        }
        catch
        {
            // Mintd unreachable — empty catalogue is the documented fallback.
            return new();
        }
    }

    private sealed record MintdConditionDto(
        string ConditionId,
        string Title,
        List<string> Outcomes,
        List<string> CategoryTags,
        string AttestationStatus)
    {
        private static readonly HashSet<string> KnownTagKeys = new(StringComparer.Ordinal) { "description", "n" };

        public static MintdConditionDto FromJson(JsonElement c)
        {
            var conditionId = c.GetProperty("condition_id").GetString() ?? string.Empty;
            var attestationStatus = c.TryGetProperty("attestation", out var att) && att.TryGetProperty("status", out var s)
                ? s.GetString() ?? "pending"
                : "pending";
            var (title, categoryTags) = ParseTags(c);
            var outcomes = ParseFirstPartition(c);
            return new MintdConditionDto(conditionId, title, outcomes, categoryTags, attestationStatus);
        }

        private static (string Title, List<string> CategoryTags) ParseTags(JsonElement c)
        {
            string? title = null;
            var category = new List<string>();
            if (c.TryGetProperty("tags", out var tags) && tags.ValueKind == JsonValueKind.Array)
            {
                foreach (var entry in tags.EnumerateArray())
                {
                    if (entry.ValueKind != JsonValueKind.Array) continue;
                    var pair = entry.EnumerateArray().ToList();
                    if (pair.Count < 2) continue;
                    var key = pair[0].GetString();
                    var value = pair[1].GetString();
                    if (key is null || value is null) continue;
                    if (key == "description") title ??= value;
                    else if (!KnownTagKeys.Contains(key)) category.Add(value);
                }
            }
            if (title is null && c.TryGetProperty("description", out var legacy))
                title = legacy.GetString();
            return (title ?? "Untitled Market", category);
        }

        private static List<string> ParseFirstPartition(JsonElement c)
        {
            if (!c.TryGetProperty("partitions", out var partitions) || partitions.ValueKind != JsonValueKind.Array)
                return new();
            var first = partitions.EnumerateArray().FirstOrDefault();
            if (first.ValueKind != JsonValueKind.Object) return new();
            if (!first.TryGetProperty("partition", out var partition) || partition.ValueKind != JsonValueKind.Array)
                return new();
            var outcomes = new List<string>();
            foreach (var item in partition.EnumerateArray())
            {
                var name = item.GetString();
                if (name is not null) outcomes.Add(name);
            }
            return outcomes;
        }
    }
}
