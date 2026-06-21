using System.Text.Json;
using BitCaster.MatchingEngine.Contracts;

namespace BitCaster.InMemoryMatchingEngine.Endpoints;

/// <summary>
/// Stub for the engine's catalogue proxy (`GET /api/v1/markets/query`,
/// ADR-009). The mock returns mintd's `/v1/conditions` re-shaped as catalogue
/// entries so the frontend dev/E2E flow works against the seeded test data.
///
/// Sort, pagination, rate-limiting, and HMAC-signed cursors are deliberately
/// not implemented — the mock hands back every condition that survives the
/// `?ids=` / `?state=` / `?search=` filters in a single response with
/// `nextCursor = null`. Tests that need to exercise cursor edge cases mock the
/// endpoint directly via Playwright `RouteAsync`.
/// </summary>
public static class MarketQueryEndpoint
{
    private const int MaxSearchLength = 200;

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

            var search = ParseSearchQuery(request.Query["search"]);
            if (search.Status == SearchParseStatus.InvalidLength)
                return Results.BadRequest("search exceeds the 200-character cap");
            if (search.Status == SearchParseStatus.InvalidControlCharacters)
                return Results.BadRequest("search must not contain control characters");

            var refreshedAt = DateTimeOffset.UtcNow;
            var conditions = await TryReadConditionsAsync(httpClientFactory);
            var entries = conditions
                .Where(c => MatchesIdsFilter(c, ids))
                .Where(c => MatchesStateFilter(c, state.Value))
                .Where(c => MatchesSearchFilter(c, search.Terms))
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

    private static SearchParseResult ParseSearchQuery(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return new SearchParseResult(SearchParseStatus.Valid, []);
        var normalized = string.Join(' ', raw.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        if (normalized.Length > MaxSearchLength) return new SearchParseResult(SearchParseStatus.InvalidLength, []);
        if (normalized.Any(char.IsControl)) return new SearchParseResult(SearchParseStatus.InvalidControlCharacters, []);
        return new SearchParseResult(
            SearchParseStatus.Valid,
            normalized
                .Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(t => t.ToLowerInvariant())
                .ToArray());
    }

    private static bool MatchesSearchFilter(MintdConditionDto c, IReadOnlyList<string> terms)
    {
        if (terms.Count == 0) return true;
        var haystack = string.Join(' ', new[]
        {
            c.ConditionId,
            c.Title,
            string.Join(' ', c.Outcomes),
            string.Join(' ', c.CategoryTags),
        }).ToLowerInvariant();
        return terms.All(haystack.Contains);
    }

    private static MarketCatalogueEntry ToCatalogueEntry(MintdConditionDto c, DateTimeOffset refreshedAt)
    {
        var open = string.Equals(c.AttestationStatus, "pending", StringComparison.OrdinalIgnoreCase);
        var market = MarketEndpoints.TryGetMarket(c.ConditionId);
        return new MarketCatalogueEntry(
            baseAsset: market?.BaseAsset ?? BaseAsset.Sat,
            categoryTags: c.CategoryTags,
            closedAt: null,
            conditionId: c.ConditionId,
            createdAt: refreshedAt,
            // NSwag generates these reference-typed fields as non-nullable
            // even though the OpenAPI spec marks them nullable; pass `null!`
            // so C# compiles and the JSON serialiser still emits `null`.
            creatorPubkey: null!,
            deadline: null,
            description: null!,
            divisibility: market?.Divisibility ?? MarketEndpoints.DefaultMarketDivisibility,
            finalOutcome: null!,
            lastSuccessfulRefreshAt: refreshedAt,
            lastTradedPrice: null,
            liquiditySats: StubLiquiditySats(c),
            outcomes: c.Outcomes,
            state: open ? MarketCatalogueEntryState.Open : MarketCatalogueEntryState.Closed,
            thumbnailUrl: null!,
            title: c.Title,
            volume24hSats: 0,
            volume30dSats: 0,
            volumeLifetimeSats: StubVolumeLifetimeSats(c));
    }

    private static long StubLiquiditySats(MintdConditionDto c) =>
        25_000L + (StableBucket(c.ConditionId, modulo: 12) * 5_000L);

    private static long StubVolumeLifetimeSats(MintdConditionDto c) =>
        StubLiquiditySats(c) * (2 + StableBucket(c.ConditionId, modulo: 4));

    private static int StableBucket(string value, int modulo)
    {
        var hash = 0;
        foreach (var ch in value)
            hash = unchecked((hash * 31) + ch);
        return Math.Abs(hash % modulo);
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
        private static readonly HashSet<string> KnownTagKeys = new(StringComparer.Ordinal) { "description", "title", "n" };

        public static MintdConditionDto FromJson(JsonElement c)
        {
            var conditionId = c.GetProperty("condition_id").GetString() ?? string.Empty;
            var attestationStatus = c.TryGetProperty("attestation", out var att) && att.TryGetProperty("status", out var s)
                ? s.GetString() ?? "pending"
                : "pending";
            var (title, categoryTags) = ParseTags(c);
            var registeredOutcomes = MarketEndpoints.TryGetRegisteredOutcomes(conditionId)?.ToList();
            var outcomes = registeredOutcomes is { Count: > 0 }
                ? registeredOutcomes
                : ParseSingletonPartitionMembers(c);
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
                    if (key == "title") title ??= value;
                    else if (key == "description") title ??= value;
                    else if (!KnownTagKeys.Contains(key)) category.Add(value);
                }
            }
            if (title is null && c.TryGetProperty("description", out var legacy))
                title = legacy.GetString();
            return (title ?? "Untitled Market", category);
        }

        private static List<string> ParseSingletonPartitionMembers(JsonElement c)
        {
            if (!c.TryGetProperty("keysets", out var keysets) || keysets.ValueKind != JsonValueKind.Object)
                return new();

            var outcomes = new List<string>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var keyset in keysets.EnumerateObject())
            {
                foreach (var member in keyset.Name.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                {
                    if (string.IsNullOrWhiteSpace(member))
                        continue;
                    if (seen.Add(member))
                        outcomes.Add(member);
                }
            }
            return OrderAtomicOutcomes(outcomes);
        }

        private static List<string> OrderAtomicOutcomes(List<string> outcomes)
        {
            if (outcomes.Count == 2
                && outcomes.Any(outcome => string.Equals(outcome, "Yes", StringComparison.OrdinalIgnoreCase))
                && outcomes.Any(outcome => string.Equals(outcome, "No", StringComparison.OrdinalIgnoreCase)))
            {
                return ["Yes", "No"];
            }

            return outcomes;
        }
    }

    private enum SearchParseStatus { Valid, InvalidLength, InvalidControlCharacters }

    private sealed record SearchParseResult(SearchParseStatus Status, IReadOnlyList<string> Terms);
}
