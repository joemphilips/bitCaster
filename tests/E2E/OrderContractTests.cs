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
        _http = new HttpClient { BaseAddress = new Uri($"http://localhost:{TestPorts.Server}") };
        await TestHelpers.WaitForService(_http, $"http://localhost:{TestPorts.Server}/health", "Matching Engine");
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
            side = "Buy",
            price = 50,
            amountSats = 100,
            userId = "test-user",
            timeInForce = "GTC",
            ephemeralPubkey = pubkey,
        };

        var res = await _http!.PostAsJsonAsync("/api/v1/test-market/orders", body);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        var json = await res.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var echoed = doc.RootElement.GetProperty("ephemeralPubkey").GetString();
        Assert.Equal(pubkey, echoed);
    }

    [Fact]
    public async Task SubmitOrder_RejectsMalformedEphemeralPubkey()
    {
        Assert.NotNull(_http);
        var body = new
        {
            outcomeId = "Yes",
            side = "Buy",
            price = 50,
            amountSats = 100,
            userId = "test-user",
            timeInForce = "GTC",
            // Wrong prefix + length — must fail validation.
            ephemeralPubkey = "04deadbeef",
        };

        var res = await _http!.PostAsJsonAsync("/api/v1/test-market/orders", body);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }
}
