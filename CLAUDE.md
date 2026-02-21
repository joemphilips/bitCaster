# bitCaster — Claude Code Instructions

## Build & Dev Commands

All commands run from `bitCaster/`:

```bash
cd bitCaster
npm run dev          # Vite dev server
npm run build        # tsc -b && vite build
npm run typecheck    # tsc --noEmit (use this to verify changes)
npm run preview      # preview production build
```

No linter or formatter is configured — rely on `tsc --strict` for correctness.

## Environment Setup

```bash
cp bitCaster/.env.example bitCaster/.env
```

Required variables:
- `VITE_MINT_URL` — Cashu mint endpoint (default `http://localhost:3338`)
- `VITE_ORACLE_PUBKEY` — (optional) hex pubkey for DLC oracle announcements

## Monorepo Layout

```
bitCaster/           React 19 + Vite PWA frontend
bitCaster-design/    Design system, specs, and mockups
infrastructure/      Terraform for Azure (Container Apps, PostgreSQL, Static Web Apps)
nuts/                Cashu NUT specifications (submodule, branch: nuts_for_prediction_markets)
cdk/                 Cashu Development Kit (submodule, branch: bitCaster at joemphilips/cdk)
../cashu.me          An example cashu wallet without CTF feature. It cab be used as a reference for the basic cashu wallet features
```

## Coding Conventions

- **TypeScript strict mode** — `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch` are all enabled
- **Path alias** — use `@/*` for imports from `src/` (e.g. `import { wallet } from "@/lib/cashu"`)
- **Styling** — Tailwind CSS with dark theme; bitcoin orange is `#f7931a`, background `#0a0a0a`
- **React 19** with react-router v7
- **PWA** — service worker via `vite-plugin-pwa`, manifest configured in `vite.config.ts`

## Key Files

- `bitCaster/src/lib/cashu.ts` — CashuWallet and CashuMint singleton setup
- `bitCaster/src/lib/nostr.ts` — NDK singleton, NIP-07 signer, NDKNWCWallet (NWC pairing)
- `bitCaster/src/App.tsx` — root component and routing

## Key Libraries

- `@cashu/cashu-ts` ^2.3.0 — CashuWallet, CashuMint, Proof types
- `@nostr-dev-kit/ndk` ^2.11.0 — NDK singleton, NDKNip07Signer, NDKPrivateKeySigner
- `@nostr-dev-kit/ndk-wallet` ^0.3.8 — NDKNWCWallet for NWC pairing

## NUT-CTF Protocol

bitCaster uses Conditional Timed Fungible (CTF) tokens — Cashu proofs whose keysets are bound to a `condition_id` (32-byte hex derived by the mint from an oracle announcement).

Specs:
- `nuts/CTF.md` — core CTF protocol
- `nuts/CTF-split-merge.md` — split/merge operations for CTF proofs
- `nuts/CTF-numeric.md` — numeric outcome markets

DLC oracle event kind on Nostr: **88**

## Design System

Reference `bitCaster-design/product/` for UI specs and mockups:
- `product/design-system/` — colors, typography
- `product/sections/` — per-section specs, types, mock data, and screenshots
- `product/shell/spec.md` — app shell layout
- `product/product-overview.md` — product overview and roadmap

## Infrastructure

Terraform configs live in `infrastructure/` (main.tf, variables.tf, outputs.tf). These deploy Azure Container Apps (mint), PostgreSQL, and Static Web Apps. Not typically modified during frontend work.
