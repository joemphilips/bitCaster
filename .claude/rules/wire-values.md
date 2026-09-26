---
paths:
  - "BitCaster.MatchingEngine.Contracts/**/*"
  - "bitCaster-app/src/**/*"
  - "bitcaster-client-sdk/src/**/*"
  - "bitcaster-daemon/src/**/*"
  - "bitcaster-cli/src/**/*"
---

# Shared Wire Values

These rules apply to values that cross a wire boundary. Code comments cite
them by number.

1. `BitCaster.MatchingEngine.Contracts/specs/openapi.yaml` is the source of
   truth for HTTP schemas and the enums that this project owns. Do not
   hand-write TypeScript unions that duplicate generated API enum types. Do not
   hand-edit generated DTOs. After a spec edit, run
   `dotnet build BitCaster.MatchingEngine.Contracts/` and then
   `cd bitCaster-app && npm run generate:api`.
2. Normalize an untrusted upstream value once at ingress. Keep one canonical
   form. Do not repair casing with ad hoc conversions at call sites. Validate
   missing and unknown values before you treat them as a generated type.
3. Use an exhaustive `switch` with `assertNever` in TypeScript. Use a C# switch
   expression without a default arm when possible. Do not compare a shared enum
   with a negative comparison such as `state !== "open"`.
   `npm run lint:enum-discipline` enforces this rule in `bitCaster-app/`.
4. Reuse one normalization and preflight path for equivalent ingress paths.
   Put shared logic in `bitcaster-client-sdk/`.
5. Do not let an untrusted mint URL change the active mint.

Verify changed wire behavior with real serialization and parser fixtures. Test
missing, unknown, and incorrectly cased values. Mock network I/O in public
TypeScript unit tests.
