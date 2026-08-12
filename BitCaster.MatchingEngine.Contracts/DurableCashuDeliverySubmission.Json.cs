using System.Text.Json.Serialization;

namespace BitCaster.MatchingEngine.Contracts;

/// <summary>Rejects fields outside the public durable-delivery contract.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public partial class DurableCashuDeliverySubmission;
