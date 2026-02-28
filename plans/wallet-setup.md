# Implementation Plan: Wallet Setup (Landing Page)

> **Goal:** Implement the 5-step wallet setup wizard as a real, functional Cashu wallet — not just UI chrome. On completion, the user has a BIP-39-derived wallet with proofs stored in IndexedDB, connected to at least one mint, identical in capability to cashu.me.

## Design Decisions

### 0. PWA Gate at Step 2

Step 2 (PWA Confirmation) **must block progression** until the app is actually running as an installed PWA. Detect this via `window.matchMedia('(display-mode: standalone)').matches` or `navigator.standalone` (iOS). If the user is still in a browser tab, the "Continue" button stays disabled and platform-specific install instructions are shown. Once the user installs and re-opens as a PWA, the check passes and they can proceed.

### 1. Client-Side Only — No Backend Wallet Endpoints

The product-plan instructions list backend endpoints (`POST /wallet/create`, etc.) but these violate the project's design principles:

- **"All information should be stored in users side as much as possible"** (AGENTS.md)
- **Cashu wallets are bearer-token systems** — seed generation and proof storage belong on the client
- **cashu.me reference** stores mnemonic in localStorage, proofs in IndexedDB, and never sends the seed to a server

**Decision:** The wallet is created and managed entirely client-side. No backend endpoints needed for wallet setup. The mnemonic is generated/validated in-browser, proofs go to IndexedDB, mint URLs go to localStorage.

### 2. Storage Model (Matching cashu.me)

| Data | Storage | Key |
|------|---------|-----|
| BIP-39 mnemonic (12 words) | `localStorage` | `bitcaster.mnemonic` |
| Mint list (url, keys, keysets, info) | `localStorage` | `bitcaster.mints` |
| Active mint URL | `localStorage` | `bitcaster.activeMintUrl` |
| Keyset counters | `localStorage` | `bitcaster.keysetCounters` |
| Setup complete flag | `localStorage` | `bitcaster.setupComplete` |
| Proofs (live ecash tokens) | IndexedDB (Dexie) | DB `bitcaster`, table `proofs`, PK `secret` |

### 3. BIP-39 Seed → CashuWallet

Following cashu.me's pattern, every `CashuWallet` instance receives `bip39seed: mnemonicToSeedSync(mnemonic)`. This enables deterministic secret derivation (required for wallet restore).

### 4. State Management — Zustand Store

No global state exists yet (everything is `useState`). The wallet is cross-cutting state needed by many pages (balance in header, proof storage for trading, mint connection for all API calls).

**Decision:** Introduce a single `useWalletStore` (zustand) that owns:
- `mnemonic`, `setupComplete`, `mints`, `activeMintUrl`, `proofs`
- Actions: `generateMnemonic()`, `recoverFromMnemonic()`, `addMint()`, `removeMint()`, `testMintConnection()`, `completeSetup()`
- Derived: `balance` (sum of active proof amounts), `wallet` (CashuWallet instance)

Zustand is chosen over React Context because it avoids unnecessary re-renders, works outside React (e.g. in service workers), and has a clean persist middleware for localStorage.

### 5. Auto-Redirect to `/setup`

If `setupComplete` is `false` (or absent), the app redirects to `/setup` from any route. The `/setup` route renders **without** `AppShell` (no nav bars).

### 6. Background Market Data Download + "Now Loading" Page

Market data download (`GET /v1/conditions`) begins **immediately after Step 2 (PWA confirmation)**, running in the background while the user continues through Steps 3–5. The existing `backgroundDataLoad` prop on the design components shows a subtle progress indicator during these steps.

After the user clicks "Finish Setup" on Step 5, if market data has not yet finished loading, the app shows a **full-screen "Now Loading" page** instead of immediately navigating to `/markets`. This page displays:
- The site motto: **"Finance wants to be free | Fake must be expensive"**
- A loading spinner

Once the data download completes, the loading page auto-navigates to `/markets`. If the download already finished during setup, the loading page is skipped entirely.

### 7. Seed Verification as Sequential Steps

After the user checks "I have saved my seed phrase" on the SeedDisplay step, the verification is done as **three independent sequential sub-steps** — one word at a time:
1. First: "Enter word #3"
2. Then: "Enter word #7"
3. Finally: "Enter word #12"

Each sub-step shows a single input field. The user must enter the correct word before advancing to the next. Wrong answers show an inline error. Only after all three are verified does the "Continue" button appear to advance to Step 5 (Mint Setup).

---

## Dependencies to Add

| Package | Purpose |
|---------|---------|
| `@scure/bip39` | BIP-39 mnemonic generation & validation (same lib cashu-ts uses internally) |
| `zustand` | Lightweight state management with localStorage persist middleware |
| `dexie` | IndexedDB wrapper for proof storage (same as cashu.me) |

> **Note:** `@scure/bip39` requires a wordlist import (`@scure/bip39/wordlists/english`). It is a peer dep of cashu-ts so likely already resolvable.

---

## Implementation Steps

### Phase 0: E2E Test — Happy Path (Write First)

Add `tests/E2E/WalletSetupTests.cs` with these test cases:

#### Test 1: `CreateNewWallet_CompletesSetupAndRedirects`
1. Navigate to `/` → expect redirect to `/setup`
2. Step 1 (Welcome): assert "Get Started" button visible → click it
3. Step 2 (PWA): **emulate PWA mode** (`--app` flag or override `display-mode: standalone` media) → assert "Continue" button becomes enabled → click it
4. Step 3 (Choice): assert "Create New Wallet" card visible → click it
5. Step 4 (Seed Display): assert 12 seed words displayed in grid → scrape the 12 words from the DOM → check "I have saved my seed phrase" → **seed verification sub-steps appear one at a time**: enter correct word #3 → "Next" → enter correct word #7 → "Next" → enter correct word #12 → click "Continue"
6. Step 5 (Mint Setup): assert default mint `http://localhost:3338` appears → wait for "Connected" status → click "Finish Setup"
7. Assert URL is `/markets`

#### Test 1b: `PwaNotInstalled_BlocksStep2`
1. Navigate to `/setup` in **normal browser mode** (not PWA)
2. Step 1 → "Get Started"
3. Step 2 (PWA): assert "Continue" button is **disabled** — user cannot proceed without installing as PWA

#### Test 1c: `SeedVerification_WrongWordBlocksContinue`
1. Navigate through to Step 4 (Create flow, PWA mode)
2. Scrape seed words from DOM
3. Check "I have saved my seed phrase"
4. Verification sub-step #1 appears: "Enter word #3"
5. Enter **wrong** word → assert "Next" is disabled and error shown
6. Enter correct word #3 → "Next" becomes enabled → click it
7. Verification sub-step #2 appears: "Enter word #7" (sequential, one at a time)

#### Test 2: `RecoverWallet_WithValidSeedAndRedirects`
1. Navigate to `/setup` (emulate PWA mode)
2. Get Started → Continue → click "Recover Wallet"
3. Step 4 (Seed Input): paste 12 valid BIP-39 words into first input → assert all fields filled → assert the phrase passes BIP-39 checksum validation (no error shown, "Recover Wallet" button enabled) → click "Recover Wallet"
4. Step 5: wait for mint connected → "Finish Setup"
5. Assert URL is `/markets`

#### Test 2b: `RecoverWallet_InvalidChecksumShowsError`
1. Navigate through to Step 4 (Recover flow, PWA mode)
2. Enter 12 words that are individually valid BIP-39 words but fail the checksum as a phrase
3. Assert "Recover Wallet" button is disabled and an error message about invalid mnemonic is shown

#### Test 2c: `FirstTimeSetup_ShowsLoadingPageBeforeMarkets`
1. Navigate to `/setup` (emulate PWA mode)
2. Intercept `**/v1/conditions` with `page.RouteAsync` to **delay** the response by 5 seconds
3. Complete the full create wallet flow through "Finish Setup"
4. Assert the "Now Loading" page is shown with text "Finance wants to be free" and a spinner
5. Fulfill the delayed conditions response
6. Assert auto-navigation to `/markets`

#### Test 3: `SetupComplete_NoRedirectToSetup`
1. Use `page.evaluate()` to set `localStorage.setItem('bitcaster.setupComplete', 'true')`
2. Navigate to `/markets`
3. Assert URL remains `/markets` (no redirect to `/setup`)

> **Note:** These E2E tests require the mint to be running (docker-compose). They use the same `WaitForService` pattern as existing tests.

### Phase 1: Vitest Unit Tests (Write First)

Create test files before implementation:

#### `bitCaster/src/stores/__tests__/wallet-store.test.ts`
Tests for the zustand store (pure logic, no UI):
- `generateMnemonic()` produces 12 valid BIP-39 English words
- `recoverFromMnemonic(words)` accepts valid phrase, rejects invalid
- `recoverFromMnemonic()` with invalid word throws/returns error
- `testMintConnection(url)` — mock fetch to `/v1/info`, returns connected/failed status
- `addMint(url)` adds to mint list and triggers connection test
- `removeMint(url)` removes from list (cannot remove last mint)
- `completeSetup()` sets `setupComplete = true`
- `balance` computed from proof amounts
- State persists to localStorage (use zustand persist mock)

#### `bitCaster/src/lib/__tests__/bip39.test.ts`
Tests for BIP-39 validation helper:
- `validateWord(word)` returns true for valid English BIP-39 words
- `validateWord("zzzzzzz")` returns false
- `validateMnemonic(words)` validates full 12-word phrase (checksum)
- `generateMnemonic()` returns 12 valid words

#### `bitCaster/src/pages/__tests__/WalletSetupPage.test.tsx`
Tests for the page-level orchestration (render + store integration):
- Renders `WalletSetup` component with correct props from store
- `onWelcomeNext` advances step 1→2
- Step 2 "Continue" disabled when `isPwa` is false; enabled when true
- `onChoiceSelect('create')` sets choice and advances to step 4
- `onSeedSavedToggle(true)` shows `SeedVerification` component (sequential sub-steps)
- Seed verification `onVerificationComplete` callback advances to step 5
- `onSeedPhrasePaste` splits phrase into 12 words in store
- Recover flow: "Recover Wallet" disabled when mnemonic checksum is invalid
- `onFinishSetup` calls `completeSetup()` — if market data loaded, navigates to `/markets`; if not, shows "Now Loading" page
- "Now Loading" page shows motto text and spinner, auto-navigates to `/markets` when data arrives
- Back navigation decrements step

#### `bitCaster/src/components/wallet-setup/__tests__/SeedInput.test.tsx`
- Pasting 12-word phrase fills all fields
- Pasting fewer than 12 words fills only available fields
- Invalid BIP-39 word shows error styling (after we add validation)
- "Recover Wallet" button disabled until all 12 fields are valid BIP-39 words
- "Recover Wallet" button disabled when all 12 words are valid BIP-39 words individually but fail checksum as a phrase

#### `bitCaster/src/components/wallet-setup/__tests__/SeedVerification.test.tsx`
- Initially shows only "Enter word #3" with a single input field
- "Next" button disabled when input is empty
- Wrong word shows inline error, "Next" stays disabled
- Correct word #3 → click "Next" → advances to "Enter word #7"
- Correct word #7 → click "Next" → advances to "Enter word #12"
- Correct word #12 → button shows "Continue" → click calls `onVerificationComplete`
- Back button returns to previous verification sub-step (or back to SeedDisplay if on first)

#### `bitCaster/src/components/wallet-setup/__tests__/PwaConfirmation.test.tsx`
- "Continue" button disabled when `isPwa` is false
- "Continue" button enabled when `isPwa` is true
- Shows install instructions when not PWA

### Phase 2: Wallet Store (`useWalletStore`)

Create `bitCaster/src/stores/wallet.ts`:

```
State:
  mnemonic: string             // 12-word space-separated phrase, persisted to localStorage
  setupComplete: boolean       // persisted to localStorage
  mints: StoredMint[]          // persisted to localStorage
  activeMintUrl: string        // persisted to localStorage
  keysetCounters: KeysetCounter[] // persisted to localStorage
  mintConnectionStatuses: Map<string, MintConnectionTestStatus>

Derived:
  balance: number              // sum of all proofs for active mint
  seedBytes: Uint8Array        // mnemonicToSeedSync(mnemonic)

Actions:
  generateMnemonic()           // generate + store 12-word phrase
  recoverFromMnemonic(words: string[])  // validate + store
  testMintConnection(url: string): Promise<MintConnectionTestStatus>
  addMint(url: string): Promise<void>   // add + test + fetch keys
  removeMint(url: string)
  completeSetup()
  getWallet(mintUrl?: string): Promise<CashuWallet>  // replaces singleton in lib/cashu.ts
```

**StoredMint type:**
```ts
interface StoredMint {
  url: string
  keys?: MintKeys
  keysets?: MintKeyset[]
  info?: MintInfo
}
```

**Persistence:** Use `zustand/middleware` `persist` with `localStorage` partialize (exclude transient connection statuses).

**Proof storage:** Create `bitCaster/src/stores/proof-db.ts` using Dexie:
```ts
class BitcasterDB extends Dexie {
  proofs!: Table<WalletProof>
  constructor() {
    super('bitcaster')
    this.version(1).stores({
      proofs: 'secret, id, C, amount'
    })
  }
}
```

Expose reactive proof access via `dexie`'s `liveQuery` or a thin hook `useProofs()`.

### Phase 3: BIP-39 Helpers

Create `bitCaster/src/lib/bip39.ts`:

```ts
import { generateMnemonic, validateMnemonic, mnemonicToSeedSync } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'

export function generate(): string[] // returns 12 words
export function validate(words: string[]): boolean // full checksum validation
export function validateWord(word: string): boolean // single word in wordlist
export function toSeed(words: string[]): Uint8Array // mnemonicToSeedSync
```

### Phase 4: Refactor `lib/cashu.ts`

Replace the module-level singleton with a call to `useWalletStore.getState().getWallet()`. The key change: every `CashuWallet` is now created with `bip39seed` from the store's mnemonic, enabling deterministic secrets.

```ts
// Before (current):
const mint = new CashuMint(url)
_wallet = new CashuWallet(mint, { unit: 'sat' })

// After:
const store = useWalletStore.getState()
const mint = new CashuMint(url)
_wallet = new CashuWallet(mint, {
  unit: 'sat',
  bip39seed: store.seedBytes,
})
```

Keep all existing exports (`createMintQuote`, `mintProofs`, etc.) working — they just source the wallet differently. This is backward-compatible; the MarketsPage and other existing code won't break.

### Phase 5: Routing — `/setup` Without AppShell

Modify `App.tsx` to render `/setup` route **outside** the `AppShell` wrapper:

```tsx
function AppRoutes() {
  const location = useLocation()
  const navigate = useNavigate()
  const setupComplete = useWalletStore((s) => s.setupComplete)

  // Auto-redirect to /setup if wallet not configured
  useEffect(() => {
    if (!setupComplete && location.pathname !== '/setup') {
      navigate('/setup', { replace: true })
    }
  }, [setupComplete, location.pathname, navigate])

  // /setup renders without AppShell
  if (location.pathname === '/setup') {
    return (
      <Routes>
        <Route path="/setup" element={<WalletSetupPage />} />
      </Routes>
    )
  }

  // All other routes render inside AppShell
  return (
    <AppShell ...>
      <Routes>
        <Route path="/" element={<MarketsPage />} />
        ...existing routes...
      </Routes>
    </AppShell>
  )
}
```

### Phase 6: Copy Design Components

Copy the 8 wallet-setup components from `bitCaster-design/product-plan/sections/wallet-setup/components/` to `bitCaster/src/components/wallet-setup/`:

- `WalletSetup.tsx`
- `WelcomeLanding.tsx`
- `PwaConfirmation.tsx`
- `ChoiceCards.tsx`
- `SeedDisplay.tsx`
- `SeedInput.tsx`
- `MintSetup.tsx`
- `StepIndicator.tsx`

Fix import paths (change `../types` to `@/types/wallet-setup`). These components are presentation-only — they accept props and fire callbacks. **Do not modify styling.**

**Additional components to create** (not in design system):

- **`SeedVerification.tsx`** — After the user checks "I have saved my seed phrase" on `SeedDisplay`, this component runs **three sequential sub-steps**, showing one word at a time:
  1. "Enter word #3" — single input field, "Next" button
  2. "Enter word #7" — single input field, "Next" button
  3. "Enter word #12" — single input field, "Continue" button (advances to Step 5)

  Each sub-step validates the entered word against the corresponding seed word. Wrong answers show an inline error and disable the button. The user must get each word correct before seeing the next. Props: `seedWords: string[]`, `onVerificationComplete: () => void`, `onBack?: () => void`.

- **Modify `PwaConfirmation.tsx`** — Add an `isPwa` prop (boolean). When `false`, the "Continue" button is disabled with a message like "Install as app to continue". Detect PWA status in the page via `window.matchMedia('(display-mode: standalone)').matches || navigator.standalone`.

### Phase 7: Implement `WalletSetupPage.tsx`

This is the orchestration layer that connects the store to the design components.

```tsx
export function WalletSetupPage() {
  // Local UI state (wizard step, terms visibility)
  const [currentStep, setCurrentStep] = useState<SetupStep>(1)
  const [showTerms, setShowTerms] = useState(false)
  const [choice, setChoice] = useState<SetupChoice | null>(null)

  // Store state
  const {
    mnemonic, generateMnemonic, recoverFromMnemonic,
    mints, addMint, removeMint, testMintConnection,
    completeSetup,
  } = useWalletStore()

  const navigate = useNavigate()

  // Seed words derived from mnemonic
  const seedWords = mnemonic ? mnemonic.split(' ') : []
  const [inputSeedWords, setInputSeedWords] = useState(Array(12).fill(''))
  const [seedSaved, setSeedSaved] = useState(false)

  // Mint connection statuses for UI
  const [mintConnections, setMintConnections] = useState<MintConnectionTest[]>([])

  // --- Callback implementations ---

  // PWA detection
  const [isPwa, setIsPwa] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(display-mode: standalone)')
    setIsPwa(mq.matches || (navigator as any).standalone === true)
    const handler = (e: MediaQueryListEvent) => setIsPwa(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Seed verification state (create flow — sequential: #3, then #7, then #12)
  const [seedVerificationActive, setSeedVerificationActive] = useState(false)

  const onChoiceSelect = (c: SetupChoice) => {
    setChoice(c)
    if (c === 'create') {
      generateMnemonic()  // store generates + persists 12 words
    }
    setCurrentStep(4)
  }

  const onSeedSavedToggle = (saved: boolean) => {
    setSeedSaved(saved)
    if (saved) {
      setSeedVerificationActive(true) // show verification sub-step
    } else {
      setSeedVerificationActive(false)
      setVerificationInputs(['', '', ''])
    }
  }

  // SeedVerification handles its own sequential sub-steps internally.
  // It calls onVerificationComplete when all 3 words are verified.
  const onVerificationComplete = () => {
    setCurrentStep(5)
  }

  const onContinue = () => {
    // For recover flow, advance directly to step 5
    setCurrentStep(5)
  }

  const onAddMint = async (url: string) => {
    setMintConnections(prev => [...prev, { url, status: 'connecting' }])
    try {
      await addMint(url)  // store fetches /v1/info + /v1/keys
      setMintConnections(prev =>
        prev.map(m => m.url === url ? { ...m, status: 'connected' } : m)
      )
    } catch (e) {
      setMintConnections(prev =>
        prev.map(m => m.url === url
          ? { ...m, status: 'failed', errorMessage: String(e) }
          : m
        )
      )
    }
  }

  // Background market data loading — starts after PWA step (step 2)
  const [marketDataLoaded, setMarketDataLoaded] = useState(false)
  useEffect(() => {
    if (currentStep >= 3 && !marketDataLoaded) {
      fetchConditions()  // from lib/markets.ts — fire and forget
        .then(() => setMarketDataLoaded(true))
        .catch(() => setMarketDataLoaded(true)) // don't block setup on failure
    }
  }, [currentStep])

  // "Now Loading" transition page state
  const [showLoadingPage, setShowLoadingPage] = useState(false)

  const onFinishSetup = () => {
    completeSetup()  // sets setupComplete = true in localStorage
    if (marketDataLoaded) {
      navigate('/markets')
    } else {
      setShowLoadingPage(true)  // show loading page until data arrives
    }
  }

  // When loading page is shown and data finishes, navigate away
  useEffect(() => {
    if (showLoadingPage && marketDataLoaded) {
      navigate('/markets')
    }
  }, [showLoadingPage, marketDataLoaded])

  // If showLoadingPage, render the "Now Loading" page
  if (showLoadingPage) {
    return <NowLoadingPage />
    // Full-screen page showing:
    //   "Finance wants to be free | Fake must be expensive"
    //   + loading spinner
  }

  // Auto-add default mint on step 5 entry
  useEffect(() => {
    if (currentStep === 5 && mintConnections.length === 0) {
      onAddMint(import.meta.env.VITE_MINT_URL ?? 'http://localhost:3338')
    }
  }, [currentStep])

  return <WalletSetup {...allProps} />
}
```

### Phase 8: Wire Up Real CashuWallet in Store

On `addMint(url)`, the store:
1. Fetches `GET {url}/v1/info` → stores as `mint.info`
2. Fetches `GET {url}/v1/keysets` → stores as `mint.keysets`
3. Fetches `GET {url}/v1/keys` → stores as `mint.keys`
4. Creates `new CashuWallet(new CashuMint(url), { bip39seed, keys, keysets, mintInfo, unit: 'sat' })`
5. Calls `wallet.loadMint()` to verify connectivity

This mirrors cashu.me's `activateMint()` flow and ensures the wallet is a fully valid Cashu wallet.

### Phase 9: Update UserMenu Balance

Replace the hardcoded `mockUser.balance` in `App.tsx` with the real balance from `useWalletStore`:

```tsx
const balance = useWalletStore((s) => s.balance)
const user = { name: 'Anon', balance }
```

### Phase 10: Run Tests & Fix

1. Run `cd bitCaster && npm run test` — all unit tests must pass
2. Run `cd bitCaster && npm run typecheck` — no type errors
3. Run `codex exec review --uncommitted` fix it if there is any problem. And go back to step 1
4. Run `docker compose up mintd` + servers, then `dotnet test tests/E2E/` — E2E tests must pass
5. Fix any failures
6. Run `codex exec review --uncommitted`, fix it if there is any problem. And go back to step 4.

---

## File Change Summary

### New Files
| File | Purpose |
|------|---------|
| `bitCaster/src/stores/wallet.ts` | Zustand wallet store (mnemonic, mints, setup state) |
| `bitCaster/src/stores/proof-db.ts` | Dexie IndexedDB schema for proof storage |
| `bitCaster/src/lib/bip39.ts` | BIP-39 helpers (generate, validate, toSeed) |
| `bitCaster/src/components/wallet-setup/*.tsx` | 8 components copied from design system |
| `bitCaster/src/components/wallet-setup/SeedVerification.tsx` | New component: sequential verification of words #3, #7, #12 (one at a time) |
| `bitCaster/src/components/wallet-setup/NowLoadingPage.tsx` | Full-screen loading page with motto + spinner (shown after first-time setup) |
| `bitCaster/src/stores/__tests__/wallet-store.test.ts` | Store unit tests |
| `bitCaster/src/lib/__tests__/bip39.test.ts` | BIP-39 helper tests |
| `bitCaster/src/pages/__tests__/WalletSetupPage.test.tsx` | Page integration tests |
| `bitCaster/src/components/wallet-setup/__tests__/SeedInput.test.tsx` | SeedInput component tests |
| `bitCaster/src/components/wallet-setup/__tests__/SeedVerification.test.tsx` | SeedVerification component tests |
| `bitCaster/src/components/wallet-setup/__tests__/PwaConfirmation.test.tsx` | PwaConfirmation gate tests |
| `tests/E2E/WalletSetupTests.cs` | E2E test class (7 tests) |

### Modified Files
| File | Change |
|------|--------|
| `bitCaster/package.json` | Add `@scure/bip39`, `zustand`, `dexie` |
| `bitCaster/src/App.tsx` | Extract `/setup` route outside AppShell; add auto-redirect; use real balance |
| `bitCaster/src/pages/WalletSetupPage.tsx` | Replace stub with real orchestration page |
| `bitCaster/src/lib/cashu.ts` | Use `bip39seed` from wallet store instead of bare singleton |
| `bitCaster/src/types/wallet-setup.ts` | Add `BackgroundDataLoad` type if not present (used by design components) |

### Unchanged Files
All existing market-related pages, components, and tests remain untouched.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| `@scure/bip39` not bundling in Vite | It's a pure ESM package, well-supported by Vite. cashu-ts already depends on it transitively. |
| IndexedDB not available in Vitest (jsdom) | Mock Dexie in unit tests; test proof persistence in E2E only. |
| Existing E2E tests break due to auto-redirect to `/setup` | Set `localStorage.setItem('bitcaster.setupComplete', 'true')` in existing test `InitializeAsync()` before navigating. |
| Design components reference `backgroundDataLoad` prop not in current types | Add the type to `wallet-setup.ts` (it's defined in the design's `types.ts`). |

---

## Out of Scope

- **Wallet restore from seed** (scanning mint for existing proofs) — future work, requires NUT-13 counter scanning
- **NWC integration** — existing `lib/nostr.ts` has `connectNwcWallet()` but wiring it to the store is a separate task
- **Multi-unit support** — hardcode `unit: 'sat'` for now
- **Nostr mint backup** — cashu.me backs up mint URLs via Nostr DM; defer to a future milestone
- **Lightning deposit/withdraw UI** — the store will support it (via existing `lib/cashu.ts` helpers) but the UI is a separate section
