using BitCaster.InMemoryMatchingEngine;
using BitCaster.InMemoryMatchingEngine.Endpoints;
using BitCaster.InMemoryMatchingEngine.Hubs;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSignalR();
builder.Services.AddSingleton<InMemoryOrderBookManager>();
builder.Services.AddHealthChecks();

var app = builder.Build();

app.MapHealthChecks("/health");
app.MapHub<MarketHub>("/hubs/market");
app.MapOrderEndpoints();
app.MapBookEndpoints();
app.MapMetadataEndpoints();
app.MapThumbnailEndpoints();
app.MapLiquidityEndpoints();

app.Run();
