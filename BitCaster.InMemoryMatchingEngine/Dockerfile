# Mock matching-engine image. Self-contained inside bitCaster/ — no parent-repo
# context required. Build with the bitCaster/ submodule as the context (see
# docker-compose.yml).
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# dotnet-tools.json (nswag) drives the OpenAPI codegen during compile.
COPY dotnet-tools.json .config/dotnet-tools.json
RUN dotnet tool restore

COPY BitCaster.MatchingEngine.Contracts/ BitCaster.MatchingEngine.Contracts/
COPY BitCaster.InMemoryMatchingEngine/ BitCaster.InMemoryMatchingEngine/

RUN dotnet publish BitCaster.InMemoryMatchingEngine -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app .
EXPOSE 5000
ENV ASPNETCORE_URLS=http://+:5000
ENTRYPOINT ["dotnet", "BitCaster.InMemoryMatchingEngine.dll"]
