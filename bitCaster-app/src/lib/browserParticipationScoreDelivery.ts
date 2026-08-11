import {
  assertDurableRecipientDeliveryStatusAuthority,
  deriveDurableRecipientDeliveryResultFingerprint,
  deriveDurableRecipientTokenAllowance,
  type DurableRecipientDeliveryStatus,
  type DurableRecipientDeliverySubmission,
} from "@bitcaster/client-sdk/durableRecipientDelivery";
import {
  createParticipationScoreDeliveryMetadata,
  createParticipationScoreDeliverySubmission,
  participationScoreDeliveryIntent,
  type ParticipationScoreDeliveryInput,
} from "@bitcaster/client-sdk/participationScoreDelivery";
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
  readBrowserDurableOutgoingCashuTransfer,
  recoverBrowserDurableOutgoingCashuTransfer,
  type BrowserDurableOutgoingCashuContext,
} from "@/lib/browserDurableOutgoingCashuTransfer";
import {
  captureBrowserMintPersistenceContext,
  getWalletForUnit,
  restoreExactMintOutputs,
} from "@/lib/cashu";
import { getDurableCashuDeliveryStatus, submitDurableCashuDelivery } from "@/lib/markets";
import { normalizeUrl } from "@/lib/url";
import { getBoundedParticipationScoreProofs, type StoredProof } from "@/stores/proof-db";
import { useWalletStore } from "@/stores/wallet";

export type ParticipationScoreDeliveryProgress = "pending" | "received" | "credited";

export interface BrowserParticipationScoreDeliveryResult {
  readonly transfer: DurableOutgoingCashuTransfer;
  readonly progress: ParticipationScoreDeliveryProgress;
  readonly delivery: DurableRecipientDeliveryStatus | null;
}

export class BrowserParticipationScoreInsufficientBalanceError extends Error {
  constructor(readonly balanceSats: number) {
    super("browser Participation Score balance is insufficient");
    this.name = "BrowserParticipationScoreInsufficientBalanceError";
  }
}

export class BrowserParticipationScoreConsolidationRequiredError extends Error {
  constructor() {
    super("browser Participation Score proofs require consolidation");
    this.name = "BrowserParticipationScoreConsolidationRequiredError";
  }
}

/** Persist one exact sat transfer before its durable-recipient POST. */
export async function executeBrowserParticipationScoreDelivery(
  input: ParticipationScoreDeliveryInput,
): Promise<BrowserParticipationScoreDeliveryResult> {
  const metadata = createParticipationScoreDeliveryMetadata(input);
  const context = captureBrowserMintPersistenceContext();
  const existing = await readBrowserDurableOutgoingCashuTransfer({
    transferId: metadata.deliveryId,
    context,
  });
  if (existing !== null && existing.token !== null) {
    return reconcileBrowserParticipationScoreDelivery({
      transfer: existing,
      metadata: persistedParticipationScoreMetadata(input, existing),
      readStatus: getDurableCashuDeliveryStatus,
      submit: submitDurableCashuDelivery,
      context,
    });
  }
  const wallet = await getWalletForUnit(metadata.mintUrl, "sat");
  if (existing !== null) {
    const recovered = await recoverBrowserDurableOutgoingCashuTransfer({
      transferId: metadata.deliveryId,
      wallet,
      restoreExactOutputs: (restore) => restoreParticipationScoreExactOutputs(wallet, restore),
      context,
    });
    if (recovered === null)
      throw new Error("Participation Score transfer disappeared during recovery");
    return reconcileBrowserParticipationScoreDelivery({
      transfer: recovered,
      metadata: persistedParticipationScoreMetadata(input, recovered),
      readStatus: getDurableCashuDeliveryStatus,
      submit: submitDurableCashuDelivery,
      context,
    });
  }

  context.requireCapturedProfile();
  const proofs = await getBoundedParticipationScoreProofs(metadata.mintUrl, {
    keysetIds: participationScoreKeysetIds(metadata.mintUrl, wallet.getKeyset().id),
  });
  context.requireCapturedProfile();
  if (sumProofs(proofs) < Number(metadata.requestedAmount)) {
    throw new BrowserParticipationScoreInsufficientBalanceError(sumProofs(proofs));
  }
  const keepLocators: Array<DurableWalletProofDerivationLocator | null> = [];
  const transfer = await executeBrowserDurableOutgoingCashuTransfer({
    reuseTransferId: true,
    transfer: {
      transferId: metadata.deliveryId,
      mintUrl: metadata.mintUrl,
      unit: metadata.unit,
      requestedAmount: metadata.requestedAmount,
      deliveryIntent: participationScoreDeliveryIntent({
        accountSubject: metadata.accountSubject,
        productBindingSha256: metadata.productBindingSha256,
        tokenBytesLimit: deriveDurableRecipientTokenAllowance(metadata),
      }),
    },
    prepareWalletSendOperation: async () =>
      prepareParticipationScoreWalletSend({
        deliveryId: metadata.deliveryId,
        wallet,
        proofs,
        amount: Number(metadata.requestedAmount),
        mintUrl: metadata.mintUrl,
        seed: context.seed,
        keepLocators,
      }),
    keepProofDerivationLocators: keepLocators,
    wallet,
    restoreExactOutputs: (restore) => restoreParticipationScoreExactOutputs(wallet, restore),
    context,
  });
  return reconcileBrowserParticipationScoreDelivery({
    transfer,
    metadata: persistedParticipationScoreMetadata(input, transfer),
    readStatus: getDurableCashuDeliveryStatus,
    submit: submitDurableCashuDelivery,
    context,
  });
}

/** Reconcile one exact existing delivery. This function never selects fresh proofs. */
export async function reconcileBrowserParticipationScoreDeliveryIfPresent(input: {
  readonly deliveryId: string;
  readonly accountSubject: string;
  readonly mintUrl: string;
}): Promise<BrowserParticipationScoreDeliveryResult | null> {
  const context = captureBrowserMintPersistenceContext();
  const existing = await readBrowserDurableOutgoingCashuTransfer({
    transferId: input.deliveryId,
    context,
  });
  if (existing === null) return null;
  const metadata: ParticipationScoreDeliveryInput = {
    ...input,
    mintUrl: existing.mintUrl,
    requestedAmount: existing.requestedAmount,
  };
  if (existing.token !== null) {
    return reconcileBrowserParticipationScoreDelivery({
      transfer: existing,
      metadata,
      readStatus: getDurableCashuDeliveryStatus,
      submit: submitDurableCashuDelivery,
      context,
    });
  }
  const wallet = await getWalletForUnit(existing.mintUrl, "sat");
  const recovered = await recoverBrowserDurableOutgoingCashuTransfer({
    transferId: existing.transferId,
    wallet,
    restoreExactOutputs: (restore) => restoreParticipationScoreExactOutputs(wallet, restore),
    context,
  });
  if (recovered === null)
    throw new Error("Participation Score transfer disappeared during recovery");
  return reconcileBrowserParticipationScoreDelivery({
    transfer: recovered,
    metadata,
    readStatus: getDurableCashuDeliveryStatus,
    submit: submitDurableCashuDelivery,
    context,
  });
}

/** Reconcile status first. A retry presents only the stored byte-identical token. */
export async function reconcileBrowserParticipationScoreDelivery(input: {
  readonly transfer: DurableOutgoingCashuTransfer;
  readonly metadata: ParticipationScoreDeliveryInput;
  readonly readStatus: (deliveryId: string) => Promise<DurableRecipientDeliveryStatus | null>;
  readonly submit: (
    submission: DurableRecipientDeliverySubmission,
  ) => Promise<DurableRecipientDeliveryStatus>;
  readonly context: BrowserDurableOutgoingCashuContext;
}): Promise<BrowserParticipationScoreDeliveryResult> {
  if (input.transfer.token === null) {
    throw new Error("Participation Score transfer has no stored token");
  }
  const submission = createParticipationScoreDeliverySubmission({
    metadata: participationScoreMetadata(input.transfer, input.metadata),
    token: input.transfer.token.encodedToken,
  });
  const existing = await input.readStatus(input.transfer.transferId);
  if (existing !== null) {
    assertDurableRecipientDeliveryStatusAuthority({ expected: submission, status: existing });
    if (existing.state !== "pending") return persistRecipientStatus(input, submission, existing);
  }
  try {
    const posted = await input.submit(submission);
    if (posted.state === "pending") {
      const refreshed = await input.readStatus(input.transfer.transferId);
      if (refreshed === null)
        return { transfer: input.transfer, progress: "pending", delivery: null };
      return persistRecipientStatus(input, submission, refreshed);
    }
    return persistRecipientStatus(input, submission, posted);
  } catch (error) {
    const recovered = await input.readStatus(input.transfer.transferId).catch(() => null);
    if (recovered !== null) return persistRecipientStatus(input, submission, recovered);
    throw error;
  }
}

function persistedParticipationScoreMetadata(
  input: ParticipationScoreDeliveryInput,
  transfer: DurableOutgoingCashuTransfer,
): ParticipationScoreDeliveryInput {
  return {
    ...input,
    deliveryId: transfer.transferId,
    mintUrl: transfer.mintUrl,
    requestedAmount: transfer.requestedAmount,
  };
}

async function persistRecipientStatus(
  input: Parameters<typeof reconcileBrowserParticipationScoreDelivery>[0],
  submission: DurableRecipientDeliverySubmission,
  status: DurableRecipientDeliveryStatus,
): Promise<BrowserParticipationScoreDeliveryResult> {
  assertDurableRecipientDeliveryStatusAuthority({ expected: submission, status });
  if (status.state === "pending")
    return { transfer: input.transfer, progress: "pending", delivery: status };
  if (
    input.transfer.deliveryIntent.policy !== "durable-recipient-ack" ||
    input.transfer.token === null
  ) {
    throw new Error("Participation Score transfer is missing recipient delivery authority");
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
  return { transfer, progress: status.state, delivery: status };
}

function participationScoreMetadata(
  transfer: DurableOutgoingCashuTransfer,
  metadata: ParticipationScoreDeliveryInput,
) {
  if (transfer.deliveryIntent.policy !== "durable-recipient-ack") {
    throw new Error("Participation Score transfer is missing recipient delivery authority");
  }
  if (
    metadata.deliveryId !== transfer.transferId ||
    metadata.accountSubject !== transfer.deliveryIntent.expectedSubject ||
    metadata.mintUrl !== transfer.mintUrl ||
    transfer.unit !== "sat" ||
    metadata.requestedAmount !== transfer.requestedAmount
  ) {
    throw new Error("Participation Score delivery metadata conflicts with the stored transfer");
  }
  const durableMetadata = createParticipationScoreDeliveryMetadata(metadata);
  if (durableMetadata.productBindingSha256 !== transfer.deliveryIntent.opaqueProductBinding) {
    throw new Error("Participation Score product binding conflicts with the stored transfer");
  }
  return durableMetadata;
}

async function restoreParticipationScoreExactOutputs(
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
    throw new Error("Participation Score restored output set is incomplete");
  }
  return {
    keep: restored.slice(0, input.outputs.keep.length),
    send: restored.slice(input.outputs.keep.length),
  };
}

async function prepareParticipationScoreWalletSend(input: {
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
  readonly seed: Uint8Array;
  readonly keepLocators: Array<DurableWalletProofDerivationLocator | null>;
}) {
  const counterReservation: { value: OperationCounters | null } = { value: null };
  const keysetId = input.wallet.getKeyset().id;
  const preview = await input.wallet.prepareSwapToSend(
    input.amount,
    input.proofs as unknown as Proof[],
    {
      includeFees: false,
      keysetId,
      onCountersReserved: (reserved) => {
        if (counterReservation.value !== null) {
          throw new Error("Participation Score output counters were reserved twice");
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
    throw new Error("Participation Score output counter reservation is missing");
  }
  const outputs = [...(preview.sendOutputs ?? []), ...(preview.keepOutputs ?? [])];
  if (outputs.length !== counters.count) {
    throw new Error(
      "Participation Score output counter reservation conflicts with the output plan",
    );
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
      if (locator === undefined)
        throw new Error("Participation Score keep output locator is missing");
      return locator;
    }),
  );
  return serializeDurableWalletSendOperation({
    operationId: `participation-score:${input.deliveryId}`,
    mintUrl: input.mintUrl,
    unit: "sat",
    preview,
  });
}

function sumProofs(proofs: readonly StoredProof[]): number {
  return proofs.reduce((sum, proof) => sum + amountToNumber(proof.amount), 0);
}

function participationScoreKeysetIds(mintUrl: string, activeKeysetId: string): string[] {
  const mint = useWalletStore
    .getState()
    .mints.find((candidate) => normalizeUrl(candidate.url) === normalizeUrl(mintUrl));
  const ids = new Set(
    mint?.keysets
      ?.filter((keyset) => keyset.unit === "sat" && /^01[0-9a-f]{64}$/.test(keyset.id))
      .map((keyset) => keyset.id) ?? [],
  );
  if (/^01[0-9a-f]{64}$/.test(activeKeysetId)) ids.add(activeKeysetId);
  return [activeKeysetId, ...ids].filter(
    (keysetId, index, all) => /^01[0-9a-f]{64}$/.test(keysetId) && all.indexOf(keysetId) === index,
  );
}

function outputProofLineage(output: OutputData): { readonly id: string; readonly secret: string } {
  return { id: output.blindedMessage.id, secret: new TextDecoder().decode(output.secret) };
}
