import { Mint as CashuMint, OutputData, type SerializedBlindedMessage } from "@cashu/cashu-ts";
import {
  planCounterCtfRangePreparation,
  type PersistedCtfRangeOrderPreparationV2,
} from "@bitcaster/client-sdk/ctfRangeOrderProtocol";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import type { BrowserWalletCounterDexieStore } from "../stores/browser-wallet-counter-db";

/** One planned blinded output. Its amount can be stored as a number or a string. */
export interface BrowserProbeOutput {
  readonly amount: unknown;
  readonly id: string;
  readonly B_: string;
}

/**
 * Ask the mint with NUT-09 which of these exact blinded outputs it already
 * signed. Return their `B_` values. The mint sees the same outputs moments
 * later in the real request, so the probe adds no new privacy exposure.
 */
export type BrowserSignedOutputProbe = (
  mintUrl: string,
  outputs: readonly BrowserProbeOutput[],
) => Promise<ReadonlySet<string>>;

const PROBE_BATCH_MAX = 100;
const PROBE_ATTEMPTS_MAX = 8;

export const probeSignedBlindedOutputs: BrowserSignedOutputProbe = async (mintUrl, outputs) => {
  const mint = new CashuMint(mintUrl);
  const signed = new Set<string>();
  for (let start = 0; start < outputs.length; start += PROBE_BATCH_MAX) {
    const batch = outputs.slice(start, start + PROBE_BATCH_MAX);
    const response = await mint.restore({
      outputs: batch.map(
        ({ amount, id, B_ }) =>
          ({ amount: amountToNumber(amount), id, B_ }) as unknown as SerializedBlindedMessage,
      ),
    });
    const requested = new Set(batch.map(({ B_ }) => B_));
    for (const output of response.outputs) {
      // A restore response may only name outputs from this request.
      if (!requested.has(output.B_)) throw new Error("mint restore returned a foreign output");
      signed.add(output.B_);
    }
  }
  return signed;
};

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
 * the whole group. On a hit, scan past the mint's signed range and probe the
 * new range. Sells, consolidations, and refunds handle a reuse refusal instead.
 */
export async function probeBuyReceiveRange(input: {
  readonly scopeId: string;
  readonly counterStore: BrowserWalletCounterDexieStore;
  readonly preparation: PersistedCtfRangeOrderPreparationV2;
  readonly seed: Uint8Array;
  readonly probe: BrowserSignedOutputProbe;
  readonly cache: BuyReceiveProbeCache;
  readonly scanPastSignedOutputs: (
    keyset: PersistedCtfRangeOrderPreparationV2["receiveKeyset"],
  ) => Promise<void>;
}): Promise<void> {
  if (input.preparation.side !== "Buy") return;
  const keyset = input.preparation.receiveKeyset;
  const context = { mintUrl: input.preparation.mintUrl, unit: "msat" as const };
  const count = planCounterCtfRangePreparation(input.preparation).receiveCount;
  const key = JSON.stringify([input.scopeId, input.preparation.mintUrl, keyset.id]);
  for (let attempt = 0; attempt < PROBE_ATTEMPTS_MAX; attempt++) {
    const start =
      (await input.counterStore.readSnapshotInContext(context, keyset.id)).nextCounter ?? 0;
    if (input.cache.isClean(key, start, count)) return;
    // A NUT-13 blinded output does not depend on its amount.
    const outputs = Array.from(
      { length: count },
      (_, index) =>
        OutputData.createSingleDeterministicData(1, input.seed, start + index, keyset.id)
          .blindedMessage,
    );
    const signed = await input.probe(input.preparation.mintUrl, outputs);
    if (!outputs.some(({ B_ }) => signed.has(B_))) {
      input.cache.markClean(key, start, count);
      return;
    }
    await input.scanPastSignedOutputs(keyset);
  }
  throw new Error("browser CTF buy receive counters stay signed after repeated scans");
}
