/**
 * Shared NUT-CTF redeem helpers.
 *
 * The mint is the sole authority that can condemn an outcome-token leg. The
 * terminal CDK error code below means the keyset's outcome collection does not
 * include the oracle-attested outcome.
 */
export const ORACLE_NOT_ATTESTED_OUTCOME_CODE = 13015;

export function isLosingLegError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const e = error as { code?: unknown };
    if (
      typeof e.code === "number" &&
      e.code === ORACLE_NOT_ATTESTED_OUTCOME_CODE
    ) {
      return true;
    }
  }
  return false;
}
