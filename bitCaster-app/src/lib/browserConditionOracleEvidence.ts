import type { RedeemWallet } from "@bitcaster/client-sdk/ctfRedeem";
import { createConditionOracleEvidenceResolver } from "@bitcaster/client-sdk/conditionOracleEvidence";
import { readAllocationBoundedJsonResponse } from "@bitcaster/client-sdk/boundedJsonResponse";
import { CONDITION_ATTESTATION_RESPONSE_BYTES_MAX } from "@bitcaster/client-sdk/engineClient";
import type { ManagedConditionInventoryBinding } from "@bitcaster/client-sdk/managedConditionInventory";

export function createBrowserConditionOracleEvidenceResolver(fetchResponse: typeof fetch = fetch) {
  const resolver = createConditionOracleEvidenceResolver();
  return async (input: {
    readonly binding: ManagedConditionInventoryBinding;
    readonly wallet: RedeemWallet;
  }) => {
    const signal = AbortSignal.timeout(5_000);
    const fetchAttestation = async () => {
      const response = await fetchResponse(
        `/api/v1/conditions/${encodeURIComponent(input.binding.conditionId)}/attestation`,
        { headers: { accept: "application/json" }, signal },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Intended condition registration is unavailable");
      }
      const raw = await readAllocationBoundedJsonResponse(
        response,
        CONDITION_ATTESTATION_RESPONSE_BYTES_MAX,
      );
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error("Intended condition registration is invalid");
      }
      const body = raw as Record<string, unknown>;
      if (body.conditionId !== input.binding.conditionId) {
        throw new Error("Intended condition registration is foreign");
      }
      return body;
    };
    return resolver.resolveFromMint({
      binding: input.binding,
      fetchInitialAttestation: fetchAttestation,
      fetchRegisteredAuthority: async () => (await fetchAttestation()).registeredAuthority,
      fetchConditionInfo: (includeOracleSigs) => {
        const getCondition = input.wallet.mint?.getCtfCondition;
        if (getCondition === undefined) {
          throw new Error("Mint condition evidence is unavailable");
        }
        return getCondition.call(input.wallet.mint, input.binding.conditionId, undefined, {
          include_oracle_sigs: includeOracleSigs,
          signal,
        });
      },
    });
  };
}

export const resolveBrowserConditionOracleEvidence = createBrowserConditionOracleEvidenceResolver();
