using System.Collections.Concurrent;
using BitCaster.MatchingEngine.Contracts;

namespace BitCaster.InMemoryMatchingEngine.Endpoints;

/// <summary>
/// Stub endpoints for the deposit/funding flow. The mock records each deposit
/// in memory and auto-transitions through the lifecycle on a short delay so
/// the frontend wizard's polling UX has realistic states to render against.
///
/// Per the submodule-independence rule (bitCaster/AGENTS.md), this mock is
/// not a fidelity reimplementation — it is the smallest behaviour that
/// makes the frontend dev/test loop work.
/// </summary>
public static class DepositEndpoints
{
    private static readonly ConcurrentDictionary<Guid, MockDeposit> Deposits = new();
    private static readonly TimeSpan AutoCreditDelay = TimeSpan.FromSeconds(2);

    public static void MapDepositEndpoints(this WebApplication app)
    {
        app.MapPost("/api/v1/markets/{conditionId}/deposit/ln-invoice", (
            string conditionId,
            RequestLnInvoiceDepositRequest req) =>
        {
            if (req.AmountSats < 1)
                return Results.BadRequest(new { error = "amountSats must be >= 1" });

            var depositId = Guid.NewGuid();
            var now = DateTimeOffset.UtcNow;
            var expiresAt = now.AddMinutes(5);
            Deposits[depositId] = new MockDeposit(
                depositId,
                conditionId,
                DepositState.Requested,
                DepositMethod.LightningInvoice,
                req.AmountSats,
                now,
                now,
                expiresAt,
                FailureReason: null);
            // Plausible-but-fake bolt11 — long enough to look real to UI components,
            // never actually decodes.
            var fakeBolt11 = $"lnbcrt{req.AmountSats}n1pq{depositId:N}stub";
            return Results.Ok(new RequestLnInvoiceDepositResponse(fakeBolt11, depositId, expiresAt));
        });

        app.MapPost("/api/v1/markets/{conditionId}/deposit/ecash", (
            string conditionId,
            RequestEcashDepositRequest req) =>
        {
            if (req.AmountSats < 1)
                return Results.BadRequest(new { error = "amountSats must be >= 1" });
            if (string.IsNullOrWhiteSpace(req.ProofsToken))
                return Results.BadRequest(new { error = "proofsToken is required" });

            var depositId = Guid.NewGuid();
            var now = DateTimeOffset.UtcNow;
            // Ecash skips Requested → Paid (we trust the caller) and lets the
            // mock's auto-transition timer credit it.
            Deposits[depositId] = new MockDeposit(
                depositId,
                conditionId,
                DepositState.Paid,
                DepositMethod.Ecash,
                req.AmountSats,
                now,
                now,
                ExpiresAt: null,
                FailureReason: null);
            return Results.Ok(new RequestEcashDepositResponse(depositId, DepositState.Paid));
        });

        app.MapGet("/api/v1/markets/{conditionId}/deposit/{depositId:guid}", (
            string conditionId,
            Guid depositId) =>
        {
            if (!Deposits.TryGetValue(depositId, out var deposit))
                return Results.NotFound();
            if (deposit.ConditionId != conditionId)
                return Results.NotFound();

            // Auto-credit after the configured delay so polling UIs see a
            // realistic state progression. LN invoices walk Requested → Paid
            // → Credited; ecash lands at Paid and walks → Credited.
            var now = DateTimeOffset.UtcNow;
            var elapsed = now - deposit.RequestedAt;
            var advanced = deposit;
            if (elapsed > AutoCreditDelay && deposit.State == DepositState.Requested)
            {
                advanced = deposit with { State = DepositState.Paid, UpdatedAt = now };
                Deposits[depositId] = advanced;
            }
            if (elapsed > AutoCreditDelay + AutoCreditDelay && advanced.State == DepositState.Paid)
            {
                advanced = advanced with { State = DepositState.Credited, UpdatedAt = now };
                Deposits[depositId] = advanced;
            }

            return Results.Ok(new GetDepositResponseDto(
                advanced.AmountSats,
                advanced.ConditionId,
                advanced.DepositId,
                advanced.ExpiresAt,
                advanced.FailureReason,
                advanced.Method,
                advanced.RequestedAt,
                advanced.State,
                advanced.UpdatedAt));
        });
    }

    private sealed record MockDeposit(
        Guid DepositId,
        string ConditionId,
        DepositState State,
        DepositMethod Method,
        long AmountSats,
        DateTimeOffset RequestedAt,
        DateTimeOffset UpdatedAt,
        DateTimeOffset? ExpiresAt,
        string? FailureReason);
}
