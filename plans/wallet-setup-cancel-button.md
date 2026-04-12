# Wallet Setup — Add Cancel Button (PWA back-out)

## Problem

When a user launches the wallet setup wizard from `/portfolio` (or is bounced here by
`WalletRequiredModal`), the wizard fills the viewport with no way to exit. In a PWA
there is no browser back button, so the user is stuck until they finish the flow.
The market creation wizard already solved this with a fixed top-right close button
and a history-aware `onClose` handler — we want to mirror that pattern.

## Goal

Add a close (X) button to the wallet setup wizard, visible on **every** step
(including the full-screen `WelcomeLanding` and `PwaConfirmation` steps where the
user is most likely to want to back out), wired to a handler that returns the user
to wherever they came from.

## Reference pattern

`bitCaster-app/src/components/market-creation/MarketCreationWizard.tsx:58-75` —
header fragment holds a `fixed top-4 right-4 z-20` X button, rendered alongside
each step's content so it overlays both full-screen and laid-out steps.

`bitCaster-app/src/hooks/useMarketCreationState.ts:131-138` — `onClose` uses
`window.history.length > 1` to decide between `navigate(-1)` and a safe fallback.

## Navigation strategy

The user always arrives at `/setup` via `navigate('/setup')` — from `PortfolioPage`
or `WalletRequiredModal` (which can pop from any page). So `navigate(-1)` naturally
returns them to the originating page. No state tracking or query params needed.

The only edge case is a direct deep-link to `/setup` with no history. For that we
fall back to `/markets` — the main browsable page that works without a wallet.

Current callers:
- `bitCaster-app/src/pages/PortfolioPage.tsx:15` — `navigate('/setup')`
- `bitCaster-app/src/components/shared/WalletRequiredModal.tsx:38` — `navigate('/setup')`

Future callers will work automatically as long as they use normal navigation to
`/setup`, because `navigate(-1)` will pop back to wherever they came from.

## Scope decisions

- **Visible on steps 1 & 2:** The `WelcomeLanding` and `PwaConfirmation` steps are
  exactly the screens where a PWA user gets trapped, so the button must be there.
  Following `MarketCreationWizard`, we render it once at the top of `WalletSetup`
  so it overlays every step.
- **Don't touch `SeedVerification`:** When the user is mid-verification, cancelling
  the whole wizard is still valid — they haven't committed anything. We don't need
  a confirmation dialog (the wizard state is all in-memory; the generated mnemonic
  has not been persisted yet at that point — confirm this in step 4 below).
- **No new shared primitive.** Two wizards is not enough to justify extracting a
  shared `<WizardCloseButton>`. Copy the markup.

## Files to change

### 1. `bitCaster-app/src/types/wallet-setup.ts`

Add one new optional callback to `WalletSetupProps`:

```ts
/** Called when user clicks the close (X) button to exit the wizard */
onClose?: () => void
```

Place it next to `onBack` (line 99) so the grouping matches the wizard's "exit"
family of callbacks.

### 2. `bitCaster-app/src/components/wallet-setup/WalletSetup.tsx`

- Import `X` from `lucide-react` (line 1 already imports from that module).
- Destructure `onClose` from props (around line 42).
- Build a shared `header` element holding the close button, matching
  `MarketCreationWizard.tsx:58-66` markup exactly:

  ```tsx
  const header = (
    <button
      onClick={() => onClose?.()}
      aria-label="Close wallet setup"
      className="fixed top-4 right-4 z-20 p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/80 backdrop-blur-sm transition-colors"
    >
      <X className="w-5 h-5" strokeWidth={1.75} />
    </button>
  )
  ```

- Render `{header}` in three places so it appears on every step:
  1. Wrap the step-1 return (lines 48-58) in a fragment: `<>{header}<WelcomeLanding …/></>`
  2. Wrap the step-2 return (lines 61-70) the same way.
  3. Inside the steps 3-5 wrapper `<div>` (line 74), render `{header}` as the first
     child — just like `MarketCreationWizard.tsx:99`.

- Keep the existing inline "Back" arrow button on steps 4+ untouched. The close
  button is orthogonal to the per-step back button.

### 3. `bitCaster-app/src/pages/WalletSetupPage.tsx`

- Add an `onClose` handler that navigates back to the originating page:

  ```ts
  const onClose = () => {
    if (window.history.length > 1) {
      navigate(-1)
    } else {
      navigate('/markets')
    }
  }
  ```

  `navigate(-1)` returns to whatever page launched the wizard (portfolio, a market
  page via `WalletRequiredModal`, or any future caller). The `/markets` fallback
  only fires for direct deep-links with no history.

  Place it next to `onBack` (line 165) so the callbacks stay grouped.

- Thread it through to `<WalletSetup …/>` at the bottom of the file (around line
  203, next to `onBack={onBack}`).

### 4. Verify mnemonic-leak concern (read-only check, no code change expected)

Before finalizing, grep `useWalletStore.generateMnemonic` to confirm that
generating a mnemonic does **not** persist it anywhere that survives the wizard
being cancelled. If it writes to `localStorage` immediately, we may need to also
call a reset action in `onClose`. If it's purely in-memory until `completeSetup`
is called, we're safe and no extra work is needed.

- File: `bitCaster-app/src/stores/wallet.ts`
- Look for: `generateMnemonic`, `recoverFromMnemonic`, `completeSetup`, and any
  `persist`/`localStorage` writes tied to them.

If persistence does happen mid-wizard, add a `cancelSetup` store action that
clears the partial state, and call it from `onClose` before navigating.

## Manual verification

1. `cd bitCaster-app && npm run typecheck` — must pass.
2. `cd bitCaster-app && npm run dev` — open `http://localhost:5173/portfolio`,
   click "Get Started", verify:
   - Close button is visible in the top-right corner on step 1 (WelcomeLanding).
   - Click it → lands back on `/portfolio` (the page that launched the wizard).
   - Walk to step 2, 3, 4, 5 and confirm the button stays visible and functional.
   - Walk into the seed-verification sub-step of step 4 and confirm cancel still
     exits the wizard entirely (no state lingering — retest entering setup fresh).
3. Repeat in PWA mode: `npm run build && npm run preview`, install as PWA, confirm
   the flow works without a browser back button available.
4. Deep-link check: open `http://localhost:5173/setup` directly in a fresh tab
   (no history), click close → should land on `/markets`, not `about:blank`.

## Out of scope

- Extracting a shared `<WizardCloseButton>` component.
- Confirmation dialog before cancelling (wizard state is cheap to rebuild).
- Changing the existing `onBack` semantics or the step-1/2 layouts beyond
  overlaying the close button.
- Touching `WalletRequiredModal` — it already points at `/setup` and doesn't
  need to know about the new cancel handler.
