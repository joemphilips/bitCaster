import type { Proof, ProofState, Wallet as CashuWallet } from "@cashu/cashu-ts";
import type { CashuProofUnit } from "@bitcaster/client-sdk/marketUnits";
import { useWalletStore } from "@/stores/wallet";

const LOCAL_STORAGE_FLAG = "bitcaster.cashuProofDiagnostics";
const STAGING_DIAGNOSTIC_HOSTNAMES = new Set(["frontend-bitcaster-staging.azurewebsites.net"]);

export interface ProofStateDiagnosticSummary {
  enabled: boolean;
  label: string;
  mintUrl: string;
  proofCount: number;
  keysetIds: string[];
  stateCounts: Record<string, number>;
}

export function isProofDiagnosticsEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  if (typeof window === "undefined") return false;
  try {
    if (window.localStorage.getItem(LOCAL_STORAGE_FLAG) === "1") return true;
  } catch {
    // Ignore storage access failures, e.g. private browsing restrictions.
  }
  return STAGING_DIAGNOSTIC_HOSTNAMES.has(window.location.hostname);
}

export async function diagnoseProofStates(input: {
  label: string;
  mintUrl: string;
  proofs: Proof[];
  unit: CashuProofUnit;
  wallet?: Pick<CashuWallet, "checkProofsStates"> | null;
  extra?: Record<string, unknown>;
}): Promise<ProofStateDiagnosticSummary | null> {
  if (!isProofDiagnosticsEnabled()) return null;

  const proofCount = input.proofs.length;
  const keysetIds = Array.from(
    new Set(input.proofs.map((proof) => proof.id).filter(Boolean)),
  ).sort();

  const base = {
    label: input.label,
    mintUrl: input.mintUrl,
    proofCount,
    keysetIds,
    ...(input.extra ? { extra: input.extra } : {}),
  };

  if (proofCount === 0) {
    const summary = { ...base, enabled: true, stateCounts: {} };
    console.info("[cashu.proof-diagnostics]", summary);
    return summary;
  }

  try {
    const wallet =
      input.wallet ?? (await useWalletStore.getState().getWalletForUnit(input.mintUrl, input.unit));
    if (!wallet.checkProofsStates) {
      const summary = {
        ...base,
        enabled: true,
        stateCounts: {},
        unsupported: true,
      };
      console.info("[cashu.proof-diagnostics]", summary);
      return summary;
    }

    const states = await wallet.checkProofsStates(
      input.proofs.map(({ id, secret }) => ({ id, secret })),
    );
    const stateCounts = countStates(states);
    const summary = { ...base, enabled: true, stateCounts };
    console.info("[cashu.proof-diagnostics]", summary);
    return summary;
  } catch (error) {
    console.warn("[cashu.proof-diagnostics]", {
      ...base,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function countStates(states: ProofState[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const state of states) {
    counts[state.state] = (counts[state.state] ?? 0) + 1;
  }
  return counts;
}
