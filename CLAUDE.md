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
- `VITE_SERVER_URL` — BitCaster.Server endpoint (default `http://localhost:5000`)
- `VITE_ORACLE_PUBKEY` — (optional) hex pubkey for DLC oracle announcements

## Monorepo Layout

```
AppHost/             .NET Aspire orchestrator (local dev: mint + server + frontend)
BitCaster.Server/    Matching engine + real-time price feed (ASP.NET minimal API + SignalR)
bitCaster/           React 19 + Vite PWA frontend
bitCaster-doc/       Astro Starlight documentation site (GitHub Pages)
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

## Documentation Site

The `bitCaster-doc/` directory contains an Astro Starlight documentation site.

```bash
cd bitCaster-doc
npm run dev          # Astro dev server
npm run build        # static build to dist/
npm run preview      # preview production build
```

- Themed with bitCaster design tokens (bitcoin orange `#f7931a`, slate neutrals, Inter + JetBrains Mono)
- Sidebar auto-generated from `src/content/docs/` directory structure
- Deployed to GitHub Pages via `.github/workflows/deploy-docs.yml` on push to `main`
- Uses Starlight's CSS custom property system (`--sl-*`), not Tailwind

## BitCaster.Server (Matching Engine)

ASP.NET minimal API (`net10.0`) with SignalR. Two responsibilities only:

1. **CLOB matching engine** — in-memory order books with price-time priority, direct + complementary matching
2. **Real-time price feed** — SignalR hub broadcasting orderbook updates and trade executions

```bash
cd BitCaster.Server
dotnet build                  # compile
dotnet run                    # start server
```

Key files:
- `Domain/OrderBook.cs` — in-memory order book per market (keyed by condition_id)
- `Domain/MatchingEngine.cs` — pure static matching logic (direct + complementary paths)
- `Hubs/MarketHub.cs` — SignalR hub at `/hubs/market` (join/leave market groups)
- `Endpoints/OrderEndpoints.cs` — `POST /api/v1/orders`, `DELETE /api/v1/orders/{id}`
- `Endpoints/BookEndpoints.cs` — `GET /api/v1/markets/{marketId}/orderbook`

Order books are ephemeral (in-memory). The mint is the source of truth for token state.

## Local Dev with Aspire

The `AppHost/` directory contains a .NET Aspire orchestrator that starts cdk-mintd, BitCaster.Server, and the Vite frontend together.

Prerequisites: .NET 10+ SDK, Docker, Node.js + npm

```bash
cd AppHost
dotnet run
```

This builds cdk-mintd from `cdk/Dockerfile` (slow first run due to Nix), starts the mint on port 8085 with fakewallet, starts BitCaster.Server, runs `npm install` + `npm run dev` for the frontend, and opens the Aspire dashboard (typically `https://localhost:17225`).

The frontend's Vite dev server proxies `/v1/*` requests to the mint. The `VITE_MINT_URL` and `VITE_SERVER_URL` env vars are set automatically by Aspire.

## Infrastructure

Terraform configs live in `infrastructure/` (main.tf, variables.tf, outputs.tf). These deploy Azure Container Apps (mint), PostgreSQL, and Static Web Apps. Not typically modified during frontend work.
