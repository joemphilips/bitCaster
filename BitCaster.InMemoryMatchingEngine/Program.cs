using BitCaster.InMemoryMatchingEngine;
using BitCaster.InMemoryMatchingEngine.Endpoints;
using BitCaster.InMemoryMatchingEngine.Hubs;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSignalR();
builder.Services.AddSingleton<InMemoryOrderBookManager>();

var app = builder.Build();

app.MapHub<MarketHub>("/hubs/market");
app.MapOrderEndpoints();
app.MapBookEndpoints();

app.Run();
