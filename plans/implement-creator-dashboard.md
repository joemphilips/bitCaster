# Implement /creator Dashboard — Port Market Creation & Management Spec

## Problem

`/creator` currently renders a 3-line placeholder at
`bitCaster-app/src/pages/CreatorPage.tsx`. The bottom-nav "Creator" tab routes
here (`App.tsx:42`), but there's nothing to see.

The design spec lives at
`bitCaster-design/product/sections/market-creation-and-management/` (types,
data, `spec.md`) with a reference React implementation under
`bitCaster-design/src/sections/market-creation-and-management/components/`.

The spec calls for a 3-view dashboard (Overview / Analytics / Add Market CTA)
with stats cards, a market list, time-series charts, and a 5-step creation
wizard. Several pieces already exist on main and must not be rebuilt:

- `/creator/new` is a **fully-implemented 6-step wizard** — leave untouched.
- `bitCaster-app/src/components/portfolio/{MyMarkets,CreatedMarketRow}.tsx`
  already render a list of created markets and are used by `/portfolio`.
- `bitCaster-app/src/types/portfolio.ts` defines `CreatedMarket` (simpler than
  the design's discriminated `CreatorMarket` union).
- `bitCaster-app/src/types/market-management.ts` already mirrors the design's
  dashboard types (`DashboardStats`, `ActiveTab`, etc).

Several backend pieces are missing:

- Engine has **no creator identity** — zero hits for `CreatorFee`, `ClaimFee`,
  `CreatorPubkey`. Markets don't know who made them.
- No endpoint aggregates stats for a given creator.
- `POST /api/v1/markets/{conditionId}` exists on the in-memory mock
  (`BitCaster.InMemoryMatchingEngine/Endpoints/MarketEndpoints.cs`) but **not**
  on the real engine (`BitCaster.MatchingEngine.ApiService/Program.cs`).

## Goals

1. Replace the `/creator` stub with a functional dashboard: header + Create
   Market CTA + stat cards (Active / Resolved / Total Volume) + Overview /
   Analytics tabs + list of the user's created markets + draft-in-progress
   banner.
2. Add a new per-pubkey creator-markets endpoint
   (`GET /api/v1/creators/{pubkey}/markets`) on both `BitCaster.MatchingEngine`
   (real) and `BitCaster.InMemoryMatchingEngine` (mock).
3. Extend `CreateMarketRequest` with an **optional** `creatorPubkey` so existing
   callers (seed script, wallets without Nostr) keep working.
4. Track the user's created markets client-side with a Zustand store mirrored to
   NIP-78 (matching `useBookmarkStore` + `useBookmarkSync`), so creators keep
   their list across devices once a Nostr key is configured.
5. Wire the `/creator/new` wizard's success path to write into the new store +
   send `creatorPubkey` with the create request.
6. Reuse `MyMarkets` / `CreatedMarketRow` for the list UI to avoid duplicating
   row components.

## Non-goals

- **No rework of the `/creator/new` wizard.** The shipped 6-step flow is the
  authoritative version; the design spec's "5-step wizard" description is
  outdated but not in scope to fix here.
- **Fees are fully stubbed client-side.** No backend fee accrual, no claim
  endpoint, no fee row action. Fee columns display `0` with a "Fees tracking —
  coming soon" footnote.
- **Analytics tab is a "Coming soon" placeholder** — no time-series endpoint
  exists, and synthesising one is out of scope.
- **No pagination in v1** — `MyMarkets` already handles a flat list. Add
  pagination if/when a creator has 20+ markets.
- **No row-level Cancel Market action** — no backend support.
- **No AI description generator** — the design calls for one but it's out of
  scope.
- **No `creatorPubkey` signature verification** — self-declared for v1. Add NIP-01
  Schnorr verification in a follow-up when the feature moves past cosmetic use.

## Backend changes

### Contracts — `bitCaster/BitCaster.MatchingEngine.Contracts/`

**`specs/openapi.yaml`**

1. Add optional `creatorPubkey` (64-char lowercase hex) to the
   `CreateMarketRequest` schema used by `POST /api/v1/markets/{conditionId}`:

   ```yaml
   creatorPubkey:
     type: string
     pattern: '^[0-9a-f]{64}$'
     description: >
       Nostr pubkey hex. Optional. When present, the market is indexed under
       this creator for dashboard queries.
   ```

2. Add a new path:

   ```yaml
   /api/v1/creators/{pubkey}/markets:
     get:
       operationId: getCreatorMarkets
       summary: List markets created by a Nostr pubkey
       parameters:
         - name: pubkey
           in: path
           required: true
           schema: { type: string, pattern: '^[0-9a-f]{64}$' }
       responses:
         '200':
           content:
             application/json:
               schema: { $ref: '#/components/schemas/CreatorMarketsResponse' }
         '400':
           description: Malformed pubkey
   ```

3. Add response schemas:

   ```yaml
   CreatorMarketEntry:
     type: object
     required: [marketId, conditionId, outcomeName, totalVolumeSats,
                totalLiquiditySats, uniqueTraderCount, totalTrades, createdAt]
     properties:
       marketId:          { type: string }
       conditionId:       { type: string }
       outcomeName:       { type: string }
       totalVolumeSats:   { $ref: '#/components/schemas/Sats' }
       totalLiquiditySats:{ $ref: '#/components/schemas/Sats' }
       uniqueTraderCount: { type: integer }
       totalTrades:       { type: integer }
       createdAt:         { type: string, format: date-time }

   CreatorMarketsResponse:
     type: object
     required: [creatorPubkey, markets]
     properties:
       creatorPubkey: { type: string }
       markets:
         type: array
         items: { $ref: '#/components/schemas/CreatorMarketEntry' }
   ```

**`Generated/ApiContracts.g.cs`** — regenerate via the project's existing
OpenAPI→C# pipeline. Extend `CreateMarketRequest` (nullable `string?
CreatorPubkey = null`). New `CreatorMarketEntry` + `CreatorMarketsResponse`
records.

**`bitCaster-app/src/generated/api.ts`** — regenerate via
`npm run gen:api` (see `bitCaster-app/package.json`). New TS types for the
endpoint + response.

### In-memory mock — `BitCaster.InMemoryMatchingEngine/Endpoints/MarketEndpoints.cs`

1. Add a module-level `ConcurrentDictionary<string, HashSet<string>>
   CreatorIndex` keyed by `creatorPubkey → Set<conditionId>`. Guarded so only
   non-null, 64-hex-char pubkeys are indexed.
2. In the existing `POST /api/v1/markets/{conditionId}` handler, after
   `Markets.TryAdd` succeeds, append to `CreatorIndex`.
3. Change the `Markets` value type to record `CreatedAt` alongside the existing
   `CreateMarketResponse` (tuple or small record).
4. Add a new `MapGet("/api/v1/creators/{pubkey}/markets", ...)` handler that:
   - Validates pubkey format → `Results.BadRequest` on fail
   - Returns `CreatorMarketsResponse` with empty list for unknown pubkey
   - For known pubkey: iterates the indexed condition IDs, expands to per-outcome
     market IDs, reads liquidity from `LiquidityEndpoints.Pools` where
     available, returns per-market entries. `totalVolumeSats`, `totalTrades`,
     `uniqueTraderCount` stay at 0 in the mock (no fills happen locally).

Unit tests: extend whatever covers `MarketEndpoints.cs` today
(`BitCaster.MatchingEngine.Unit/`) — assert index population on create,
assert query returns the right entries, assert malformed pubkey → 400, assert
unknown pubkey → empty list (200).

### Real engine — `BitCaster.MatchingEngine.ApiService/` + `BitCaster.MatchingEngine.Domain/`

Real-engine work is **phased**. This PR ships the contract surface and a
working minimum; deeper Sekiban projection work is explicitly deferred.

**Phase 1 (in this PR):**

1. Extend `CreateMarketRequest` in `BitCaster.MatchingEngine.Domain/Contracts/
   Endpoints/MarketContracts.cs` with `string? CreatorPubkey = null`
   (`[property: Id(5)]`). Register in
   `BitCasterMatchingEngineDomainEventsJsonContext`.
2. Add `CreatorMarketEntry` / `CreatorMarketsResponse` records (same file or a
   new `CreatorContracts.cs`) with `[GenerateSerializer]`.
3. Add the missing `POST /api/v1/markets/{conditionId}` handler in
   `ApiService/Program.cs`. Route into the existing seed/create command path
   (the same one the seed script uses) extended to accept `creatorPubkey`.
4. Extend the `OrderBookCreated` event (or the equivalent aggregate creation
   event) with `string? CreatorPubkey = null` and store it in
   `OrderBookPayload` at a new `[property: Id(...)]` slot. Projector applies it.
5. Add `GET /api/v1/creators/{pubkey}/markets` handler. Minimum viable: returns
   an empty `CreatorMarketsResponse` + a `// TODO: Sekiban multi-projection
   query` marker. This honours the contract without blocking the PR on a full
   projector implementation.

**Phase 2 (follow-up PR, out of scope here):**

- `GetCreatorMarketsQuery : IMultiProjectionQuery<AggregateListProjector<OrderBookProjector>, ...>`
  walking `OrderBookPayload` aggregates filtered by `CreatorPubkey`, joined with
  `CpmmPoolProjector` for liquidity.

Phase 1 is enough for in-memory-mock dev and establishes a stable contract
shape for clients.

Integration test in `BitCaster.MatchingEngine.E2E/`: POST a market with
`creatorPubkey`, GET `/creators/{pubkey}/markets`, assert shape (Phase 1 will
assert empty list + 200; Phase 2 upgrades the assertion).

## Frontend changes

### New files — `bitCaster-app/src/`

1. **`stores/creatorMarkets.ts`** — Zustand + `persist` store, key
   `bitcaster-creator-markets`. Shape:

   ```ts
   interface CreatorMarketEntry {
     conditionId: string         // primary key
     marketIds: string[]         // [`${conditionId}-${outcomeName}`, ...]
     title: string               // cached from wizard for offline display
     imageUrl: string | null
     creatorPubkey: string | null
     createdAt: string           // ISO 8601
   }

   interface CreatorMarketsState {
     entries: CreatorMarketEntry[]
     addCreatedMarket: (entry: CreatorMarketEntry) => void
     removeCreatedMarket: (conditionId: string) => void
     mergeFromRemote: (entries: CreatorMarketEntry[]) => void
   }
   ```

   `mergeFromRemote` unions by `conditionId`, prefers remote stats but keeps
   local `title` when remote is missing it.

2. **`lib/nip78CreatorMarkets.ts`** — mirrors `lib/nip78Bookmarks.ts`. Kind
   `30078`, d-tag `bitcaster:creator-markets`, content `{ markets:
   CreatorMarketEntry[] }`.

3. **`stores/useCreatorSync.ts`** — mirrors `stores/useBookmarkSync.ts`. On
   mnemonic change: derive Nostr key pair, `fetchFromRelays`, `mergeFromRemote`.
   On store change: debounced 800 ms publish to relays.

4. **`hooks/useCreatorDashboardState.ts`** — owns `activeTab`, `loading`,
   `error`, `creatorMarkets: CreatedMarket[]`, `dashboardStats: DashboardStats`,
   `refresh()`. Fetches on mount + on mnemonic change:
   - If mnemonic present: `fetchCreatorMarkets(pubkey)` from the engine
   - Fallback: iterate `useCreatorMarketsStore.entries`, call
     `fetchMarketMetadata(marketId)` in parallel, assemble `CreatedMarket[]`
   - Joins the engine response with titles/imageUrl from the store + any
     `fetchConditions()` enrichment for closing date / category tags
   - Derives `DashboardStats`: activeCount / resolvedCount / refundedCount from
     per-market status (status derivation: status = `'active'` always for v1 —
     the engine has no resolution state machine yet), totalVolumeSats = sum,
     all fee fields = 0

5. **`components/creator/CreatorDashboard.tsx`** — presentational component.
   Props: `{ stats, markets, activeTab, onTabChange, onCreateMarket,
   onViewMarket, hasDraft, draftTitle, draftStep, onContinueDraft,
   onDiscardDraft, hasNostrKey, loading, error, onRefresh }`.

   Layout:
   - Header with title + "Create Market" CTA (navigates to `/creator/new`)
   - 3-tile `StatCard` grid: Active / Resolved / Total Volume
   - Tab row: Overview / Analytics
   - Overview: optional info banner when `!hasNostrKey` ("Configure a wallet
     to sync your creator history across devices"), then `<MyMarkets>` with
     empty state, then optional draft-in-progress banner that reads from
     `useMarketDraftStore` (step X of 6, title from `stepBasicInfo?.title`)
   - Analytics: `<AnalyticsComingSoon />`
   - Loading skeleton and error states

6. **`components/creator/AnalyticsComingSoon.tsx`** — small stateless card with
   a `BarChart3` lucide icon + "Analytics — coming soon" copy.

### Modified files

1. **`pages/CreatorPage.tsx`** — replace the 3-line stub. Calls
   `useCreatorDashboardState()`, `useNavigate()`, `useMarketDraftStore()`,
   renders `<CreatorDashboard>`.

2. **`App.tsx`** — mount `useCreatorSync()` on a line immediately after
   `useBookmarkSync()` (line 15).

3. **`hooks/useMarketCreationState.ts`** — on successful
   `POST /api/v1/markets/{conditionId}` response (around line 447-450, after
   `clearDraft()` and before `navigate(...)`):
   - Derive the creator Nostr pubkey via `deriveNostrKeyPair(mnemonic)` (mnemonic
     from `useWalletStore.getState()`)
   - Call `useCreatorMarketsStore.getState().addCreatedMarket({...})` with the
     `conditionId`, `marketIds`, cached `title`, `imageUrl`, `creatorPubkey`,
     `createdAt`.
   - Also pass `creatorPubkey` in the create-market request body. Update
     `lib/markets.ts`'s `createMarket()` signature to accept and forward
     `creatorPubkey` through the multipart form data.

4. **`lib/markets.ts`** — add:
   - `export async function fetchCreatorMarkets(pubkey: string):
     Promise<CreatorMarketStats[]>` hitting `GET /api/v1/creators/{pubkey}/markets`
   - Extend `createMarket()` to include `creatorPubkey` form field
   - Export `CreatorMarketStats` type (or import from `generated/api.ts` after
     regeneration)

5. **`index.css`** — add `@keyframes shimmer` block used by the CTA button's
   `animate-[shimmer_3s_infinite]` class ported from the design. (Confirm
   whether the CTA uses this decoration at port time — if not kept, drop this
   change.)

### New tests

- **`stores/__tests__/creatorMarkets.test.ts`** — `addCreatedMarket`,
  `removeCreatedMarket`, `mergeFromRemote` (dedupe by conditionId, local title
  preserved).
- **`hooks/__tests__/useCreatorDashboardState.test.tsx`** — mock
  `fetchCreatorMarkets`, `fetchMarketMetadata`, `fetchConditions`; assert
  `DashboardStats` derivation, assert fallback path when backend call rejects,
  assert store-is-empty empty state.
- **`components/creator/__tests__/CreatorDashboard.test.tsx`** — render with
  mock props; assert CTA exists and invokes callback, assert "Analytics coming
  soon" renders on Analytics tab, assert absence of Claim Fees / Cancel
  Market buttons, assert draft banner renders when `hasDraft`.
- **`tests/E2E/CreatorDashboardTests.cs`** — Playwright + xUnit. Seed a wallet,
  complete the `/creator/new` wizard via the mock server, navigate to
  `/creator`, assert the created market title appears in `MyMarkets`, assert
  the Active count increments.

## Implementation sequence

Each step compiles and keeps tests green before the next.

1. **Backend contracts.** Update `openapi.yaml`, regenerate
   `ApiContracts.g.cs` + `bitCaster-app/src/generated/api.ts`. No behaviour
   change yet — just contract shape.

2. **In-memory mock endpoint.** Add `CreatorIndex`, extend the POST handler
   with the index update, add the new GET handler. Add unit tests. Smoke-test
   with `curl` against `docker compose up -d`.

3. **Real engine Phase 1.** Extend `OrderBookCreated` + `OrderBookPayload`
   with `CreatorPubkey`, add the `POST /api/v1/markets/{conditionId}` handler
   wired to the seed command path, add the GET handler returning an empty
   list with a TODO marker. Add a minimal integration test.

4. **Frontend shimmer CSS + lucide usage sanity check.** Add `@keyframes
   shimmer` to `index.css` iff the ported component keeps the CTA shimmer.

5. **`creatorMarkets` store + tests.** Land the Zustand store on its own.

6. **`nip78CreatorMarkets` + `useCreatorSync`.** Mirror the bookmark sync
   pattern. Mount in `App.tsx`.

7. **Wizard wiring.** Update `useMarketCreationState.submit()` to push into
   the store and pass `creatorPubkey` to `createMarket()`. Add a regression
   test to `useMarketCreationState.test.tsx`.

8. **`lib/markets.ts` — fetchCreatorMarkets.** Pure data layer, unit-test via
   hook test below.

9. **`useCreatorDashboardState` hook + tests.**

10. **`CreatorDashboard` + `AnalyticsComingSoon` components + snapshot test.**

11. **Replace `CreatorPage.tsx`** — wire the hook + render. Verify via
    `playwright-cli` in the browser.

12. **E2E test** `tests/E2E/CreatorDashboardTests.cs`. Ensure the full create
    → navigate → list flow passes against the in-memory mock.

## Open questions / risks

- **Status derivation for v1** — the engine has no market-resolution state
  machine, so every created market reports as `active`. The "Resolved" count
  will stay at zero until the resolution flow lands. This is acceptable (the
  spec's resolved state is aspirational).
- **Creator pubkey spoofing** — self-declared; see non-goals. Leave a
  `// TODO: verify NIP-01 signature` comment next to the endpoint.
- **No mnemonic configured** — fallback to localStorage-only; backend endpoint
  is not called; dashboard shows a non-blocking info banner.
- **Cross-device sync race** — if two devices publish the same pubkey's list
  concurrently, last-write-wins on the Nostr relay. `mergeFromRemote` unions
  entries, so drift is self-healing after one round-trip.
- **Real-engine Sekiban query deferral** — Phase 1 returns empty list in prod
  until Phase 2 lands. The in-memory mock is what dev uses, so this does not
  affect local work. Open a follow-up issue before shipping.
