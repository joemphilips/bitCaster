# Plan: Kormir-WASM Oracle Integration (Announcement Flow)

## Goal

Wire `kormir-wasm` into `bitCaster-app` so a user can **become an oracle** for the markets they create. The oracle's DLC signing key must be the **same** secp256k1 key used for Nostr identity, and announcements must be published to the user's configured Nostr relays.

This PR implements the **announcement path only**. Attestation (`sign_enum_event` + "My Oracle" dashboard) is deferred to a follow-up PR.

## Constraints & Decisions (from clarifying Q&A)

1. **nsec is required for the oracle flow.** Kormir-wasm needs raw secret key material. NIP-07 extensions keep the key opaque, so a user in NIP-07 mode cannot become an oracle. The general Nostr experience (reading announcements, profile lookup, …) continues to work with NIP-07 — oracle creation is the only gated path.
2. **Scope = announcement only** (remove `Oracle Settings` placeholder, update `OracleCheck` copy, wire `Kormir.create_enum_event` into market submission). Attestation UI is a follow-up.
3. **`event_id` = URL-safe slug of the market title.** Per DLC spec (`dlcspecs/Oracle.md:110`, `Messaging.md:408`), it's a free-form string named/categorised by the oracle. We'll slugify the title (e.g. `"What is the Bitcoin Price?" → "what_is_the_bitcoin_price"`). A short suffix disambiguates collisions within the same oracle's IndexedDB.
4. **kormir-wasm build: local `wasm-pack` + `file:` dependency.** Build output committed under `bitCaster-app/src/lib/kormir-wasm-pkg/`, imported relatively. A helper script (`tools/build-kormir-wasm.sh`) and a line in `bitCaster/AGENTS.md` document the build step.

## Background: What the Code Currently Does

### Current "Oracle Configuration Required" dead-end

`bitCaster-app/src/components/market-creation/OracleCheck.tsx:124-151` renders a dead-end panel when the user picks `become-oracle`:

- "Go to Settings" button calls `onExit` → navigates to `/markets` (bug — it should go to `/settings`)
- "I've already configured" calls `onContinue` → advances the wizard with **no announcement in state**
- At submit time, `useMarketCreationState.ts:326` throws `"No oracle announcement selected"`

There is no path from this UI that ever creates an announcement.

### Current "Oracle Settings" placeholder

`bitCaster-app/src/components/settings/Settings.tsx:552-576` is a fully grayed-out (`opacity-50 pointer-events-none`) `CategoryCard` with a "Coming Soon" badge. `SettingsState.oracle` in `types/settings.ts:84` is hard-coded to `{ comingSoon: true }` at `SettingsPage.tsx:85-87`. No callbacks, no store slice.

### Current Nostr signer state

`useSettingsStore.nostrSignerMode: 'none' | 'nip07' | 'nsec'` (persisted under key `bitcaster-settings`). `loginWithExtension()` / `loginWithNsec(nsec)` in `lib/nostr.ts:47-62` install an `NDKSigner` on the module-level NDK singleton. The NDK instance uses `DEFAULT_RELAYS` (hardcoded / `VITE_NOSTR_RELAYS` env), **not** the user's `settingsStore.relays` list — a known gap noted below.

### kormir-wasm API (from `kormir/kormir-wasm/src/lib.rs`)

```typescript
class Kormir {
  static new(relays: string[]): Promise<Kormir>       // loads or generates IndexedDB key, connects relays
  static restore(nsec: string): Promise<void>         // wipes IndexedDB, writes new key (must re-new afterwards)
  get_public_key(): string                            // x-only pubkey hex (64 chars)
  create_enum_event(
    event_id: string,
    outcomes: string[],
    event_maturity_epoch: number
  ): Promise<string>                                  // returns announcement hex + publishes kind-88
  sign_enum_event(event_id: string, outcome: string): Promise<string>    // deferred (attestation follow-up)
  list_events(): Promise<EventData[]>                 // read-only; typed as JsValue
  static decode_announcement(hex: string): Promise<Announcement>
  static decode_attestation(hex: string): Promise<Attestation>
}
```

Storage: IndexedDB db `"kormir"`, store `"oracle"`, key `"nsec"` (hex secret), `"nonce_index"` (u32 counter), `"oracle_data/<event_id>"`. **The nsec stored by kormir IS the Nostr identity** — `Oracle::nostr_keys()` simply wraps the same 32-byte secret in `nostr::Keys`. This is the linchpin that makes key unification work.

### Gaps discovered during exploration (listed for awareness; see "Scope" below for which we tackle)

1. `registerCondition` in `markets.ts:384` sends `{ announcement: hex }` but the CDK mint / seed script expects `{ announcements: [hex] }` (array). Latent bug — visible only when strict mint validation runs.
2. `registerPartition` in `markets.ts:406` sends only `{ partition }`; spec / seed script expect `{ collateral: "sat", partition, parent_collection_id }`.
3. `lib/oracle.ts` parses `description` / `outcomes` / `maturity` tags that kormir does **not** emit (kormir emits kind-88 with `base64(tlv)` as content, no tags). The "use existing announcement" fetch would fail to parse events from our own oracle unless rewritten.
4. `OracleCheck.tsx:135` `onExit` navigates to `/markets` not `/settings`.
5. `settingsStore.relays` is disconnected from the NDK singleton — adding a relay in Settings has no effect on NDK connections today.

## Scope of This PR

**In scope (must fix for the feature to work):**
- (F1) kormir-wasm build + bundle into bitCaster-app
- (F2) Remove `Oracle Settings` placeholder
- (F3) `OracleCheck` copy + gating on `nsec` mode + `/settings` navigation fix
- (F4) Wire `Kormir.create_enum_event` into market submission for the `become-oracle` path
- (F5) Key unification: when the user enters an nsec, call `Kormir.restore(nsec)` so kormir and NDK share the key
- (F6) Propagate relay list from `settingsStore.relays` to the `Kormir.new(relays)` constructor so oracles publish to the user-configured relays (addresses gap 5, which is load-bearing for requirement #2 "arbitrary nostr relay")

**Also in scope (small, related correctness fixes):**
- (F7) Fix `onExit` → `/settings` in `OracleCheck`
- (F8) Slug util + unit tests

**Out of scope (explicitly deferred):**
- Attestation flow, "My Oracle" dashboard, `sign_enum_event` integration
- Fix for `registerCondition` / `registerPartition` field name bugs (gaps 1–2) — these are mint-API contract bugs that exist independent of oracles. Call out in PR description for a separate fix.
- Rewrite `lib/oracle.ts` tag-parsing (gap 3) — only matters for "use existing announcement"; deferred with attestation work.
- Numeric events (`create_numeric_event`) — wizard currently only wires enum outcomes. If the wizard's numeric path is live, we'll either gate it ("numeric oracle coming soon") or add a follow-up. **Open question flagged below.**

## Architecture

### Data flow: become-oracle submission

```
Settings page: user picks "nsec" mode and enters nsec
  └─> loginWithNsec(nsec)
        ├─> NDK singleton gets NDKPrivateKeySigner(nsec)
        └─> restoreKormirWithNsec(nsec)          [NEW]
              ├─> await init()                    (wasm-bindgen boot, once)
              ├─> Kormir.restore(nsec)            (wipes IndexedDB, writes new nsec)
              └─> resets kormir singleton ref     (forces re-init next access)

Market creation wizard (become-oracle path):
  Step 1 (OracleCheck)
    if choice === 'become-oracle':
      if signerMode !== 'nsec':
        show "You must register a Nostr key (nsec) to become an oracle. Go to Settings."
        [Continue] button disabled
      else:
        show "You will publish this market's announcement as oracle: <pubkey>"
        [Continue] advances to Step 2

  Steps 2–6: unchanged (basic info, outcomes, liquidity, review)

  Step 6 (ReviewAndCreate.onCreateMarket):
    const isBecoming = draft.stepOracleCheck.choice === 'become-oracle'
    let announcementHex: string
    if isBecoming:
      const relays = useSettingsStore.getState().relays.map(r => r.url)
      const kormir = await getKormir(relays)
      const eventId = buildEventId(title, kormir.get_public_key())
      const maturityEpoch = Math.floor(new Date(closingDate).getTime() / 1000)
      announcementHex = await kormir.create_enum_event(eventId, outcomes, maturityEpoch)
      // kormir publishes kind-88 to `relays` as a side effect
      draft.stepOracleCheck.oracleEventId = eventId    // store for future attestation
    else:
      const selected = oracleAnnouncements.find(a => a.id === draft.stepOracleCheck.selectedAnnouncementId)
      if (!selected) throw new Error('No oracle announcement selected')
      announcementHex = selected.id

    const { condition_id } = await registerCondition({ tags, announcementHex })
    await registerPartition(condition_id, outcomes)
    await createMarket(condition_id, params, thumbnailFile)
    navigate(`/markets/${condition_id}`)
```

### Key unification strategy

Kormir and NDK each hold the signer independently. Unification is achieved by funneling **all nsec-based sign-ins through a single helper** that updates both:

```typescript
// lib/nostr.ts
export async function loginWithNsec(nsec: string): Promise<NDKSigner> {
  // 1. NDK
  const signer = new NDKPrivateKeySigner(nsec)
  const ndk = getNdk()
  ndk.signer = signer
  await ndk.connect()

  // 2. Kormir — same 32 bytes, different storage location
  await restoreKormirWithNsec(nsec)

  return signer
}
```

On page refresh, `settingsStore.nostrSignerMode === 'nsec'` is persisted but **the actual nsec is not** (security — we don't persist the raw key). Kormir's IndexedDB DOES persist the nsec across refreshes, so:

- First load after refresh: NDK is signer-less (read-only) until user re-enters nsec OR we read the key back out of kormir's IndexedDB.
- We will **not** read the key back out of kormir's IndexedDB automatically. The existing behavior (user must re-enter nsec after refresh) is preserved. Kormir's persisted key is used only by kormir itself (so `create_enum_event` still works after refresh if the user hasn't cleared IndexedDB), and the key is already the "correct" unified key because `restore()` was called on the same nsec before.

**Edge case — kormir IndexedDB already contains a different key.** If a user previously used the app without nsec (kormir auto-generated one in an earlier session — should not happen since we don't init kormir without user action, but possible via DevTools), then enters a nsec, `Kormir.restore(nsec)` wipes and overwrites. Any previously created oracle events in kormir's IndexedDB are lost. Since this PR is the first time kormir is instantiated, there should be no pre-existing state for existing users.

### Event ID generation

```typescript
// lib/slug.ts
export function slugifyEventTitle(title: string): string {
  return title
    .normalize('NFKD')                      // decompose accented chars
    .replace(/[\u0300-\u036f]/g, '')        // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')            // non-alphanumerics → underscore
    .replace(/^_+|_+$/g, '')                // trim leading/trailing underscores
    .slice(0, 64)                           // cap length
}

// In useMarketCreationState
function buildEventId(title: string, oraclePubkey: string): string {
  const base = slugifyEventTitle(title) || 'event'
  // Suffix with last 6 chars of pubkey + unix seconds (base36).
  // Gives "what_is_the_bitcoin_price_a1b2c3_lz4k7"
  // Uniqueness: oracle's own ns + title + time ensures no collisions in kormir IndexedDB
  const pubkeySuffix = oraclePubkey.slice(-6)
  const timeSuffix = Math.floor(Date.now() / 1000).toString(36)
  return `${base}_${pubkeySuffix}_${timeSuffix}`
}
```

Rationale: the slug alone is not unique enough (a user might create similar markets). Adding pubkey + timestamp makes it human-readable *and* collision-free in IndexedDB. It is stored in the wizard draft so the follow-up attestation PR can reference it via `sign_enum_event(eventId, outcome)`.

### kormir-wasm build & packaging

**Build script** (`scripts/build-kormir-wasm.sh` at repo root of `bitCaster/`, since the wasm output is consumed by `bitCaster-app/`):

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
KORMIR_DIR="$HERE/../kormir"
OUT_DIR="$HERE/../bitCaster-app/src/lib/kormir-wasm-pkg"

cd "$KORMIR_DIR"
wasm-pack build ./kormir-wasm \
  --release \
  --target web \
  --out-dir "$OUT_DIR" \
  --out-name kormir_wasm
```

- `--target web` produces an ES module with a default-exported `init()` function the app must call once before using any `Kormir.*` methods.
- `--release` for the shipped build; developers can use `--dev` locally for faster iteration.
- Output: `bitCaster-app/src/lib/kormir-wasm-pkg/{kormir_wasm.js, kormir_wasm_bg.wasm, kormir_wasm.d.ts, kormir_wasm_bg.wasm.d.ts, package.json}`.
- The `pkg/` directory is **committed** to the repo. This avoids needing Rust nightly + wasm-pack in CI (frontend tests should not need to build wasm).
- Developers rebuild when `kormir/` submodule is updated. Documented in `bitCaster/AGENTS.md` under a new "Building kormir-wasm" section.

**Vite config** (`bitCaster-app/vite.config.ts`):
- Add `optimizeDeps.exclude: ['./src/lib/kormir-wasm-pkg/kormir_wasm.js']` to prevent esbuild from trying to pre-bundle the wasm file.
- `.wasm` files alongside the JS glue are served correctly by Vite's asset pipeline by default with `--target web` — `init()` fetches the `.wasm` URL relative to the module URL, which Vite handles.

**`.gitignore`**: ensure `bitCaster-app/src/lib/kormir-wasm-pkg/` is **not** ignored (we commit the generated output).

### React integration layer

New file: `bitCaster-app/src/lib/kormir.ts`

```typescript
import init, { Kormir } from './kormir-wasm-pkg/kormir_wasm.js'

let _initialized = false
let _kormir: Kormir | null = null

async function ensureInit(): Promise<void> {
  if (_initialized) return
  await init()
  _initialized = true
}

/** Get (or lazily create) the Kormir singleton. Pass the CURRENT relay list. */
export async function getKormir(relays: string[]): Promise<Kormir> {
  await ensureInit()
  if (!_kormir) {
    _kormir = await Kormir.new(relays)
  }
  return _kormir
}

/** Wipe kormir's stored key and install a new one. Resets the singleton. */
export async function restoreKormirWithNsec(nsec: string): Promise<void> {
  await ensureInit()
  await Kormir.restore(nsec)
  _kormir = null       // force re-init next `getKormir`
}

/** For tests. */
export function __resetKormirForTesting(): void {
  _kormir = null
  _initialized = false
}
```

Singleton rationale: `Kormir.new(relays)` opens websocket connections, so we don't want to reconstruct it on every call. If the user changes the relay list in Settings, the singleton should be reset — we'll add a listener/subscriber in a follow-up (for now, relays captured at first `getKormir` call for the session).

## Files Changed

### New files

| Path | Purpose |
|---|---|
| `bitCaster-app/src/lib/kormir.ts` | Singleton wrapper + `restoreKormirWithNsec` |
| `bitCaster-app/src/lib/slug.ts` | `slugifyEventTitle` util |
| `bitCaster-app/src/lib/__tests__/slug.test.ts` | Unit tests for slug edge cases |
| `bitCaster-app/src/lib/__tests__/kormir.test.ts` | Unit tests for kormir wrapper (wasm module mocked) |
| `bitCaster-app/src/lib/kormir-wasm-pkg/*` | wasm-pack build output (committed) |
| `tools/build-kormir-wasm.sh` | wasm-pack build helper |

### Modified files

| Path | Change |
|---|---|
| `bitCaster-app/src/components/settings/Settings.tsx` | Delete `Oracle Settings` `CategoryCard` (lines ~552-576) and `Eye` icon import if unused elsewhere |
| `bitCaster-app/src/pages/SettingsPage.tsx` | Remove `oracle: { comingSoon: true }` from `settingsState` (lines 85-87) |
| `bitCaster-app/src/types/settings.ts` | Remove `'oracle'` from `SettingsCategory`; delete `OracleSettings` interface; delete `oracle` field from `SettingsState` |
| `bitCaster-app/src/types/index.ts` | Remove `OracleSettings` re-export if present |
| `bitCaster-app/src/components/market-creation/OracleCheck.tsx` | New props: `signerMode`, `oraclePubkey?`; rewrite `become-oracle` panel with gating copy; fix `onExit` navigation target |
| `bitCaster-app/src/hooks/useMarketCreationState.ts` | Wire `create_enum_event` into `onCreateMarket` for the `become-oracle` path; add `buildEventId`; pass `signerMode`/`oraclePubkey` through to OracleCheck; surface kormir errors via `submitError` |
| `bitCaster-app/src/pages/MarketCreationPage.tsx` | If the hook returns new values (`signerMode`, `oraclePubkey`), forward to the wizard |
| `bitCaster-app/src/components/market-creation/MarketCreationWizard.tsx` | Forward new props to `OracleCheck` |
| `bitCaster-app/src/lib/nostr.ts` | In `loginWithNsec`, also call `restoreKormirWithNsec(nsec)` |
| `bitCaster-app/src/types/market-creation.ts` | Add `oracleEventId: string \| null` to `WizardStepOracleCheck` (needed for future attestation lookup) |
| `bitCaster-app/vite.config.ts` | Add `optimizeDeps.exclude` for kormir-wasm-pkg entrypoint |
| `bitCaster-app/package.json` | No new runtime deps (relative import) |
| `bitCaster/AGENTS.md` | Add "Building kormir-wasm" subsection under local-dev |

## UI Copy Changes

### OracleCheck — become-oracle panel (new variants)

**Case A: signerMode === 'none'**
```
Nostr Key Required
You must register a Nostr key (nsec) to become an oracle.
Your Nostr identity will also be used to sign the market's
oracle announcement and future attestation.
[Go to Settings]
```

**Case B: signerMode === 'nip07'**
```
Switch to nsec Sign-In
Becoming an oracle requires direct access to your private key,
which your browser extension does not expose. Please sign in
with an nsec in Settings to continue.
[Go to Settings]
```

**Case C: signerMode === 'nsec'**
```
Ready to Publish
You'll publish this market's oracle announcement as:
<pubkey short>
The announcement will be broadcast to your configured Nostr relays.
[Continue]
```

"Go to Settings" in both A and B navigates to `/settings?category=nostr` (open the accordion to the Nostr section). Query-param handling for the accordion category is a small addition to `SettingsPage` (reads `?category` and calls `setActiveCategory`).

### Settings — Nostr section (minor)

No changes required — the existing nsec input flow works. We only need the downstream `loginWithNsec` to also sync kormir.

## Testing Strategy

### Unit tests (vitest)

1. **`slug.test.ts`** — `slugifyEventTitle`:
   - ASCII: `"What is the Bitcoin Price?"` → `"what_is_the_bitcoin_price"`
   - Diacritics: `"Café résumé"` → `"cafe_resume"`
   - Unicode drop: `"日本語 test"` → `"test"` (or trailing underscore handling)
   - Empty/whitespace → `""` (caller falls back to `"event"`)
   - Length cap at 64 chars
   - Consecutive separators collapsed

2. **`kormir.test.ts`** — wrapper (mock the wasm module):
   - `getKormir` caches the instance across calls
   - `restoreKormirWithNsec` resets the cache
   - Mock kormir-wasm by using vitest module mock on `./kormir-wasm-pkg/kormir_wasm.js`

3. **`OracleCheck.test.tsx`** — gating:
   - `signerMode === 'none'` → "Nostr Key Required", Continue disabled
   - `signerMode === 'nip07'` → "Switch to nsec Sign-In", Continue disabled
   - `signerMode === 'nsec'` → "Ready to Publish", Continue enabled; shows short pubkey
   - `onExit` navigates to `/settings?category=nostr`

4. **`useMarketCreationState.test.tsx`** — extend existing test:
   - Mock `lib/kormir.ts` (`getKormir` returns an object with `create_enum_event: vi.fn().mockResolvedValue('deadbeef...')`)
   - Test: `become-oracle` path calls `create_enum_event(eventId, outcomes, epoch)` → then `registerCondition({ announcementHex: 'deadbeef...' })` → then `registerPartition` → then `createMarket`
   - Test: existing `existing-oracle` path unchanged

### E2E test (Playwright, under `tests/E2E/`)

Add a new test case to the market creation flow:

1. Seed nsec into settings (via localStorage or the settings UI)
2. Navigate to `/creator/new`
3. Choose `become-oracle`
4. Fill wizard steps
5. Submit; assert navigation to `/markets/<condition_id>`
6. Assert the mint received a POST to `/v1/conditions` with an `announcements` array containing hex

If the kormir-wasm wasm load doesn't play well with Playwright's headless browser, fall back to mocking `lib/kormir.ts` at test time via `page.addInitScript`.

## Build Sequence (implementation order)

The plan is broken into small commits that each leave the tree in a working state.

1. **Build + commit kormir-wasm pkg.** Add `scripts/build-kormir-wasm.sh`, run it, commit the `bitCaster-app/src/lib/kormir-wasm-pkg/` output. Update `vite.config.ts` `optimizeDeps.exclude`. Verify `npm run build` succeeds with an unused placeholder import of `./lib/kormir-wasm-pkg/kormir_wasm.js`.
2. **Add slug util + tests.** New `lib/slug.ts` + tests.
3. **Add kormir wrapper + tests.** New `lib/kormir.ts` with mocked wasm in tests.
4. **Wire key sync in `loginWithNsec`.** Update `lib/nostr.ts`. Extend existing nostr tests if any.
5. **Remove Oracle Settings placeholder.** Delete the `CategoryCard` block; delete types; delete `oracle: { comingSoon: true }` from SettingsPage. Verify `/settings` renders with three sections (General, Cashu, Nostr).
6. **Update `OracleCheck` component.** New props + copy + navigation fix + tests.
7. **Wire `create_enum_event` into market submission.** Update `useMarketCreationState.ts` + tests.
8. **Propagate new props through `MarketCreationWizard` and `MarketCreationPage`.**
9. **Add E2E test for become-oracle path** (or skip if wasm load in Playwright is problematic — document as follow-up).
10. **Run branch completion workflow** (`/simplify`, unit tests, build, E2E, draft PR, ready).

Each step should leave `npm run test` and `npm run build` green.

## Risks & Open Questions

### Risk: kormir-wasm bundle size

Unknown until first build. The kormir core + nostr-sdk + secp256k1 in wasm will likely be 500 KB–2 MB compressed. Mitigation: lazy-load via dynamic `import()` inside `getKormir` so the wasm only loads when the user actually enters the become-oracle path. This is already how our singleton works — the module-level `import init` will be tree-shaken into a dynamic chunk by Vite if we restructure as:

```typescript
let _kormirModule: typeof import('./kormir-wasm-pkg/kormir_wasm.js') | null = null
async function loadKormirModule() {
  if (!_kormirModule) {
    _kormirModule = await import('./kormir-wasm-pkg/kormir_wasm.js')
    await _kormirModule.default()  // init()
  }
  return _kormirModule
}
```

**Decision: use dynamic import.** I'll implement it this way from the start so users who never become oracles don't download the wasm.

### Risk: `Kormir.new(relays)` connection failures

If the user's configured relays are unreachable, `Kormir.new` may hang or error in a non-obvious way (nostr-sdk's connect is fire-and-forget, but `send_event` will fail silently if no relays are connected). Mitigation: catch errors from `create_enum_event` and surface them in `submitError`. Show a clear message "Failed to publish announcement — check your Nostr relay configuration."

### Risk: `Kormir.restore` wipes prior oracle events

If a user had previously auto-generated a kormir key (shouldn't happen on first rollout but could during dev), `restore(nsec)` wipes the entire IndexedDB store. Any previously stored oracle events and nonce counters are lost. For this PR, we accept this because (a) kormir is not currently used, so there's nothing to lose, and (b) attestation is deferred — no one should yet have unreleased events.

### Risk: Relay list mismatch

`settingsStore.relays` (user-editable) and `DEFAULT_RELAYS` in `lib/nostr.ts` (env-var driven) are independent today. For kormir we pass `settingsStore.relays.map(r => r.url)`, so oracles publish to the user-configured set. But the NDK fetches (for "use existing announcement") still use `DEFAULT_RELAYS`. This inconsistency is documented and left for a follow-up (fixing NDK would be its own refactor touching wallet + profile + oracle fetching).

### Open question 1: numeric events

The wizard's `OutcomesStep` has a "numeric" path (bounds, precision, unit) — does the user want this wired to `kormir.create_numeric_event` in this PR, or should we hard-gate it to enum outcomes only with a "numeric markets coming soon" message? Kormir's numeric path is well-supported, but the CDK mint may or may not accept numeric announcements (worth verifying against `nuts/CTF.md`). **Defaulting: enum only; numeric path shows "Numeric oracle markets coming soon" if user picks the numeric outcome type with `become-oracle` choice.**

### Open question 2: should we fix the `registerCondition` / `registerPartition` field name bugs (gaps 1–2) as part of this PR?

Pro: a user who becomes an oracle will send an announcement hex that the strict mint validates — if the field name is wrong, the oracle flow fails immediately. These fixes directly block the feature when tested against a real mint.

Con: they're independent of oracles and the existing fetchMockMint may be lenient.

**Recommendation: fix them in this PR** (single-line changes, adjacent to the oracle work, unblock end-to-end testing).

### Open question 3: scope of the `OracleSettings` type removal

The `'oracle'` literal is in `SettingsCategory`, used as a discriminant in `onCategoryToggle` and the accordion's `activeCategory`. Removing it is a type-level change that will ripple. Alternative: keep the union member but never render the section. **Recommendation: remove fully** — the point is to delete dead code, and the ripple is small (one switch statement).

---

## Summary Checklist

Before merging:

- [ ] `scripts/build-kormir-wasm.sh` works and produces a committed `pkg/` directory
- [ ] `npm run build` succeeds in `bitCaster-app/`
- [ ] `npm run test` green
- [ ] E2E become-oracle scenario green (or documented skip)
- [ ] `/settings` no longer shows Oracle Settings section
- [ ] Market creation `become-oracle` flow:
  - [ ] Shows correct gating message for `none` / `nip07` modes
  - [ ] Continues through steps 2–6 for `nsec` mode
  - [ ] Successfully calls `create_enum_event`, `registerCondition`, `registerPartition`, `createMarket`
  - [ ] Navigates to `/markets/<condition_id>` on success
- [ ] `onExit` in OracleCheck navigates to `/settings?category=nostr`
- [ ] Same key verified in NDK signer and kormir pubkey after `loginWithNsec`
- [ ] PR description lists: mint contract bug fixes included, numeric oracle deferred, attestation deferred
