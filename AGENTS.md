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

Every communication should be defined as an open protocol

- bitCaster-app <-> cdk ... defined in nuts/
- bitCaster-app <-> matching engine ... defined in yaml specs under BitCaster.MatchingEngine.Contracts/specs/

## NUT-CTF Protocol Summary

1. **Oracle announces** an event outcome as a Nostr event (kind 88)
2. **Mint registers** the announcement and derives a `condition_id`
3. **Users mint CTF tokens** locked to a `condition_id` (stake on an outcome)
4. **Oracle attests** — publishes the result as a Nostr event
5. **Mint settles** — winners swap their CTF tokens for regular sats; losing tokens become unspendable

See `nuts/CTF.md` for the complete specification.

## Nostr relay

Nostr relay is used for two purposes

1. Store private information with [NIP-78.md](https://github.com/nostr-protocol/nips/blob/master/78.md)
2. Broadcast/Fetch public information including those for DLC Oracle

All informations to be stored in localStorage must also be stored in NIP-78 relay iff the user has already configured the nostr key.
For public information, DLC Oracle announcement/attestation is the only usage. We SHOULD not publish anything else for the sake of anonymity of the user.

## Monorepo Layout

```
BitCaster.MatchingEngine.Contracts/ Shared API contract types (DTOs, enums, request/response records)
BitCaster.InMemoryMatchingEngine/   In-memory matching engine for dev/testing (stores orders, no matching)
bitCaster-app/       React 19 + Vite PWA frontend
bitCaster-doc/       Astro Starlight documentation site (GitHub Pages)
bitCaster-design/    Design system, specs, and mockups
nuts/                Cashu NUT specifications (submodule, branch: nuts_for_prediction_markets)
cdk/                 Cashu Development Kit (submodule, branch: bitCaster at joemphilips/cdk)
kormir/              DLC oracle library — WASM + server (submodule at joemphilips/kormir)
cashu.me/            Reference cashu wallet (no CTF feature)
tools/               Dev tooling (seed scripts, etc.) — NOT inside cdk/
tests/E2E/           Playwright E2E tests (xUnit, docker-compose)
plans/               Implementation plan documents that has been used by coding agents
```

> **Note:** The real CLOB matching engine lives in a **private repo** at `https://github.com/joemphilips/bitCaster-matching-engine` or in one level above directory. It references `BitCaster.MatchingEngine.Contracts` via git submodule.

## Local Dev

The recommended workflow uses `docker-compose.yml` at the repo root to run the mint, then launches the server and frontend separately:

```bash
# Terminal 1: Start mint
docker compose up mintd server

# Terminal 2: Start frontend
cd bitCaster-app && npm install && npm run dev
```

The mint runs on port 8085, the server on port 5000, and the frontend on port 5173. The frontend's `.env` is pre-configured with these values.

- Prefer TDD approach: When you create a plan. First have a happy path tests in `E2E` test project. And then, create unit tests for non-happy path. And then start implementation. Continue until the test passes.

### Data Seeding

Test/seed data must **never** live in production frontend code. The frontend should show an honest empty or error state when the mint has no data.

- Seed data is injected into the CDK mint at startup via `tools/seed-conditions/seed.sh` (a bash script using `curl` + `jq` that calls the mint's REST API)
- The `seed` service in `docker-compose.yml` runs after `mintd` is healthy
- To add or change seed markets, edit `tools/seed-conditions/seed.sh`
- The announcement hex values are pre-computed from deterministic CDK test helpers (hardcoded oracle keys, no randomness)

### kormir-wasm (DLC oracle)

The frontend's become-oracle flow depends on a WASM build of kormir. The generated package is committed at `bitCaster-app/src/lib/kormir-wasm-pkg/` so normal builds and CI do not need a Rust toolchain. Rebuild it whenever the `kormir/` submodule changes:

```bash
./tools/build-kormir-wasm.sh          # release build (default)
./tools/build-kormir-wasm.sh --dev    # faster dev build
```

The script wraps `wasm-pack build --target web` and auto-detects the clang resource directory for Nix's split `clang` / `clang-lib` packages (secp256k1-sys compiles C to wasm32 and needs `stddef.h` on the include path). Prerequisites:

- `rustup target add wasm32-unknown-unknown`
- `wasm-pack` (install with `curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh`)

The frontend loads the ~3MB wasm bundle lazily via dynamic import in `bitCaster-app/src/lib/kormir.ts`, so users who never enter the oracle flow do not download it. Vite is configured to exclude the package from dep optimization (see `bitCaster-app/vite.config.ts`).

### Before Committing

1. **All tests pass** — follow the Branch Completion Workflow below.

## Branch Completion Workflow

When work on a branch is complete, follow these steps in order before publishing a PR:

1. **Run /simplify** — invoke the simplify skill to review changed code for reuse, quality, and efficiency. Commit any improvements.
2. **Run frontend tests** — `cd bitCaster-app && npm run test`
3. **Run .NET build** — `dotnet build BitCaster.MatchingEngine.Contracts/ && dotnet build BitCaster.InMemoryMatchingEngine/`
4. **Run E2E tests** — Start services with `docker compose up -d`, wait for mint (`curl localhost:8085/v1/info`), server (`curl localhost:5000/health`), and frontend (`curl localhost:5173`) to be healthy, then run `dotnet test tests/E2E/ -- RunConfiguration.MaxCpuCount=7`.
5. **Create a draft PR** — `gh pr create --draft`. Monitor CI. If CI fails, fix issues, push, and iterate until green.
6. **Publish the PR** — `gh pr ready` to mark the draft as ready for review.

## Project-Specific Details

See `.claude/rules/` for details on each subproject:
- `frontend.md` — React PWA build commands, coding conventions, env setup, key files & libraries
- `server.md` — BitCaster.MatchingEngine.Contracts + InMemoryMatchingEngine (contract/mock split)
- `nut-ctf.md` — NUT-CTF protocol and specs
- `doc-site.md` — Astro Starlight documentation site
- `design.md` — Design system references
- `e2e-tests.md` — E2E testing with Playwright + docker-compose

