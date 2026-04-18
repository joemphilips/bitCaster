---
paths:
  - "bitCaster-app/**/*"
---

# bitCaster Frontend (React PWA)

React 19 + Vite + Tailwind + react-router v7 + PWA (`vite-plugin-pwa`). TypeScript strict. No linter/formatter — rely on `tsc --strict` for correctness.

## Commands

```bash
cd bitCaster-app
npm run dev          # Vite dev server (5173)
npm run build        # tsc -b && vite build
npm run typecheck    # tsc --noEmit — use this to verify changes
```

Manual UI checks: use `playwright-cli` or add an E2E test under `tests/E2E/`.

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
- `VITE_SERVER_URL` — matching engine (default `http://localhost:5000`)
- `VITE_ORACLE_PUBKEY` — (optional) hex pubkey for DLC oracle announcements

## Key Files & Libraries

- `src/lib/cashu.ts` — `CashuWallet` / `CashuMint` singletons (`@cashu/cashu-ts` ^2.3.0)
- `src/lib/nostr.ts` — NDK singleton, `NDKNip07Signer`, `NDKPrivateKeySigner`, `NDKNWCWallet` (`@nostr-dev-kit/ndk` ^2.11.0, `ndk-wallet` ^0.3.8)
- `src/lib/kormir.ts` — lazy dynamic import of the kormir-wasm bundle
- `src/App.tsx` — root component + routing

## Frontend-Backend Validation Parity

Every validation rule enforced by the backend (in endpoint handlers or Sekiban domain commands) must be duplicated on the frontend so users cannot submit invalid data in the first place. The backend's OpenAPI spec (`BitCaster.MatchingEngine.Contracts/specs/openapi.yaml`) and value types (`Contracts/Domain/ValueTypes.cs`) are the source of truth for constraints (e.g., `Probability` must be in `[1, 99]`, probabilities must sum to 100). Frontend checks are a UX convenience; backend checks remain the security boundary.

## Mobile/Desktop UI Parity

Every feature visible in the desktop app bar / user menu must also be available in the mobile bottom nav / user menu overlay, and vice versa. The two layouts must show identical data (badges, notification counts, menu items including language selector, docs link, etc.). When adding a new feature to either layout, always update both.

## kormir-wasm (DLC oracle)

The become-oracle flow depends on a WASM build of kormir. The generated package is committed at `src/lib/kormir-wasm-pkg/` so normal builds and CI don't need a Rust toolchain. Rebuild whenever the `kormir/` submodule changes:

```bash
./tools/build-kormir-wasm.sh          # release (default)
./tools/build-kormir-wasm.sh --dev    # faster dev build
```

Wraps `wasm-pack build --target web`. Auto-detects the clang resource directory for Nix's split `clang` / `clang-lib` (secp256k1-sys compiles C to wasm32 and needs `stddef.h`). Requires `rustup target add wasm32-unknown-unknown` and `wasm-pack`. The ~3MB bundle loads lazily via dynamic import in `src/lib/kormir.ts`; `vite.config.ts` excludes the package from dep optimization.
