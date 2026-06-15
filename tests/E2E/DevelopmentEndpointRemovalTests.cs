using System.Net;
using System.Net.Http.Json;

namespace BitCaster.E2ETest;

public class DevelopmentEndpointRemovalTests
{
    [Fact]
    public async Task MockMarketStatusDevelopmentEndpoint_Returns404()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        await TestHelpers.WaitForService(httpClient, $"{TestPorts.ServerUrl}/health", "Matching Engine");

        var conditionId = Guid.NewGuid().ToString("N");
        using var response = await httpClient.PostAsJsonAsync(
            $"{TestPorts.ServerUrl}/api/v1/dev/markets/{conditionId}/status",
            new { state = "closed" });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }
}
