import type { CashuWallet, Proof } from "@cashu/cashu-ts";
import {
  prepareDeterministicOutgoingCashuSend,
  type DeterministicOutgoingCashuWallet,
} from "@bitcaster/client-sdk/deterministicOutgoingCashuPreparation";
import { serializeDurableWalletSendOperation } from "@bitcaster/client-sdk/durableWalletOperation";
import type { DurableWalletProofDerivationLocator } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { createSpeculativeCounterTranscript } from "@bitcaster/client-sdk/speculativeCounterTranscript";
import { assertCanonicalNut02V2KeysetId } from "@bitcaster/client-sdk/durableSeedDerivedOutputs";
import { restoreExactMintOutputs } from "@/lib/cashu";
import { browserWalletScope } from "./browserCtfRangeOrderSource";
import {
  BrowserWalletCounterDexieStore,
  type BrowserWalletCounterContext,
} from "../stores/browser-wallet-counter-db";
import { db, type BitcasterDB } from "../stores/proof-db";
import { createUncachedWalletForSeedUnit } from "../stores/wallet";
import { bindBrowserOutgoingCounterPreparation } from "./browserOutgoingCounterPreparation";

export type BrowserDeterministicOutgoingCashuWallet = DeterministicOutgoingCashuWallet;

/** Prepare one V2 deterministic send plan and retain only exact keep-output locators. */
export async function prepareBrowserDeterministicOutgoingCashuSend(input: {
  readonly operationId: string;
  readonly amount: number;
  readonly proofs: readonly Proof[];
  readonly mintUrl: string;
  readonly unit: string;
  readonly seed: Uint8Array;
  readonly wallet: BrowserDeterministicOutgoingCashuWallet;
  readonly database?: BitcasterDB;
  readonly requireCapturedProfile: () => void;
  readonly keepProofDerivationLocators: Array<DurableWalletProofDerivationLocator | null>;
  readonly diagnosticLabel: string;
}) {
  const database = input.database ?? db;
  const scope = browserWalletScope(input.seed);
  const selected = input.wallet.getKeyset();
  try {
    assertCanonicalNut02V2KeysetId(selected.id);
  } catch {
    throw new Error(`${input.diagnosticLabel} requires a canonical V2 keyset`);
  }
  const counterContext: BrowserWalletCounterContext = {
    mintUrl: input.mintUrl,
    unit: input.unit,
  };
  const counterStore = new BrowserWalletCounterDexieStore({
    database,
    scopeId: scope.scopeId,
    isCurrentProfile: () => {
      input.requireCapturedProfile();
      return true;
    },
  });
  const transcript = createSpeculativeCounterTranscript([
    await counterStore.readSnapshotInContext(counterContext, selected.id),
  ]);
  const draftWallet = await createUncachedWalletForSeedUnit({
    mintUrl: input.mintUrl,
    unit: input.unit,
    seed: input.seed,
    scopeId: scope.scopeId,
    database,
    requireCapturedProfile: input.requireCapturedProfile,
    counterSource: transcript.counterSource,
  });
  const pinned = draftWallet.getKeyset(selected.id);
  if (pinned.id !== selected.id || !pinned.verify()) {
    throw new Error(`${input.diagnosticLabel} pinned output keyset changed`);
  }
  const prepared = await prepareDeterministicOutgoingCashuSend({ ...input, wallet: draftWallet });
  const allocation = transcript.allocations();
  if (
    allocation.length !== 1 ||
    allocation[0]!.keysetId !== prepared.counters.keysetId ||
    allocation[0]!.start !== prepared.counters.start ||
    allocation[0]!.count !== prepared.counters.count
  ) {
    throw new Error(`${input.diagnosticLabel} counter transcript conflicts with its output plan`);
  }
  input.keepProofDerivationLocators.splice(
    0,
    input.keepProofDerivationLocators.length,
    ...prepared.keepProofDerivationLocators,
  );
  const operation = serializeDurableWalletSendOperation({
    operationId: input.operationId,
    mintUrl: input.mintUrl,
    unit: input.unit,
    preview: prepared.preview,
  });
  bindBrowserOutgoingCounterPreparation(operation, {
    transcript,
    counterStore,
    counterContext,
  });
  return operation;
}

/** Restore and preserve the exact persisted keep/send output order. */
export async function restoreBrowserDeterministicOutgoingCashuOutputs(input: {
  readonly wallet: CashuWallet;
  readonly restore: {
    readonly mintUrl: string;
    readonly unit: string;
    readonly outputs: {
      readonly keep: Parameters<typeof restoreExactMintOutputs>[1]["outputs"];
      readonly send: Parameters<typeof restoreExactMintOutputs>[1]["outputs"];
    };
  };
  readonly diagnosticLabel: string;
}) {
  const outputs = [...input.restore.outputs.keep, ...input.restore.outputs.send];
  const restored = await restoreExactMintOutputs(input.wallet, {
    mintUrl: input.restore.mintUrl,
    unit: input.restore.unit,
    outputs,
  });
  if (restored.length !== outputs.length) {
    throw new Error(`${input.diagnosticLabel} restored output set is incomplete`);
  }
  return {
    keep: restored.slice(0, input.restore.outputs.keep.length),
    send: restored.slice(input.restore.outputs.keep.length),
  };
}
