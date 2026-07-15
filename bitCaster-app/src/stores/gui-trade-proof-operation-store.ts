import type {
  CtfPrepareProofOperationInput,
  CtfProofOperationStore,
} from "@bitcaster/client-sdk/ctfSplit";
import {
  addDurableWalletProofTransitionMetadata,
  createDurableWalletProofTransition,
  type DurableWalletProofResultDisposition,
  type DurableWalletProofTransition,
} from "@bitcaster/client-sdk/durableWalletProofTransition";
import type { Proof } from "@cashu/cashu-ts";
import type {
  PrepareProofOperationInput as SwapPrepareProofOperationInput,
  ProofOperationRecord as SwapProofOperationRecord,
  ProofOperationStore,
} from "@bitcaster/swap-protocol/atomicSwap";
import { resolveConditionalProofMetadata } from "../lib/conditionalKeysetMetadata";
import { splitMarketId } from "../lib/orderStatus";
import type { ActiveSwap } from "./activeSwaps";
import {
  getProofOperationUnderLock,
  type ProofOperationRecord,
} from "./proof-db";
import {
  completeGuiProofOperationWithSessionUnderLock,
  markGuiProofOperationMintSubmittedWithSessionUnderLock,
  prepareGuiProofOperationWithSessionUnderLock,
  resolveGuiProofOperationPreparation,
  withGuiSwapSessionOwnership,
} from "./swap-session-db";
import type { GuiWalletLockContext } from "./gui-wallet-lock";

type GuiPrepareProofOperationInput =
  | SwapPrepareProofOperationInput
  | CtfPrepareProofOperationInput;

type GuiProofPolicyFactory = (
  input: GuiPrepareProofOperationInput,
  swap: ActiveSwap,
) => DurableWalletProofTransition;

export function localLockGuiProofOperationStore(
  walletId: string,
  swap: ActiveSwap,
): ProofOperationStore {
  return createUnlockedGuiSwapProofOperationStore(
    localLockProofPolicy,
    walletId,
    swap,
  );
}

export function externalClaimGuiProofOperationStore(
  walletId: string,
  swap: ActiveSwap,
): ProofOperationStore {
  return createUnlockedGuiSwapProofOperationStore(
    externalClaimProofPolicy,
    walletId,
    swap,
  );
}

export function ctfGuiProofOperationStore(
  walletId: string,
  swap: ActiveSwap,
): CtfProofOperationStore {
  return createUnlockedGuiCtfProofOperationStore(walletId, swap);
}

export function regularSplitGuiProofOperationStore(
  walletId: string,
  swap: ActiveSwap,
): CtfProofOperationStore {
  return createUnlockedGuiCtfProofOperationStore(walletId, swap);
}

function createUnlockedGuiSwapProofOperationStore(
  policyFactory: GuiProofPolicyFactory | undefined,
  walletId: string,
  pinnedSwap: ActiveSwap,
): ProofOperationStore {
  return {
    getProofOperation: (operationId) =>
      withProofOperationLock(walletId, pinnedSwap, (lock) =>
        readGuiProofOperation(operationId, lock),
      ) as Promise<SwapProofOperationRecord | null>,
    prepareProofOperation: async (input) => {
      const prepared = await prepareGuiProofOperationInput(
        input,
        policyFactory,
        pinnedSwap,
      );
      const resolved = await resolveGuiProofOperationPreparation(
        prepared,
        pinnedSwap,
      );
      return withProofOperationLock(walletId, pinnedSwap, (lock) =>
        prepareGuiProofOperationWithSessionUnderLock(
          lock,
          prepared,
          pinnedSwap,
          resolved,
        ),
      ) as Promise<SwapProofOperationRecord>;
    },
    markProofOperationMintSubmitted: (operationId) =>
      withProofOperationLock(walletId, pinnedSwap, (lock) =>
        markGuiProofOperationForCurrentSwap(operationId, lock, pinnedSwap),
      ) as Promise<SwapProofOperationRecord>,
    markProofOperationCompleted: (operationId, resultProofs) =>
      withProofOperationLock(walletId, pinnedSwap, (lock) =>
        completeGuiProofOperationForCurrentSwap(
          operationId,
          resultProofs,
          lock,
          pinnedSwap,
        ),
      ) as Promise<SwapProofOperationRecord>,
  };
}

function createUnlockedGuiCtfProofOperationStore(
  walletId: string,
  pinnedSwap: ActiveSwap,
): CtfProofOperationStore {
  const store = createUnlockedGuiSwapProofOperationStore(
    undefined,
    walletId,
    pinnedSwap,
  );
  return store as CtfProofOperationStore;
}

function withProofOperationLock<T>(
  walletId: string,
  swap: ActiveSwap,
  action: (lock: GuiWalletLockContext) => Promise<T>,
): Promise<T> {
  return withGuiSwapSessionOwnership(swap.tradeId, action, walletId);
}

async function prepareGuiProofOperationInput(
  input: GuiPrepareProofOperationInput,
  policyFactory: GuiProofPolicyFactory | undefined,
  swap: ActiveSwap,
) {
  const policy = policyFactory?.(input, swap);
  const metadata = policy
    ? addDurableWalletProofTransitionMetadata(
        await proofOperationMetadata(input, swap),
        policy,
      )
    : input.metadata;
  return { ...input, metadata };
}

async function markGuiProofOperationForCurrentSwap(
  operationId: string,
  lock: GuiWalletLockContext,
  pinnedSwap: ActiveSwap,
) {
  const { operation, swap } = await currentGuiProofOperation(
    operationId,
    lock,
    pinnedSwap,
  );
  return markGuiProofOperationMintSubmittedWithSessionUnderLock(
    lock,
    operationId,
    swap,
    operation.mintUrl,
  );
}

async function completeGuiProofOperationForCurrentSwap(
  operationId: string,
  resultProofs: Record<string, Proof[]>,
  lock: GuiWalletLockContext,
  pinnedSwap: ActiveSwap,
) {
  const { operation, swap } = await currentGuiProofOperation(
    operationId,
    lock,
    pinnedSwap,
  );
  return completeGuiProofOperationWithSessionUnderLock(
    lock,
    operationId,
    resultProofs,
    swap,
    operation.mintUrl,
  );
}

async function currentGuiProofOperation(
  operationId: string,
  lock: GuiWalletLockContext,
  pinnedSwap: ActiveSwap,
) {
  const swap = requireBoundGuiSwap(operationId, pinnedSwap);
  const operation = await readGuiProofOperation(operationId, lock);
  if (!operation || operation.durableTradeRecovery?.tradeId !== swap.tradeId) {
    throw new Error("Proof operation has no exact durable GUI binding");
  }
  return { operation, swap };
}

function requireBoundGuiSwap(
  operationId: string,
  pinnedSwap: ActiveSwap,
): ActiveSwap {
  const tradeId = operationId.split("/browser/")[0] ?? "";
  if (pinnedSwap.tradeId !== tradeId) {
    throw new Error("Proof operation does not match the pinned GUI swap");
  }
  return pinnedSwap;
}

function readGuiProofOperation(
  operationId: string,
  lock: GuiWalletLockContext,
): Promise<ProofOperationRecord | null> {
  return getProofOperationUnderLock(lock, operationId);
}

async function proofOperationMetadata(
  input: GuiPrepareProofOperationInput,
  swap: ActiveSwap,
): Promise<Record<string, unknown>> {
  const metadata = structuredClone(input.metadata ?? {});
  if (input.kind !== "conditional-keyset-swap") return metadata;
  const market = splitMarketId(swap.marketId);
  if (!market) throw new Error(`Invalid market id ${swap.marketId}`);
  const outcomeByKeyset = await resolveInputOutcomeMetadata(
    input,
    market.conditionId,
  );
  return { ...metadata, conditionId: market.conditionId, outcomeByKeyset };
}

async function resolveInputOutcomeMetadata(
  input: GuiPrepareProofOperationInput,
  conditionId: string,
) {
  const inputByKeyset = new Map(input.inputs.map((proof) => [proof.id, proof]));
  return Object.fromEntries(
    await Promise.all(
      [...inputByKeyset].map(async ([keysetId, proof]) => {
        if (!keysetId) {
          throw new Error("Conditional proof operation has no input keyset");
        }
        const outcome = await resolveConditionalProofMetadata(
          input.mintUrl,
          proof,
          conditionId,
        );
        return [keysetId, outcome] as const;
      }),
    ),
  );
}

function localLockProofPolicy(
  input: GuiPrepareProofOperationInput,
): DurableWalletProofTransition {
  switch (input.kind) {
    case "swap-lock":
      assertExactOutputLabels(input, ["send", "keep"]);
      return policyForOutputGroups(input, "wallet", swapLockDisposition);
    case "conditional-keyset-swap":
      assertConditionalLockOutputLabels(input);
      return policyForOutputGroups(input, "wallet", conditionalLockDisposition);
    default:
      throw new Error(`Unexpected local-lock operation kind ${input.kind}`);
  }
}

function swapLockDisposition(
  label: string,
): DurableWalletProofResultDisposition {
  switch (label) {
    case "send":
      return { kind: "operation" };
    case "keep":
      return { kind: "wallet", asset: "regular", reservedBy: null };
    default:
      throw new Error(`Unexpected swap-lock output group ${label}`);
  }
}

function conditionalLockDisposition(
  label: string,
): DurableWalletProofResultDisposition {
  switch (label) {
    case "lock":
      return { kind: "operation" };
    case "change":
      return { kind: "wallet", asset: "conditional", reservedBy: null };
    default:
      throw new Error(`Unexpected conditional-lock output group ${label}`);
  }
}

function externalClaimProofPolicy(
  input: GuiPrepareProofOperationInput,
): DurableWalletProofTransition {
  if (input.kind !== "swap-claim" && input.kind !== "conditional-keyset-swap") {
    throw new Error(`Unexpected external-claim operation kind ${input.kind}`);
  }
  assertExactOutputLabels(input, ["keep"]);
  const asset =
    input.kind === "conditional-keyset-swap" ? "conditional" : "regular";
  return policyForOutputGroups(input, "external", (label) => {
    if (label !== "keep") {
      throw new Error(`Unexpected claim output group ${label}`);
    }
    return { kind: "wallet", asset, reservedBy: null };
  });
}

function assertConditionalLockOutputLabels(
  input: GuiPrepareProofOperationInput,
): void {
  const labels = Object.keys(input.outputs);
  if (
    !labels.includes("lock") ||
    labels.some((label) => label !== "lock" && label !== "change")
  ) {
    throw new Error("Conditional lock output groups are invalid");
  }
}

function assertExactOutputLabels(
  input: GuiPrepareProofOperationInput,
  expected: readonly string[],
): void {
  const actual = Object.keys(input.outputs).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((label, index) => label !== sortedExpected[index])
  ) {
    throw new Error(`${input.kind} output groups are invalid`);
  }
}

function policyForOutputGroups(
  input: GuiPrepareProofOperationInput,
  inputSource: "wallet" | "external",
  disposition: (label: string) => DurableWalletProofResultDisposition,
): DurableWalletProofTransition {
  const labels = Object.keys(input.outputs);
  return createDurableWalletProofTransition({
    inputSource,
    plannedOutputLabels: labels,
    resultGroups: Object.fromEntries(
      labels.map((label) => [label, disposition(label)]),
    ),
    passthroughResultGroups: passthroughResultGroups(input, labels),
  });
}

function passthroughResultGroups(
  input: GuiPrepareProofOperationInput,
  outputLabels: readonly string[],
): Record<string, Proof[]> {
  const value = input.metadata?.unselectedProofs;
  if (value === undefined) return {};
  if (!Array.isArray(value)) {
    throw new Error("Proof operation unselected proofs are invalid");
  }
  const proofs = value as Proof[];
  if (proofs.length === 0) return {};
  const resultLabel = outputLabels.includes("keep")
    ? "keep"
    : outputLabels.includes("refund")
      ? "refund"
      : null;
  if (!resultLabel) {
    throw new Error("Proof passthroughs have no wallet result group");
  }
  return { [resultLabel]: proofs };
}
