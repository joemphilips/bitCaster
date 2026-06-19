namespace BitCaster.E2ETest;

public class AsyncApiContractTests
{
    [Fact]
    public void AsyncApi_DocumentsTradeCreatedCanonicalSettlementTailFields()
    {
        var asyncApi = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(),
            "BitCaster.MatchingEngine.Contracts",
            "specs",
            "asyncapi.yaml"));

        Assert.Contains("TradeCreatedArguments:", asyncApi, StringComparison.Ordinal);
        Assert.Contains("description: tradeId", asyncApi, StringComparison.Ordinal);
        Assert.Contains("description: quotePaymentSubunits", asyncApi, StringComparison.Ordinal);
        Assert.Contains("description: outcomeFaceAmountSubunits", asyncApi, StringComparison.Ordinal);
        Assert.Contains("description: tokenSide", asyncApi, StringComparison.Ordinal);
        Assert.Contains("maxItems: 17", asyncApi, StringComparison.Ordinal);
    }

    [Fact]
    public void AsyncApi_DocumentsMatchedDeltaCanonicalSettlementFields()
    {
        var asyncApi = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(),
            "BitCaster.MatchingEngine.Contracts",
            "specs",
            "asyncapi.yaml"));

        var matchedDeltaIndex = asyncApi.IndexOf("MatchedDelta:", StringComparison.Ordinal);
        Assert.NotEqual(-1, matchedDeltaIndex);

        var matchedDeltaSection = asyncApi[matchedDeltaIndex..asyncApi.IndexOf("\n    MarketStatusChanged:", matchedDeltaIndex, StringComparison.Ordinal)];

        Assert.Contains("baseAsset:", matchedDeltaSection, StringComparison.Ordinal);
        Assert.Contains("divisibility:", matchedDeltaSection, StringComparison.Ordinal);
        Assert.Contains("quotePaymentSubunits:", matchedDeltaSection, StringComparison.Ordinal);
        Assert.Contains("outcomeFaceAmountSubunits:", matchedDeltaSection, StringComparison.Ordinal);
        Assert.Contains("tokenSide:", matchedDeltaSection, StringComparison.Ordinal);
    }

    [Fact]
    public void AsyncApi_DocumentsCanonicalSettlementAuthority()
    {
        var asyncApi = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(),
            "BitCaster.MatchingEngine.Contracts",
            "specs",
            "asyncapi.yaml"));

        Assert.Contains("`quotePaymentSubunits + baseAsset + divisibility`", asyncApi, StringComparison.Ordinal);
        Assert.Contains("`quotePaymentSats` is legacy", asyncApi, StringComparison.Ordinal);
    }

    private static string FindRepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "BitCaster.MatchingEngine.Contracts", "specs", "asyncapi.yaml")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException("Could not locate bitCaster repository root.");
    }
}
