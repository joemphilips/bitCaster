namespace BitCaster.E2ETest;

public static class E2ECollections
{
    public const string LiveServiceMutation = "Live service mutation";
}

/// <summary>
/// Serializes classes that mutate shared docker-compose services: the matching
/// engine order/market state, the mint ledger, cashu.me wallet state, local
/// relay announcements, or daemon processes. Other browser-only classes use
/// isolated contexts and route stubs, so they can keep the default per-class
/// collections and run in parallel.
/// </summary>
[CollectionDefinition(E2ECollections.LiveServiceMutation)]
public sealed class LiveServiceMutationCollection;
