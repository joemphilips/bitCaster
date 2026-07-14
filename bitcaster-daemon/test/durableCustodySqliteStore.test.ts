import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  decodeDurableCustodyRecord,
  deriveDurableCustodyOperationId,
  deriveDurableCustodyScopeId,
  readDurableCustodyRecoveryPage,
  type DurableCustodyRecord,
  type DurableCustodyScope,
} from "@bitcaster-market/client-sdk/durableCustody";
import { openProfileDatabase, profileDatabasePath } from "../src/profile.ts";
import { SqliteDurableCustodyStore } from "../src/durableCustodySqliteStore.ts";

const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);
const FINGERPRINT_C = "c".repeat(64);

async function withDaemonHome(run: () => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "bitcaster-daemon-custody-store-"));
  const previousHome = process.env.BITCASTER_DAEMON_HOME;
  process.env.BITCASTER_DAEMON_HOME = home;
  try {
    await run();
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME;
    else process.env.BITCASTER_DAEMON_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
}

function profileScope(profileId = "profile-001"): DurableCustodyScope {
  return {
    scopeKind: "profile",
    profileId,
    scopeId: deriveDurableCustodyScopeId({ scopeKind: "profile", profileId }),
  };
}

function marketScope(input: {
  marketId: string;
  inventoryAccountId: string;
}): DurableCustodyScope {
  const value = {
    scopeKind: "market" as const,
    marketId: input.marketId,
    inventoryAccountId: input.inventoryAccountId,
    normalizedMint: "https://mint.example",
    unit: "sat",
  };
  return { ...value, scopeId: deriveDurableCustodyScopeId(value) };
}

function record(
  scope: DurableCustodyScope,
  input: {
    tradeId?: string;
    retainedOperationKey?: string;
    sessionId?: string;
    proofId?: string;
  } = {},
): DurableCustodyRecord {
  const tradeId = input.tradeId ?? "trade-001";
  const retainedOperationKey = input.retainedOperationKey ?? "seller-lock-001";
  const sessionId = input.sessionId ?? `session-${tradeId}`;
  const proofId = input.proofId ?? FINGERPRINT_A;
  const operationId = deriveDurableCustodyOperationId(scope.scopeId, {
    retainedOperationKey,
    trade: { tradeId, role: "seller", stage: "lock" },
  });
  const context =
    scope.scopeKind === "profile"
      ? {
          normalizedMint: "https://mint.example",
          unit: "sat",
          inventoryAccountId: null,
        }
      : {
          normalizedMint: scope.normalizedMint,
          unit: scope.unit,
          inventoryAccountId: scope.inventoryAccountId,
        };
  return decodeDurableCustodyRecord({
    schemaVersion: 1,
    revision: 0,
    scope,
    operation: {
      operationId,
      retainedOperationKey,
      trade: { tradeId, role: "seller", stage: "lock" },
      semanticKind: "swap-lock",
      state: "dispatch-intent",
      terminalReplayEvidenceRequired: true,
      custodyContext: context,
      reservation: {
        reservationId: `reservation-${tradeId}`,
        inputs: [{ proofId, keysetId: "keyset-001", curve: "secp256k1" }],
      },
      exactRequest: {
        requestId: `request-${tradeId}`,
        requestFingerprint: FINGERPRINT_A,
        payloadHandle: `request-payload-${tradeId}`,
        inputProofIds: [proofId],
        outputPlanFingerprint: FINGERPRINT_B,
      },
      outputPlan: {
        outputPlanId: `output-plan-${tradeId}`,
        outputPlanFingerprint: FINGERPRINT_B,
        outputMaterialHandle: `output-material-${tradeId}`,
      },
      privateMaterial: {
        materialHandle: `private-material-${tradeId}`,
        useId: `${tradeId}/seller/lock`,
        publicFingerprint: FINGERPRINT_A,
      },
      result: {
        state: "none",
        resultHandle: null,
        resultFingerprint: null,
        outputPlanFingerprint: null,
      },
      verification: {
        outputPlanFingerprint: FINGERPRINT_B,
        keysetBindings: [
          {
            keysetId: "keyset-001",
            curve: "secp256k1",
            keysetFingerprint: FINGERPRINT_B,
            requireDleq: true,
          },
        ],
      },
      sessionLink: {
        linkKind: "trade",
        sessionId,
        tradeId,
        immutableTradeFingerprint: FINGERPRINT_A,
        hasDependentOperation: false,
      },
      delivery: {
        deliveryKind: "none",
        deliveryId: null,
        payloadHandle: null,
        payloadFingerprint: null,
        expiresAtMs: null,
        state: "none",
      },
      retry: { attempt: 0, nextAttemptAtMs: null, reason: "none" },
      horizon: {
        notBeforeMs: null,
        notAfterMs: 10_000,
        safetyMarginMs: 0,
        keysetExpiryMs: null,
      },
    },
    terminalTombstone: null,
  });
}

async function claimedStore(scope = profileScope()) {
  const store = new SqliteDurableCustodyStore();
  await store.registerScope(scope);
  const state = await store.claimScope({
    scope,
    ownerId: "worker-001",
    observedAtMs: 1,
    leaseExpiresAtMs: 10_000,
  });
  return {
    store,
    scope,
    owner: {
      ownerId: "worker-001",
      ownerEpoch: state.owner?.epoch ?? -1,
      observedAtMs: 2,
    },
  };
}

test("SQLite custody store registers scopes with canonical market isolation constraints", async () => {
  await withDaemonHome(async () => {
    const store = new SqliteDurableCustodyStore();
    const first = await store.registerScope(profileScope());
    assert.equal(first.owner, null);
    assert.equal(
      (await store.registerScope(profileScope())).scope.scopeId,
      first.scope.scopeId,
    );
    await assert.rejects(
      () =>
        store.registerScope({
          scopeKind: "profile",
          profileId: "profile-forged",
          scopeId: first.scope.scopeId,
        }),
      /scope id is invalid/,
    );

    const database = openProfileDatabase();
    try {
      assert.equal(
        database.prepare("PRAGMA foreign_keys").get()?.foreign_keys,
        1,
      );
      const tables = database
        .prepare(
          `SELECT name, sql FROM sqlite_master
         WHERE type = 'table' AND name GLOB 'custody_*' ORDER BY name`,
        )
        .all() as Array<{ name: string; sql: string }>;
      assert.deepEqual(
        tables.map((table) => table.name),
        [
          "custody_active_work",
          "custody_operation_inputs",
          "custody_operations",
          "custody_proof_reservations",
          "custody_schema_metadata",
          "custody_scope_state",
          "custody_scopes",
          "custody_session_links",
          "custody_verification_bindings",
        ],
      );
      assert.equal(
        tables.every((table) => table.sql.includes("STRICT")),
        true,
      );
      assert.throws(
        () =>
          database
            .prepare(
              "INSERT INTO custody_active_work (scope_id, operation_id) VALUES (?, ?)",
            )
            .run(first.scope.scopeId, "foreign-operation"),
        /FOREIGN KEY constraint failed/,
      );
      assert.throws(
        () =>
          database
            .prepare(
              `INSERT INTO custody_operation_inputs (
                scope_id, operation_id, proof_id, input_position, keyset_id, curve
              ) VALUES (?, ?, ?, 0, 'keyset-001', 'secp256k1')`,
            )
            .run(first.scope.scopeId, "foreign-operation", FINGERPRINT_A),
        /FOREIGN KEY constraint failed/,
      );
      assert.throws(
        () =>
          database
            .prepare(
              `INSERT INTO custody_verification_bindings (
                scope_id, operation_id, keyset_id, curve, keyset_fingerprint, require_dleq
              ) VALUES (?, ?, 'keyset-001', 'secp256k1', ?, 1)`,
            )
            .run(first.scope.scopeId, "foreign-operation", FINGERPRINT_B),
        /FOREIGN KEY constraint failed/,
      );
      assert.throws(
        () =>
          database
            .prepare(
              "UPDATE custody_schema_metadata SET schema_version = ? WHERE singleton = 1",
            )
            .run("one"),
        /cannot store TEXT value in INTEGER column|datatype mismatch/,
      );
    } finally {
      database.close();
    }

    const market = marketScope({
      marketId: "cond-YES",
      inventoryAccountId: "inventory-A",
    });
    await store.registerScope(market);
    await assert.rejects(
      () =>
        store.registerScope(
          marketScope({
            marketId: "cond-YES",
            inventoryAccountId: "inventory-B",
          }),
        ),
      /market custody scope registration conflicts/,
    );
    await assert.rejects(
      () =>
        store.registerScope(
          marketScope({
            marketId: "other-NO",
            inventoryAccountId: "inventory-A",
          }),
        ),
      /market custody scope registration conflicts/,
    );
  });
});

test("SQLite custody schema stores canonical records in typed rows, never JSON serialized columns", async () => {
  await withDaemonHome(async () => {
    const store = new SqliteDurableCustodyStore();
    await store.registerScope(profileScope());
    const database = openProfileDatabase();
    try {
      const tableNames = [
        "custody_scopes",
        "custody_scope_state",
        "custody_operations",
        "custody_operation_inputs",
        "custody_session_links",
        "custody_proof_reservations",
        "custody_verification_bindings",
      ];
      for (const tableName of tableNames) {
        const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
          name: string;
          type: string;
        }>;
        assert.equal(columns.some((column) => /json/i.test(column.name)), false);
        assert.equal(columns.some((column) => /json/i.test(column.type)), false);
        assert.equal(
          columns.some((column) =>
            ["scope_payload", "state_payload", "record_payload", "link_payload"].includes(
              column.name,
            ),
          ),
          false,
        );
      }
    } finally {
      database.close();
    }
  });
});

test("SQLite custody transaction commits canonical operation, session, reservation, and active index together", async () => {
  await withDaemonHome(async () => {
    const { store, scope, owner } = await claimedStore();
    const operation = record(scope);

    await store.transact({ scope, owner }, (transaction) => {
      transaction.putOperation(operation);
      transaction.putSessionLink(operation.operation.sessionLink);
      transaction.reserveExactInputs({
        operationId: operation.operation.operationId,
        reservationId: operation.operation.reservation.reservationId,
        proofIds: operation.operation.reservation.inputs.map(
          (input) => input.proofId,
        ),
      });
      transaction.rebuildActiveWorkIndex();
    });

    assert.equal(
      (await store.listRecoverable(scope))[0]?.operation.operationId,
      operation.operation.operationId,
    );
    await assert.rejects(
      () =>
        store.transact({ scope, owner }, (transaction) => {
          transaction.putOperation(
            record(scope, {
              tradeId: "trade-002",
              retainedOperationKey: "seller-lock-002",
              sessionId: "session-trade-002",
              proofId: FINGERPRINT_A,
            }),
          );
          transaction.reserveExactInputs({
            operationId: deriveDurableCustodyOperationId(scope.scopeId, {
              retainedOperationKey: "seller-lock-002",
              trade: { tradeId: "trade-002", role: "seller", stage: "lock" },
            }),
            reservationId: "reservation-trade-002",
            proofIds: [FINGERPRINT_A],
          });
        }),
      /proof reservation is already owned/,
    );
    const forgedExactRequest = structuredClone(operation);
    forgedExactRequest.operation.exactRequest.payloadHandle =
      "different-persisted-request";
    await assert.rejects(
      () =>
        store.transact({ scope, owner }, (transaction) => {
          transaction.putOperation(forgedExactRequest);
        }),
      /existing custody operations must advance through an SDK reducer transition/,
    );
    const handoffOwner = { ...owner, observedAtMs: 3 };
    let effectiveClock = -1;
    await store.transact({ scope, owner: handoffOwner }, (transaction) => {
      transaction.transitionOperation({
        operationId: operation.operation.operationId,
        transition: { kind: "transport-attempted" },
      });
      effectiveClock = transaction.getScopeState().effectiveClock.highWaterMarkMs;
      transaction.rebuildActiveWorkIndex();
    });
    assert.equal(effectiveClock, 3);
    assert.equal(
      (await store.listRecoverable(scope))[0]?.operation.state,
      "transport-attempted",
    );
    await assert.rejects(
      () =>
        store.transact({ scope, owner: handoffOwner }, (transaction) => {
          transaction.transitionOperation({
            operationId: operation.operation.operationId,
            transition: {
              kind: "abort-no-transport",
              classification: "all-inputs-unspent",
            },
          });
        }),
      /abort is only legal before transport handoff/,
    );

    const database = openProfileDatabase();
    try {
      database
        .prepare("DELETE FROM custody_active_work WHERE scope_id = ?")
        .run(scope.scopeId);
    } finally {
      database.close();
    }
    await assert.rejects(
      () => store.listRecoverable(scope),
      /active-work index is missing or stale/,
    );
    assert.equal(await store.rebuildActiveWorkIndex(scope), "rebuilt");
    assert.equal((await store.listRecoverable(scope)).length, 1);
  });
});

test("SQLite custody recovery pages use an exclusive bounded operation cursor", async () => {
  await withDaemonHome(async () => {
    const { store, scope, owner } = await claimedStore();
    const operations = [
      record(scope, {
        tradeId: "trade-page-a",
        retainedOperationKey: "seller-lock-page-a",
        sessionId: "session-page-a",
        proofId: FINGERPRINT_A,
      }),
      record(scope, {
        tradeId: "trade-page-b",
        retainedOperationKey: "seller-lock-page-b",
        sessionId: "session-page-b",
        proofId: FINGERPRINT_B,
      }),
      record(scope, {
        tradeId: "trade-page-c",
        retainedOperationKey: "seller-lock-page-c",
        sessionId: "session-page-c",
        proofId: FINGERPRINT_C,
      }),
    ];
    await store.transact({ scope, owner }, (transaction) => {
      for (const operation of operations) {
        transaction.putOperation(operation);
        transaction.putSessionLink(operation.operation.sessionLink);
        transaction.reserveExactInputs({
          operationId: operation.operation.operationId,
          reservationId: operation.operation.reservation.reservationId,
          proofIds: operation.operation.reservation.inputs.map(
            (input) => input.proofId,
          ),
        });
      }
      transaction.rebuildActiveWorkIndex();
    });

    const first = await readDurableCustodyRecoveryPage(store, {
      scope,
      cursor: null,
      limit: 2,
    });
    assert.equal(first.records.length, 2);
    assert.notEqual(first.nextCursor, null);
    assert.deepEqual(
      first.records.map((item) => item.operation.operationId),
      [...first.records]
        .map((item) => item.operation.operationId)
        .sort(),
    );
    const second = await readDurableCustodyRecoveryPage(store, {
      scope,
      cursor: first.nextCursor,
      limit: 2,
    });
    assert.equal(second.records.length, 1);
    assert.equal(second.nextCursor, null);
    assert.deepEqual(
      [...first.records, ...second.records]
        .map((item) => item.operation.operationId)
        .sort(),
      operations.map((item) => item.operation.operationId).sort(),
    );
    await assert.rejects(
      () => store.listRecoverablePage({ scope, cursor: null, limit: 257 }),
      /page limit is invalid/,
    );
  });
});

test("SQLite custody store rolls back foreign awaits and fails closed on corrupt canonical rows", async () => {
  await withDaemonHome(async () => {
    const { store, scope, owner } = await claimedStore();
    await assert.rejects(
      () => store.transact({ scope, owner }, async () => undefined),
      /transaction callback must not await/,
    );
    await assert.rejects(
      () =>
        store.transact({ scope, owner }, (transaction) => {
          transaction.putScopeState({
            ...transaction.getScopeState(),
            owner: {
              ownerId: "foreign-worker",
              epoch: 99,
              leaseExpiresAtMs: 20_000,
            },
          });
        }),
      /owner changes require claimScope/,
    );
    assert.deepEqual(await store.listRecoverable(scope), []);

    const operation = record(scope);
    await store.transact({ scope, owner }, (transaction) => {
      transaction.putOperation(operation);
      transaction.putSessionLink(operation.operation.sessionLink);
      transaction.reserveExactInputs({
        operationId: operation.operation.operationId,
        reservationId: operation.operation.reservation.reservationId,
        proofIds: operation.operation.reservation.inputs.map(
          (input) => input.proofId,
        ),
      });
      transaction.rebuildActiveWorkIndex();
    });

    const database = new DatabaseSync(profileDatabasePath());
    try {
      database
        .prepare(
          `UPDATE custody_operations SET result_handle = 'corrupt-result'
         WHERE scope_id = ? AND operation_id = ?`,
        )
        .run(scope.scopeId, operation.operation.operationId);
    } finally {
      database.close();
    }
    await assert.rejects(
      () => store.listRecoverable(scope),
      /result/i,
    );
  });
});

test("SQLite custody store fails closed when a reservation row no longer matches its exact input", async () => {
  await withDaemonHome(async () => {
    const { store, scope, owner } = await claimedStore();
    const operation = record(scope);
    await store.transact({ scope, owner }, (transaction) => {
      transaction.putOperation(operation);
      transaction.putSessionLink(operation.operation.sessionLink);
      transaction.reserveExactInputs({
        operationId: operation.operation.operationId,
        reservationId: operation.operation.reservation.reservationId,
        proofIds: operation.operation.reservation.inputs.map(
          (input) => input.proofId,
        ),
      });
      transaction.rebuildActiveWorkIndex();
    });

    const database = new DatabaseSync(profileDatabasePath());
    try {
      database
        .prepare(
          `UPDATE custody_proof_reservations SET keyset_id = 'foreign-keyset'
         WHERE proof_id = ?`,
        )
        .run(operation.operation.reservation.inputs[0]?.proofId);
    } finally {
      database.close();
    }
    await assert.rejects(
      () => store.listRecoverable(scope),
      /reservation is missing or foreign/,
    );
  });
});

test("SQLite custody store never repairs a partial schema and retains pending delivery work", async () => {
  await withDaemonHome(async () => {
    const { store, scope, owner } = await claimedStore();
    const operation = record(scope);
    await store.transact({ scope, owner }, (transaction) => {
      transaction.putOperation(operation);
      transaction.putSessionLink(operation.operation.sessionLink);
      transaction.reserveExactInputs({
        operationId: operation.operation.operationId,
        reservationId: operation.operation.reservation.reservationId,
        proofIds: operation.operation.reservation.inputs.map(
          (input) => input.proofId,
        ),
      });
      transaction.putDelivery({
        operationId: operation.operation.operationId,
        deliveryKind: "cipher",
        payloadHandle: "cipher-payload-001",
        payloadFingerprint: FINGERPRINT_A,
        expiresAtMs: 5_000,
        state: "pending",
      });
      transaction.stageVerifiedResult({
        operationId: operation.operation.operationId,
        outputPlanFingerprint:
          operation.operation.outputPlan.outputPlanFingerprint,
        resultHandle: "result-001",
        resultFingerprint: FINGERPRINT_A,
      });
      transaction.applyVerifiedResult({
        operationId: operation.operation.operationId,
        outputPlanFingerprint:
          operation.operation.outputPlan.outputPlanFingerprint,
        resultHandle: "result-001",
        resultFingerprint: FINGERPRINT_A,
      });
      transaction.rebuildActiveWorkIndex();
    });
    assert.equal((await store.listRecoverable(scope)).length, 1);
    await assert.rejects(
      () =>
        store.transact({ scope, owner }, (transaction) => {
          transaction.putDelivery({
            operationId: operation.operation.operationId,
            deliveryKind: "cipher",
            payloadHandle: "cipher-payload-001",
            payloadFingerprint: FINGERPRINT_A,
            expiresAtMs: 5_000,
            state: "expired",
          });
        }),
      /delivery expiry is premature/,
    );

    const database = openProfileDatabase();
    try {
      database.exec("DROP TABLE custody_active_work");
    } finally {
      database.close();
    }
    await assert.rejects(
      () => store.listRecoverable(scope),
      /schema is incomplete; refusing repair/,
    );
  });
});
