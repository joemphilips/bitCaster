using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using BitCaster.MatchingEngine.Contracts;

namespace BitCaster.E2ETest;

public class DepositContractTests
{
    [Fact]
    public void GeneratedDepositDtos_RoundTripOpenApiEnumCasing()
    {
        var depositId = Guid.NewGuid();
        var requested = new GetDepositResponseDto(
            1_000,
            "deadbeef",
            depositId,
            DateTimeOffset.UtcNow.AddMinutes(5),
            null!,
            DepositMethod.LightningInvoice,
            DateTimeOffset.UtcNow,
            DepositState.Requested,
            DateTimeOffset.UtcNow);

        var statusJson = JsonSerializer.Serialize(requested);
        using var statusDoc = JsonDocument.Parse(statusJson);
        Assert.Equal("requested", statusDoc.RootElement.GetProperty("state").GetString());
        Assert.Equal("lightningInvoice", statusDoc.RootElement.GetProperty("method").GetString());

        var paid = new RequestEcashDepositResponse(depositId, DepositState.Paid);
        var paidJson = JsonSerializer.Serialize(paid);
        using var paidDoc = JsonDocument.Parse(paidJson);
        Assert.Equal("paid", paidDoc.RootElement.GetProperty("state").GetString());

        var order = new SubmitOrderRequest(
            1_000,
            null!,
            new string('0', 66),
            "YES",
            50,
            OrderSide.Buy,
            TimeInForce.GTC,
            TokenSide.Outcome);
        var orderJson = JsonSerializer.Serialize(order);
        using var orderDoc = JsonDocument.Parse(orderJson);
        Assert.Equal("Buy", orderDoc.RootElement.GetProperty("side").GetString());
        Assert.Equal("Outcome", orderDoc.RootElement.GetProperty("tokenSide").GetString());
        Assert.Equal("GTC", orderDoc.RootElement.GetProperty("timeInForce").GetString());

        var lowerStatus = JsonSerializer.Deserialize<GetDepositResponseDto>(
            """
            {
              "amountSats": 1000,
              "conditionId": "deadbeef",
              "depositId": "11111111-1111-1111-1111-111111111111",
              "expiresAt": "2026-05-17T06:20:06.200Z",
              "failureReason": null,
              "method": "lightningInvoice",
              "requestedAt": "2026-05-17T06:05:06.200Z",
              "state": "requested",
              "updatedAt": "2026-05-17T06:05:06.200Z"
            }
            """);
        Assert.NotNull(lowerStatus);
        Assert.Equal(DepositState.Requested, lowerStatus.State);
        Assert.Equal(DepositMethod.LightningInvoice, lowerStatus.Method);

        var legacyStatus = JsonSerializer.Deserialize<GetDepositResponseDto>(
            """
            {
              "amountSats": 1000,
              "conditionId": "deadbeef",
              "depositId": "22222222-2222-2222-2222-222222222222",
              "expiresAt": null,
              "failureReason": null,
              "method": "LightningInvoice",
              "requestedAt": "2026-05-17T06:05:06.200Z",
              "state": "Requested",
              "updatedAt": "2026-05-17T06:05:06.200Z"
            }
            """);
        Assert.NotNull(legacyStatus);
        Assert.Equal(DepositState.Requested, legacyStatus.State);
        Assert.Equal(DepositMethod.LightningInvoice, legacyStatus.Method);
    }

    [Fact]
    public async Task MockDepositEndpoints_EmitOpenApiEnumCasing()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        await TestHelpers.WaitForService(httpClient, $"{TestPorts.ServerUrl}/health", "Matching Engine");

        var conditionId = Guid.NewGuid().ToString("N");
        var creatorPubkey = new string('a', 64);

        using var lnResponse = await httpClient.PostAsJsonAsync(
            $"{TestPorts.ServerUrl}/api/v1/markets/{conditionId}/deposit/ln-invoice",
            new { amountSats = 1_000, creatorPubkey, fundAmm = false });
        Assert.Equal(HttpStatusCode.OK, lnResponse.StatusCode);

        var lnBody = await lnResponse.Content.ReadAsStringAsync();
        using var lnJson = JsonDocument.Parse(lnBody);
        var lnDepositId = lnJson.RootElement.GetProperty("depositId").GetGuid();

        using var lnStatusResponse = await httpClient.GetAsync(
            $"{TestPorts.ServerUrl}/api/v1/markets/{conditionId}/deposit/{lnDepositId}");
        Assert.Equal(HttpStatusCode.OK, lnStatusResponse.StatusCode);

        var lnStatusBody = await lnStatusResponse.Content.ReadAsStringAsync();
        using var lnStatusJson = JsonDocument.Parse(lnStatusBody);
        Assert.Equal("requested", lnStatusJson.RootElement.GetProperty("state").GetString());
        Assert.Equal("lightningInvoice", lnStatusJson.RootElement.GetProperty("method").GetString());

        using var ecashResponse = await httpClient.PostAsJsonAsync(
            $"{TestPorts.ServerUrl}/api/v1/markets/{conditionId}/deposit/ecash",
            new
            {
                amountSats = 1_000,
                creatorPubkey,
                fundAmm = false,
                proofsToken = "cashuBo2FteG9jawo=",
            });
        Assert.Equal(HttpStatusCode.OK, ecashResponse.StatusCode);

        var ecashBody = await ecashResponse.Content.ReadAsStringAsync();
        using var ecashJson = JsonDocument.Parse(ecashBody);
        Assert.Equal("paid", ecashJson.RootElement.GetProperty("state").GetString());

        var ecashDepositId = ecashJson.RootElement.GetProperty("depositId").GetGuid();
        using var ecashStatusResponse = await httpClient.GetAsync(
            $"{TestPorts.ServerUrl}/api/v1/markets/{conditionId}/deposit/{ecashDepositId}");
        Assert.Equal(HttpStatusCode.OK, ecashStatusResponse.StatusCode);

        var ecashStatusBody = await ecashStatusResponse.Content.ReadAsStringAsync();
        using var ecashStatusJson = JsonDocument.Parse(ecashStatusBody);
        Assert.Equal("paid", ecashStatusJson.RootElement.GetProperty("state").GetString());
        Assert.Equal("ecash", ecashStatusJson.RootElement.GetProperty("method").GetString());

        JsonDocument? creditedJson = null;
        for (var attempt = 0; attempt < 8; attempt++)
        {
            await Task.Delay(700);
            using var creditedResponse = await httpClient.GetAsync(
                $"{TestPorts.ServerUrl}/api/v1/markets/{conditionId}/deposit/{ecashDepositId}");
            Assert.Equal(HttpStatusCode.OK, creditedResponse.StatusCode);
            var creditedBody = await creditedResponse.Content.ReadAsStringAsync();
            creditedJson?.Dispose();
            creditedJson = JsonDocument.Parse(creditedBody);
            if (creditedJson.RootElement.GetProperty("state").GetString() == "credited")
                break;
        }

        using (creditedJson)
        {
            Assert.NotNull(creditedJson);
            Assert.Equal("credited", creditedJson.RootElement.GetProperty("state").GetString());
            Assert.Equal("ecash", creditedJson.RootElement.GetProperty("method").GetString());
        }
    }
}
