using BitCaster.MatchingEngine.Contracts.Domain;

namespace BitCaster.MatchingEngine.Contracts.Endpoints;

/// <summary>
/// Request body for submitting a new order to the matching engine.
/// </summary>
/// <param name="MarketId">The condition_id of the target market.</param>
/// <param name="OutcomeId">The outcome to trade (e.g. "YES", "NO").</param>
/// <param name="Side">Buy or sell direction.</param>
/// <param name="Type">Limit or market order type.</param>
/// <param name="Price">Probability price in [1,99]. Required for limit orders, ignored for market orders.</param>
/// <param name="AmountSats">Order size in satoshis. Must be positive.</param>
/// <param name="UserId">Opaque user identifier (e.g. Nostr pubkey hex).</param>
public record SubmitOrderRequest(
    string MarketId,
    string OutcomeId,
    OrderSide Side,
    OrderType Type,
    Probability? Price,
    Sats AmountSats,
    string UserId);

/// <summary>
/// Response returned after an order is submitted to the matching engine.
/// </summary>
/// <param name="OrderId">The unique identifier assigned to this order.</param>
/// <param name="Status">
/// One of: "filled" (fully matched), "partially_filled" (some matches, remainder resting or cancelled),
/// "resting" (limit order on book, no matches yet), "cancelled" (market order with no matches).
/// </param>
/// <param name="RemainingAmountSats">Unfilled satoshi amount after matching.</param>
/// <param name="Fills">List of fills produced by this order. Empty if no matches.</param>
public record SubmitOrderResponse(
    Guid OrderId,
    string Status,
    Sats RemainingAmountSats,
    List<Fill> Fills);
