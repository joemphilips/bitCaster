import {
  DURABLE_TRADE_SESSION_SCHEMA_VERSION,
  createDurableTradeProofOperationLink,
  recoverDurableTradeSessions,
  reduceDurableTradeSession,
  resumeDurableTradeSession,
  validateDurableTradeSession,
  validateDurableTradePrivateKeyBinding,
  verifyDurableTradeSessionCipherIntegrity,
  type DurableTradeResumePorts,
  type DurableTradeResumeResult,
  type DurableTradeRecoveryPorts,
  type DurableTradeRecoveryResult,
  type DurableTradeSessionRepository,
  type DurableProofOperationRepository,
  type DurableProofOperationStage,
  type DurableTradeProofOperationLink,
  type DurableTradeSession,
  type DurableTradeSessionRecord,
} from "@bitcaster/client-sdk/durableTradeRecovery";
import type { ActiveSwap } from "./activeSwaps";
import {
  db,
  ensureDurableSwapStorage,
  markProofOperationMintSubmitted,
  markProofOperationCompleted,
  prepareProofOperation,
  type PrepareProofOperationInput,
  type ProofOperationKind,
  type ProofOperationState,
  type ProofOperationRecord,
  type SwapSessionRecord,
} from "./proof-db";

export type GuiSwapSessionRecord = DurableTradeSessionRecord<ActiveSwap> &
  SwapSessionRecord;

/** GUI-owned ports supplied to the shared durable recovery coordinator. */
export type GuiDurableTradeRecoveryInput = Omit<
  DurableTradeRecoveryPorts,
  "sessions" | "operations"
>;

/**
 * Each browser tab owns a separate Dexie connection to the same durable
 * database. The default is this module's connection; the explicit shape lets
 * a second context use the same recovery adapter without duplicating its
 * session/link rules.
 */
export type GuiDurableRecoveryDatabase = Pick<
  typeof db,
  "open" | "transaction" | "proofOperations" | "swapSessions"
>;

export const MAX_ACTIVE_GUI_SWAP_SESSIONS = 32;

/**
 * Persist the GUI protocol payload with the shared SDK envelope before the
 * next irreversible protocol action. The browser record is client-local and
 * contains no Nostr identity.
 */
export async function persistGuiSwapSession(
  swap: ActiveSwap,
  mintUrl: string,
): Promise<void> {
  const session = await durableSessionFromActiveSwap(swap, mintUrl);
  if (!session) {
    throw new Error(
      "Cannot persist a swap session before trade role and locktimes are known",
    );
  }
  await ensureDurableSwapStorage();
  await db.transaction("rw", db.swapSessions, async () => {
    await putGuiSwapSessionInTransaction(swap, session);
  });
}

/** Atomically writes the mint-operation intent and its GUI recovery session. */
export async function prepareGuiProofOperationWithSession(
  input: PrepareProofOperationInput,
  swap: ActiveSwap,
): Promise<ProofOperationRecord> {
  const session = await durableSessionFromActiveSwap(swap, input.mintUrl);
  if (!session)
    throw new Error(
      "Cannot prepare proof operation without a durable swap session",
    );
  await ensureDurableSwapStorage();
  return db.transaction("rw", db.proofOperations, db.swapSessions, async () => {
    const operation = await prepareProofOperation(input);
    const durableTradeRecovery = durableLinkForGuiProofOperation(
      swap,
      operation,
    );
    const linkedOperation = {
      ...operation,
      durableTradeRecovery,
      durableOperationId: durableTradeRecovery.operationId,
      durableTradeId: durableTradeRecovery.tradeId,
    };
    await db.proofOperations.put(linkedOperation);
    await putGuiSwapSessionInTransaction(swap, session, durableTradeRecovery);
    return linkedOperation;
  });
}

/** Atomically records fresh mint outputs and the session reconciliation cursor. */
export async function completeGuiProofOperationWithSession(
  operationId: string,
  resultProofs: Record<string, import("@cashu/cashu-ts").Proof[]>,
  swap: ActiveSwap,
  mintUrl: string,
): Promise<ProofOperationRecord> {
  const session = await durableSessionFromActiveSwap(swap, mintUrl);
  if (!session)
    throw new Error(
      "Cannot complete proof operation without a durable swap session",
    );
  await ensureDurableSwapStorage();
  return db.transaction("rw", db.proofOperations, db.swapSessions, async () => {
    const operation = await markProofOperationCompleted(
      operationId,
      resultProofs,
    );
    const durableTradeRecovery = operation.durableTradeRecovery
      ? { ...operation.durableTradeRecovery, state: "reconciled" as const }
      : undefined;
    const linkedOperation = {
      ...operation,
      durableTradeRecovery,
      durableOperationId: durableTradeRecovery?.operationId,
      durableTradeId: durableTradeRecovery?.tradeId,
    };
    await db.proofOperations.put(linkedOperation);
    await putGuiSwapSessionInTransaction(swap, session, durableTradeRecovery);
    return linkedOperation;
  });
}

/** Atomically advances the proof ledger and SDK session before a mint request. */
export async function markGuiProofOperationMintSubmittedWithSession(
  operationId: string,
  swap: ActiveSwap,
  mintUrl: string,
): Promise<ProofOperationRecord> {
  const session = await durableSessionFromActiveSwap(swap, mintUrl);
  if (!session)
    throw new Error(
      "Cannot submit proof operation without a durable swap session",
    );
  await ensureDurableSwapStorage();
  return db.transaction("rw", db.proofOperations, db.swapSessions, async () => {
    const operation = await markProofOperationMintSubmitted(operationId);
    const durableTradeRecovery = operation.durableTradeRecovery
      ? { ...operation.durableTradeRecovery, state: "mint-submitted" as const }
      : undefined;
    const linkedOperation = {
      ...operation,
      durableTradeRecovery,
      durableOperationId: durableTradeRecovery?.operationId,
      durableTradeId: durableTradeRecovery?.tradeId,
    };
    await db.proofOperations.put(linkedOperation);
    await putGuiSwapSessionInTransaction(swap, session, durableTradeRecovery);
    return linkedOperation;
  });
}

async function putGuiSwapSessionInTransaction(
  swap: ActiveSwap,
  session: DurableTradeSession,
  durableTradeRecovery?: DurableTradeProofOperationLink,
): Promise<void> {
  const existing = await db.swapSessions.toArray();
  const prior = existing.find((item) => item.tradeId === swap.tradeId);
  const activeCount = existing.filter((item) => {
    if (!isGuiSwapSessionRecord(item)) return false;
    return item.adapterState.step !== "completed";
  }).length;
  if (!prior && activeCount >= MAX_ACTIVE_GUI_SWAP_SESSIONS) {
    throw new Error("Durable swap session capacity is exhausted");
  }
  const priorSession = isGuiSwapSessionRecord(prior)
    ? prior.session
    : undefined;
  if (priorSession && validateDurableTradeSession(priorSession) !== null) {
    throw new Error("Cannot update an invalid durable swap session");
  }
  const nextSession = mergeGuiProofOperationLink(
    session,
    priorSession,
    durableTradeRecovery,
  );
  await db.swapSessions.put({
    tradeId: swap.tradeId,
    session: nextSession,
    adapterState: structuredClone(swap),
    updatedAt: Date.now(),
  } satisfies SwapSessionRecord);
}

function durableLinkForGuiProofOperation(
  swap: ActiveSwap,
  operation: ProofOperationRecord,
): DurableTradeProofOperationLink {
  if (!swap.role)
    throw new Error("Cannot link a proof operation without a swap role");
  return createDurableTradeProofOperationLink({
    tradeId: swap.tradeId,
    role: swap.role,
    stage: durableStageForGuiProofOperation(operation.kind),
    state: "prepared",
    operationKey: operation.operationId,
  });
}

function durableStageForGuiProofOperation(
  kind: ProofOperationKind,
): DurableProofOperationStage {
  switch (kind) {
    case "swap-lock":
    case "conditional-keyset-swap":
      return "proof-reservation";
    case "swap-claim":
      return "claim";
    case "swap-refund":
      return "refund";
    case "ctf-split":
    case "ctf-merge":
    case "ctf-redeem":
    case "ctf-condition-registration":
    case "regular-split":
    case "proof-split":
      return "mint-submission";
  }
}

function mergeGuiProofOperationLink(
  session: DurableTradeSession,
  prior: DurableTradeSession | undefined,
  durableTradeRecovery: DurableTradeProofOperationLink | undefined,
): DurableTradeSession {
  const links = new Map<string, DurableTradeProofOperationLink>();
  for (const link of prior?.proofOperations ?? [])
    links.set(link.operationId, link);
  if (durableTradeRecovery)
    links.set(durableTradeRecovery.operationId, durableTradeRecovery);
  const proofOperations = [...links.values()];
  const stage = proofOperations.some((link) => link.state === "mint-submitted")
    ? "mint-submitted"
    : proofOperations.some((link) => link.state === "prepared")
      ? "proof-reserved"
      : proofOperations.length > 0
        ? "reconciliation-complete"
        : session.stage;
  return {
    ...session,
    revision: prior ? prior.revision + 1 : 0,
    stage,
    proofOperations,
  };
}

/**
 * One coordinator owns a trade while it can lock/mint/send. Web Locks covers
 * modern browsers. Browsers without Web Locks fail closed because a local
 * lease cannot fence an external mint request after the owning tab stalls.
 */
export async function withGuiSwapSessionOwnership<T>(
  tradeId: string,
  action: () => Promise<T>,
): Promise<T | null> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(
      `bitcaster-swap:${tradeId}`,
      { mode: "exclusive" },
      action,
    );
  }
  return null;
}

export async function loadRecoverableGuiSwapSessions(): Promise<ActiveSwap[]> {
  await ensureDurableSwapStorage();
  const rows = await db.swapSessions.toArray();
  const recovered: ActiveSwap[] = [];
  for (const row of rows) {
    if (!isGuiSwapSessionRecord(row)) continue;
    if (row.adapterState.step === "completed") continue;
    if (validateDurableTradeSession(row.session) !== null) continue;
    if (
      (await verifyDurableTradeSessionCipherIntegrity(
        row.session,
        sha256Hex,
      )) !== null
    )
      continue;
    if (!isAdapterStateBoundToSession(row.adapterState, row.session)) continue;
    recovered.push(row.adapterState);
  }
  return recovered;
}

/** Rejoins a persisted session and replays only its SDK-owned durable outbox. */
export async function resumeGuiSwapSession(
  tradeId: string,
  ports: DurableTradeResumePorts,
): Promise<DurableTradeResumeResult | null> {
  await ensureDurableSwapStorage();
  const row = await db.swapSessions.get(tradeId);
  if (!isGuiSwapSessionRecord(row)) return null;
  const validationError = validateDurableTradeSession(row.session);
  if (validationError)
    return { kind: "invalid-session", reason: validationError };
  const integrityError = await verifyDurableTradeSessionCipherIntegrity(
    row.session,
    sha256Hex,
  );
  if (integrityError)
    return { kind: "invalid-session", reason: integrityError };
  return resumeDurableTradeSession(row.session, ports);
}

/**
 * Runs the SDK coordinator against the real Dexie session and proof-operation
 * tables. The caller supplies only the custody-specific mint and transport
 * ports; session CAS and link transitions remain one browser adapter.
 */
export async function recoverGuiDurableTradeSession(
  tradeId: string,
  input: GuiDurableTradeRecoveryInput,
  database: GuiDurableRecoveryDatabase = db,
): Promise<DurableTradeRecoveryResult | null> {
  return withGuiSwapSessionOwnership(tradeId, async () => {
    if (database === db) await ensureDurableSwapStorage();
    else await database.open();
    return recoverDurableTradeSessions({
      ...input,
      sessions: guiDurableTradeSessionRepository(tradeId, database),
      operations: guiDurableProofOperationRepository(tradeId, database),
      atomicTransition: {
        advance: async ({ session, operation, state }) =>
          advanceGuiDurableTradeAtomically(session, operation, state, database),
      },
    });
  });
}

/**
 * Retains exact recovered mint outputs before the coordinator advances the
 * linked operation to reconciled. Repeating this write is idempotent only for
 * byte-identical outputs; a different response fails closed.
 */
export async function recordGuiRecoveredProofOperationOutputs(
  tradeId: string,
  durableOperationId: string,
  resultProofs: Record<string, import("@cashu/cashu-ts").Proof[]>,
): Promise<void> {
  await db.transaction("rw", db.proofOperations, async () => {
    const operation =
      await findGuiProofOperationByDurableId(durableOperationId);
    if (operation?.durableTradeRecovery?.tradeId !== tradeId) {
      throw new Error(
        `GUI durable proof operation ${durableOperationId} is missing`,
      );
    }
    if (
      operation.resultProofs &&
      JSON.stringify(operation.resultProofs) !== JSON.stringify(resultProofs)
    ) {
      throw new Error(
        `GUI durable proof operation ${durableOperationId} has conflicting recovered outputs`,
      );
    }
    await db.proofOperations.put({
      ...operation,
      resultProofs: structuredClone(resultProofs),
      updatedAt: Date.now(),
    });
  });
}

export async function removeGuiSwapSession(tradeId: string): Promise<void> {
  await ensureDurableSwapStorage();
  await db.swapSessions.delete(tradeId);
}

async function durableSessionFromActiveSwap(
  swap: ActiveSwap,
  mintUrl: string,
): Promise<DurableTradeSession | null> {
  if (
    !swap.role ||
    !swap.counterpartyPubkey ||
    swap.sellerLocktime === null ||
    swap.buyerLocktime === null
  ) {
    return null;
  }
  const receivedCiphers = await journalCiphers([
    [
      "adaptor-point",
      swap.role === "buyer" ? swap.messages.adaptorPoint : undefined,
    ],
    [
      "locked-proofs-seller",
      swap.role === "buyer" ? swap.messages.lockedProofsSeller : undefined,
    ],
    [
      "locked-proofs-buyer",
      swap.role === "seller" ? swap.messages.lockedProofsBuyer : undefined,
    ],
  ]);
  const outboundCiphers = await journalCiphers([
    [
      "adaptor-point",
      swap.role === "seller" ? swap.sellerState?.adaptorPointCipher : undefined,
    ],
    [
      "locked-proofs-seller",
      swap.role === "seller" ? swap.sellerState?.lockedProofsCipher : undefined,
    ],
    [
      "locked-proofs-buyer",
      swap.role === "buyer" ? swap.buyerState?.lockedProofsCipher : undefined,
    ],
  ]);
  return {
    schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
    revision: 0,
    tradeId: swap.tradeId,
    role: swap.role,
    localProtocolPubkey: swap.ephemeralPubkeyHex.toLowerCase(),
    counterpartyProtocolPubkey: swap.counterpartyPubkey.toLowerCase(),
    mintUrl,
    sellerLocktimeSecs: swap.sellerLocktime,
    buyerLocktimeSecs: swap.buyerLocktime,
    ephemeralKeyHandle: {
      keyId: `gui-swap-session:${swap.tradeId}`,
      tradeId: swap.tradeId,
      role: swap.role,
      localProtocolPubkey: swap.ephemeralPubkeyHex.toLowerCase(),
      counterpartyProtocolPubkey: swap.counterpartyPubkey.toLowerCase(),
      mintUrl,
      sellerLocktimeSecs: swap.sellerLocktime,
      buyerLocktimeSecs: swap.buyerLocktime,
    },
    stage:
      swap.step === "awaiting-confirmation"
        ? "reconciliation-complete"
        : "intent",
    proofOperations: [],
    receivedCiphers,
    outboundCiphers,
  };
}

async function journalCiphers(
  input: Array<
    [keyof DurableTradeSession["receivedCiphers"], string | undefined]
  >,
): Promise<DurableTradeSession["receivedCiphers"]> {
  const output: DurableTradeSession["receivedCiphers"] = {};
  for (const [messageType, ciphertext] of input) {
    if (!ciphertext) continue;
    output[messageType] = { ciphertext, sha256: await sha256Hex(ciphertext) };
  }
  return output;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (part) =>
    part.toString(16).padStart(2, "0"),
  ).join("");
}

function isGuiSwapSessionRecord(value: unknown): value is GuiSwapSessionRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SwapSessionRecord).tradeId === "string" &&
    typeof (value as SwapSessionRecord).updatedAt === "number" &&
    typeof (value as SwapSessionRecord).adapterState === "object" &&
    (value as SwapSessionRecord).adapterState !== null
  );
}

function isAdapterStateBoundToSession(
  swap: ActiveSwap,
  session: DurableTradeSession,
): boolean {
  return (
    swap.tradeId === session.tradeId &&
    swap.role === session.role &&
    validateDurableTradePrivateKeyBinding(
      swap.ephemeralPrivkeyHex,
      session.localProtocolPubkey,
    ) === null &&
    swap.ephemeralPubkeyHex.toLowerCase() === session.localProtocolPubkey &&
    swap.counterpartyPubkey?.toLowerCase() ===
      session.counterpartyProtocolPubkey &&
    swap.sellerLocktime === session.sellerLocktimeSecs &&
    swap.buyerLocktime === session.buyerLocktimeSecs
  );
}

function guiDurableTradeSessionRepository(
  tradeId: string,
  database: GuiDurableRecoveryDatabase,
): DurableTradeSessionRepository {
  return {
    get: async (requestedTradeId) => {
      if (requestedTradeId !== tradeId) return null;
      const row = await database.swapSessions.get(tradeId);
      return isGuiSwapSessionRecord(row) ? structuredClone(row.session) : null;
    },
    listRecoverable: async () => {
      const row = await database.swapSessions.get(tradeId);
      if (!isGuiSwapSessionRecord(row) || row.adapterState.step === "completed")
        return [];
      return [structuredClone(row.session)];
    },
    create: async () => {
      throw new Error(
        "GUI durable sessions must be created with their adapter state",
      );
    },
    compareAndSwap: async (requestedTradeId, expectedRevision, next) => {
      if (requestedTradeId !== tradeId || next.tradeId !== tradeId) return null;
      let updated: DurableTradeSession | null = null;
      await database.transaction("rw", database.swapSessions, async () => {
        const current = await database.swapSessions.get(tradeId);
        if (
          !isGuiSwapSessionRecord(current) ||
          current.session.revision !== expectedRevision
        )
          return;
        await database.swapSessions.put({
          ...current,
          session: structuredClone(next),
          updatedAt: Date.now(),
        });
        updated = structuredClone(next);
      });
      return updated;
    },
    remove: async () => false,
  };
}

function guiDurableProofOperationRepository(
  tradeId: string,
  database: GuiDurableRecoveryDatabase,
): DurableProofOperationRepository {
  return {
    get: async (operationId) => {
      const operation = await findGuiProofOperationByDurableId(
        operationId,
        database,
      );
      return operation?.durableTradeRecovery?.tradeId === tradeId
        ? structuredClone(operation.durableTradeRecovery)
        : null;
    },
    listByTrade: async (requestedTradeId) => {
      if (requestedTradeId !== tradeId) return [];
      return (
        await database.proofOperations
          .where("durableTradeId")
          .equals(tradeId)
          .toArray()
      ).flatMap((operation) =>
        operation.durableTradeRecovery?.tradeId === tradeId
          ? [structuredClone(operation.durableTradeRecovery)]
          : [],
      );
    },
    listRecoverable: async () =>
      (
        await database.proofOperations
          .where("durableTradeId")
          .equals(tradeId)
          .toArray()
      ).flatMap((operation) =>
        operation.durableTradeRecovery &&
        operation.durableTradeRecovery.tradeId === tradeId &&
        operation.durableTradeRecovery.state !== "reconciled"
          ? [structuredClone(operation.durableTradeRecovery)]
          : [],
      ),
    prepare: async () => {
      throw new Error(
        "GUI proof operations must be prepared with their persisted Cashu request",
      );
    },
    markMintSubmitted: async (operationId) =>
      updateGuiDurableProofOperation(
        tradeId,
        operationId,
        "mint-submitted",
        database,
      ),
    markReconciled: async (operationId) =>
      updateGuiDurableProofOperation(
        tradeId,
        operationId,
        "reconciled",
        database,
      ),
  };
}

async function updateGuiDurableProofOperation(
  tradeId: string,
  operationId: string,
  state: "mint-submitted" | "reconciled",
  database: GuiDurableRecoveryDatabase,
): Promise<DurableTradeProofOperationLink> {
  let link: DurableTradeProofOperationLink | null = null;
  await database.transaction("rw", database.proofOperations, async () => {
    const operation = await findGuiProofOperationByDurableId(
      operationId,
      database,
    );
    if (operation?.durableTradeRecovery?.tradeId !== tradeId) {
      throw new Error(`GUI durable proof operation ${operationId} is missing`);
    }
    const nextLink = { ...operation.durableTradeRecovery, state };
    const operationState: ProofOperationState =
      state === "mint-submitted" ? "mint-submitted" : "completed";
    await database.proofOperations.put({
      ...operation,
      state: operationState,
      durableTradeRecovery: nextLink,
      durableOperationId: nextLink.operationId,
      durableTradeId: nextLink.tradeId,
      updatedAt: Date.now(),
    });
    link = nextLink;
  });
  if (!link)
    throw new Error(
      `GUI durable proof operation ${operationId} was not updated`,
    );
  return link;
}

async function advanceGuiDurableTradeAtomically(
  session: DurableTradeSession,
  operation: DurableTradeProofOperationLink,
  state: "mint-submitted" | "reconciled",
  database: GuiDurableRecoveryDatabase,
): Promise<{
  session: DurableTradeSession;
  operation: DurableTradeProofOperationLink;
} | null> {
  let result: {
    session: DurableTradeSession;
    operation: DurableTradeProofOperationLink;
  } | null = null;
  await database.transaction(
    "rw",
    database.proofOperations,
    database.swapSessions,
    async () => {
      const sessionRow = await database.swapSessions.get(session.tradeId);
      if (
        !isGuiSwapSessionRecord(sessionRow) ||
        sessionRow.session.revision !== session.revision
      ) {
        return;
      }
      const nativeOperation = await findGuiProofOperationByDurableId(
        operation.operationId,
        database,
      );
      if (
        !nativeOperation?.durableTradeRecovery ||
        nativeOperation.durableTradeRecovery.operationId !==
          operation.operationId ||
        nativeOperation.durableTradeRecovery.operationKey !==
          operation.operationKey ||
        nativeOperation.durableTradeRecovery.tradeId !== session.tradeId ||
        nativeOperation.durableTradeRecovery.role !== operation.role ||
        nativeOperation.durableTradeRecovery.stage !== operation.stage ||
        nativeOperation.durableTradeRecovery.kind !== operation.kind ||
        nativeOperation.durableTradeRecovery.state !== operation.state
      ) {
        return;
      }
      const nextSession = reduceDurableTradeSession(
        session,
        state === "mint-submitted"
          ? { kind: "mint-submitted", operationId: operation.operationId }
          : {
              kind: "proof-operation-reconciled",
              operationId: operation.operationId,
            },
      );
      const nextOperation = { ...nativeOperation.durableTradeRecovery, state };
      const operationState: ProofOperationState =
        state === "mint-submitted" ? "mint-submitted" : "completed";
      await database.proofOperations.put({
        ...nativeOperation,
        state: operationState,
        durableTradeRecovery: nextOperation,
        durableOperationId: nextOperation.operationId,
        durableTradeId: nextOperation.tradeId,
        updatedAt: Date.now(),
      });
      await database.swapSessions.put({
        ...sessionRow,
        session: nextSession,
        updatedAt: Date.now(),
      });
      result = {
        session: structuredClone(nextSession),
        operation: structuredClone(nextOperation),
      };
    },
  );
  return result;
}

/** The coordinator addresses semantic link ids; Dexie keeps the native operation key. */
async function findGuiProofOperationByDurableId(
  durableOperationId: string,
  database: GuiDurableRecoveryDatabase = db,
): Promise<ProofOperationRecord | undefined> {
  const operation = await database.proofOperations
    .where("durableOperationId")
    .equals(durableOperationId)
    .first();
  return operation?.durableTradeRecovery?.operationId === durableOperationId
    ? operation
    : undefined;
}
