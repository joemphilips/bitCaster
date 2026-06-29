import type { Proof } from "@cashu/cashu-ts";
import type { CtfConditionalKeysetInfo } from "./ctfSplit.ts";
import type { ConditionalKeysetTransport } from "./conditionalKeysets.ts";
import { getConditionalKeysets } from "./conditionalKeysets.ts";

export interface ProofUnitMintSource {
  getKeySets(): Promise<{
    keysets: Array<{ id: string; unit?: string | null }>;
  }>;
}

export interface ResolveProofUnitOptions {
  conditionalKeysets?: CtfConditionalKeysetInfo[];
  conditionalKeysetTransport?: ConditionalKeysetTransport;
  mintUrl?: string;
  cacheKey?: string;
}

export async function resolveProofUnit(
  mint: ProofUnitMintSource,
  proofs: readonly Pick<Proof, "id">[],
  options: ResolveProofUnitOptions = {},
): Promise<string> {
  if (proofs.length === 0) return "sat";

  const keysetIds = [...new Set(proofs.map((proof) => proof.id))];
  const missingIds = keysetIds.filter((keysetId) => !keysetId);
  if (missingIds.length > 0) {
    throw new Error("Proof set contains proof(s) missing keyset id");
  }

  const { keysets } = await mint.getKeySets();
  const unitByKeysetId = new Map<string, string>();
  for (const keyset of keysets) {
    if (keyset.unit) unitByKeysetId.set(keyset.id, keyset.unit);
  }

  const missingFromRegular = keysetIds.filter((keysetId) => !unitByKeysetId.has(keysetId));
  if (missingFromRegular.length > 0) {
    const conditionalKeysets = options.conditionalKeysets ??
      (options.conditionalKeysetTransport
        ? await getConditionalKeysets({
            transport: options.conditionalKeysetTransport,
            mintUrl: options.mintUrl,
            cacheKey: options.cacheKey,
          })
        : []);
    for (const keyset of conditionalKeysets) {
      if (keyset.unit) unitByKeysetId.set(keyset.id, keyset.unit);
    }
  }

  const units = new Set<string>();
  const missing: string[] = [];
  for (const keysetId of keysetIds) {
    const unit = unitByKeysetId.get(keysetId);
    if (!unit) {
      missing.push(keysetId);
    } else {
      units.add(unit);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Mint did not return unit metadata for proof keyset(s): ${missing.join(", ")}`);
  }
  if (units.size !== 1) {
    throw new Error(`Proof set contains mixed units: ${[...units].sort().join(", ")}`);
  }
  return [...units][0]!;
}
