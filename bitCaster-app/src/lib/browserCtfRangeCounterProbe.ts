import { Mint as CashuMint, type SerializedBlindedMessage } from "@cashu/cashu-ts";
import {
  createCounterCtfRangePreparation,
  reconstructCtfRangePreparation,
  type CtfRangePreparationIntent,
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
 * Advance the offer and receive counters past every planned manifest output
 * that the mint already signed, before the preparation reserves them. Another
 * client with the same seed can have used these counters.
 */
export async function advanceCtfRangePreparationPastSignedOutputs(input: {
  readonly counterStore: BrowserWalletCounterDexieStore;
  readonly preparation: PersistedCtfRangeOrderPreparationV2;
  readonly intent: CtfRangePreparationIntent;
  readonly seed: Uint8Array;
  readonly probe: BrowserSignedOutputProbe;
}): Promise<void> {
  const context = { mintUrl: input.preparation.mintUrl, unit: "msat" as const };
  const offerKeysetId = input.preparation.offerKeyset.id;
  const receiveKeysetId = input.preparation.receiveKeyset.id;
  for (let attempt = 0; attempt < PROBE_ATTEMPTS_MAX; attempt++) {
    const [offer, receive] = await Promise.all([
      input.counterStore.readSnapshotInContext(context, offerKeysetId),
      input.counterStore.readSnapshotInContext(context, receiveKeysetId),
    ]);
    const receipt = createCounterCtfRangePreparation({
      preparation: input.preparation,
      intent: input.intent,
      seed: input.seed,
      offerCounterStart: offer.nextCounter ?? 0,
      receiveCounterStart: receive.nextCounter ?? 0,
    });
    const entries = reconstructCtfRangePreparation(receipt, input.seed).manifest.entries;
    const signed = await input.probe(
      input.preparation.mintUrl,
      entries.map(({ outputData }) => outputData.blindedMessage),
    );
    const signedKeysets = new Set(
      entries
        .filter(({ outputData }) => signed.has(outputData.blindedMessage.B_))
        .map(({ outputData }) => outputData.blindedMessage.id),
    );
    if (signedKeysets.size === 0) return;
    // Skip each touched range as a whole. A later probe checks the next range.
    if (signedKeysets.has(receiveKeysetId)) {
      await input.counterStore.advanceToAtLeastInContext(
        context,
        receiveKeysetId,
        receipt.receiveCounterStart + receipt.receiveCounterCount,
        true,
      );
    }
    if (signedKeysets.has(offerKeysetId)) {
      await input.counterStore.advanceToAtLeastInContext(
        context,
        offerKeysetId,
        receipt.offerCounterStart + receipt.offerCounterCount,
        true,
      );
    }
  }
  throw new Error("browser CTF preparation counters stay signed after repeated advances");
}
