using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace BitCaster.E2ETest;

/// <summary>
/// Direct HTTP tests against the running matching engine — exercise the
/// SubmitOrderRequest/Response contract without going through the browser.
/// Cheap guard that the server round-trips <c>ephemeralPubkey</c> and
/// rejects malformed ones, so the UI can trust the wire.
/// </summary>
public class OrderContractTests : IAsyncLifetime
{
    private HttpClient? _http;

    public async Task InitializeAsync()
    {
        _http = new HttpClient { BaseAddress = new Uri($"{TestPorts.ServerUrl}") };
        await TestHelpers.WaitForService(_http, $"{TestPorts.ServerUrl}/health", "Matching Engine");
    }

    public Task DisposeAsync()
    {
        _http?.Dispose();
        return Task.CompletedTask;
    }

    private static string NewCompressedPubkey() =>
        "02" + new string('a', 64);

    [Fact]
    public async Task SubmitOrder_EchoesEphemeralPubkey_InResponse()
    {
        Assert.NotNull(_http);
        var pubkey = NewCompressedPubkey();
        var body = new
        {
            outcomeId = "Yes",
            tokenSide = "Outcome",
            side = "Buy",
            price = 50,
            amountSats = 100,
            timeInForce = "GTC",
            ephemeralPubkey = pubkey,
        };

        var res = await _http!.PostAsJsonAsync("/api/v1/test-Yes/orders", body);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        var json = await res.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var echoed = doc.RootElement.GetProperty("ephemeralPubkey").GetString();
        Assert.Equal(pubkey, echoed);
    }

    [Fact]
    public async Task GetOrderStatus_ReturnsRestingForNewlySubmittedOrder()
    {
        Assert.NotNull(_http);
        var pubkey = NewCompressedPubkey();
        var submit = new
        {
            outcomeId = "Yes",
            tokenSide = "Outcome",
            side = "Buy",
            price = 50,
            amountSats = 100,
            timeInForce = "GTC",
            ephemeralPubkey = pubkey,
        };

        var submitRes = await _http!.PostAsJsonAsync("/api/v1/status-Yes/orders", submit);
        Assert.Equal(HttpStatusCode.OK, submitRes.StatusCode);
        var submitJson = JsonDocument.Parse(await submitRes.Content.ReadAsStringAsync());
        var orderId = submitJson.RootElement.GetProperty("orderId").GetString();
        Assert.NotNull(orderId);

        var statusRes = await _http!.GetAsync($"/api/v1/status-Yes/orders/{orderId}");
        Assert.Equal(HttpStatusCode.OK, statusRes.StatusCode);

        using var doc = JsonDocument.Parse(await statusRes.Content.ReadAsStringAsync());
        var root = doc.RootElement;
        Assert.Equal(orderId, root.GetProperty("orderId").GetString());
        Assert.Equal("status-Yes", root.GetProperty("marketId").GetString());
        // The InMemoryMatchingEngine never matches, so new orders sit resting
        // with zero fills and the full amount outstanding.
        Assert.Equal("resting", root.GetProperty("status").GetString());
        Assert.Equal(100, root.GetProperty("remainingAmountSats").GetInt32());
        Assert.Equal(0, root.GetProperty("filledAmountSats").GetInt32());
        Assert.Equal(0, root.GetProperty("fills").GetArrayLength());
    }

    [Fact]
    public async Task GetOrderStatus_ReturnsNotFoundForUnknownOrderId()
    {
        Assert.NotNull(_http);
        var res = await _http!.GetAsync($"/api/v1/any-market/orders/{Guid.NewGuid()}");
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task SubmitOrder_RejectsMalformedEphemeralPubkey()
    {
        Assert.NotNull(_http);
        var body = new
        {
            outcomeId = "Yes",
            tokenSide = "Outcome",
            side = "Buy",
            price = 50,
            amountSats = 100,
            timeInForce = "GTC",
            // Wrong prefix + length — must fail validation.
            ephemeralPubkey = "04deadbeef",
        };

        var res = await _http!.PostAsJsonAsync("/api/v1/test-Yes/orders", body);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }
}
