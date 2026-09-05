---
name: bitcaster-coding-guideline
description: Apply bitCaster public contract, generated-type, and shared wire-value rules.
---

# bitCaster Public Coding Guideline

Paths below are relative to the public repository.
The public contract defines client obligations.
Do not encode private engine architecture or persistence policy in this skill.

## Contract Authority

Use `BitCaster.MatchingEngine.Contracts/specs/openapi.yaml` as the source
of truth for HTTP schemas and shared enums.
Use the public asynchronous specification and hub interfaces for SignalR.
Do not hand-write TypeScript unions that duplicate generated API enum types.
Do not hand-edit generated DTOs.

After an OpenAPI change, run:

```bash
dotnet build BitCaster.MatchingEngine.Contracts/
cd bitCaster-app && npm run generate:api
```

The frontend generation command updates the app and SDK types.
Keep shared parsing, validation, and protocol logic in `bitcaster-client-sdk/`.
Do not add a dependency on a private implementation repository.

## Wire Values And Mappings

Preserve the exact values declared by the public schema.
Do not repair producer casing errors with ad hoc consumer conversions.
Generated converter attributes can override a global serializer policy.
Verify serialized values through the actual converter or transport boundary.

Normalize untrusted upstream values once at ingress.
Validate missing and unknown values before treating them as a generated type.
Use only defaults defined by the relevant contract.
Do not expose raw untrusted payloads or secrets in errors.

Use exhaustive TypeScript `switch` mappings with `assertNever`.
Do not infer a shared enum's meaning from a negative comparison.
Use exhaustive C# mappings without a default arm when possible.
Check unknown numeric enum values at the boundary.
Do not claim that an incomplete C# switch always fails compilation.

Market lifecycle and market outcome metadata have different authorities.
Follow `.claude/rules/server.md`.
Do not infer engine lifecycle from an absent mint attestation.

## Shared Ingress And User State

Reuse normalization and preflight logic across equivalent ingress paths.
Correct an in-scope divergence instead of copying it.
Route shared behavior through the SDK.
Do not let an untrusted mint URL silently change the active mint.
Use the client's approved mutation boundary and consent rules.

## Verification

Use real serialization and parser fixtures for changed wire behavior.
Test missing, unknown, and incorrectly cased values.
Mock network I/O in public TypeScript unit tests.
Use the approved integration harness when real-socket coverage is needed.

Read `bitCaster-app/package.json` for available checks.
The app has `lint:enum-discipline`, `lint:identity-ops`, and
`lint:wallet-ops` checks. Run the checks relevant to the change.
Do not assume a generic `npm run lint` command or an ESLint configuration.
Check generated output after regeneration.
Do not use a handwritten boundary catalogue as a second schema authority.
