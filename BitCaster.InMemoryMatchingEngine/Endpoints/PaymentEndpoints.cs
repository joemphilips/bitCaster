using BitCaster.MatchingEngine.Contracts;

namespace BitCaster.InMemoryMatchingEngine.Endpoints;

public static class PaymentEndpoints
{
    public static void MapPaymentEndpoints(this WebApplication app)
    {
        app.MapPost("/api/v1/markets/{marketId}/payment-requests", async (
            string marketId,
            CreatePaymentRequestRequest req,
            LnBitsWalletManager walletManager) =>
        {
            var wallet = walletManager.GetWallet(marketId);
            if (wallet is null)
                return Results.NotFound($"No wallet for market {marketId}");

            try
            {
                var bolt11 = await walletManager.CreateInvoiceAsync(
                    wallet,
                    req.AmountSats,
                    req.Description ?? $"bitCaster market {marketId}");
                return Results.Ok(new CreatePaymentRequestResponse(bolt11));
            }
            catch (HttpRequestException ex)
            {
                return Results.Problem(ex.Message, statusCode: 502);
            }
        });

        app.MapPost("/api/v1/markets/{marketId}/simulate-payment", async (
            string marketId,
            SimulatePaymentRequest req,
            LnBitsWalletManager walletManager) =>
        {
            var wallet = walletManager.GetWallet(marketId);
            if (wallet is null)
                return Results.NotFound($"No wallet for market {marketId}");

            try
            {
                var paid = await walletManager.SimulatePayInvoiceAsync(wallet, req.Bolt11);
                return Results.Ok(new SimulatePaymentResponse(paid));
            }
            catch (HttpRequestException ex)
            {
                return Results.Problem(ex.Message, statusCode: 502);
            }
        });
    }
}
