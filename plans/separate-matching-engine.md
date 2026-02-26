# Plan: Separate BitCaster.Server into Contract + Mock and Private Implementation

## Context

BitCaster.Server currently bundles the API contract (DTOs, endpoint shapes, SignalR hub) with the matching engine business logic. The goal is to:
- Keep a **shared contract library** and a **simple mock server** in the monorepo for E2E testing and frontend development
- Move the **real matching engine implementation** to a private repo at `~/working/src/cashu/bitCaster-matching-engine`
- The private repo will reference the contract types via **git submodule** (consistent with existing `nuts/`, `cdk/` patterns)

## Final Project Structure

### Monorepo (after changes)

```
BitCaster.Contracts/                  NEW — shared class library
  BitCaster.Contracts.csproj          (Microsoft.NET.Sdk, net10.0)
  Domain/
    Order.cs                          (Order record, OrderSide, OrderType enums)
    Fill.cs                           (Fill record, MatchPath enum, MatchResult record)
    Snapshots.cs                      (OrderBookSnapshot, OutcomeSnapshot, LevelDto)
  Endpoints/
    OrderContracts.cs                 (SubmitOrderRequest, SubmitOrderResponse)

BitCaster.MockServer/                 NEW — replaces BitCaster.Server/
  BitCaster.MockServer.csproj         (Microsoft.NET.Sdk.Web, references Contracts)
  Program.cs
  MockOrderBookManager.cs             (in-memory store, no matching)
  Endpoints/
    OrderEndpoints.cs                 (stores orders, returns plausible responses)
    BookEndpoints.cs                  (returns snapshot from stored orders)
  Hubs/
    MarketHub.cs                      (join/leave groups, send snapshot on join)
  Dockerfile

BitCaster.Server/                     DELETED from monorepo
```

> Note: `BitCaster.MatchingEngine.Contract` and `BitCaster.InMemoryMatchingEngine` seems more correct name.


### Private Repo (`~/working/src/cashu/bitCaster-matching-engine`)

```
BitCaster.Contracts/                  git submodule → monorepo
BitCaster.MatchingEngine/
  BitCaster.MatchingEngine.csproj     (Microsoft.NET.Sdk.Web, references Contracts)
  Program.cs
  Domain/
    OrderBook.cs                      (OrderBookManager, OrderBook, comparers)
    MatchingEngine.cs                 (static Match logic)
  Endpoints/
    OrderEndpoints.cs                 (real matching + SignalR broadcast)
    BookEndpoints.cs                  (real snapshot)
  Hubs/
    MarketHub.cs
  Dockerfile
```

## Step-by-Step Implementation

### Step 1: Create `BitCaster.Contracts/` class library

1. Create `BitCaster.Contracts/BitCaster.Contracts.csproj` — `Microsoft.NET.Sdk`, net10.0
2. Extract from `BitCaster.Server/Domain/Order.cs` → `BitCaster.Contracts/Domain/Order.cs`
   - `Order` record, `OrderSide` enum, `OrderType` enum
   - Namespace: `BitCaster.Contracts.Domain`
3. Extract from `BitCaster.Server/Domain/Fill.cs` → `BitCaster.Contracts/Domain/Fill.cs`
   - `Fill` record, `MatchPath` enum, `MatchResult` record
   - Namespace: `BitCaster.Contracts.Domain`
4. Extract snapshot records from `BitCaster.Server/Domain/OrderBook.cs` → `BitCaster.Contracts/Domain/Snapshots.cs`
   - `OrderBookSnapshot`, `OutcomeSnapshot`, `LevelDto`
   - Namespace: `BitCaster.Contracts.Domain`
5. Extract from `BitCaster.Server/Endpoints/OrderEndpoints.cs` → `BitCaster.Contracts/Endpoints/OrderContracts.cs`
   - `SubmitOrderRequest`, `SubmitOrderResponse`
   - Namespace: `BitCaster.Contracts.Endpoints`
6. Verify: `dotnet build BitCaster.Contracts/`

### Step 2: Create `BitCaster.MockServer/`

The mock stores submitted orders in-memory and returns them in snapshots, but performs **no matching**.

1. Create `BitCaster.MockServer/BitCaster.MockServer.csproj` — `Microsoft.NET.Sdk.Web`, net10.0, `<ProjectReference>` to `../BitCaster.Contracts/BitCaster.Contracts.csproj`
2. Create `MockOrderBookManager.cs`:
   - `ConcurrentDictionary<string, List<Order>>` keyed by marketId
   - `AddOrder(Order)` — stores the order
   - `GetSnapshot(string marketId)` → builds `OrderBookSnapshot` from stored orders (bids/asks grouped by outcome)
   - `CancelOrder(Guid id)` → removes order, returns bool
   - `GetAllMarketIds()` → keys
3. Create `Endpoints/OrderEndpoints.cs`:
   - `POST /api/v1/orders` — validate input, create `Order`, store via MockOrderBookManager, return `SubmitOrderResponse(orderId, "resting", amountSats, emptyFills)`
   - `DELETE /api/v1/orders/{id}` — call `CancelOrder`, return Ok/NotFound
   - Broadcast `OrderBookUpdated` via SignalR after each operation
4. Create `Endpoints/BookEndpoints.cs`:
   - `GET /api/v1/markets/{marketId}/orderbook` — return snapshot from MockOrderBookManager
5. Create `Hubs/MarketHub.cs`:
   - `JoinMarket` — add to group, send current snapshot
   - `LeaveMarket` — remove from group
6. Create `Program.cs` — register SignalR + MockOrderBookManager singleton, map endpoints + hub
7. Create `Dockerfile`:
   ```dockerfile
   FROM mcr.microsoft.com/dotnet/sdk:10.0-preview AS build
   WORKDIR /src
   COPY BitCaster.Contracts/ BitCaster.Contracts/
   COPY BitCaster.MockServer/ BitCaster.MockServer/
   RUN dotnet publish BitCaster.MockServer -c Release -o /app

   FROM mcr.microsoft.com/dotnet/aspnet:10.0-preview
   WORKDIR /app
   COPY --from=build /app .
   EXPOSE 5000
   ENV ASPNETCORE_URLS=http://+:5000
   ENTRYPOINT ["dotnet", "BitCaster.MockServer.dll"]
   ```
8. Verify: `dotnet run --project BitCaster.MockServer/`

### Step 3: Update E2E tests

In both `tests/E2E/MarketDiscoveryTests.cs` and `tests/E2E/SettingsPageTests.cs`:
- Change `Path.Combine(RepoRoot, "BitCaster.Server")` → `Path.Combine(RepoRoot, "BitCaster.MockServer")`

### Step 4: Update `docker-compose.yml`

```yaml
server:
  build:
    context: .
    dockerfile: BitCaster.MockServer/Dockerfile
  ports:
    - "5000:5000"
  environment:
    ASPNETCORE_URLS: "http://+:5000"
  depends_on:
    mintd:
      condition: service_healthy
```

Remove `Mint__Url` (mock doesn't need it).

### Step 5: Create private repo with real implementation

1. `mkdir -p ~/working/src/cashu/bitCaster-matching-engine && cd ~/working/src/cashu/bitCaster-matching-engine && git init`
2. Add submodule: `git submodule add <monorepo-git-url> BitCaster.Contracts` (pointing to monorepo, we'll use a sparse checkout or subtree strategy later — for now, copy the Contracts directory)
3. Create `BitCaster.MatchingEngine/BitCaster.MatchingEngine.csproj` with `<ProjectReference>` to Contracts
4. Copy from current `BitCaster.Server/`:
   - `Domain/OrderBook.cs` → remove snapshot records (use `using BitCaster.Contracts.Domain;`), keep `OrderBookManager`, `OrderBook`, comparers
   - `Domain/MatchingEngine.cs` → update namespace + using
   - `Endpoints/OrderEndpoints.cs` → full real logic, update namespaces/usings
   - `Endpoints/BookEndpoints.cs` → update namespaces/usings
   - `Hubs/MarketHub.cs` → update namespaces/usings
   - `Program.cs` → update namespaces/usings
   - `Dockerfile` → adapted for new structure
5. Update all namespaces: `BitCaster.Server.*` → `BitCaster.MatchingEngine.*`
6. Verify: `dotnet build` and `dotnet run`
7. Initial commit

### Step 6: Delete `BitCaster.Server/` from monorepo

Remove the entire `BitCaster.Server/` directory.

### Step 7: Update documentation

1. **`AGENTS.md`** — Update monorepo layout:
   - Replace `BitCaster.Server/` with `BitCaster.Contracts/` and `BitCaster.MockServer/`
   - Add note about private matching engine repo
   - Update "Local Dev" section (Terminal 2 now runs MockServer)
2. **`.claude/rules/server.md`** — Rewrite to describe MockServer and explain the contract/mock split
3. **`.claude/rules/e2e-tests.md`** — Update server directory reference

## Critical Files

| File | Action |
|------|--------|
| `BitCaster.Server/Domain/Order.cs` | Extract types → Contracts, copy impl → private repo |
| `BitCaster.Server/Domain/Fill.cs` | Extract types → Contracts, copy impl → private repo |
| `BitCaster.Server/Domain/OrderBook.cs` | Split: snapshot records → Contracts, OrderBook+Manager → private repo |
| `BitCaster.Server/Domain/MatchingEngine.cs` | Move entirely → private repo |
| `BitCaster.Server/Endpoints/OrderEndpoints.cs` | Split: DTOs → Contracts, logic → private repo, mock → MockServer |
| `BitCaster.Server/Endpoints/BookEndpoints.cs` | Mock → MockServer, real → private repo |
| `BitCaster.Server/Hubs/MarketHub.cs` | Copy to both MockServer and private repo |
| `BitCaster.Server/Program.cs` | Adapted for MockServer, copy for private repo |
| `BitCaster.Server/Dockerfile` | Replaced by MockServer Dockerfile |
| `tests/E2E/MarketDiscoveryTests.cs` | Update server path |
| `tests/E2E/SettingsPageTests.cs` | Update server path |
| `docker-compose.yml` | Update server service |
| `AGENTS.md` | Update layout + docs |
| `.claude/rules/server.md` | Rewrite for MockServer |

## Verification

1. `dotnet build BitCaster.Contracts/` — contracts build
2. `dotnet build BitCaster.MockServer/` — mock builds
3. `dotnet run --project BitCaster.MockServer/` — mock starts on port 5000
4. `curl http://localhost:5000/api/v1/markets/test/orderbook` — returns valid JSON
5. `curl -X POST http://localhost:5000/api/v1/orders -H 'Content-Type: application/json' -d '{"MarketId":"test","OutcomeId":"YES","Side":0,"Type":0,"Price":50,"AmountSats":1000,"UserId":"test"}'` — returns order response
6. `dotnet test tests/E2E/` — E2E tests pass with mock server
7. `docker compose build server` — Docker build succeeds
8. In private repo: `dotnet build` and `dotnet run` — real server works
9. `codex exec review --uncommitted` — passes review
