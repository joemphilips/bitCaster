# Plan: Atomic Swap Relay Support in BitCaster.Server

## Context

The new `bitCaster-doc/src/content/docs/technical/atomic-swap.md` specifies a 9-step P2P trading protocol using ECDH key agreement and adaptor signatures over NUT-11 P2PK. The cryptographic swap itself happens client-side and at the mint — but **the server must act as a non-custodial relay** that:

1. Accepts orders with ephemeral pubkeys (step 1)
2. Notifies matched parties with counterparty pubkeys (step 2)
3. Relays ECDH-encrypted messages between matched pairs (steps 4-6)

The server never sees plaintext swap data and never takes custody of tokens.

## Files to Modify

| File | Change |
|------|--------|
| `BitCaster.Server/Domain/Order.cs` | Add `EphemeralPubkey` init property |
| `BitCaster.Server/Domain/Fill.cs` | Add `MakerOrder` init property (for pubkey lookup after match) |
| `BitCaster.Server/Domain/MatchingEngine.cs` | Set `MakerOrder` on each fill |
| `BitCaster.Server/Endpoints/OrderEndpoints.cs` | Add `EphemeralPubkey`/`ConnectionId` to request; emit `SwapMatched` after fills |
| `BitCaster.Server/Hubs/MarketHub.cs` | Add `SendSwapMessage`, `AckSwapComplete`, `OnDisconnectedAsync` |
| `BitCaster.Server/Program.cs` | Register new singletons |

## Files to Create

| File | Purpose |
|------|---------|
| `BitCaster.Server/Domain/SwapSession.cs` | Lightweight record: session ID + two connection IDs + two pubkeys |
| `BitCaster.Server/Domain/SwapSessionStore.cs` | `ConcurrentDictionary` store with connection-ID index for disconnect cleanup |
| `BitCaster.Server/Domain/OrderConnectionRegistry.cs` | Maps `orderId → SignalR connectionId` for targeted match notifications |
| `tests/Unit/BitCaster.Server.Tests/BitCaster.Server.Tests.csproj` | New test project (unit + integration tests) |
| `tests/Unit/BitCaster.Server.Tests/SwapSessionStoreTests.cs` | Unit tests for session store |
| `tests/Unit/BitCaster.Server.Tests/SwapRelayIntegrationTests.cs` | Integration tests using ASP.NET `TestServer` + `SignalR.Client` |
| `.claude/rules/server.md` | Update with test conventions (unit vs integration vs E2E) |
| `CLAUDE.md` or `.claude/rules/e2e-tests.md` | Add general rule: E2E = browser + mint; otherwise use integration tests |

## Implementation Steps (TDD)

### 1. Create test project and document test conventions

Create `tests/Unit/BitCaster.Server.Tests/` with:
- net10.0, xunit 2.9.3, project reference to `BitCaster.Server`
- `Microsoft.AspNetCore.Mvc.Testing` for `WebApplicationFactory`/`TestServer`
- `Microsoft.AspNetCore.SignalR.Client` for SignalR integration tests
- Tests written first (red), then made green by implementation

**Test categories** (separated by xUnit `[Trait]` attributes):
- `[Trait("Category", "Unit")]` — pure domain logic, no server, no I/O
- `[Trait("Category", "Integration")]` — uses ASP.NET `TestServer` (in-memory HTTP + SignalR), no external processes

Update `.claude/rules/server.md` with these test conventions.
Update `.claude/rules/e2e-tests.md` with the general rule: **E2E tests require browser (Playwright) and/or mint (docker-compose). Tests that only exercise the server should be integration tests using `TestServer`.**

### 2. Write unit tests `[Trait("Category", "Unit")]`

**`SwapSessionStoreTests.cs`:**
- `Create_ReturnsFreshSession`
- `Get_ReturnsNullForUnknownId`
- `Remove_CleansUpSession`
- `CounterpartyConnectionId_ReturnsCorrectPeer` (taker gets maker, maker gets taker)
- `RemoveByConnection_CleansUpOnDisconnect`

### 3. Write integration tests `[Trait("Category", "Integration")]`

**`SwapRelayIntegrationTests.cs`** — uses ASP.NET `TestServer` (via `WebApplicationFactory<Program>`) + `SignalR.Client`. No external processes, no browser, no mint.

- Test: `MatchedParties_ReceiveCounterpartyPubkeysAndCanRelayMessages`
  1. Alice connects to SignalR via TestServer, joins market
  2. Bob connects to SignalR via TestServer, joins market
  3. Alice posts sell order with `ephemeralPubkey="02aa..."`, `connectionId=<alice's>`
  4. Bob posts buy order with `ephemeralPubkey="02bb..."`, `connectionId=<bob's>`
  5. Assert: Alice receives `SwapMatched` with Bob's pubkey + session ID
  6. Assert: Bob receives `SwapMatched` with Alice's pubkey + same session ID
  7. Alice calls `SendSwapMessage(sessionId, "encrypted_payload_1")`
  8. Assert: Bob receives `SwapMessageReceived` with that payload
  9. Bob calls `SendSwapMessage(sessionId, "encrypted_payload_2")`
  10. Assert: Alice receives it
- Test: `SendSwapMessage_UnknownSession_ReturnsFalse`

### 4. Implement domain types

**`Domain/SwapSession.cs`:**
```csharp
public record SwapSession(
    Guid Id,
    string TakerConnectionId, string MakerConnectionId,
    string TakerPubkey, string MakerPubkey,
    DateTimeOffset CreatedAt);
```
With `CounterpartyConnectionId(string myConnId)` helper method.

**`Domain/SwapSessionStore.cs`:**
- `ConcurrentDictionary<Guid, SwapSession>` for sessions
- `ConcurrentDictionary<string, Guid>` index by connection ID
- Methods: `Create`, `Get`, `Remove`, `RemoveByConnection`

**`Domain/OrderConnectionRegistry.cs`:**
- `ConcurrentDictionary<Guid, string>` mapping orderId → connectionId
- Methods: `Register`, `GetConnectionId`, `Remove`

### 5. Modify existing domain types

**`Order.cs`:**
- Add `EphemeralPubkey` as a required constructor parameter (breaking change is fine)
- Rename `AmountSats` → `Amount` and `RemainingAmountSats` → `RemainingAmount` throughout (the matching engine handles arbitrary cashu-to-cashu swaps, not only sats)

**`Fill.cs`:**
- Add `MakerOrder` property so the endpoint can access the matched maker's pubkey (maker orders are removed from `_ordersById` when fully filled)
- Rename `AmountSats` → `Amount`

**`MatchingEngine.cs`** — set `MakerOrder = maker` when constructing each `Fill` in `MatchAgainst`.

**`OrderEndpoints.cs`** — update `SubmitOrderRequest`/`SubmitOrderResponse` to use `Amount` instead of `AmountSats`.

### 6. Modify endpoints and hub

**`OrderEndpoints.cs`:**
- Add `EphemeralPubkey` and `ConnectionId` to `SubmitOrderRequest`
- Rename `AmountSats` → `Amount` in request/response
- Register `ConnectionId` in `OrderConnectionRegistry`
- After each fill: create a `SwapSession` and send `SwapMatched` to each party via `Clients.Client(connectionId)`
- Validate `EphemeralPubkey` is 66 hex chars (cheap length check, no EC library)

**`MarketHub.cs`:**
- Inject `SwapSessionStore`
- Add `SendSwapMessage(Guid swapSessionId, string ciphertext) → bool`: look up session, relay to counterparty
- Add `AckSwapComplete(Guid swapSessionId)`: notify counterparty, remove session
- Add `OnDisconnectedAsync`: call `_swapSessionStore.RemoveByConnection(Context.ConnectionId)`

**`Program.cs`:**
- Register `SwapSessionStore` and `OrderConnectionRegistry` as singletons

### 7. Run all tests

- `dotnet test tests/Unit/ --filter "Category=Unit"` — unit tests green
- `dotnet test tests/Unit/ --filter "Category=Integration"` — integration tests green (TestServer)
- `dotnet test` — full suite, no regressions

## SignalR Contract (new messages)

**Server → Client:**
| Event | Payload | Trigger |
|-------|---------|---------|
| `SwapMatched` | `{ swapSessionId, counterpartyPubkey, fill }` | Fill where both orders have pubkeys |
| `SwapMessageReceived` | `{ swapSessionId, ciphertext }` | Relay from counterparty |
| `SwapCompleted` | `{ swapSessionId }` | Counterparty called `AckSwapComplete` |

**Client → Server (hub methods):**
| Method | Args | Returns |
|--------|------|---------|
| `SendSwapMessage` | `Guid swapSessionId, string ciphertext` | `bool` |
| `AckSwapComplete` | `Guid swapSessionId` | void |

**REST change — `POST /api/v1/orders`:**
- Rename `amountSats` → `amount`
- Add required fields: `ephemeralPubkey` (66-char hex) and `connectionId` (SignalR connection ID)

## Edge Cases

- **Partial fills**: Each fill creates its own swap session. Unfilled remainder rests normally.
- **Disconnect cleanup**: `OnDisconnectedAsync` removes sessions via connection-ID index.
- **No pubkey validation beyond length**: Server is a relay, not a crypto engine. Bad pubkeys fail client-side.
- **Event ordering**: `TradeExecuted` broadcasts first, then `SwapMatched` (targeted).

## Verification

1. `dotnet test tests/Unit/ --filter "Category=Unit"` — unit tests pass
2. `dotnet test tests/Unit/ --filter "Category=Integration"` — integration tests pass (TestServer)
3. `dotnet test` — full test suite passes, no regressions
4. `codex exec review --uncommitted` — LGTM
