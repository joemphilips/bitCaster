namespace BitCaster.MatchingEngine.Contracts.Hubs;

/// <summary>
/// Strongly-typed SignalR client interface for trade hub callbacks.
/// All cryptographic operations happen client-side; the engine relays opaque ciphertexts.
/// </summary>
public interface ITradeHubClient
{
    /// <summary>
    /// Owner-filtered order lifecycle update. This callback never contains
    /// settlement capability artifacts or bearer proof material.
    /// </summary>
    Task OrderLifecycleChanged(OrderLifecycleChangedDelta delta);

    /// <summary>
    /// Owner-filtered settlement-group lifecycle update for one affected order.
    /// </summary>
    Task SettlementGroupStateChanged(SettlementGroupStateChangedDelta delta);

    /// <summary>
    /// Owner-filtered display-only portfolio refresh hint for one wallet.
    /// </summary>
    Task PortfolioInvalidated(PortfolioInvalidatedDelta delta);

    /// <summary>Relayed to the counterparty when a swap message arrives.</summary>
    Task SwapMessageReceived(Guid tradeId, string messageType, string ciphertext);

    /// <summary>Broadcast to both parties when the trade state transitions.</summary>
    Task TradeStateChanged(Guid tradeId, string newState);

    /// <summary>Sent during JoinOrder recovery when a matched order is waiting for this party's ephemeral pubkey.</summary>
    Task PendingPubkeyRequired(Guid tradeId, string role, DateTimeOffset deadline);

    /// <summary>
    /// Sent to both parties immediately after a trade is created from a fill.
    /// Carries counterparty pubkeys, the engine-computed asymmetric locktimes,
    /// the market id, the canonical matched fill amount, and explicit settlement
    /// amounts. The canonical settlement amount is `quotePaymentSubunits +
    /// baseAsset + collateralUnit + divisibility`; `fillAmountSubunits` is the
    /// aggregate matched face amount.
    /// </summary>
    Task TradeCreated(Guid tradeId, string sellerPubkey, string buyerPubkey,
        DateTimeOffset sellerLocktime, DateTimeOffset buyerLocktime,
        string marketId, long fillAmountSubunits,
        long outcomeFaceAmountSubunits,
        long quotePaymentSubunits,
        string? settlementKind,
        string? sellerKeepOutcomeSetId,
        string? sellerLockOutcomeSetId,
        BaseAsset baseAsset,
        string collateralUnit,
        int divisibility,
        TokenSide tokenSide);
}

public sealed record OrderLifecycleChangedDelta(
    Guid OrderId,
    string MarketId,
    OrderLifecycleStatus Status,
    long RemainingAmountSubunits,
    BaseAsset BaseAsset,
    string CollateralUnit,
    int Divisibility,
    SettlementGroupSummary? ActiveSettlementGroup);

public sealed record SettlementGroupStateChangedDelta(
    Guid OrderId,
    string MarketId,
    SettlementGroupSummary SettlementGroup);

public sealed record PortfolioInvalidatedDelta(string WalletId);
