using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace BitCaster.InMemoryMatchingEngine;

public record LnBitsWallet(string Id, string AdminKey, string InvoiceKey);

public class LnBitsWalletManager
{
    private readonly ConcurrentDictionary<string, LnBitsWallet> _wallets = new();
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IConfiguration _config;
    private readonly ILogger<LnBitsWalletManager> _logger;

    private static readonly JsonSerializerOptions CamelCaseJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public LnBitsWalletManager(
        IHttpClientFactory httpClientFactory,
        IConfiguration config,
        ILogger<LnBitsWalletManager> logger)
    {
        _httpClientFactory = httpClientFactory;
        _config = config;
        _logger = logger;
    }

    public async Task<LnBitsWallet> CreateWallet(string marketId)
    {
        var client = _httpClientFactory.CreateClient("lnbits");
        using var response = await client.PostAsJsonAsync("/api/v1/account", new { name = marketId });
        response.EnsureSuccessStatusCode();

        var body = await response.Content.ReadFromJsonAsync<LnBitsAccountResponse>(CamelCaseJson);
        var wallet = new LnBitsWallet(body!.Id, body.Adminkey, body.Inkey);
        _wallets[marketId] = wallet;

        _logger.LogInformation("Created LNBits wallet for market {MarketId}", marketId);
        return wallet;
    }

    public LnBitsWallet? GetWallet(string marketId)
    {
        _wallets.TryGetValue(marketId, out var wallet);
        return wallet;
    }

    public async Task<string> CreateInvoiceAsync(LnBitsWallet wallet, long amountSats, string memo)
    {
        var client = _httpClientFactory.CreateClient("lnbits");
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/payments");
        request.Headers.Add("X-Api-Key", wallet.InvoiceKey);
        request.Content = JsonContent.Create(new
        {
            @out = false,
            amount = amountSats,
            memo,
        });

        using var response = await client.SendAsync(request);
        if (!response.IsSuccessStatusCode)
        {
            var error = await response.Content.ReadAsStringAsync();
            throw new HttpRequestException($"LNBits create invoice failed: {error}");
        }

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return body.GetProperty("payment_request").GetString()!;
    }

    public async Task<bool> SimulatePayInvoiceAsync(LnBitsWallet wallet, string bolt11)
    {
        var client = _httpClientFactory.CreateClient("lnbits");
        var adminToken = await AuthenticateAdminAsync(client);
        await TopUpAsync(client, adminToken, wallet.Id, amountSats: 1_000_000);

        using var payRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/payments");
        payRequest.Headers.Add("X-Api-Key", wallet.AdminKey);
        payRequest.Content = JsonContent.Create(new
        {
            @out = true,
            bolt11,
        });

        using var payResponse = await client.SendAsync(payRequest);
        return payResponse.IsSuccessStatusCode;
    }

    private async Task<string> AuthenticateAdminAsync(HttpClient client)
    {
        using var response = await client.PostAsJsonAsync("/api/v1/auth", new
        {
            username = _config["LNBITS_ADMIN_USERNAME"] ?? "admin",
            password = _config["LNBITS_ADMIN_PASSWORD"] ?? "adminpass",
        });
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException("Failed to authenticate with LNBits admin");

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return body.GetProperty("access_token").GetString()!;
    }

    private static async Task TopUpAsync(HttpClient client, string adminToken, string walletId, long amountSats)
    {
        using var request = new HttpRequestMessage(HttpMethod.Put, "/admin/api/v1/topup/");
        request.Headers.Add("Authorization", $"Bearer {adminToken}");
        request.Content = JsonContent.Create(new { id = walletId, amount = amountSats });

        using var response = await client.SendAsync(request);
        if (!response.IsSuccessStatusCode)
        {
            var error = await response.Content.ReadAsStringAsync();
            throw new HttpRequestException($"LNBits topup failed: {error}");
        }
    }

    private record LnBitsAccountResponse(
        string Id,
        string Name,
        string Adminkey,
        string Inkey,
        [property: JsonPropertyName("balance_msat")] long BalanceMsat);
}
