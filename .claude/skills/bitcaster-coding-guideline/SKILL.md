---
name: bitcaster-coding-guideline
description: bitCaster cross-language coding rules for the C# (engine + Sekiban) ↔ TypeScript (frontend + wallet-service) boundary. Codifies the discipline that prevents enum-drift, string-literal comparisons, and casing/null bugs from silently leaking across the JSON wire. Use whenever you (a) add or change a value that crosses an OpenAPI boundary, (b) write a `switch`/comparison over a string-typed value generated from a backend enum, (c) introduce or rename an engine enum or Sekiban event field that the frontend or wallet-service consumes. Loaded by `engine-engineer` and the submodule's `bitcaster-software-engineer` agents — NOT by security/architect/devops personas. Trigger phrases — "enum drift", "shared enum", "wire-format value", "OpenAPI enum", "string comparison", "MarketState mapping", "attestation status mapping".
---

# bitCaster Coding Guideline — Cross-Language Discipline

The matching engine speaks **C# (.NET 9)** and the frontend / wallet-service / mock engine speak **TypeScript**. Values flow over JSON across that boundary every request. When a value is an enum or a fixed set of strings, naive comparisons on the receiving side break silently when:

- the **casing** drifts (`'Open'` vs `'open'`)
- a value is **null/undefined/missing** (e.g. mintd hasn't published an attestation yet)
- the producer adds a **new variant** (consumer's negative comparison `!== 'pending'` flips for the new value)
- whitespace, accidental quoting, or serialization framework differences slip in

These bugs do not surface in unit tests of either side in isolation. They surface in production as user-visible regressions. P7 staging review's "newly created markets shown as Closed" was one such bug (`isMarketClosed(s) => s.status !== 'pending'` — `undefined !== 'pending'` is `true`).

This skill codifies the rules for both `engine-engineer` (.NET writer) and the submodule's `bitcaster-software-engineer` (TypeScript writer) so the same value drawn at the same wire boundary is read the same way by both.

## When to load this skill

Load this skill **before** writing or editing code that:

- Defines a C# enum or string-typed value type that crosses the engine ↔ frontend / engine ↔ wallet-service / wallet-service ↔ frontend boundary (`Contracts/`, OpenAPI spec, SignalR hub method signature).
- Compares a TypeScript string against a hand-written literal that came from one of those wires.
- Adds a new variant to an existing shared enum.
- Touches `MarketState`, `DepositState`, `OrderState`, `AttestationStatus`, `OutcomeType`, or any other backend-defined string union.

Skip this skill when working purely inside one language's domain (engine-internal commands, frontend-only client state) and the values never serialize across the boundary.

## The three rules

### Rule 1 — OpenAPI is the single source of truth for shared enums

**Every enum that crosses an HTTP boundary lives in `bitCaster/BitCaster.MatchingEngine.Contracts/specs/openapi.yaml`** with an explicit `enum:` list. The TypeScript type **must** be generated, not hand-written. The generator output is `bitCaster/bitCaster-app/src/generated/api.ts`; the wallet-service uses its own generator output under `bitcaster-wallet-service/src/generated/`.

```yaml
# openapi.yaml — canonical
MarketState:
  type: string
  enum: [open, closed]
  x-enum-varnames: [Open, Closed]
```

```ts
// generated/api.ts — never edited by hand
type MarketState = "open" | "closed"
```

```csharp
// Contracts/Domain/ValueTypes.cs — kept in lockstep manually OR generated
[JsonConverter(typeof(JsonStringEnumConverter<MarketState>))]
public enum MarketState { Open, Closed }
```

**Banned**: hand-typed `'open' | 'closed'` literals in TypeScript app code. Always import from `generated/api.ts`. Hand-written C# enums that have no OpenAPI counterpart but are exposed over the wire are equally banned — promote them to the spec first, then regenerate consumers.

The mintd-side schema (`/v1/conditions`, `attestation.status`) is **upstream** and not under our control. Treat its values as raw strings at the ingress boundary, normalize them once into our generated TypeScript type, and never compare strings against mintd's wire form again past that ingress.

### Rule 2 — One canonical wire form, enforced at the boundary, not at the call site

C# `JsonStringEnumConverter` is configured globally with `JsonNamingPolicy.CamelCase`. All enum values go out as `camelCase` strings (`"open"`, not `"Open"`). The frontend never accepts `"Open"`, never lowercases at the call site to "be safe". If a value arrives miscased from a producer we control, that is a **bug in the producer** — fix it at the boundary, not by paving over it with `.toLowerCase()`.

> **NSwag trap (P7 finding, 2026-05-04).** NSwag-generated DTOs ship per-property `[JsonConverter(typeof(JsonStringEnumConverter<T>))]` attributes that use the parameterless converter constructor — **no naming policy** — silently overriding any global `JsonNamingPolicy.CamelCase`. The `[EnumMember(Value = "open")]` attributes NSwag also emits are honored by `Newtonsoft.Json` but **not** by `System.Text.Json.JsonStringEnumConverter`. Result: the engine emits `"state":"Open"` against a spec that says `"open"`. When you add a new enum to the OpenAPI spec, do not assume the C# producer emits camelCase just because the spec says so. **Verify with `curl`** that the running mock + production engine emit the lowercase form. If they don't, fix the producer (regenerate DTOs with `JsonStringEnumConverter(JsonNamingPolicy.CamelCase)`), not the consumer. Frontend defensive normalization is acceptable only as a stopgap with a TODO.

For values that come from outside our control (mintd, NIP-88 events, NIP-17 DMs from arbitrary peers), normalize **once** at the ingress boundary into the generated TypeScript type:

```ts
// good — mintd ingress, in lib/markets.ts
function normalizeMintdStatus(raw: unknown): AttestationStatus {
  if (raw == null) return 'pending'   // explicit default for absent attestation
  const s = String(raw).toLowerCase().trim()
  switch (s) {
    case 'pending': case 'attested': case 'expired': case 'violation':
      return s as AttestationStatus
    default:
      throw new Error(`unknown mintd attestation status: ${raw}`)
  }
}
```

Inside app code past that ingress, enum values are **trusted** and compared via Rule 3.

### Rule 3 — Total mappings, not negative comparisons

The P7 regression — `attestation.status !== 'pending'` — is the canonical anti-pattern. A negative comparison silently flips for any unexpected value (typo, casing drift, undefined, new variant the consumer didn't update for).

**Always** write exhaustive switches over the generated union, with a TypeScript `assertNever` on the default branch. Adding a new enum variant must become a **compile-time error** at every consumer.

```ts
// good
import type { MarketState } from '@/generated/api'

function isClosed(s: MarketState): boolean {
  switch (s) {
    case 'open':   return false
    case 'closed': return true
    default:       return assertNever(s)
  }
}

function assertNever(x: never): never {
  throw new Error(`unhandled enum variant: ${JSON.stringify(x)}`)
}
```

```ts
// banned — fails the lint rule below
const closed = state !== 'open'
const closed = state === 'closed'   // not exhaustive when a new variant is added
```

The C# side gets the equivalent treatment with switch-expressions over the enum, no fallthrough, no `_ => default(...)`:

```csharp
// good
public bool IsClosed(MarketState s) => s switch
{
    MarketState.Open   => false,
    MarketState.Closed => true,
    // no default — adding a variant breaks compilation
};
```

```csharp
// banned
return s != MarketState.Open;
```

### Rule 4 — Cross-aggregate state invariants live in the projector, not the command handler

Per ADR-013, when a command's behaviour depends on the **current value of an event-sourced state field on a different aggregate** (the canonical case: `MarketRegistration.MarketState` gating `OrderBook` / `MarketFunding` / `Trade` / `MarketWallet` mutations), the invariant lives in the **projector**, not the handler. The handler accepts the command unconditionally on that axis; the projector subscribes to the source aggregate's state event (e.g. `MarketClosed`), mirrors the state into its own payload via Sekiban event-stream subscription, and emits a no-op for mutating events when the mirrored state forbids the mutation. The rejected event is preserved in the event store as a forensic record.

Why: cross-aggregate reads from inside a command handler are non-local (extra round-trip, race surface, awkward Sekiban plumbing). The projector already owns the aggregate's state and is the natural enforcement point. The "accept-then-no-op" model is forensically complete (rejected attempts are recorded for audit / abuse triage) and structurally regression-safe (no gate to forget when a new command issuer is added).

When this rule does **NOT** apply — keep the rejection at the handler:

| Rejection class | Stays at handler because |
|---|---|
| Authz / IDOR (`order.UserId != requester`) | Returning 403 to the user is a useful signal; silent no-op masks legitimate client bugs |
| Input validation (UserId format, hex shape, ExpiresAt-in-past) | Stateless; pure shape checks. Moving to projector adds ceremony with zero benefit |
| Sekiban command idempotency (duplicate `DepositId`, replay of `RecordDepositPaid`) | Already an event-sourced no-op via `EventOrNone.None` — that IS the projector pattern, just earlier in the pipeline |
| mTLS-internal contract (`RecordDepositCreditedCommand` rejected when not in `Paid` state) | Wallet-service is operator-internal; silent no-op would mask a real wallet-service bug |

**Decision rule**: ask "does this rejection depend on the current value of an event-sourced state field on a different aggregate?" If yes → projector-side per ADR-013. If no → handler-side.

The fast-fail UX gate at the HTTP endpoint (`ClosedMarketGate.CheckByConditionIdAsync`) is allowed as a defence-in-depth optimisation — return 409 fast on the first user attempt rather than letting the user wait for the round-trip-and-projector-no-op. It is NOT the primary correctness mechanism. Programmatic / internal command issuers (CPMM bot, Orleans timers, replay tooling) MUST NOT rely on the endpoint gate; they get the projector check for free.

## Enforcement

The three rules are enforced — not aspirational.

### Lint rule (TypeScript)

`bitCaster/bitCaster-app/eslint.config.js` ships a custom rule (or grep-gate in CI when ESLint custom rules are too heavy) that flags:

- `=== '<literal>'` and `!== '<literal>'` where the LHS is typed as one of the generated enums
- string-literal type aliases hand-written in app code that duplicate a generated enum

Suggested message: "Compare via exhaustive switch + assertNever; see `.claude/skills/bitcaster-coding-guideline/`."

### Vitest contract-shape test

`bitCaster/bitCaster-app/src/generated/__tests__/enum-discipline.test.ts` asserts via `tsd` / `expectError` that the canonical enum consumers (`useMarketState`, mintd ingress, etc.) exhaustively cover their input enum — adding a synthetic variant must produce a compile error.

### CI guard for hand-typed shared enums

A grep-gate in CI fails the build if app code under `bitCaster/bitCaster-app/src/` (excluding `generated/`) defines a string union that duplicates the name of a generated enum. The intent: prevent drift via copy-paste.

### Generator regeneration check

CI runs the OpenAPI → TypeScript generator and `git diff --exit-code` against the committed `generated/api.ts`. A spec change that wasn't committed alongside its regenerated TS fails CI.

## Boundary catalogue — current shared enums

When you touch any of these, this skill's rules apply.

| Enum / value union | Producer | Consumer(s) | Spec location |
|---|---|---|---|
| `MarketState` | engine | frontend, wallet-service | `openapi.yaml#MarketState` |
| `DepositState` | engine | frontend | `openapi.yaml#DepositState` |
| `DepositMethod` | engine | wallet-service, frontend | `openapi.yaml#DepositMethod` |
| `OrderState` | engine | frontend | `openapi.yaml#OrderState` |
| `TimeInForce` | frontend → engine | engine | `openapi.yaml#TimeInForce` |
| `OutcomeType` | engine | frontend | `openapi.yaml#OutcomeType` |
| `AttestationStatus` | mintd (upstream) | frontend (only) | not ours — normalized at ingress, then internal |
| SignalR hub events (`PriceUpdated`, etc.) | engine hub | frontend | `MarketHub.cs` + frontend hooks |

When you add a new shared enum, append it here in the same PR.

## Examples — the P7 regression, before and after

### Before (banned)

```ts
// bitCaster/bitCaster-app/src/lib/markets.ts
export function isMarketClosed(attestation: Pick<AttestationState, 'status'>): boolean {
  return attestation.status !== 'pending'   // undefined !== 'pending' === true → market closed
}
```

```ts
// bitCaster/bitCaster-app/src/hooks/useMarketState.ts (paraphrased)
const CLOSED_STATUSES: ReadonlySet<ResolutionStatus> = new Set(['resolved', 'pending_resolution', 'disputed'])
return CLOSED_STATUSES.has(market.resolution.status) ? 'Closed' : 'Open'
```

Two ways this fails: (a) `attestation.status` is undefined for a never-attested market → first function returns `true`; (b) the set membership pattern is fine but couples the frontend to mintd's lifecycle authority instead of engine state, violating the P7 directive.

### After (canonical)

```ts
// generated/api.ts (do not edit) — engine state
type MarketState = "open" | "closed"

// bitCaster/bitCaster-app/src/hooks/useMarketState.ts
import type { MarketState } from '@/generated/api'

export function isClosed(s: MarketState): boolean {
  switch (s) {
    case 'open':   return false
    case 'closed': return true
    default:       return assertNever(s)
  }
}
```

The detail page reads engine `state` directly. Mintd's `attestation.status` is reduced to "outcome metadata" (which outcome the oracle attested) and is normalized once at ingress.

## Failure modes this rule does NOT cover

- **Numeric drift across the wire** (e.g. an engine `decimal` round-tripped through a TS `number` losing precision). Addressed separately by the `bigint`/string-encoding rule for sats-amount fields — see existing patterns in `Contracts/` for `AmountSats`.
- **Time/date string formats**. Both sides agree on ISO-8601 UTC; format drift is caught by separate parser tests.
- **Schema-shape drift** (a field added on one side, missing on the other). OpenAPI generator catches this — so does Rule 1.
- **Engine-internal C# enums that never cross the wire**. They are out of scope for this skill — apply normal C# style.

## Cross-references

- `.claude/skills/bitcaster-analyzing-code-security` — Pattern 11 (JwtBearer `AuthenticationType` default trap) is conceptually adjacent: a mis-mapped enum-shaped value silently flips a security check. Same root cause class.
- `bitCaster/AGENTS.md` — "Frontend-Backend Validation Parity" section linking here.
- `AGENTS.md` (outer) — "Submodule Independence" rule. The OpenAPI spec lives in `bitCaster/` and is the only contract; this skill enforces that consumers honor the contract instead of reinventing it.
