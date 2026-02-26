namespace BitCaster.MatchingEngine.Contracts.Domain;

public record Fill(
    Guid Id,
    Guid TakerOrderId,
    Guid MakerOrderId,
    long AmountSats,
    int ExecutionPrice,
    MatchPath Path,
    DateTimeOffset FilledAt);

public enum MatchPath { Direct, Complementary }

public record MatchResult(List<Fill> Fills, long RemainingSats);
