using System.Text.Json;
using BitCaster.MatchingEngine.Contracts.Json;
using Xunit;

namespace BitCaster.MatchingEngine.Contracts.Tests.Json;

/// <summary>
/// A client of the contract must accept every <c>MatchPath</c> value,
/// including <c>Merge</c>, which the engine does not send yet.
/// </summary>
public sealed class MatchPathContractTests
{
    [Theory]
    [InlineData("Complementary", MatchPath.Complementary)]
    [InlineData("Mint", MatchPath.Mint)]
    [InlineData("Merge", MatchPath.Merge)]
    public void MatchPathReadsAndWritesEveryContractValue(string wire, MatchPath expected)
    {
        var options = Options();

        Assert.Equal(expected, JsonSerializer.Deserialize<MatchPath>($"\"{wire}\"", options));
        Assert.Equal($"\"{wire}\"", JsonSerializer.Serialize(expected, options));
    }

    [Theory]
    [InlineData("merge")]
    [InlineData("MERGE")]
    [InlineData("DirectSwap")]
    [InlineData("Split")]
    public void MatchPathRefusesAnyOtherValue(string wire)
    {
        Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<MatchPath>($"\"{wire}\"", Options()));
    }

    private static JsonSerializerOptions Options()
    {
        var options = new JsonSerializerOptions();
        options.Converters.Add(new OpenApiJsonStringEnumConverter<MatchPath>());
        return options;
    }
}
