import type {
  CashuWallet,
  OperationCounters,
  OutputData,
  Proof,
  SwapPreview,
} from "@cashu/cashu-ts";
import { locateSeedDerivedProofLineage } from "@bitcaster/client-sdk/durableSeedDerivedProofLineage";
import { serializeDurableWalletSendOperation } from "@bitcaster/client-sdk/durableWalletOperation";
import type { DurableWalletProofDerivationLocator } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { restoreExactMintOutputs } from "@/lib/cashu";

export interface BrowserDeterministicOutgoingCashuWallet {
  prepareSwapToSend(
    amount: number,
    proofs: Proof[],
    config: {
      includeFees: false;
      keysetId: string;
      onCountersReserved: (counters: OperationCounters) => void;
    },
    outputConfig: {
      send: { type: "deterministic"; counter: 0 };
      keep: { type: "deterministic"; counter: 0 };
    },
  ): Promise<SwapPreview>;
  getKeyset(keysetId?: string): { id: string };
}

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
  const keysetId = requireCanonicalV2Keyset(input);
  const { preview, counters } = await prepareDeterministicPreview(input, keysetId);
  assertExactOutputPlan(input.diagnosticLabel, preview, counters);
  replaceKeepProofDerivationLocators(input, preview, counters);
  return serializeDurableWalletSendOperation({
    operationId: input.operationId,
    mintUrl: input.mintUrl,
    unit: input.unit,
    preview,
  });
}

function requireCanonicalV2Keyset(input: {
  readonly amount: number;
  readonly wallet: BrowserDeterministicOutgoingCashuWallet;
  readonly diagnosticLabel: string;
}): string {
  if (!Number.isSafeInteger(input.amount) || input.amount < 1) {
    throw new Error(`${input.diagnosticLabel} amount is invalid`);
  }
  const keysetId = input.wallet.getKeyset().id;
  if (!/^01[0-9a-f]{64}$/.test(keysetId)) {
    throw new Error(`${input.diagnosticLabel} requires a canonical V2 keyset`);
  }
  return keysetId;
}

async function prepareDeterministicPreview(
  input: Parameters<typeof prepareBrowserDeterministicOutgoingCashuSend>[0],
  keysetId: string,
): Promise<{ readonly preview: SwapPreview; readonly counters: OperationCounters }> {
  const counters: { value: OperationCounters | null } = { value: null };
  const preview = await input.wallet.prepareSwapToSend(
    input.amount,
    input.proofs as Proof[],
    {
      includeFees: false,
      keysetId,
      onCountersReserved: (reserved) => {
        if (counters.value !== null) {
          throw new Error(`${input.diagnosticLabel} output counters were reserved twice`);
        }
        counters.value = reserved;
      },
    },
    {
      send: { type: "deterministic", counter: 0 },
      keep: { type: "deterministic", counter: 0 },
    },
  );
  if (counters.value === null || counters.value.keysetId !== preview.keysetId) {
    throw new Error(`${input.diagnosticLabel} output counter reservation is missing`);
  }
  return { preview, counters: counters.value };
}

function assertExactOutputPlan(
  diagnosticLabel: string,
  preview: SwapPreview,
  counters: OperationCounters,
): void {
  const outputs = [...(preview.sendOutputs ?? []), ...(preview.keepOutputs ?? [])];
  if (outputs.length !== counters.count) {
    throw new Error(`${diagnosticLabel} output counter reservation conflicts with the output plan`);
  }
}

function replaceKeepProofDerivationLocators(
  input: Parameters<typeof prepareBrowserDeterministicOutgoingCashuSend>[0],
  preview: SwapPreview,
  counters: OperationCounters,
): void {
  const outputs = [...(preview.sendOutputs ?? []), ...(preview.keepOutputs ?? [])];
  const lineage = locateSeedDerivedProofLineage({
    seed: input.seed,
    keysetId: counters.keysetId,
    counterStart: counters.start,
    counterCount: counters.count,
    proofs: outputs.map(outputProofLineage),
  });
  const locators = new Map(lineage.map(({ secret, ...locator }) => [secret, locator]));
  input.keepProofDerivationLocators.splice(
    0,
    input.keepProofDerivationLocators.length,
    ...(preview.keepOutputs ?? []).map((output) => {
      const locator = locators.get(outputProofLineage(output).secret);
      if (locator === undefined) {
        throw new Error(`${input.diagnosticLabel} keep output locator is missing`);
      }
      return locator;
    }),
  );
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

function outputProofLineage(output: OutputData): { readonly id: string; readonly secret: string } {
  return { id: output.blindedMessage.id, secret: new TextDecoder().decode(output.secret) };
}
