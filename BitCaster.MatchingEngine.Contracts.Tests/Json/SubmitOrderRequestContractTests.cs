using System.Text.Json;
using Xunit;

namespace BitCaster.MatchingEngine.Contracts.Tests.Json;

/// <summary>
/// The order request gained the admission form. A changed public contract keeps a fixture of its previous form
/// (ADR-049 rule 5): the reference-form body that release 5a clients send must still read with the current contract.
/// </summary>
public sealed class SubmitOrderRequestContractTests
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    [Fact]
    public void ThePreviousReferenceFormStillReadsAsTheReferenceForm()
    {
        var body = File.ReadAllText(Path.Combine(
            AppContext.BaseDirectory, "Fixtures", "PreviousForms", "submit-order-request.release5a-reference-form.json"));

        var request = JsonSerializer.Deserialize<SubmitOrderRequest>(body, Options);

        Assert.NotNull(request);
        Assert.NotNull(request.SettlementCapability);
        Assert.Equal(Guid.Parse("40000000-0000-0000-0000-000000000001"), request.SettlementCapability.ArtifactId);
        Assert.Equal(new string('a', 64), request.SettlementCapability.BindingDigest);
        Assert.Null(request.SettlementCapabilityAdmission);
        Assert.Null(request.Comment);
        Assert.Equal(new string('b', 64), request.WalletId);
    }
}
