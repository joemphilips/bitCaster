import {
  deriveMarketFundingProductBinding,
  executeMarketFundingDelivery,
  marketFundingDeliveryIntent,
  reconcileMarketFundingDelivery,
  requireMarketFundingActivationAmount,
  type MarketFundingDeliveryAttempt,
  type MarketFundingDeliveryInput,
  type MarketFundingDeliveryProgress,
  type MarketFundingDeliveryResult,
} from "@bitcaster/client-sdk/marketFundingDelivery";
import { deriveDurableRecipientTokenAllowance } from "@bitcaster/client-sdk/durableRecipientDelivery";
import {
  createEncryptedWalletBackupV2AssetIdentity,
  type EncryptedWalletBackupV2AssetIdentity,
} from "@bitcaster/client-sdk";
import type { DurableWalletProofDerivationLocator } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import {
  amountToNumber,
  computeInputFeeSubunitsFromPpk,
} from "@bitcaster/client-sdk/proofSelection";
import type { DurableOutgoingCashuTransfer } from "@bitcaster/client-sdk/durableOutgoingCashuTransfer";
import {
  acknowledgeBrowserDurableOutgoingCashuRecipient,
  executeBrowserDurableOutgoingCashuTransfer,
  readBrowserDurableOutgoingCashuTransfer,
  recoverBrowserDurableOutgoingCashuTransfer,
  type BrowserDurableOutgoingCashuContext,
} from "@/lib/browserDurableOutgoingCashuTransfer";
import {
  prepareBrowserDeterministicOutgoingCashuSend,
  restoreBrowserDeterministicOutgoingCashuOutputs,
} from "@/lib/browserDeterministicOutgoingCashu";
import { captureBrowserMintPersistenceContext, getWalletForUnit } from "@/lib/cashu";
import { recoverBrowserFundedAsset } from "@/lib/browserFundedAssetRecovery";
import {
  getBoundedCanonicalRegularProofs,
  decodeBrowserOutgoingCashuTransferRow,
  findBrowserOutgoingCashuTransferByPredecessor,
  readBrowserMarketFundingHead,
  type StoredProof,
} from "@/stores/proof-db";
import { getDurableCashuDeliveryStatus, submitDurableCashuDelivery } from "@/lib/markets";

export type { MarketFundingDeliveryProgress };
export type BrowserMarketFundingDeliveryResult = MarketFundingDeliveryResult;
export type BrowserMarketFundingDeliveryAttempt = MarketFundingDeliveryAttempt;

export type BrowserMarketFundingDeliveryInput = Omit<
  MarketFundingDeliveryInput,
  "deliveryId" | "requestedAmount"
> & {
  readonly outcomeCount?: number;
  /** Classifies only a final locked shortfall. It never bypasses recovery or selection. */
  readonly availableAmount?: number;
  readonly attempt: BrowserMarketFundingDeliveryAttempt;
};

export class BrowserMarketFundingInsufficientBalanceError extends Error {
  constructor() {
    super("browser market funding balance is insufficient");
    this.name = "BrowserMarketFundingInsufficientBalanceError";
  }
}

export class BrowserMarketFundingConsolidationRequiredError extends Error {
  constructor() {
    super("browser market funding proofs require consolidation");
    this.name = "BrowserMarketFundingConsolidationRequiredError";
  }
}

/** Read the exact persisted funding head for the captured wallet and scope. */
export async function readBrowserMarketFundingHeadId(
  input: Omit<MarketFundingDeliveryInput, "deliveryId" | "requestedAmount">,
): Promise<string | null> {
  const context = captureBrowserMintPersistenceContext();
  context.requireCapturedProfile();
  if (input.mintUrl !== context.activeMintUrl) {
    throw new Error("market funding mint conflicts with the captured wallet");
  }
  const productBindingSha256 = deriveMarketFundingProductBinding({
    accountSubject: input.accountSubject,
    conditionId: input.conditionId,
    divisibility: input.divisibility,
  });
  const head = await readBrowserMarketFundingHead(
    context.scopeId,
    productBindingSha256,
    context.database,
  );
  context.requireCapturedProfile();
  if (head === null) return null;
  if (
    head.scopeId !== context.scopeId ||
    head.recipientBinding !== productBindingSha256 ||
    head.accountSubject !== input.accountSubject ||
    head.conditionId !== input.conditionId ||
    head.divisibility !== input.divisibility ||
    head.mintUrl !== input.mintUrl ||
    head.unit !== input.unit
  ) {
    throw new Error("market funding head scope conflicts with the captured wallet");
  }
  return head.transferId;
}

/** Prepare or resume one durable outgoing transfer, then submit its stored token. */
export async function executeBrowserMarketFundingDelivery(
  input: BrowserMarketFundingDeliveryInput,
): Promise<BrowserMarketFundingDeliveryResult> {
  const context = captureBrowserMintPersistenceContext();
  context.requireCapturedProfile();
  if (input.mintUrl !== context.activeMintUrl) {
    throw new Error("market funding mint conflicts with the captured wallet");
  }
  return executeMarketFundingDelivery({
    funding: input,
    attempt: input.attempt,
    ports: {
      readTransfer: (transferId) =>
        readBrowserDurableOutgoingCashuTransfer({ transferId, context }),
      findSuccessor: async ({ productBindingSha256, predecessorTransferId }) => {
        const row = await findBrowserOutgoingCashuTransferByPredecessor({
          scopeId: context.scopeId,
          recipientBinding: productBindingSha256,
          predecessorTransferId,
          database: context.database,
        });
        context.requireCapturedProfile();
        return row === null ? null : decodeBrowserOutgoingCashuTransferRow(context.scopeId, row);
      },
      prepareTransfer: ({ metadata, attempt, requireCredited }) =>
        prepareBrowserMarketFundingTransfer({ input, context, metadata, attempt, requireCredited }),
      recoverTransfer: async (transfer) => {
        const wallet = await getWalletForUnit(transfer.mintUrl, transfer.unit);
        return recoverBrowserDurableOutgoingCashuTransfer({
          transferId: transfer.transferId,
          wallet,
          restoreExactOutputs: (restore) =>
            restoreBrowserDeterministicOutgoingCashuOutputs({
              wallet,
              restore,
              diagnosticLabel: "Market funding",
            }),
          context,
        });
      },
      getDurableRecipientDeliveryStatus: getDurableCashuDeliveryStatus,
      submitDurableRecipientDelivery: submitDurableCashuDelivery,
      acknowledgeRecipient: ({ transfer, receipt }) =>
        acknowledgeBrowserDurableOutgoingCashuRecipient({ transfer, receipt, context }),
    },
  });
}

async function prepareBrowserMarketFundingTransfer(input: {
  readonly input: BrowserMarketFundingDeliveryInput;
  readonly context: ReturnType<typeof captureBrowserMintPersistenceContext>;
  readonly metadata: ReturnType<
    typeof import("@bitcaster/client-sdk/marketFundingDelivery").createMarketFundingDeliveryMetadata
  >;
  readonly attempt: Extract<MarketFundingDeliveryAttempt, { kind: "begin" }>;
  readonly requireCredited: (predecessor: DurableOutgoingCashuTransfer) => Promise<void>;
}): Promise<DurableOutgoingCashuTransfer> {
  const { metadata: durableMetadata, context, attempt: begin } = input;
  const wallet = await getWalletForUnit(durableMetadata.mintUrl, durableMetadata.unit);
  context.requireCapturedProfile();
  const keepLocators: Array<DurableWalletProofDerivationLocator | null> = [];
  const asset = ordinaryFundingAsset(durableMetadata.mintUrl, durableMetadata.unit);
  return executeBrowserDurableOutgoingCashuTransfer({
    marketFundingAttempt: {
      expectedPreviousTransferId: begin.expectedPreviousTransferId,
      conditionId: durableMetadata.destinationId,
      divisibility: input.input.divisibility,
      requireCredited: input.requireCredited,
    },
    transfer: {
      transferId: begin.newAttemptId,
      mintUrl: durableMetadata.mintUrl,
      unit: durableMetadata.unit,
      requestedAmount: durableMetadata.requestedAmount,
      recipientSequence: {
        predecessorTransferId: begin.expectedPreviousTransferId,
      },
      deliveryIntent: marketFundingDeliveryIntent({
        accountSubject: durableMetadata.accountSubject,
        productBindingSha256: durableMetadata.productBindingSha256,
        tokenBytesLimit: deriveDurableRecipientTokenAllowance(durableMetadata),
      }),
    },
    preflightFundedAsset: async () => {
      await preflightMarketFundingAsset({
        context,
        asset,
        requiredAmount: durableMetadata.requestedAmount,
        mintUrl: durableMetadata.mintUrl,
        unit: durableMetadata.unit,
      });
    },
    prepareWalletSendOperation: async () => {
      context.requireCapturedProfile();
      const proofs = await readMarketFundingCandidates({
        mintUrl: durableMetadata.mintUrl,
        unit: durableMetadata.unit,
        scopeId: context.scopeId,
      });
      context.requireCapturedProfile();
      if (sumProofs(proofs) < Number(durableMetadata.requestedAmount)) {
        if (
          input.input.availableAmount !== undefined &&
          input.input.availableAmount >= Number(begin.requestedAmount)
        ) {
          throw new BrowserMarketFundingConsolidationRequiredError();
        }
        throw new BrowserMarketFundingInsufficientBalanceError();
      }
      const operation = await prepareBrowserDeterministicOutgoingCashuSend({
        operationId: `market-funding:${begin.newAttemptId}`,
        wallet,
        proofs,
        amount: Number(begin.requestedAmount),
        mintUrl: durableMetadata.mintUrl,
        unit: durableMetadata.unit,
        seed: context.seed,
        keepProofDerivationLocators: keepLocators,
        diagnosticLabel: "Market funding",
      });
      const keyset = wallet.getKeyset(operation.preview.keysetId);
      if (
        keyset.id !== operation.preview.keysetId ||
        keyset.unit !== "msat" ||
        keyset.conditional ||
        !keyset.verify() ||
        operation.preview.sendOutputs.some((output) => output.blindedMessage.id !== keyset.id)
      ) {
        throw new Error("Market funding receive-fee keyset is invalid");
      }
      requireMarketFundingActivationAmount({
        grossMsat: Number(operation.preview.amount),
        receiveFeeMsat: computeInputFeeSubunitsFromPpk(
          operation.preview.sendOutputs.length * keyset.fee,
        ),
        outcomeCount: input.input.outcomeCount ?? 8,
      });
      return operation;
    },
    keepProofDerivationLocators: keepLocators,
    wallet,
    restoreExactOutputs: (restore) =>
      restoreBrowserDeterministicOutgoingCashuOutputs({
        wallet,
        restore,
        diagnosticLabel: "Market funding",
      }),
    context,
  });
}

function ordinaryFundingAsset(
  mintUrl: string,
  unit: "sat" | "msat",
): EncryptedWalletBackupV2AssetIdentity {
  return createEncryptedWalletBackupV2AssetIdentity({ mintUrl, unit, asset: { kind: "ordinary" } });
}

async function preflightMarketFundingAsset(input: {
  readonly context: ReturnType<typeof captureBrowserMintPersistenceContext>;
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly requiredAmount: string;
  readonly mintUrl: string;
  readonly unit: "sat" | "msat";
}): Promise<void> {
  const recovery = await recoverBrowserFundedAsset({
    scopeId: input.context.scopeId,
    seed: input.context.seed,
    mnemonic: input.context.mnemonic,
    asset: input.asset,
    requiredAmount: BigInt(input.requiredAmount),
    loadPlan: async () =>
      sumProofs(await readMarketFundingCandidates({ ...input, scopeId: input.context.scopeId })) >=
      Number(input.requiredAmount)
        ? { kind: "ready" as const }
        : { kind: "insufficient" as const },
    isCurrentProfile: () => {
      input.context.requireCapturedProfile();
      return true;
    },
  });
  switch (recovery.kind) {
    case "ready":
    case "recovered":
      return;
    case "unavailable":
      throw new BrowserMarketFundingInsufficientBalanceError();
    case "persistent-error":
      throw new Error("Market funding asset recovery is unavailable");
    case "not-recoverable":
      throw new BrowserMarketFundingConsolidationRequiredError();
    default:
      throw new Error("market funding recovery outcome is invalid");
  }
}

async function readMarketFundingCandidates(input: {
  readonly mintUrl: string;
  readonly unit: "sat" | "msat";
  readonly scopeId: string;
}): Promise<StoredProof[]> {
  return getBoundedCanonicalRegularProofs(input.mintUrl, {
    unit: input.unit,
    scopeId: input.scopeId,
  });
}

function sumProofs(proofs: readonly StoredProof[]): number {
  return proofs.reduce((sum, proof) => sum + amountToNumber(proof.amount), 0);
}

/**
 * Reconcile one persisted delivery before a retry POST. This function does
 * not select proofs or mint a token. It submits only the stored token.
 */
export async function reconcileBrowserMarketFundingDelivery(input: {
  readonly transfer: DurableOutgoingCashuTransfer;
  readonly metadata: MarketFundingDeliveryInput;
  readonly readStatus: typeof getDurableCashuDeliveryStatus;
  readonly submit: typeof submitDurableCashuDelivery;
  readonly context: BrowserDurableOutgoingCashuContext;
}): Promise<BrowserMarketFundingDeliveryResult> {
  return reconcileMarketFundingDelivery({
    transfer: input.transfer,
    metadata: input.metadata,
    ports: {
      getDurableRecipientDeliveryStatus: input.readStatus,
      submitDurableRecipientDelivery: input.submit,
      acknowledgeRecipient: ({ transfer, receipt }) =>
        acknowledgeBrowserDurableOutgoingCashuRecipient({
          transfer,
          receipt,
          context: input.context,
        }),
    },
  });
}
