---
paths:
  - "bitCaster-app/**/*"
---

# bitCaster Frontend (React PWA)

## Build & Dev

All commands run from `bitCaster-app/`:

```bash
cd bitCaster-app
npm run dev          # Vite dev server
npm run build        # tsc -b && vite build
npm run typecheck    # tsc --noEmit (use this to verify changes)
npm run preview      # preview production build
```

No linter or formatter is configured — rely on `tsc --strict` for correctness.

## No Dummy/Test Data in Production Code

Never embed hardcoded sample or dummy data in the frontend source. The frontend must always fetch real data from the CDK mint (`GET /v1/conditions`). When the mint is unavailable or has no conditions, show an error state or empty state — never fall back to fake data. Test/seed data belongs in `tools/seed-conditions/` and is injected via docker-compose.

## Coding Conventions

- **TypeScript strict mode** — `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch` are all enabled
- **Path alias** — use `@/*` for imports from `src/` (e.g. `import { wallet } from "@/lib/cashu"`)
- **Styling** — Tailwind CSS with dark theme; bitcoin orange is `#f7931a`, background `#0a0a0a`
- **React 19** with react-router v7
- **PWA** — service worker via `vite-plugin-pwa`, manifest configured in `vite.config.ts`

## Key Files

- `bitCaster-app/src/lib/cashu.ts` — CashuWallet and CashuMint singleton setup
- `bitCaster-app/src/lib/nostr.ts` — NDK singleton, NIP-07 signer, NDKNWCWallet (NWC pairing)
- `bitCaster-app/src/App.tsx` — root component and routing

## Key Libraries

- `@cashu/cashu-ts` ^2.3.0 — CashuWallet, CashuMint, Proof types
- `@nostr-dev-kit/ndk` ^2.11.0 — NDK singleton, NDKNip07Signer, NDKPrivateKeySigner
- `@nostr-dev-kit/ndk-wallet` ^0.3.8 — NDKNWCWallet for NWC pairing

## Environment Setup

```bash
cp bitCaster-app/.env.example bitCaster-app/.env
```

Required variables:
- `VITE_MINT_URL` — Cashu mint endpoint (default `http://localhost:3338`)
- `VITE_SERVER_URL` — BitCaster.Server endpoint (default `http://localhost:5000`)
- `VITE_ORACLE_PUBKEY` — (optional) hex pubkey for DLC oracle announcements
