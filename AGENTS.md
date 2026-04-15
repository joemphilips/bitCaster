# bitCaster — Agent Instructions

**Free, anonymous, Bitcoin-native prediction markets powered by Cashu ecash.**

Market positions are **Cashu conditional tokens (CTF)** — ecash spendable only when a DLC oracle attests a specific outcome. No accounts, no KYC, no custodians — settlement is enforced cryptographically by the mint. **Nostr** provides identity, oracle announcements, and NWC.

## Architecture

```
User Browser (PWA)
  │  cashu-ts   ←→  CDK mintd (Azure Container Apps)
  │  NDK        ←→  Nostr relays (oracle announcements)
  │  NWC        ←→  Lightning wallet (top-up)
  │  SignalR    ←→  Matching Engine (price feed)
  │  REST       ←→  Matching Engine (order submission)
  │
  └─ Azure Static Web Apps (CDN)

Matching Engine (private repo: bitCaster-matching-engine)
  └─ In-memory order books (ConcurrentDictionary per market)

CDK mintd
  ├─ PostgreSQL Flexible Server (state)
  └─ Key Vault (mint keys)
```

## Design Principle

### Open Protocol First

Every communication should be defined as an open protocol:

- bitCaster-app ↔ cdk — defined in `nuts/`
- bitCaster-app ↔ matching engine — defined in yaml specs under `BitCaster.MatchingEngine.Contracts/specs/`

### User-specific state must handled by client-side

- Matching engine **should NOT** store user information as much as possible. It's sole purpose is to keep the markets liquid and tradable.
- User-specific data must be handled by client side using Nostr [NIP-78](https://github.com/nostr-protocol/nips/blob/master/78.md), or simply by localStorage if user has not configured nostr pubkey

## Monorepo Layout

```
BitCaster.MatchingEngine.Contracts/ Shared API DTOs, enums, request/response records
BitCaster.InMemoryMatchingEngine/   Dev/test stub server (no matching)
bitCaster-app/       React 19 + Vite PWA frontend
bitCaster-doc/       Astro Starlight doc site (GitHub Pages)
bitCaster-design/    Design specs and mockups
nuts/                Cashu NUT specs (submodule: nuts_for_prediction_markets)
cdk/                 Cashu Development Kit (submodule: joemphilips/cdk, branch bitCaster)
kormir/              DLC oracle library — WASM + server (submodule: joemphilips/kormir)
cashu.me/            Reference cashu wallet (no CTF)
tools/               Dev tooling (seed scripts, worktree-services.sh, build-kormir-wasm.sh)
tests/E2E/           Playwright E2E tests (xUnit)
```

The real CLOB matching engine is a **private repo** one level above (`bitCaster-matching-engine`); it references `BitCaster.MatchingEngine.Contracts` via submodule.

## Nostr Usage

1. **Private storage** via [NIP-78](https://github.com/nostr-protocol/nips/blob/master/78.md) — anything in localStorage must also be mirrored to NIP-78 iff the user has configured a nostr key.
2. **Public broadcast/fetch** for DLC oracle announcements / attestations **only** — never publish anything else (user anonymity).

## Local Dev

```bash
docker compose up -d                 # mint:8085, server:5000, cashu-me:3000, nostr-relay, lnbits, seed
cd bitCaster-app && npm run dev      # frontend:5173
```

The frontend `.env` is pre-configured with the default ports.

- **TDD first**: when planning a feature, start with a happy-path E2E test in `tests/E2E/`, then unit tests for edge cases, then implement until green.
- **Never embed test/seed data in frontend source.** The frontend must fetch from `GET /v1/conditions` and show an honest empty/error state when the mint has no data. Seed data lives in `tools/seed-conditions/seed.sh` and is injected via docker-compose.
- **Parallel worktrees + port slots** — see `.claude/rules/e2e-tests.md`.
- **kormir-wasm rebuild** — see `.claude/rules/frontend.md`.

## Branch Completion Workflow

When work on a branch is complete, follow these steps in order before publishing a PR:

1. **Run /simplify** — invoke the simplify skill to review changed code for reuse, quality, and efficiency. Commit any improvements.
2. **Run frontend tests** — `cd bitCaster-app && npm run test`
3. **Run .NET build** — `dotnet build BitCaster.MatchingEngine.Contracts/ && dotnet build BitCaster.InMemoryMatchingEngine/`
4. **Run E2E tests** — `docker compose up -d`, wait for mint (`curl localhost:8085/v1/info`), server (`curl localhost:5000/health`), and frontend (`curl localhost:5173`) to be healthy, then `dotnet test tests/E2E/ -- RunConfiguration.MaxCpuCount=7`.
5. **Create a draft PR** — `gh pr create --draft`. Monitor CI. If CI fails, fix issues, push, and iterate until green.
6. **Publish the PR** — `gh pr ready`.

## Subproject Rules

Details scoped per subproject live in `.claude/rules/`:

- `frontend.md` — React PWA, env setup, kormir-wasm build
- `server.md` — Contracts + InMemoryMatchingEngine, market-ID / order-book model
- `nut-ctf.md` — NUT-CTF protocol and CDK submodule policy
- `e2e-tests.md` — Playwright E2E, port overrides, parallel worktree slots
- `doc-site.md` — Astro Starlight
- `design.md` — Design system
- `cdk.md` — CDK (upstream) build / lint / style
