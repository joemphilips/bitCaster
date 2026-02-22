var builder = DistributedApplication.CreateBuilder(args);

// cdk-mintd from existing Dockerfile (Nix-based build)
var mintd = builder.AddDockerfile("mintd", "../cdk")
    .WithHttpEndpoint(port: 8085, targetPort: 8085, name: "mint-api")
    .WithEnvironment("CDK_MINTD_URL", "http://localhost:8085")
    .WithEnvironment("CDK_MINTD_LN_BACKEND", "fakewallet")
    .WithEnvironment("CDK_MINTD_LISTEN_HOST", "0.0.0.0")
    .WithEnvironment("CDK_MINTD_LISTEN_PORT", "8085")
    .WithEnvironment("CDK_MINTD_DATABASE", "sqlite")
    .WithEnvironment("CDK_MINTD_CACHE_BACKEND", "memory")
    .WithEnvironment("CDK_MINTD_MNEMONIC", "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");

var mintEndpoint = mintd.GetEndpoint("mint-api");

// BitCaster matching engine + price feed
var server = builder.AddProject<Projects.BitCaster_Server>("bitcaster-server")
    .WithEnvironment("MINT_URL", mintEndpoint)
    .WaitFor(mintd);

// React/Vite frontend
builder.AddViteApp("frontend", "../bitCaster")
    .WithNpm()
    .WithExternalHttpEndpoints()
    .WithEnvironment("VITE_MINT_URL", mintEndpoint)
    .WithEnvironment("VITE_SERVER_URL", server.GetEndpoint("http"))
    .WaitFor(mintd)
    .WaitFor(server);

builder.Build().Run();
