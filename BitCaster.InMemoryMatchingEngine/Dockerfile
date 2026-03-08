FROM mcr.microsoft.com/dotnet/sdk:10.0-preview AS build
WORKDIR /src
COPY BitCaster.MatchingEngine.Contracts/ BitCaster.MatchingEngine.Contracts/
COPY BitCaster.InMemoryMatchingEngine/ BitCaster.InMemoryMatchingEngine/
RUN dotnet publish BitCaster.InMemoryMatchingEngine -c Release -o /app --self-contained -r linux-x64

FROM mcr.microsoft.com/dotnet/aspnet:9.0
WORKDIR /app
COPY --from=build /app .
EXPOSE 5000
ENV ASPNETCORE_URLS=http://+:5000
ENTRYPOINT ["./BitCaster.InMemoryMatchingEngine"]
