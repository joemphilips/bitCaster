using System.Collections.Concurrent;

namespace BitCaster.InMemoryMatchingEngine;

/// <summary>
/// Per-trade bookkeeping for the mock's <c>TradeHub</c>. Tracks counterparty
/// pubkeys + locktimes so a late-joining client can be replayed
/// <c>TradeCreated</c> on <c>JoinTrade</c>, and counts <c>settlement-complete</c>
/// confirmations so the hub can flip the trade to <c>Confirmed</c> after both
/// sides report they have swapped at the mint.
///
/// <para>
/// Mock-only — never compiled into the real engine. The real engine persists
/// trades in a Sekiban aggregate with full schnorr-authenticated party ids;
/// the mock is a byte relay and does not verify identities.
/// </para>
/// </summary>
public class InMemoryTradeRegistry
{
    private readonly ConcurrentDictionary<Guid, TradeRecord> _trades = new();

    public sealed record TradeRecord(
        Guid TradeId,
        string SellerPubkey,
        string BuyerPubkey,
        DateTimeOffset SellerLocktime,
        DateTimeOffset BuyerLocktime,
        HashSet<string> ConfirmedBy,
        bool Confirmed);

    /// <summary>
    /// Register a freshly-matched trade. Sets asymmetric locktimes that match
    /// the protocol invariant (seller lock shorter than buyer lock so the
    /// buyer can extract <c>t</c> after the seller spends). The values are
    /// arbitrary in the mock — the seller's atomic-swap driver only checks
    /// they are positive timestamps.
    /// </summary>
    public TradeRecord Register(Guid tradeId, string sellerPubkey, string buyerPubkey)
    {
        var now = DateTimeOffset.UtcNow;
        var record = new TradeRecord(
            tradeId, sellerPubkey, buyerPubkey,
            SellerLocktime: now.AddHours(1),
            BuyerLocktime: now.AddHours(2),
            ConfirmedBy: [],
            Confirmed: false);
        return _trades.GetOrAdd(tradeId, record);
    }

    public TradeRecord? TryGet(Guid tradeId)
        => _trades.TryGetValue(tradeId, out var r) ? r : null;

    /// <summary>
    /// Record a <c>settlement-complete</c> confirmation from one party. Returns
    /// true when this call completes the trade (both parties have now
    /// confirmed) so the hub knows whether to broadcast
    /// <c>TradeStateChanged → Confirmed</c>. Idempotent per pubkey.
    /// </summary>
    public bool ConfirmAndMaybeFinalize(Guid tradeId, string fromPubkey)
    {
        if (!_trades.TryGetValue(tradeId, out var existing)) return false;
        lock (existing.ConfirmedBy)
        {
            if (existing.Confirmed) return false;
            existing.ConfirmedBy.Add(fromPubkey);
            var bothIn = existing.ConfirmedBy.Contains(existing.SellerPubkey)
                         && existing.ConfirmedBy.Contains(existing.BuyerPubkey);
            if (!bothIn) return false;

            _trades[tradeId] = existing with { Confirmed = true };
            return true;
        }
    }
}
