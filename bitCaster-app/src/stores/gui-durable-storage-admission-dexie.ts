import Dexie from "dexie";
import {
  advanceDurableStorageReservationArtifacts,
  advanceDurablePreTradeSession,
  advanceDurablePreTradePubkeyAttempt,
  applyDurablePreTradeStorageAdmissionBatch,
  bindDurablePreTradeStorageReservation,
  createDurableStorageAccountingState,
  promoteDurablePreTradeSession,
  reduceDurableStorageAccountingState,
  type DurableStorageAccountingState,
  type DurablePreTradeStorageAdmissionBatchPlan,
} from "@bitcaster/client-sdk/durableStorageAdmission";
import {
  readGuiDurableStorageReservationArtifactsInCurrentTransaction,
  type GuiDurableStorageReservationArtifacts,
} from "./gui-durable-storage-reservation-dexie";
import {
  requirePreparedGuiCustodyArtifactWriteSet,
  type PreparedGuiCustodyArtifactWriteSet,
} from "./gui-custody-unit-of-work";
import {
  assertGuiPreTradeStorageCapacityProfile,
  decodeDurableStorageAccountingRow,
  decodeDurableStorageHeadroomRow,
  durableStorageAccountingRow,
  createDurableStorageHeadroomRow,
  GUI_DURABLE_STORAGE_ACCOUNTING_LIMIT_BYTES,
  GUI_DURABLE_STORAGE_HEADROOM_RECORD_ID,
} from "./gui-durable-storage-admission-model";
import { createGuiDurableStorageRowArtifact } from "./gui-durable-storage-artifacts";
import { requireGuiDexieWriteTransaction } from "./gui-dexie-transaction";
import { guiWalletContextForWallet } from "./gui-custody-authority";
import {
  walletIdFromHeldGuiOriginStorageAdmissionLock,
  type GuiOriginStorageAdmissionLockContext,
} from "./gui-origin-storage-admission-lock";
import {
  db,
  type BitcasterDB,
  type SwapIntentRecord,
  type SwapSessionRecord,
} from "./proof-db";
import {
  decodeGuiPendingTradeRecord,
  type PendingTradeRecord,
} from "./pendingTrades";
import { decodeGuiPendingSwapIntentRecord } from "./pending-swap-intent-db";

export function initializeGuiDurableStorageAdmission(
  originLock: GuiOriginStorageAdmissionLockContext,
  database: BitcasterDB = db,
): Promise<DurableStorageAccountingState> {
  walletIdFromHeldGuiOriginStorageAdmissionLock(originLock);
  return database.transaction(
    "rw",
    [
      database.durableStorageAccounting,
      database.durableStorageHeadroom,
      database.proofOperations,
      database.custodyOperations,
      database.custodySessionLinks,
      database.custodyProofReservations,
      database.swapSessions,
      database.swapIntents,
    ],
    () => initializeInCurrentTransaction(database),
  );
}

export function commitGuiPreTradeStorageAdmissionInCurrentTransaction(input: {
  originLock: GuiOriginStorageAdmissionLockContext;
  batch: DurablePreTradeStorageAdmissionBatchPlan;
  pendingTradeKey: readonly [string, string];
  expectedPendingTrade: PendingTradeRecord;
  intents: readonly SwapIntentRecord[];
  database?: BitcasterDB;
}): Promise<DurableStorageAccountingState> {
  try {
    return beginGuiPreTradeStorageAdmission(input);
  } catch (error) {
    return Dexie.Promise.reject(error);
  }
}

function beginGuiPreTradeStorageAdmission(
  input: Parameters<
    typeof commitGuiPreTradeStorageAdmissionInCurrentTransaction
  >[0],
): Promise<DurableStorageAccountingState> {
  const walletId = walletIdFromHeldGuiOriginStorageAdmissionLock(
    input.originLock,
  );
  if (
    input.batch.scopeId !== guiWalletContextForWallet(walletId).scope.scopeId
  ) {
    throw new Error("GUI durable storage admission scope is foreign");
  }
  const database = input.database ?? db;
  requireCurrentWriteTransaction(database);
  return readReadyAccounting(database).then((state) => {
    requireAdmissionOwnership(input.originLock, walletId, database);
    return readExactPendingTrade(
      database,
      walletId,
      input.pendingTradeKey,
      input.expectedPendingTrade,
    ).then((pendingTrade) =>
      commitPreparedPreTradeAdmission(
        input,
        database,
        walletId,
        state,
        pendingTrade,
      ),
    );
  });
}

function commitPreparedPreTradeAdmission(
  input: Parameters<
    typeof commitGuiPreTradeStorageAdmissionInCurrentTransaction
  >[0],
  database: BitcasterDB,
  walletId: string,
  state: DurableStorageAccountingState,
  pendingTrade: PendingTradeRecord,
): Promise<DurableStorageAccountingState> {
  requireAdmissionOwnership(input.originLock, walletId, database);
  const intents = decodePreTradeIntents(
    input.intents,
    walletId,
    pendingTrade,
    input.batch,
  );
  const next = applyDurablePreTradeStorageAdmissionBatch({
    state,
    batch: input.batch,
    artifacts: preTradeAdmissionArtifacts(
      intents,
      pendingTrade,
      input.pendingTradeKey,
    ),
  });
  const exactReplay = next.revision === state.revision;
  return validateStoredPreTradeIntents(
    database,
    walletId,
    intents,
    exactReplay,
  ).then(() =>
    persistPreTradeAdmission(
      input.originLock,
      database,
      walletId,
      intents,
      state,
      next,
      exactReplay,
    ),
  );
}

function preTradeAdmissionArtifacts(
  intents: readonly SwapIntentRecord[],
  pendingTrade: PendingTradeRecord,
  pendingTradeKey: readonly [string, string],
) {
  return [
    ...intents.map((row) =>
      createGuiDurableStorageRowArtifact({
        table: "swapIntents",
        key: row.tradeId,
        artifactRole: "trade-intent",
        row,
      }),
    ),
    createGuiDurableStorageRowArtifact({
      table: "pendingTrades",
      key: pendingTradeKey,
      artifactRole: "transaction-only-retained",
      row: pendingTrade,
    }),
  ];
}

function validateStoredPreTradeIntents(
  database: BitcasterDB,
  walletId: string,
  intents: readonly SwapIntentRecord[],
  exactReplay: boolean,
): Promise<void> {
  return Dexie.Promise.all(
    intents.map((intent) =>
      database.swapIntents.get(intent.tradeId).then((current) => {
        requireCurrentWriteTransaction(database);
        validateStoredPreTradeIntent(current, intent, walletId, exactReplay);
      }),
    ),
  ).then(() => undefined);
}

function validateStoredPreTradeIntent(
  current: SwapIntentRecord | undefined,
  intent: SwapIntentRecord,
  walletId: string,
  exactReplay: boolean,
): void {
  if (current === undefined) {
    if (exactReplay) {
      throw new Error("GUI pre-trade admission replay is physically partial");
    }
    return;
  }
  const decoded = decodeGuiPendingSwapIntentRecord(
    current,
    walletId,
    intent.tradeId,
  );
  if (!sameArtifactRow("swapIntents", intent.tradeId, decoded, intent)) {
    throw new Error("GUI pre-trade intent conflicts with existing authority");
  }
  if (!exactReplay) {
    throw new Error("GUI pre-trade intent has no accounting authority");
  }
}

function persistPreTradeAdmission(
  originLock: GuiOriginStorageAdmissionLockContext,
  database: BitcasterDB,
  walletId: string,
  intents: readonly SwapIntentRecord[],
  state: DurableStorageAccountingState,
  next: DurableStorageAccountingState,
  exactReplay: boolean,
): Promise<DurableStorageAccountingState> {
  requireAdmissionOwnership(originLock, walletId, database);
  if (exactReplay) return Dexie.Promise.resolve(state);
  return database.swapIntents
    .bulkPut(intents)
    .then(() => {
      requireCurrentWriteTransaction(database);
      return database.durableStorageAccounting.put(
        durableStorageAccountingRow(next),
      );
    })
    .then(() => {
      requireAdmissionOwnership(originLock, walletId, database);
      return next;
    });
}

function requireAdmissionOwnership(
  originLock: GuiOriginStorageAdmissionLockContext,
  walletId: string,
  database: BitcasterDB,
): void {
  requireCurrentWriteTransaction(database);
  if (walletIdFromHeldGuiOriginStorageAdmissionLock(originLock) !== walletId) {
    throw new Error("GUI durable storage admission wallet ownership changed");
  }
}

export async function markGuiPreTradePubkeyAttemptInCurrentTransaction(input: {
  originLock: GuiOriginStorageAdmissionLockContext;
  tradeId: string;
  expectedIntent: SwapIntentRecord;
  nextIntent: SwapIntentRecord;
  database?: BitcasterDB;
}): Promise<DurableStorageAccountingState> {
  const walletId = walletIdFromHeldGuiOriginStorageAdmissionLock(
    input.originLock,
  );
  const scopeId = guiWalletContextForWallet(walletId).scope.scopeId;
  const database = input.database ?? db;
  requireCurrentWriteTransaction(database);
  const state = await readReadyAccounting(database);
  requireCurrentWriteTransaction(database);
  const currentValue = await database.swapIntents.get(input.tradeId);
  requireCurrentWriteTransaction(database);
  if (currentValue === undefined) {
    throw new Error("GUI pre-trade intent is missing");
  }
  const current = decodeGuiPendingSwapIntentRecord(
    currentValue,
    walletId,
    input.tradeId,
  );
  const expected = decodeGuiPendingSwapIntentRecord(
    input.expectedIntent,
    walletId,
    input.tradeId,
  );
  const nextIntent = decodeGuiPendingSwapIntentRecord(
    input.nextIntent,
    walletId,
    input.tradeId,
  );
  if (!sameArtifactRow("swapIntents", input.tradeId, current, expected)) {
    throw new Error("GUI pre-trade intent changed before pubkey attempt");
  }
  requirePubkeyAttemptTransition(current, nextIntent);
  const reservation = state.preTradeReservations.find(
    (item) => item.scopeId === scopeId && item.swapId === input.tradeId,
  );
  if (!reservation) {
    throw new Error("GUI pre-trade storage reservation is missing");
  }
  walletIdFromHeldGuiOriginStorageAdmissionLock(input.originLock);
  requireCurrentWriteTransaction(database);
  const next = advanceDurablePreTradePubkeyAttempt({
    state,
    scopeId,
    reservationId: reservation.reservationId,
    previousIntent: createIntentArtifact(current),
    nextIntent: createIntentArtifact(nextIntent),
  });
  walletIdFromHeldGuiOriginStorageAdmissionLock(input.originLock);
  requireCurrentWriteTransaction(database);
  await database.swapIntents.put(nextIntent);
  requireCurrentWriteTransaction(database);
  if (next.revision !== state.revision) {
    await database.durableStorageAccounting.put(
      durableStorageAccountingRow(next),
    );
    requireCurrentWriteTransaction(database);
  }
  walletIdFromHeldGuiOriginStorageAdmissionLock(input.originLock);
  return next;
}

export async function commitGuiPreTradeSessionTransitionInCurrentTransaction(input: {
  originLock: GuiOriginStorageAdmissionLockContext;
  tradeId: string;
  previousSession: SwapSessionRecord | undefined;
  nextSession: SwapSessionRecord;
  database?: BitcasterDB;
}): Promise<DurableStorageAccountingState> {
  const walletId = walletIdFromHeldGuiOriginStorageAdmissionLock(
    input.originLock,
  );
  const scopeId = guiWalletContextForWallet(walletId).scope.scopeId;
  const database = input.database ?? db;
  requireCurrentWriteTransaction(database);
  const state = await readReadyAccounting(database);
  requireCurrentWriteTransaction(database);
  const reservation = state.preTradeReservations.find(
    (item) => item.scopeId === scopeId && item.swapId === input.tradeId,
  );
  if (!reservation) {
    throw new Error("GUI pre-trade storage reservation is missing");
  }
  const storedSession = await database.swapSessions.get(input.tradeId);
  requireCurrentWriteTransaction(database);
  if (
    storedSession === undefined ||
    !sameSessionArtifact(storedSession, input.nextSession)
  ) {
    throw new Error("GUI durable swap session post-image is not exact");
  }
  const next = input.previousSession
    ? advanceDurablePreTradeSession({
        state,
        scopeId,
        reservationId: reservation.reservationId,
        previousSession: createSessionArtifact(input.previousSession),
        nextSession: createSessionArtifact(input.nextSession),
      })
    : await promoteGuiPreTradeSession(
        database,
        state,
        reservation.reservationId,
        input.tradeId,
        scopeId,
        input.nextSession,
      );
  walletIdFromHeldGuiOriginStorageAdmissionLock(input.originLock);
  requireCurrentWriteTransaction(database);
  if (next.revision !== state.revision) {
    await database.durableStorageAccounting.put(
      durableStorageAccountingRow(next),
    );
    requireCurrentWriteTransaction(database);
  }
  walletIdFromHeldGuiOriginStorageAdmissionLock(input.originLock);
  return next;
}

declare const PREPARED_GUI_STORAGE_ARTIFACT_TRANSITION: unique symbol;

export interface PreparedGuiDurableStorageArtifactTransition {
  readonly walletId: string;
  readonly tradeId: string;
  readonly kind: "bind-first" | "advance-bound";
  readonly [PREPARED_GUI_STORAGE_ARTIFACT_TRANSITION]: true;
}

interface PreparedArtifactTransitionState {
  originLock: GuiOriginStorageAdmissionLockContext;
  database: BitcasterDB;
  scopeId: string;
  kind: "bind-first" | "advance-bound";
  previous?: GuiDurableStorageReservationArtifacts;
}

const preparedArtifactTransitions = new WeakMap<
  object,
  PreparedArtifactTransitionState
>();

export function withGuiDurableStorageArtifactTransitionInCurrentTransaction<
  T,
>(input: {
  originLock: GuiOriginStorageAdmissionLockContext;
  tradeId: string;
  action: (prepared: PreparedGuiDurableStorageArtifactTransition) => Promise<T>;
  database?: BitcasterDB;
}): Promise<T> {
  const walletId = walletIdFromHeldGuiOriginStorageAdmissionLock(
    input.originLock,
  );
  const scopeId = guiWalletContextForWallet(walletId).scope.scopeId;
  const database = input.database ?? db;
  requireCurrentWriteTransaction(database);
  return Dexie.Promise.resolve(readReadyAccounting(database)).then((state) => {
    requireCurrentWriteTransaction(database);
    const kind = classifyArtifactTransition(state, scopeId, input.tradeId);
    const previous =
      kind === "advance-bound"
        ? readGuiDurableStorageReservationArtifactsInCurrentTransaction({
            originLock: input.originLock,
            tradeId: input.tradeId,
            database,
          })
        : undefined;
    return Dexie.Promise.resolve(previous).then((resolvedPrevious) => {
      requireCurrentWriteTransaction(database);
      const prepared = Object.freeze({
        walletId,
        tradeId: input.tradeId,
        kind,
      }) as PreparedGuiDurableStorageArtifactTransition;
      preparedArtifactTransitions.set(prepared, {
        originLock: input.originLock,
        database,
        scopeId,
        kind,
        previous: resolvedPrevious,
      });
      return input.action(prepared);
    });
  });
}

export function commitGuiDurableStorageArtifactTransitionInCurrentTransaction(input: {
  prepared: PreparedGuiDurableStorageArtifactTransition;
  writeSet: PreparedGuiCustodyArtifactWriteSet;
  next: GuiDurableStorageReservationArtifacts;
}): Promise<DurableStorageAccountingState> {
  const prepared = requirePreparedArtifactTransition(input.prepared);
  const writeSet = requirePreparedGuiCustodyArtifactWriteSet(input.writeSet);
  requireMatchingPreparedWriteSet(input.prepared, prepared, writeSet);
  return Dexie.Promise.resolve(readReadyAccounting(prepared.database))
    .then((state) => {
      requireCurrentWriteTransaction(prepared.database);
      return prepared.kind === "bind-first"
        ? commitPreparedPreTradeSessionTransition(
            input.prepared,
            prepared,
            writeSet,
          )
        : state;
    })
    .then((state) => {
      const next = applyPreparedArtifactTransition(
        state,
        input.prepared,
        prepared,
        writeSet,
        input.next,
      );
      return Dexie.Promise.resolve(
        writeArtifactTransitionState(prepared, state, next),
      ).then(() => next);
    });
}

function classifyArtifactTransition(
  state: DurableStorageAccountingState,
  scopeId: string,
  tradeId: string,
): "bind-first" | "advance-bound" {
  const preTrade = state.preTradeReservations.some(
    (item) => item.scopeId === scopeId && item.reservationId === tradeId,
  );
  const bound = state.reservations.some(
    (item) =>
      item.scopeId === scopeId &&
      item.reservationId === tradeId &&
      item.swapId === tradeId,
  );
  if (preTrade === bound) {
    throw new Error("GUI durable storage reservation kind is ambiguous");
  }
  return preTrade ? "bind-first" : "advance-bound";
}

function applyPreparedArtifactTransition(
  state: DurableStorageAccountingState,
  token: PreparedGuiDurableStorageArtifactTransition,
  prepared: PreparedArtifactTransitionState,
  writeSet: PreparedGuiCustodyArtifactWriteSet,
  next: GuiDurableStorageReservationArtifacts,
): DurableStorageAccountingState {
  if (prepared.kind === "bind-first") {
    requireExactFirstArtifactSet(writeSet, next);
    return bindDurablePreTradeStorageReservation({
      state,
      scopeId: prepared.scopeId,
      reservationId: token.tradeId,
      artifactPlan: next.artifactPlan,
      artifacts: next.artifacts,
    });
  }
  const previous = requirePreviousArtifactSet(prepared);
  requireExactArtifactDelta(writeSet, previous, next);
  return advanceDurableStorageReservationArtifacts({
    state,
    scopeId: prepared.scopeId,
    reservationId: token.tradeId,
    previousArtifacts: reservationArtifacts(previous),
    nextArtifactPlan: next.artifactPlan,
    nextArtifacts: next.artifacts,
  });
}

function reservationArtifacts(
  value: GuiDurableStorageReservationArtifacts,
): GuiDurableStorageReservationArtifacts["artifacts"] {
  const transactionOnlyIds = new Set(
    value.artifactPlan.transactionOnlyArtifacts.map(
      ({ artifactId }) => artifactId,
    ),
  );
  return value.artifacts.filter(
    ({ artifactId }) => !transactionOnlyIds.has(artifactId),
  );
}

function requirePreparedArtifactTransition(
  token: PreparedGuiDurableStorageArtifactTransition,
): PreparedArtifactTransitionState {
  const prepared = preparedArtifactTransitions.get(token);
  if (
    !prepared ||
    token.walletId !==
      walletIdFromHeldGuiOriginStorageAdmissionLock(prepared.originLock)
  ) {
    throw new Error("GUI storage artifact transition was not prepared");
  }
  requireCurrentWriteTransaction(prepared.database);
  return prepared;
}

function requireMatchingPreparedWriteSet(
  token: PreparedGuiDurableStorageArtifactTransition,
  prepared: PreparedArtifactTransitionState,
  writeSet: PreparedGuiCustodyArtifactWriteSet,
): void {
  if (
    writeSet.database !== prepared.database ||
    writeSet.walletId !== token.walletId ||
    writeSet.tradeId !== token.tradeId
  ) {
    throw new Error("GUI storage artifact write set is foreign");
  }
}

function commitPreparedPreTradeSessionTransition(
  token: PreparedGuiDurableStorageArtifactTransition,
  prepared: PreparedArtifactTransitionState,
  writeSet: PreparedGuiCustodyArtifactWriteSet,
): Promise<DurableStorageAccountingState> {
  if (!writeSet.nextSession) {
    throw new Error(
      "GUI first storage binding requires its session post-image",
    );
  }
  return commitGuiPreTradeSessionTransitionInCurrentTransaction({
    originLock: prepared.originLock,
    tradeId: token.tradeId,
    previousSession: writeSet.previousSession,
    nextSession: writeSet.nextSession,
    database: prepared.database,
  });
}

async function writeArtifactTransitionState(
  prepared: PreparedArtifactTransitionState,
  previous: DurableStorageAccountingState,
  next: DurableStorageAccountingState,
): Promise<void> {
  walletIdFromHeldGuiOriginStorageAdmissionLock(prepared.originLock);
  requireCurrentWriteTransaction(prepared.database);
  if (next.revision === previous.revision) return;
  await prepared.database.durableStorageAccounting.put(
    durableStorageAccountingRow(next),
  );
  requireCurrentWriteTransaction(prepared.database);
  walletIdFromHeldGuiOriginStorageAdmissionLock(prepared.originLock);
}

function requireExactFirstArtifactSet(
  writeSet: PreparedGuiCustodyArtifactWriteSet,
  next: GuiDurableStorageReservationArtifacts,
): void {
  const expected = expectedArtifactMap(writeSet);
  const actual = artifactMap(next);
  if (
    !sameStringSet(new Set(expected.keys()), new Set(actual.keys())) ||
    [...expected].some(
      ([artifactId, artifact]) =>
        artifactSignature(artifact) !==
        artifactSignature(actual.get(artifactId)),
    )
  ) {
    throw new Error(
      `GUI first storage binding is outside its prepared write set: ${artifactMapMismatch(expected, actual)}`,
    );
  }
}

function artifactMapMismatch(
  expected: Map<
    string,
    GuiDurableStorageReservationArtifacts["artifacts"][number]
  >,
  actual: Map<
    string,
    GuiDurableStorageReservationArtifacts["artifacts"][number]
  >,
): string {
  return JSON.stringify({
    missing: [...expected.keys()].filter((id) => !actual.has(id)),
    unexpected: [...actual.keys()].filter((id) => !expected.has(id)),
    changed: [...expected].flatMap(([id, artifact]) =>
      actual.has(id) &&
      artifactSignature(artifact) !== artifactSignature(actual.get(id))
        ? [id]
        : [],
    ),
  });
}

function requireExactArtifactDelta(
  writeSet: PreparedGuiCustodyArtifactWriteSet,
  previous: GuiDurableStorageReservationArtifacts,
  next: GuiDurableStorageReservationArtifacts,
): void {
  const before = artifactMap(previous);
  const after = artifactMap(next);
  const allowed = new Set([
    ...writeSet.postImageArtifacts.map(({ artifactId }) => artifactId),
    ...writeSet.deletedArtifactIds,
  ]);
  requirePreparedPostImage(writeSet, after);
  for (const artifactId of new Set([...before.keys(), ...after.keys()])) {
    if (
      artifactSignature(before.get(artifactId)) !==
        artifactSignature(after.get(artifactId)) &&
      !allowed.has(artifactId)
    ) {
      throw new Error(
        "GUI storage artifact delta is outside its prepared write set",
      );
    }
  }
}

function requirePreparedPostImage(
  writeSet: PreparedGuiCustodyArtifactWriteSet,
  after: ReadonlyMap<
    string,
    GuiDurableStorageReservationArtifacts["artifacts"][number]
  >,
): void {
  const mismatched = writeSet.postImageArtifacts.some(
    (artifact) =>
      artifactSignature(artifact) !==
      artifactSignature(after.get(artifact.artifactId)),
  );
  const retainedDeletion = writeSet.deletedArtifactIds.some((artifactId) =>
    after.has(artifactId),
  );
  if (mismatched || retainedDeletion) {
    throw new Error(
      "GUI storage artifacts do not match the prepared post-image",
    );
  }
}

function expectedArtifactMap(
  writeSet: PreparedGuiCustodyArtifactWriteSet,
): Map<string, GuiDurableStorageReservationArtifacts["artifacts"][number]> {
  const result = new Map<
    string,
    GuiDurableStorageReservationArtifacts["artifacts"][number]
  >();
  for (const artifact of [
    ...writeSet.retainedContextArtifacts,
    ...writeSet.postImageArtifacts,
  ]) {
    if (result.has(artifact.artifactId)) {
      throw new Error(
        "GUI prepared storage artifacts contain a duplicate identity",
      );
    }
    result.set(artifact.artifactId, artifact);
  }
  return result;
}

function artifactMap(
  value: GuiDurableStorageReservationArtifacts,
): Map<string, (typeof value.artifacts)[number]> {
  const result = new Map<string, (typeof value.artifacts)[number]>();
  for (const artifact of value.artifacts) {
    if (result.has(artifact.artifactId)) {
      throw new Error("GUI storage artifact set has a duplicate identity");
    }
    result.set(artifact.artifactId, artifact);
  }
  return result;
}

function artifactSignature(
  artifact:
    | GuiDurableStorageReservationArtifacts["artifacts"][number]
    | undefined,
): string | undefined {
  if (artifact === undefined) return undefined;
  if (artifact.encoding !== "json-utf8") {
    throw new Error("GUI storage artifact must use canonical JSON");
  }
  return `${artifact.artifactRole}\u0000${artifact.encodedJson}`;
}

function sameStringSet(left: Set<string>, right: Set<string>): boolean {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

function requirePreviousArtifactSet(
  prepared: PreparedArtifactTransitionState,
): GuiDurableStorageReservationArtifacts {
  if (!prepared.previous) {
    throw new Error("GUI bound storage reservation pre-image is missing");
  }
  return prepared.previous;
}

async function promoteGuiPreTradeSession(
  database: BitcasterDB,
  state: DurableStorageAccountingState,
  reservationId: string,
  tradeId: string,
  scopeId: string,
  nextSession: SwapSessionRecord,
): Promise<DurableStorageAccountingState> {
  const intentValue = await database.swapIntents.get(tradeId);
  requireCurrentWriteTransaction(database);
  if (intentValue === undefined) {
    throw new Error("GUI pre-trade intent is missing");
  }
  const intent = decodeGuiPendingSwapIntentRecord(
    intentValue,
    nextSession.walletId,
    tradeId,
  );
  const next = promoteDurablePreTradeSession({
    state,
    scopeId,
    reservationId,
    previousIntent: createIntentArtifact(intent),
    session: createSessionArtifact(nextSession),
  });
  await database.swapIntents.delete(tradeId);
  requireCurrentWriteTransaction(database);
  return next;
}

function readExactPendingTrade(
  database: BitcasterDB,
  walletId: string,
  key: readonly [string, string],
  expectedValue: unknown,
): Promise<PendingTradeRecord> {
  if (key[0] !== walletId) {
    throw new Error("GUI pending trade key belongs to another wallet");
  }
  const expected = decodeGuiPendingTradeRecord(expectedValue, walletId);
  if (key[1] !== expected.orderId) {
    throw new Error("GUI pending trade key is invalid");
  }
  return database.pendingTrades.get([key[0], key[1]]).then((storedValue) => {
    if (storedValue === undefined) {
      throw new Error(
        "GUI pre-trade admission requires an existing pending trade",
      );
    }
    const stored = decodeGuiPendingTradeRecord(storedValue, walletId);
    if (!sameArtifactRow("pendingTrades", key, expected, stored)) {
      throw new Error("GUI pending trade changed before pre-trade admission");
    }
    return stored;
  });
}

function decodePreTradeIntents(
  values: readonly SwapIntentRecord[],
  walletId: string,
  pendingTrade: PendingTradeRecord,
  batch: DurablePreTradeStorageAdmissionBatchPlan,
): SwapIntentRecord[] {
  if (values.length === 0 || values.length !== batch.reservations.length) {
    throw new Error("GUI pre-trade admission intent count is invalid");
  }
  const seen = new Set<string>();
  return values.map((value) => {
    const row = decodeGuiPendingSwapIntentRecord(
      value,
      walletId,
      value.tradeId,
    );
    if (seen.has(row.tradeId)) {
      throw new Error("GUI pre-trade admission has a duplicate intent");
    }
    seen.add(row.tradeId);
    if (
      row.intent.orderId !== pendingTrade.orderId ||
      row.intent.marketId !== pendingTrade.marketId
    ) {
      throw new Error("GUI pre-trade intent belongs to another order");
    }
    const reservation = batch.reservations.find(
      (item) => item.swapId === row.tradeId,
    );
    const deadlineMs = Date.parse(row.intent.deadline);
    if (
      !reservation ||
      reservation.scopeId !== batch.scopeId ||
      reservation.orderId !== row.intent.orderId ||
      reservation.marketId !== row.intent.marketId ||
      !Number.isSafeInteger(deadlineMs) ||
      reservation.deadlineMs !== deadlineMs
    ) {
      throw new Error("GUI pre-trade reservation identity is invalid");
    }
    assertGuiPreTradeStorageCapacityProfile(reservation.capacityProfile);
    return row;
  });
}

function sameArtifactRow(
  table: "swapIntents" | "pendingTrades",
  key: string | readonly [string, string],
  left: unknown,
  right: unknown,
): boolean {
  const artifactRole =
    table === "swapIntents" ? "trade-intent" : "transaction-only-retained";
  return (
    createGuiDurableStorageRowArtifact({
      table,
      key,
      artifactRole,
      row: left,
    }).encodedJson ===
    createGuiDurableStorageRowArtifact({
      table,
      key,
      artifactRole,
      row: right,
    }).encodedJson
  );
}

function createIntentArtifact(row: SwapIntentRecord) {
  return createGuiDurableStorageRowArtifact({
    table: "swapIntents",
    key: row.tradeId,
    artifactRole: "trade-intent",
    row,
  });
}

function createSessionArtifact(row: SwapSessionRecord) {
  return createGuiDurableStorageRowArtifact({
    table: "swapSessions",
    key: row.tradeId,
    artifactRole: "trade-session",
    row,
  });
}

function sameSessionArtifact(
  left: SwapSessionRecord,
  right: SwapSessionRecord,
): boolean {
  return (
    createSessionArtifact(left).encodedJson ===
    createSessionArtifact(right).encodedJson
  );
}

function requirePubkeyAttemptTransition(
  current: SwapIntentRecord,
  next: SwapIntentRecord,
): void {
  if (current.submitted) {
    if (!sameArtifactRow("swapIntents", current.tradeId, current, next)) {
      throw new Error("GUI attempted pubkey intent cannot change");
    }
    return;
  }
  const normalized = {
    ...next,
    submitted: current.submitted,
    updatedAt: current.updatedAt,
  };
  if (
    !next.submitted ||
    next.updatedAt < current.updatedAt ||
    !sameArtifactRow("swapIntents", current.tradeId, current, normalized)
  ) {
    throw new Error("GUI pubkey attempt transition is invalid");
  }
}

export async function releaseGuiDurableStorageHeadroomInCurrentTransaction(
  originLock: GuiOriginStorageAdmissionLockContext,
  database: BitcasterDB = db,
): Promise<DurableStorageAccountingState> {
  walletIdFromHeldGuiOriginStorageAdmissionLock(originLock);
  requireCurrentWriteTransaction(database);
  const state = await readStoredAccounting(database);
  requireCurrentWriteTransaction(database);
  if (state.emergencyHeadroom.state !== "ready") {
    throw new Error(
      "GUI durable storage emergency headroom is already released",
    );
  }
  const next = reduceDurableStorageAccountingState(state, {
    kind: "release-emergency-headroom",
    expectedRevision: state.revision,
    reason: "quota-recovery",
  });
  walletIdFromHeldGuiOriginStorageAdmissionLock(originLock);
  await database.durableStorageHeadroom.delete(
    GUI_DURABLE_STORAGE_HEADROOM_RECORD_ID,
  );
  requireCurrentWriteTransaction(database);
  walletIdFromHeldGuiOriginStorageAdmissionLock(originLock);
  await database.durableStorageAccounting.put(
    durableStorageAccountingRow(next),
  );
  requireCurrentWriteTransaction(database);
  walletIdFromHeldGuiOriginStorageAdmissionLock(originLock);
  return next;
}

export async function restoreGuiDurableStorageHeadroomInCurrentTransaction(
  originLock: GuiOriginStorageAdmissionLockContext,
  database: BitcasterDB = db,
): Promise<DurableStorageAccountingState> {
  walletIdFromHeldGuiOriginStorageAdmissionLock(originLock);
  requireCurrentWriteTransaction(database);
  const state = await readStoredAccounting(database);
  requireCurrentWriteTransaction(database);
  if (state.emergencyHeadroom.state !== "released-for-maintenance") {
    throw new Error("GUI durable storage emergency headroom is already ready");
  }
  const next = reduceDurableStorageAccountingState(state, {
    kind: "restore-emergency-headroom",
    expectedRevision: state.revision,
  });
  walletIdFromHeldGuiOriginStorageAdmissionLock(originLock);
  await database.durableStorageHeadroom.add(createDurableStorageHeadroomRow());
  requireCurrentWriteTransaction(database);
  walletIdFromHeldGuiOriginStorageAdmissionLock(originLock);
  await database.durableStorageAccounting.put(
    durableStorageAccountingRow(next),
  );
  requireCurrentWriteTransaction(database);
  walletIdFromHeldGuiOriginStorageAdmissionLock(originLock);
  return next;
}

export function guiDurableStorageAdmissionTables(database: BitcasterDB) {
  return [
    database.durableStorageAccounting,
    database.durableStorageHeadroom,
  ] as const;
}

async function initializeInCurrentTransaction(
  database: BitcasterDB,
): Promise<DurableStorageAccountingState> {
  const accountingRows = await database.durableStorageAccounting
    .limit(2)
    .toArray();
  requireCurrentWriteTransaction(database);
  const headroomRows = await database.durableStorageHeadroom.limit(2).toArray();
  requireCurrentWriteTransaction(database);
  if (accountingRows.length > 1 || headroomRows.length > 1) {
    throw new Error("GUI durable storage singleton rows are corrupt");
  }
  if (accountingRows.length === 1) {
    return validateStoredAdmissionRows(accountingRows[0], headroomRows[0]);
  }
  if (headroomRows.length !== 0) {
    throw new Error("GUI durable storage headroom has no accounting authority");
  }
  await assertNoUnaccountedCustody(database);
  requireCurrentWriteTransaction(database);
  const state = createDurableStorageAccountingState({
    accountingLimitBytes: GUI_DURABLE_STORAGE_ACCOUNTING_LIMIT_BYTES,
  });
  await database.durableStorageAccounting.add(
    durableStorageAccountingRow(state),
  );
  requireCurrentWriteTransaction(database);
  await database.durableStorageHeadroom.add(createDurableStorageHeadroomRow());
  requireCurrentWriteTransaction(database);
  return state;
}

function readReadyAccounting(
  database: BitcasterDB,
): Promise<DurableStorageAccountingState> {
  return readStoredAccounting(database).then((state) => {
    if (state.emergencyHeadroom.state !== "ready") {
      throw new Error("GUI durable storage emergency headroom is unavailable");
    }
    return state;
  });
}

function readStoredAccounting(
  database: BitcasterDB,
): Promise<DurableStorageAccountingState> {
  return Dexie.Promise.all([
    database.durableStorageAccounting.limit(2).toArray(),
    database.durableStorageHeadroom.limit(2).toArray(),
  ]).then(([accountingRows, headroomRows]) => {
    if (accountingRows.length !== 1 || headroomRows.length > 1) {
      throw new Error("GUI durable storage singleton rows are corrupt");
    }
    return validateStoredAdmissionRows(accountingRows[0], headroomRows[0]);
  });
}

function validateStoredAdmissionRows(
  accountingValue: unknown,
  headroomValue: unknown,
): DurableStorageAccountingState {
  if (accountingValue === undefined) {
    throw new Error("GUI durable storage accounting row is missing");
  }
  const accounting = decodeDurableStorageAccountingRow(accountingValue);
  if (accounting.state.emergencyHeadroom.state === "ready") {
    if (headroomValue === undefined) {
      throw new Error("GUI durable storage emergency headroom is missing");
    }
    decodeDurableStorageHeadroomRow(headroomValue);
  } else if (headroomValue !== undefined) {
    throw new Error("GUI durable storage released headroom still exists");
  }
  return accounting.state;
}

function assertNoUnaccountedCustody(database: BitcasterDB): Promise<void> {
  return Dexie.Promise.all([
    database.proofOperations.limit(1).count(),
    database.custodyOperations.limit(1).count(),
    database.custodySessionLinks.limit(1).count(),
    database.custodyProofReservations.limit(1).count(),
    database.swapSessions.limit(1).count(),
    database.swapIntents.limit(1).count(),
  ]).then((counts) => {
    if (counts.some((count) => count !== 0)) {
      throw new Error(
        "GUI durable storage accounting cannot adopt existing custody",
      );
    }
  });
}

function requireCurrentWriteTransaction(database: BitcasterDB): void {
  requireGuiDexieWriteTransaction(
    database,
    "GUI durable storage admission requires the active Dexie write transaction",
  );
}
