import { Mint as CashuMint, type SerializedBlindedMessage } from "@cashu/cashu-ts";
import type {
  CtfRangePreparationIntent,
  PersistedCtfRangeOrderPreparationV2,
} from "@bitcaster/client-sdk/ctfRangeOrderProtocol";
import { reserveCheckedCtfRangeOrderPreparation } from "@bitcaster/client-sdk/ctfRangeOrderOutputCheck";
import type {
  SeedCounterRestoreClient,
  SeedCounterSkip,
} from "@bitcaster/client-sdk/seedCounterGapScan";
import type {
  BrowserCtfPreparationReservationResult,
  BrowserWalletCounterDexieStore,
} from "../stores/browser-wallet-counter-db";

type OrderKeyset = PersistedCtfRangeOrderPreparationV2["offerKeyset"];

/** The NUT-09 client of one mint for counter-only checks. */
export function browserSeedCounterRestoreClient(mintUrl: string): SeedCounterRestoreClient {
  const mint = new CashuMint(mintUrl);
  return {
    restore: async ({ outputs }: { outputs: SerializedBlindedMessage[] }) =>
      mint.restore({ outputs }),
  };
}

/**
 * Check every output of a new Buy or Sell order with the mint, then reserve
 * its counters at the checked starts (ADR-037 reused-output amendment,
 * decision 14). Another client of this seed can already hold signed outputs
 * at these counters. The SDK skips past them through `skipSignedCounters`,
 * which also records where a later pass admits them (ADR-033).
 */
export async function reserveCheckedBrowserCtfRangePreparation(input: {
  readonly counterStore: BrowserWalletCounterDexieStore;
  readonly preparation: PersistedCtfRangeOrderPreparationV2;
  readonly intent: CtfRangePreparationIntent;
  readonly seed: Uint8Array;
  readonly mint: SeedCounterRestoreClient;
  readonly createdAtMs: number;
  readonly skipSignedCounters: (keyset: OrderKeyset, skip: SeedCounterSkip) => Promise<void>;
}): Promise<BrowserCtfPreparationReservationResult> {
  const { offerKeyset, receiveKeyset } = input.preparation;
  const context = { mintUrl: input.preparation.mintUrl, unit: "msat" as const };
  const readNextCounter = async (keysetId: string) =>
    (await input.counterStore.readSnapshotInContext(context, keysetId)).nextCounter ?? 0;
  return reserveCheckedCtfRangeOrderPreparation({
    mint: input.mint,
    seed: input.seed,
    preparation: input.preparation,
    intent: input.intent,
    readCounterStarts: async () => ({
      offer: await readNextCounter(offerKeyset.id),
      receive: await readNextCounter(receiveKeyset.id),
    }),
    skipSignedCounters: (skip) =>
      input.skipSignedCounters(
        skip.keysetId === offerKeyset.id ? offerKeyset : receiveKeyset,
        skip,
      ),
    reserve: (counterStarts) =>
      input.counterStore.reserveCtfPreparationInContext({
        context,
        preparation: input.preparation,
        intent: input.intent,
        seed: input.seed,
        createdAtMs: input.createdAtMs,
        counterStarts,
      }),
  });
}
