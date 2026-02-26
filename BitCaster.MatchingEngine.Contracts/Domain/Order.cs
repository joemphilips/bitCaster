namespace BitCaster.MatchingEngine.Contracts.Domain;

public record Order(
    Guid Id,
    string MarketId,
    string OutcomeId,
    OrderSide Side,
    OrderType Type,
    int? Price,
    long AmountSats,
    string UserId,
    DateTimeOffset PlacedAt)
{
    public long RemainingAmountSats { get; set; } = AmountSats;
}

public enum OrderSide { Buy, Sell }

public enum OrderType { Limit, Market }
