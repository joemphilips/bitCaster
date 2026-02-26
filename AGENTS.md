# bitCaster — Agent Instructions

**Free, anonymous, Bitcoin-native prediction markets powered by Cashu ecash**

- Market positions are **Cashu conditional tokens** (CTF) — ecash spendable only when a DLC oracle attests a specific outcome
- **No accounts, no KYC, no custodians** — settlement is enforced cryptographically by the mint
- **Nostr** provides identity (optional), oracle announcements, and Nostr Wallet Connect (NWC)
- The Cashu mint runs **CDK** (Cashu Development Kit in Rust) with the NUT-CTF extension

## Architecture

```
User Browser (PWA)
  │  cashu-ts   ←→  CDK mintd (Azure Container Apps)
  │  NDK        ←→  Nostr relays (oracle announcements)
  │  NWC        ←→  Lightning wallet (top-up)
  │  SignalR    ←→  Matching Engine (matching engine + price feed)
  │  REST       ←→  Matching Engine (order submission)
  │
  └─ Azure Static Web Apps (CDN)

Matching Engine (private repo: bitCaster-matching-engine)
  └─ In-memory order books (ConcurrentDictionary per market)

CDK mintd
  ├─ PostgreSQL Flexible Server (state)
  └─ Key Vault (mint keys)
```

## Design Principle — Open Protocol First

Every feature should be an **open protocol defined in a NUT** and implemented in **CDK**, not a custom endpoint in the matching engine.

- The frontend talks directly to the mint for all protocol-level operations (e.g. market discovery via `/v1/conditions`, minting CTF tokens, settlement).
- **The matching engine exists only for the order book** (order book + real-time price feed via SignalR) — functionality that is inherently centralised and cannot be expressed as an open spec. The real implementation lives in a **private repo** (`bitCaster-matching-engine`); this monorepo contains only shared contracts and a mock server for development/testing.
- When adding a new feature, ask: *"Can this be a NUT endpoint on the mint?"* — if yes, it belongs in `nuts/` + `cdk/`, not in the matching engine.
- All information should be stored in users side as much as possible

## NUT-CTF Protocol Summary

1. **Oracle announces** an event outcome as a Nostr event (kind 88)
2. **Mint registers** the announcement and derives a `condition_id`
3. **Users mint CTF tokens** locked to a `condition_id` (stake on an outcome)
4. **Oracle attests** — publishes the result as a Nostr event
5. **Mint settles** — winners swap their CTF tokens for regular sats; losing tokens become unspendable

See `nuts/CTF.md` for the complete specification.

## Monorepo Layout

```
BitCaster.MatchingEngine.Contracts/ Shared API contract types (DTOs, enums, request/response records)
BitCaster.InMemoryMatchingEngine/   In-memory matching engine for dev/testing (stores orders, no matching)
bitCaster/           React 19 + Vite PWA frontend
bitCaster-doc/       Astro Starlight documentation site (GitHub Pages)
bitCaster-design/    Design system, specs, and mockups
infrastructure/      Terraform for Azure (Container Apps, PostgreSQL, Static Web Apps)
nuts/                Cashu NUT specifications (submodule, branch: nuts_for_prediction_markets)
cdk/                 Cashu Development Kit (submodule, branch: bitCaster at joemphilips/cdk)
cashu.me/            Reference cashu wallet (no CTF feature)
tools/               Dev tooling (seed scripts, etc.) — NOT inside cdk/
tests/E2E/           Playwright E2E tests (xUnit, docker-compose)
plans/               Implementation plan documents that has been used by coding agents
```

> **Note:** The real CLOB matching engine lives in a **private repo** at `~/working/src/cashu/bitCaster-matching-engine`. It references `BitCaster.MatchingEngine.Contracts` via git submodule.

## Local Dev

The recommended workflow uses `docker-compose.yml` at the repo root to run the mint, then launches the server and frontend separately:

```bash
# Terminal 1: Start mint
docker compose up mintd

# Terminal 2: Start in-memory matching engine
cd BitCaster.InMemoryMatchingEngine && dotnet run

# Terminal 3: Start frontend
cd bitCaster && npm install && npm run dev
```

The mint runs on port 8085, the server on port 5000, and the frontend on port 5173. The frontend's `.env` is pre-configured with these values.

- Prefer TDD approach: When you create a plan. First have a happy path tests in `E2E` test project. And then, create unit tests for non-happy path. And then start implementation. Continue until the test passes.

### Data Seeding

Test/seed data must **never** live in production frontend code. The frontend should show an honest empty or error state when the mint has no data.

- Seed data is injected into the CDK mint at startup via `tools/seed-conditions/` (a standalone Rust binary that calls the mint's REST API)
- The `seed` service in `docker-compose.yml` runs after `mintd` is healthy
- To add or change seed markets, edit `tools/seed-conditions/src/main.rs`

### Before Committing

1. **All tests pass** — run `dotnet test` from the repo root and ensure all unit and integration tests are green.

## Project-Specific Details

See `.claude/rules/` for details on each subproject:
- `frontend.md` — React PWA build commands, coding conventions, env setup, key files & libraries
- `server.md` — BitCaster.MatchingEngine.Contracts + InMemoryMatchingEngine (contract/mock split)
- `nut-ctf.md` — NUT-CTF protocol and specs
- `doc-site.md` — Astro Starlight documentation site
- `design.md` — Design system references
- `infrastructure.md` — Terraform / Azure deployment
- `e2e-tests.md` — E2E testing with Playwright + docker-compose

## Competitive Landscape

When reviewing features or writing docs, keep these differentiators in mind:

| | **bitCaster** | **Predyx** | **Polymarket** |
|---|---|---|---|
| **Custody** | Custodial mint, but bearer tokens held client-side ([trust model](https://bitcoin.design/guide/how-it-works/ecash/introduction/)) | Server-side (traditional exchange model) | Non-custodial (on-chain settlement on Polygon) |
| **Matching** | CLOB (central limit order book) | AMM (automated market maker) | Hybrid CLOB (off-chain matching, on-chain settlement) |
| **Privacy** | High — ecash + Lightning leave no on-chain trace | Low — all data server-side | Low — all trades visible on Polygon |
| **Market creation** | Open — anyone can create markets via Nostr + DLC oracle specs | Closed — platform-controlled | Closed — platform-controlled |
| **Token overhead** | None (Bitcoin/Lightning only) | None | Requires USDC on Polygon; bridging costs |
| **Specs** | Open (NUT-CTF, Nostr kind 88, DLC) | Proprietary | Partially open (CLOB API docs public, protocol on Polygon) |

### Key Trade-offs
- **AMM vs CLOB**: AMMs (Predyx) bootstrap liquidity without market makers but suffer wide spreads in large outcome spaces and numerical markets. CLOBs (bitCaster, Polymarket) offer tighter spreads but require active market makers.
- **On-chain vs ecash**: Polymarket's on-chain settlement provides full auditability but incurs gas costs, bridging friction, and public transaction history. bitCaster's ecash model trades on-chain auditability for instant settlement, zero gas, and strong privacy.

Related services:
- Predyx: https://beta.predyx.com/
- Polymarket: https://polymarket.com
- Polymarket CLOB docs: https://docs.polymarket.com/developers/CLOB/introduction
