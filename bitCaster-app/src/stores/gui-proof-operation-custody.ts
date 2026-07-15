import {
  type DurableCustodyRecord,
  type DurableCustodyTransaction,
  type DurableProofOperationFacts,
} from "@bitcaster/client-sdk/durableCustody";
import {
  resolveDurableCustodyProofOperationFacts,
  type DurableCustodyProofOperationInput,
} from "@bitcaster/client-sdk/durableCustodyProofOperation";
import {
  bindDurableCustodyProofOperation,
  createDurableCustodyProofOperation,
  deriveDurableCustodyProofResultFingerprint,
} from "@bitcaster/client-sdk/durableCustodyProofOperationRecord";
import {
  createDurableTradeProofOperationLink,
  validateDurableProofOperationLink,
  type DurableTradeProofOperationLink,
} from "@bitcaster/client-sdk/durableTradeRecovery";
import { requireDurableWalletProofTransition } from "@bitcaster/client-sdk/durableWalletProofTransition";
import type { Proof } from "@cashu/cashu-ts";
import { normalizeUrl } from "../lib/url";
import type { ActiveSwap } from "./activeSwaps";
import { sameValue } from "./durable-custody-dexie-model";
import {
  acquireGuiCustodyAuthority,
  guiWalletContextFromHeldLock,
  resolveGuiCustodyMintKeys,
  type GuiCustodyAuthority,
} from "./gui-custody-authority";
import type { GuiWalletLockContext } from "./gui-wallet-lock";
import {
  createGuiSwapSessionRecord,
  durableSessionFromActiveSwap,
  durableStageForGuiProofOperation,
  MAX_ACTIVE_GUI_SWAP_SESSIONS,
} from "./gui-swap-session-record";
import {
  finalizeGuiNativeProofDelta,
  guiNativeProofAuthority,
  prepareGuiNativeProofDelta,
  requireGuiNativeProofInputAuthority,
  reserveGuiNativeInputProofs,
} from "./gui-native-proof-custody";
import {
  prepareGuiCustodyUnitOfWork,
  readGuiCustodyOperationSnapshot,
  readGuiCustodyNativeSnapshot,
  type GuiCustodyNativeSnapshot,
} from "./gui-custody-unit-of-work";
import { commitGuiDurableStorageCustodyUnitOfWork } from "./gui-durable-storage-custody-unit-of-work";
import {
  ensureDurableSwapStorage,
  locateStoredProofs,
  type PrepareProofOperationInput,
  type ProofOperationRecord,
  type StoredProof,
} from "./proof-db";

/** Atomically writes the mint-operation intent and its GUI recovery session. */
export async function prepareGuiProofOperationWithSessionUnderLock(
  lock: GuiWalletLockContext,
  input: PrepareProofOperationInput,
  swap: ActiveSwap,
  resolved: GuiProofOperationPreparation,
): Promise<ProofOperationRecord> {
  const context = guiWalletContextFromHeldLock(lock);
  const session = await requireActiveDurableSession(
    swap,
    input.mintUrl,
    "prepare",
  );
  assertGuiProofOperationPreparation(resolved, input, session);
  await ensureDurableSwapStorage(context.walletId);
  const inputProofTransition = requireDurableWalletProofTransition(
    input.metadata ?? {},
    Object.keys(input.outputs),
  );
  const inputProofAuthority = guiNativeProofAuthority(
    input,
    inputProofTransition,
  );
  const snapshot = await readGuiCustodyNativeSnapshot(
    input.operationId,
    swap.tradeId,
    context.walletId,
    undefined,
    locateStoredProofs(
      inputProofAuthority,
      input.mintUrl,
      input.metadata?.unit as string | undefined,
    ),
  );
  const durableTradeRecovery = resolveGuiProofOperationLink(
    swap,
    input,
    snapshot.operation,
  );
  const operationInput = canonicalGuiProofOperationInput(
    input,
    durableTradeRecovery,
  );
  const facts = resolved.facts;
  const authority = await acquireGuiCustodyAuthority(lock);
  const custodyRecord = createDurableCustodyProofOperation({
    scope: authority.scope,
    operation: operationInput,
    facts,
    inventoryAccountId: null,
  });
  const plan = await authority.store.prepareTransaction(
    {
      scope: authority.scope,
      owner: authority.owner,
      operationIds: [custodyRecord.operation.operationId],
    },
    (transaction) =>
      bindDurableCustodyProofOperation(transaction, custodyRecord),
  );
  const nextOperation = createGuiPreparedProofOperation(
    input,
    durableTradeRecovery,
    custodyRecord.operation.operationId,
    snapshot.operation,
    context.walletId,
  );
  const proofTransition = requireDurableWalletProofTransition(
    nextOperation.metadata,
    Object.keys(nextOperation.outputs),
  );
  requireGuiNativeProofInputAuthority(
    nextOperation,
    snapshot.proofs,
    proofTransition,
    "available",
    swap.tradeId,
  );
  const nextProofs =
    proofTransition.inputSource === "wallet"
      ? reserveGuiNativeInputProofs(
          input.operationId,
          input.mintUrl,
          guiNativeProofAuthority(nextOperation, proofTransition),
          snapshot.proofs,
          context.walletId,
          swap.tradeId,
        )
      : undefined;
  const prepared = await prepareGuiCustodyUnitOfWork({
    authority,
    plan,
    snapshot,
    nextOperation,
    nextProofs,
    nextSession: createGuiSwapSessionRecord(
      swap,
      session,
      context.walletId,
      snapshot.session,
      durableTradeRecovery,
    ),
    activeSessionLimit: MAX_ACTIVE_GUI_SWAP_SESSIONS,
  });
  await commitGuiDurableStorageCustodyUnitOfWork({
    walletLock: lock,
    tradeId: swap.tradeId,
    prepared,
  });
  return nextOperation;
}

export interface GuiProofOperationPreparation {
  operation: DurableCustodyProofOperationInput;
  facts: DurableProofOperationFacts;
  session: Awaited<ReturnType<typeof requireActiveDurableSession>>;
}

/**
 * Resolves mint-owned key authority before the caller acquires the profile
 * Web Lock. The locked phase revalidates these exact artifacts before commit.
 */
export async function resolveGuiProofOperationPreparation(
  input: PrepareProofOperationInput,
  swap: ActiveSwap,
): Promise<GuiProofOperationPreparation> {
  const session = await requireActiveDurableSession(
    swap,
    input.mintUrl,
    "prepare",
  );
  const operation = canonicalGuiProofOperationInput(
    input,
    durableLinkForGuiProofOperation(swap, input),
  );
  const facts = await resolveDurableCustodyProofOperationFacts({
    operation,
    session,
    resolveMintKeys: resolveGuiCustodyMintKeys,
    requireDleq: true,
  });
  return { operation, facts, session };
}

function assertGuiProofOperationPreparation(
  resolved: GuiProofOperationPreparation,
  input: PrepareProofOperationInput,
  session: GuiProofOperationPreparation["session"],
): void {
  const expected = canonicalGuiProofOperationInput(
    input,
    durableLinkForGuiProofOperation(session, input),
  );
  if (
    !sameValue(resolved.operation, expected) ||
    !sameValue(resolved.session, session)
  ) {
    throw new Error("GUI proof-operation mint authority became stale");
  }
}

/** Atomically records fresh mint outputs and the session reconciliation cursor. */
export async function completeGuiProofOperationWithSessionUnderLock(
  lock: GuiWalletLockContext,
  operationId: string,
  resultProofs: Record<string, Proof[]>,
  swap: ActiveSwap,
  mintUrl: string,
): Promise<ProofOperationRecord> {
  const context = guiWalletContextFromHeldLock(lock);
  const session = await requireActiveDurableSession(swap, mintUrl, "complete");
  await ensureDurableSwapStorage(context.walletId);
  const current = await readGuiCustodyOperationSnapshot(
    operationId,
    context.walletId,
  );
  const currentOperation = requireGuiProofOperation(current, operationId);
  const draftProofDelta = await prepareGuiNativeProofDelta(
    currentOperation,
    resultProofs,
    swap,
  );
  const snapshot = await readGuiCustodyOperationSnapshot(
    operationId,
    context.walletId,
    draftProofDelta.nextProofs,
    swap.tradeId,
  );
  const operation = requireGuiProofOperation(snapshot, operationId);
  if (!sameValue(currentOperation, operation)) {
    throw new Error("GUI proof operation changed while preparing its result");
  }
  const proofTransition = requireDurableWalletProofTransition(
    operation.metadata,
    Object.keys(operation.outputs),
  );
  requireGuiNativeProofInputAuthority(
    operation,
    snapshot.proofs,
    proofTransition,
    "owned",
  );
  const proofDelta = finalizeGuiNativeProofDelta(
    draftProofDelta,
    snapshot.proofs,
  );
  assertExactInputDeletion(operation, proofTransition.inputSource, proofDelta);
  const link = requireGuiProofOperationLink(operation, swap.tradeId);
  const durableTradeRecovery = { ...link, state: "reconciled" as const };
  const resultFingerprint =
    deriveDurableCustodyProofResultFingerprint(resultProofs);
  const authority = await acquireGuiCustodyAuthority(lock);
  const plan = await prepareGuiCustodyTransition(
    authority,
    operation,
    (record, transaction) => {
      if (record.operation.result.state === "applied") {
        if (record.operation.result.resultFingerprint !== resultFingerprint) {
          throw new Error("GUI custody result conflicts with committed output");
        }
        return;
      }
      const outputPlanFingerprint =
        record.operation.outputPlan.outputPlanFingerprint;
      const resultHandle = `result:${resultFingerprint}`;
      transaction.stageVerifiedResult({
        operationId: record.operation.operationId,
        outputPlanFingerprint,
        resultHandle,
        resultFingerprint,
      });
      transaction.applyVerifiedResult({
        operationId: record.operation.operationId,
        outputPlanFingerprint,
        resultHandle,
        resultFingerprint,
      });
    },
  );
  const nextOperation = completedGuiProofOperation(
    operation,
    resultProofs,
    durableTradeRecovery,
  );
  const prepared = await prepareGuiCustodyUnitOfWork({
    authority,
    plan,
    snapshot,
    nextOperation,
    deleteProofs: proofDelta.deleteProofs,
    nextProofs: proofDelta.nextProofs,
    nextSession: createGuiSwapSessionRecord(
      swap,
      session,
      context.walletId,
      snapshot.session,
      durableTradeRecovery,
    ),
  });
  await commitGuiDurableStorageCustodyUnitOfWork({
    walletLock: lock,
    tradeId: swap.tradeId,
    prepared,
  });
  return nextOperation;
}

function assertExactInputDeletion(
  operation: ProofOperationRecord,
  inputSource: "wallet" | "external",
  proofDelta: { deleteProofs: StoredProof[]; nextProofs: StoredProof[] },
): void {
  const expected =
    inputSource === "wallet"
      ? operation.inputs.map(({ secret }) => secret).sort()
      : [];
  const actual = proofDelta.deleteProofs.map(({ secret }) => secret).sort();
  if (!sameValue(expected, actual)) {
    throw new Error("GUI proof result does not replace its exact input set");
  }
}

/** Atomically advances the proof ledger and SDK session before a mint request. */
export async function markGuiProofOperationMintSubmittedWithSessionUnderLock(
  lock: GuiWalletLockContext,
  operationId: string,
  swap: ActiveSwap,
  mintUrl: string,
): Promise<ProofOperationRecord> {
  const context = guiWalletContextFromHeldLock(lock);
  const session = await requireActiveDurableSession(swap, mintUrl, "submit");
  await ensureDurableSwapStorage(context.walletId);
  const snapshot = await readGuiCustodyNativeSnapshot(
    operationId,
    swap.tradeId,
    context.walletId,
  );
  const operation = requireGuiProofOperation(snapshot, operationId);
  if (operation.state === "completed" || operation.state === "Failed") {
    throw new Error(`Cannot submit terminal proof operation ${operationId}`);
  }
  const link = requireGuiProofOperationLink(operation, swap.tradeId);
  const durableTradeRecovery = { ...link, state: "mint-submitted" as const };
  const authority = await acquireGuiCustodyAuthority(lock);
  const plan = await prepareGuiCustodyTransition(
    authority,
    operation,
    (record, transaction) => {
      if (record.operation.state === "dispatch-intent") {
        transaction.transitionOperation({
          operationId: record.operation.operationId,
          transition: { kind: "transport-attempted" },
        });
      } else if (record.operation.state !== "transport-attempted") {
        throw new Error("GUI custody cannot submit from its current state");
      }
    },
  );
  const nextOperation: ProofOperationRecord = {
    ...operation,
    state: "mint-submitted",
    durableTradeRecovery,
    durableOperationId: durableTradeRecovery.operationId,
    durableTradeId: durableTradeRecovery.tradeId,
    lastError: null,
    failureCode: undefined,
    updatedAt: Date.now(),
  };
  const prepared = await prepareGuiCustodyUnitOfWork({
    authority,
    plan,
    snapshot,
    nextOperation,
    nextSession: createGuiSwapSessionRecord(
      swap,
      session,
      context.walletId,
      snapshot.session,
      durableTradeRecovery,
    ),
  });
  await commitGuiDurableStorageCustodyUnitOfWork({
    walletLock: lock,
    tradeId: swap.tradeId,
    prepared,
  });
  return nextOperation;
}

export async function prepareGuiCustodyTransition(
  authority: GuiCustodyAuthority,
  operation: ProofOperationRecord,
  apply: (
    record: DurableCustodyRecord,
    transaction: DurableCustodyTransaction,
  ) => void,
) {
  const custodyOperationId = operation.custodyOperationId;
  if (!custodyOperationId) {
    throw new Error("GUI proof operation has no custody operation identity");
  }
  return authority.store.prepareTransaction(
    {
      scope: authority.scope,
      owner: authority.owner,
      operationIds: [custodyOperationId],
    },
    (transaction) => {
      const record = transaction.getOperation(custodyOperationId);
      if (!record)
        throw new Error("GUI canonical custody operation is missing");
      apply(record, transaction);
      transaction.rebuildActiveWorkIndex();
    },
  );
}

function canonicalGuiProofOperationInput(
  input: PrepareProofOperationInput,
  durableTradeRecovery: DurableTradeProofOperationLink,
): DurableCustodyProofOperationInput {
  return {
    ...input,
    mintUrl: normalizeUrl(input.mintUrl),
    metadata: structuredClone(input.metadata ?? {}),
    durableTradeRecovery,
  };
}

function resolveGuiProofOperationLink(
  swap: ActiveSwap,
  input: PrepareProofOperationInput,
  existing: ProofOperationRecord | undefined,
): DurableTradeProofOperationLink {
  const expected = durableLinkForGuiProofOperation(swap, input);
  const current = existing?.durableTradeRecovery;
  if (!current) {
    if (existing && existing.state !== "prepared") {
      throw new Error("Existing GUI proof operation has no durable binding");
    }
    return expected;
  }
  if (
    validateDurableProofOperationLink(current) !== null ||
    !sameValue(linkIdentity(current), linkIdentity(expected)) ||
    existing?.durableOperationId !== current.operationId ||
    existing.durableTradeId !== current.tradeId
  ) {
    throw new Error("Existing GUI proof operation has a foreign binding");
  }
  return structuredClone(current);
}

function createGuiPreparedProofOperation(
  input: PrepareProofOperationInput,
  durableTradeRecovery: DurableTradeProofOperationLink,
  custodyOperationId: string,
  existing: ProofOperationRecord | undefined,
  walletId: string,
): ProofOperationRecord {
  const exact = {
    kind: input.kind,
    mintUrl: normalizeUrl(input.mintUrl),
    inputs: input.inputs,
    outputs: input.outputs,
    metadata: input.metadata ?? {},
  };
  if (
    existing &&
    (!sameValue(exact, {
      kind: existing.kind,
      mintUrl: existing.mintUrl,
      inputs: existing.inputs,
      outputs: existing.outputs,
      metadata: existing.metadata,
    }) ||
      (existing.custodyOperationId !== undefined &&
        existing.custodyOperationId !== custodyOperationId))
  ) {
    throw new Error("Existing GUI proof operation has foreign exact artifacts");
  }
  const now = Date.now();
  return {
    walletId,
    operationId: input.operationId,
    kind: input.kind,
    state: existing?.state ?? "prepared",
    mintUrl: exact.mintUrl,
    inputs: structuredClone(input.inputs),
    outputs: structuredClone(input.outputs),
    metadata: structuredClone(input.metadata ?? {}),
    resultProofs: structuredClone(existing?.resultProofs),
    lastError: existing?.lastError ?? null,
    failureCode: existing?.failureCode,
    durableTradeRecovery,
    durableOperationId: durableTradeRecovery.operationId,
    durableTradeId: durableTradeRecovery.tradeId,
    custodyOperationId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: existing?.updatedAt ?? now,
  };
}

function completedGuiProofOperation(
  operation: ProofOperationRecord,
  resultProofs: Record<string, Proof[]>,
  durableTradeRecovery: DurableTradeProofOperationLink,
): ProofOperationRecord {
  return {
    ...operation,
    state: "completed",
    resultProofs: structuredClone(resultProofs),
    durableTradeRecovery,
    durableOperationId: durableTradeRecovery.operationId,
    durableTradeId: durableTradeRecovery.tradeId,
    lastError: null,
    failureCode: undefined,
    updatedAt: Date.now(),
  };
}

function requireGuiProofOperation(
  snapshot: GuiCustodyNativeSnapshot,
  operationId: string,
): ProofOperationRecord {
  if (!snapshot.operation || snapshot.operation.operationId !== operationId) {
    throw new Error(`Missing GUI proof operation ${operationId}`);
  }
  return snapshot.operation;
}

function requireGuiProofOperationLink(
  operation: ProofOperationRecord,
  tradeId: string,
): DurableTradeProofOperationLink {
  const link = operation.durableTradeRecovery;
  if (
    !link ||
    validateDurableProofOperationLink(link) !== null ||
    link.tradeId !== tradeId ||
    operation.durableOperationId !== link.operationId ||
    operation.durableTradeId !== link.tradeId
  ) {
    throw new Error("GUI proof operation has no exact durable binding");
  }
  return link;
}

function linkIdentity(link: DurableTradeProofOperationLink) {
  const { state: _, ...identity } = link;
  return identity;
}

function durableLinkForGuiProofOperation(
  swap: Pick<ActiveSwap, "tradeId" | "role">,
  operation: Pick<PrepareProofOperationInput, "operationId" | "kind">,
): DurableTradeProofOperationLink {
  if (!swap.role) {
    throw new Error("Cannot link a proof operation without a swap role");
  }
  return createDurableTradeProofOperationLink({
    tradeId: swap.tradeId,
    role: swap.role,
    stage: durableStageForGuiProofOperation(operation.kind),
    state: "prepared",
    operationKey: operation.operationId,
  });
}

async function requireActiveDurableSession(
  swap: ActiveSwap,
  mintUrl: string,
  action: string,
) {
  const session = await durableSessionFromActiveSwap(swap, mintUrl);
  if (!session) {
    throw new Error(
      `Cannot ${action} proof operation without a durable swap session`,
    );
  }
  return session;
}
