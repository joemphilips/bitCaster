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

    /// <summary>
    /// Pushed to every per-outcome market group of a condition when its
    /// lifecycle state changes (e.g. open -> closed on oracle/deadline close).
    /// </summary>
    Task MarketStatusChanged(MarketStatusChanged status);
}

public sealed record OrderAcceptedDelta(
    string MarketId,
    Guid OrderId,
    string OutcomeId,
    OrderSide Side,
    int Price,
    long RemainingAmountSubunits);

public sealed record OrderCancelledDelta(
    string MarketId,
    Guid OrderId);

public sealed record MatchedDelta(
    string MarketId,
    Guid TradeId,
    Guid MakerOrderId,
    Guid TakerOrderId,
    int ExecutionPrice,
    long AmountSubunits,
    MatchPath Path,
    DateTimeOffset MatchedAt,
    DateTimeOffset Deadline,
    BaseAsset BaseAsset,
    string CollateralUnit,
    int Divisibility,
    long QuotePaymentSubunits,
    long OutcomeFaceAmountSubunits,
    TokenSide TokenSide);

public sealed record MarketStatusChanged(
    string ConditionId,
    string State,
    DateTimeOffset? ClosedAt,
    string? FinalOutcome);
