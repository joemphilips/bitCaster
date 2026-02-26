FROM mcr.microsoft.com/dotnet/sdk:10.0-preview AS build
WORKDIR /src
COPY BitCaster.MatchingEngine.Contracts/ BitCaster.MatchingEngine.Contracts/
COPY BitCaster.InMemoryMatchingEngine/ BitCaster.InMemoryMatchingEngine/
RUN dotnet publish BitCaster.InMemoryMatchingEngine -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0-preview
WORKDIR /app
COPY --from=build /app .
EXPOSE 5000
ENV ASPNETCORE_URLS=http://+:5000
ENTRYPOINT ["dotnet", "BitCaster.InMemoryMatchingEngine.dll"]
