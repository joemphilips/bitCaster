# Deposit/Withdrawal Page Implementation Plan

## Context

The Portfolio page already has Deposit/Withdraw buttons that navigate to `/deposit` and `/withdraw`, but those routes and pages don't exist yet. This plan implements the full deposit/withdrawal flows, mirroring cashu.me's Receive/Send UX: deposit via Lightning invoice or ecash token paste, withdraw by generating ecash tokens or paying Lightning invoices. All wallet operations are client-side only, using the existing `@cashu/cashu-ts` library and local IndexedDB proof storage.

**UI approach**: No independent routes for deposit/withdraw. Instead, everything is rendered in-page as overlays triggered from the Portfolio (or any other page). A Drawer (bottom sheet on mobile, centered modal on desktop) appears first as the method chooser, then transitions to a full-screen Modal for the selected flow (Lightning/Ecash). This avoids route changes and keeps the parent page mounted underneath.

## Phase 0: Foundation — reactive balance + dependencies

**Install packages** in `bitCaster-app/`:
- `qrcode.react` — QR code rendering for invoices and tokens
- `dexie-react-hooks` — reactive IndexedDB queries

**Fix `useBalance()`** in `bitCaster-app/src/stores/wallet.ts:153`:
- Replace the hardcoded `return 0` with a `useLiveQuery` from `dexie-react-hooks` that reads proof amounts from `db.proofs`
- This enables `MintSelector` to show real per-mint balances reactively

## Phase 1: E2E tests (happy paths)

**Create** `tests/E2E/DepositWithdrawTests.cs`

Follow the established `WalletSetupTests.cs` pattern (`IAsyncLifetime`, `WaitForService`, `NewPwaPageAsync()`). Pre-seed `localStorage` with a completed wallet setup so tests start from a ready state.

**Infrastructure**: Add a c-lightning (CLN) node to `docker-compose.yml` connected to the mint's Lightning backend. This enables real Lightning payment testing end-to-end.

**Single end-to-end test** (`AliceBob_DepositTransferWithdraw`): Two browser instances (Alice and Bob), one continuous flow:

1. **Alice deposits via Lightning** — Alice opens Portfolio → clicks Deposit → selects Lightning → enters amount → clicks CREATE INVOICE → the test pays the invoice from c-lightning via CLI (`lightning-cli pay <bolt11>`) → verify Alice's balance increases (ecash proofs minted)
2. **Alice sends ecash to Bob** — Alice clicks Withdraw → selects Ecash → enters amount → clicks SEND → copies the generated cashu token → Bob opens Deposit → selects Ecash → pastes the token → verify Bob's balance increases and Alice's balance decreases
3. **Bob withdraws to Lightning** — Bob clicks Withdraw → selects Lightning → pastes a c-lightning invoice (generated via `lightning-cli invoice`) → confirms payment → verify Bob's balance decreases and c-lightning received the funds


## Phase 2: Unit tests (non-happy paths)

**Create** `bitCaster-app/src/pages/__tests__/useDepositWithdrawState.test.ts`:
- Numpad: digits build amount string, backspace removes last char, backspace on "0" stays 0
- Amount > balance disables send
- View transitions: chooser → deposit-lightning, chooser → deposit-ecash, etc.
- `onClose` resets state

**Create** `bitCaster-app/src/components/deposit-withdraw/__tests__/DepositWithdraw.test.tsx`:
- CREATE INVOICE disabled when amount is 0
- SEND disabled when amount is 0
- Correct title for deposit vs withdraw mode

## Phase 3: Copy design components + types

**Copy from** `bitCaster-design/product-plan/sections/deposit-withdraw/`:

Types → `bitCaster-app/src/types/deposit-withdraw.ts`

Components → `bitCaster-app/src/components/deposit-withdraw/`:
- `DepositWithdraw.tsx`, `MethodChooser.tsx`, `DepositEcash.tsx`, `DepositLightning.tsx`
- `SendEcash.tsx`, `PayLightning.tsx`, `MintSelector.tsx`, `AmountDisplay.tsx`, `Numpad.tsx`, `index.ts`

Fix imports: `from '../types'` → `from '@/types/deposit-withdraw'`

## Phase 4: New result/waiting views

These views are not in the design spec but are required for the post-action phase.

**Create** `bitCaster-app/src/components/deposit-withdraw/InvoiceDisplay.tsx`:
- Shows bolt11 QR code (`qrcode.react`) + copyable text + payment status spinner
- On `status === 'paid'`, shows success checkmark then calls `onPaid`

**Create** `bitCaster-app/src/components/deposit-withdraw/TokenDisplay.tsx`:
- Shows cashu token QR code + copyable text + amount

**Create** `bitCaster-app/src/components/deposit-withdraw/MeltConfirmation.tsx`:
- Shows decoded invoice amount + fee estimate from melt quote + total
- PAY button to confirm

All use the same `fixed inset-0 z-[70] bg-slate-900` layout pattern as the design components.

## Phase 5: Custom hook `useDepositWithdrawState`

**Create** `bitCaster-app/src/pages/useDepositWithdrawState.ts`

Manages local UI state (view, amount, mint selection, lightning input) and dispatches to existing `cashu.ts` helpers.

Key handlers (mirroring cashu.me flows):

| Handler | Flow |
|---|---|
| `onCreateInvoice` | `wallet.createMintQuote(amount)` → show InvoiceDisplay → `waitForMintQuotePaid()` → `wallet.mintProofs()` → `addProofs()` |
| `onPaste` (deposit ecash) | `navigator.clipboard.readText()` → `decodeToken()` → `receiveToken()` → `addProofs()` |
| `onSendEcash` | `getProofs()` → `sendProofs(amount, proofs)` → `removeProofs()` + `addProofs(keep)` → `encodeToken(send)` → show TokenDisplay |
| `onLightningInputChange` | Auto-detect bolt11 → `createMeltQuote()` → show MeltConfirmation |
| `onConfirmMelt` | `getProofs()` → `meltProofs(quote, proofs)` → update proof store |
| `onScanQR` / `onScan` | Deferred — show "coming soon" for camera scanning |

Mint adapter: builds `MintInfo[]` from `useWalletStore.mints[]` + `useBalance(mint.url)`.

## Phase 6: Wire into Portfolio (in-page overlay, no new routes)

No new routes or page components needed. Instead:

**Modify** `bitCaster-app/src/pages/PortfolioPage.tsx`:
- Add local state: `const [depositWithdrawMode, setDepositWithdrawMode] = useState<'deposit' | 'withdraw' | null>(null)`
- Replace `navigate('/deposit')` with `setDepositWithdrawMode('deposit')`, same for withdraw
- Conditionally render `<DepositWithdraw>` overlay when `depositWithdrawMode` is not null
- `onClose` sets mode back to `null`

**Create** `bitCaster-app/src/components/deposit-withdraw/DepositWithdrawOverlay.tsx`:
- A wrapper that combines `useDepositWithdrawState` with `DepositWithdraw` and the result views (InvoiceDisplay, TokenDisplay, MeltConfirmation)
- Accepts `mode: 'deposit' | 'withdraw'` and `onClose` props
- Renders the Drawer (method chooser) first, then transitions to the full-screen Modal for the selected flow

This keeps the Portfolio page mounted underneath and avoids route-based navigation for deposit/withdraw.

## Phase 7: WebSocket + polling helpers

**Modify** `bitCaster-app/src/lib/cashu.ts`:

Add `waitForMintQuotePaid(quoteId, onPaid, onError)`:
- Try WebSocket subscription via `wallet.onMintQuotePaid()` (NUT-17)
- Fallback: poll `wallet.checkMintQuote()` every 5 seconds
- Returns unsubscribe function for cleanup in `useEffect`

Add `checkMintQuote(quoteId)` wrapper.

## Phase 8: Integration testing + polish

1. Run E2E: `dotnet test tests/E2E/ -j $(($(nproc) - 1))`
2. Run typecheck: `cd bitCaster-app && npm run typecheck`
3. Fix iteratively until all tests pass
4. Error handling: network errors, insufficient balance, expired quotes
5. Loading spinners during async operations
6. WebSocket cleanup on unmount

## File Summary

### New files
| File | Purpose |
|---|---|
| `tests/E2E/DepositWithdrawTests.cs` | E2E test (Alice/Bob flow with c-lightning) |
| `bitCaster-app/src/types/deposit-withdraw.ts` | Types (copy from design) |
| `bitCaster-app/src/components/deposit-withdraw/*.tsx` | 9 design components (copy) |
| `bitCaster-app/src/components/deposit-withdraw/index.ts` | Barrel export (copy) |
| `bitCaster-app/src/components/deposit-withdraw/InvoiceDisplay.tsx` | QR + status for bolt11 |
| `bitCaster-app/src/components/deposit-withdraw/TokenDisplay.tsx` | QR + copy for ecash token |
| `bitCaster-app/src/components/deposit-withdraw/MeltConfirmation.tsx` | Fee confirmation for melt |
| `bitCaster-app/src/components/deposit-withdraw/DepositWithdrawOverlay.tsx` | Overlay wrapper combining hook + views |
| `bitCaster-app/src/pages/useDepositWithdrawState.ts` | All flow logic |

### Modified files
| File | Change |
|---|---|
| `bitCaster-app/package.json` | Add `qrcode.react`, `dexie-react-hooks` |
| `bitCaster-app/src/stores/wallet.ts` | Reactive `useBalance()` via `useLiveQuery` |
| `bitCaster-app/src/pages/PortfolioPage.tsx` | Add overlay state, render `DepositWithdrawOverlay` in-page |
| `bitCaster-app/src/lib/cashu.ts` | Add `waitForMintQuotePaid()`, `checkMintQuote()` |
| `docker-compose.yml` | Add c-lightning service for E2E testing |

## Reusable existing code
- `bitCaster-app/src/lib/cashu.ts` — `createMintQuote()`, `mintProofs()`, `encodeToken()`, `decodeToken()`, `receiveToken()`, `sendProofs()`, `createMeltQuote()`, `meltProofs()`
- `bitCaster-app/src/stores/wallet.ts` — `useWalletStore` (mints, activeMintUrl, getWallet)
- `bitCaster-app/src/stores/proof-db.ts` — `getProofs()`, `addProofs()`, `removeProofs()`

## Verification

1. `cd bitCaster-app && npm run typecheck` — no type errors
2. `cd bitCaster-app && npm test` — unit tests pass
3. Start services (`docker compose up mintd`, `cd BitCaster.InMemoryMatchingEngine && dotnet run`, `cd bitCaster-app && npm run dev`)
4. `dotnet test tests/E2E/` — E2E tests pass
5. Manual: Navigate to Portfolio → click Deposit → Lightning → enter 100 → CREATE INVOICE → verify QR appears
6. Manual: Navigate to Portfolio → click Withdraw → Ecash → enter 50 → SEND → verify token string appears
7. Run `codex exec review --uncommitted` for code review, fix any issues found, re-run tests if necessary

