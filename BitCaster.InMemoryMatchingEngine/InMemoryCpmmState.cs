using System.Collections.Concurrent;
using System.Collections.Immutable;

namespace BitCaster.InMemoryMatchingEngine;

/// <summary>
/// In-memory surrogate for the real engine's
/// <c>EngineWalletAggregate</c> + <c>CpmmPool</c> event-sourced state, scoped
/// to Phase 1G's Frontend E2E needs.
///
/// <para>
/// The real engine holds CTF reserves in Sekiban (see
/// <c>EngineWalletService</c> + <c>CpmmSettlementService</c>). The mock has no
/// Sekiban runtime, so we keep everything in a <see cref="ConcurrentDictionary{TKey, TValue}"/>
/// keyed by <c>(conditionId, outcome)</c>. This is a test double only — it
/// is never compiled into the production ApiService. Callers interact via
/// <see cref="BitCaster.InMemoryMatchingEngine.Endpoints.OrderEndpoints"/>
/// and the dev-only simulate-payment endpoint.
/// </para>
///
/// <para>
/// Capped-loss still holds in the mock: a settlement call that would
/// overdraw the reserve is rejected with <c>InsufficientCpmmReserve</c>,
/// symmetric with <c>CpmmSettlementService.SettleAsync</c>.
/// </para>
/// </summary>
public class InMemoryCpmmState
{
    /// <summary>
    /// Deterministic fake engine pubkey — 33-byte compressed secp256k1 value
    /// (66 hex chars, "02"/"03" prefix) returned from
    /// <c>GET /api/v1/engine/pubkey</c>. The frontend validates this with
    /// <c>^(02|03)[0-9a-fA-F]{64}$</c> before using it to P2PK-lock proofs —
    /// a short/invalid string would fail that check and break the CPMM
    /// funding path. The value is otherwise arbitrary; the mock never signs.
    /// </summary>
    public const string EnginePubkey = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

    private readonly ConcurrentDictionary<string, PoolState> _pools = new();

    // userPubkey -> (marketId -> PositionRecord)
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, PositionRecord>> _positions = new();

    public sealed class PoolState
    {
        public required string MarketId { get; init; }
        public PoolStatus Status { get; set; } = PoolStatus.AwaitingFunding;
        public long DeclaredSats { get; set; }
        public DateTimeOffset? LastUpdatedAt { get; set; }

        /// <summary>
        /// Outcome -> CTF reserve balance held by the engine, denominated in
        /// outcome-tokens (the unit the buyer receives). Initialised by
        /// <see cref="InMemoryCpmmState.MarkActive"/> and decremented by
        /// <see cref="InMemoryCpmmState.TryConsumeReserve"/>.
        /// </summary>
        public ImmutableDictionary<string, long> Reserves { get; set; } =
            ImmutableDictionary<string, long>.Empty;
    }

    public sealed record PositionRecord(
        string MarketId,
        string Outcome,
        long TokenAmount,
        long TotalCostSats,
        DateTimeOffset LastUpdated);

    public enum PoolStatus
    {
        AwaitingFunding,
        Active,
        Frozen,
    }

    public PoolState GetOrCreatePool(string marketId, long declaredSats = 0)
    {
        return _pools.GetOrAdd(marketId, id => new PoolState
        {
            MarketId = id,
            DeclaredSats = declaredSats,
        });
    }

    public PoolState? TryGetPool(string marketId)
        => _pools.TryGetValue(marketId, out var p) ? p : null;

    /// <summary>
    /// Flip a pool to <see cref="PoolStatus.Active"/> with a given per-outcome
    /// reserve map. Mirrors the real engine's <c>CpmmPoolFunded</c> transition
    /// (see <c>PaymentSettlementWorker</c>) without talking to LNBits or a mint.
    /// Used by the dev-only simulate-payment endpoint so the E2E can seed a
    /// funded pool in O(1).
    /// </summary>
    public PoolState MarkActive(string marketId, long declaredSats, IReadOnlyDictionary<string, long> reserves)
    {
        var pool = GetOrCreatePool(marketId, declaredSats);
        lock (pool)
        {
            pool.DeclaredSats = declaredSats;
            pool.Status = PoolStatus.Active;
            pool.Reserves = reserves.ToImmutableDictionary();
            pool.LastUpdatedAt = DateTimeOffset.UtcNow;
        }
        return pool;
    }

    public enum ReserveResult { Success, PoolNotFound, NotActive, UnknownOutcome, Insufficient }

    /// <summary>
    /// Atomically check-and-decrement the engine's CTF reserve for the given
    /// outcome. Returns the new reserve amount on success, or a non-Success
    /// <see cref="ReserveResult"/> describing why the settlement cannot proceed.
    /// Symmetric with <c>CpmmSettlementService</c>'s capped-loss gate.
    /// </summary>
    public (ReserveResult Outcome, long NewReserve) TryConsumeReserve(
        string marketId, string outcome, long tokenAmount)
    {
        if (!_pools.TryGetValue(marketId, out var pool))
            return (ReserveResult.PoolNotFound, 0);

        lock (pool)
        {
            if (pool.Status != PoolStatus.Active)
                return (ReserveResult.NotActive, 0);

            if (!pool.Reserves.TryGetValue(outcome, out var current))
                return (ReserveResult.UnknownOutcome, 0);

            if (current < tokenAmount)
                return (ReserveResult.Insufficient, current);

            var next = current - tokenAmount;
            pool.Reserves = pool.Reserves.SetItem(outcome, next);
            pool.LastUpdatedAt = DateTimeOffset.UtcNow;
            return (ReserveResult.Success, next);
        }
    }

    /// <summary>
    /// Accrue (or create) a user's position for a given (marketId, outcome)
    /// tuple. Mirrors the real engine's <c>AccruePositionCommand</c> path —
    /// positive deltas on buys, negative on sells. Phase 1G only exercises
    /// the buy path.
    /// </summary>
    public PositionRecord ApplyPositionDelta(
        string userPubkey,
        string marketId,
        string outcome,
        long deltaTokens,
        long deltaCostSats)
    {
        var byMarket = _positions.GetOrAdd(userPubkey,
            _ => new ConcurrentDictionary<string, PositionRecord>());

        return byMarket.AddOrUpdate(
            marketId,
            _ => new PositionRecord(marketId, outcome, deltaTokens, deltaCostSats, DateTimeOffset.UtcNow),
            (_, existing) => existing with
            {
                TokenAmount = existing.TokenAmount + deltaTokens,
                TotalCostSats = existing.TotalCostSats + deltaCostSats,
                LastUpdated = DateTimeOffset.UtcNow,
            });
    }

    public IReadOnlyList<PositionRecord> GetPositions(string userPubkey)
    {
        if (!_positions.TryGetValue(userPubkey, out var byMarket))
            return Array.Empty<PositionRecord>();
        return byMarket.Values.ToArray();
    }
}
