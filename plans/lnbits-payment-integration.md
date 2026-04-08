# LNBits Payment Integration Plan

## Goal

Add a single LNBits instance for the InMemoryMatchingEngine server so that each market has its own LNBits wallet for independent accounting. Provide endpoints to create bolt11 payment requests and simulate payments (dev-only).

CDK mintd keeps its built-in FakeWallet — no LNBits needed there.

## Background

### FakeWallet behavior

- **CDK FakeWallet**: Generates real valid bolt11 invoices (hardcoded signing key). Auto-pays all incoming invoices immediately via background task. Self-contained, no external service.
- **LNBits FakeWallet**: Generates real bolt11 strings (key derived from `FAKE_WALLET_SECRET`). 1M sats virtual balance. Internal payments only — `pay_invoice()` succeeds only for invoices created by the same instance. Cross-instance payments fail.

### LNBits wallet API

- `POST /api/v1/account` with `{ "name": "<wallet-name>" }` creates a new user+wallet, returns `{ id, name, adminkey, inkey, balance_msat }`.
- `POST /api/v1/payments` with `{ "out": false, "amount": <sats>, "memo": "<desc>" }` + `X-Api-Key: <inkey>` creates an invoice.
- `POST /api/v1/payments` with `{ "out": true, "bolt11": "<invoice>" }` + `X-Api-Key: <adminkey>` pays an invoice.

## Implementation Steps

### Step 1: docker-compose — Add LNBits service

**File:** `docker-compose.yml`

```yaml
lnbits:
  image: lnbitsdocker/lnbits:latest
  ports:
    - "5002:5000"
  environment:
    LNBITS_ADMIN_UI: "true"
    LNBITS_BACKEND_WALLET_CLASS: FakeWallet
    FAKE_WALLET_SECRET: "serversecret"
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:5000/api/v1/health"]
    interval: 5s
    timeout: 5s
    retries: 30
```

Update `server` service:
```yaml
server:
  environment:
    LNBITS_URL: "http://lnbits:5000"
  depends_on:
    lnbits:
      condition: service_healthy
```

### Step 2: OpenAPI spec — Add schemas and endpoints

**File:** `BitCaster.MatchingEngine.Contracts/specs/openapi.yaml`

New schemas:
- `CreatePaymentRequestRequest`: `{ amountSats: Sats, description?: string }`
- `CreatePaymentRequestResponse`: `{ bolt11: string }`
- `SimulatePaymentRequest`: `{ bolt11: string }`
- `SimulatePaymentResponse`: `{ paid: boolean }`

New paths:
- `POST /api/v1/markets/{marketId}/payment-requests` — create bolt11 invoice via market's LNBits wallet
- `POST /api/v1/markets/{marketId}/simulate-payment` — pay the invoice internally (tagged `x-dev-only: true` in openapi.yaml)

### Step 3: Regenerate contracts

Run NSwag to update `Generated/ApiContracts.g.cs`.

### Step 4: LnBitsWalletManager service

**File:** `BitCaster.InMemoryMatchingEngine/LnBitsWalletManager.cs` (new)

Singleton service:
- `ConcurrentDictionary<string, LnBitsWallet>` mapping marketId to `{ AdminKey, InvoiceKey }`
- `CreateWallet(marketId)` — calls `POST /api/v1/account` with name = marketId, caches keys
- `GetWallet(marketId)` — returns cached wallet or null

### Step 5: Eagerly create wallet during market creation

**File:** `BitCaster.InMemoryMatchingEngine/Endpoints/MarketEndpoints.cs`

In the `POST /api/v1/markets/{conditionId}` handler, after creating per-outcome markets, call `LnBitsWalletManager.CreateWallet(marketId)` for each outcome market.

### Step 6: PaymentEndpoints

**File:** `BitCaster.InMemoryMatchingEngine/Endpoints/PaymentEndpoints.cs` (new)

```
POST /api/v1/markets/{marketId}/payment-requests
  -> walletManager.GetWallet(marketId) ?? 404
  -> POST lnbits/api/v1/payments { out: false, amount, memo } with inkey
  -> return { bolt11 }

POST /api/v1/markets/{marketId}/simulate-payment
  -> walletManager.GetWallet(marketId) ?? 404
  -> POST lnbits/api/v1/payments { out: true, bolt11 } with adminkey
  -> return { paid: true/false }
```

### Step 7: Wire up in Program.cs

- Register `LnBitsWalletManager` as singleton
- Register named `HttpClient("lnbits")` with base URL from `LNBITS_URL` env var
- Add `app.MapPaymentEndpoints()`

### Step 8: E2E test

1. Create a market
2. `POST /api/v1/markets/{marketId}/payment-requests` with amount -> bolt11 starting with `lnbc`
3. `POST /api/v1/markets/{marketId}/simulate-payment` with that bolt11 -> `{ paid: true }`
