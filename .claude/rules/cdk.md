# CLAUDE.md

## Overview

This repo is rust implementation of Cashu ecash protocol.
The spec for the cashu itself can be found in `../nuts`

## Build & Development

Requires Nix or Rust toolchain with protobuf compiler (for `cdk-mintd`).

```bash
nix develop -c $SHELL    # Enter dev shell (provides all deps)
just build                # Build workspace
just final-check          # Run before committing (format + clippy + test + docs)
```

### Testing

```bash
just test                 # Unit tests
just test-pure db="memory" # Integration tests (in-memory DB)
just itest sqlite         # Regtest integration tests (requires docker)
```

### Linting & Formatting

```bash
just clippy               # Lint
just format               # Format (stable rustfmt)
just lint                 # clippy + format check
just check-wasm           # WASM target check
just check-docs           # Doc build check
```

## Architecture

Cashu e-cash protocol implementation in Rust. Workspace of ~22 crates under `crates/`.

**Layer structure** (each depends on the previous):
`cashu` → `cdk-common` → `cdk` → application crates (`cdk-mintd`, `cdk-cli`, etc.)

**Pluggable backends via traits:**
- Database: sqlite, postgres, redb
- Lightning: cln, lnd, lnbits, ldk-node, fake

**Key patterns:**
- Saga pattern for crash-recoverable mint/wallet transactions
- Feature flags: `mint`, `wallet`, `auth`, `nostr`, `bip353`, `tor`

## Code Style

Per `CODE_STYLE.md`:

- Trait bounds in `where` clauses, not inline
- Use `Self` instead of repeating the type name
- Qualify tracing macros directly: `tracing::warn!(...)` not `use tracing::warn; warn!(...)`
- Prefer `.to_string()` over `.into()` / `String::from()`
- Prefer `match` over `if let ... else`
- Sub-modules go in separate files (except `tests`/`benches`)

## Lint Policy

From workspace `Cargo.toml`:

- `unsafe_code = "forbid"`
- `unwrap_used = "deny"` — use `?` or handle errors explicitly
- `missing_docs = "warn"`
- `missing_debug_implementations = "warn"`

## Formatting

- CI checks with **stable** rustfmt; nightly also accepted locally
- `imports_granularity = "Module"`
- `group_imports = "StdExternalCrate"`

## CI Docker Builds

When there is a change in cdk, docker build process in the CI will not use cache and takes quite a long time. So instead build the image in local and then push it to dockerhub first.
