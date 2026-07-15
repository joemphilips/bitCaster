import type {
  CtfRedeemMintSubmissionBinding,
  CtfProofOperationRecord,
  CtfProofOperationStore,
} from "@bitcaster/client-sdk/ctfSplit";
import { getProofOperationUnderLock } from "./proof-db";
import {
  markProofOperationCompletedForWallet,
  markProofOperationFailedForWallet,
  markProofOperationMintSubmittedForWallet,
  prepareProofOperationForWallet,
} from "./gui-wallet-proof-operation-custody";
import { withGuiCustodyProfileLockForWallet } from "./gui-custody-authority";
import type {
  PrepareProofOperationInput,
  ProofOperationRecord,
} from "./proof-db";

interface GuiProofOperationAdapter {
  get(operationId: string): Promise<ProofOperationRecord | null>;
  prepare(input: PrepareProofOperationInput): Promise<ProofOperationRecord>;
  submit(
    operationId: string,
    redeemBinding?: CtfRedeemMintSubmissionBinding,
  ): Promise<ProofOperationRecord>;
  complete(
    operationId: string,
    resultProofs: Parameters<
      CtfProofOperationStore["markProofOperationCompleted"]
    >[1],
  ): Promise<ProofOperationRecord>;
  fail(operationId: string, error: Error): Promise<ProofOperationRecord>;
}

/** Captures one seed-derived wallet while protocol I/O runs without Web Locks. */
export function createCapturedGuiWalletProofOperationStore(
  walletId: string,
): CtfProofOperationStore {
  return ctfProofOperationStore({
    get: (operationId) =>
      withGuiCustodyProfileLockForWallet(walletId, (_context, lock) =>
        getProofOperationUnderLock(lock, operationId),
      ),
    prepare: (input) => prepareProofOperationForWallet(walletId, input),
    submit: (operationId, redeemBinding) =>
      markProofOperationMintSubmittedForWallet(
        walletId,
        operationId,
        redeemBinding,
      ),
    complete: (operationId, resultProofs) =>
      markProofOperationCompletedForWallet(walletId, operationId, resultProofs),
    fail: (operationId, error) =>
      markProofOperationFailedForWallet(walletId, operationId, error),
  });
}

function ctfProofOperationStore(
  adapter: GuiProofOperationAdapter,
): CtfProofOperationStore {
  return {
    getProofOperation: async (operationId) =>
      (await adapter.get(operationId)) as CtfProofOperationRecord | null,
    prepareProofOperation: async (input) =>
      (await adapter.prepare(input)) as CtfProofOperationRecord,
    markProofOperationMintSubmitted: async (operationId, redeemBinding) =>
      (await adapter.submit(
        operationId,
        redeemBinding,
      )) as CtfProofOperationRecord,
    markProofOperationCompleted: async (operationId, resultProofs) =>
      (await adapter.complete(
        operationId,
        resultProofs,
      )) as CtfProofOperationRecord,
    markProofOperationFailed: async (operationId, message, failureCode) =>
      (await adapter.fail(
        operationId,
        mintFailure(message, failureCode),
      )) as CtfProofOperationRecord,
  };
}

function mintFailure(message: string, failureCode?: number): Error {
  const error = new Error(message) as Error & { code?: number };
  error.code = failureCode;
  return error;
}
