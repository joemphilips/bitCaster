import {
  assertCtfRangeOrderPreparationTransition,
  bindCtfRangeOrderPreparationCapability,
  decodeCtfRangeOrderPreparationIdentity,
  decodeCtfRangeOrderPreparationPageCursor,
  decodeCtfRangeOrderPreparationPageLimit,
  decodeCtfRangeOrderPreparationRecord,
  sameCtfRangeOrderPreparationIdentity,
  type CtfRangeOrderPreparationCapability,
  type CtfRangeOrderPreparationIdentity,
  type CtfRangeOrderPreparationLifecycle,
  type CtfRangeOrderPreparationPageCursor,
  type CtfRangeOrderPreparationRecord,
} from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import Dexie, { type Table, type Transaction } from "dexie";
import { db, type BitcasterDB, type CtfRangePreparationConsolidationLinkRow } from "./proof-db";

export interface CtfRangePreparationPage {
  preparations: readonly CtfRangeOrderPreparationRecord[];
  nextCursor: CtfRangeOrderPreparationPageCursor | null;
}

const ACTIVE_PREPARATION_STATES = [
  "prepared",
  "capability-requested",
  "capability-bound",
  "order-submitted",
  "submission-rejected",
] as const satisfies readonly CtfRangeOrderPreparationLifecycle[];

export async function insertCtfRangePreparation(
  input: CtfRangeOrderPreparationIdentity,
  database: BitcasterDB = db,
): Promise<CtfRangeOrderPreparationRecord> {
  return database.transaction("rw", database.ctfRangePreparations, async (transaction) =>
    insertCtfRangePreparationInTransaction(transaction, input, database),
  );
}

export async function insertCtfRangePreparationInTransaction(
  transaction: Transaction,
  input: CtfRangeOrderPreparationIdentity,
  database: BitcasterDB = db,
): Promise<CtfRangeOrderPreparationRecord> {
  return runInCurrentWriteTransaction(
    transaction,
    database,
    [database.ctfRangePreparations],
    async () => {
      const identity = decodeCtfRangeOrderPreparationIdentity(input);
      const key: [string, string] = [identity.scopeId, identity.rangeOperationId];
      const existing = await database.ctfRangePreparations.get(key);
      if (existing) return requireSameIdentity(existing, identity);

      const record = decodeCtfRangeOrderPreparationRecord({
        ...identity,
        lifecycleState: "prepared",
        revision: 0,
        capability: null,
        updatedAtMs: identity.createdAtMs,
      });
      await database.ctfRangePreparations.add(record);
      return decodeCtfRangeOrderPreparationRecord(record);
    },
  );
}

export async function readCtfRangePreparation(
  scopeId: string,
  rangeOperationId: string,
  database: BitcasterDB = db,
): Promise<CtfRangeOrderPreparationRecord | null> {
  const record = await database.ctfRangePreparations.get([scopeId, rangeOperationId]);
  return record ? decodeCtfRangeOrderPreparationRecord(record) : null;
}

export async function readActiveCtfRangePreparationByClientOrderId(
  scopeId: string,
  clientOrderId: string,
  database: BitcasterDB = db,
): Promise<CtfRangeOrderPreparationRecord | null> {
  const rows = await database.ctfRangePreparations
    .where("[scopeId+clientOrderId]")
    .equals([scopeId, clientOrderId])
    .filter((record) => record.lifecycleState !== "terminal")
    .limit(2)
    .toArray();
  if (rows.length > 1) {
    throw new Error("browser CTF range client order has overlapping active preparations");
  }
  return rows[0] ? decodeCtfRangeOrderPreparationRecord(rows[0]) : null;
}

/** Returns whether this wallet scope has any durably submitted range order. */
export async function hasSubmittedCtfRangeOrder(
  scopeId: string,
  database: BitcasterDB = db,
): Promise<boolean> {
  const row = await database.ctfRangePreparations
    .where("[scopeId+lifecycleState+createdAtMs+rangeOperationId]")
    .between([scopeId, "order-submitted"], [scopeId, "order-submitted", []], true, true)
    .first();
  return row?.scopeId === scopeId && row.lifecycleState === "order-submitted";
}

export async function appendCtfRangePreparationConsolidation(
  input: CtfRangePreparationConsolidationLinkRow,
  database: BitcasterDB = db,
): Promise<CtfRangePreparationConsolidationLinkRow> {
  return database.transaction(
    "rw",
    database.ctfRangePreparationConsolidations,
    async (transaction) =>
      appendCtfRangePreparationConsolidationInTransaction(transaction, input, database),
  );
}

export async function appendCtfRangePreparationConsolidationInTransaction(
  transaction: Transaction,
  input: CtfRangePreparationConsolidationLinkRow,
  database: BitcasterDB = db,
): Promise<CtfRangePreparationConsolidationLinkRow> {
  return runInCurrentWriteTransaction(
    transaction,
    database,
    [database.ctfRangePreparationConsolidations],
    async () => {
      if (!Number.isSafeInteger(input.round) || input.round < 0 || input.round > 4_095) {
        throw new Error("browser CTF range consolidation round is invalid");
      }
      const key: [string, string, number] = [input.scopeId, input.rangeOperationId, input.round];
      const existing = await database.ctfRangePreparationConsolidations.get(key);
      if (existing) {
        if (
          existing.operationId !== input.operationId ||
          existing.reservationId !== input.reservationId
        ) {
          throw new Error("browser CTF range consolidation conflicts with its persisted link");
        }
        return existing;
      }
      await database.ctfRangePreparationConsolidations.add(input);
      return input;
    },
  );
}

export async function readCtfRangePreparationConsolidations(
  scopeId: string,
  rangeOperationId: string,
  database: BitcasterDB = db,
): Promise<CtfRangePreparationConsolidationLinkRow[]> {
  return database.ctfRangePreparationConsolidations
    .where("[scopeId+rangeOperationId+round]")
    .between([scopeId, rangeOperationId], [scopeId, rangeOperationId, []], true, true)
    .sortBy("round");
}

export async function bindCtfRangePreparationCapability(
  input: {
    scopeId: string;
    rangeOperationId: string;
    expectedRevision: number;
    capability: CtfRangeOrderPreparationCapability;
    updatedAtMs: number;
  },
  database: BitcasterDB = db,
): Promise<CtfRangeOrderPreparationRecord> {
  return database.transaction("rw", database.ctfRangePreparations, async (transaction) =>
    bindCtfRangePreparationCapabilityInTransaction(transaction, input, database),
  );
}

export async function bindCtfRangePreparationCapabilityInTransaction(
  transaction: Transaction,
  input: {
    scopeId: string;
    rangeOperationId: string;
    expectedRevision: number;
    capability: CtfRangeOrderPreparationCapability;
    updatedAtMs: number;
  },
  database: BitcasterDB = db,
): Promise<CtfRangeOrderPreparationRecord> {
  return runInCurrentWriteTransaction(
    transaction,
    database,
    [database.ctfRangePreparations],
    async () => {
      const current = await requirePreparation(input.scopeId, input.rangeOperationId, database);
      const next = bindCtfRangeOrderPreparationCapability({ current, ...input });
      if (next.revision !== current.revision) {
        await database.ctfRangePreparations.put(next);
      }
      return decodeCtfRangeOrderPreparationRecord(next);
    },
  );
}

export async function transitionCtfRangePreparation(
  input: {
    scopeId: string;
    rangeOperationId: string;
    expectedRevision: number;
    from: CtfRangeOrderPreparationLifecycle;
    to: CtfRangeOrderPreparationLifecycle;
    updatedAtMs: number;
  },
  database: BitcasterDB = db,
): Promise<CtfRangeOrderPreparationRecord> {
  return database.transaction("rw", database.ctfRangePreparations, async (transaction) =>
    transitionCtfRangePreparationInTransaction(transaction, input, database),
  );
}

export async function transitionCtfRangePreparationInTransaction(
  transaction: Transaction,
  input: {
    scopeId: string;
    rangeOperationId: string;
    expectedRevision: number;
    from: CtfRangeOrderPreparationLifecycle;
    to: CtfRangeOrderPreparationLifecycle;
    updatedAtMs: number;
  },
  database: BitcasterDB = db,
): Promise<CtfRangeOrderPreparationRecord> {
  return runInCurrentWriteTransaction(
    transaction,
    database,
    [database.ctfRangePreparations],
    async () => {
      assertCtfRangeOrderPreparationTransition(input.from, input.to);
      const current = await requirePreparation(input.scopeId, input.rangeOperationId, database);
      if (
        current.lifecycleState !== input.from ||
        current.revision !== input.expectedRevision ||
        input.updatedAtMs < current.updatedAtMs
      ) {
        throw new Error("browser CTF range preparation revision or lifecycle changed");
      }
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new Error("browser CTF range preparation revision is exhausted");
      }
      const next = decodeCtfRangeOrderPreparationRecord({
        ...current,
        lifecycleState: input.to,
        revision: current.revision + 1,
        updatedAtMs: input.updatedAtMs,
      });
      await database.ctfRangePreparations.put(next);
      return next;
    },
  );
}

export async function pageActiveCtfRangePreparations(
  input: {
    scopeId: string;
    limit: number;
    after?: CtfRangeOrderPreparationPageCursor;
  },
  database: BitcasterDB = db,
): Promise<CtfRangePreparationPage> {
  const limit = decodeCtfRangeOrderPreparationPageLimit(input.limit);
  const after = input.after ? decodeCtfRangeOrderPreparationPageCursor(input.after) : undefined;
  const rows = (
    await Promise.all(
      ACTIVE_PREPARATION_STATES.map((lifecycleState) => {
        const lower: readonly unknown[] = after
          ? [input.scopeId, lifecycleState, after.createdAtMs, after.rangeOperationId]
          : [input.scopeId, lifecycleState];
        const upper: readonly unknown[] = [input.scopeId, lifecycleState, []];
        return database.ctfRangePreparations
          .where("[scopeId+lifecycleState+createdAtMs+rangeOperationId]")
          .between(lower, upper, after === undefined, true)
          .limit(limit + 1)
          .toArray();
      }),
    )
  )
    .flat()
    .sort(
      (left, right) =>
        left.createdAtMs - right.createdAtMs ||
        left.rangeOperationId.localeCompare(right.rangeOperationId),
    )
    .slice(0, limit + 1);
  const page = rows.slice(0, limit).map(decodeCtfRangeOrderPreparationRecord);
  const last = page.at(-1);
  return {
    preparations: page,
    nextCursor:
      rows.length > limit && last
        ? { createdAtMs: last.createdAtMs, rangeOperationId: last.rangeOperationId }
        : null,
  };
}

async function requirePreparation(
  scopeId: string,
  rangeOperationId: string,
  database: BitcasterDB,
): Promise<CtfRangeOrderPreparationRecord> {
  const record = await readCtfRangePreparation(scopeId, rangeOperationId, database);
  if (!record) throw new Error("browser CTF range preparation is missing");
  return record;
}

async function runInCurrentWriteTransaction<T>(
  transaction: Transaction,
  database: BitcasterDB,
  tables: readonly Table[],
  persist: () => Promise<T>,
): Promise<T> {
  assertCurrentTransactionIdentity(transaction, database);
  try {
    assertActiveWriteTransaction(transaction, tables);
    return await persist();
  } catch (error) {
    if (transaction.active) transaction.abort();
    throw error;
  }
}

function assertCurrentTransactionIdentity(transaction: Transaction, database: BitcasterDB): void {
  if (Dexie.currentTransaction !== transaction) {
    throw new Error("browser CTF range transaction is not current");
  }
  if (transaction.db !== database) {
    throw new Error("browser CTF range transaction belongs to another database");
  }
}

function assertActiveWriteTransaction(transaction: Transaction, tables: readonly Table[]): void {
  if (!transaction.active || transaction.mode !== "readwrite") {
    throw new Error("browser CTF range transaction is not active readwrite authority");
  }
  if (tables.some((table) => !transaction.storeNames.includes(table.name))) {
    throw new Error("browser CTF range transaction does not cover required tables");
  }
}

function requireSameIdentity(
  existing: CtfRangeOrderPreparationRecord,
  identity: CtfRangeOrderPreparationIdentity,
): CtfRangeOrderPreparationRecord {
  const record = decodeCtfRangeOrderPreparationRecord(existing);
  if (!sameCtfRangeOrderPreparationIdentity(record, identity)) {
    throw new Error("browser CTF range preparation conflicts with its persisted authority");
  }
  return record;
}
