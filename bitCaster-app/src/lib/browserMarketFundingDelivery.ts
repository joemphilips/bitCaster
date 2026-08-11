import {
  assertDurableRecipientDeliveryStatusAuthority,
  deriveDurableRecipientDeliveryResultFingerprint,
  reconcileDurableRecipientDelivery,
  type DurableRecipientDeliverySubmission,
  type DurableRecipientDeliveryStatus,
} from "@bitcaster/client-sdk/durableRecipientDelivery";
import {
  createMarketFundingDeliverySubmission,
  createMarketFundingDeliveryMetadata,
  deriveMarketFundingProductBinding,
  marketFundingDeliveryIntent,
  type MarketFundingDeliveryInput,
} from "@bitcaster/client-sdk/marketFundingDelivery";
import { deriveDurableRecipientTokenAllowance } from "@bitcaster/client-sdk/durableRecipientDelivery";
import {
  createEncryptedWalletBackupV2AssetIdentity,
  type EncryptedWalletBackupV2AssetIdentity,
} from "@bitcaster/client-sdk";
import { locateSeedDerivedProofLineage } from "@bitcaster/client-sdk/durableSeedDerivedProofLineage";
import { serializeDurableWalletSendOperation } from "@bitcaster/client-sdk/durableWalletOperation";
import type { DurableWalletProofDerivationLocator } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import type { OperationCounters, OutputData, Proof, SwapPreview } from "@cashu/cashu-ts";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import type {
  DurableOutgoingCashuCoordinatorInput,
  DurableOutgoingCashuTransfer,
} from "@bitcaster/client-sdk/durableOutgoingCashuTransfer";
import {
  acknowledgeBrowserDurableOutgoingCashuRecipient,
  executeBrowserDurableOutgoingCashuTransfer,
  findBrowserDurableOutgoingCashuTransferByRecipientBinding,
  recoverBrowserDurableOutgoingCashuTransfer,
  type BrowserDurableOutgoingCashuContext,
} from "@/lib/browserDurableOutgoingCashuTransfer";
import {
  captureBrowserMintPersistenceContext,
  getWalletForUnit,
  restoreExactMintOutputs,
} from "@/lib/cashu";
import { recoverBrowserFundedAsset } from "@/lib/browserFundedAssetRecovery";
import { getBoundedMarketFundingProofs, type StoredProof } from "@/stores/proof-db";
import { getDurableCashuDeliveryStatus, submitDurableCashuDelivery } from "@/lib/markets";

export type MarketFundingDeliveryProgress = "pending" | "received" | "credited";

export interface BrowserMarketFundingDeliveryResult {
  readonly transfer: DurableOutgoingCashuTransfer;
  readonly progress: MarketFundingDeliveryProgress;
}

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

/** Prepare one durable outgoing transfer, then submit its stored token. */
export async function executeBrowserMarketFundingDelivery(
  input: Omit<MarketFundingDeliveryInput, "deliveryId"> & {
    readonly deliveryId?: string;
    /** Classifies only a final locked shortfall. It never bypasses recovery or selection. */
    readonly availableAmount?: number;
  },
): Promise<BrowserMarketFundingDeliveryResult> {
  const context = captureBrowserMintPersistenceContext();
  const productBindingSha256 = deriveMarketFundingProductBinding({
    accountSubject: input.accountSubject,
    conditionId: input.conditionId,
    divisibility: input.divisibility,
  });
  const prior = await findBrowserDurableOutgoingCashuTransferByRecipientBinding({
    productBindingSha256,
    context,
  });
  if (prior !== null) {
    const wallet = await getWalletForUnit(prior.mintUrl, prior.unit);
    const recovered = await recoverBrowserDurableOutgoingCashuTransfer({
      transferId: prior.transferId,
      wallet,
      restoreExactOutputs: (restore) => restoreMarketFundingExactOutputs(wallet, restore),
      context,
    });
    if (recovered === null) {
      throw new Error("market funding transfer disappeared during recovery");
    }
    return reconcileBrowserMarketFundingDelivery({
      transfer: recovered,
      metadata: persistedMarketFundingMetadata(input, recovered),
      readStatus: getDurableCashuDeliveryStatus,
      submit: submitDurableCashuDelivery,
      context,
    });
  }
  const deliveryId = input.deliveryId ?? crypto.randomUUID();
  const metadata: MarketFundingDeliveryInput = { ...input, deliveryId };
  const durableMetadata = createMarketFundingDeliveryMetadata(metadata);
  const wallet = await getWalletForUnit(context.activeMintUrl, input.unit);
  context.requireCapturedProfile();
  const keepLocators: Array<DurableWalletProofDerivationLocator | null> = [];
  const asset = ordinaryFundingAsset(durableMetadata.mintUrl, durableMetadata.unit);
  const transfer = await executeBrowserDurableOutgoingCashuTransfer({
    reuseRecipientBinding: true,
    transfer: {
      transferId: deliveryId,
      mintUrl: durableMetadata.mintUrl,
      unit: durableMetadata.unit,
      requestedAmount: durableMetadata.requestedAmount,
      deliveryIntent: marketFundingDeliveryIntent({
        accountSubject: durableMetadata.accountSubject,
        productBindingSha256: durableMetadata.productBindingSha256,
        tokenBytesLimit: deriveDurableRecipientTokenAllowance(durableMetadata),
      }),
    },
    preflightFundedAsset: () =>
      preflightMarketFundingAsset({
        context,
        asset,
        requiredAmount: durableMetadata.requestedAmount,
        mintUrl: durableMetadata.mintUrl,
        unit: durableMetadata.unit,
      }),
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
          input.availableAmount !== undefined &&
          input.availableAmount >= Number(input.requestedAmount)
        ) {
          throw new BrowserMarketFundingConsolidationRequiredError();
        }
        throw new BrowserMarketFundingInsufficientBalanceError();
      }
      return prepareMarketFundingWalletSend({
        deliveryId,
        wallet,
        proofs,
        amount: Number(input.requestedAmount),
        mintUrl: durableMetadata.mintUrl,
        unit: durableMetadata.unit,
        seed: context.seed,
        keepLocators,
      });
    },
    keepProofDerivationLocators: keepLocators,
    wallet,
    restoreExactOutputs: (restore) => restoreMarketFundingExactOutputs(wallet, restore),
    context,
  });
  return reconcileBrowserMarketFundingDelivery({
    transfer,
    metadata: persistedMarketFundingMetadata(input, transfer),
    readStatus: getDurableCashuDeliveryStatus,
    submit: submitDurableCashuDelivery,
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
    database: input.context.database,
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
  return getBoundedMarketFundingProofs(input.mintUrl, {
    unit: input.unit,
    scopeId: input.scopeId,
  });
}

function sumProofs(proofs: readonly StoredProof[]): number {
  return proofs.reduce((sum, proof) => sum + amountToNumber(proof.amount), 0);
}

function persistedMarketFundingMetadata(
  input: Omit<MarketFundingDeliveryInput, "deliveryId">,
  transfer: DurableOutgoingCashuTransfer,
): MarketFundingDeliveryInput {
  return {
    ...input,
    deliveryId: transfer.transferId,
    mintUrl: transfer.mintUrl,
    unit: "msat",
    requestedAmount: transfer.requestedAmount,
  };
}

async function restoreMarketFundingExactOutputs(
  wallet: Awaited<ReturnType<typeof getWalletForUnit>>,
  input: Parameters<DurableOutgoingCashuCoordinatorInput["restoreExactOutputs"]>[0],
) {
  const exactOutputs = [...input.outputs.keep, ...input.outputs.send];
  const restored = await restoreExactMintOutputs(wallet, {
    mintUrl: input.mintUrl,
    unit: input.unit,
    outputs: exactOutputs,
  });
  if (restored.length !== exactOutputs.length) {
    throw new Error("market funding restored output set is incomplete");
  }
  return {
    keep: restored.slice(0, input.outputs.keep.length),
    send: restored.slice(input.outputs.keep.length),
  };
}

/**
 * Reconcile one persisted delivery before a retry POST. This function does
 * not select proofs or mint a token. It submits only the stored token.
 */
export async function reconcileBrowserMarketFundingDelivery(input: {
  readonly transfer: DurableOutgoingCashuTransfer;
  readonly metadata: MarketFundingDeliveryInput;
  readonly readStatus: (deliveryId: string) => Promise<DurableRecipientDeliveryStatus | null>;
  readonly submit: (
    submission: DurableRecipientDeliverySubmission,
  ) => Promise<DurableRecipientDeliveryStatus>;
  readonly context: BrowserDurableOutgoingCashuContext;
}): Promise<BrowserMarketFundingDeliveryResult> {
  if (input.transfer.token === null) {
    throw new Error("market funding transfer has no stored token");
  }
  const submission = createMarketFundingDeliverySubmission({
    metadata: marketFundingMetadata(input.transfer, input.metadata),
    token: input.transfer.token.encodedToken,
  });

  const status = await reconcileDurableRecipientDelivery({
    client: {
      getDurableRecipientDeliveryStatus: input.readStatus,
      submitDurableRecipientDelivery: input.submit,
    },
    submission,
  });
  if (status === null) return { transfer: input.transfer, progress: "pending" };
  return persistRecipientStatus(input, submission, status);
}

async function persistRecipientStatus(
  input: Parameters<typeof reconcileBrowserMarketFundingDelivery>[0],
  submission: DurableRecipientDeliverySubmission,
  status: DurableRecipientDeliveryStatus,
): Promise<BrowserMarketFundingDeliveryResult> {
  assertDurableRecipientDeliveryStatusAuthority({ expected: submission, status });
  if (status.state === "pending") return { transfer: input.transfer, progress: "pending" };
  if (
    input.transfer.deliveryIntent.policy !== "durable-recipient-ack" ||
    input.transfer.token === null
  ) {
    throw new Error("market funding transfer is missing recipient delivery authority");
  }

  const result = status.result;
  const transfer = await acknowledgeBrowserDurableOutgoingCashuRecipient({
    transfer: input.transfer,
    receipt: {
      transferId: input.transfer.transferId,
      expectedSubject: input.transfer.deliveryIntent.expectedSubject,
      opaqueProductBinding: input.transfer.deliveryIntent.opaqueProductBinding,
      mintUrl: input.transfer.mintUrl,
      unit: input.transfer.unit,
      requestedAmount: input.transfer.requestedAmount,
      tokenSha256: input.transfer.token.sha256,
      tokenLength: input.transfer.token.encodedLength,
      receiveOperationId: result.receiveOperationId,
      durableResultFingerprint: deriveDurableRecipientDeliveryResultFingerprint(status),
    },
    context: input.context,
  });
  return { transfer, progress: status.state };
}

function marketFundingMetadata(
  transfer: DurableOutgoingCashuTransfer,
  metadata: MarketFundingDeliveryInput,
) {
  if (transfer.deliveryIntent.policy !== "durable-recipient-ack") {
    throw new Error("market funding transfer is missing recipient delivery authority");
  }
  if (metadata.deliveryId !== transfer.transferId) {
    throw new Error("market funding delivery id conflicts with the stored transfer");
  }
  if (
    metadata.accountSubject !== transfer.deliveryIntent.expectedSubject ||
    metadata.mintUrl !== transfer.mintUrl ||
    metadata.unit !== transfer.unit ||
    metadata.requestedAmount !== transfer.requestedAmount
  ) {
    throw new Error("market funding delivery metadata conflicts with the stored transfer");
  }
  const durableMetadata = createMarketFundingDeliveryMetadata(metadata);
  if (durableMetadata.productBindingSha256 !== transfer.deliveryIntent.opaqueProductBinding) {
    throw new Error("market funding product binding conflicts with the stored transfer");
  }
  return durableMetadata;
}

async function prepareMarketFundingWalletSend(input: {
  readonly deliveryId: string;
  readonly wallet: {
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
  };
  readonly proofs: readonly StoredProof[];
  readonly amount: number;
  readonly mintUrl: string;
  readonly unit: "sat" | "msat";
  readonly seed: Uint8Array;
  readonly keepLocators: Array<DurableWalletProofDerivationLocator | null>;
}) {
  if (!Number.isSafeInteger(input.amount) || input.amount < 1) {
    throw new Error("market funding amount is invalid");
  }
  const keysetId = input.wallet.getKeyset().id;
  const counterReservation: { value: OperationCounters | null } = { value: null };
  const preview = await input.wallet.prepareSwapToSend(
    input.amount,
    input.proofs as unknown as Proof[],
    {
      includeFees: false,
      keysetId,
      onCountersReserved: (reserved) => {
        if (counterReservation.value !== null) {
          throw new Error("market funding output counters were reserved twice");
        }
        counterReservation.value = reserved;
      },
    },
    {
      send: { type: "deterministic", counter: 0 },
      keep: { type: "deterministic", counter: 0 },
    },
  );
  const counters = counterReservation.value;
  if (counters === null || counters.keysetId !== preview.keysetId) {
    throw new Error("market funding output counter reservation is missing");
  }
  const outputs = [...(preview.sendOutputs ?? []), ...(preview.keepOutputs ?? [])];
  if (outputs.length !== counters.count) {
    throw new Error("market funding output counter reservation conflicts with the output plan");
  }
  const lineage = locateSeedDerivedProofLineage({
    seed: input.seed,
    keysetId: counters.keysetId,
    counterStart: counters.start,
    counterCount: counters.count,
    proofs: outputs.map(outputProofLineage),
  });
  const locators = new Map(lineage.map(({ secret, ...locator }) => [secret, locator]));
  input.keepLocators.splice(
    0,
    input.keepLocators.length,
    ...(preview.keepOutputs ?? []).map((output) => {
      const locator = locators.get(outputProofLineage(output).secret);
      if (locator === undefined) throw new Error("market funding keep output locator is missing");
      return locator;
    }),
  );
  return serializeDurableWalletSendOperation({
    operationId: `market-funding:${input.deliveryId}`,
    mintUrl: input.mintUrl,
    unit: input.unit,
    preview,
  });
}

function outputProofLineage(output: OutputData): { readonly id: string; readonly secret: string } {
  return { id: output.blindedMessage.id, secret: new TextDecoder().decode(output.secret) };
}
