using BitCaster.MatchingEngine.Contracts;

namespace BitCaster.InMemoryMatchingEngine.Endpoints;

public static class ParticipationScoreEndpoints
{
    public static void MapParticipationScoreEndpoints(this WebApplication app)
    {
        app.MapGet("/api/v1/participation-score", () =>
            Results.Ok(new ParticipationScoreResponse(
                pubkey: "mock-pubkey",
                balance: 0,
                purchasedTotal: 0,
                consumedTotal: 0,
                penaltyTotal: 0,
                matchDebitScore: 1,
                enabled: false)));

        app.MapPost("/api/v1/participation-score/ecash", () =>
            Results.Problem("Participation Score is disabled in the in-memory mock engine.", statusCode: 409));
    }
}
