namespace BitCaster.MatchingEngine.Contracts.Domain;

public record OrderBookSnapshot(string MarketId, Dictionary<string, OutcomeSnapshot> Outcomes);

public record OutcomeSnapshot(LevelDto[] Bids, LevelDto[] Asks, int? Spread);

public record LevelDto(int Price, long Amount);
