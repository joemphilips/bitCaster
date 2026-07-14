import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  applyDurableCustodyTransaction,
  claimDurableCustodyScope,
  decodeDurableCustodyRecord,
  decodeDurableCustodyScopeState,
  reduceDurableCustodyState,
  validateDurableCustodyScopeRegistration,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyOperationTransition,
  type DurableCustodyRecord,
  type DurableCustodyRecoveryPage,
  type DurableCustodyRecoveryPageInput,
  type DurableCustodyScope,
  type DurableCustodyScopeClaimInput,
  type DurableCustodyScopeState,
  type DurableCustodyStore,
  type DurableCustodyTransaction,
  type DurableCustodyTransactionInput,
  type DurableCustodyTransactionWork,
  DURABLE_CUSTODY_RECOVERY_PAGE_LIMIT_MAX,
} from "@bitcaster-market/client-sdk/durableCustody";
import { openProfileDatabase, tableExists } from "./profile.ts";

const CUSTODY_SCHEMA_VERSION = 1;
const CUSTODY_TABLES = [
  "custody_schema_metadata",
  "custody_scopes",
  "custody_scope_state",
  "custody_operations",
  "custody_operation_inputs",
  "custody_session_links",
  "custody_proof_reservations",
  "custody_verification_bindings",
  "custody_active_work",
] as const;

/**
 * SQLite physical adapter for the shared custody port. Canonical record
 * validation remains in the SDK; this file owns only SQLite layout and the
 * single physical transaction that makes logical rows visible together.
 */
export class SqliteDurableCustodyStore implements DurableCustodyStore {
  async listRecoverablePage(
    input: DurableCustodyRecoveryPageInput,
  ): Promise<DurableCustodyRecoveryPage> {
    const scope = canonicalizeScope(input.scope);
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > DURABLE_CUSTODY_RECOVERY_PAGE_LIMIT_MAX
    ) {
      throw new Error("custody recovery page limit is invalid");
    }
    if (
      input.cursor !== null &&
      (typeof input.cursor !== "string" || input.cursor.length === 0)
    ) {
      throw new Error("custody recovery page cursor is invalid");
    }
    const database = this.openDatabase();
    try {
      assertRegisteredScope(database, scope);
      const rows = database
        .prepare(
          `SELECT operation.*
             FROM custody_active_work AS active
             JOIN custody_operations AS operation
               ON operation.scope_id = active.scope_id
              AND operation.operation_id = active.operation_id
            WHERE active.scope_id = ?
              AND (? IS NULL OR active.operation_id > ?)
            ORDER BY active.operation_id
            LIMIT ?`,
        )
        .all(
          scope.scopeId,
          input.cursor,
          input.cursor,
          input.limit + 1,
        ) as Array<Record<string, unknown>>;
      const hasMore = rows.length > input.limit;
      const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
      const records = pageRows.map((row) =>
        decodeOperationRow(database, row, scope),
      );
      return {
        records,
        nextCursor:
          hasMore && records.length > 0
            ? records[records.length - 1]!.operation.operationId
            : null,
      };
    } finally {
      database.close();
    }
  }

  async registerScope(
    scope: DurableCustodyScope,
  ): Promise<DurableCustodyScopeState> {
    scope = canonicalizeScope(scope);
    const database = this.openDatabase();
    try {
      return inImmediateTransaction(database, () => {
        const existing = readScope(database, scope.scopeId);
        if (existing !== null) {
          validateDurableCustodyScopeRegistration(existing, scope);
          return readScopeState(database, scope);
        }

        if (scope.scopeKind === "market") {
          const conflictingRows = database
            .prepare(
              `SELECT scope_id, schema_version, scope_kind, profile_id, market_id,
                      inventory_account_id, normalized_mint, unit
                 FROM custody_scopes
             WHERE market_id = ?
                OR (normalized_mint = ? AND unit = ? AND inventory_account_id = ?)`,
            )
            .all(
              scope.marketId,
              scope.normalizedMint,
              scope.unit,
              scope.inventoryAccountId,
            ) as Array<Parameters<typeof decodeScopeRow>[0]>;
          for (const row of conflictingRows) {
            const registered = decodeScopeRow(row);
            validateDurableCustodyScopeRegistration(registered, scope);
          }
        }

        insertScope(database, scope);
        const state: DurableCustodyScopeState = {
          schemaVersion: 1,
          scope,
          owner: null,
          effectiveClock: { highWaterMarkMs: 0 },
        };
        insertScopeState(database, state);
        return state;
      });
    } finally {
      database.close();
    }
  }

  async claimScope(
    input: DurableCustodyScopeClaimInput,
  ): Promise<DurableCustodyScopeState> {
    input = { ...input, scope: canonicalizeScope(input.scope) };
    const database = this.openDatabase();
    try {
      return inImmediateTransaction(database, () => {
        assertRegisteredScope(database, input.scope);
        const previous = readScopeState(database, input.scope);
        const next = claimDurableCustodyScope(previous, {
          kind: "owner-claimed",
          nextOwnerId: input.ownerId,
          nextOwnerEpoch: (previous.owner?.epoch ?? 0) + 1,
          observedAtMs: input.observedAtMs,
          nextLeaseExpiresAtMs: input.leaseExpiresAtMs,
        });
        writeScopeState(database, next);
        return next;
      });
    } finally {
      database.close();
    }
  }

  async transact<T>(
    input: DurableCustodyTransactionInput,
    apply: DurableCustodyTransactionWork<T>,
  ): Promise<T> {
    input = { ...input, scope: canonicalizeScope(input.scope) };
    const database = this.openDatabase();
    try {
      return inImmediateTransaction(database, () => {
        assertRegisteredScope(database, input.scope);
        const authorizedState = authorizeScopeOwner(
          readScopeState(database, input.scope),
          input.owner,
        );
        writeScopeState(database, authorizedState);
        const transaction = new SqliteDurableCustodyTransaction(
          database,
          input.scope,
          authorizedState,
          input.owner,
        );
        const result = applyDurableCustodyTransaction(transaction, apply);
        transaction.assertIntegrity();
        return result;
      });
    } finally {
      database.close();
    }
  }

  async listRecoverable(
    scope: DurableCustodyScope,
  ): Promise<DurableCustodyRecord[]> {
    scope = canonicalizeScope(scope);
    const database = this.openDatabase();
    try {
      assertRegisteredScope(database, scope);
      assertScopeIntegrity(database, scope);
      const rows = database
        .prepare(
          `SELECT operation.*
         FROM custody_active_work AS active
         JOIN custody_operations AS operation
           ON operation.scope_id = active.scope_id
          AND operation.operation_id = active.operation_id
         WHERE active.scope_id = ?
         ORDER BY active.operation_id`,
        )
        .all(scope.scopeId) as Array<Record<string, unknown>>;
      return rows.map((row) => decodeOperationRow(database, row, scope));
    } finally {
      database.close();
    }
  }

  async rebuildActiveWorkIndex(
    scope: DurableCustodyScope,
  ): Promise<"rebuilt" | "unavailable"> {
    scope = canonicalizeScope(scope);
    const database = this.openDatabase();
    try {
      return inImmediateTransaction(database, () => {
        assertRegisteredScope(database, scope);
        rebuildActiveWorkIndex(database, scope);
        assertScopeIntegrity(database, scope);
        return "rebuilt";
      });
    } finally {
      database.close();
    }
  }

  private openDatabase(): DatabaseSync {
    const database = openProfileDatabase();
    try {
      ensureSchema(database);
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }
}

class SqliteDurableCustodyTransaction implements DurableCustodyTransaction {
  private readonly database: DatabaseSync;
  private readonly scope: DurableCustodyScope;
  private scopeState: DurableCustodyScopeState;
  private readonly owner: DurableCustodyOwnerAuthorization;

  constructor(
    database: DatabaseSync,
    scope: DurableCustodyScope,
    scopeState: DurableCustodyScopeState,
    owner: DurableCustodyOwnerAuthorization,
  ) {
    this.database = database;
    this.scope = scope;
    this.scopeState = scopeState;
    this.owner = owner;
  }

  getScopeState(): DurableCustodyScopeState {
    return structuredClone(this.scopeState);
  }

  putScopeState(state: DurableCustodyScopeState): void {
    const decoded = decodeDurableCustodyScopeState(state, this.scope);
    if (!sameOwner(this.scopeState.owner, decoded.owner)) {
      throw new Error("custody owner changes require claimScope");
    }
    if (
      decoded.effectiveClock.highWaterMarkMs <
      this.scopeState.effectiveClock.highWaterMarkMs
    ) {
      throw new Error("custody effective clock moves backwards");
    }
    this.scopeState = decoded;
    writeScopeState(this.database, this.scopeState);
  }

  getOperation(operationId: string): DurableCustodyRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM custody_operations
       WHERE scope_id = ? AND operation_id = ?`,
      )
      .get(this.scope.scopeId, operationId) as Record<string, unknown> | undefined;
    return row === undefined ? null : decodeOperationRow(this.database, row, this.scope);
  }

  putOperation(record: DurableCustodyRecord): void {
    const decoded = decodeDurableCustodyRecord(record, this.scope);
    const existing = this.getOperation(decoded.operation.operationId);
    if (existing !== null) {
      if (isDeepStrictEqual(existing, decoded)) return;
      throw new Error(
        "existing custody operations must advance through an SDK reducer transition",
      );
    }
    assertInitialOperation(decoded);
    const foreign = this.database
      .prepare("SELECT scope_id FROM custody_operations WHERE operation_id = ?")
      .get(decoded.operation.operationId) as { scope_id?: unknown } | undefined;
    if (foreign !== undefined && foreign.scope_id !== this.scope.scopeId) {
      throw new Error("custody operation belongs to a foreign scope");
    }

    const currentLink = this.database
      .prepare(
        `SELECT session_id, operation_id, link_kind, trade_id, immutable_trade_fingerprint,
                has_dependent_operation
         FROM custody_session_links WHERE session_id = ?`,
      )
      .get(decoded.operation.sessionLink.sessionId) as
      | {
          session_id?: unknown;
          operation_id?: unknown;
          link_kind?: unknown;
          trade_id?: unknown;
          immutable_trade_fingerprint?: unknown;
          has_dependent_operation?: unknown;
        }
      | undefined;
    if (currentLink !== undefined) {
      if (currentLink.operation_id !== decoded.operation.operationId) {
        throw new Error(
          "custody session link is already owned by another operation",
        );
      }
      assertSessionLinkMatches(decoded, currentLink);
    }

    const otherSession = this.database
      .prepare(
        `SELECT session_id FROM custody_session_links
       WHERE scope_id = ? AND operation_id = ? AND session_id <> ?`,
      )
      .get(
        this.scope.scopeId,
        decoded.operation.operationId,
        decoded.operation.sessionLink.sessionId,
      ) as { session_id?: unknown } | undefined;
    if (otherSession !== undefined) {
      throw new Error("custody operation session link is immutable");
    }

    insertOperationRow(this.database, decoded);
  }

  getSessionLink(
    sessionId: string,
  ): DurableCustodyRecord["operation"]["sessionLink"] | null {
    const row = this.database
      .prepare(
        `SELECT scope_id, session_id, operation_id, link_kind, trade_id,
                immutable_trade_fingerprint, has_dependent_operation
         FROM custody_session_links
       WHERE session_id = ?`,
      )
      .get(sessionId) as
      | {
          scope_id?: unknown;
          session_id?: unknown;
          operation_id?: unknown;
          link_kind?: unknown;
          trade_id?: unknown;
          immutable_trade_fingerprint?: unknown;
          has_dependent_operation?: unknown;
        }
      | undefined;
    if (row === undefined) return null;
    if (
      row.scope_id !== this.scope.scopeId ||
      typeof row.operation_id !== "string"
    ) {
      throw new Error("custody session link is foreign");
    }
    const record = this.getOperation(row.operation_id);
    if (record === null)
      throw new Error("custody session link operation is missing");
    assertSessionLinkMatches(record, row);
    return structuredClone(record.operation.sessionLink);
  }

  putSessionLink(link: DurableCustodyRecord["operation"]["sessionLink"]): void {
    const record = findOperationForSession(
      this.database,
      this.scope,
      link.sessionId,
    );
    if (record === null)
      throw new Error("custody session link has no matching operation");
    if (!sameSessionLink(record.operation.sessionLink, link)) {
      throw new Error("custody session link is foreign");
    }
    const existing = this.database
      .prepare(
        `SELECT scope_id, session_id, operation_id, link_kind, trade_id,
                immutable_trade_fingerprint, has_dependent_operation
         FROM custody_session_links WHERE session_id = ?`,
      )
      .get(link.sessionId) as
      | {
          scope_id?: unknown;
          session_id?: unknown;
          operation_id?: unknown;
          link_kind?: unknown;
          trade_id?: unknown;
          immutable_trade_fingerprint?: unknown;
          has_dependent_operation?: unknown;
        }
      | undefined;
    if (existing !== undefined) {
      if (
        existing.scope_id !== this.scope.scopeId ||
        existing.operation_id !== record.operation.operationId
      ) {
        throw new Error(
          "custody session link is already owned by another operation",
        );
      }
      assertSessionLinkMatches(record, existing);
      return;
    }
    this.database
      .prepare(
        `INSERT INTO custody_session_links (
          scope_id, session_id, operation_id, schema_version, link_kind,
          trade_id, immutable_trade_fingerprint, has_dependent_operation
        ) VALUES (?, ?, ?, 1, 'trade', ?, ?, ?)`,
      )
      .run(
        this.scope.scopeId,
        link.sessionId,
        record.operation.operationId,
        link.tradeId,
        link.immutableTradeFingerprint,
        link.hasDependentOperation ? 1 : 0,
      );
  }

  reserveExactInputs(input: {
    operationId: string;
    reservationId: string;
    proofIds: readonly string[];
  }): void {
    const record = this.getOperation(input.operationId);
    if (record === null)
      throw new Error("custody reservation operation is missing");
    if (record.operation.reservation.reservationId !== input.reservationId) {
      throw new Error("custody reservation id is foreign");
    }
    const expectedProofIds = record.operation.reservation.inputs.map(
      (proof) => proof.proofId,
    );
    if (
      !sameOrderedValues(expectedProofIds, input.proofIds) ||
      new Set(input.proofIds).size !== input.proofIds.length
    ) {
      throw new Error("custody reservation inputs are not exact");
    }
    const existingRows = this.database
      .prepare(
        `SELECT proof_id, reservation_id, input_position, keyset_id, curve
         FROM custody_proof_reservations
       WHERE scope_id = ? AND operation_id = ? ORDER BY proof_id`,
      )
      .all(this.scope.scopeId, input.operationId) as Array<{
      proof_id?: unknown;
      reservation_id?: unknown;
      input_position?: unknown;
      keyset_id?: unknown;
      curve?: unknown;
    }>;
    if (existingRows.length > 0) {
      const existingProofIds = existingRows.map((row) => row.proof_id);
      if (
        !sameUnorderedStringValues(expectedProofIds, existingProofIds) ||
        existingRows.some((row) => {
          const exactInput = record.operation.reservation.inputs.find(
            (candidate) => candidate.proofId === row.proof_id,
          );
          return (
            row.reservation_id !== input.reservationId ||
            exactInput === undefined ||
            row.input_position !==
              record.operation.reservation.inputs.indexOf(exactInput) ||
            row.keyset_id !== exactInput.keysetId ||
            row.curve !== exactInput.curve
          );
        })
      ) {
        throw new Error("custody reservation is incomplete or foreign");
      }
      return;
    }
    for (const [inputPosition, proofId] of expectedProofIds.entries()) {
      const exactInput = record.operation.reservation.inputs[inputPosition];
      if (exactInput === undefined) throw new Error("custody reservation input is missing");
      const owner = this.database
        .prepare(
          `SELECT scope_id, operation_id, reservation_id, input_position, keyset_id, curve
           FROM custody_proof_reservations
         WHERE proof_id = ?`,
        )
        .get(proofId) as
        | {
            scope_id?: unknown;
            operation_id?: unknown;
            reservation_id?: unknown;
            input_position?: unknown;
            keyset_id?: unknown;
            curve?: unknown;
          }
        | undefined;
      if (owner !== undefined) {
        if (
          owner.scope_id !== this.scope.scopeId ||
          owner.operation_id !== input.operationId ||
          owner.reservation_id !== input.reservationId ||
          owner.input_position !== inputPosition ||
          owner.keyset_id !== exactInput.keysetId ||
          owner.curve !== exactInput.curve
        ) {
          throw new Error("proof reservation is already owned");
        }
        continue;
      }
      this.database
        .prepare(
          `INSERT INTO custody_proof_reservations (
          proof_id, scope_id, operation_id, reservation_id, schema_version,
          input_position, keyset_id, curve
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          proofId,
          this.scope.scopeId,
          input.operationId,
          input.reservationId,
          inputPosition,
          exactInput.keysetId,
          exactInput.curve,
        );
    }
  }

  transitionOperation(input: {
    operationId: string;
    transition: DurableCustodyOperationTransition;
  }): void {
    assertOperationTransition(input.transition);
    this.reduceOperation(input.operationId, {
      ...input.transition,
      ...this.owner,
    });
  }

  stageVerifiedResult(input: {
    operationId: string;
    outputPlanFingerprint: string;
    resultHandle: string;
    resultFingerprint: string;
  }): void {
    this.transitionOperation({
      operationId: input.operationId,
      transition: {
        kind: "verified-result-staged",
        outputPlanFingerprint: input.outputPlanFingerprint,
        resultHandle: input.resultHandle,
        resultFingerprint: input.resultFingerprint,
      },
    });
  }

  applyVerifiedResult(input: {
    operationId: string;
    outputPlanFingerprint: string;
    resultHandle: string;
    resultFingerprint: string;
  }): void {
    const record = this.requireOperation(input.operationId);
    if (
      record.operation.result.state !== "verified-staged" ||
      record.operation.result.outputPlanFingerprint !==
        input.outputPlanFingerprint ||
      record.operation.result.resultHandle !== input.resultHandle ||
      record.operation.result.resultFingerprint !== input.resultFingerprint
    ) {
      throw new Error("verified result is foreign or not staged");
    }
    const recoverySource =
      record.operation.state === "transport-attempted"
        ? "transport-attempted"
        : "verified-result-staged";
    this.transitionOperation({
      operationId: input.operationId,
      transition: { kind: "reconciled", recoverySource },
    });
  }

  putDelivery(input: {
    operationId: string;
    deliveryKind: "cipher" | "settlement" | "wallet-send";
    payloadHandle: string;
    payloadFingerprint: string;
    expiresAtMs: number | null;
    state: "pending" | "acknowledged" | "expired";
  }): void {
    assertDeliveryKind(input.deliveryKind);
    if (input.expiresAtMs === null) {
      throw new Error("outbox delivery expiry is required");
    }
    const current = this.requireOperation(input.operationId);
    const deliveryId = `delivery:${current.operation.operationId}:${input.deliveryKind}`;
    if (current.operation.delivery.deliveryKind === "none") {
      if (input.state !== "pending") {
        throw new Error("outbox delivery must begin pending");
      }
      const next = structuredClone(current);
      next.revision += 1;
      next.operation.delivery = {
        deliveryKind: "outbox",
        deliveryId,
        payloadHandle: input.payloadHandle,
        payloadFingerprint: input.payloadFingerprint,
        expiresAtMs: input.expiresAtMs,
        state: "pending",
      };
      this.updateOperation(next);
      return;
    }
    if (current.operation.delivery.deliveryId !== deliveryId
      || current.operation.delivery.payloadHandle !== input.payloadHandle
      || current.operation.delivery.payloadFingerprint !== input.payloadFingerprint
      || current.operation.delivery.expiresAtMs !== input.expiresAtMs) {
      throw new Error("outbox delivery is foreign");
    }
    if (input.state === "pending") {
      if (current.operation.delivery.state !== "pending") {
        throw new Error("outbox delivery cannot return to pending");
      }
      return;
    }
    this.transitionOperation({
      operationId: input.operationId,
      transition: { kind: "delivery-resolved", deliveryState: input.state },
    });
  }

  rebuildActiveWorkIndex(): void {
    rebuildActiveWorkIndex(this.database, this.scope);
  }

  assertIntegrity(): void {
    assertScopeIntegrity(this.database, this.scope);
  }

  private requireOperation(operationId: string): DurableCustodyRecord {
    const record = this.getOperation(operationId);
    if (record === null) throw new Error("custody operation is missing");
    return record;
  }

  private reduceOperation(
    operationId: string,
    transition: Parameters<typeof reduceDurableCustodyState>[1],
  ): void {
    const record = this.requireOperation(operationId);
    const reduced = reduceDurableCustodyState(
      { scopeState: this.scopeState, operation: record },
      transition,
    );
    this.putScopeState(reduced.scopeState);
    this.updateOperation(reduced.operation);
  }

  private updateOperation(record: DurableCustodyRecord): void {
    const decoded = decodeDurableCustodyRecord(record, this.scope);
    const previous = this.requireOperation(decoded.operation.operationId);
    assertOperationMutation(previous, decoded);
    updateOperationRow(this.database, decoded);
  }
}

function ensureSchema(database: DatabaseSync): void {
  const foreignKeys = database.prepare("PRAGMA foreign_keys").get() as
    | { foreign_keys?: unknown }
    | undefined;
  if (foreignKeys?.foreign_keys !== 1)
    throw new Error("SQLite foreign-key enforcement is unavailable");
  const presentTables = CUSTODY_TABLES.filter((table) =>
    tableExists(database, table),
  );
  if (presentTables.length === 0) {
    if (tableExists(database, "daemon_profile_initialization")) {
      throw new Error("custody SQLite schema is missing; refusing repair");
    }
    inImmediateTransaction(database, () => {
      const racingTables = CUSTODY_TABLES.filter((table) =>
        tableExists(database, table),
      );
      if (racingTables.length !== 0) {
        throw new Error(
          "custody SQLite schema initialization raced with another writer",
        );
      }
      createSchema(database);
      database
        .prepare(
          `INSERT INTO custody_schema_metadata (singleton, schema_version)
         VALUES (1, ?)`,
        )
        .run(CUSTODY_SCHEMA_VERSION);
    });
    return;
  }
  if (presentTables.length !== CUSTODY_TABLES.length) {
    throw new Error("custody SQLite schema is incomplete; refusing repair");
  }
  const marker = database
    .prepare(
      "SELECT schema_version FROM custody_schema_metadata WHERE singleton = 1",
    )
    .get() as { schema_version?: unknown } | undefined;
  if (marker?.schema_version !== CUSTODY_SCHEMA_VERSION) {
    throw new Error("custody SQLite schema version is unsupported");
  }
  for (const table of CUSTODY_TABLES) {
    const row = database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table) as { sql?: unknown } | undefined;
    if (typeof row?.sql !== "string" || !row.sql.includes("STRICT")) {
      throw new Error("custody SQLite schema shape is unsupported");
    }
  }
  assertForeignKey(database, "custody_scope_state", "custody_scopes", [
    ["scope_id", "scope_id"],
  ]);
  assertForeignKey(database, "custody_operations", "custody_scopes", [
    ["scope_id", "scope_id"],
  ]);
  assertForeignKey(database, "custody_operation_inputs", "custody_operations", [
    ["scope_id", "scope_id"],
    ["operation_id", "operation_id"],
  ]);
  assertForeignKey(database, "custody_session_links", "custody_operations", [
    ["scope_id", "scope_id"],
    ["operation_id", "operation_id"],
  ]);
  assertForeignKey(database, "custody_proof_reservations", "custody_operations", [
    ["scope_id", "scope_id"],
    ["operation_id", "operation_id"],
  ]);
  assertForeignKey(database, "custody_verification_bindings", "custody_operations", [
    ["scope_id", "scope_id"],
    ["operation_id", "operation_id"],
  ]);
  assertForeignKey(database, "custody_active_work", "custody_operations", [
    ["scope_id", "scope_id"],
    ["operation_id", "operation_id"],
  ]);
}

function assertForeignKey(
  database: DatabaseSync,
  table: string,
  referencedTable: string,
  columns: ReadonlyArray<readonly [string, string]>,
): void {
  const rows = database.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    table?: unknown;
    from?: unknown;
    to?: unknown;
  }>;
  for (const [from, to] of columns) {
    if (!rows.some((row) => row.table === referencedTable && row.from === from && row.to === to)) {
      throw new Error("custody SQLite schema foreign key is unsupported");
    }
  }
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE custody_schema_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS custody_scopes (
      scope_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('profile', 'market')),
      profile_id TEXT,
      market_id TEXT UNIQUE,
      inventory_account_id TEXT,
      normalized_mint TEXT,
      unit TEXT,
      CHECK (
        (scope_kind = 'profile'
          AND profile_id IS NOT NULL
          AND market_id IS NULL
          AND inventory_account_id IS NULL
          AND normalized_mint IS NULL
          AND unit IS NULL)
        OR
        (scope_kind = 'market'
          AND profile_id IS NULL
          AND market_id IS NOT NULL
          AND inventory_account_id IS NOT NULL
          AND normalized_mint IS NOT NULL
          AND unit IS NOT NULL)
      ),
      UNIQUE (normalized_mint, unit, inventory_account_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS custody_scope_state (
      scope_id TEXT PRIMARY KEY REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      owner_id TEXT,
      owner_epoch INTEGER,
      lease_expires_at_ms INTEGER,
      high_water_mark_ms INTEGER NOT NULL,
      CHECK (
        (owner_id IS NULL AND owner_epoch IS NULL AND lease_expires_at_ms IS NULL)
        OR
        (owner_id IS NOT NULL AND owner_epoch IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
      )
    ) STRICT;

    CREATE TABLE IF NOT EXISTS custody_operations (
      scope_id TEXT NOT NULL,
      operation_id TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      retained_operation_key TEXT NOT NULL,
      trade_id TEXT NOT NULL,
      trade_role TEXT NOT NULL CHECK (trade_role IN ('buyer', 'seller')),
      trade_stage TEXT NOT NULL,
      semantic_kind TEXT NOT NULL,
      operation_state TEXT NOT NULL CHECK (operation_state IN ('dispatch-intent', 'transport-attempted', 'reconciled', 'aborted')),
      terminal_replay_evidence_required INTEGER NOT NULL CHECK (terminal_replay_evidence_required IN (0, 1)),
      normalized_mint TEXT NOT NULL,
      unit TEXT NOT NULL,
      inventory_account_id TEXT,
      reservation_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      request_payload_handle TEXT NOT NULL,
      request_output_plan_fingerprint TEXT NOT NULL,
      output_plan_id TEXT NOT NULL,
      output_plan_fingerprint TEXT NOT NULL,
      output_material_handle TEXT NOT NULL,
      private_material_handle TEXT NOT NULL,
      private_material_use_id TEXT NOT NULL,
      private_material_public_fingerprint TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_trade_id TEXT NOT NULL,
      session_immutable_trade_fingerprint TEXT NOT NULL,
      session_has_dependent_operation INTEGER NOT NULL CHECK (session_has_dependent_operation IN (0, 1)),
      result_state TEXT NOT NULL CHECK (result_state IN ('none', 'verified-staged', 'applied')),
      result_handle TEXT,
      result_fingerprint TEXT,
      result_output_plan_fingerprint TEXT,
      verification_output_plan_fingerprint TEXT NOT NULL,
      delivery_kind TEXT NOT NULL CHECK (delivery_kind IN ('none', 'outbox')),
      delivery_id TEXT,
      delivery_payload_handle TEXT,
      delivery_payload_fingerprint TEXT,
      delivery_expires_at_ms INTEGER,
      delivery_state TEXT NOT NULL CHECK (delivery_state IN ('none', 'pending', 'acknowledged', 'expired')),
      retry_attempt INTEGER NOT NULL CHECK (retry_attempt >= 0),
      retry_next_attempt_at_ms INTEGER,
      retry_reason TEXT NOT NULL,
      not_before_ms INTEGER,
      not_after_ms INTEGER,
      safety_margin_ms INTEGER NOT NULL CHECK (safety_margin_ms >= 0),
      keyset_expiry_ms INTEGER,
      tombstone_id TEXT,
      tombstone_trade_id TEXT,
      tombstone_authenticated_terminal INTEGER,
      tombstone_replay_cutoff INTEGER,
      PRIMARY KEY (scope_id, operation_id),
      FOREIGN KEY (scope_id) REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS custody_session_links (
      scope_id TEXT NOT NULL,
      session_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      link_kind TEXT NOT NULL CHECK (link_kind = 'trade'),
      trade_id TEXT NOT NULL,
      immutable_trade_fingerprint TEXT NOT NULL,
      has_dependent_operation INTEGER NOT NULL CHECK (has_dependent_operation IN (0, 1)),
      FOREIGN KEY (scope_id, operation_id)
        REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS custody_operation_inputs (
      scope_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      proof_id TEXT NOT NULL,
      input_position INTEGER NOT NULL CHECK (input_position >= 0),
      keyset_id TEXT NOT NULL,
      curve TEXT NOT NULL CHECK (curve IN ('secp256k1', 'bls12-381')),
      PRIMARY KEY (scope_id, operation_id, proof_id),
      UNIQUE (scope_id, operation_id, input_position),
      FOREIGN KEY (scope_id, operation_id)
        REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS custody_proof_reservations (
      proof_id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      reservation_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      input_position INTEGER NOT NULL CHECK (input_position >= 0),
      keyset_id TEXT NOT NULL,
      curve TEXT NOT NULL CHECK (curve IN ('secp256k1', 'bls12-381')),
      FOREIGN KEY (scope_id, operation_id)
        REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS custody_verification_bindings (
      scope_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      keyset_id TEXT NOT NULL,
      curve TEXT NOT NULL CHECK (curve IN ('secp256k1', 'bls12-381')),
      keyset_fingerprint TEXT NOT NULL,
      require_dleq INTEGER NOT NULL CHECK (require_dleq IN (0, 1)),
      PRIMARY KEY (scope_id, operation_id, keyset_id),
      FOREIGN KEY (scope_id, operation_id)
        REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS custody_active_work (
      scope_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      PRIMARY KEY (scope_id, operation_id),
      FOREIGN KEY (scope_id, operation_id)
        REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
    ) STRICT;
  `);
}

function insertScope(database: DatabaseSync, scope: DurableCustodyScope): void {
  if (scope.scopeKind === "profile") {
    database
      .prepare(
        `INSERT INTO custody_scopes (
        scope_id, schema_version, scope_kind, profile_id, market_id,
        inventory_account_id, normalized_mint, unit
      ) VALUES (?, 1, 'profile', ?, NULL, NULL, NULL, NULL)`,
      )
      .run(scope.scopeId, scope.profileId);
    return;
  }
  database
    .prepare(
      `INSERT INTO custody_scopes (
      scope_id, schema_version, scope_kind, profile_id, market_id,
      inventory_account_id, normalized_mint, unit
    ) VALUES (?, 1, 'market', NULL, ?, ?, ?, ?)`,
    )
    .run(
      scope.scopeId,
      scope.marketId,
      scope.inventoryAccountId,
      scope.normalizedMint,
      scope.unit,
    );
}

function readScope(
  database: DatabaseSync,
  scopeId: string,
): DurableCustodyScope | null {
  const row = database
    .prepare(
      `SELECT scope_id, schema_version, scope_kind, profile_id, market_id,
            inventory_account_id, normalized_mint, unit
     FROM custody_scopes WHERE scope_id = ?`,
    )
    .get(scopeId) as
    | {
        schema_version?: unknown;
        scope_kind?: unknown;
        profile_id?: unknown;
        market_id?: unknown;
        inventory_account_id?: unknown;
        normalized_mint?: unknown;
        unit?: unknown;
        scope_id?: unknown;
      }
    | undefined;
  if (row === undefined) return null;
  if (row.schema_version !== 1)
    throw new Error("unsupported durable custody schema version");
  const scope = decodeScopeRow(row);
  if (scope.scopeId !== scopeId || row.scope_kind !== scope.scopeKind) {
    throw new Error("custody scope row is corrupt");
  }
  if (scope.scopeKind === "profile") {
    if (
      row.profile_id !== scope.profileId ||
      row.market_id !== null ||
      row.inventory_account_id !== null ||
      row.normalized_mint !== null ||
      row.unit !== null
    ) {
      throw new Error("custody scope row is corrupt");
    }
  } else if (
    row.profile_id !== null ||
    row.market_id !== scope.marketId ||
    row.inventory_account_id !== scope.inventoryAccountId ||
    row.normalized_mint !== scope.normalizedMint ||
    row.unit !== scope.unit
  ) {
    throw new Error("custody scope row is corrupt");
  }
  return scope;
}

function assertRegisteredScope(
  database: DatabaseSync,
  requested: DurableCustodyScope,
): void {
  const stored = readScope(database, requested.scopeId);
  if (stored === null) throw new Error("custody scope is not registered");
  validateDurableCustodyScopeRegistration(stored, requested);
}

function readScopeState(
  database: DatabaseSync,
  scope: DurableCustodyScope,
): DurableCustodyScopeState {
  const row = database
    .prepare(
      `SELECT schema_version, owner_id, owner_epoch, lease_expires_at_ms,
            high_water_mark_ms
     FROM custody_scope_state WHERE scope_id = ?`,
    )
    .get(scope.scopeId) as
    | {
        schema_version?: unknown;
        owner_id?: unknown;
        owner_epoch?: unknown;
        lease_expires_at_ms?: unknown;
        high_water_mark_ms?: unknown;
      }
    | undefined;
  if (row === undefined) throw new Error("custody scope state is missing");
  if (row.schema_version !== 1)
    throw new Error("unsupported durable custody schema version");
  const state = decodeScopeStateRow(row, scope);
  const owner = state.owner;
  if (
    row.owner_id !== (owner?.ownerId ?? null) ||
    row.owner_epoch !== (owner?.epoch ?? null) ||
    row.lease_expires_at_ms !== (owner?.leaseExpiresAtMs ?? null) ||
    row.high_water_mark_ms !== state.effectiveClock.highWaterMarkMs
  ) {
    throw new Error("custody scope state row is corrupt");
  }
  return state;
}

function writeScopeState(
  database: DatabaseSync,
  state: DurableCustodyScopeState,
): void {
  const decoded = decodeDurableCustodyScopeState(state, state.scope);
  const owner = decoded.owner;
  const result = database
    .prepare(
      `UPDATE custody_scope_state SET
       schema_version = 1,
       owner_id = ?,
       owner_epoch = ?,
       lease_expires_at_ms = ?,
       high_water_mark_ms = ?
     WHERE scope_id = ?`,
    )
    .run(
      owner?.ownerId ?? null,
      owner?.epoch ?? null,
      owner?.leaseExpiresAtMs ?? null,
      decoded.effectiveClock.highWaterMarkMs,
      decoded.scope.scopeId,
    );
  if (result.changes !== 1) throw new Error("custody scope state is missing");
}

function insertScopeState(
  database: DatabaseSync,
  state: DurableCustodyScopeState,
): void {
  const decoded = decodeDurableCustodyScopeState(state, state.scope);
  const owner = decoded.owner;
  database
    .prepare(
      `INSERT INTO custody_scope_state (
       scope_id, schema_version, owner_id, owner_epoch, lease_expires_at_ms,
       high_water_mark_ms
     ) VALUES (?, 1, ?, ?, ?, ?)`,
    )
    .run(
      decoded.scope.scopeId,
      owner?.ownerId ?? null,
      owner?.epoch ?? null,
      owner?.leaseExpiresAtMs ?? null,
      decoded.effectiveClock.highWaterMarkMs,
    );
}

function decodeScopeRow(row: {
  schema_version?: unknown;
  scope_kind?: unknown;
  profile_id?: unknown;
  market_id?: unknown;
  inventory_account_id?: unknown;
  normalized_mint?: unknown;
  unit?: unknown;
  scope_id?: unknown;
}): DurableCustodyScope {
  if (row.schema_version !== 1) {
    throw new Error("unsupported durable custody schema version");
  }
  return decodeDurableCustodyScopeState({
    schemaVersion: 1,
    scope: row.scope_kind === "profile"
      ? {
        scopeKind: "profile",
        profileId: row.profile_id,
        scopeId: row.scope_id,
      }
      : {
        scopeKind: row.scope_kind,
        marketId: row.market_id,
        inventoryAccountId: row.inventory_account_id,
        normalizedMint: row.normalized_mint,
        unit: row.unit,
        scopeId: row.scope_id,
      },
    owner: null,
    effectiveClock: { highWaterMarkMs: 0 },
  }).scope;
}

function canonicalizeScope(scope: DurableCustodyScope): DurableCustodyScope {
  return decodeDurableCustodyScopeState({
    schemaVersion: 1,
    scope,
    owner: null,
    effectiveClock: { highWaterMarkMs: 0 },
  }).scope;
}

function decodeScopeStateRow(
  row: {
    schema_version?: unknown;
    owner_id?: unknown;
    owner_epoch?: unknown;
    lease_expires_at_ms?: unknown;
    high_water_mark_ms?: unknown;
  },
  scope: DurableCustodyScope,
): DurableCustodyScopeState {
  return decodeDurableCustodyScopeState(
    {
      schemaVersion: row.schema_version,
      scope,
      owner: row.owner_id === null && row.owner_epoch === null && row.lease_expires_at_ms === null
        ? null
        : {
          ownerId: row.owner_id,
          epoch: row.owner_epoch,
          leaseExpiresAtMs: row.lease_expires_at_ms,
        },
      effectiveClock: { highWaterMarkMs: row.high_water_mark_ms },
    },
    scope,
  );
}

function decodeOperationRow(
  database: DatabaseSync,
  row: Record<string, unknown>,
  scope: DurableCustodyScope,
): DurableCustodyRecord {
  if (row.schema_version !== 1) {
    throw new Error("unsupported durable custody schema version");
  }
  const operationId = requireDatabaseText(row.operation_id, "custody operation id");
  const inputRows = database.prepare(
    `SELECT proof_id, input_position, keyset_id, curve
       FROM custody_operation_inputs
     WHERE scope_id = ? AND operation_id = ? ORDER BY input_position`,
  ).all(scope.scopeId, operationId) as Array<Record<string, unknown>>;
  for (const [position, input] of inputRows.entries()) {
    if (input.input_position !== position) {
      throw new Error("custody operation input position is corrupt");
    }
  }
  const verificationRows = database.prepare(
    `SELECT keyset_id, curve, keyset_fingerprint, require_dleq
     FROM custody_verification_bindings
     WHERE scope_id = ? AND operation_id = ? ORDER BY keyset_id`,
  ).all(scope.scopeId, operationId) as Array<Record<string, unknown>>;
  const tombstone = row.tombstone_id === null
    ? null
    : {
      tombstoneId: row.tombstone_id,
      tradeId: row.tombstone_trade_id,
      authenticatedTerminalStatus: decodeDatabaseBoolean(
        row.tombstone_authenticated_terminal,
        "custody tombstone terminal marker",
      ),
      replayCutoffObserved: decodeDatabaseBoolean(
        row.tombstone_replay_cutoff,
        "custody tombstone cutoff marker",
      ),
    };
  return decodeDurableCustodyRecord({
    schemaVersion: row.schema_version,
    revision: row.revision,
    scope,
    operation: {
      operationId,
      retainedOperationKey: row.retained_operation_key,
      trade: {
        tradeId: row.trade_id,
        role: row.trade_role,
        stage: row.trade_stage,
      },
      semanticKind: row.semantic_kind,
      state: row.operation_state,
      terminalReplayEvidenceRequired: decodeDatabaseBoolean(
        row.terminal_replay_evidence_required,
        "custody terminal replay requirement",
      ),
      custodyContext: {
        normalizedMint: row.normalized_mint,
        unit: row.unit,
        inventoryAccountId: row.inventory_account_id,
      },
      reservation: {
        reservationId: row.reservation_id,
        inputs: inputRows.map((input) => ({
          proofId: input.proof_id,
          keysetId: input.keyset_id,
          curve: input.curve,
        })),
      },
      exactRequest: {
        requestId: row.request_id,
        requestFingerprint: row.request_fingerprint,
        payloadHandle: row.request_payload_handle,
        inputProofIds: inputRows.map((input) => input.proof_id),
        outputPlanFingerprint: row.request_output_plan_fingerprint,
      },
      outputPlan: {
        outputPlanId: row.output_plan_id,
        outputPlanFingerprint: row.output_plan_fingerprint,
        outputMaterialHandle: row.output_material_handle,
      },
      privateMaterial: {
        materialHandle: row.private_material_handle,
        useId: row.private_material_use_id,
        publicFingerprint: row.private_material_public_fingerprint,
      },
      result: {
        state: row.result_state,
        resultHandle: row.result_handle,
        resultFingerprint: row.result_fingerprint,
        outputPlanFingerprint: row.result_output_plan_fingerprint,
      },
      verification: {
        outputPlanFingerprint: row.verification_output_plan_fingerprint,
        keysetBindings: verificationRows.map((binding) => ({
          keysetId: binding.keyset_id,
          curve: binding.curve,
          keysetFingerprint: binding.keyset_fingerprint,
          requireDleq: decodeDatabaseBoolean(binding.require_dleq, "custody DLEQ marker"),
        })),
      },
      sessionLink: {
        linkKind: "trade",
        sessionId: row.session_id,
        tradeId: row.session_trade_id,
        immutableTradeFingerprint: row.session_immutable_trade_fingerprint,
        hasDependentOperation: decodeDatabaseBoolean(
          row.session_has_dependent_operation,
          "custody session dependency marker",
        ),
      },
      delivery: {
        deliveryKind: row.delivery_kind,
        deliveryId: row.delivery_id,
        payloadHandle: row.delivery_payload_handle,
        payloadFingerprint: row.delivery_payload_fingerprint,
        expiresAtMs: row.delivery_expires_at_ms,
        state: row.delivery_state,
      },
      retry: {
        attempt: row.retry_attempt,
        nextAttemptAtMs: row.retry_next_attempt_at_ms,
        reason: row.retry_reason,
      },
      horizon: {
        notBeforeMs: row.not_before_ms,
        notAfterMs: row.not_after_ms,
        safetyMarginMs: row.safety_margin_ms,
        keysetExpiryMs: row.keyset_expiry_ms,
      },
    },
    terminalTombstone: tombstone,
  }, scope);
}

function insertOperationRow(database: DatabaseSync, record: DurableCustodyRecord): void {
  persistOperationRow(database, record);
}

function updateOperationRow(database: DatabaseSync, record: DurableCustodyRecord): void {
  persistOperationRow(database, record);
}

function persistOperationRow(database: DatabaseSync, record: DurableCustodyRecord): void {
  const operation = record.operation;
  const tombstone = record.terminalTombstone;
  database.prepare(
    `INSERT INTO custody_operations (
      scope_id, operation_id, schema_version, revision, retained_operation_key,
      trade_id, trade_role, trade_stage, semantic_kind, operation_state,
      terminal_replay_evidence_required,
      normalized_mint, unit, inventory_account_id, reservation_id,
      request_id, request_fingerprint, request_payload_handle, request_output_plan_fingerprint,
      output_plan_id, output_plan_fingerprint, output_material_handle,
      private_material_handle, private_material_use_id, private_material_public_fingerprint,
      session_id, session_trade_id, session_immutable_trade_fingerprint, session_has_dependent_operation,
      result_state, result_handle, result_fingerprint, result_output_plan_fingerprint,
      verification_output_plan_fingerprint,
      delivery_kind, delivery_id, delivery_payload_handle, delivery_payload_fingerprint,
      delivery_expires_at_ms, delivery_state,
      retry_attempt, retry_next_attempt_at_ms, retry_reason,
      not_before_ms, not_after_ms, safety_margin_ms, keyset_expiry_ms,
      tombstone_id, tombstone_trade_id, tombstone_authenticated_terminal, tombstone_replay_cutoff
    ) VALUES (
      ?, ?, 1, ?, ?,
      ?, ?, ?, ?, ?,
      ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?
    )
    ON CONFLICT(scope_id, operation_id) DO UPDATE SET
      schema_version = excluded.schema_version,
      revision = excluded.revision,
      retained_operation_key = excluded.retained_operation_key,
      trade_id = excluded.trade_id,
      trade_role = excluded.trade_role,
      trade_stage = excluded.trade_stage,
      semantic_kind = excluded.semantic_kind,
      operation_state = excluded.operation_state,
      terminal_replay_evidence_required = excluded.terminal_replay_evidence_required,
      normalized_mint = excluded.normalized_mint,
      unit = excluded.unit,
      inventory_account_id = excluded.inventory_account_id,
      reservation_id = excluded.reservation_id,
      request_id = excluded.request_id,
      request_fingerprint = excluded.request_fingerprint,
      request_payload_handle = excluded.request_payload_handle,
      request_output_plan_fingerprint = excluded.request_output_plan_fingerprint,
      output_plan_id = excluded.output_plan_id,
      output_plan_fingerprint = excluded.output_plan_fingerprint,
      output_material_handle = excluded.output_material_handle,
      private_material_handle = excluded.private_material_handle,
      private_material_use_id = excluded.private_material_use_id,
      private_material_public_fingerprint = excluded.private_material_public_fingerprint,
      session_id = excluded.session_id,
      session_trade_id = excluded.session_trade_id,
      session_immutable_trade_fingerprint = excluded.session_immutable_trade_fingerprint,
      session_has_dependent_operation = excluded.session_has_dependent_operation,
      result_state = excluded.result_state,
      result_handle = excluded.result_handle,
      result_fingerprint = excluded.result_fingerprint,
      result_output_plan_fingerprint = excluded.result_output_plan_fingerprint,
      verification_output_plan_fingerprint = excluded.verification_output_plan_fingerprint,
      delivery_kind = excluded.delivery_kind,
      delivery_id = excluded.delivery_id,
      delivery_payload_handle = excluded.delivery_payload_handle,
      delivery_payload_fingerprint = excluded.delivery_payload_fingerprint,
      delivery_expires_at_ms = excluded.delivery_expires_at_ms,
      delivery_state = excluded.delivery_state,
      retry_attempt = excluded.retry_attempt,
      retry_next_attempt_at_ms = excluded.retry_next_attempt_at_ms,
      retry_reason = excluded.retry_reason,
      not_before_ms = excluded.not_before_ms,
      not_after_ms = excluded.not_after_ms,
      safety_margin_ms = excluded.safety_margin_ms,
      keyset_expiry_ms = excluded.keyset_expiry_ms,
      tombstone_id = excluded.tombstone_id,
      tombstone_trade_id = excluded.tombstone_trade_id,
      tombstone_authenticated_terminal = excluded.tombstone_authenticated_terminal,
      tombstone_replay_cutoff = excluded.tombstone_replay_cutoff`,
  ).run(
    record.scope.scopeId,
    operation.operationId,
    record.revision,
    operation.retainedOperationKey,
    operation.trade.tradeId,
    operation.trade.role,
    operation.trade.stage,
    operation.semanticKind,
    operation.state,
    operation.terminalReplayEvidenceRequired ? 1 : 0,
    operation.custodyContext.normalizedMint,
    operation.custodyContext.unit,
    operation.custodyContext.inventoryAccountId,
    operation.reservation.reservationId,
    operation.exactRequest.requestId,
    operation.exactRequest.requestFingerprint,
    operation.exactRequest.payloadHandle,
    operation.exactRequest.outputPlanFingerprint,
    operation.outputPlan.outputPlanId,
    operation.outputPlan.outputPlanFingerprint,
    operation.outputPlan.outputMaterialHandle,
    operation.privateMaterial.materialHandle,
    operation.privateMaterial.useId,
    operation.privateMaterial.publicFingerprint,
    operation.sessionLink.sessionId,
    operation.sessionLink.tradeId,
    operation.sessionLink.immutableTradeFingerprint,
    operation.sessionLink.hasDependentOperation ? 1 : 0,
    operation.result.state,
    operation.result.resultHandle,
    operation.result.resultFingerprint,
    operation.result.outputPlanFingerprint,
    operation.verification.outputPlanFingerprint,
    operation.delivery.deliveryKind,
    operation.delivery.deliveryId,
    operation.delivery.payloadHandle,
    operation.delivery.payloadFingerprint,
    operation.delivery.expiresAtMs,
    operation.delivery.state,
    operation.retry.attempt,
    operation.retry.nextAttemptAtMs,
    operation.retry.reason,
    operation.horizon.notBeforeMs,
    operation.horizon.notAfterMs,
    operation.horizon.safetyMarginMs,
    operation.horizon.keysetExpiryMs,
    tombstone?.tombstoneId ?? null,
    tombstone?.tradeId ?? null,
    tombstone === null ? null : tombstone.authenticatedTerminalStatus ? 1 : 0,
    tombstone === null ? null : tombstone.replayCutoffObserved ? 1 : 0,
  );
  database.prepare(
    "DELETE FROM custody_operation_inputs WHERE scope_id = ? AND operation_id = ?",
  ).run(record.scope.scopeId, operation.operationId);
  for (const [inputPosition, input] of operation.reservation.inputs.entries()) {
    database.prepare(
      `INSERT INTO custody_operation_inputs (
        scope_id, operation_id, proof_id, input_position, keyset_id, curve
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      record.scope.scopeId,
      operation.operationId,
      input.proofId,
      inputPosition,
      input.keysetId,
      input.curve,
    );
  }
  database.prepare(
    "DELETE FROM custody_verification_bindings WHERE scope_id = ? AND operation_id = ?",
  ).run(record.scope.scopeId, operation.operationId);
  for (const binding of operation.verification.keysetBindings) {
    database.prepare(
      `INSERT INTO custody_verification_bindings (
        scope_id, operation_id, keyset_id, curve, keyset_fingerprint, require_dleq
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      record.scope.scopeId,
      operation.operationId,
      binding.keysetId,
      binding.curve,
      binding.keysetFingerprint,
      binding.requireDleq ? 1 : 0,
    );
  }
}

function findOperationForSession(
  database: DatabaseSync,
  scope: DurableCustodyScope,
  sessionId: string,
): DurableCustodyRecord | null {
  const rows = database
    .prepare(
      `SELECT * FROM custody_operations
     WHERE scope_id = ? ORDER BY operation_id`,
    )
    .all(scope.scopeId) as Array<Record<string, unknown>>;
  const matches = rows
    .map((row) => decodeOperationRow(database, row, scope))
    .filter((record) => record.operation.sessionLink.sessionId === sessionId);
  if (matches.length > 1) throw new Error("custody session link is ambiguous");
  return matches[0] ?? null;
}

function rebuildActiveWorkIndex(
  database: DatabaseSync,
  scope: DurableCustodyScope,
): void {
  database
    .prepare("DELETE FROM custody_active_work WHERE scope_id = ?")
    .run(scope.scopeId);
  const rows = database
    .prepare(
      `SELECT * FROM custody_operations
     WHERE scope_id = ? ORDER BY operation_id`,
    )
    .all(scope.scopeId) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const record = decodeOperationRow(database, row, scope);
    if (!isRecoverable(record)) continue;
    database
      .prepare(
        `INSERT INTO custody_active_work (scope_id, operation_id) VALUES (?, ?)`,
      )
      .run(scope.scopeId, record.operation.operationId);
  }
}

function assertScopeIntegrity(
  database: DatabaseSync,
  scope: DurableCustodyScope,
): void {
  const operationRows = database
    .prepare(
      `SELECT * FROM custody_operations
     WHERE scope_id = ? ORDER BY operation_id`,
    )
    .all(scope.scopeId) as Array<Record<string, unknown>>;
  const records = operationRows.map((row) => decodeOperationRow(database, row, scope));
  const recordsByOperation = new Map(
    records.map((record) => [record.operation.operationId, record]),
  );
  const sessionRows = database
    .prepare(
      `SELECT session_id, operation_id, link_kind, trade_id,
              immutable_trade_fingerprint, has_dependent_operation
       FROM custody_session_links
     WHERE scope_id = ?`,
    )
    .all(scope.scopeId) as Array<{
    session_id?: unknown;
    operation_id?: unknown;
    link_kind?: unknown;
    trade_id?: unknown;
    immutable_trade_fingerprint?: unknown;
    has_dependent_operation?: unknown;
  }>;
  const sessionsByOperation = new Map<
    string,
    {
      session_id?: unknown;
      link_kind?: unknown;
      trade_id?: unknown;
      immutable_trade_fingerprint?: unknown;
      has_dependent_operation?: unknown;
    }
  >();
  for (const row of sessionRows) {
    if (
      typeof row.operation_id !== "string" ||
      typeof row.session_id !== "string"
    ) {
      throw new Error("custody session link row is corrupt");
    }
    const record = recordsByOperation.get(row.operation_id);
    if (
      record === undefined ||
      record.operation.sessionLink.sessionId !== row.session_id
    ) {
      throw new Error("custody session link is foreign");
    }
    assertSessionLinkMatches(record, row);
    if (sessionsByOperation.has(row.operation_id))
      throw new Error("custody operation has multiple session links");
    sessionsByOperation.set(row.operation_id, row);
  }

  const reservationRows = database
    .prepare(
      `SELECT proof_id, operation_id, reservation_id, input_position, keyset_id, curve
         FROM custody_proof_reservations
     WHERE scope_id = ?`,
    )
    .all(scope.scopeId) as Array<{
    proof_id?: unknown;
    operation_id?: unknown;
    reservation_id?: unknown;
    input_position?: unknown;
    keyset_id?: unknown;
    curve?: unknown;
  }>;
  const reservationsByOperation = new Map<
    string,
    Array<{
      proof_id?: unknown;
      reservation_id?: unknown;
      input_position?: unknown;
      keyset_id?: unknown;
      curve?: unknown;
    }>
  >();
  for (const row of reservationRows) {
    if (
      typeof row.operation_id !== "string" ||
      typeof row.proof_id !== "string"
    ) {
      throw new Error("custody proof reservation row is corrupt");
    }
    const entries = reservationsByOperation.get(row.operation_id) ?? [];
    entries.push(row);
    reservationsByOperation.set(row.operation_id, entries);
  }

  const indexedRows = database
    .prepare("SELECT operation_id FROM custody_active_work WHERE scope_id = ?")
    .all(scope.scopeId) as Array<{ operation_id?: unknown }>;
  const indexed = new Set(
    indexedRows.map((row) => {
      if (typeof row.operation_id !== "string")
        throw new Error("custody active-work row is corrupt");
      return row.operation_id;
    }),
  );

  for (const record of records) {
    const operationId = record.operation.operationId;
    if (!sessionsByOperation.has(operationId)) {
      throw new Error("custody operation session link is missing");
    }
    const reservations = reservationsByOperation.get(operationId) ?? [];
    const expectedProofIds = record.operation.reservation.inputs.map(
      (proof) => proof.proofId,
    );
    if (
      !sameUnorderedStringValues(
        expectedProofIds,
        reservations.map((row) => row.proof_id),
      ) ||
      reservations.some(
        (row) =>
          row.reservation_id !== record.operation.reservation.reservationId,
      )
    ) {
      throw new Error("custody operation reservation is missing or foreign");
    }
    for (const reservation of reservations) {
      const expectedInput = record.operation.reservation.inputs.find(
        (input) => input.proofId === reservation.proof_id,
      );
      if (
        expectedInput === undefined ||
        reservation.input_position !==
          record.operation.reservation.inputs.indexOf(expectedInput) ||
        reservation.keyset_id !== expectedInput.keysetId ||
        reservation.curve !== expectedInput.curve
      ) {
        throw new Error("custody operation reservation is missing or foreign");
      }
    }
    if (indexed.has(operationId) !== isRecoverable(record)) {
      throw new Error("custody active-work index is missing or stale");
    }
    indexed.delete(operationId);
  }
  if (indexed.size !== 0)
    throw new Error("custody active-work index is foreign");
}

function authorizeScopeOwner(
  state: DurableCustodyScopeState,
  owner: DurableCustodyOwnerAuthorization,
): DurableCustodyScopeState {
  if (state.owner === null) throw new Error("custody scope is unclaimed");
  if (
    state.owner.ownerId !== owner.ownerId ||
    state.owner.epoch !== owner.ownerEpoch
  ) {
    throw new Error("custody owner epoch is foreign");
  }
  const effectiveNowMs = Math.max(
    state.effectiveClock.highWaterMarkMs,
    owner.observedAtMs,
  );
  if (effectiveNowMs >= state.owner.leaseExpiresAtMs) {
    throw new Error("custody owner lease has expired");
  }
  const next = structuredClone(state);
  next.effectiveClock.highWaterMarkMs = effectiveNowMs;
  return next;
}

function assertInitialOperation(record: DurableCustodyRecord): void {
  if (
    record.revision !== 0 ||
    record.operation.state !== "dispatch-intent" ||
    record.operation.result.state !== "none" ||
    record.operation.delivery.deliveryKind !== "none" ||
    record.operation.retry.attempt !== 0 ||
    record.operation.retry.nextAttemptAtMs !== null ||
    record.operation.retry.reason !== "none" ||
    record.terminalTombstone !== null
  ) {
    throw new Error("new custody operation is not a dispatch intent");
  }
}

function assertOperationMutation(
  previous: DurableCustodyRecord,
  next: DurableCustodyRecord,
): void {
  if (!sameImmutableOperation(previous, next)) {
    throw new Error("custody operation immutable bindings changed");
  }
  if (next.revision !== previous.revision + 1) {
    throw new Error("custody operation revision is not monotonic");
  }
}

function sameImmutableOperation(
  left: DurableCustodyRecord,
  right: DurableCustodyRecord,
): boolean {
  return (
    isDeepStrictEqual({
      scope: left.scope,
      operation: {
        operationId: left.operation.operationId,
        retainedOperationKey: left.operation.retainedOperationKey,
        trade: left.operation.trade,
        semanticKind: left.operation.semanticKind,
        terminalReplayEvidenceRequired:
          left.operation.terminalReplayEvidenceRequired,
        custodyContext: left.operation.custodyContext,
        reservation: left.operation.reservation,
        exactRequest: left.operation.exactRequest,
        outputPlan: left.operation.outputPlan,
        privateMaterial: left.operation.privateMaterial,
        verification: left.operation.verification,
        sessionLink: left.operation.sessionLink,
      },
    }, {
      scope: right.scope,
      operation: {
        operationId: right.operation.operationId,
        retainedOperationKey: right.operation.retainedOperationKey,
        trade: right.operation.trade,
        semanticKind: right.operation.semanticKind,
        terminalReplayEvidenceRequired:
          right.operation.terminalReplayEvidenceRequired,
        custodyContext: right.operation.custodyContext,
        reservation: right.operation.reservation,
        exactRequest: right.operation.exactRequest,
        outputPlan: right.operation.outputPlan,
        privateMaterial: right.operation.privateMaterial,
        verification: right.operation.verification,
        sessionLink: right.operation.sessionLink,
      },
    })
  );
}

function assertDeliveryKind(
  value: unknown,
): asserts value is "cipher" | "settlement" | "wallet-send" {
  switch (value) {
    case "cipher":
    case "settlement":
    case "wallet-send":
      return;
    default:
      throw new Error("outbox delivery kind is invalid");
  }
}

function assertOperationTransition(value: DurableCustodyOperationTransition): void {
  switch (value.kind) {
    case "transport-attempted":
    case "retry-scheduled":
    case "verified-result-staged":
    case "abort-no-transport":
    case "reconciled":
    case "delivery-resolved":
    case "terminal-tombstone-created":
    case "terminal-tombstone-confirmed":
      return;
    default:
      throw new Error("durable custody operation transition is invalid");
  }
}

function isRecoverable(record: DurableCustodyRecord): boolean {
  switch (record.operation.state) {
    case "dispatch-intent":
    case "transport-attempted":
      return true;
    case "reconciled":
      return (
        record.operation.delivery.deliveryKind === "outbox" &&
        record.operation.delivery.state === "pending"
      );
    case "aborted":
      return false;
  }
}

function assertSessionLinkMatches(
  record: DurableCustodyRecord,
  row: unknown,
): void {
  if (!sameSessionLinkRow(record.operation.sessionLink, row)) {
    throw new Error("custody session link is foreign");
  }
}

function sameSessionLink(
  left: DurableCustodyRecord["operation"]["sessionLink"],
  right: unknown,
): boolean {
  if (typeof right !== "object" || right === null || Array.isArray(right))
    return false;
  const candidate = right as Record<string, unknown>;
  return (
    candidate.linkKind === left.linkKind &&
    candidate.sessionId === left.sessionId &&
    candidate.tradeId === left.tradeId &&
    candidate.immutableTradeFingerprint === left.immutableTradeFingerprint &&
    candidate.hasDependentOperation === left.hasDependentOperation &&
    Object.keys(candidate).length === 5
  );
}

function sameSessionLinkRow(
  left: DurableCustodyRecord["operation"]["sessionLink"],
  right: unknown,
): boolean {
  if (typeof right !== "object" || right === null || Array.isArray(right)) {
    return false;
  }
  const row = right as Record<string, unknown>;
  return row.link_kind === left.linkKind
    && row.session_id === left.sessionId
    && row.trade_id === left.tradeId
    && row.immutable_trade_fingerprint === left.immutableTradeFingerprint
    && decodeDatabaseBoolean(row.has_dependent_operation, "custody session dependency marker")
      === left.hasDependentOperation;
}

function sameOwner(
  left: DurableCustodyScopeState["owner"],
  right: DurableCustodyScopeState["owner"],
): boolean {
  return (
    left?.ownerId === right?.ownerId &&
    left?.epoch === right?.epoch &&
    left?.leaseExpiresAtMs === right?.leaseExpiresAtMs
  );
}

function sameOrderedValues(
  expected: readonly string[],
  actual: readonly string[],
): boolean {
  return (
    expected.length === actual.length &&
    expected.every((value, index) => value === actual[index])
  );
}

function sameUnorderedStringValues(
  expected: readonly string[],
  actual: readonly unknown[],
): boolean {
  if (expected.length !== actual.length) return false;
  const expectedValues = [...expected].sort();
  const actualValues = actual
    .map((value) => {
      if (typeof value !== "string")
        throw new Error("custody row contains an invalid identifier");
      return value;
    })
    .sort();
  return expectedValues.every((value, index) => value === actualValues[index]);
}

function requireDatabaseText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is corrupt`);
  }
  return value;
}

function decodeDatabaseBoolean(value: unknown, name: string): boolean {
  switch (value) {
    case 0:
      return false;
    case 1:
      return true;
    default:
      throw new Error(`${name} is corrupt`);
  }
}

function inImmediateTransaction<T>(database: DatabaseSync, apply: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = apply();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The transaction may already have completed after an external fault.
    }
    throw error;
  }
}
