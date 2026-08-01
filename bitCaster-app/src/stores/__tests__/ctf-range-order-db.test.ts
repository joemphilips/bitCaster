// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import {
  encodeCtfRangeOrderPreparationArtifact,
  type CtfRangeOrderPreparationIdentity,
} from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import {
  appendCtfRangePreparationConsolidation,
  bindCtfRangePreparationCapability,
  insertCtfRangePreparation,
  pageActiveCtfRangePreparations,
  readActiveCtfRangePreparationByClientOrderId,
  readCtfRangePreparationConsolidations,
  readCtfRangePreparation,
  transitionCtfRangePreparation,
} from "../ctf-range-order-db";
import { BitcasterDB } from "../proof-db";

const openDatabases: BitcasterDB[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("browser CTF range order journal", () => {
  it("persists an exact identity idempotently and rejects substitution", async () => {
    const database = createDatabase();
    const input = identity("range-a", "client-a", 10);

    const inserted = await insertCtfRangePreparation(input, database);
    expect(inserted.lifecycleState).toBe("prepared");
    expect(inserted.revision).toBe(0);
    expect(await insertCtfRangePreparation(input, database)).toEqual(inserted);

    await expect(
      insertCtfRangePreparation({ ...input, amountSubunits: 20_000 }, database),
    ).rejects.toThrow(/conflicts with its persisted authority/);
    expect(await readCtfRangePreparation(input.scopeId, input.rangeOperationId, database)).toEqual(
      inserted,
    );
  });

  it("binds capability and advances lifecycle with revision CAS", async () => {
    const database = createDatabase();
    const input = identity("range-bind", "client-bind", 20);
    await insertCtfRangePreparation(input, database);
    await transitionCtfRangePreparation(
      {
        scopeId: input.scopeId,
        rangeOperationId: input.rangeOperationId,
        expectedRevision: 0,
        from: "prepared",
        to: "capability-requested",
        updatedAtMs: 21,
      },
      database,
    );

    const bound = await bindCtfRangePreparationCapability(
      {
        scopeId: input.scopeId,
        rangeOperationId: input.rangeOperationId,
        expectedRevision: 1,
        capability: {
          artifactId: "11111111-1111-4111-8111-111111111111",
          bindingDigest: "22".repeat(32),
          artifactDigest: "33".repeat(32),
          orderId: "44444444-4444-4444-8444-444444444444",
        },
        updatedAtMs: 22,
      },
      database,
    );
    expect(bound.lifecycleState).toBe("capability-bound");
    expect(bound.revision).toBe(2);

    await expect(
      transitionCtfRangePreparation(
        {
          scopeId: input.scopeId,
          rangeOperationId: input.rangeOperationId,
          expectedRevision: 1,
          from: "capability-bound",
          to: "order-submitted",
          updatedAtMs: 23,
        },
        database,
      ),
    ).rejects.toThrow(/revision or lifecycle changed/);

    const submitted = await transitionCtfRangePreparation(
      {
        scopeId: input.scopeId,
        rangeOperationId: input.rangeOperationId,
        expectedRevision: 2,
        from: "capability-bound",
        to: "order-submitted",
        updatedAtMs: 23,
      },
      database,
    );
    expect(submitted.lifecycleState).toBe("order-submitted");
    expect(submitted.revision).toBe(3);
  });

  it("pages active records by scope and excludes terminal records", async () => {
    const database = createDatabase();
    const records = [
      identity("range-a", "client-a", 10),
      identity("range-b", "client-b", 11),
      identity("range-c", "client-c", 12),
    ];
    for (const record of records) await insertCtfRangePreparation(record, database);
    await transitionCtfRangePreparation(
      {
        scopeId: records[1]!.scopeId,
        rangeOperationId: records[1]!.rangeOperationId,
        expectedRevision: 0,
        from: "prepared",
        to: "terminal",
        updatedAtMs: 13,
      },
      database,
    );

    const first = await pageActiveCtfRangePreparations(
      { scopeId: records[0]!.scopeId, limit: 1 },
      database,
    );
    expect(first.preparations.map((record) => record.rangeOperationId)).toEqual(["range-a"]);
    expect(first.nextCursor).toEqual({ createdAtMs: 10, rangeOperationId: "range-a" });
    await transitionCtfRangePreparation(
      {
        scopeId: records[0]!.scopeId,
        rangeOperationId: records[0]!.rangeOperationId,
        expectedRevision: 0,
        from: "prepared",
        to: "capability-requested",
        updatedAtMs: 100,
      },
      database,
    );

    const second = await pageActiveCtfRangePreparations(
      { scopeId: records[0]!.scopeId, limit: 1, after: first.nextCursor! },
      database,
    );
    expect(second.preparations.map((record) => record.rangeOperationId)).toEqual(["range-c"]);
    expect(second.nextCursor).toBeNull();
    expect(
      await readActiveCtfRangePreparationByClientOrderId(records[0]!.scopeId, "client-b", database),
    ).toBeNull();
  });

  it("links ordered consolidation rounds idempotently and rejects substitution", async () => {
    const database = createDatabase();
    const input = identity("range-consolidated", "client-consolidated", 30);
    await insertCtfRangePreparation(input, database);
    const link = {
      scopeId: input.scopeId,
      rangeOperationId: input.rangeOperationId,
      round: 0,
      operationId: `${input.sourceOperationId}:consolidation:0`,
      reservationId: `ctf-range-consolidation:${input.sourceOperationId}:consolidation:0`,
    };

    await expect(appendCtfRangePreparationConsolidation(link, database)).resolves.toEqual(link);
    await expect(appendCtfRangePreparationConsolidation(link, database)).resolves.toEqual(link);
    await expect(
      appendCtfRangePreparationConsolidation(
        { ...link, operationId: `${input.sourceOperationId}:substituted` },
        database,
      ),
    ).rejects.toThrow(/conflicts with its persisted link/);
    await expect(
      readCtfRangePreparationConsolidations(input.scopeId, input.rangeOperationId, database),
    ).resolves.toEqual([link]);
  });
});

function createDatabase(): BitcasterDB {
  const database = new BitcasterDB(`bitcaster-test-${crypto.randomUUID()}`);
  openDatabases.push(database);
  return database;
}

function identity(
  rangeOperationId: string,
  clientOrderId: string,
  createdAtMs: number,
): CtfRangeOrderPreparationIdentity {
  const walletId = deriveDurableCustodyWalletId(new Uint8Array(32).fill(7));
  return {
    scopeId: deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId }),
    rangeOperationId,
    sourceOperationId: `${rangeOperationId}:source`,
    sourceKind: "wallet-prepared",
    predecessorRangeOperationId: null,
    authorizationId: `${rangeOperationId}:authorization`,
    clientOrderId,
    orderRouteId: "condition-a-YES",
    normalizedMint: "https://mint.example",
    conditionId: "condition-a",
    unit: "msat",
    tokenSide: "Outcome",
    side: "Buy",
    priceSubunits: 5_000,
    amountSubunits: 10_000,
    minimumFillAmountSubunits: 10_000,
    continueAfterPartialFill: false,
    continuation: null,
    divisibility: 10_000,
    authorizationExpiresAtUnixSeconds: 1_000,
    preparationBytes: encodeCtfRangeOrderPreparationArtifact({ version: 1 }),
    createdAtMs,
  };
}
