---
paths:
  - "cdk/**/*"
---

# CDK (Cashu Development Kit)

Rust implementation of the Cashu ecash protocol. Upstream repo — specs live in `../nuts`.

## Build & Dev

Requires Nix, or a Rust toolchain with the protobuf compiler (needed for `cdk-mintd`).

```bash
nix develop -c $SHELL      # dev shell with all deps
just build                 # build workspace
just final-check           # format + clippy + test + docs — run before committing
```

### Testing

```bash
just test                  # unit tests
just test-pure db="memory" # integration tests (in-memory DB)
just itest sqlite          # regtest integration tests (needs docker)
```

### Lint / Format

```bash
just clippy | format | lint | check-wasm | check-docs
```

CI uses **stable** rustfmt (nightly also accepted locally).

## Architecture

Workspace of ~22 crates under `crates/`. Layer stack (each depends on the previous):

`cashu` → `cdk-common` → `cdk` → application crates (`cdk-mintd`, `cdk-cli`, …)

Pluggable backends via traits:
- **Database**: sqlite, postgres, redb
- **Lightning**: cln, lnd, lnbits, ldk-node, fake

Saga pattern for crash-recoverable mint/wallet transactions. Feature flags: `mint`, `wallet`, `auth`, `nostr`, `bip353`, `tor`.

## Code Style (`CODE_STYLE.md`)

- Trait bounds in `where` clauses, not inline.
- Use `Self` instead of repeating the type name.
- Qualify tracing macros directly: `tracing::warn!(...)` — don't `use tracing::warn`.
- Prefer `.to_string()` over `.into()` / `String::from()`.
- Prefer `match` over `if let … else`.
- Sub-modules go in separate files (except `tests` / `benches`).

## Lint Policy (workspace `Cargo.toml`)

- `unsafe_code = "forbid"`
- `unwrap_used = "deny"` — use `?` or handle errors explicitly
- `missing_docs = "warn"`, `missing_debug_implementations = "warn"`

## Formatting Config

- `imports_granularity = "Module"`
- `group_imports = "StdExternalCrate"`

## CI Docker Builds

When `cdk` changes, the CI docker build is uncached and slow. Build the image locally and push to Docker Hub first.

## Branching Policy

`origin/ctf` is the feature branch for implementing specs defined in `nuts/CTF*.md`. **Never create other branches for CTF work** — all fixes and features go directly on `ctf`. Ideally it should catch up to the latest `upstream/main` branch with occasional rebasing. If there is a bug that has to be fixed in the CTF branch, first check whether it has been fixed in upstream main.

