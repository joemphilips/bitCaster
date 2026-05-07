using System.Net.Http.Json;
using System.Text.Json;

namespace BitCaster.E2ETest;

public class PaymentEndpointTests : IAsyncLifetime
{
    public async Task InitializeAsync()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        await Task.WhenAll(
            TestHelpers.WaitForService(httpClient, $"{TestPorts.MintUrl}/v1/info", "Mint"),
            TestHelpers.WaitForService(httpClient, $"{TestPorts.ServerUrl}/health", "Matching Engine"),
            TestHelpers.WaitForService(httpClient, $"{TestPorts.LnBitsUrl}/api/v1/health", "LNBits"));
    }

    public Task DisposeAsync() => Task.CompletedTask;

    [Fact]
    public async Task CreatePaymentRequest_AndSimulatePayment_Succeeds()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };

        // 1. Fetch a real condition from the mint
        var mintResponse = await httpClient.GetAsync($"{TestPorts.MintUrl}/v1/conditions");
        Assert.True(mintResponse.IsSuccessStatusCode, "Failed to fetch conditions from mint");
        var mintBody = await mintResponse.Content.ReadAsStringAsync();
        using var mintDoc = JsonDocument.Parse(mintBody);
        var firstCondition = mintDoc.RootElement.GetProperty("conditions").EnumerateArray().First();
        var conditionId = firstCondition.GetProperty("condition_id").GetString()!;

        // Extract outcomes from the seeded condition
        var partition = firstCondition.GetProperty("partitions").EnumerateArray().First()
            .GetProperty("partition");
        var outcomeNames = partition.EnumerateArray().Select(p => p.GetString()!).ToList();
        var probPerOutcome = 100 / outcomeNames.Count;
        var outcomes = outcomeNames.Select((name, i) => new
        {
            name,
            probability = i == outcomeNames.Count - 1
                ? 100 - probPerOutcome * (outcomeNames.Count - 1)
                : probPerOutcome,
        }).ToArray();

        // 2. Create a market on the matching engine
        var metadata = JsonSerializer.Serialize(new
        {
            title = "Payment E2E Test Market",
            description = "Testing bolt11 payment flow",
            outcomes,
            liquiditySats = 1000,
            categoryTags = new[] { "test" },
        });

        var formContent = new MultipartFormDataContent();
        formContent.Add(new StringContent(metadata), "metadata");

        var createResponse = await httpClient.PostAsync(
            $"{TestPorts.ServerUrl}/api/v1/markets/{conditionId}",
            formContent);

        // Accept 200 (created) or 409 (already exists from prior run)
        Assert.True(
            createResponse.IsSuccessStatusCode || createResponse.StatusCode == System.Net.HttpStatusCode.Conflict,
            $"createMarket failed: {createResponse.StatusCode} {await createResponse.Content.ReadAsStringAsync()}");

        var marketId = $"{conditionId}-{outcomeNames[0]}";

        // 3. Create a payment request (bolt11 invoice)
        var paymentReqResponse = await httpClient.PostAsJsonAsync(
            $"{TestPorts.ServerUrl}/api/v1/markets/{marketId}/payment-requests",
            new { amountSats = 100 });

        Assert.True(paymentReqResponse.IsSuccessStatusCode,
            $"createPaymentRequest failed: {paymentReqResponse.StatusCode} {await paymentReqResponse.Content.ReadAsStringAsync()}");

        var paymentReqBody = await paymentReqResponse.Content.ReadFromJsonAsync<JsonElement>();
        var bolt11 = paymentReqBody.GetProperty("bolt11").GetString()!;

        // bolt11 invoices start with "lnbc" (mainnet) — LNBits FakeWallet generates mainnet-formatted invoices
        Assert.StartsWith("lnbc", bolt11);

        // 4. Simulate payment using the dev-only endpoint
        var simulateResponse = await httpClient.PostAsJsonAsync(
            $"{TestPorts.ServerUrl}/api/v1/markets/{marketId}/simulate-payment",
            new { bolt11 });

        Assert.True(simulateResponse.IsSuccessStatusCode,
            $"simulatePayment failed: {simulateResponse.StatusCode} {await simulateResponse.Content.ReadAsStringAsync()}");

        var simulateBody = await simulateResponse.Content.ReadFromJsonAsync<JsonElement>();
        var paid = simulateBody.GetProperty("paid").GetBoolean();

        Assert.True(paid, "Expected simulated payment to succeed");
    }
}
