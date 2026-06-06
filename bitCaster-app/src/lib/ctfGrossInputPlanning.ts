import type { MintKeys } from "@cashu/cashu-ts";
import type { CtfGrossInputPlanningKeyset } from "@/lib/ctfSplit";

interface GrossInputPlanningWallet {
  keysetId?: string;
  getKeyset?: () => { id?: string };
  mint?: {
    getKeys(keysetId?: string): Promise<{ keysets: MintKeys[] }>;
  };
}

export async function resolveGrossCtfInputPlanningKeyset(
  wallet: GrossInputPlanningWallet,
): Promise<CtfGrossInputPlanningKeyset> {
  const keysetId = readActiveKeysetId(wallet);
  if (!keysetId) {
    throw new Error("Cashu wallet did not expose an active keyset id");
  }
  if (!wallet.mint?.getKeys) {
    throw new Error("Cashu wallet does not expose mint key loading");
  }

  const response = await wallet.mint.getKeys(keysetId);
  const keyset = response.keysets.find((candidate) => candidate.id === keysetId);
  if (!keyset) {
    throw new Error(`Mint did not return keys for keyset ${keysetId}`);
  }
  return {
    id: keyset.id,
    keys: keyset.keys,
    input_fee_ppk: keyset.input_fee_ppk ?? 0,
  };
}

function readActiveKeysetId(wallet: GrossInputPlanningWallet): string | null {
  try {
    if (wallet.keysetId) return wallet.keysetId;
  } catch {
    // Fall back to getKeyset below; cashu-ts exposes keysetId as a throwing getter.
  }

  try {
    return wallet.getKeyset?.().id ?? null;
  } catch {
    return null;
  }
}
