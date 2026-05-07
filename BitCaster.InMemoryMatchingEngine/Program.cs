using BitCaster.InMemoryMatchingEngine;
using BitCaster.InMemoryMatchingEngine.Endpoints;
using BitCaster.InMemoryMatchingEngine.Hubs;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSignalR();
builder.Services.AddSingleton<InMemoryOrderBookManager>();
builder.Services.AddSingleton<LnBitsWalletManager>();
builder.Services.AddSingleton<InMemoryTradeRegistry>();
builder.Services.AddHealthChecks();
builder.Services.AddHttpClient("mint", c =>
    c.BaseAddress = new Uri(builder.Configuration["MINT_URL"] ?? "http://localhost:8085"));
builder.Services.AddHttpClient("lnbits", c =>
    c.BaseAddress = new Uri(builder.Configuration["LNBITS_URL"] ?? "http://localhost:5102"));

// Dev/E2E only — the frontend's `useTradeHub` / `marketHub.ts` connect to
// `VITE_SERVER_URL ?? http://localhost:5000` directly (not through the Vite
// proxy), so any browser at a different origin (5273) needs CORS allowed
// for SignalR negotiation + WebSocket upgrade. This mock is never deployed
// to production; the real ApiService has its own CORS policy.
const string DevCorsPolicy = "DevAllowAllOrigins";
builder.Services.AddCors(options =>
{
    options.AddPolicy(DevCorsPolicy, policy =>
        policy.SetIsOriginAllowed(_ => true)
              .AllowAnyHeader()
              .AllowAnyMethod()
              .AllowCredentials());
});

var app = builder.Build();

app.UseCors(DevCorsPolicy);

app.MapHealthChecks("/health");
app.MapHub<MarketHub>("/hubs/market");
app.MapHub<TradeHub>("/hubs/trade");
app.MapMarketEndpoints();
app.MapMarketQueryEndpoint();
app.MapOrderEndpoints();
app.MapBookEndpoints();
app.MapMetadataEndpoints();
app.MapThumbnailEndpoints();
app.MapLiquidityEndpoints();
app.MapPaymentEndpoints();
app.MapDepositEndpoints();

app.Run();
