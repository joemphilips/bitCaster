import {
  decodeDurableCustodyRecord,
  decodeDurableCustodyScopeState,
  deriveDurableCustodyArtifactFingerprint,
  isDurableCustodyActiveRecoveryRecord,
  validateDurableCustodyScopeRegistration,
  DURABLE_CUSTODY_RECOVERY_PAGE_LIMIT_MAX,
  type DurableCustodyBinding,
  type DurableCustodyRecord,
  type DurableCustodyRecoveryPageInput,
  type DurableCustodyScope,
  type DurableCustodyScopeState,
} from "@bitcaster/client-sdk/durableCustody";

export type TradeBinding = Extract<
  DurableCustodyBinding,
  { kind: "trade" }
>;
export type ActiveMarker = 0 | 1;

export interface DexieCustodyScopeRow {
  scopeId: string;
  scopeKind: DurableCustodyScope["scopeKind"];
  marketId?: string;
  inventoryKey?: string;
  scope: DurableCustodyScope;
}

export interface DexieCustodyScopeStateRow {
  scopeId: string;
  state: DurableCustodyScopeState;
}

export interface DexieCustodyOperationRow {
  operationId: string;
  scopeId: string;
  active: ActiveMarker;
  bindingKind: DurableCustodyBinding["kind"];
  record: DurableCustodyRecord;
}

export interface DexieCustodySessionLinkRow {
  operationId: string;
  scopeId: string;
  sessionId: string;
  binding: TradeBinding;
}

export interface DexieCustodyProofReservationRow {
  proofId: string;
  scopeId: string;
  operationId: string;
  reservationId: string;
  inputPosition: number;
  keysetId: string;
  curve: DurableCustodyRecord["operation"]["reservation"]["inputs"][number]["curve"];
}

export interface CustodySnapshot {
  scope: DurableCustodyScope;
  stateRow: DexieCustodyScopeStateRow;
  operationRows: Map<string, DexieCustodyOperationRow | undefined>;
  linkRows: Map<string, DexieCustodySessionLinkRow | undefined>;
  reservationsByOperation: Map<string, DexieCustodyProofReservationRow[]>;
}

export function decodeSnapshot(
  scope: DurableCustodyScope,
  stateRow: DexieCustodyScopeStateRow,
  operationIds: readonly string[],
  rawOperations: Array<DexieCustodyOperationRow | undefined>,
  rawLinks: Array<DexieCustodySessionLinkRow | undefined>,
  rawReservations: DexieCustodyProofReservationRow[],
): CustodySnapshot {
  const operationRows = new Map<
    string,
    DexieCustodyOperationRow | undefined
  >();
  const linkRows = new Map<string, DexieCustodySessionLinkRow | undefined>();
  const reservationsByOperation = new Map<
    string,
    DexieCustodyProofReservationRow[]
  >();
  operationIds.forEach((operationId, index) => {
    const operation = rawOperations[index];
    const link = rawLinks[index];
    operationRows.set(
      operationId,
      operation ? decodeOperationStorageRow(operation, scope) : undefined,
    );
    linkRows.set(
      operationId,
      link ? decodeLinkRow(link, scope, operationId) : undefined,
    );
    reservationsByOperation.set(operationId, []);
  });
  for (const row of rawReservations) {
    const decoded = decodeReservationRow(row, scope);
    const rows = reservationsByOperation.get(decoded.operationId);
    if (!rows) {
      throw new Error("custody reservation belongs to an unselected operation");
    }
    rows.push(decoded);
  }
  for (const rows of reservationsByOperation.values()) {
    rows.sort((left, right) => left.inputPosition - right.inputPosition);
  }
  return {
    scope,
    stateRow: {
      scopeId: scope.scopeId,
      state: decodeDurableCustodyScopeState(stateRow.state, scope),
    },
    operationRows,
    linkRows,
    reservationsByOperation,
  };
}

export function canonicalScope(
  scope: DurableCustodyScope,
): DurableCustodyScope {
  return initialScopeState(scope).scope;
}

export function initialScopeState(
  scope: DurableCustodyScope,
): DurableCustodyScopeState {
  return decodeDurableCustodyScopeState({
    schemaVersion: 1,
    scope,
    fencingEpoch: 0,
    owner: null,
    effectiveClock: { highWaterMarkMs: 0 },
  });
}

export function scopeRow(scope: DurableCustodyScope): DexieCustodyScopeRow {
  return scope.scopeKind === "wallet"
    ? { scopeId: scope.scopeId, scopeKind: "wallet", scope }
    : {
        scopeId: scope.scopeId,
        scopeKind: "market",
        marketId: scope.marketId,
        inventoryKey: marketInventoryKey(scope),
        scope,
      };
}

export function marketInventoryKey(
  scope: Extract<DurableCustodyScope, { scopeKind: "market" }>,
): string {
  return deriveDurableCustodyArtifactFingerprint({
    normalizedMint: scope.normalizedMint,
    unit: scope.unit,
    inventoryAccountId: scope.inventoryAccountId,
  });
}

export function assertScopeRow(
  row: DexieCustodyScopeRow,
  scope: DurableCustodyScope,
): void {
  if (row.scopeId !== scope.scopeId || row.scopeKind !== scope.scopeKind) {
    throw new Error("custody scope registration is foreign");
  }
  validateDurableCustodyScopeRegistration(canonicalScope(row.scope), scope);
  if (!sameValue(row, scopeRow(scope))) {
    throw new Error("custody scope row is corrupt");
  }
}

export function decodeOperationRow(
  row: DexieCustodyOperationRow,
  scope: DurableCustodyScope,
): DurableCustodyRecord {
  const record = decodeDurableCustodyRecord(row.record, scope);
  if (
    row.operationId !== record.operation.operationId ||
    row.scopeId !== scope.scopeId ||
    row.active !== activeMarker(record) ||
    row.bindingKind !== record.operation.binding.kind
  ) {
    throw new Error("custody operation row is corrupt");
  }
  return record;
}

export function activeMarker(record: DurableCustodyRecord): ActiveMarker {
  return isDurableCustodyActiveRecoveryRecord(record) ? 1 : 0;
}

export function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Map || right instanceof Map) {
    if (!(left instanceof Map) || !(right instanceof Map)) return false;
    if (left.size !== right.size) return false;
    return [...left].every(
      ([key, value]) => right.has(key) && sameValue(value, right.get(key)),
    );
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
    );
  }
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    sameValue(leftKeys, rightKeys) &&
    leftKeys.every((key) => sameValue(left[key], right[key]))
  );
}

export function assertRecoveryPageInput(
  input: DurableCustodyRecoveryPageInput,
): void {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > DURABLE_CUSTODY_RECOVERY_PAGE_LIMIT_MAX
  ) {
    throw new Error("custody recovery page limit is invalid");
  }
  if (input.cursor !== null && !input.cursor) {
    throw new Error("custody recovery page cursor is invalid");
  }
}

function decodeOperationStorageRow(
  row: DexieCustodyOperationRow,
  scope: DurableCustodyScope,
): DexieCustodyOperationRow {
  const record = decodeOperationRow(row, scope);
  return {
    operationId: record.operation.operationId,
    scopeId: scope.scopeId,
    active: activeMarker(record),
    bindingKind: record.operation.binding.kind,
    record,
  };
}

function decodeLinkRow(
  row: DexieCustodySessionLinkRow,
  scope: DurableCustodyScope,
  operationId: string,
): DexieCustodySessionLinkRow {
  if (
    row.operationId !== operationId ||
    row.scopeId !== scope.scopeId ||
    row.sessionId !== row.binding.sessionId ||
    row.binding.kind !== "trade"
  ) {
    throw new Error("custody session link row is corrupt");
  }
  return structuredClone(row);
}

function decodeReservationRow(
  row: DexieCustodyProofReservationRow,
  scope: DurableCustodyScope,
): DexieCustodyProofReservationRow {
  if (
    row.scopeId !== scope.scopeId ||
    !Number.isSafeInteger(row.inputPosition) ||
    row.inputPosition < 0 ||
    !row.proofId ||
    !row.operationId ||
    !row.reservationId ||
    !row.keysetId ||
    (row.curve !== "secp256k1" && row.curve !== "bls12-381")
  ) {
    throw new Error("custody proof reservation row is corrupt");
  }
  return structuredClone(row);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
