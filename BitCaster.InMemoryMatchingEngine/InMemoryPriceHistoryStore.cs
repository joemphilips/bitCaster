using System.Collections.Concurrent;
using BitCaster.MatchingEngine.Contracts;

namespace BitCaster.InMemoryMatchingEngine;

public sealed class InMemoryPriceHistoryStore
{
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, List<MarketPriceHistoryPoint>>> _ticks = new();

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
                timestamp: fill.FilledAt,
                price: fill.ExecutionPrice,
                volumeSats: fill.AmountSats));
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
        if (!_ticks.TryGetValue(conditionId, out var byOutcome))
        {
            return new MarketPriceHistoryResponse(conditionId, [], ToResponseTimeframe(timeframe));
        }

        var outcomes = byOutcome
            .OrderBy(entry => entry.Key, StringComparer.Ordinal)
            .Select(entry =>
            {
                lock (entry.Value)
                {
                    return new MarketOutcomePriceHistory(
                        entry.Value
                            .Where(point => since is null || point.Timestamp >= since)
                            .OrderBy(point => point.Timestamp)
                            .ToList(),
                        entry.Key);
                }
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
