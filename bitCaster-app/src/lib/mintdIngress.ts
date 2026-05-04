import { assertNever } from './enumDiscipline'

/**
 * Canonical wire form of mintd's `attestation.status` field, normalised once
 * at the ingress boundary. Mintd is upstream and not under our OpenAPI spec
 * (per `bitcaster-coding-guideline` Rule 1 the spec is the single source of
 * truth only for enums we own). Treat any value coming out of `/v1/conditions`
 * as a raw string at the boundary, normalise it through this module, then
 * compare against this union — never compare a raw mintd value past ingress.
 *
 * Per ADR-009 (and Phase 2 of the P7 staging-fix plan) the detail page no
 * longer reads this union to decide market lifecycle (Open / Closed) — that
 * authority lives on the engine `MarketState`. This union is reduced to
 * "outcome metadata" — which outcome the oracle attested, when, and whether
 * the announcement window expired without a resolution. The fields stay so
 * the resolution-info panel can surface them.
 */
export type AttestationStatus = 'pending' | 'attested' | 'expired' | 'violation'

/**
 * Normalise a raw mintd `attestation.status` string into the canonical
 * `AttestationStatus` union. Implements `bitcaster-coding-guideline` Rule 2:
 * one canonical wire form, normalised at the boundary, never paved over with
 * `.toLowerCase()` at call sites.
 *
 *  - `null` / `undefined` → `'pending'`. A fresh market with no oracle
 *    attestation yet has no `attestation` object on mintd's response; the
 *    consumer-facing meaning is "the oracle has not spoken", which is the
 *    `pending` semantic.
 *  - Whitespace and casing variants normalise to the lowercase canonical
 *    form (mintd ships `pending|attested|expired|violation`; defensive
 *    against future drift).
 *  - Anything else throws so a producer-side regression surfaces loudly
 *    rather than silently flipping a downstream branch.
 */
export function normalizeMintdStatus(raw: unknown): AttestationStatus {
  if (raw == null) return 'pending'
  const s = String(raw).toLowerCase().trim()
  switch (s) {
    case 'pending':   return 'pending'
    case 'attested':  return 'attested'
    case 'expired':   return 'expired'
    case 'violation': return 'violation'
    default:
      throw new Error(`unknown mintd attestation status: ${JSON.stringify(raw)}`)
  }
}

/**
 * Convenience predicate for "has the oracle resolved this market?" — the
 * semantic the resolution-info badge cares about. Unlike a negative
 * comparison (`status !== 'pending'`, which silently reads `true` for
 * `undefined`), this is a total mapping: every input variant is either
 * resolved or not, and the compiler enforces exhaustiveness.
 */
export function isAttestationResolved(s: AttestationStatus): boolean {
  switch (s) {
    case 'pending':   return false
    case 'attested':  return true
    case 'expired':   return true
    case 'violation': return true
    default:          return assertNever(s)
  }
}
