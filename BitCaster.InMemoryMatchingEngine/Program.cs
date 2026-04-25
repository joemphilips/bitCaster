using BitCaster.InMemoryMatchingEngine;
using BitCaster.InMemoryMatchingEngine.Endpoints;
using BitCaster.InMemoryMatchingEngine.Hubs;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSignalR();
builder.Services.AddSingleton<InMemoryOrderBookManager>();
builder.Services.AddSingleton<LnBitsWalletManager>();
builder.Services.AddSingleton<InMemoryCpmmState>();
builder.Services.AddSingleton<InMemoryTradeRegistry>();
builder.Services.AddHealthChecks();
builder.Services.AddHttpClient("mint", c =>
    c.BaseAddress = new Uri(builder.Configuration["MINT_URL"] ?? "http://localhost:8085"));
builder.Services.AddHttpClient("lnbits", c =>
    c.BaseAddress = new Uri(builder.Configuration["LNBITS_URL"] ?? "http://localhost:5002"));

var app = builder.Build();

app.MapHealthChecks("/health");
app.MapHub<MarketHub>("/hubs/market");
app.MapHub<TradeHub>("/hubs/trade");
app.MapMarketEndpoints();
app.MapOrderEndpoints();
app.MapBookEndpoints();
app.MapMetadataEndpoints();
app.MapThumbnailEndpoints();
app.MapLiquidityEndpoints();
app.MapPaymentEndpoints();
app.MapCpmmEndpoints();

app.Run();
