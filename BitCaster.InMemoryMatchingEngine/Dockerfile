# TODO(P2): extract BitCaster.MatchingEngine.Matching into the submodule so this
# Dockerfile can live purely inside bitCaster/ again. Current context reaches into
# the parent repo for the Domain reference added in Phase 1F. The build context is
# the PARENT repo root (one level above bitCaster/) — see ../docker-compose.yml.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# dotnet-tools.json (nswag) lives inside the submodule; restore from that subdir
# so relative paths match the non-Docker build.
COPY bitCaster/dotnet-tools.json bitCaster/.config/dotnet-tools.json
WORKDIR /src/bitCaster
RUN dotnet tool restore
WORKDIR /src

# Parent-repo Directory.Build.props (TreatWarningsAsErrors, NoWarn for NU1608).
# Mirrors the build behavior outside Docker when dotnet build is invoked from the
# parent repo root.
COPY Directory.Build.props Directory.Build.props

# Domain lives in the parent repo; Contracts + InMemoryMatchingEngine live in the
# submodule. Paths below preserve the on-disk layout so ProjectReference paths
# (..\..\BitCaster.MatchingEngine.Domain\... and ..\BitCaster.MatchingEngine.Contracts\...)
# resolve unchanged.
COPY BitCaster.MatchingEngine.Domain/ BitCaster.MatchingEngine.Domain/
COPY bitCaster/BitCaster.MatchingEngine.Contracts/ bitCaster/BitCaster.MatchingEngine.Contracts/
COPY bitCaster/BitCaster.InMemoryMatchingEngine/ bitCaster/BitCaster.InMemoryMatchingEngine/

RUN dotnet publish bitCaster/BitCaster.InMemoryMatchingEngine -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app .
EXPOSE 5000
ENV ASPNETCORE_URLS=http://+:5000
ENTRYPOINT ["dotnet", "BitCaster.InMemoryMatchingEngine.dll"]
