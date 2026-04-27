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
    /// the protocol invariant <c>T_YES &gt; T_sat + Δ</c> — the seller's
    /// (Alice's) YES-proof locktime is LONGER than the buyer's (Bob's) sat
    /// locktime, so that Bob has time to extract <c>t</c> from Alice's mint
    /// spend before his own refund window opens. See
    /// bitCaster/bitCaster-doc/src/content/docs/technical/protocol/atomic-swap.md
    /// §"Locktime Constraints". The 1h gap is arbitrary in the mock — the
    /// real engine uses a 30-second gap — but the ordering must agree with
    /// the engine so frontend devs running against the mock see the same
    /// shape.
    /// </summary>
    public TradeRecord Register(Guid tradeId, string sellerPubkey, string buyerPubkey)
    {
        var now = DateTimeOffset.UtcNow;
        var record = new TradeRecord(
            tradeId, sellerPubkey, buyerPubkey,
            SellerLocktime: now.AddHours(2),
            BuyerLocktime: now.AddHours(1),
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
