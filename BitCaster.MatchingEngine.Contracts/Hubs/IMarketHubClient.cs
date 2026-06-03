using BitCaster.MatchingEngine.Contracts;

namespace BitCaster.MatchingEngine.Contracts.Hubs;

/// <summary>
/// Strongly-typed SignalR client interface for market hub callbacks.
/// Kept in sync with specs/asyncapi.yaml.
/// </summary>
public interface IMarketHubClient
{
    Task OrderBookUpdated(OrderBookSnapshot snapshot);

    Task OrderAccepted(OrderAcceptedDelta delta);

    Task OrderCancelled(OrderCancelledDelta delta);

    Task Matched(MatchedDelta delta);

    Task DepthChanged(DepthDelta delta);

    Task MarketStatusChanged(MarketStatusChanged status);
}

public sealed record OrderAcceptedDelta(
    string MarketId,
    Guid OrderId,
    string OutcomeId,
    OrderSide Side,
    int Price,
    long RemainingAmountSats);

public sealed record OrderCancelledDelta(
    string MarketId,
    Guid OrderId);

public sealed record MatchedDelta(
    string MarketId,
    Guid TradeId,
    Guid MakerOrderId,
    Guid TakerOrderId,
    int ExecutionPrice,
    long AmountSats,
    MatchPath Path,
    DateTimeOffset MatchedAt);

public sealed record DepthDelta(
    string MarketId,
    IReadOnlyList<LevelDto> Bids,
    IReadOnlyList<LevelDto> Asks,
    int? Spread);

public sealed record MarketStatusChanged(
    string ConditionId,
    string State,
    DateTimeOffset? ClosedAt,
    string? FinalOutcome);
