# bitCaster — Agent Instructions

**Free, anonymous, Bitcoin-native prediction markets powered by Cashu ecash**

- Market positions are **Cashu conditional tokens** (CTF) — ecash spendable only when a DLC oracle attests a specific outcome
- **No accounts, no KYC, no custodians** — settlement is enforced cryptographically by the mint
- **Nostr** provides identity (optional), oracle announcements, and Nostr Wallet Connect (NWC)
- The Cashu mint runs **CDK** (Cashu Development Kit in Rust) with the NUT-CTF extension

## Architecture

```
User Browser (PWA)
  │  cashu-ts   ←→  CDK mintd (Azure Container Apps)
  │  NDK        ←→  Nostr relays (oracle announcements)
  │  NWC        ←→  Lightning wallet (top-up)
  │  SignalR    ←→  BitCaster.Server (matching engine + price feed)
  │  REST       ←→  BitCaster.Server (order submission)
  │
  └─ Azure Static Web Apps (CDN)

BitCaster.Server
  └─ In-memory order books (ConcurrentDictionary per market)

CDK mintd
  ├─ PostgreSQL Flexible Server (state)
  └─ Key Vault (mint keys)
```

## NUT-CTF Protocol Summary

1. **Oracle announces** an event outcome as a Nostr event (kind 88)
2. **Mint registers** the announcement and derives a `condition_id`
3. **Users mint CTF tokens** locked to a `condition_id` (stake on an outcome)
4. **Oracle attests** — publishes the result as a Nostr event
5. **Mint settles** — winners swap their CTF tokens for regular sats; losing tokens become unspendable

See `nuts/CTF.md` for the complete specification.

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
cashu.me/            Reference cashu wallet (no CTF feature)
```

## Local Dev

`AppHost/` is the entry point for development — it launches the CDK mint, BitCaster.Server, and Vite frontend together via .NET Aspire. See `.claude/rules/aspire.md` for details.

### Before Committing

1. **All tests pass** — run `dotnet test` from the repo root and ensure all unit and integration tests are green.
2. **Codex review passes** — run `codex exec review`, fix any reported issues, and repeat until codex returns LGTM.

## Project-Specific Details

See `.claude/rules/` for details on each subproject:
- `frontend.md` — React PWA build commands, coding conventions, env setup, key files & libraries
- `server.md` — BitCaster.Server matching engine & SignalR hub
- `nut-ctf.md` — NUT-CTF protocol and specs
- `doc-site.md` — Astro Starlight documentation site
- `design.md` — Design system references
- `aspire.md` — Local dev orchestration with .NET Aspire
- `infrastructure.md` — Terraform / Azure deployment
