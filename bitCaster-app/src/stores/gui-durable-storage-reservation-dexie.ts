import Dexie from "dexie";
import {
  DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION,
  calculateDurableSwapStorageBudget,
  createDurableStorageReservationArtifactPlan,
  createDurableStorageReservationPlan,
  type DurableStoragePlannedArtifact,
  type DurableStorageReservationArtifactPlan,
} from "@bitcaster/client-sdk/durableStorageAdmission";
import { requireDurableWalletProofTransition } from "@bitcaster/client-sdk/durableWalletProofTransition";
import {
  assertScopeRow,
  decodeSnapshot,
  type CustodySnapshot,
  type DexieCustodyOperationRow,
  type DexieCustodyProofReservationRow,
  type DexieCustodyScopeRow,
  type DexieCustodySessionLinkRow,
} from "./durable-custody-dexie-model";
import { createGuiDurableStorageRowArtifact } from "./gui-durable-storage-artifacts";
import { requireGuiDexieWriteTransaction } from "./gui-dexie-transaction";
import { guiWalletContextForWallet } from "./gui-custody-authority";
import {
  walletIdFromHeldGuiOriginStorageAdmissionLock,
  type GuiOriginStorageAdmissionLockContext,
} from "./gui-origin-storage-admission-lock";
import {
  db,
  locateStoredProofs,
  requireProofOperationRecord,
  requireStoredProofRow,
  storedProofIds,
  type BitcasterDB,
  type ProofOperationRecord,
} from "./proof-db";

const GUI_STORAGE_OPERATION_LIMIT = 8;

export interface GuiDurableStorageReservationArtifacts {
  artifactPlan: DurableStorageReservationArtifactPlan;
  artifacts: DurableStoragePlannedArtifact[];
}

export async function readGuiDurableStorageReservationArtifactsInCurrentTransaction(input: {
  originLock: GuiOriginStorageAdmissionLockContext;
  tradeId: string;
  database?: BitcasterDB;
}): Promise<GuiDurableStorageReservationArtifacts> {
  const walletId = walletIdFromHeldGuiOriginStorageAdmissionLock(
    input.originLock,
  );
  const scope = guiWalletContextForWallet(walletId).scope;
  const database = input.database ?? db;
  requireCurrentWriteTransaction(database);
  const session = await database.swapSessions.get(input.tradeId);
  requireCurrentWriteTransaction(database);
  if (!session || session.walletId !== walletId) {
    throw new Error("GUI durable storage session is missing or foreign");
  }
  const custody = await readTradeCustodySnapshot(
    database,
    scope,
    input.tradeId,
  );
  const operationArtifacts = await readOperationArtifacts(
    database,
    walletId,
    input.tradeId,
    custody.snapshot,
  );
  const sessionArtifact = createGuiDurableStorageRowArtifact({
    table: "swapSessions",
    key: input.tradeId,
    artifactRole: "trade-session",
    row: session,
  });
  return createReservationArtifacts({
    scopeId: scope.scopeId,
    tradeId: input.tradeId,
    sessionArtifact,
    operationArtifacts,
    custody,
  });
}

function createReservationArtifacts(input: {
  scopeId: string;
  tradeId: string;
  sessionArtifact: DurableStoragePlannedArtifact;
  operationArtifacts: OperationArtifacts[];
  custody: TradeCustodySnapshot;
}): GuiDurableStorageReservationArtifacts {
  const budget = calculateDurableSwapStorageBudget({
    schemaVersion: DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION,
    scopeId: input.scopeId,
    swapId: input.tradeId,
    session: input.sessionArtifact,
    operations: input.operationArtifacts.map(
      ({ operationId, ...artifacts }) => ({
        semanticOperationId: operationId,
        ...artifacts,
      }),
    ),
  });
  const reservation = createDurableStorageReservationPlan({
    reservationId: input.tradeId,
    budget,
  });
  const transactionOnlyArtifacts = scopeArtifacts(
    input.custody.snapshot,
    input.custody.scopeRow,
  );
  return {
    artifactPlan: createDurableStorageReservationArtifactPlan({
      reservation,
      transactionOnlyArtifacts,
    }),
    artifacts: [
      input.sessionArtifact,
      ...input.operationArtifacts.flatMap(operationArtifactValues),
      ...transactionOnlyArtifacts,
    ],
  };
}

interface TradeCustodySnapshot {
  snapshot: CustodySnapshot;
  scopeRow: DexieCustodyScopeRow;
}

async function readTradeCustodySnapshot(
  database: BitcasterDB,
  scope: ReturnType<typeof guiWalletContextForWallet>["scope"],
  tradeId: string,
): Promise<TradeCustodySnapshot> {
  const scopeRow = await database.custodyScopes.get(scope.scopeId);
  requireCurrentWriteTransaction(database);
  if (!scopeRow) throw new Error("GUI custody scope row is missing");
  assertScopeRow(scopeRow, scope);
  const stateRow = await database.custodyScopeStates.get(scope.scopeId);
  requireCurrentWriteTransaction(database);
  if (!stateRow) throw new Error("GUI custody scope state row is missing");
  const links = await readTradeLinks(database, scope.scopeId, tradeId);
  const operationIds = links.map(({ operationId }) => operationId).sort();
  const operations = await database.custodyOperations.bulkGet(operationIds);
  requireCurrentWriteTransaction(database);
  const linksById = new Map(links.map((row) => [row.operationId, row]));
  const reservations = await readTradeReservations(
    database,
    scope.scopeId,
    operationIds,
  );
  return {
    scopeRow,
    snapshot: decodeSnapshot(
      scope,
      stateRow,
      operationIds,
      operations,
      operationIds.map((operationId) => linksById.get(operationId)),
      reservations,
    ),
  };
}

function readTradeLinks(
  database: BitcasterDB,
  scopeId: string,
  tradeId: string,
) {
  return database.custodySessionLinks
    .where("[scopeId+sessionId+operationId]")
    .between([scopeId, tradeId, Dexie.minKey], [scopeId, tradeId, Dexie.maxKey])
    .limit(GUI_STORAGE_OPERATION_LIMIT + 1)
    .toArray()
    .then((links) => {
      requireCurrentWriteTransaction(database);
      if (links.length === 0 || links.length > GUI_STORAGE_OPERATION_LIMIT) {
        throw new Error("GUI durable storage operation count is invalid");
      }
      return links;
    });
}

function readTradeReservations(
  database: BitcasterDB,
  scopeId: string,
  operationIds: readonly string[],
): Promise<DexieCustodyProofReservationRow[]> {
  return Dexie.Promise.all(
    operationIds.map((operationId) =>
      database.custodyProofReservations
        .where("[scopeId+operationId]")
        .equals([scopeId, operationId])
        .toArray(),
    ),
  ).then((pages) => {
    requireCurrentWriteTransaction(database);
    return pages.flat();
  });
}

interface OperationArtifacts {
  operationId: string;
  exactOperation: DurableStoragePlannedArtifact;
  proofReferences: DurableStoragePlannedArtifact[];
  privateMaterial: DurableStoragePlannedArtifact[];
  ciphers: DurableStoragePlannedArtifact[];
  transitionOverhead: DurableStoragePlannedArtifact[];
}

async function readOperationArtifacts(
  database: BitcasterDB,
  walletId: string,
  tradeId: string,
  snapshot: CustodySnapshot,
): Promise<OperationArtifacts[]> {
  const operationIds = [...snapshot.operationRows.keys()].sort();
  const native = new Map<string, ProofOperationRecord>();
  for (const operationId of operationIds) {
    const rows = await database.proofOperations
      .where("custodyOperationId")
      .equals(operationId)
      .limit(2)
      .toArray();
    requireCurrentWriteTransaction(database);
    if (rows.length !== 1) {
      throw new Error("GUI exact proof-operation row is missing or duplicated");
    }
    const operation = requireProofOperationRecord(
      rows[0],
      walletId,
      rows[0]!.operationId,
    );
    if (
      operation.custodyOperationId !== operationId ||
      operation.durableTradeId !== tradeId
    ) {
      throw new Error("GUI exact proof operation belongs to another trade");
    }
    native.set(operationId, operation);
  }
  const consumedProofs = consumedProofIds(native);
  await assertProofRowsAbsent(database, consumedProofs);
  const proofOwners = assignProofOwners(snapshot, native, consumedProofs);
  const result: OperationArtifacts[] = [];
  for (const operationId of operationIds) {
    result.push(
      await operationArtifacts(
        database,
        walletId,
        operationId,
        native.get(operationId)!,
        snapshot,
        proofOwners,
      ),
    );
  }
  return result;
}

function assignProofOwners(
  snapshot: CustodySnapshot,
  operations: ReadonlyMap<string, ProofOperationRecord>,
  consumedProofs: ReadonlySet<string>,
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const operationId of [...operations.keys()].sort()) {
    const operation = operations.get(operationId)!;
    const policy = requireDurableWalletProofTransition(
      operation.metadata,
      Object.keys(operation.outputs),
    );
    if (policy.inputSource !== "wallet") continue;
    for (const row of snapshot.reservationsByOperation.get(operationId) ?? []) {
      if (consumedProofs.has(row.proofId)) continue;
      if (owners.has(row.proofId)) {
        throw new Error("GUI proof is reserved by multiple custody operations");
      }
      owners.set(row.proofId, operationId);
    }
  }
  const resultProducers = new Map<string, string>();
  for (const [operationId, operation] of [...operations].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    for (const proofId of resultProofIds(operation)) {
      if (resultProducers.has(proofId)) {
        throw new Error("GUI proof was produced by multiple operations");
      }
      resultProducers.set(proofId, operationId);
    }
  }
  for (const [proofId, operationId] of resultProducers) {
    if (!consumedProofs.has(proofId) && !owners.has(proofId)) {
      owners.set(proofId, operationId);
    }
  }
  return owners;
}

function consumedProofIds(
  operations: ReadonlyMap<string, ProofOperationRecord>,
): Set<string> {
  const consumed = new Set<string>();
  for (const operation of operations.values()) {
    const policy = requireDurableWalletProofTransition(
      operation.metadata,
      Object.keys(operation.outputs),
    );
    if (operation.state !== "completed" || policy.inputSource !== "wallet") {
      continue;
    }
    const ids = storedProofIds(
      locateStoredProofs(
        operation.inputs,
        operation.mintUrl,
        operation.metadata.unit,
      ),
    );
    for (const proofId of ids) {
      if (consumed.has(proofId)) {
        throw new Error("GUI proof was consumed by multiple operations");
      }
      consumed.add(proofId);
    }
  }
  return consumed;
}

async function assertProofRowsAbsent(
  database: BitcasterDB,
  proofIds: ReadonlySet<string>,
): Promise<void> {
  if (proofIds.size === 0) return;
  const rows = await database.proofs.bulkGet([...proofIds]);
  requireCurrentWriteTransaction(database);
  if (rows.some((row) => row !== undefined)) {
    throw new Error("GUI consumed proof still has a physical row");
  }
}

function resultProofIds(operation: ProofOperationRecord): string[] {
  if (operation.state !== "completed") return [];
  const policy = requireDurableWalletProofTransition(
    operation.metadata,
    Object.keys(operation.outputs),
  );
  const proofs = Object.entries(operation.resultProofs ?? {}).flatMap(
    ([label, values]) =>
      policy.resultGroups[label]?.kind === "wallet" ? values : [],
  );
  if (proofs.length === 0) return [];
  const unit = operation.metadata.unit;
  if (typeof unit !== "string") {
    throw new Error("GUI proof operation result has no exact unit");
  }
  return storedProofIds(locateStoredProofs(proofs, operation.mintUrl, unit));
}

async function operationArtifacts(
  database: BitcasterDB,
  walletId: string,
  operationId: string,
  operation: ProofOperationRecord,
  snapshot: CustodySnapshot,
  proofOwners: ReadonlyMap<string, string>,
): Promise<OperationArtifacts> {
  const operationRow = snapshot.operationRows.get(operationId);
  const linkRow = snapshot.linkRows.get(operationId);
  if (!operationRow || !linkRow) {
    throw new Error("GUI custody operation overhead is incomplete");
  }
  const reservationRows =
    snapshot.reservationsByOperation.get(operationId) ?? [];
  const proofIds = await readOperationProofIds(
    database,
    walletId,
    operationId,
    operation,
    proofOwners,
  );
  const proofReferences = await readProofReferenceArtifacts(
    database,
    walletId,
    proofIds,
  );
  return {
    operationId,
    exactOperation: createGuiDurableStorageRowArtifact({
      table: "proofOperations",
      key: [walletId, operation.operationId],
      artifactRole: "exact-operation",
      row: operation,
    }),
    proofReferences,
    privateMaterial: [],
    ciphers: [],
    transitionOverhead: operationTransitionOverhead(
      operationId,
      operationRow,
      linkRow,
      reservationRows,
    ),
  };
}

function readOperationProofIds(
  database: BitcasterDB,
  walletId: string,
  operationId: string,
  operation: ProofOperationRecord,
  proofOwners: ReadonlyMap<string, string>,
): Promise<string[]> {
  return database.proofs
    .where("[walletId+reservedBy]")
    .equals([walletId, operation.operationId])
    .toArray()
    .then((reservedRows) => {
      requireCurrentWriteTransaction(database);
      const reservedProofIds = reservedRows.map(
        (row) => requireStoredProofRow(row, walletId).proofId,
      );
      for (const proofId of reservedProofIds) {
        const owner = proofOwners.get(proofId);
        if (owner !== undefined && owner !== operationId) {
          throw new Error(
            "GUI reserved proof belongs to another custody operation",
          );
        }
      }
      return [
        ...new Set([
          ...reservedProofIds,
          ...[...proofOwners]
            .filter(([, owner]) => owner === operationId)
            .map(([proofId]) => proofId),
        ]),
      ].sort();
    });
}

function readProofReferenceArtifacts(
  database: BitcasterDB,
  walletId: string,
  proofIds: readonly string[],
): Promise<DurableStoragePlannedArtifact[]> {
  return database.proofs.bulkGet([...proofIds]).then((proofRows) => {
    requireCurrentWriteTransaction(database);
    return proofRows.map((row, index) => {
      if (!row) throw new Error("GUI durable storage proof row is missing");
      const proof = requireStoredProofRow(row, walletId);
      if (proof.proofId !== proofIds[index]) {
        throw new Error("GUI durable storage proof identity changed");
      }
      return createGuiDurableStorageRowArtifact({
        table: "proofs",
        key: proof.proofId,
        artifactRole: "proof-post-image",
        row: proof,
      });
    });
  });
}

function operationTransitionOverhead(
  operationId: string,
  operationRow: DexieCustodyOperationRow,
  linkRow: DexieCustodySessionLinkRow,
  reservationRows: readonly DexieCustodyProofReservationRow[],
): DurableStoragePlannedArtifact[] {
  return [
    createGuiDurableStorageRowArtifact({
      table: "custodyOperations",
      key: operationId,
      artifactRole: "operation-overhead",
      row: operationRow,
    }),
    createGuiDurableStorageRowArtifact({
      table: "custodySessionLinks",
      key: operationId,
      artifactRole: "operation-overhead",
      row: linkRow,
    }),
    ...reservationRows.map((row) =>
      createGuiDurableStorageRowArtifact({
        table: "custodyProofReservations",
        key: row.proofId,
        artifactRole: "operation-overhead",
        row,
      }),
    ),
  ];
}

function scopeArtifacts(
  snapshot: CustodySnapshot,
  physicalScopeRow: unknown,
): DurableStoragePlannedArtifact[] {
  return [
    createGuiDurableStorageRowArtifact({
      table: "custodyScopes",
      key: snapshot.scope.scopeId,
      artifactRole: "transaction-only-retained",
      row: physicalScopeRow,
    }),
    createGuiDurableStorageRowArtifact({
      table: "custodyScopeStates",
      key: snapshot.scope.scopeId,
      artifactRole: "transaction-only-retained",
      row: snapshot.stateRow,
    }),
  ];
}

function operationArtifactValues(
  operation: OperationArtifacts,
): DurableStoragePlannedArtifact[] {
  return [
    operation.exactOperation,
    ...operation.proofReferences,
    ...operation.privateMaterial,
    ...operation.ciphers,
    ...operation.transitionOverhead,
  ];
}

function requireCurrentWriteTransaction(database: BitcasterDB): void {
  requireGuiDexieWriteTransaction(
    database,
    "GUI durable storage enumeration requires the active write transaction",
  );
}
