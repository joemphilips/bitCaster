---
paths:
  - "AppHost/**/*"
---

# Local Dev with Aspire

The `AppHost/` directory contains a .NET Aspire orchestrator that starts cdk-mintd, BitCaster.Server, and the Vite frontend together.

Prerequisites: .NET 10+ SDK, Docker, Node.js + npm

```bash
cd AppHost
dotnet run
```

This builds cdk-mintd from `cdk/Dockerfile` (slow first run due to Nix), starts the mint on port 8085 with fakewallet, starts BitCaster.Server, runs `npm install` + `npm run dev` for the frontend, and opens the Aspire dashboard (typically `https://localhost:17225`).

The frontend's Vite dev server proxies `/v1/*` requests to the mint. The `VITE_MINT_URL` and `VITE_SERVER_URL` env vars are set automatically by Aspire.
