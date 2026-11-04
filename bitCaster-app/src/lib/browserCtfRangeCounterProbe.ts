import { Mint as CashuMint, type SerializedBlindedMessage } from "@cashu/cashu-ts";
import {
  planCounterCtfRangePreparation,
  type PersistedCtfRangeOrderPreparationV2,
} from "@bitcaster/client-sdk/ctfRangeOrderProtocol";
import {
  probeSeedCounterRangeBeforeReservation,
  type SeedCounterRestoreClient,
} from "@bitcaster/client-sdk/seedCounterGapScan";
import type { BrowserWalletCounterDexieStore } from "../stores/browser-wallet-counter-db";

/** The NUT-09 client of one mint for counter-only probes. */
export function browserSeedCounterRestoreClient(mintUrl: string): SeedCounterRestoreClient {
  const mint = new CashuMint(mintUrl);
  return {
    restore: async ({ outputs }: { outputs: SerializedBlindedMessage[] }) =>
      mint.restore({ outputs }),
  };
}

/**
 * Remembers a clean probe of one receive counter range. The submit reuses the
 * preview's probe while the cursor stays where the preview saw it.
 */
export interface BuyReceiveProbeCache {
  isClean(key: string, nextCounter: number, count: number): boolean;
  markClean(key: string, nextCounter: number, count: number): void;
}

const PROBE_CACHE_LIMIT = 64;

export function createBuyReceiveProbeCache(): BuyReceiveProbeCache {
  const clean = new Map<string, { nextCounter: number; count: number }>();
  return {
    isClean: (key, nextCounter, count) => {
      const entry = clean.get(key);
      return entry !== undefined && entry.nextCounter === nextCounter && entry.count >= count;
    },
    markClean: (key, nextCounter, count) => {
      clean.delete(key);
      clean.set(key, { nextCounter, count });
      while (clean.size > PROBE_CACHE_LIMIT) {
        const oldest = clean.keys().next().value;
        if (oldest === undefined) break;
        clean.delete(oldest);
      }
    },
  };
}

/**
 * Before a buy reserves its receive counters, ask the mint with NUT-09 whether
 * another client with the same seed already signed those outputs. The engine
 * signs receive outputs in a group convert, where one reused output rejects
 * the whole group. The SDK probe scans past the mint's signed range with a
 * work bound and probes the new range. Sells, consolidations, and refunds
 * handle a reuse refusal instead.
 */
export async function probeBuyReceiveRange(input: {
  readonly scopeId: string;
  readonly counterStore: BrowserWalletCounterDexieStore;
  readonly preparation: PersistedCtfRangeOrderPreparationV2;
  readonly seed: Uint8Array;
  readonly mint: SeedCounterRestoreClient;
  readonly cache: BuyReceiveProbeCache;
  /**
   * Advances the cursor to `nextCounter`, past the mint's signed outputs.
   * `fromCounter` is the start of the probed range, so a later pass admits
   * the signed outputs.
   */
  readonly advancePastSignedOutputs: (
    keyset: PersistedCtfRangeOrderPreparationV2["receiveKeyset"],
    fromCounter: number,
    nextCounter: number,
  ) => Promise<void>;
}): Promise<void> {
  if (input.preparation.side !== "Buy") return;
  const keyset = input.preparation.receiveKeyset;
  const context = { mintUrl: input.preparation.mintUrl, unit: "msat" as const };
  const count = planCounterCtfRangePreparation(input.preparation).receiveCount;
  const key = JSON.stringify([input.scopeId, input.preparation.mintUrl, keyset.id]);
  const readNextCounter = async () =>
    (await input.counterStore.readSnapshotInContext(context, keyset.id)).nextCounter ?? 0;
  let probedFrom = await readNextCounter();
  if (input.cache.isClean(key, probedFrom, count)) return;
  await probeSeedCounterRangeBeforeReservation({
    mint: input.mint,
    seed: input.seed,
    keysetId: keyset.id,
    count,
    readNextCounter: async () => {
      probedFrom = await readNextCounter();
      return probedFrom;
    },
    advanceCounterTo: (nextCounter) =>
      input.advancePastSignedOutputs(keyset, probedFrom, nextCounter),
  });
  input.cache.markClean(key, probedFrom, count);
}
