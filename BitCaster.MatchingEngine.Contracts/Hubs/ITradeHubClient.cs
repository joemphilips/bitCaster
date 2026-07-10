namespace BitCaster.MatchingEngine.Contracts.Hubs;

/// <summary>
/// Strongly-typed SignalR client interface for trade hub callbacks.
/// All cryptographic operations happen client-side; the engine relays opaque ciphertexts.
/// </summary>
public interface ITradeHubClient
{
    /// <summary>Relayed to the counterparty when a swap message arrives.</summary>
    Task SwapMessageReceived(Guid tradeId, string messageType, string ciphertext);

    /// <summary>
    /// Broadcast to both parties when the trade state transitions. The optional
    /// failure reason is a stable public code, present only for allowlisted
    /// terminal failures that a client may safely recover from.
    /// </summary>
    Task TradeStateChanged(Guid tradeId, string newState, string? failureReason = null);

    /// <summary>Sent during JoinOrder recovery when a matched order is waiting for this party's ephemeral pubkey.</summary>
    Task PendingPubkeyRequired(Guid tradeId, string role, DateTimeOffset deadline);

    /// <summary>
    /// Sent to both parties immediately after a trade is created from a fill.
    /// Carries counterparty pubkeys, the engine-computed asymmetric locktimes,
    /// the market id, the canonical matched fill amount, and explicit settlement
    /// amounts. The
    /// canonical settlement amount is `quotePaymentSubunits + baseAsset +
    /// divisibility`; consumers should prefer those fields when present and
    /// treat `fillAmountSubunits` as the aggregate matched face amount.
    /// </summary>
    Task TradeCreated(Guid tradeId, string sellerPubkey, string buyerPubkey,
        DateTimeOffset sellerLocktime, DateTimeOffset buyerLocktime,
        string marketId, long fillAmountSubunits,
        long? outcomeFaceAmountSubunits = null,
        long? quotePaymentSubunits = null,
        string? settlementKind = null,
        string? sellerKeepOutcomeSetId = null,
        string? sellerLockOutcomeSetId = null,
        string? baseAsset = null,
        int? divisibility = null,
        string? tokenSide = null);
}
