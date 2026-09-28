import { Mint as CashuMint, splitAmount, type Proof } from "@cashu/cashu-ts";
import {
  EngineClientError,
  isDefinitiveOrderSubmissionError,
  type NostrKind1Event,
  type SubmitOrderResponse,
} from "@bitcaster/client-sdk/engineClient";
import {
  loadCtfRangeMintMetadata,
  type CtfRangeMintMetadataClient,
} from "@bitcaster/client-sdk/ctfRangeMintMetadata";
import type { TradeTicket } from "@bitcaster/client-sdk/tradeTicket";
import {
  planCtfRangeCapabilitySource,
  type CtfRangeCapabilitySourcePlan,
  type CtfRangeSourceShortfall,
} from "@bitcaster/client-sdk/ctfRangeCapabilitySourcePlan";
import { planCtfRangeSourceConsolidation } from "@bitcaster/client-sdk/ctfRangeSourceOperation";
import type { CtfRangeSourceMode } from "@bitcaster/client-sdk/ctfRangeSourceOperation";
import { planCtfRangeOrderAuthorization } from "@bitcaster/client-sdk/ctfRangeOrderAuthorization";
import {
  assertCtfRangeOrderFeeConsent,
  composeCtfRangeOrderFeeFacts,
  type CtfRangeOrderFeeFacts,
} from "@bitcaster/client-sdk/ctfRangeOrderFeeComposition";
import { planPersistedCtfRangeOrderAuthorization } from "@bitcaster/client-sdk/ctfRangeOrderProtocol";
import type { DurableCtfRangeAsset } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import { createEncryptedWalletBackupV2AssetIdentity } from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import { toSeed } from "@/lib/bip39";
import { browserWalletScopeIdFromMnemonic } from "@/lib/browserWalletProfile";
import type { MarketDetail } from "@/types/market-detail";
import { getBoundedCanonicalRangeProofsForKeyset } from "@/stores/proof-db";
import { getWalletForMnemonicUnit } from "@/stores/wallet";
import {
  BrowserCtfRangeOrderCoordinator,
  BrowserCtfRangeOrderError,
  buildBrowserCtfRangeOrderPreparation,
  browserCtfRangeOrderErrorMessage,
  type BrowserCtfRangeOrderErrorCode,
  type BrowserCtfRangeRecoveryPage,
} from "./browserCtfRangeOrderCoordinator";
import { createAuthenticatedBrowserEngineClient } from "./markets";
import { readCtfRangePreparation } from "@/stores/ctf-range-order-db";
import { recordBrowserCtfRangeMessage } from "@/stores/ctf-range-order-messages";
import { recoverBrowserFundedAsset } from "./browserFundedAssetRecovery";
import { activeBrowserWalletScopeId } from "./browserWalletProfile";
import { browserRangeSourceAsset } from "./browserCtfRangeOrderSource";
import { ensureWalletKeysetCounterReady } from "./cashu";
import { ensureParticipationScoreForNextMatch } from "./participationScorePayment";
import type { BrowserParticipationScoreRecoveryStatus } from "./browserParticipationScoreDelivery";
import {
  beginBrowserCtfRangeOrderAttempt,
  endBrowserCtfRangeOrderAttempt,
} from "./browserCtfRangeOrderRecoveryWake";

const MINT_METADATA_CACHE_TTL_MS = 30_000;
const MINT_METADATA_CACHE_LIMIT = 64;
const ADMISSION_POLICY_CACHE_TTL_MS = 30_000;
const BROWSER_CONSOLIDATION_ROUNDS_MAX = 256;
type BrowserCtfRangeRecoveryPending = BrowserCtfRangeRecoveryPage["pending"][number];
const ORDER_FAILURE_CODES = new Set<BrowserCtfRangeOrderErrorCode>([
  "invalid-order-type",
  "capability-creation-failed",
  "capability-validation-failed",
  "order-attempt-ended",
  "score-top-up-required",
  "score-top-up-cancelled",
  "settlement-capability-invalid-request",
  "settlement-capability-invalid-artifact",
  "settlement-capability-policy-rejected",
  "settlement-capability-score-required",
  "settlement-capability-not-found",
  "settlement-capability-conflict",
  "settlement-capability-market-unavailable",
  "settlement-capability-request-too-large",
  "settlement-capability-admission-limited",
  "settlement-capability-capacity-exhausted",
  "settlement-capability-admission-unavailable",
  "order-invalid-request",
  "order-invalid-comment",
  "order-market-not-found",
  "order-capability-not-found",
  "order-capability-route-mismatch",
  "order-capability-not-current",
  "order-processing-conflict",
  "order-market-closed",
  "order-submission-rejected",
  "order-submission-uncertain",
]);
const mintMetadataCache = new Map<
  string,
  { expiresAtMs: number; value: ReturnType<typeof loadCtfRangeMintMetadata> }
>();
let admissionPolicyCache:
  | {
      expiresAtMs: number;
      value: ReturnType<
        ReturnType<
          typeof createAuthenticatedBrowserEngineClient
        >["getSettlementCapabilityAdmissionPolicy"]
      >;
    }
  | undefined;

export interface BrowserCtfRangeOrderSubmission {
  readonly market: MarketDetail;
  readonly ticket: TradeTicket;
  readonly clientOrderId: string;
  readonly mintUrl: string;
  readonly mnemonic: string;
  readonly comment?: NostrKind1Event | null;
  readonly consentedFeeFacts: CtfRangeOrderFeeFacts;
  readonly onScoreTopUpRequired?: (input: {
    readonly requiredSats: number;
    readonly balanceSats: number | null;
    readonly recoveryStatus?: BrowserParticipationScoreRecoveryStatus;
  }) => Promise<void>;
}

export type BrowserCtfRangeOrderFeePreview = CtfRangeOrderFeeFacts;

export async function previewBrowserCtfRangeOrderFees(input: {
  readonly market: MarketDetail;
  readonly ticket: TradeTicket;
  readonly mintUrl: string;
}): Promise<BrowserCtfRangeOrderFeePreview> {
  const scopeId = activeBrowserWalletScopeId();
  if (scopeId === null) throw new Error("The active wallet profile is unavailable.");
  const { preparation, maxOutputs } = await loadBrowserRangePreparation({
    ...input,
    clientOrderId: crypto.randomUUID(),
  });
  const selection = await loadBrowserRangeSourceSelection(
    preparation,
    scopeId,
    maxOutputs,
    "cash-funded-preferred",
  );
  switch (selection.kind) {
    case "direct":
      return selection.currentFeeFacts;
    case "unavailable":
      throw insufficientSourceError(selection.shortfall);
    case "consolidation-required": {
      const plan = await loadBrowserRangeConsolidationPlan(
        preparation,
        scopeId,
        selection.offeredCandidates,
      );
      if (plan.kind !== "ready") throw rangeSourcePlanError(plan.kind);
      return browserBoundedFeeFacts(preparation, plan, maxOutputs);
    }
    default:
      return assertNever(selection);
  }
}

export async function submitBrowserCtfRangeOrder(
  input: BrowserCtfRangeOrderSubmission,
): Promise<SubmitOrderResponse> {
  const words = input.mnemonic.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new Error("The wallet seed is unavailable.");

  const seed = toSeed(words);
  const scopeId = browserWalletScopeIdFromMnemonic(input.mnemonic);
  if (scopeId === null) throw new Error("The wallet profile is unavailable.");
  const { engine, preparation, maxOutputs } = await loadBrowserRangePreparation(input);
  const coordinator = createBrowserCtfRangeCoordinator(
    engine,
    input.mnemonic,
    isLoopbackMint(input.mintUrl),
    input.onScoreTopUpRequired,
  );
  beginBrowserCtfRangeOrderAttempt({
    scopeId,
    operationId: preparation.operationId,
  });
  let failed = false;
  try {
    const asset = browserRangeSourceAsset(preparation);
    try {
      await ensureWalletKeysetCounterReady({
        scopeId,
        mintUrl: preparation.mintUrl,
        unit: "msat",
        keyset: preparation.offerKeyset,
        ...(asset.kind === "conditional"
          ? {
              conditionalAsset: {
                conditionId: asset.conditionId,
                outcomeCollection: asset.outcomeCollection,
              },
            }
          : {}),
      });
    } catch {
      throw new BrowserCtfRangeOrderError(
        "source-preparation-failed",
        "The wallet could not finish preparing this order. No order was submitted. Please try again.",
      );
    }
    if (preparation.side === "Sell") {
      try {
        await ensureWalletKeysetCounterReady({
          scopeId,
          mintUrl: preparation.mintUrl,
          unit: "msat",
          keyset: preparation.receiveKeyset,
        });
      } catch {
        throw new BrowserCtfRangeOrderError(
          "source-preparation-failed",
          "The wallet could not finish preparing this order. No order was submitted. Please try again.",
        );
      }
    }
    const consolidated = await consolidateBrowserRangeSource({
      coordinator,
      seed,
      preparation,
      maxOutputs,
      mnemonic: input.mnemonic,
      scopeId,
      consentedFeeFacts: input.consentedFeeFacts,
    });
    return await coordinator.prepareAndSubmit({
      seed,
      preparation,
      candidates: consolidated.candidates,
      collateralCandidates: consolidated.collateralCandidates,
      maxOutputs,
      comment: input.comment ?? null,
      consentedFeeFacts: input.consentedFeeFacts,
      paidConsolidationFeeSubunits: consolidated.paidConsolidationFeeSubunits,
      currentFeeFacts: consolidated.currentFeeFacts,
    });
  } catch (error) {
    failed = true;
    const durableCode =
      error instanceof BrowserCtfRangeOrderError
        ? error.code
        : error instanceof BrowserCtfRangeScoreTopUpRequiredError
          ? "score-top-up-required"
          : error instanceof BrowserCtfRangeScoreTopUpCancelledError
            ? "score-top-up-cancelled"
            : null;
    if (durableCode !== null) {
      const record = await readCtfRangePreparation(scopeId, preparation.operationId);
      if (record !== null) {
        await persistRangeMessages({
          scopeId,
          operationId: preparation.operationId,
          revision: record.revision,
          code: durableCode,
          observedAtMs: Date.now(),
          ...(record.lifecycleState === "terminal" ? { includeRecovery: false } : {}),
        });
      } else if (durableCode === "asset-recovery-failed" && record === null) {
        await persistRangeMessages({
          scopeId,
          operationId: preparation.operationId,
          revision: 0,
          code: durableCode,
          observedAtMs: Date.now(),
        });
      }
    }
    throw error;
  } finally {
    let retainedRecoveryWork = false;
    if (failed) {
      try {
        const record = await readCtfRangePreparation(scopeId, preparation.operationId);
        retainedRecoveryWork = record !== null && record.lifecycleState !== "terminal";
      } catch {
        // Preserve the original failure. A later scheduled pass can inspect the journal.
      }
    }
    endBrowserCtfRangeOrderAttempt({
      scopeId,
      operationId: preparation.operationId,
      retainedRecoveryWork,
    });
  }
}

interface BrowserRangeSourceInput {
  readonly coordinator: BrowserCtfRangeOrderCoordinator;
  readonly seed: Uint8Array;
  readonly preparation: ReturnType<typeof buildBrowserCtfRangeOrderPreparation>;
  readonly mnemonic: string;
  readonly scopeId: string;
  readonly maxOutputs: number;
  readonly consentedFeeFacts: CtfRangeOrderFeeFacts;
}

interface SelectedBrowserRangeSource {
  readonly candidates: readonly Proof[];
  readonly collateralCandidates: readonly Proof[];
  readonly paidConsolidationFeeSubunits: string;
  readonly currentFeeFacts: CtfRangeOrderFeeFacts;
}

/**
 * Applies the preview's selection policy to current custody. A direct source
 * is used at once. Otherwise the offered asset may be recovered, and a
 * fragmented offered holding is consolidated before its fee-funded source.
 */
async function consolidateBrowserRangeSource(
  input: BrowserRangeSourceInput,
): Promise<SelectedBrowserRangeSource> {
  const initial = await loadBrowserRangeSourceSelection(
    input.preparation,
    input.scopeId,
    input.maxOutputs,
    "cash-funded-preferred",
  );
  switch (initial.kind) {
    case "direct":
      return directRangeSource(input, "0", initial);
    case "unavailable":
      switch (initial.shortfall) {
        case "offered":
          break;
        case "collateral":
        case "mint-limits":
          // The held offered value already covers the face. Offered-asset
          // recovery cannot add regular cash or reduce the mint request size,
          // so refuse before it runs.
          throw insufficientSourceError(initial.shortfall);
        default:
          return assertNever(initial.shortfall);
      }
      break;
    case "consolidation-required":
      break;
    default:
      return assertNever(initial);
  }
  const recovered = await recoverRangeSourcePlan(input);
  switch (recovered.kind) {
    case "direct":
      return directRangeSource(input, "0", recovered.selection);
    case "consolidation":
      return executeConsolidationRounds(input, recovered.plan);
    default:
      return assertNever(recovered);
  }
}

function directRangeSource(
  input: Pick<BrowserRangeSourceInput, "preparation" | "consentedFeeFacts">,
  paidConsolidationFeeSubunits: string,
  selection: DirectBrowserRangeSourceSelection,
): SelectedBrowserRangeSource {
  assertApprovedFeeFacts(input, paidConsolidationFeeSubunits, selection.currentFeeFacts);
  return {
    candidates: selection.offeredCandidates,
    collateralCandidates: selection.collateralCandidates,
    paidConsolidationFeeSubunits,
    currentFeeFacts: selection.currentFeeFacts,
  };
}

async function recoverRangeSourcePlan(
  input: BrowserRangeSourceInput,
): Promise<RecoveredRangeSourcePlan> {
  const recovery = await recoverBrowserFundedAsset({
    scopeId: input.scopeId,
    seed: input.seed,
    mnemonic: input.mnemonic,
    asset: rangeSourceAsset(input.preparation),
    requiredAmount: rangeSourceRequiredAmount(input.preparation),
    loadPlan: () => loadBrowserRangeConsolidationPlan(input.preparation, input.scopeId),
    isCurrentProfile: () => activeBrowserWalletScopeId() === input.scopeId,
  });
  switch (recovery.kind) {
    case "ready":
      return { kind: "consolidation", plan: readyRangeSourcePlan(recovery.plan) };
    case "recovered": {
      // Recovered custody gets the same selection policy as a fresh preview.
      const selection = await loadBrowserRangeSourceSelection(
        input.preparation,
        input.scopeId,
        input.maxOutputs,
        "cash-funded-preferred",
      );
      if (selection.kind === "direct") return { kind: "direct", selection };
      return {
        kind: "consolidation",
        plan: postRecoveryRangeSourcePlan(
          await loadBrowserRangeConsolidationPlan(input.preparation, input.scopeId),
        ),
      };
    }
    case "persistent-error":
      throw assetRecoveryFailed();
    case "unavailable":
      throw rangeSourcePlanError("insufficient");
    case "not-recoverable":
      throw rangeSourcePlanError(
        recovery.plan.kind === "ready" ? "insufficient" : recovery.plan.kind,
      );
    default:
      throw new Error("browser range recovery outcome is invalid");
  }
}

type DirectBrowserRangeSourceSelection = Extract<BrowserRangeSourceSelection, { kind: "direct" }>;

type RecoveredRangeSourcePlan =
  | { readonly kind: "direct"; readonly selection: DirectBrowserRangeSourceSelection }
  | { readonly kind: "consolidation"; readonly plan: ReadyRangeSourcePlan };

function postRecoveryRangeSourcePlan(
  plan: Awaited<ReturnType<typeof loadBrowserRangeConsolidationPlan>>,
): ReadyRangeSourcePlan {
  if (plan.kind === "ready") return plan;
  if (plan.kind === "insufficient") throw assetRecoveryFailed();
  throw rangeSourcePlanError(plan.kind);
}

type ReadyRangeSourcePlan = Extract<
  Awaited<ReturnType<typeof loadBrowserRangeConsolidationPlan>>,
  { kind: "ready" }
>;

function readyRangeSourcePlan(
  plan: Awaited<ReturnType<typeof loadBrowserRangeConsolidationPlan>>,
): ReadyRangeSourcePlan {
  if (plan.kind === "ready") return plan;
  throw rangeSourcePlanError(plan.kind);
}

function rangeSourcePlanError(kind: "insufficient" | "not-reducible" | "round-limit") {
  switch (kind) {
    case "insufficient":
      // Consolidation and funded recovery read only the offered asset.
      return insufficientSourceError("offered");
    case "not-reducible":
    case "round-limit":
      return new BrowserCtfRangeOrderError(
        "source-preparation-failed",
        consolidationPlanMessage(kind),
      );
    default:
      return assertNever(kind);
  }
}

function insufficientSourceError(shortfall: CtfRangeSourceShortfall) {
  return new BrowserCtfRangeOrderError(
    "insufficient-funds",
    consolidationPlanMessage("insufficient"),
    shortfall,
  );
}

function assetRecoveryFailed() {
  return new BrowserCtfRangeOrderError(
    "asset-recovery-failed",
    "The wallet could not recover the exact funds for this order.",
  );
}

async function executeConsolidationRounds(
  input: BrowserRangeSourceInput,
  plan: ReadyRangeSourcePlan,
): Promise<SelectedBrowserRangeSource> {
  let current = plan;
  let round = 0;
  let committedFeeSubunits = "0";
  while (current.consolidationRounds.length > 0) {
    if (round >= BROWSER_CONSOLIDATION_ROUNDS_MAX) throw rangeSourcePlanError("round-limit");
    assertApprovedConsolidationFee(input, committedFeeSubunits, current);
    const plannedRound = current.consolidationRounds[0]!;
    const proofs = await selectedRangeSourceProofs(input, plannedRound.inputs);
    await input.coordinator.consolidateRound({
      seed: input.seed,
      preparation: input.preparation,
      round,
      inputs: proofs,
      plannedRound,
    });
    committedFeeSubunits = (BigInt(committedFeeSubunits) + BigInt(plannedRound.fee)).toString();
    current = readyRangeSourcePlan(
      await loadBrowserRangeConsolidationPlan(input.preparation, input.scopeId),
    );
    round += 1;
  }
  assertApprovedConsolidationFee(input, committedFeeSubunits, current);
  // The consented plan is fee-funded from the offered asset. Consolidation can
  // make cash-funded preparation feasible, but that changes the consented
  // source mode and fee asset, so the final selection excludes collateral.
  const final = await loadBrowserRangeSourceSelection(
    input.preparation,
    input.scopeId,
    input.maxOutputs,
    "fee-funded-only",
  );
  switch (final.kind) {
    case "direct":
      return directRangeSource(input, committedFeeSubunits, final);
    case "unavailable":
      throw insufficientSourceError(final.shortfall);
    case "consolidation-required":
      throw rangeSourcePlanError("not-reducible");
    default:
      return assertNever(final);
  }
}

function assertApprovedConsolidationFee(
  input: {
    readonly preparation: ReturnType<typeof buildBrowserCtfRangeOrderPreparation>;
    readonly maxOutputs: number;
    readonly consentedFeeFacts: CtfRangeOrderFeeFacts;
  },
  committedFeeSubunits: string,
  plan: ReadyRangeSourcePlan,
): void {
  assertApprovedFeeFacts(
    input,
    committedFeeSubunits,
    browserBoundedFeeFacts(input.preparation, plan, input.maxOutputs),
  );
}

function assertApprovedFeeFacts(
  input: {
    readonly preparation: ReturnType<typeof buildBrowserCtfRangeOrderPreparation>;
    readonly consentedFeeFacts: CtfRangeOrderFeeFacts;
  },
  committedFeeSubunits: string,
  current: CtfRangeOrderFeeFacts,
): void {
  try {
    assertCtfRangeOrderFeeConsent({
      consented: input.consentedFeeFacts,
      current,
      paidConsolidationFeeSubunits: committedFeeSubunits,
    });
  } catch {
    throw new BrowserCtfRangeOrderError(
      "source-preparation-failed",
      "Wallet proof fees changed. Review the updated trade cost and try again.",
    );
  }
}

function browserFeeFacts(
  preparation: ReturnType<typeof buildBrowserCtfRangeOrderPreparation>,
  plan: Extract<
    CtfRangeCapabilitySourcePlan,
    { kind: "same-keyset-swap" | "mixed-source-ctf-convert" }
  >,
): CtfRangeOrderFeeFacts {
  const sourceMode: CtfRangeSourceMode =
    plan.kind === "mixed-source-ctf-convert"
      ? "mixed-source-ctf-convert"
      : preparation.side === "Buy"
        ? "wallet-send"
        : "conditional-keyset-swap";
  return composeCtfRangeOrderFeeFacts({
    authorizationPlan: planPersistedCtfRangeOrderAuthorization(preparation),
    sourcePlan: plan,
    sourceMode,
    consolidationFeeSubunits: "0",
    settlementAsset: { kind: "regular", unit: "msat" },
    sourcePreparationAsset:
      sourceMode === "conditional-keyset-swap"
        ? browserPreparationAsset(preparation)
        : { kind: "regular", unit: "msat" },
    consolidationAsset: browserPreparationAsset(preparation),
  });
}

function browserBoundedFeeFacts(
  preparation: ReturnType<typeof buildBrowserCtfRangeOrderPreparation>,
  plan: ReadyRangeSourcePlan,
  maxOutputs: number,
): CtfRangeOrderFeeFacts {
  if (plan.consolidationRounds.some((round) => round.outputs.length > maxOutputs)) {
    throw new BrowserCtfRangeOrderError(
      "source-preparation-failed",
      "The selected consolidation exceeds the mint output limit.",
    );
  }
  const authorization = planPersistedCtfRangeOrderAuthorization(preparation);
  const selectedTotal = plan.selectedInputs.reduce((total, amount) => total + BigInt(amount), 0n);
  const sourceFee = BigInt(requireFeeAmount(plan.sourceFee, "source preparation fee"));
  const changeAmount = selectedTotal - BigInt(authorization.inputAmount) - sourceFee;
  if (changeAmount < 0n) throw new Error("bounded source selection is underfunded");
  const changeOutputCount =
    changeAmount === 0n ? 0 : splitAmount(changeAmount, { ...preparation.offerKeyset.keys }).length;
  if (authorization.authorizationAmounts.length + changeOutputCount > maxOutputs) {
    throw new BrowserCtfRangeOrderError(
      "source-preparation-failed",
      "The selected source exceeds the mint output limit.",
    );
  }
  const sourceMode: CtfRangeSourceMode =
    preparation.side === "Buy" ? "wallet-send" : "conditional-keyset-swap";
  return {
    settlementInputFeeSubunits: authorization.participantFeeAllocationUpperBound,
    sourcePreparationFeeSubunits: sourceFee.toString(),
    consolidationFeeSubunits: requireFeeAmount(plan.consolidationFee, "consolidation fee"),
    settlementAsset: { kind: "regular", unit: "msat" },
    sourcePreparationAsset: browserPreparationAsset(preparation),
    consolidationAsset: browserPreparationAsset(preparation),
    sourceMode,
  };
}

function requireFeeAmount(value: string, label: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 20) {
    throw new Error(`${label} is invalid`);
  }
  return BigInt(value).toString();
}

function browserPreparationAsset(
  preparation: ReturnType<typeof buildBrowserCtfRangeOrderPreparation>,
): DurableCtfRangeAsset {
  const asset = browserRangeSourceAsset(preparation);
  return asset.kind === "regular"
    ? { kind: "regular", unit: "msat" }
    : {
        kind: "conditional",
        unit: "msat",
        conditionId: asset.conditionId,
        outcomeCollection: asset.outcomeCollection,
      };
}

function selectedRangeSourceProofs(
  input: { preparation: ReturnType<typeof buildBrowserCtfRangeOrderPreparation>; scopeId: string },
  amounts: readonly string[],
) {
  return selectCanonicalRangeProofAmounts(input, amounts);
}

function rangeSourceAsset(preparation: ReturnType<typeof buildBrowserCtfRangeOrderPreparation>) {
  if (preparation.side === "Buy") {
    return createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: preparation.mintUrl,
      unit: "msat",
      asset: { kind: "ordinary" },
    });
  }
  const offer = preparation.offerKeyset as typeof preparation.offerKeyset & {
    readonly conditionId: string;
    readonly outcomeCollection: string;
    readonly outcomeCollectionId: string;
    readonly registeredAt: number;
  };
  return createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: preparation.mintUrl,
    unit: "msat",
    asset: {
      kind: "ctf",
      conditionId: offer.conditionId,
      outcomeLabel: offer.outcomeCollection,
      outcomeCollectionId: offer.outcomeCollectionId,
      registeredAt: offer.registeredAt,
      finalExpiry: offer.finalExpiry,
    },
  });
}

export class BrowserCtfRangeScoreTopUpRequiredError extends Error {
  readonly requiredSats: number;
  readonly balanceSats: number | null;
  readonly recoveryStatus: BrowserParticipationScoreRecoveryStatus;

  constructor(input: {
    requiredSats: number;
    balanceSats: number | null;
    recoveryStatus?: BrowserParticipationScoreRecoveryStatus;
  }) {
    super(
      input.recoveryStatus === "unavailable"
        ? "Participation Score asset recovery is unavailable. Retry recovery or add funds."
        : "Participation Score balance is insufficient for this capability. Top up and retry to recover the prepared capability.",
    );
    this.name = "BrowserCtfRangeScoreTopUpRequiredError";
    this.requiredSats = input.requiredSats;
    this.balanceSats = input.balanceSats;
    this.recoveryStatus = input.recoveryStatus ?? "insufficient";
  }
}

export class BrowserCtfRangeScoreTopUpCancelledError extends Error {
  constructor() {
    super("Participation Score top-up was cancelled.");
    this.name = "BrowserCtfRangeScoreTopUpCancelledError";
  }
}

function rangeSourceRequiredAmount(
  preparation: ReturnType<typeof buildBrowserCtfRangeOrderPreparation>,
): bigint {
  return BigInt(
    planCtfRangeOrderAuthorization({
      side: preparation.side,
      priceNumerator: preparation.priceNumerator,
      amountSubunits: preparation.amountSubunits,
      divisibility: preparation.divisibility,
      inputFeePpk: preparation.offerKeyset.inputFeePpk,
      offerKeysetKeys: preparation.offerKeyset.keys,
      maxPoolEntries: preparation.maxPoolEntries,
      maxInputs: preparation.maxInputs,
    }).inputAmount,
  );
}

async function loadBrowserRangePreparation(input: {
  readonly market: MarketDetail;
  readonly ticket: TradeTicket;
  readonly clientOrderId: string;
  readonly mintUrl: string;
}) {
  if (input.ticket.request.timeInForce !== "FOK") {
    throw new BrowserCtfRangeOrderError(
      "invalid-order-type",
      browserCtfRangeOrderErrorMessage("invalid-order-type"),
    );
  }
  const engine = createAuthenticatedBrowserEngineClient();
  const mint = new CashuMint(input.mintUrl) as unknown as CtfRangeMintMetadataClient;
  const [policy, mintFacts] = await Promise.all([
    loadCachedAdmissionPolicy(engine),
    loadCachedMintMetadata({
      mint,
      mintUrl: input.mintUrl,
      conditionId: input.market.id,
      observedAt: Math.floor(Date.now() / 1_000),
      allowInsecureLoopbackHttp: isLoopbackMint(input.mintUrl),
    }),
  ]);
  const preparation = buildBrowserCtfRangeOrderPreparation({
    request: {
      ...input.ticket.request,
      clientOrderId: input.clientOrderId,
      marketId: input.ticket.marketId,
      conditionId: input.market.id,
      minimumFillAmountSubunits: input.market.divisibility,
      baseAsset: "sat",
      collateralUnit: "msat",
      divisibility: input.market.divisibility,
      timeInForce: "FOK",
      expiresAt: null,
      mintUrl: input.mintUrl,
    },
    policy,
    mintFacts,
    market: input.market,
    nowUnixSeconds: Math.floor(Date.now() / 1_000),
    randomId: () => crypto.randomUUID(),
  });
  return { engine, preparation, maxOutputs: mintFacts.maxOutputs };
}

function loadCachedAdmissionPolicy(
  engine: ReturnType<typeof createAuthenticatedBrowserEngineClient>,
) {
  const nowMs = Date.now();
  if (admissionPolicyCache && admissionPolicyCache.expiresAtMs > nowMs) {
    return admissionPolicyCache.value;
  }
  const value = engine.getSettlementCapabilityAdmissionPolicy().catch((error: unknown) => {
    if (admissionPolicyCache?.value === value) admissionPolicyCache = undefined;
    throw error;
  });
  admissionPolicyCache = { expiresAtMs: nowMs + ADMISSION_POLICY_CACHE_TTL_MS, value };
  return value;
}

async function loadBrowserRangeConsolidationPlan(
  preparation: ReturnType<typeof buildBrowserCtfRangeOrderPreparation>,
  scopeId: string,
  candidates?: readonly Proof[],
) {
  const proofs =
    candidates ??
    (await getBoundedCanonicalRangeProofsForKeyset(preparation.mintUrl, {
      scopeId,
      unit: "msat",
      keysetId: preparation.offerKeyset.id,
      asset: browserRangeSourceAsset(preparation),
    }));
  const inventory = proofAmountInventory(proofs);
  return planCtfRangeSourceConsolidation({
    preparation,
    inventory,
    maxRounds: BROWSER_CONSOLIDATION_ROUNDS_MAX,
  });
}

type BrowserRangeSourceSelection =
  | {
      readonly kind: "direct";
      readonly offeredCandidates: readonly Proof[];
      readonly collateralCandidates: readonly Proof[];
      readonly currentFeeFacts: CtfRangeOrderFeeFacts;
    }
  | { readonly kind: "consolidation-required"; readonly offeredCandidates: readonly Proof[] }
  | { readonly kind: "unavailable"; readonly shortfall: CtfRangeSourceShortfall };

/**
 * `cash-funded-preferred` lets a held-share Sell pay its preparation fee with
 * regular cash. `fee-funded-only` keeps an already consented fee-funded source.
 */
type BrowserRangeSourcePolicy = "cash-funded-preferred" | "fee-funded-only";

async function loadBrowserRangeSourceSelection(
  preparation: ReturnType<typeof buildBrowserCtfRangeOrderPreparation>,
  scopeId: string,
  maxOutputs: number,
  policy: BrowserRangeSourcePolicy,
): Promise<BrowserRangeSourceSelection> {
  const offeredCandidates = await getBoundedCanonicalRangeProofsForKeyset(preparation.mintUrl, {
    scopeId,
    unit: "msat",
    keysetId: preparation.offerKeyset.id,
    asset: browserRangeSourceAsset(preparation),
  });
  const collateralCandidates = await loadCollateralCandidates(preparation, scopeId, policy);
  const plan = planCtfRangeCapabilitySource({
    side: preparation.side,
    authorizationAmounts: planPersistedCtfRangeOrderAuthorization(preparation).authorizationAmounts,
    offeredKeyset: preparation.offerKeyset,
    collateralKeyset:
      preparation.side === "Sell" ? preparation.receiveKeyset : preparation.offerKeyset,
    complementKeyset: preparation.complementKeyset,
    offeredCandidates,
    collateralCandidates,
    maxInputs: preparation.maxInputs,
    maxOutputs,
  });
  switch (plan.kind) {
    case "same-keyset-swap":
      return {
        kind: "direct",
        offeredCandidates: plan.inputs,
        collateralCandidates: [],
        currentFeeFacts: browserFeeFacts(preparation, plan),
      };
    case "mixed-source-ctf-convert":
      return {
        kind: "direct",
        offeredCandidates: plan.offeredInputs,
        collateralCandidates: plan.collateralInputs,
        currentFeeFacts: browserFeeFacts(preparation, plan),
      };
    case "collateral-ctf-convert":
      // This path never synthesizes a held-share shortfall from collateral.
      return { kind: "unavailable", shortfall: "offered" };
    case "consolidation-required":
      return { kind: "consolidation-required", offeredCandidates };
    case "source-unavailable":
      return { kind: "unavailable", shortfall: plan.shortfall };
    default:
      return assertNever(plan);
  }
}

async function loadCollateralCandidates(
  preparation: ReturnType<typeof buildBrowserCtfRangeOrderPreparation>,
  scopeId: string,
  policy: BrowserRangeSourcePolicy,
): Promise<readonly Proof[]> {
  switch (policy) {
    case "fee-funded-only":
      return [];
    case "cash-funded-preferred":
      // Only a held-share Sell has a separate regular asset for its fee.
      return preparation.side === "Sell"
        ? getBoundedCanonicalRangeProofsForKeyset(preparation.mintUrl, {
            scopeId,
            unit: "msat",
            keysetId: preparation.receiveKeyset.id,
            asset: { kind: "regular" },
          })
        : [];
    default:
      return assertNever(policy);
  }
}

async function selectCanonicalRangeProofAmounts(
  input: { preparation: ReturnType<typeof buildBrowserCtfRangeOrderPreparation>; scopeId: string },
  amounts: readonly string[],
) {
  if (amounts.length < 1 || amounts.length > 256) {
    throw new Error("Proof amount selection limit is invalid");
  }
  const wanted = new Map<number, number>();
  for (const value of amounts) {
    const amount = Number(value);
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(amount)) {
      throw new Error("Proof amount selection is invalid");
    }
    wanted.set(amount, (wanted.get(amount) ?? 0) + 1);
  }
  const proofs = await getBoundedCanonicalRangeProofsForKeyset(input.preparation.mintUrl, {
    scopeId: input.scopeId,
    unit: "msat",
    keysetId: input.preparation.offerKeyset.id,
    asset: browserRangeSourceAsset(input.preparation),
  });
  const selected = proofs.filter((proof) => {
    const amount = Number(proof.amount);
    const remaining = wanted.get(amount) ?? 0;
    if (remaining < 1) return false;
    if (remaining === 1) wanted.delete(amount);
    else wanted.set(amount, remaining - 1);
    return true;
  });
  if (wanted.size > 0 || selected.length !== amounts.length) {
    throw new Error("Proof inventory changed after consolidation planning");
  }
  return selected;
}

function proofAmountInventory(proofs: readonly { amount: unknown }[]) {
  const counts = new Map<number, number>();
  for (const proof of proofs) {
    const amount = Number(proof.amount);
    if (!Number.isSafeInteger(amount) || amount < 1)
      throw new Error("Range proof amount is invalid");
    counts.set(amount, (counts.get(amount) ?? 0) + 1);
  }
  return [...counts]
    .sort(([left], [right]) => right - left)
    .map(([amount, count]) => ({ amount: String(amount), count }));
}

function assertNever(value: never): never {
  throw new Error(`Unsupported browser range source variant: ${String(value)}`);
}

function consolidationPlanMessage(kind: "insufficient" | "not-reducible" | "round-limit"): string {
  switch (kind) {
    case "insufficient":
      return "The wallet does not have enough exact funds for this order.";
    case "not-reducible":
      return "The wallet proofs cannot be reduced under the mint input limit.";
    case "round-limit":
      return "The wallet proof consolidation exceeded its safe round limit.";
  }
}

export async function recoverBrowserCtfRangeOrders(input: {
  readonly mnemonic: string;
  readonly mintUrls: readonly string[];
}): Promise<{
  readonly recovered: number;
  readonly pending: readonly BrowserCtfRangeRecoveryPending[];
}> {
  const words = input.mnemonic.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { recovered: 0, pending: [] };
  const seed = toSeed(words);
  const scopeId = browserWalletScopeIdFromMnemonic(input.mnemonic);
  if (scopeId === null) return { recovered: 0, pending: [] };
  const coordinator = createBrowserCtfRangeCoordinator(
    createAuthenticatedBrowserEngineClient(),
    input.mnemonic,
    input.mintUrls.some(isLoopbackMint),
  );
  let after: Parameters<BrowserCtfRangeOrderCoordinator["recoverPage"]>[0]["after"];
  let recovered = 0;
  const pending: BrowserCtfRangeRecoveryPending[] = [];
  let priorCursor = "";
  do {
    const page = await coordinator.recoverPage({
      seed,
      limit: 64,
      ...(after === undefined ? {} : { after }),
    });
    recovered += page.recoveredOperationIds.length;
    for (const message of page.pending) {
      pending.push(message);
      await persistRecoveryPending(scopeId, message);
    }
    if (page.nextCursor === null) break;
    const cursor = JSON.stringify(page.nextCursor);
    if (cursor === priorCursor) throw new Error("Browser range recovery cursor did not advance.");
    priorCursor = cursor;
    after = page.nextCursor;
    await Promise.resolve();
  } while (after !== undefined);
  return { recovered, pending };
}

export async function recoverBrowserCtfRangeOrder(input: {
  readonly mnemonic: string;
  readonly mintUrls: readonly string[];
  readonly clientOrderId: string;
}): Promise<{
  readonly recovered: number;
  readonly pending: readonly BrowserCtfRangeRecoveryPending[];
}> {
  const words = input.mnemonic.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { recovered: 0, pending: [] };
  const seed = toSeed(words);
  const scopeId = browserWalletScopeIdFromMnemonic(input.mnemonic);
  if (scopeId === null) return { recovered: 0, pending: [] };
  const coordinator = createBrowserCtfRangeCoordinator(
    createAuthenticatedBrowserEngineClient(),
    input.mnemonic,
    input.mintUrls.some(isLoopbackMint),
  );
  const recovery = await coordinator.recoverClientOrder({
    seed,
    clientOrderId: input.clientOrderId,
  });
  for (const message of recovery.pending) {
    await persistRecoveryPending(scopeId, message);
  }
  return { recovered: recovery.recoveredOperationIds.length, pending: recovery.pending };
}

async function persistRecoveryPending(
  scopeId: string,
  pending: BrowserCtfRangeRecoveryPending,
): Promise<void> {
  // Recovery keeps retrying this operation. A durable funds message would
  // report the protocol's normal pre-expiry refund wait as a failure.
  if (pending.code === "awaiting-authorization-expiry") return;
  await persistRangeMessages({
    scopeId,
    operationId: pending.operationId,
    revision: pending.revision,
    code: pending.code,
    observedAtMs: Date.now(),
  });
}

async function persistRangeMessages(input: {
  scopeId: string;
  operationId: string;
  revision: number;
  code: BrowserCtfRangeOrderErrorCode;
  observedAtMs: number;
  includeRecovery?: boolean;
}): Promise<void> {
  const { includeRecovery, ...message } = input;
  const kind = orderFailureCode(message.code) ? "order" : "funds";
  await recordBrowserCtfRangeMessage({ ...message, kind });
  if (kind === "order" && includeRecovery !== false) {
    await recordBrowserCtfRangeMessage({ ...message, code: "recovery-pending", kind: "funds" });
  }
}

function orderFailureCode(code: BrowserCtfRangeOrderErrorCode): boolean {
  return ORDER_FAILURE_CODES.has(code);
}

function createBrowserCtfRangeCoordinator(
  engine: ReturnType<typeof createAuthenticatedBrowserEngineClient>,
  mnemonic: string,
  allowInsecureLoopbackHttp: boolean,
  onScoreTopUpRequired?: BrowserCtfRangeOrderSubmission["onScoreTopUpRequired"],
): BrowserCtfRangeOrderCoordinator {
  return new BrowserCtfRangeOrderCoordinator({
    wallet: (mintUrl) => getWalletForMnemonicUnit(mintUrl, "msat", mnemonic),
    engine,
    allowInsecureLoopbackHttp,
    beforeCreateCapability: async ({ mintUrl, requiredScore }) => {
      while (true) {
        const score = await ensureParticipationScoreForNextMatch({
          mintUrl,
          requiredScore,
        });
        switch (score.kind) {
          case "disabled":
          case "sufficient":
          case "paid":
            return;
          case "needs-regular-top-up":
            break;
          default:
            throw new Error("Participation Score preflight result is invalid");
        }
        if (onScoreTopUpRequired === undefined) {
          throw new BrowserCtfRangeScoreTopUpRequiredError({
            requiredSats: score.requiredSats,
            balanceSats: score.balanceSats,
            recoveryStatus: score.recoveryStatus,
          });
        }
        await onScoreTopUpRequired({
          requiredSats: score.requiredSats,
          balanceSats: score.balanceSats,
          recoveryStatus: score.recoveryStatus,
        });
      }
    },
    isDefinitiveOrderRejection: (error) =>
      error instanceof EngineClientError && isDefinitiveOrderSubmissionError(error),
  });
}

function isLoopbackMint(mintUrl: string): boolean {
  const hostname = new URL(mintUrl).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function loadCachedMintMetadata(
  input: Parameters<typeof loadCtfRangeMintMetadata>[0],
): ReturnType<typeof loadCtfRangeMintMetadata> {
  const key = `${new URL(input.mintUrl).toString()}\0${input.conditionId}`;
  const nowMs = Date.now();
  const cached = mintMetadataCache.get(key);
  if (cached && cached.expiresAtMs > nowMs) {
    mintMetadataCache.delete(key);
    mintMetadataCache.set(key, cached);
    return cached.value;
  }
  if (cached) mintMetadataCache.delete(key);
  const value = loadCtfRangeMintMetadata(input).catch((error: unknown) => {
    if (mintMetadataCache.get(key)?.value === value) mintMetadataCache.delete(key);
    throw error;
  });
  mintMetadataCache.set(key, { expiresAtMs: nowMs + MINT_METADATA_CACHE_TTL_MS, value });
  while (mintMetadataCache.size > MINT_METADATA_CACHE_LIMIT) {
    const oldest = mintMetadataCache.keys().next().value;
    if (oldest === undefined) break;
    mintMetadataCache.delete(oldest);
  }
  return value;
}
