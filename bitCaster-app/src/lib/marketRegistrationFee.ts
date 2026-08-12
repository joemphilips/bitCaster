import type { ProofState } from "@cashu/cashu-ts";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import {
  registrationFeeForPolicy,
  requiredMarketCreationOutcomeCollections,
} from "@bitcaster/client-sdk/ctfRegistration";
import {
  createEncryptedWalletBackupV2AssetIdentity,
  type EncryptedWalletBackupV2AssetIdentity,
} from "@bitcaster/client-sdk";
import { hydrateDurableWalletProof } from "@bitcaster/client-sdk/durableWalletOperation";
import type { DurableWalletProofDerivationLocator } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import type { DurableOutgoingCashuTransfer } from "@bitcaster/client-sdk/durableOutgoingCashuTransfer";
import {
  defaultCollateralUnit,
  parseCashuProofUnit,
  type CashuProofUnit,
} from "@bitcaster/client-sdk/marketUnits";
import {
  classifyBrowserDurableOutgoingBearerTransfer,
  executeBrowserDurableOutgoingCashuTransfer,
  readBrowserDurableOutgoingCashuTransfer,
} from "@/lib/browserDurableOutgoingCashuTransfer";
import {
  prepareBrowserDeterministicOutgoingCashuSend,
  restoreBrowserDeterministicOutgoingCashuOutputs,
} from "@/lib/browserDeterministicOutgoingCashu";
import { recoverBrowserFundedAsset } from "@/lib/browserFundedAssetRecovery";
import { captureBrowserMintPersistenceContext, getWalletForUnit } from "@/lib/cashu";
import { MintError, registerCondition } from "@/lib/markets";
import { getBoundedCanonicalRegularProofs, type StoredProof } from "@/stores/proof-db";

export const MAX_CONDITION_REGISTRATION_FEE_SUBUNITS = 1_000_000;
const REGISTRATION_FEE_TOKEN_BYTES_LIMIT = 61_440;
const REGISTRATION_FEE_TOKEN_PROOF_LIMIT = 512;

export interface ConditionRegistrationRequest {
  tags: string[][];
  announcementHex: string;
  collateral: string;
  outcomeCollections?: readonly string[];
}

export interface ConditionRegistrationResult {
  condition_id: string;
  keysets: Record<string, string>;
}

export { registrationFeeForPolicy, requiredMarketCreationOutcomeCollections };

/** Return the active profile's bounded canonical V2 regular balance for this asset. */
export async function getAvailableRegularBalanceSubunits(
  mintUrl: string,
  baseAsset?: string | null,
): Promise<number> {
  const context = captureBrowserMintPersistenceContext();
  const unit = requireCashuProofUnit(defaultCollateralUnit(baseAsset));
  const proofs = await readRegistrationFeeCandidates({
    mintUrl,
    unit,
    scopeId: context.scopeId,
  });
  context.requireCapturedProfile();
  return sumProofs(proofs);
}

/**
 * Pay one condition registration fee through the shared durable outgoing transfer.
 * The exact send token is persisted before the condition endpoint sees it.
 */
export async function registerConditionWithFee(input: {
  mintUrl: string;
  request: ConditionRegistrationRequest;
  requiredFeeSubunits: number;
}): Promise<ConditionRegistrationResult> {
  if (input.requiredFeeSubunits <= 0) {
    return registerCondition(input.request);
  }
  if (
    !Number.isSafeInteger(input.requiredFeeSubunits) ||
    input.requiredFeeSubunits > MAX_CONDITION_REGISTRATION_FEE_SUBUNITS
  ) {
    throw new Error(
      `Condition registration fee must be between 1 and ${MAX_CONDITION_REGISTRATION_FEE_SUBUNITS} subunits.`,
    );
  }

  const feeUnit = requireCashuProofUnit(registrationFeeUnit(input.request));
  const transferId = await buildOperationId(input.request, input.requiredFeeSubunits);
  const context = captureBrowserMintPersistenceContext();
  const terminal = await readBrowserDurableOutgoingCashuTransfer({ transferId, context });
  if (terminal?.deliveryState === "bearer-spent") {
    assertTerminalRegistrationFeeTransfer({
      transfer: terminal,
      transferId,
      mintUrl: input.mintUrl,
      unit: feeUnit,
      amount: input.requiredFeeSubunits,
    });
    return registerCondition(input.request);
  }
  const wallet = await getWalletForUnit(input.mintUrl, feeUnit);
  context.requireCapturedProfile();
  const keepLocators: Array<DurableWalletProofDerivationLocator | null> = [];
  const asset = ordinaryRegistrationFeeAsset(input.mintUrl, feeUnit);
  const transfer = await executeBrowserDurableOutgoingCashuTransfer({
    reuseTransferId: true,
    transfer: {
      transferId,
      mintUrl: input.mintUrl,
      unit: feeUnit,
      requestedAmount: String(input.requiredFeeSubunits),
      deliveryIntent: {
        policy: "bearer-spend-classification",
        tokenBytesLimit: REGISTRATION_FEE_TOKEN_BYTES_LIMIT,
        tokenProofLimit: REGISTRATION_FEE_TOKEN_PROOF_LIMIT,
      },
    },
    preflightFundedAsset: () =>
      preflightRegistrationFeeAsset({
        context,
        asset,
        mintUrl: input.mintUrl,
        requiredAmount: input.requiredFeeSubunits,
        unit: feeUnit,
      }),
    prepareWalletSendOperation: async () => {
      context.requireCapturedProfile();
      const proofs = await readRegistrationFeeCandidates({
        mintUrl: input.mintUrl,
        unit: feeUnit,
        scopeId: context.scopeId,
      });
      context.requireCapturedProfile();
      if (sumProofs(proofs) < input.requiredFeeSubunits) {
        throw insufficientRegistrationFeeError(input.requiredFeeSubunits, feeUnit);
      }
      return prepareBrowserDeterministicOutgoingCashuSend({
        operationId: transferId,
        wallet,
        proofs,
        amount: input.requiredFeeSubunits,
        mintUrl: input.mintUrl,
        unit: feeUnit,
        seed: context.seed,
        keepProofDerivationLocators: keepLocators,
        diagnosticLabel: "Condition registration fee",
      });
    },
    keepProofDerivationLocators: keepLocators,
    wallet,
    restoreExactOutputs: (restore) =>
      restoreBrowserDeterministicOutgoingCashuOutputs({
        wallet,
        restore,
        diagnosticLabel: "Condition registration fee",
      }),
    context,
  });
  return submitRegistrationFeeToken({ transfer, request: input.request, wallet, context });
}

/** Reject an improbable transfer-id collision before a terminal idempotent retry skips wallet I/O. */
function assertTerminalRegistrationFeeTransfer(input: {
  readonly transfer: DurableOutgoingCashuTransfer;
  readonly transferId: string;
  readonly mintUrl: string;
  readonly unit: CashuProofUnit;
  readonly amount: number;
}): void {
  if (
    input.transfer.transferId !== input.transferId ||
    input.transfer.mintUrl !== input.mintUrl ||
    input.transfer.unit !== input.unit ||
    input.transfer.requestedAmount !== String(input.amount) ||
    input.transfer.deliveryIntent.policy !== "bearer-spend-classification" ||
    input.transfer.deliveryIntent.tokenBytesLimit !== REGISTRATION_FEE_TOKEN_BYTES_LIMIT ||
    input.transfer.deliveryIntent.tokenProofLimit !== REGISTRATION_FEE_TOKEN_PROOF_LIMIT
  ) {
    throw new Error("Condition registration fee terminal transfer conflicts with the request.");
  }
}

async function submitRegistrationFeeToken(input: {
  readonly transfer: DurableOutgoingCashuTransfer;
  readonly request: ConditionRegistrationRequest;
  readonly wallet: Awaited<ReturnType<typeof getWalletForUnit>>;
  readonly context: ReturnType<typeof captureBrowserMintPersistenceContext>;
}): Promise<ConditionRegistrationResult> {
  if (input.transfer.deliveryIntent.policy !== "bearer-spend-classification") {
    throw new Error("Condition registration fee transfer has the wrong delivery policy.");
  }
  if (input.transfer.deliveryState === "bearer-spent") {
    return registerCondition(input.request);
  }
  if (input.transfer.token === null) {
    throw new Error("Condition registration fee transfer has no stored token.");
  }

  try {
    const response = await registerCondition({
      ...input.request,
      fee: input.transfer.token.proofs.map(hydrateDurableWalletProof),
    });
    await classifyRegistrationFeeSpend(input);
    return response;
  } catch (error) {
    if (error instanceof MintError && error.code === 13044) {
      const classified = await classifyRegistrationFeeSpend(input);
      if (classified.deliveryState === "bearer-spent") {
        return registerCondition(input.request);
      }
    }
    throw mapRegistrationFeeMintError(error);
  }
}

/** Classify the persisted exact token. This never selects proofs or mints a replacement token. */
async function classifyRegistrationFeeSpend(input: {
  readonly transfer: DurableOutgoingCashuTransfer;
  readonly wallet: Awaited<ReturnType<typeof getWalletForUnit>>;
  readonly context: ReturnType<typeof captureBrowserMintPersistenceContext>;
}): Promise<DurableOutgoingCashuTransfer> {
  if (input.transfer.token === null) {
    throw new Error("Condition registration fee transfer has no stored token.");
  }
  input.context.requireCapturedProfile();
  const states = await input.wallet.checkProofsStates(
    input.transfer.token.proofs.map(({ id, secret }) => ({ id, secret })),
  );
  input.context.requireCapturedProfile();
  return classifyBrowserDurableOutgoingBearerTransfer({
    transfer: input.transfer,
    states: normalizeProofStates(states),
    context: input.context,
  });
}

function mapRegistrationFeeMintError(error: unknown): unknown {
  if (error instanceof MintError && error.code === 13044) {
    return new Error("Registration fee was missing or insufficient.");
  }
  return error;
}

function ordinaryRegistrationFeeAsset(
  mintUrl: string,
  unit: CashuProofUnit,
): EncryptedWalletBackupV2AssetIdentity {
  return createEncryptedWalletBackupV2AssetIdentity({ mintUrl, unit, asset: { kind: "ordinary" } });
}

async function preflightRegistrationFeeAsset(input: {
  readonly context: ReturnType<typeof captureBrowserMintPersistenceContext>;
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly mintUrl: string;
  readonly requiredAmount: number;
  readonly unit: CashuProofUnit;
}): Promise<void> {
  const recovery = await recoverBrowserFundedAsset({
    database: input.context.database,
    scopeId: input.context.scopeId,
    seed: input.context.seed,
    mnemonic: input.context.mnemonic,
    asset: input.asset,
    requiredAmount: BigInt(input.requiredAmount),
    loadPlan: async () =>
      sumProofs(
        await readRegistrationFeeCandidates({
          mintUrl: input.mintUrl,
          unit: input.unit,
          scopeId: input.context.scopeId,
        }),
      ) >= input.requiredAmount
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
      throw insufficientRegistrationFeeError(input.requiredAmount, input.unit);
    case "persistent-error":
      throw new Error("Condition registration fee asset recovery is unavailable.");
    case "not-recoverable":
      throw new Error("Condition registration fee proofs require consolidation.");
    default:
      throw new Error("Condition registration fee recovery outcome is invalid.");
  }
}

async function readRegistrationFeeCandidates(input: {
  readonly mintUrl: string;
  readonly unit: CashuProofUnit;
  readonly scopeId: string;
}): Promise<StoredProof[]> {
  return getBoundedCanonicalRegularProofs(input.mintUrl, {
    unit: input.unit,
    scopeId: input.scopeId,
  });
}

function insufficientRegistrationFeeError(requiredAmount: number, unit: CashuProofUnit): Error {
  return new Error(
    `Not enough regular ${unit} proofs are available for the ${requiredAmount} ${unit} condition registration fee.`,
  );
}

function sumProofs(proofs: readonly StoredProof[]): number {
  return proofs.reduce((total, proof) => total + amountToNumber(proof.amount), 0);
}

function normalizeProofStates(states: readonly ProofState[]) {
  return states.map(({ Y, state }) => ({
    Y,
    state: String(state) as "UNSPENT" | "PENDING" | "SPENT",
  }));
}

function requireCashuProofUnit(value: string | null | undefined): CashuProofUnit {
  const unit = parseCashuProofUnit(value);
  if (!unit) throw new Error(`Unsupported Cashu proof unit '${value ?? ""}'`);
  return unit;
}

async function buildOperationId(
  request: ConditionRegistrationRequest,
  requiredFeeSubunits: number,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      request: stableRegistrationRequest(request),
      requiredFeeSubunits,
      feeUnit: registrationFeeUnit(request),
    }),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `ctf-condition-registration:${bytesToHex(new Uint8Array(digest))}`;
}

function stableRegistrationRequest(
  request: ConditionRegistrationRequest,
): ConditionRegistrationRequest {
  return {
    tags: request.tags.map((tag) => [...tag]),
    announcementHex: request.announcementHex,
    collateral: request.collateral,
    outcomeCollections: request.outcomeCollections ? [...request.outcomeCollections] : undefined,
  };
}

function registrationFeeUnit(request: ConditionRegistrationRequest): string {
  return request.collateral.trim().toLowerCase();
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
