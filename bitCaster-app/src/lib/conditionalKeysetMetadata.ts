import type { Proof } from "@cashu/cashu-ts";
import { normalizeMarketBaseAsset } from "@bitcaster/client-sdk/marketUnits";
import { normalizeUrl } from "@/lib/url";
import type { StoredProof } from "@/stores/proof-db";

export interface ConditionalProofMetadata {
  conditionId: string;
  outcomeCollection: string;
  marketId: string;
}

interface ConditionalKeysetInfo {
  id: string;
  condition_id: string;
  outcome_collection: string;
  outcome_collection_id: string;
}

interface ConditionalKeysetsResponse {
  keysets?: ConditionalKeysetInfo[];
}

const cache = new Map<string, Promise<Map<string, ConditionalKeysetInfo>>>();

export async function resolveConditionalProofMetadata(
  mintUrl: string,
  proof: Proof,
  expectedConditionId?: string,
): Promise<ConditionalProofMetadata> {
  if (!proof.id) {
    throw new Error("Conditional proof is missing keyset id");
  }
  const registry = await conditionalKeysetRegistry(mintUrl);
  const keyset = registry.get(proof.id);
  if (!keyset) {
    throw new Error(`Conditional keyset ${proof.id} is not known by the mint`);
  }
  if (
    expectedConditionId &&
    keyset.condition_id.toLowerCase() !== expectedConditionId.toLowerCase()
  ) {
    throw new Error(
      `Conditional keyset ${proof.id} belongs to condition ${keyset.condition_id}, expected ${expectedConditionId}`,
    );
  }
  return {
    conditionId: keyset.condition_id,
    outcomeCollection: keyset.outcome_collection,
    marketId: `${keyset.condition_id}-${keyset.outcome_collection}`,
  };
}

export async function storedConditionalProofsFromMintMetadata(input: {
  mintUrl: string;
  proofs: Proof[];
  expectedConditionId?: string;
  reservedBy?: string;
  baseAsset?: string | null;
}): Promise<StoredProof[]> {
  const out: StoredProof[] = [];
  const baseAsset = normalizeMarketBaseAsset(input.baseAsset);
  for (const proof of input.proofs) {
    const metadata = await resolveConditionalProofMetadata(
      input.mintUrl,
      proof,
      input.expectedConditionId,
    );
    out.push({
      ...proof,
      ...metadata,
      mintUrl: input.mintUrl,
      reservedBy: input.reservedBy,
      baseAsset,
    });
  }
  return out;
}

export async function proofsWithOptionalConditionalMetadata(input: {
  mintUrl: string;
  proofs: Proof[];
}): Promise<Proof[]> {
  const registry = await tryConditionalKeysetRegistry(input.mintUrl);
  if (!registry) return input.proofs;

  return input.proofs.map((proof) => {
    if (!proof.id) return proof;
    const keyset = registry.get(proof.id);
    if (!keyset) return proof;
    return {
      ...proof,
      conditionId: keyset.condition_id,
      outcomeCollection: keyset.outcome_collection,
      marketId: `${keyset.condition_id}-${keyset.outcome_collection}`,
    };
  });
}

async function conditionalKeysetRegistry(
  mintUrl: string,
): Promise<Map<string, ConditionalKeysetInfo>> {
  const normalized = normalizeUrl(mintUrl);
  let existing = cache.get(normalized);
  if (!existing) {
    existing = fetchConditionalKeysets(normalized).catch((error) => {
      cache.delete(normalized);
      throw error;
    });
    cache.set(normalized, existing);
  }
  return existing;
}

async function tryConditionalKeysetRegistry(
  mintUrl: string,
): Promise<Map<string, ConditionalKeysetInfo> | null> {
  try {
    return await conditionalKeysetRegistry(mintUrl);
  } catch {
    return null;
  }
}

async function fetchConditionalKeysets(
  mintUrl: string,
): Promise<Map<string, ConditionalKeysetInfo>> {
  const response = await fetch(`${mintUrl}/v1/conditional_keysets`);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch conditional keysets from mint: HTTP ${response.status}`,
    );
  }
  const body = (await response.json()) as ConditionalKeysetsResponse;
  return new Map((body.keysets ?? []).map((keyset) => [keyset.id, keyset]));
}
