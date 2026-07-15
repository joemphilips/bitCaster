import {
  readDurableCustodyRecoveryPage,
  type DurableCustodyRecord,
  type DurableCustodyTransaction,
} from "@bitcaster/client-sdk/durableCustody";
import { deriveDurableCustodyProofResultFingerprint } from "@bitcaster/client-sdk/durableCustodyProofOperationRecord";
import { requireDurableWalletProofTransition } from "@bitcaster/client-sdk/durableWalletProofTransition";
import {
  recoverDurableTradeSessions,
  reduceDurableTradeSession,
  type DurableProofOperationRepository,
  type DurableTradeProofOperationLink,
  type DurableTradeRecoveryPorts,
  type DurableTradeRecoveryResult,
  type DurableTradeSession,
  type DurableTradeSessionRepository,
} from "@bitcaster/client-sdk/durableTradeRecovery";
import type { Proof } from "@cashu/cashu-ts";
import type { ActiveSwap } from "./activeSwaps";
import { sameValue } from "./durable-custody-dexie-model";
import {
  acquireGuiCustodyAuthority,
  guiWalletContextForWallet,
  releaseGuiCustodyAuthority,
  withGuiCustodyProfileLockForWallet,
  type GuiCustodyAuthority,
} from "./gui-custody-authority";
import { DexieDurableCustodyStore } from "./durable-custody-dexie";
import { prepareGuiCustodyTransition } from "./gui-proof-operation-custody";
import {
  finalizeGuiNativeProofDelta,
  prepareGuiNativeProofDelta,
  requireGuiNativeProofInputAuthority,
} from "./gui-native-proof-custody";
import {
  guiSwapSessionIntegrityError,
  isGuiSwapSessionRecord,
  MAX_ACTIVE_GUI_SWAP_SESSIONS,
  type GuiSwapSessionRecord,
} from "./gui-swap-session-record";
import {
  commitGuiCustodyUnitOfWork,
  readGuiCustodyOperationSnapshot,
  readGuiCustodyNativeSnapshot,
} from "./gui-custody-unit-of-work";
import {
  db,
  currentGuiWalletId,
  ensureDurableSwapStorage,
  requireProofOperationRecord,
  type BitcasterDB,
  type ProofOperationRecord,
  type ProofOperationState,
} from "./proof-db";
import {
  walletIdFromHeldGuiWalletLock,
  type GuiWalletLockContext,
} from "./gui-wallet-lock";

/** GUI-owned ports supplied to the shared durable recovery coordinator. */
export type GuiDurableTradeRecoveryInput = Omit<
  DurableTradeRecoveryPorts,
  "sessions" | "operations"
>;

/** Separate Dexie connections model independent browser contexts. */
export type GuiDurableRecoveryDatabase = BitcasterDB;

const GUI_TRADE_OPERATION_RECOVERY_PAGE_SIZE = 16;

export interface GuiTradeOperationRecoveryPage {
  tradeIds: string[];
  nextCursor: string | null;
}

/** Pages canonical active custody rows, including operations with no session. */
export async function loadRecoverableGuiTradeOperationPage(
  walletId: string,
  cursor: string | null = null,
  database: GuiDurableRecoveryDatabase = db,
): Promise<GuiTradeOperationRecoveryPage> {
  if (database === db) await ensureDurableSwapStorage(walletId);
  else await database.open();
  const context = guiWalletContextForWallet(walletId);
  const store = new DexieDurableCustodyStore(database);
  if ((await store.readScope(context.scope)) === null) {
    return { tradeIds: [], nextCursor: null };
  }
  const page = await readDurableCustodyRecoveryPage(store, {
    scope: context.scope,
    cursor,
    limit: GUI_TRADE_OPERATION_RECOVERY_PAGE_SIZE,
  });
  const tradeIds = new Set<string>();
  for (const record of page.records) {
    if (record.operation.binding.kind === "trade") {
      tradeIds.add(record.operation.binding.tradeId);
    }
  }
  return { tradeIds: [...tradeIds].sort(), nextCursor: page.nextCursor };
}

export async function loadRecoverableGuiSwapSessions(): Promise<ActiveSwap[]> {
  const walletId = currentGuiWalletId();
  await ensureDurableSwapStorage(walletId);
  const rows = await db.swapSessions
    .where("[walletId+active]")
    .equals([walletId, 1])
    .limit(MAX_ACTIVE_GUI_SWAP_SESSIONS + 1)
    .toArray();
  if (rows.length > MAX_ACTIVE_GUI_SWAP_SESSIONS) {
    throw new Error("Durable swap session capacity is corrupt");
  }
  const recovered: ActiveSwap[] = [];
  for (const row of rows) {
    if ((await guiSwapSessionIntegrityError(row, walletId)) !== null) {
      throw new Error("An active durable swap row is invalid");
    }
    recovered.push((row as GuiSwapSessionRecord).adapterState);
  }
  return recovered;
}

export async function loadGuiSwapSessionStateUnderLock(
  lock: GuiWalletLockContext,
  tradeId: string,
): Promise<ActiveSwap | null> {
  return loadGuiSwapSessionStateForWallet(
    tradeId,
    walletIdFromHeldGuiWalletLock(lock),
  );
}

export async function loadGuiDurableTradeSessionUnderLock(
  lock: GuiWalletLockContext,
  tradeId: string,
): Promise<DurableTradeSession | null> {
  const walletId = walletIdFromHeldGuiWalletLock(lock);
  await ensureDurableSwapStorage(walletId);
  const row = await db.swapSessions.get(tradeId);
  if (row === undefined) return null;
  if ((await guiSwapSessionIntegrityError(row, walletId)) !== null) {
    throw new Error("The durable swap row is invalid");
  }
  return structuredClone(row.session);
}

async function loadGuiSwapSessionStateForWallet(
  tradeId: string,
  walletId: string,
): Promise<ActiveSwap | null> {
  await ensureDurableSwapStorage(walletId);
  const row = await db.swapSessions.get(tradeId);
  if (row === undefined) return null;
  if ((await guiSwapSessionIntegrityError(row, walletId)) !== null) {
    throw new Error("The durable swap row is invalid");
  }
  return structuredClone((row as GuiSwapSessionRecord).adapterState);
}

/**
 * Runs the shared coordinator without retaining the profile Web Lock across
 * mint ports. Every repository callback reacquires the lock and commits
 * through the existing snapshot/epoch CAS.
 */
export async function recoverGuiDurableTradeSession(
  tradeId: string,
  input: GuiDurableTradeRecoveryInput,
  walletId: string,
  database: GuiDurableRecoveryDatabase = db,
): Promise<DurableTradeRecoveryResult | null> {
  if (database === db) await ensureDurableSwapStorage(walletId);
  else await database.open();
  return recoverDurableTradeSessions({
    ...input,
    sessions: unlockedGuiDurableTradeSessionRepository(
      tradeId,
      walletId,
      database,
    ),
    operations: unlockedGuiDurableProofOperationRepository(
      tradeId,
      walletId,
      database,
    ),
    atomicTransition: {
      advance: ({ session, operation, state }) =>
        withGuiRecoveryAuthority(walletId, database, (authority) =>
          advanceGuiDurableTradeAtomically(
            session,
            operation,
            state,
            authority,
            database,
          ),
        ),
    },
  });
}

function unlockedGuiDurableTradeSessionRepository(
  tradeId: string,
  walletId: string,
  database: GuiDurableRecoveryDatabase,
): DurableTradeSessionRepository {
  return {
    get: (requestedTradeId) =>
      withGuiRecoveryLock(walletId, async () => {
        if (requestedTradeId !== tradeId) return null;
        return readGuiDurableSession(tradeId, walletId, database);
      }),
    listRecoverable: () =>
      withGuiRecoveryLock(walletId, async () => {
        const session = await readGuiDurableSession(
          tradeId,
          walletId,
          database,
        );
        return session ? [session] : [];
      }),
    create: async () => {
      throw new Error(
        "GUI durable sessions must be created with their adapter state",
      );
    },
    compareAndSwap: (requestedTradeId, expectedRevision, next) =>
      withGuiRecoveryAuthority(walletId, database, async (authority) => {
        if (requestedTradeId !== tradeId || next.tradeId !== tradeId) {
          return null;
        }
        const repository = guiDurableTradeSessionRepository(
          tradeId,
          authority,
          database,
        );
        return repository.compareAndSwap(
          requestedTradeId,
          expectedRevision,
          next,
        );
      }),
    remove: async () => false,
  };
}

function unlockedGuiDurableProofOperationRepository(
  tradeId: string,
  walletId: string,
  database: GuiDurableRecoveryDatabase,
): DurableProofOperationRepository {
  const read = () =>
    guiDurableProofOperationRepository(tradeId, walletId, database);
  return {
    get: (operationId) =>
      withGuiRecoveryLock(walletId, () => read().get(operationId)),
    listByTrade: (requestedTradeId) =>
      withGuiRecoveryLock(walletId, () => read().listByTrade(requestedTradeId)),
    listRecoverable: () =>
      withGuiRecoveryLock(walletId, () => read().listRecoverable()),
    prepare: async () => {
      throw new Error(
        "GUI proof operations must be prepared with their persisted Cashu request",
      );
    },
    markMintSubmitted: async () => {
      throw new Error("GUI recovery requires its atomic custody transition");
    },
    markReconciled: async () => {
      throw new Error("GUI recovery requires its atomic custody transition");
    },
  };
}

async function readGuiDurableSession(
  tradeId: string,
  walletId: string,
  database: GuiDurableRecoveryDatabase,
): Promise<DurableTradeSession | null> {
  const row = await database.swapSessions.get(tradeId);
  const current = requireCurrentGuiSwapSessionRecord(row, walletId);
  return current ? structuredClone(current.session) : null;
}

function withGuiRecoveryLock<T>(
  walletId: string,
  action: () => Promise<T>,
): Promise<T> {
  return withGuiCustodyProfileLockForWallet(walletId, () => action());
}

function withGuiRecoveryAuthority<T>(
  walletId: string,
  database: GuiDurableRecoveryDatabase,
  action: (authority: GuiCustodyAuthority) => Promise<T>,
): Promise<T> {
  return withGuiCustodyProfileLockForWallet(
    walletId,
    async (_context, lock) => {
      const authority = await acquireGuiCustodyAuthority(lock, database);
      try {
        return await action(authority);
      } finally {
        await releaseGuiCustodyAuthority(lock, authority);
      }
    },
  );
}

/** Stages exact recovered outputs before the coordinator advances the link. */
export async function recordGuiRecoveredProofOperationOutputsUnderLock(
  lock: GuiWalletLockContext,
  tradeId: string,
  durableOperationId: string,
  resultProofs: Record<string, Proof[]>,
): Promise<void> {
  return recordGuiRecoveredProofOperationOutputsForWallet(
    walletIdFromHeldGuiWalletLock(lock),
    tradeId,
    durableOperationId,
    resultProofs,
  );
}

async function recordGuiRecoveredProofOperationOutputsForWallet(
  walletId: string,
  tradeId: string,
  durableOperationId: string,
  resultProofs: Record<string, Proof[]>,
): Promise<void> {
  await ensureDurableSwapStorage(walletId);
  await db.transaction("rw", db.proofOperations, async () => {
    const operation = await findGuiProofOperationByDurableId(
      durableOperationId,
      walletId,
    );
    if (operation?.durableTradeRecovery?.tradeId !== tradeId) {
      throw new Error(
        `GUI durable proof operation ${durableOperationId} is missing`,
      );
    }
    if (
      operation.resultProofs &&
      !sameValue(operation.resultProofs, resultProofs)
    ) {
      throw new Error(
        `GUI durable proof operation ${durableOperationId} has conflicting recovered outputs`,
      );
    }
    await db.proofOperations.put(
      requireProofOperationRecord(
        {
          ...operation,
          resultProofs: structuredClone(resultProofs),
          updatedAt: Date.now(),
        },
        walletId,
        operation.operationId,
      ),
    );
  });
}

export async function removeGuiSwapSessionUnderLock(
  lock: GuiWalletLockContext,
  tradeId: string,
): Promise<void> {
  const walletId = walletIdFromHeldGuiWalletLock(lock);
  await ensureDurableSwapStorage(walletId);
  await db.transaction("rw", db.swapSessions, async () => {
    const row = await db.swapSessions.get(tradeId);
    const current = requireCurrentGuiSwapSessionRecord(row, walletId);
    if (!current) return;
    if (current.adapterState.step !== "completed") {
      throw new Error("Cannot retire a nonterminal GUI swap session");
    }
    await db.swapSessions.put({ ...current, active: 0, updatedAt: Date.now() });
  });
}

function guiDurableTradeSessionRepository(
  tradeId: string,
  authority: GuiCustodyAuthority,
  database: GuiDurableRecoveryDatabase,
): DurableTradeSessionRepository {
  return {
    get: async (requestedTradeId) => {
      if (requestedTradeId !== tradeId) return null;
      const row = await database.swapSessions.get(tradeId);
      const current = requireCurrentGuiSwapSessionRecord(
        row,
        authority.scope.walletId,
      );
      return current ? structuredClone(current.session) : null;
    },
    listRecoverable: async () => {
      const row = await database.swapSessions.get(tradeId);
      const current = requireCurrentGuiSwapSessionRecord(
        row,
        authority.scope.walletId,
      );
      return current ? [structuredClone(current.session)] : [];
    },
    create: async () => {
      throw new Error(
        "GUI durable sessions must be created with their adapter state",
      );
    },
    compareAndSwap: async (requestedTradeId, expectedRevision, next) => {
      if (requestedTradeId !== tradeId || next.tradeId !== tradeId) return null;
      const snapshot = await readGuiCustodyNativeSnapshot(
        null,
        tradeId,
        authority.scope.walletId,
        database,
      );
      const current = requireCurrentGuiSwapSessionRecord(
        snapshot.session,
        authority.scope.walletId,
      );
      if (!current || current.session.revision !== expectedRevision) {
        return null;
      }
      const plan = await authority.store.prepareTransaction(
        { scope: authority.scope, owner: authority.owner, operationIds: [] },
        () => undefined,
      );
      await commitGuiCustodyUnitOfWork({
        authority,
        plan,
        snapshot,
        database,
        nextSession: {
          ...current,
          session: structuredClone(next),
          updatedAt: Date.now(),
        },
      });
      return structuredClone(next);
    },
    remove: async () => false,
  };
}

function guiDurableProofOperationRepository(
  tradeId: string,
  walletId: string,
  database: GuiDurableRecoveryDatabase,
): DurableProofOperationRepository {
  const listByTrade = async () =>
    (
      await database.proofOperations
        .where("[walletId+durableTradeId]")
        .equals([walletId, tradeId])
        .toArray()
    ).map((operation) =>
      requireProofOperationRecord(operation, walletId, operation.operationId),
    );
  return {
    get: async (operationId) => {
      const operation = await findGuiProofOperationByDurableId(
        operationId,
        walletId,
        database,
      );
      return operation?.durableTradeRecovery?.tradeId === tradeId
        ? structuredClone(operation.durableTradeRecovery)
        : null;
    },
    listByTrade: async (requestedTradeId) => {
      if (requestedTradeId !== tradeId) return [];
      return (await listByTrade()).flatMap((operation) =>
        operation.durableTradeRecovery?.tradeId === tradeId
          ? [structuredClone(operation.durableTradeRecovery)]
          : [],
      );
    },
    listRecoverable: async () =>
      (await listByTrade()).flatMap((operation) =>
        operation.durableTradeRecovery?.tradeId === tradeId &&
        operation.durableTradeRecovery.state !== "reconciled"
          ? [structuredClone(operation.durableTradeRecovery)]
          : [],
      ),
    prepare: async () => {
      throw new Error(
        "GUI proof operations must be prepared with their persisted Cashu request",
      );
    },
    markMintSubmitted: async () => {
      throw new Error("GUI recovery requires its atomic custody transition");
    },
    markReconciled: async () => {
      throw new Error("GUI recovery requires its atomic custody transition");
    },
  };
}

async function advanceGuiDurableTradeAtomically(
  session: DurableTradeSession,
  operation: DurableTradeProofOperationLink,
  state: "mint-submitted" | "reconciled",
  authority: GuiCustodyAuthority,
  database: GuiDurableRecoveryDatabase,
): Promise<{
  session: DurableTradeSession;
  operation: DurableTradeProofOperationLink;
} | null> {
  const nativeOperation = await findGuiProofOperationByDurableId(
    operation.operationId,
    authority.scope.walletId,
    database,
  );
  if (
    !nativeOperation ||
    !sameValue(nativeOperation.durableTradeRecovery, operation)
  ) {
    return null;
  }
  const sessionRow = await database.swapSessions.get(session.tradeId);
  const currentSession = requireCurrentGuiSwapSessionRecord(
    sessionRow,
    authority.scope.walletId,
  );
  if (!currentSession) {
    return null;
  }
  const draftProofDelta =
    state === "reconciled"
      ? await prepareRecoveredGuiNativeProofDelta(
          nativeOperation,
          currentSession.adapterState,
        )
      : null;
  const snapshot = await readGuiCustodyOperationSnapshot(
    nativeOperation.operationId,
    authority.scope.walletId,
    draftProofDelta?.nextProofs ?? [],
    session.tradeId,
    database,
  );
  const snapshotSession = requireCurrentGuiSwapSessionRecord(
    snapshot.session,
    authority.scope.walletId,
  );
  if (
    !snapshotSession ||
    !sameValue(snapshotSession.session, session) ||
    !sameValue(snapshot.operation, nativeOperation)
  ) {
    return null;
  }
  const plan = await prepareGuiCustodyTransition(
    authority,
    nativeOperation,
    (record, transaction) =>
      advanceCanonicalRecovery(record, transaction, state, nativeOperation),
  );
  const nextSession = reduceDurableTradeSession(
    session,
    state === "mint-submitted"
      ? { kind: "mint-submitted", operationId: operation.operationId }
      : {
          kind: "proof-operation-reconciled",
          operationId: operation.operationId,
        },
  );
  const nextLink = { ...operation, state };
  const operationState: ProofOperationState =
    state === "mint-submitted" ? "mint-submitted" : "completed";
  const proofDelta = draftProofDelta
    ? finalizeRecoveredGuiNativeProofDelta(
        nativeOperation,
        snapshot.proofs,
        draftProofDelta,
      )
    : null;
  await commitGuiCustodyUnitOfWork({
    authority,
    plan,
    snapshot,
    database,
    nextOperation: {
      ...nativeOperation,
      state: operationState,
      durableTradeRecovery: nextLink,
      durableOperationId: nextLink.operationId,
      durableTradeId: nextLink.tradeId,
      updatedAt: Date.now(),
    },
    deleteProofs: proofDelta?.deleteProofs,
    nextProofs: proofDelta?.nextProofs,
    nextSession: {
      ...snapshotSession,
      session: nextSession,
      updatedAt: Date.now(),
    },
  });
  return {
    session: structuredClone(nextSession),
    operation: structuredClone(nextLink),
  };
}

async function prepareRecoveredGuiNativeProofDelta(
  operation: ProofOperationRecord,
  swap: ActiveSwap,
) {
  if (!operation.resultProofs) {
    throw new Error("GUI recovered output artifact is missing");
  }
  return prepareGuiNativeProofDelta(operation, operation.resultProofs, swap);
}

function finalizeRecoveredGuiNativeProofDelta(
  operation: ProofOperationRecord,
  snapshotProofs: Parameters<typeof finalizeGuiNativeProofDelta>[1],
  draft: Awaited<ReturnType<typeof prepareGuiNativeProofDelta>>,
) {
  const policy = requireDurableWalletProofTransition(
    operation.metadata,
    Object.keys(operation.outputs),
  );
  requireGuiNativeProofInputAuthority(
    operation,
    snapshotProofs,
    policy,
    "owned",
  );
  return finalizeGuiNativeProofDelta(draft, snapshotProofs);
}

function advanceCanonicalRecovery(
  record: DurableCustodyRecord,
  transaction: DurableCustodyTransaction,
  state: "mint-submitted" | "reconciled",
  nativeOperation: ProofOperationRecord,
): void {
  const operationId = record.operation.operationId;
  if (record.operation.state === "dispatch-intent") {
    transaction.transitionOperation({
      operationId,
      transition: { kind: "transport-attempted" },
    });
  } else if (
    record.operation.state !== "transport-attempted" &&
    record.operation.state !== "reconciled"
  ) {
    throw new Error("GUI canonical recovery state is invalid");
  }
  if (state === "mint-submitted") {
    if (record.operation.state === "reconciled") {
      throw new Error("GUI canonical recovery cannot move backwards");
    }
    return;
  }
  if (!nativeOperation.resultProofs) {
    throw new Error("GUI recovered output artifact is missing");
  }
  const resultFingerprint = deriveDurableCustodyProofResultFingerprint(
    nativeOperation.resultProofs,
  );
  if (record.operation.result.state === "applied") {
    if (record.operation.result.resultFingerprint !== resultFingerprint) {
      throw new Error("GUI recovered output conflicts with canonical custody");
    }
    return;
  }
  const outputPlanFingerprint =
    record.operation.outputPlan.outputPlanFingerprint;
  const resultHandle = `result:${resultFingerprint}`;
  transaction.stageVerifiedResult({
    operationId,
    outputPlanFingerprint,
    resultHandle,
    resultFingerprint,
  });
  transaction.applyVerifiedResult({
    operationId,
    outputPlanFingerprint,
    resultHandle,
    resultFingerprint,
  });
}

async function findGuiProofOperationByDurableId(
  durableOperationId: string,
  walletId: string,
  database: GuiDurableRecoveryDatabase = db,
): Promise<ProofOperationRecord | undefined> {
  const row = await database.proofOperations
    .where("[walletId+durableOperationId]")
    .equals([walletId, durableOperationId])
    .first();
  const operation = row
    ? requireProofOperationRecord(row, walletId, row.operationId)
    : undefined;
  return operation?.durableTradeRecovery?.operationId === durableOperationId
    ? operation
    : undefined;
}

function isCurrentGuiSwapSessionRecord(
  value: unknown,
  walletId: string,
): value is GuiSwapSessionRecord {
  if (!isGuiSwapSessionRecord(value)) return false;
  if (value.walletId !== walletId) {
    throw new Error("GUI swap session belongs to another wallet scope");
  }
  return true;
}

function requireCurrentGuiSwapSessionRecord(
  value: unknown,
  walletId: string,
): GuiSwapSessionRecord | undefined {
  if (value === undefined) return undefined;
  if (!isCurrentGuiSwapSessionRecord(value, walletId)) {
    throw new Error("The durable swap row is invalid");
  }
  return value;
}
