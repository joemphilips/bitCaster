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

    Task ConfirmedTradeRecorded(ConfirmedTradeRecordedMessage message);

    Task MarketCommentsChanged(MarketCommentsChangedMessage message);

    Task MarketFundingUpdated(MarketFundingUpdatedMessage message);

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
    Guid FillId,
    Guid MakerOrderId,
    Guid TakerOrderId,
    int ExecutionPrice,
    long AmountSubunits,
    MatchPath Path,
    DateTimeOffset MatchedAt,
    BaseAsset BaseAsset,
    string CollateralUnit,
    int Divisibility,
    long QuotePaymentSubunits,
    long OutcomeFaceAmountSubunits,
    TokenSide TokenSide);

public sealed record ConfirmedTradeRecordedMessage(
    string ConditionId,
    LatestConfirmedTrade LatestConfirmedTrade);

/// <summary>
/// A committed comment invalidates the condition's comment snapshot.
/// EventOrder is an opaque source position. It does not prove snapshot readiness.
/// </summary>
public sealed record MarketCommentsChangedMessage(
    string ConditionId,
    string EventOrder);

/// <summary>
/// One committed cumulative market-funding observation. The revision is the
/// exact durable event order that produced the total.
/// </summary>
public sealed record MarketFundingUpdatedMessage(
    string ConditionId,
    long AmmBotBudgetSubunits,
    string FundingRevision);

public sealed record MarketStatusChanged(
    string ConditionId,
    string State,
    DateTimeOffset? ClosedAt,
    string? FinalOutcome);
