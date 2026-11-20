using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Xunit;

namespace BitCaster.MatchingEngine.Contracts.Tests.Json;

/// <summary>
/// The order request has only the admission form, and <c>settlementCapabilityAdmission</c>
/// is required. The server refuses a body with the removed <c>settlementCapability</c>
/// reference form with <c>410 order-reference-form-removed</c>, so the contract has no
/// property for that form. The fixture of the previous form stays, and the current
/// contract does not read it as a request.
/// </summary>
public sealed class SubmitOrderRequestContractTests
{
    private static readonly string[] RequestProperties = ["comment", "settlementCapabilityAdmission", "walletId"];

    private static readonly string[] AdmissionProperties =
        ["artifact", "clientOrderId", "marketId", "orderIntent", "stageIdempotencyKey"];

    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    /// <summary>
    /// A strict reader: every constructor parameter must be present, a non-nullable
    /// member must not be null, and an unknown member is refused
    /// (<c>additionalProperties: false</c>). It is stricter than the schema: the
    /// generated constructor has no default for <c>walletId</c>, so this reader also
    /// requires <c>walletId</c>, which the schema leaves optional. The tests send it.
    /// </summary>
    private static readonly JsonSerializerOptions SchemaOptions = new(JsonSerializerDefaults.Web)
    {
        RespectRequiredConstructorParameters = true,
        RespectNullableAnnotations = true,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    [Fact]
    public void TheRequestHasNoReferenceFormProperty()
    {
        var properties = Options.GetTypeInfo(typeof(SubmitOrderRequest)).Properties
            .Select(property => property.Name)
            .Order(StringComparer.Ordinal);

        Assert.Equal(RequestProperties, properties);
        Assert.Null(typeof(SubmitOrderRequest).GetProperty("SettlementCapability"));
    }

    [Fact]
    public void TheAdmissionFormIsRequiredAndNotNullable()
    {
        var nullability = new NullabilityInfoContext();
        var type = typeof(SubmitOrderRequest);
        var admission = Assert.Single(
            Assert.Single(type.GetConstructors()).GetParameters(),
            parameter => parameter.Name == "settlementCapabilityAdmission");

        Assert.False(admission.HasDefaultValue);
        Assert.Equal(NullabilityState.NotNull, nullability.Create(admission).WriteState);
        Assert.Equal(
            NullabilityState.NotNull,
            nullability.Create(type.GetProperty(nameof(SubmitOrderRequest.SettlementCapabilityAdmission))!).ReadState);
        Assert.Equal(
            NullabilityState.Nullable,
            nullability.Create(type.GetProperty(nameof(SubmitOrderRequest.Comment))!).ReadState);
        Assert.Equal(
            NullabilityState.Nullable,
            nullability.Create(type.GetProperty(nameof(SubmitOrderRequest.WalletId))!).ReadState);

        var withoutAdmission = Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<SubmitOrderRequest>(
                """{"comment":null,"walletId":null}""",
                SchemaOptions));
        Assert.Contains("'settlementCapabilityAdmission'", withoutAdmission.Message, StringComparison.Ordinal);
        var nullAdmission = Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<SubmitOrderRequest>(
                """{"settlementCapabilityAdmission":null,"comment":null,"walletId":null}""",
                SchemaOptions));
        Assert.Contains("'settlementCapabilityAdmission'", nullAdmission.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TheSerializedRequestCarriesOnlyTheAdmissionForm()
    {
        var request = new SubmitOrderRequest(
            comment: null,
            settlementCapabilityAdmission: new CreateSettlementCapabilityRequest(
                artifact: [1, 2, 3],
                clientOrderId: "client-order-1",
                marketId: $"{new string('c', 64)}-YES",
                orderIntent: new SettlementOrderIntent(
                    amountSubunits: 1_000,
                    baseAsset: BaseAsset.Sat,
                    collateralUnit: CollateralUnit.Msat,
                    expiresAt: null,
                    maxQuotePaymentSubunits: null,
                    minimumFillAmountSubunits: 1_000,
                    minQuotePaymentSubunits: 600,
                    outcomeId: "YES",
                    price: 600,
                    side: OrderSide.Sell,
                    timeInForce: SettlementCapabilityTimeInForce.FOK,
                    tokenSide: TokenSide.Outcome),
                stageIdempotencyKey: "stage-1"),
            walletId: new string('b', 64));

        var body = JsonSerializer.SerializeToNode(request, Options)!.AsObject();

        Assert.Equal(RequestProperties, body.Select(property => property.Key).Order(StringComparer.Ordinal));
        Assert.Equal(
            AdmissionProperties,
            body["settlementCapabilityAdmission"]!.AsObject().Select(property => property.Key)
                .Order(StringComparer.Ordinal));
        Assert.Equal("AQID", body["settlementCapabilityAdmission"]!["artifact"]!.GetValue<string>());
        Assert.Null(body["comment"]);
        Assert.Equal(new string('b', 64), body["walletId"]!.GetValue<string>());

        var read = JsonSerializer.Deserialize<SubmitOrderRequest>(body.ToJsonString(), SchemaOptions)!;
        Assert.Equal("stage-1", read.SettlementCapabilityAdmission.StageIdempotencyKey);
        Assert.Equal("client-order-1", read.SettlementCapabilityAdmission.ClientOrderId);
        Assert.Equal(new byte[] { 1, 2, 3 }, read.SettlementCapabilityAdmission.Artifact);
    }

    [Fact]
    public void ThePreviousReferenceFormDoesNotReadAsARequest()
    {
        var body = File.ReadAllText(Path.Combine(
            AppContext.BaseDirectory, "Fixtures", "PreviousForms", "submit-order-request.release5a-reference-form.json"));

        // The reference form is an unknown member of the current request.
        var unknownReference = Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<SubmitOrderRequest>(body, SchemaOptions));
        Assert.Contains("'settlementCapability'", unknownReference.Message, StringComparison.Ordinal);
        // Without that member, the body still has no admission form.
        var withoutAdmission = Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<SubmitOrderRequest>(
                body,
                new JsonSerializerOptions(SchemaOptions) { UnmappedMemberHandling = JsonUnmappedMemberHandling.Skip }));
        Assert.Contains("'settlementCapabilityAdmission'", withoutAdmission.Message, StringComparison.Ordinal);
    }
}
