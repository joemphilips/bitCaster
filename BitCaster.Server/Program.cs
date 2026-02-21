using BitCaster.Server.Domain;
using BitCaster.Server.Endpoints;
using BitCaster.Server.Hubs;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSignalR();
builder.Services.AddSingleton<OrderBookManager>();

var app = builder.Build();

app.MapHub<MarketHub>("/hubs/market");
app.MapOrderEndpoints();
app.MapBookEndpoints();

app.Run();
