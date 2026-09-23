# bitCaster — Agent Instructions

**Free, anonymous, Bitcoin-native prediction markets powered by Cashu ecash.**

Market positions are **Cashu conditional tokens (CTF)** — ecash spendable only when a DLC oracle attests a specific outcome. No accounts, no KYC, no custodians — settlement is enforced cryptographically by the mint. **Nostr** provides identity, oracle announcements, and NWC.

## Design Principle

### Shared Logic Lives in the SDK

Any logic used by more than one consumer (bitCaster-app, bitcaster-daemon,
bitcaster-cli, bitcaster-wallet-service, or any future client) MUST be
implemented in `bitcaster-client-sdk/` and imported from there. Do not
duplicate parsing, validation, fee calculation, proof selection, keyset
resolution, or protocol-level logic across consumers. If you find yourself
copy-pasting a function into a second consumer, move it to the SDK first.
This includes the wallet-service — its `CashuWalletService` must not
reimplement SDK logic that the frontend and daemon already use.

### Open Protocol First

Every communication should be defined as an open protocol:

- bitCaster-app ↔ cdk — defined in `nuts/`
- bitCaster-app ↔ matching engine — defined in yaml specs under `BitCaster.MatchingEngine.Contracts/specs/`

Public contracts and docs in this submodule must describe only wire-visible
behavior: endpoints, schemas, authentication, errors, state semantics, and
client obligations. Do not mention non-public service repositories or backend
implementation choices in `BitCaster.MatchingEngine.Contracts/`,
`bitCaster-app/`, or `bitCaster-doc/`.

### Keep user funds authority client-side

- Keep complete private custody state in the client durable store.
- A reviewed independent asset-monitoring domain can show a display-only
  economic portfolio.
- Do not use that projection for spending, settlement, proof selection, refunds,
  penalties, Score, eviction, or deletion.
- A browser can use a separate client-encrypted backup for quota and origin-loss
  recovery.
- The backup service must not learn proof secrets or spending authority.
- Use encrypted NIP-78 records only for other approved private application
  state.
- Creator-market discovery can be public or indexed by the engine.
- Keep private oracle drafts out of public storage.

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
bitcaster-client-sdk/ Shared client protocol and wallet logic
bitcaster-cli/        CLI client
bitcaster-daemon/     Native client service
bitCaster-app/       React 19 + Vite PWA frontend
bitCaster-doc/       Astro Starlight doc site (GitHub Pages)
bitCaster-design/    Design specs and mockups
nuts/                Cashu NUT specs (submodule: nuts_for_prediction_markets)
nips-protocol/       Nostr NIP specs (submodule: nostr-protocol/nips — upstream, read-only)
cdk/                 Cashu Development Kit (submodule: joemphilips/cdk, branch bitCaster)
kormir/              DLC oracle library — WASM + server (submodule: joemphilips/kormir)
cashu.me/            Reference cashu wallet (no CTF)
tools/               Dev tooling (seed scripts, worktree-services.sh, build-kormir-wasm.sh)
```

The matching engine is an external service from this public repo's perspective.
Public code, contracts, docs, and standalone builds must not depend on a
private parent repository. An embedding repository can supply test-only
integration scenarios without creating a shipped dependency.

## Nostr Usage

1. Use NIP-78 with NIP-44 self-encryption for approved private application records when the user has configured a Nostr key. Do not use this rule to mirror custody state or proof secrets. Follow the client-custody and encrypted-backup boundaries above.
2. **Public app state** via NIP-78 or engine indexing — non-sensitive records like "markets this pubkey created" may be public when that improves UX.
3. **Public broadcast/fetch** for DLC oracle announcements / attestations — these are public protocol artifacts.

When you need to understand a NIP, read the spec from the `nips-protocol/` submodule (pinned upstream copy of `nostr-protocol/nips`). **Do not edit files under `nips-protocol/`** — it is an upstream reference and must stay untouched. To pull a newer revision, bump the submodule pointer with `git submodule update --remote nips-protocol` rather than editing its contents.

## Local Dev

```bash
docker compose up -d                 # mint, cashu-me, relay, LNBits, and seed; no matching engine
cd bitCaster-app && npm run dev      # frontend:5273
```

Check `bitCaster-app/.env.example`, `bitCaster-app/vite.config.ts`, and
`docker-compose.yml` for the current configuration.
The matching engine is a separate service.
Run service commands only against authorized local fixtures.

- Add regression coverage at the layer that owns the changed behavior. Use a
  failing-first test when practical. Use full-stack coverage when integration
  behavior requires it.
- **Never embed test/seed data in frontend source.** The frontend must fetch from `GET /v1/conditions` and show an honest empty/error state when the mint has no data. Seed data lives in `tools/seed-conditions/seed.sh` and is injected via docker-compose.
- **Browser checks and local service ownership** — see `.claude/rules/e2e-tests.md`.
- **kormir-wasm rebuild** — see `.claude/rules/frontend.md`.

## Branch Completion Workflow

Complete the requested change and its relevant verification. Correct in-scope
failures before handing off the result. Preserve the approved plan's review
and test gates. Do not run product builds for prose-only changes.

- Frontend tests: `cd bitCaster-app && npm run test`.
- Frontend build: `cd bitCaster-app && npm run build`.
- Public contract build: `dotnet build BitCaster.MatchingEngine.Contracts/`.
- Browser checks: follow `.claude/rules/e2e-tests.md` when the change needs them.
- Review non-trivial changes for correctness, reuse, maintainability, and risk.
  Do not require an unavailable named skill to perform that review.

These checks do not authorize publication or deployment. When PR publication
is authorized, create a draft PR. Monitor CI and correct in-scope failures.
Mark the PR ready only after its required gates pass.

## Subproject Rules

Details scoped per subproject live in `.claude/rules/`:

- `frontend.md` — React PWA, env setup, kormir-wasm build
- `server.md` — Public contract conventions
- `nut-ctf.md` — NUT-CTF protocol and CDK submodule policy
- `e2e-tests.md` — Browser checks and local service ownership
- `doc-site.md` — Astro Starlight
- `design.md` — Design system
- `cdk.md` — CDK (upstream) build / lint / style

## Repo-Local Skills

Use `.agents/skills/bitcaster-frontend-guideline` for user-visible frontend
behavior. This includes errors, notifications, recovery progress, and browser
persistence.
