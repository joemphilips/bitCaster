namespace BitCaster.InMemoryMatchingEngine.Hubs;

internal static class TradeMessageTypes
{
    public const string AdaptorPoint = "adaptor-point";
    public const string LockedProofsSeller = "locked-proofs-seller";
    public const string LockedProofsBuyer = "locked-proofs-buyer";
    public const string SettlementComplete = "settlement-complete";
}
