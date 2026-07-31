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
import { db, type BitcasterDB } from "./proof-db";

export interface CtfRangePreparationPage {
  preparations: readonly CtfRangeOrderPreparationRecord[];
  nextCursor: CtfRangeOrderPreparationPageCursor | null;
}

export async function insertCtfRangePreparation(
  input: CtfRangeOrderPreparationIdentity,
  database: BitcasterDB = db,
): Promise<CtfRangeOrderPreparationRecord> {
  const identity = decodeCtfRangeOrderPreparationIdentity(input);
  return database.transaction("rw", database.ctfRangePreparations, async () => {
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
  });
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
  return database.transaction("rw", database.ctfRangePreparations, async () => {
    const current = await requirePreparation(input.scopeId, input.rangeOperationId, database);
    const next = bindCtfRangeOrderPreparationCapability({ current, ...input });
    if (next.revision !== current.revision) {
      await database.ctfRangePreparations.put(next);
    }
    return decodeCtfRangeOrderPreparationRecord(next);
  });
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
  assertCtfRangeOrderPreparationTransition(input.from, input.to);
  return database.transaction("rw", database.ctfRangePreparations, async () => {
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
  });
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
  const lower: readonly unknown[] = after
    ? [input.scopeId, after.updatedAtMs, after.rangeOperationId]
    : [input.scopeId];
  // IndexedDB orders array keys after numeric timestamp keys. This prefix
  // bound includes every record in the scope without an Infinity sentinel.
  const upper: readonly unknown[] = [input.scopeId, []];
  const rows = await database.ctfRangePreparations
    .where("[scopeId+updatedAtMs+rangeOperationId]")
    .between(lower, upper, after === undefined, true)
    .filter((record) => record.lifecycleState !== "terminal")
    .limit(limit + 1)
    .toArray();
  const page = rows.slice(0, limit).map(decodeCtfRangeOrderPreparationRecord);
  const last = page.at(-1);
  return {
    preparations: page,
    nextCursor:
      rows.length > limit && last
        ? { updatedAtMs: last.updatedAtMs, rangeOperationId: last.rangeOperationId }
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
