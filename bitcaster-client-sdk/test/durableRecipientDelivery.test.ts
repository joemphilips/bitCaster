import assert from "node:assert/strict";
import test from "node:test";

import {
  createDurableRecipientDeliveryRecord,
  decodeDurableRecipientDeliveryEvidence,
  decodeDurableRecipientDeliveryRecord,
  reduceDurableRecipientDelivery,
  type DurableRecipientDeliveryEvidence,
  type DurableRecipientDeliveryRecord,
} from "../src/durableRecipientDelivery.ts";

const token = "cashuB-test-token";

function pending(): DurableRecipientDeliveryRecord {
  return createDurableRecipientDeliveryRecord({
    deliveryId: "payment-1",
    accountSubject: "account:alice",
    recipientKind: "matching-engine",
    purpose: "participation-score",
    destinationId: "participation-score",
    mintUrl: "https://mint.example/",
    unit: "sat",
    requestedAmount: 5,
    encodedToken: token,
  });
}

function received(
  record = pending(),
): Extract<DurableRecipientDeliveryEvidence, { kind: "received" }> {
  return {
    kind: "received",
    request: record.request,
    receiptOperationId: "score-receipt/payment-1",
    receivedAtMs: 100,
  };
}

function credited(
  record = pending(),
): Extract<DurableRecipientDeliveryEvidence, { kind: "credited" }> {
  return {
    kind: "credited",
    request: record.request,
    receiptOperationId: "score-receipt/payment-1",
    receivedAtMs: 100,
    creditedAmount: 5,
    businessEventId: "score-purchase/payment-1",
    creditedAtMs: 200,
  };
}

test("durable recipient receipt advances monotonically through credit", () => {
  const initial = pending();
  const afterReceipt = reduceDurableRecipientDelivery(
    initial,
    received(initial),
  );
  assert.deepEqual(afterReceipt.state, {
    kind: "received",
    receiptOperationId: "score-receipt/payment-1",
    receivedAtMs: 100,
  });

  const afterCredit = reduceDurableRecipientDelivery(
    afterReceipt,
    credited(initial),
  );
  assert.equal(afterCredit.state.kind, "credited");
  assert.deepEqual(
    reduceDurableRecipientDelivery(afterCredit, received(initial)),
    afterCredit,
  );
  assert.deepEqual(
    reduceDurableRecipientDelivery(afterCredit, credited(initial)),
    afterCredit,
  );
});

test("a terminal status may safely close a stale pending projection", () => {
  const initial = pending();
  const next = reduceDurableRecipientDelivery(initial, credited(initial));
  assert.equal(next.state.kind, "credited");
});

test("not-found status is stale non-authority", () => {
  const initial = pending();
  assert.deepEqual(
    reduceDurableRecipientDelivery(initial, { kind: "not-found" }),
    initial,
  );
});

test("every immutable request field is checked before accepting evidence", () => {
  const initial = pending();
  for (const [field, replacement] of [
    ["deliveryId", "payment-2"],
    ["accountSubject", "account:bob"],
    ["recipientKind", "other-service"],
    ["purpose", "market-funding"],
    ["destinationId", "market-1"],
    ["mintUrl", "https://other-mint.example"],
    ["unit", "usd"],
    ["requestedAmount", 6],
    ["tokenDigest", "ab".repeat(32)],
    ["encodedTokenBytes", 999],
  ] as const) {
    const evidence = credited(initial);
    evidence.request = { ...evidence.request, [field]: replacement };
    assert.throws(
      () => reduceDurableRecipientDelivery(initial, evidence),
      /request .* conflicts/,
      field,
    );
  }
});

test("receipt and business result substitution fail closed", () => {
  const initial = pending();
  const terminal = reduceDurableRecipientDelivery(initial, credited(initial));
  for (const patch of [
    { receiptOperationId: "score-receipt/foreign" },
    { receivedAtMs: 101 },
    { creditedAmount: 4 },
    { businessEventId: "score-purchase/foreign" },
    { creditedAtMs: 201 },
  ]) {
    assert.throws(
      () =>
        reduceDurableRecipientDelivery(terminal, {
          ...credited(initial),
          ...patch,
        }),
      /conflicts/,
    );
  }
});

test("codecs reject unknown fields and impossible timestamps", () => {
  const record = pending();
  assert.throws(
    () => decodeDurableRecipientDeliveryRecord({ ...record, extra: true }),
    /fields are invalid/,
  );
  assert.throws(
    () =>
      decodeDurableRecipientDeliveryEvidence({
        ...credited(record),
        creditedAtMs: 99,
      }),
    /precedes/,
  );
});
