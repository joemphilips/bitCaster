# bitCaster

**Free, anonymous, Bitcoin-native prediction markets powered by Cashu ecash**

bitCaster is a decentralised prediction market platform where:

- Market positions are represented as **Cashu conditional tokens** (CTF) — ecash that only becomes spendable when a specific outcome is attested by a DLC oracle
- **No accounts, no KYC, no custodians** — settlement is enforced cryptographically by the mint
- **Nostr** provides identity (optional), oracle announcements, and Nostr Wallet Connect (NWC)
- The Cashu mint runs **CDK** (the Cashu Development Kit in Rust) with the NUT-CTF extension

The relevant NUT specifications are in the `nuts/` submodule (branch `nuts_for_prediction_markets`):

| Spec | Description |
|------|-------------|
| `NUT-CTF.md` | Core conditional token mint/settle flow |
| `NUT-CTF-split-merge.md` | Split one outcome token into multiple sub-outcomes |
| `NUT-CTF-numeric.md` | Numeric range outcome tokens |

Or checkout this [PR](https://github.com/cashubtc/nuts/pull/337)

---

## Monorepo Structure

```
bitCaster/
├── nuts/               submodule — NUT specs (joemphilips/nuts @ nuts_for_prediction_markets)
├── cdk/                submodule — Cashu Development Kit (joemphilips/cdk @ bitCaster)
├── bitCaster-design/   React design tool with product specs and UI mockups
├── bitCaster/          PWA frontend (React 19 + Vite + cashu-ts + NDK)
├── BitCaster.Server/   Matching engine + real-time price feed (ASP.NET minimal API + SignalR)
└── infrastructure/     Terraform for Azure (Container Apps, PostgreSQL, Static Web Apps)
```

---

## Prerequisites

| Tool | Version |
|------|---------|
| git | ≥ 2.28 |
| Node.js | ≥ 22 (LTS) |
| pnpm / npm | ≥ 9 |
| Terraform | ≥ 1.6 |
| Azure CLI | ≥ 2.55 (for infra) |
| Rust + cargo | latest stable (to build CDK locally) |
| .NET SDK | ≥ 10.0 (for BitCaster.Server) |
| Docker | latest (for mintd via docker-compose) |

---

## Quick Start

### 1. Clone with submodules

```bash
git clone --recurse-submodules git@github.com:joemphilips/bitCaster.git
cd bitCaster
```

> **Note on the `cdk` submodule:** The `bitCaster` branch must be pushed to
> `git@github.com:joemphilips/cdk.git` before `git submodule update --init cdk`
> will succeed for other contributors.  The branch has now been pushed.

If you cloned without `--recurse-submodules`:

```bash
git submodule update --init --recursive
```

### 2. Frontend (PWA)

```bash
cd bitCaster
cp .env.example .env          # set VITE_MINT_URL to your mint
npm install
npm run dev                   # → http://localhost:5173
```

Build for production:

```bash
npm run build                 # output in dist/
```

### 3. Matching Engine Server

```bash
cd BitCaster.Server
dotnet run                    # → http://localhost:5000
```

The server provides:
- **CLOB matching engine** — `POST /api/v1/orders`, `DELETE /api/v1/orders/{id}`
- **Orderbook snapshots** — `GET /api/v1/markets/{marketId}/orderbook`
- **Real-time price feed** — SignalR hub at `/hubs/market` (broadcasts `OrderBookUpdated` and `TradeExecuted`)

Order books are in-memory and ephemeral — if the server restarts, users resubmit orders. The mint remains the source of truth for token state.

### 4. Local Dev (all services)

Run all three services in separate terminals:

```bash
# Terminal 1: Start mint
docker compose up mintd

# Terminal 2: Start server
cd BitCaster.Server && dotnet run

# Terminal 3: Start frontend
cd bitCaster && npm install && npm run dev
```

### 5. CDK mint (standalone)

```bash
cd cdk
cargo run --bin cdk-mintd -- --help
```

Refer to `cdk/README.md` for full configuration options.

### 6. Infrastructure (Azure)

```bash
cd infrastructure
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

You will need an Azure subscription and `az login` before running Terraform.
The `mint_image` variable defaults to `ghcr.io/cashubtc/cdk-mintd:latest`;
override it to use your own built image.

---

## Design System

UI mockups and product specifications live in `bitCaster-design/` (branch `bitCaster`).
The frontend in `bitCaster/` consumes the same design tokens (Tailwind palette, typography).

---

## NUT-CTF Protocol Summary

1. **Oracle announces** an event outcome as a Nostr event (kind 88)
2. **Mint registers** the announcement and derives a `condition_id`
3. **Users mint CTF tokens** locked to a `condition_id` (stake on an outcome)
4. **Oracle attests** — publishes the result as a Nostr event
5. **Mint settles** — winners swap their CTF tokens for regular sats; losing tokens become unspendable

See `nuts/NUT-CTF.md` for the complete specification.

---

## Architecture

```
User Browser (PWA)
  │  cashu-ts   ←→  CDK mintd (Azure Container Apps)
  │  NDK        ←→  Nostr relays (oracle announcements)
  │  NWC        ←→  Lightning wallet (top-up)
  │  SignalR    ←→  BitCaster.Server (matching engine + price feed)
  │  REST       ←→  BitCaster.Server (order submission)
  │
  └─ Azure Static Web Apps (CDN)

BitCaster.Server
  └─ In-memory order books (ConcurrentDictionary per market)

CDK mintd
  ├─ PostgreSQL Flexible Server (state)
  └─ Key Vault (mint keys)
```

---

## Contributing

1. Fork the repo and create a feature branch
2. Run `npm run typecheck` in `bitCaster/` before opening a PR
3. For mint changes, run the CDK test suite: `cargo test -p cdk`
4. Infrastructure changes require `terraform validate` to pass
