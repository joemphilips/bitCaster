# bitCaster — Claude Code Instructions

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

## Environment Setup

```bash
cp bitCaster/.env.example bitCaster/.env
```

Required variables:
- `VITE_MINT_URL` — Cashu mint endpoint (default `http://localhost:3338`)
- `VITE_SERVER_URL` — BitCaster.Server endpoint (default `http://localhost:5000`)
- `VITE_ORACLE_PUBKEY` — (optional) hex pubkey for DLC oracle announcements

## Project-Specific Details

See `.claude/rules/` for details on each subproject:
- `frontend.md` — React PWA build commands, coding conventions, key files & libraries
- `server.md` — BitCaster.Server matching engine & SignalR hub
- `nut-ctf.md` — NUT-CTF protocol and specs
- `doc-site.md` — Astro Starlight documentation site
- `design.md` — Design system references
- `aspire.md` — Local dev orchestration with .NET Aspire
- `infrastructure.md` — Terraform / Azure deployment
