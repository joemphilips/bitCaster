# bitCaster — Agent Instructions

**Free, anonymous, Bitcoin-native prediction markets powered by Cashu ecash.**

Market positions are **Cashu conditional tokens (CTF)** — ecash spendable only when a DLC oracle attests a specific outcome. No accounts, no KYC, no custodians — settlement is enforced cryptographically by the mint. **Nostr** provides identity, oracle announcements, and NWC.

## Architecture

```
User Browser (PWA)
  │  cashu-ts   ←→  CDK mintd (Azure Container Apps)
  │  NDK        ←→  Nostr relays (oracle announcements)
  │  NWC        ←→  Lightning wallet (top-up)
  │  SignalR    ←→  Matching Engine API (price feed)
  │  REST       ←→  Matching Engine API (order submission)
  │
  └─ Azure Static Web Apps (CDN)

Matching Engine API
  └─ Public REST / SignalR contract defined by this repo

CDK mintd
  ├─ PostgreSQL Flexible Server (state)
  └─ Key Vault (mint keys)
```

## Design Principle

### Shared Logic Lives in the SDK

Any logic used by more than one consumer (bitCaster-app, bitcaster-daemon,
bitcaster-cli, or any future client) MUST be implemented in
`bitcaster-client-sdk/` and imported from there. Do not duplicate parsing,
validation, fee calculation, proof selection, or protocol-level logic across
consumers. If you find yourself copy-pasting a function into a second
consumer, move it to the SDK first.

### Open Protocol First

Every communication should be defined as an open protocol:

- bitCaster-app ↔ cdk — defined in `nuts/`
- bitCaster-app ↔ matching engine — defined in yaml specs under `BitCaster.MatchingEngine.Contracts/specs/`

Public contracts and docs in this submodule must describe only wire-visible
behavior: endpoints, schemas, authentication, errors, state semantics, and
client obligations. Do not mention non-public service repositories or backend
implementation choices in `BitCaster.MatchingEngine.Contracts/`,
`bitCaster-app/`, or `bitCaster-doc/`.

### User-specific state must be handled client-side

- Matching engine **should NOT** store user information as much as possible. It's sole purpose is to keep the markets liquid and tradable.
- Private user-specific data must be handled client-side using localStorage for reload UX and encrypted NIP-44 content inside Nostr [NIP-78](https://github.com/nostr-protocol/nips/blob/master/78.md) replaceable events when the user has configured a Nostr key. Examples: portfolio activity history, local wallet workflow records, private oracle drafts, and anything the engine cannot verify as authoritative.
- Creator-market discovery is not private by itself; it can be mirrored publicly or indexed by the engine for UX. Keep sensitive creator-side material out of public storage unless it is already public Nostr/oracle data.

### Live Market Values

All market price and position-value surfaces must update from the real-time
price feed without requiring a page reload. This includes market-detail prices,
order-book visible depth after reservations/fills, portfolio active/closed
position values, and claim-time position displays.

For lifecycle transitions that do not affect live price/value display, prefer
event-driven updates or explicit user refresh/reload over background polling.
Do not introduce long polling for eventual consistency unless the event source
is unavailable and the bounded polling behavior is documented as a temporary
release tradeoff.

## Monorepo Layout

```
BitCaster.MatchingEngine.Contracts/ Shared API DTOs, enums, request/response records
BitCaster.InMemoryMatchingEngine/   Dev/test stub server (no matching)
bitCaster-app/       React 19 + Vite PWA frontend
bitCaster-doc/       Astro Starlight doc site (GitHub Pages)
bitCaster-design/    Design specs and mockups
nuts/                Cashu NUT specs (submodule: nuts_for_prediction_markets)
nips-protocol/       Nostr NIP specs (submodule: nostr-protocol/nips — upstream, read-only)
cdk/                 Cashu Development Kit (submodule: joemphilips/cdk, branch bitCaster)
kormir/              DLC oracle library — WASM + server (submodule: joemphilips/kormir)
cashu.me/            Reference cashu wallet (no CTF)
tools/               Dev tooling (seed scripts, worktree-services.sh, build-kormir-wasm.sh)
tests/E2E/           Playwright E2E tests (xUnit)
```

The matching engine is an external service from this public repo's perspective.
This repo owns only the public contract, mock/dev server, frontend, and docs.

## Nostr Usage

1. **Private storage** via [NIP-78](https://github.com/nostr-protocol/nips/blob/master/78.md) + NIP-44 self-encryption — private records in localStorage must also be mirrored to encrypted NIP-78 iff the user has configured a Nostr key.
2. **Public app state** via NIP-78 or engine indexing — non-sensitive records like "markets this pubkey created" may be public when that improves UX.
3. **Public broadcast/fetch** for DLC oracle announcements / attestations — these are public protocol artifacts.

When you need to understand a NIP, read the spec from the `nips-protocol/` submodule (pinned upstream copy of `nostr-protocol/nips`). **Do not edit files under `nips-protocol/`** — it is an upstream reference and must stay untouched. To pull a newer revision, bump the submodule pointer with `git submodule update --remote nips-protocol` rather than editing its contents.

## Local Dev

```bash
docker compose up -d                 # mint:8085, server:5000, cashu-me:3000, nostr-relay, lnbits:5102, seed
cd bitCaster-app && npm run dev      # frontend:5273
```

The frontend `.env` is pre-configured with the default ports.

- **TDD first**: when planning a feature, start with a happy-path E2E test in `tests/E2E/`, then unit tests for edge cases, then implement until green.
- **Never embed test/seed data in frontend source.** The frontend must fetch from `GET /v1/conditions` and show an honest empty/error state when the mint has no data. Seed data lives in `tools/seed-conditions/seed.sh` and is injected via docker-compose.
- **Parallel worktrees + port slots** — see `.claude/rules/e2e-tests.md`.
- **kormir-wasm rebuild** — see `.claude/rules/frontend.md`.

## Zustand + React Patterns

- Never subscribe to state that a useEffect modifies (infinite retry loop) — use `useRef` one-shot guard + `useWalletStore.getState()` instead of selectors inside effects that trigger `addMint` or similar async mutations
- Zustand `persist` rehydrates asynchronously — reading `getState()` inside a mount effect returns the initial state, not the persisted one. Gate boot-time reads on `persist.hasHydrated()` + `persist.onFinishHydration(fn)`.
- E2E tests seed localStorage between `GotoAsync(/setup)` and `GotoAsync(/target)` — any boot effect that writes back through persist middleware will overwrite the seed. If the effect must skip certain routes (e.g. the setup wizard owns mint config), check `window.location.pathname` against a `WIZARD_PATHS` list.
- `addMint(url)` in `stores/wallet.ts` sets `activeMintUrl` as a side-effect. Never call it from untrusted inputs (inbound NIP-17 DMs, query strings, etc.) without explicit user consent — doing so lets an attacker silently retarget the user's active mint.

## Branch Completion Workflow

When work on a branch is complete, follow these steps in order before publishing a PR:

1. **Run /simplify** — invoke the simplify skill to review changed code for reuse, quality, and efficiency. Commit any improvements.
2. **Run frontend tests** — `cd bitCaster-app && npm run test`
3. **Run .NET build** — `dotnet build BitCaster.MatchingEngine.Contracts/ && dotnet build BitCaster.InMemoryMatchingEngine/`
4. **Run E2E tests** — `docker compose up -d`, wait for mint (`curl localhost:8085/v1/info`), server (`curl localhost:5000/health`), and frontend (`curl localhost:5273`) to be healthy, then `dotnet test tests/E2E/ -- RunConfiguration.MaxCpuCount=7`.
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
