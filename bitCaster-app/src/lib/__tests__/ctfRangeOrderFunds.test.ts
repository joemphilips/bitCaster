// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import {
  encodeCtfRangeOrderPreparationArtifact,
  type CtfRangeOrderPreparationLifecycle,
  type CtfRangeOrderPreparationRecord,
} from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import { BitcasterDB, activateBrowserWalletDatabase, db } from "@/stores/proof-db";
import {
  orderFailureFundsReader,
  observeOrderFailureFunds,
  orderFailureNoticeKey,
  recordOrderFailureNotice,
  useOrderFailureNotices,
} from "@/stores/orderFailureNotices";
import { browserCustodyOperationId } from "../browserCtfRangeOrderSource";
import {
  browserRangeCustodyOperationId,
  ctfRangeOrderLock,
  readCtfRangeOrderFunds,
  readCtfRangeOrderLocks,
  refusedOrderAlertFunds,
} from "../ctfRangeOrderFunds";
import {
  RANGE_FIXTURE_CONDITION_ID,
  RANGE_FIXTURE_OUTCOME,
  ctfRangePreparationRecordFixture,
} from "@/test/ctfRangePreparationRecordFixture";

const databases: BitcasterDB[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

const scopeId = deriveDurableCustodyScopeId({
  scopeKind: "wallet",
  walletId: deriveDurableCustodyWalletId(new Uint8Array(32).fill(7)),
});

describe("CTF range order funds", () => {
  it("uses the custody operation identity of the order source", () => {
    expect(browserRangeCustodyOperationId(scopeId, "range-1")).toBe(
      browserCustodyOperationId(
        { scopeId } as Parameters<typeof browserCustodyOperationId>[0],
        "range-1",
      ),
    );
  });

  it("is active while the journal operation is active", async () => {
    const database = createDatabase();
    await database.ctfRangePreparations.put(journal("order-submitted"));
    expect(await readCtfRangeOrderFunds(scopeId, "range-1", database)).toEqual({
      kind: "active",
      lifecycleState: "order-submitted",
    });
  });

  it("is refunded only when the refund aborted the custody operation and ended the journal", async () => {
    const database = createDatabase();
    await database.ctfRangePreparations.put(journal("terminal"));
    await database.custodyOperations.put(custody("aborted"));
    expect(await readCtfRangeOrderFunds(scopeId, "range-1", database)).toEqual({
      kind: "refunded",
    });
  });

  it("is settled when the settlement reconciled the custody operation", async () => {
    const database = createDatabase();
    await database.ctfRangePreparations.put(journal("terminal"));
    await database.custodyOperations.put(custody("reconciled"));
    expect(await readCtfRangeOrderFunds(scopeId, "range-1", database)).toEqual({
      kind: "settled",
    });
  });

  it("is ended, with no refund claim, without a custody operation", async () => {
    const database = createDatabase();
    await database.ctfRangePreparations.put(journal("terminal"));
    expect(await readCtfRangeOrderFunds(scopeId, "range-1", database)).toEqual({ kind: "ended" });
  });

  it("is ended without a journal record", async () => {
    expect(await readCtfRangeOrderFunds(scopeId, "range-1", createDatabase())).toEqual({
      kind: "ended",
    });
  });

  it.each([
    [
      "order-submission-rejected",
      { kind: "active", lifecycleState: "order-request-rejected" },
      "pending",
    ],
    ["order-market-closed", { kind: "active", lifecycleState: "submission-rejected" }, "pending"],
    ["order-submission-rejected", { kind: "refunded" }, "refunded"],
    // A refusal whose journal still waits for the order answer has no refund yet.
    ["order-submission-rejected", { kind: "active", lifecycleState: "order-requested" }, null],
    ["order-submission-rejected", { kind: "ended" }, null],
    ["order-submission-rejected", { kind: "settled" }, null],
    // An uncertain result is not a refusal; no refund follows from it.
    ["order-submission-uncertain", { kind: "refunded" }, null],
  ] as const)("gives the funds of a %s alert in state %o: %s", (code, funds, expected) => {
    expect(refusedOrderAlertFunds(code, funds)).toBe(expected);
  });
});

describe("funds that an order attempt holds until its authorization expires", () => {
  it("names the planned Buy inputs in msat, the lock end, and the order to start again", () => {
    // Two shares at 512 msat cost 1,024 msat. The inputs 1,024 + 1 msat pay
    // the 1 msat input fee of two inputs.
    const record = ctfRangePreparationRecordFixture({
      scopeId,
      operationId: "range-buy",
      side: "Buy",
      tokenSide: "Complement",
      price: 512,
      amountSubunits: 2_000,
    });
    expect(ctfRangeOrderLock(record)).toEqual({
      side: "Buy",
      lockedSubunits: 1_025,
      divisibility: 1_000,
      unlockAtMs: record.authorizationExpiresAtUnixSeconds * 1_000,
      retry: {
        conditionId: RANGE_FIXTURE_CONDITION_ID,
        orderRouteId: `${RANGE_FIXTURE_CONDITION_ID}-${RANGE_FIXTURE_OUTCOME}`,
        tokenSide: "Complement",
        side: "Buy",
        amountSubunits: 2_000,
      },
    });
  });

  it("names the offered shares of a Sell in face subunits", () => {
    const record = ctfRangePreparationRecordFixture({
      scopeId,
      operationId: "range-sell",
      side: "Sell",
      price: 512,
      amountSubunits: 3_000,
    });
    expect(ctfRangeOrderLock(record)).toMatchObject({ side: "Sell", lockedSubunits: 3_000 });
  });

  it("gives no lock for a preparation that does not decode", () => {
    expect(ctfRangeOrderLock(journal("order-submitted"))).toBeNull();
  });

  it("reads the locks of active journal records only", async () => {
    const database = createDatabase();
    const active = ctfRangePreparationRecordFixture({
      scopeId,
      operationId: "range-active",
      side: "Buy",
      price: 512,
      amountSubunits: 2_000,
    });
    const ended = ctfRangePreparationRecordFixture({
      scopeId,
      operationId: "range-ended",
      side: "Buy",
      price: 512,
      amountSubunits: 2_000,
      lifecycleState: "terminal",
    });
    await database.ctfRangePreparations.bulkPut([active, ended]);
    const locks = await readCtfRangeOrderLocks(
      scopeId,
      ["range-active", "range-ended", "range-missing"],
      database,
    );
    expect(Object.keys(locks)).toEqual(["range-active"]);
    expect(locks["range-active"]?.lockedSubunits).toBe(1_025);
  });
});

describe("order failure funds of the current wallet", () => {
  const otherScopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: deriveDurableCustodyWalletId(new Uint8Array(32).fill(8)),
  });
  const notice = {
    scopeId,
    operationId: "range-1",
    orderId: "11111111-1111-4111-8111-111111111111",
    marketId: "condition-a-Alpha",
    marketTitle: null,
    reason: "Unspecified" as const,
  };
  const stored = () =>
    useOrderFailureNotices.getState().notices[orderFailureNoticeKey(scopeId, "range-1")];

  afterEach(async () => {
    useOrderFailureNotices.setState({ notices: {} });
    for (const id of [scopeId, otherScopeId]) {
      activateBrowserWalletDatabase(id);
      await db.delete();
    }
  });

  it("does not settle a notice from the database of another wallet", async () => {
    // The journal operation of this wallet is still active.
    activateBrowserWalletDatabase(scopeId);
    await db.ctfRangePreparations.put(journal("order-submitted"));
    // The user switched to another wallet before the check.
    activateBrowserWalletDatabase(otherScopeId);

    await recordOrderFailureNotice(notice);

    expect(stored()?.funds).toBe("pending");
  });

  it("keeps a notice pending when the wallet changes during the check", async () => {
    activateBrowserWalletDatabase(scopeId);
    await db.ctfRangePreparations.put(journal("order-submitted"));
    useOrderFailureNotices.getState().record(notice);
    const read = orderFailureFundsReader(scopeId);
    expect(read).not.toBeNull();
    activateBrowserWalletDatabase(otherScopeId);

    await observeOrderFailureFunds(scopeId, read!);

    expect(stored()?.funds).toBe("pending");
    expect(orderFailureFundsReader(scopeId)).toBeNull();
  });

  it("marks the notice of an order whose settlement completed as settled", async () => {
    activateBrowserWalletDatabase(scopeId);
    await db.ctfRangePreparations.put(journal("terminal"));
    await db.custodyOperations.put(custody("reconciled"));

    await recordOrderFailureNotice(notice);

    expect(stored()?.funds).toBe("settled");
  });
});

function createDatabase(): BitcasterDB {
  const database = new BitcasterDB(`range-funds-${crypto.randomUUID()}`);
  databases.push(database);
  return database;
}

function journal(
  lifecycleState: CtfRangeOrderPreparationLifecycle,
): CtfRangeOrderPreparationRecord {
  return {
    scopeId,
    rangeOperationId: "range-1",
    sourceOperationId: "source-1",
    authorizationId: "auth-1",
    clientOrderId: "client-1",
    orderRouteId: "condition-a-Alpha",
    normalizedMint: "https://mint.example",
    conditionId: "condition-a",
    unit: "msat",
    tokenSide: "Outcome",
    side: "Buy",
    priceSubunits: 500,
    amountSubunits: 1_000,
    minimumFillAmountSubunits: 1_000,
    divisibility: 1_000,
    authorizationExpiresAtUnixSeconds: 1_000,
    preparationBytes: encodeCtfRangeOrderPreparationArtifact({ version: 1 }),
    feeConsentBytes: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    lifecycleState,
    revision: 3,
    capability: {
      artifactId: "11111111-1111-4111-8111-111111111111",
      orderId: "11111111-1111-4111-8111-111111111111",
      bindingDigest: "22".repeat(32),
      artifactDigest: "33".repeat(32),
    },
  };
}

function custody(operationState: "aborted" | "reconciled") {
  return {
    scopeId,
    operationId: browserRangeCustodyOperationId(scopeId, "range-1"),
    revision: 1,
    operationState,
    nextAttemptAtMs: null,
    estimatedBytes: 0,
    record: {} as never,
  };
}
