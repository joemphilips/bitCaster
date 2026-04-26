using System.Text.Json;

namespace BitCaster.InMemoryMatchingEngine;

/// <summary>
/// Extracts the caller's pubkey from a NIP-98 <c>Authorization: Nostr &lt;base64&gt;</c>
/// header without verifying the Schnorr signature.
///
/// <para>
/// <b>MOCK ONLY — never reference from the production ApiService.</b> The
/// real engine runs a full <c>Nip98AuthenticationHandler</c> with signature
/// verification. This shortcut is acceptable here because
/// <c>BitCaster.InMemoryMatchingEngine</c> is dev/E2E scaffolding that is
/// never deployed to staging or prod, and a malicious caller can at worst
/// impersonate themselves to a stub server.
/// </para>
/// </summary>
internal static class Nip98PubkeyExtractor
{
    public static string? TryExtract(HttpRequest request)
    {
        if (!request.Headers.TryGetValue("Authorization", out var values)) return null;
        var raw = values.ToString();
        if (string.IsNullOrEmpty(raw)) return null;
        const string scheme = "Nostr ";
        if (!raw.StartsWith(scheme, StringComparison.OrdinalIgnoreCase)) return null;
        var token = raw[scheme.Length..].Trim();
        try
        {
            var bytes = Convert.FromBase64String(token);
            using var doc = JsonDocument.Parse(bytes);
            if (doc.RootElement.TryGetProperty("pubkey", out var pk))
                return pk.GetString();
        }
        catch
        {
            // malformed token → treat as anonymous
        }
        return null;
    }
}
