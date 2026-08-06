using System.Text.Json.Serialization;
using BitCaster.MatchingEngine.Contracts.Json;

namespace BitCaster.MatchingEngine.Contracts;

/// <summary>
/// A monitored asset identity in an asset-monitoring report.
/// </summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record Asset
{
    [JsonConstructor]
    public Asset(
        Uri canonicalMintUrl,
        AssetMonitoringAssetKind kind,
        AssetMonitoringUnit cashuUnit,
        AssetMonitoringUnit displayBaseAsset,
        string? conditionId = null,
        string? parentConditionId = null,
        string? outcomeUniverseDigest = null,
        string? internalOutcomeSetId = null)
    {
        ArgumentNullException.ThrowIfNull(canonicalMintUrl);
        ValidateConditionalFields(
            kind,
            conditionId,
            parentConditionId,
            outcomeUniverseDigest,
            internalOutcomeSetId);

        CanonicalMintUrl = canonicalMintUrl;
        Kind = kind;
        CashuUnit = cashuUnit;
        DisplayBaseAsset = displayBaseAsset;
        ConditionId = conditionId;
        ParentConditionId = parentConditionId;
        OutcomeUniverseDigest = outcomeUniverseDigest;
        InternalOutcomeSetId = internalOutcomeSetId;
    }

    [JsonRequired]
    [JsonPropertyName("canonicalMintUrl")]
    public Uri CanonicalMintUrl { get; init; }

    [JsonRequired]
    [JsonPropertyName("kind")]
    [JsonConverter(typeof(OpenApiJsonStringEnumConverter<AssetMonitoringAssetKind>))]
    public AssetMonitoringAssetKind Kind { get; init; }

    [JsonRequired]
    [JsonPropertyName("cashuUnit")]
    [JsonConverter(typeof(OpenApiJsonStringEnumConverter<AssetMonitoringUnit>))]
    public AssetMonitoringUnit CashuUnit { get; init; }

    [JsonRequired]
    [JsonPropertyName("displayBaseAsset")]
    [JsonConverter(typeof(OpenApiJsonStringEnumConverter<AssetMonitoringUnit>))]
    public AssetMonitoringUnit DisplayBaseAsset { get; init; }

    [JsonPropertyName("conditionId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ConditionId { get; init; }

    [JsonPropertyName("parentConditionId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ParentConditionId { get; init; }

    [JsonPropertyName("outcomeUniverseDigest")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? OutcomeUniverseDigest { get; init; }

    [JsonPropertyName("internalOutcomeSetId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? InternalOutcomeSetId { get; init; }

    private static void ValidateConditionalFields(
        AssetMonitoringAssetKind kind,
        string? conditionId,
        string? parentConditionId,
        string? outcomeUniverseDigest,
        string? internalOutcomeSetId)
    {
        var conditionalFields = new[]
        {
            conditionId,
            parentConditionId,
            outcomeUniverseDigest,
            internalOutcomeSetId,
        };

        switch (kind)
        {
            case AssetMonitoringAssetKind.Collateral when conditionalFields.Any(static value => value is not null):
                throw new ArgumentException("A collateral asset cannot contain conditional fields.", nameof(kind));
            case AssetMonitoringAssetKind.Conditional when conditionalFields.Any(string.IsNullOrWhiteSpace):
                throw new ArgumentException("A conditional asset requires all conditional fields.", nameof(kind));
            case AssetMonitoringAssetKind.Collateral:
            case AssetMonitoringAssetKind.Conditional:
                return;
            default:
                throw new ArgumentOutOfRangeException(nameof(kind));
        }
    }
}
