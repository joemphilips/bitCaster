---
paths:
  - "bitCaster-app/**/*"
---

# bitCaster Frontend (React PWA)

The app uses React, Vite, Tailwind, and TypeScript strict mode.
Read `package.json` for current versions and available checks.

## Commands

```bash
cd bitCaster-app
npm run dev          # Vite dev server (5273 by default; PORT can override it)
npm run build        # tsc -b && vite build
npm run typecheck    # tsc --noEmit — use this to verify changes
```

For browser checks, read `e2e-tests.md` in this directory.

## Conventions

- Path alias `@/*` → `src/*` (e.g. `import { wallet } from "@/lib/cashu"`).
- Tailwind dark theme: bitcoin orange `#f7931a`, background `#0a0a0a`.
- TS strict flags on: `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`.
- **No dummy/test data in source.** Fetch from the mint (`GET /v1/conditions`); show empty or error state on failure. Test/seed data belongs in `tools/seed-conditions/`.

## Env

```bash
cp bitCaster-app/.env.example bitCaster-app/.env
```

- `VITE_MINT_URL` — Cashu mint (default `http://localhost:8085`)
- `BITCASTER_SERVER_URL` — Vite server proxy target for the matching engine
- `VITE_ORACLE_PUBKEY` — (optional) hex pubkey for DLC oracle announcements

## Key Files & Libraries

- `src/stores/wallet.ts` — wallet state
- `src/lib/walletOps.ts` — wallet mutation boundary
- `src/lib/identityOps.ts` — identity mutation boundary
- `src/lib/cashu.ts` — Cashu adapters
- `src/lib/nostr.ts` — Nostr adapters
- `src/lib/kormir.ts` — lazy dynamic import of the kormir-wasm bundle
- `src/App.tsx` — root component + routing

## Frontend-Backend Validation Parity

Use the public OpenAPI contract for user-input constraints.
Keep shared validation in `bitcaster-client-sdk/`.
Reuse it across clients instead of copying backend implementation logic.
Show invalid input before submission when the client has the required facts.
The backend remains the security boundary.
Handle authoritative refusals when state changes after a client check.

## Persisted State And Effects

- Gate boot-time reads on persisted-store hydration.
- Avoid effects that repeatedly trigger themselves through a store mutation.
- Preserve test fixtures during startup hydration.
- Use the wallet and identity mutation boundaries.
- Do not let an untrusted URL, query, or message change the active mint without
  explicit user consent.

## Mobile/Desktop UI Parity

Every feature visible in the desktop app bar / user menu must also be available in the mobile bottom nav / user menu overlay, and vice versa. The two layouts must show identical data (badges, notification counts, menu items including language selector, docs link, etc.). When adding a new feature to either layout, always update both.

## Node Version

Node 22+ is required. Node 20's ESM named-export validation breaks `@cashu/cashu-ts` imports before Vitest's resolve alias can remap them.

## kormir-wasm (DLC oracle)

The become-oracle flow depends on a WASM build of kormir. The generated package is committed at `src/lib/kormir-wasm-pkg/` so normal builds and CI don't need a Rust toolchain. Rebuild whenever the `kormir/` submodule changes:

```bash
./tools/build-kormir-wasm.sh          # release (default)
./tools/build-kormir-wasm.sh --dev    # faster dev build
```

The script wraps `wasm-pack build --target web`.
It needs the `wasm32-unknown-unknown` target and `wasm-pack`.
It locates the clang headers needed by the C dependency.
The app loads the generated package by relative dynamic import.
Normal frontend builds do not require a WASM rebuild.
