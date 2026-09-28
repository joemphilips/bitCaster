using System.Text.Json;
using BitCaster.MatchingEngine.Contracts.Json;
using Xunit;

namespace BitCaster.MatchingEngine.Contracts.Tests.Json;

public sealed class OpenApiJsonStringEnumConverterTests
{
    [Fact]
    public void OpenApiEnumConverterAcceptsOnlyCanonicalCasing()
    {
        var options = new JsonSerializerOptions();
        options.Converters.Add(new OpenApiJsonStringEnumConverter<
            BitCaster.MatchingEngine.Contracts.BaseAsset>());

        Assert.Equal(
            BitCaster.MatchingEngine.Contracts.BaseAsset.Sat,
            JsonSerializer.Deserialize<BitCaster.MatchingEngine.Contracts.BaseAsset>(
                "\"sat\"", options));
        Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<BitCaster.MatchingEngine.Contracts.BaseAsset>(
                "\"SAT\"", options));
    }
}
