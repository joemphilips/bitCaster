import type { CashuWallet, Proof } from "@cashu/cashu-ts";
import {
  prepareDeterministicOutgoingCashuSend,
  type DeterministicOutgoingCashuWallet,
} from "@bitcaster/client-sdk/deterministicOutgoingCashuPreparation";
import { serializeDurableWalletSendOperation } from "@bitcaster/client-sdk/durableWalletOperation";
import type { DurableWalletProofDerivationLocator } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { restoreExactMintOutputs } from "@/lib/cashu";

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
  readonly keepProofDerivationLocators: Array<DurableWalletProofDerivationLocator | null>;
  readonly diagnosticLabel: string;
}) {
  const prepared = await prepareDeterministicOutgoingCashuSend(input);
  input.keepProofDerivationLocators.splice(
    0,
    input.keepProofDerivationLocators.length,
    ...prepared.keepProofDerivationLocators,
  );
  return serializeDurableWalletSendOperation({
    operationId: input.operationId,
    mintUrl: input.mintUrl,
    unit: input.unit,
    preview: prepared.preview,
  });
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
