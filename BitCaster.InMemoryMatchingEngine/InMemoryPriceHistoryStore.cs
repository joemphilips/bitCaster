using System.Collections.Concurrent;
using BitCaster.MatchingEngine.Contracts;

namespace BitCaster.InMemoryMatchingEngine;

public sealed class InMemoryPriceHistoryStore
{
    public const int MaxPointsPerOutcomeResponse = 1000;

    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, List<MarketPriceHistoryPoint>>> _ticks = new();
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, MarketPriceHistoryPoint>> _initial = new();

    public void SeedInitialPriceHistory(
        string conditionId,
        IEnumerable<(string OutcomeId, int ProbabilityPercent)> outcomes,
        int divisibility,
        DateTimeOffset timestamp)
    {
        var byOutcome = _initial.GetOrAdd(
            conditionId,
            _ => new ConcurrentDictionary<string, MarketPriceHistoryPoint>(StringComparer.Ordinal));

        foreach (var outcome in outcomes)
        {
            var price = Math.Clamp(outcome.ProbabilityPercent * divisibility / 100, 1, divisibility - 1);
            byOutcome[outcome.OutcomeId] = new MarketPriceHistoryPoint(
                price: price,
                source: MarketPriceHistoryPointSource.Initial,
                timestamp: timestamp,
                volumeSubunits: 0,
                volumeSubunits: 0);
        }
    }

    public void RecordFill(string marketId, Fill fill)
    {
        var parts = MarketParts.TryParse(marketId);
        if (parts is null) return;
        if (parts.OutcomeSetId.Contains('|', StringComparison.Ordinal)) return;

        var byOutcome = _ticks.GetOrAdd(
            parts.ConditionId,
            _ => new ConcurrentDictionary<string, List<MarketPriceHistoryPoint>>(StringComparer.Ordinal));
        var points = byOutcome.GetOrAdd(parts.OutcomeSetId, _ => []);
        lock (points)
        {
            points.Add(new MarketPriceHistoryPoint(
                price: fill.ExecutionPrice,
                source: MarketPriceHistoryPointSource.Fill,
                timestamp: fill.FilledAt,
                volumeSubunits: fill.AmountSubunits,
                volumeSubunits: fill.AmountSubunits));
            if (points.Count > 1000)
            {
                points.RemoveRange(0, points.Count - 1000);
            }
        }
    }

    public MarketPriceHistoryResponse Get(string conditionId, string timeframe, DateTimeOffset nowUtc)
    {
        var since = timeframe switch
        {
            "1h" => nowUtc - TimeSpan.FromHours(1),
            "24h" => nowUtc - TimeSpan.FromHours(24),
            "7d" => nowUtc - TimeSpan.FromDays(7),
            "30d" => nowUtc - TimeSpan.FromDays(30),
            "all" => (DateTimeOffset?)null,
            _ => nowUtc - TimeSpan.FromDays(7)
        };
        _ticks.TryGetValue(conditionId, out var byOutcome);
        _initial.TryGetValue(conditionId, out var initialByOutcome);
        if (byOutcome is null && initialByOutcome is null)
        {
            return new MarketPriceHistoryResponse(conditionId, [], ToResponseTimeframe(timeframe));
        }

        var outcomeIds = new HashSet<string>(StringComparer.Ordinal);
        if (initialByOutcome is not null)
        {
            foreach (var outcomeId in initialByOutcome.Keys) outcomeIds.Add(outcomeId);
        }
        if (byOutcome is not null)
        {
            foreach (var outcomeId in byOutcome.Keys) outcomeIds.Add(outcomeId);
        }

        var outcomes = outcomeIds
            .OrderBy(outcomeId => outcomeId, StringComparer.Ordinal)
            .Select(outcomeId =>
            {
                var points = new List<MarketPriceHistoryPoint>();
                if (initialByOutcome?.TryGetValue(outcomeId, out var initial) == true)
                {
                    points.Add(since is not null && initial.Timestamp < since.Value
                        ? new MarketPriceHistoryPoint(
                            price: initial.Price,
                            source: initial.Source,
                            timestamp: since.Value,
                            volumeSubunits: initial.VolumeSubunits,
                            volumeSubunits: initial.VolumeSubunits)
                        : initial);
                }
                if (byOutcome?.TryGetValue(outcomeId, out var fills) == true)
                {
                    lock (fills)
                    {
                        points.AddRange(fills.Where(point => since is null || point.Timestamp >= since));
                    }
                }
                var fillCapacity = initialByOutcome?.ContainsKey(outcomeId) == true
                    ? MaxPointsPerOutcomeResponse - 1
                    : MaxPointsPerOutcomeResponse;
                var maxPoints = initialByOutcome?.ContainsKey(outcomeId) == true
                    ? fillCapacity + 1
                    : fillCapacity;
                if (points.Count > maxPoints)
                {
                    var initialPoint = points.FirstOrDefault(point => point.Source == MarketPriceHistoryPointSource.Initial);
                    var newestFills = points
                        .Where(point => point.Source != MarketPriceHistoryPointSource.Initial)
                        .OrderBy(point => point.Timestamp)
                        .TakeLast(fillCapacity)
                        .ToList();
                    points = initialPoint is null
                        ? newestFills
                        : newestFills.Prepend(initialPoint).ToList();
                }
                return new MarketOutcomePriceHistory(
                    points
                        .OrderBy(point => point.Timestamp)
                        .ThenBy(point => point.Source)
                        .ToList(),
                    outcomeId);
            })
            .Where(series => series.Data.Count > 0)
            .ToList();

        return new MarketPriceHistoryResponse(conditionId, outcomes, ToResponseTimeframe(timeframe));
    }

    private static MarketPriceHistoryResponseTimeframe ToResponseTimeframe(string timeframe) =>
        timeframe switch
        {
            "1h" => MarketPriceHistoryResponseTimeframe._1h,
            "24h" => MarketPriceHistoryResponseTimeframe._24h,
            "30d" => MarketPriceHistoryResponseTimeframe._30d,
            "all" => MarketPriceHistoryResponseTimeframe.All,
            _ => MarketPriceHistoryResponseTimeframe._7d
        };
}
