import { getEncodedTokenV4, type Proof, type ProofState } from "@cashu/cashu-ts";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import {
  createEncryptedWalletBackupV2AssetIdentity,
  type EncryptedWalletBackupV2AssetIdentity,
} from "@bitcaster/client-sdk";
import {
  deriveDurableWalletOperationAuthority,
  hydrateDurableWalletProof,
  serializeDurableWalletProof,
} from "@bitcaster/client-sdk/durableWalletOperation";
import type { DurableWalletProofDerivationLocator } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import {
  completeDurableOutgoingCashuReclaim,
  markDurableOutgoingCashuReclaimRecipientSpent,
  prepareDurableOutgoingCashuReclaim,
  type DurableOutgoingCashuTransfer,
} from "@bitcaster/client-sdk/durableOutgoingCashuTransfer";
import { deriveDurableCustodyArtifactFingerprint } from "@bitcaster/client-sdk/durableCustody";
import {
  classifyBrowserDurableOutgoingBearerTransfer,
  browserOutgoingCashuTransferRow,
  executeBrowserDurableOutgoingCashuTransfer,
  findBrowserDurableOutgoingBearerTransfer,
  readBrowserDurableOutgoingCashuTransfer,
} from "@/lib/browserDurableOutgoingCashuTransfer";
import {
  prepareBrowserDeterministicOutgoingCashuSend,
  restoreBrowserDeterministicOutgoingCashuOutputs,
} from "@/lib/browserDeterministicOutgoingCashu";
import { captureBrowserMintPersistenceContext, getWalletForUnit } from "@/lib/cashu";
import {
  abortPreparedBrowserDurableWalletReceive,
  bindPreparedBrowserDurableWalletReceiveOperation,
  prepareBrowserDurableWalletReceiveOperation,
  receiveBrowserDurableWalletToken,
} from "@/lib/browserDurableWalletReceive";
import { getBoundedCanonicalSatProofs, type StoredProof } from "@/stores/proof-db";
import { recoverBrowserFundedAsset } from "@/lib/browserFundedAssetRecovery";

export const BEARER_TOKEN_BYTES_LIMIT = 61_440;
export const BEARER_TOKEN_PROOF_LIMIT = 512;

/** Create and durably admit one bearer token only after the explicit Send action. */
export async function executeBrowserBearerWithdrawal(input: {
  readonly amount: number;
  readonly mintUrl: string;
}): Promise<DurableOutgoingCashuTransfer> {
  if (!Number.isSafeInteger(input.amount) || input.amount < 1) {
    throw new Error("Withdrawal amount is invalid");
  }
  const context = captureBrowserMintPersistenceContext();
  const wallet = await getWalletForUnit(input.mintUrl, "sat");
  context.requireCapturedProfile();
  const transferId = `bearer-withdrawal:${crypto.randomUUID()}`;
  const keepLocators: Array<DurableWalletProofDerivationLocator | null> = [];
  return executeBrowserDurableOutgoingCashuTransfer({
    reuseTransferId: true,
    transfer: {
      transferId,
      mintUrl: input.mintUrl,
      unit: "sat",
      requestedAmount: String(input.amount),
      deliveryIntent: {
        policy: "bearer-spend-classification",
        tokenBytesLimit: BEARER_TOKEN_BYTES_LIMIT,
        tokenProofLimit: BEARER_TOKEN_PROOF_LIMIT,
      },
    },
    preflightFundedAsset: () =>
      preflightBearerAsset({
        context,
        mintUrl: input.mintUrl,
        requiredAmount: input.amount,
      }),
    prepareWalletSendOperation: async () => {
      context.requireCapturedProfile();
      const proofs = await readBearerCandidates(input.mintUrl, context.scopeId);
      context.requireCapturedProfile();
      if (sumProofs(proofs) < input.amount) {
        throw new Error("Withdrawal balance is insufficient in the active V2 sat keyset");
      }
      return prepareBrowserDeterministicOutgoingCashuSend({
        operationId: `bearer-withdrawal:${transferId}`,
        wallet,
        proofs,
        amount: input.amount,
        mintUrl: input.mintUrl,
        seed: context.seed,
        unit: "sat",
        keepProofDerivationLocators: keepLocators,
        diagnosticLabel: "Withdrawal",
      });
    },
    keepProofDerivationLocators: keepLocators,
    wallet,
    restoreExactOutputs: (restore) =>
      restoreBrowserDeterministicOutgoingCashuOutputs({
        wallet,
        restore,
        diagnosticLabel: "Withdrawal",
      }),
    context,
  });
}

async function preflightBearerAsset(input: {
  readonly context: ReturnType<typeof captureBrowserMintPersistenceContext>;
  readonly mintUrl: string;
  readonly requiredAmount: number;
}): Promise<void> {
  const asset: EncryptedWalletBackupV2AssetIdentity = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: input.mintUrl,
    unit: "sat",
    asset: { kind: "ordinary" },
  });
  const recovery = await recoverBrowserFundedAsset({
    database: input.context.database,
    scopeId: input.context.scopeId,
    seed: input.context.seed,
    mnemonic: input.context.mnemonic,
    asset,
    requiredAmount: BigInt(input.requiredAmount),
    loadPlan: async () =>
      sumProofs(await readBearerCandidates(input.mintUrl, input.context.scopeId)) >=
      input.requiredAmount
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
      throw new Error("Withdrawal balance is insufficient in the active V2 sat keyset");
    case "persistent-error":
      throw new Error("Withdrawal asset recovery is unavailable");
    case "not-recoverable":
      throw new Error("Withdrawal proofs require consolidation");
    default:
      throw new Error("Withdrawal recovery outcome is invalid");
  }
}

async function readBearerCandidates(mintUrl: string, scopeId: string): Promise<StoredProof[]> {
  return getBoundedCanonicalSatProofs(mintUrl, { scopeId });
}

function sumProofs(proofs: readonly StoredProof[]): number {
  return proofs.reduce((sum, proof) => sum + amountToNumber(proof.amount), 0);
}

/** Read one persisted bearer token only after the user opens the Ecash withdrawal surface. */
export async function resumeBrowserBearerWithdrawal(
  mintUrl: string,
): Promise<DurableOutgoingCashuTransfer | null> {
  return findBrowserDurableOutgoingBearerTransfer({
    mintUrl,
    context: captureBrowserMintPersistenceContext(),
  });
}

/** Classify the complete exact token vector before a user may reclaim it. */
export async function classifyBrowserBearerWithdrawal(input: {
  readonly transfer: DurableOutgoingCashuTransfer;
}): Promise<DurableOutgoingCashuTransfer> {
  if (input.transfer.token === null) throw new Error("Bearer token authority is unavailable");
  const context = captureBrowserMintPersistenceContext();
  const wallet = await getWalletForUnit(input.transfer.mintUrl, "sat");
  context.requireCapturedProfile();
  const states = await wallet.checkProofsStates(
    input.transfer.token.proofs.map(({ id, secret }) => ({ id, secret })),
  );
  context.requireCapturedProfile();
  return classifyBrowserDurableOutgoingBearerTransfer({
    transfer: input.transfer,
    states: normalizeProofStates(states),
    context,
  });
}

/** Reclaim only the exact subset that a fresh complete NUT-07 classification permits. */
export async function reclaimBrowserBearerWithdrawal(input: {
  readonly transfer: DurableOutgoingCashuTransfer;
}): Promise<DurableOutgoingCashuTransfer> {
  if (input.transfer.token === null) throw new Error("Bearer token authority is unavailable");
  const context = captureBrowserMintPersistenceContext();
  const wallet = await getWalletForUnit(input.transfer.mintUrl, "sat");
  if (input.transfer.deliveryState === "reclaim-prepared") {
    return recoverPreparedBrowserBearerReclaim(input.transfer, wallet, context);
  }
  context.requireCapturedProfile();
  const states = normalizeProofStates(
    await wallet.checkProofsStates(
      input.transfer.token.proofs.map(({ id, secret }) => ({ id, secret })),
    ),
  );
  context.requireCapturedProfile();
  const classified = await classifyBrowserDurableOutgoingBearerTransfer({
    transfer: input.transfer,
    states,
    context,
  });
  if (classified.deliveryState === "bearer-spent") return classified;
  if (
    classified.deliveryState !== "delivery-pending" &&
    classified.deliveryState !== "bearer-partial"
  ) {
    return classified;
  }
  if (classified.token?.unspentProofs === null || classified.token === null) return classified;
  const reclaimId = `bearer-reclaim:${crypto.randomUUID()}`;
  const token = getEncodedTokenV4({
    mint: classified.mintUrl,
    unit: classified.unit,
    proofs: classified.token.unspentProofs.map(hydrateDurableWalletProof),
  });
  const operation = await prepareBrowserDurableWalletReceiveOperation(
    {
      operationId: reclaimId,
      token,
      mintUrl: classified.mintUrl,
      unit: "sat",
      wallet,
      context,
    },
    () => crypto.randomUUID(),
  );
  const prepared = prepareDurableOutgoingCashuReclaim({
    transfer: classified,
    reclaimId,
    states,
    dueAtMs: Date.now(),
    walletReceiveOperation: operation,
  });
  await bindPreparedBrowserDurableWalletReceiveOperation({
    operation,
    wallet,
    outgoingTransfer: browserOutgoingCashuTransferRow(context.scopeId, prepared, "consumed"),
    context,
  });
  return prepared;
}

/** Execute only the already persisted exact reclaim receive. */
async function executePreparedBrowserBearerReclaim(
  transfer: DurableOutgoingCashuTransfer,
  wallet: Awaited<ReturnType<typeof getWalletForUnit>>,
  context: ReturnType<typeof captureBrowserMintPersistenceContext>,
): Promise<DurableOutgoingCashuTransfer> {
  const reclaim = transfer.reclaim;
  if (reclaim === null) throw new Error("Bearer reclaim authority is unavailable");
  const token = getEncodedTokenV4({
    mint: transfer.mintUrl,
    unit: transfer.unit,
    proofs: reclaim.proofs.map(hydrateDurableWalletProof),
  });
  await receiveBrowserDurableWalletToken({
    operationId: reclaim.walletReceiveOperation.operationId,
    preparedOperation: reclaim.walletReceiveOperation,
    skipBind: true,
    recoveryMode: "recover",
    token,
    mintUrl: transfer.mintUrl,
    unit: "sat",
    wallet,
    context,
    completeOutgoingTransfer: (received) =>
      completedBearerReclaimRow(
        transfer,
        reclaim.walletReceiveOperation,
        received,
        reclaim.reclaimId,
        context.scopeId,
      ),
    abortOutgoingTransfer: ({ custodyOperationId }) =>
      abortPreparedBrowserDurableWalletReceive({
        custodyOperationId,
        transferId: transfer.transferId,
        terminalOutgoingTransfer: browserOutgoingCashuTransferRow(
          context.scopeId,
          markDurableOutgoingCashuReclaimRecipientSpent(transfer),
          "consumed",
        ),
        context,
      }),
  });
  const completed = await readBrowserDurableOutgoingCashuTransfer({
    transferId: transfer.transferId,
    context,
  });
  if (completed === null) throw new Error("Bearer reclaim transfer is missing after recovery");
  return completed;
}

function reclaimPresentation(
  operation: Parameters<typeof prepareDurableOutgoingCashuReclaim>[0]["walletReceiveOperation"],
) {
  return {
    returnedAmount: operation.preview.amount,
    receiveFee: operation.preview.fees,
  };
}

export function browserBearerReclaimFeeDisclosure(transfer: DurableOutgoingCashuTransfer): {
  readonly returnedAmount: string;
  readonly receiveFee: string;
} | null {
  if (transfer.deliveryState !== "reclaim-prepared" || transfer.reclaim === null) return null;
  return reclaimPresentation(transfer.reclaim.walletReceiveOperation);
}

async function recoverPreparedBrowserBearerReclaim(
  transfer: DurableOutgoingCashuTransfer,
  wallet: Awaited<ReturnType<typeof getWalletForUnit>>,
  context: ReturnType<typeof captureBrowserMintPersistenceContext>,
): Promise<DurableOutgoingCashuTransfer> {
  return executePreparedBrowserBearerReclaim(transfer, wallet, context);
}

function normalizeProofStates(states: readonly ProofState[]) {
  return states.map(({ Y, state }) => ({
    Y,
    state: String(state) as "UNSPENT" | "PENDING" | "SPENT",
  }));
}

function proofIdentity(proof: {
  readonly id: string;
  readonly secret: string;
  readonly C: string;
}): string {
  return deriveDurableCustodyArtifactFingerprint({
    id: proof.id,
    secret: proof.secret,
    C: proof.C,
  });
}

function reclaimCompletionEvidence(
  transfer: DurableOutgoingCashuTransfer,
  operation: Parameters<typeof deriveDurableWalletOperationAuthority>[0],
  successors: readonly Proof[],
  reclaimId: string,
) {
  if (transfer.reclaim === null) throw new Error("Bearer reclaim authority is unavailable");
  return {
    transferId: transfer.transferId,
    reclaimId,
    walletReceiveOperationAuthority: deriveDurableWalletOperationAuthority(operation),
    successorProofFingerprint: deriveDurableCustodyArtifactFingerprint(
      successors.map(serializeDurableWalletProof),
    ),
    custodyRevisions: [
      ...transfer.reclaim.proofs.map((proof) => ({
        proofIdentity: proofIdentity(proof),
        revision: 0,
      })),
      ...successors.map((proof) => ({ proofIdentity: proofIdentity(proof), revision: 0 })),
    ],
  };
}

function completedBearerReclaimRow(
  transfer: DurableOutgoingCashuTransfer,
  operation: Parameters<typeof deriveDurableWalletOperationAuthority>[0],
  successors: readonly Proof[],
  reclaimId: string,
  scopeId: string,
) {
  const completed = completeDurableOutgoingCashuReclaim({
    transfer,
    successorProofs: successors,
    evidence: reclaimCompletionEvidence(transfer, operation, successors, reclaimId),
  });
  return browserOutgoingCashuTransferRow(scopeId, completed, "consumed");
}
