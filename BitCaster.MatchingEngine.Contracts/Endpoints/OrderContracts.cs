using BitCaster.MatchingEngine.Contracts.Domain;

namespace BitCaster.MatchingEngine.Contracts.Endpoints;

public record SubmitOrderRequest(
    string MarketId,
    string OutcomeId,
    OrderSide Side,
    OrderType Type,
    int? Price,
    long AmountSats,
    string UserId);

public record SubmitOrderResponse(
    Guid OrderId,
    string Status,
    long RemainingAmountSats,
    List<Fill> Fills);
