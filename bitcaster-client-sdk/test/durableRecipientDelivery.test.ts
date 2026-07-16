import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createDurableRecipientDeliveryRecord,
  decodeDurableRecipientDeliveryEvidence,
  decodeDurableRecipientDeliveryRecord,
  reduceDurableRecipientDelivery,
  type DurableRecipientDeliveryEvidence,
  type DurableRecipientDeliveryRecord,
} from "../src/durableRecipientDelivery.ts";
import {
  advanceDurableOutgoingRecipientDeliveryOnce,
  createDurableOutgoingRecipientDeliveryRecord,
  decodeDurableOutgoingRecipientDeliveryRecord,
} from "../src/durableOutgoingRecipientDelivery.ts";
import {
  readDurableRecipientSubmissionAuthority,
} from "../src/durableRecipientSubmission.ts";
import {
  createRecipientDeliveryFixture,
} from "./durableRecipientDeliveryFixture.ts";
import {
  decodeDurableWalletSendDeliveryPreparation,
} from "../src/durableWalletSendDeliveryPreparation.ts";

function pending(): DurableRecipientDeliveryRecord {
  const fixture = createRecipientDeliveryFixture();
  return createDurableRecipientDeliveryRecord({
    deliveryId: "payment-1",
    accountSubject: "account:alice",
    recipientKind: "matching-engine",
    purpose: "participation-score",
    destinationId: "participation-score",
    mintUrl: "https://mint.example",
    unit: "sat",
    requestedAmount: "1",
    creditPolicy: { kind: "exact-amount" },
    encodedToken: fixture.encodedToken,
  });
}

function exactPayloadStore(
  fixture = createRecipientDeliveryFixture(),
) {
  return {
    loadExactPayload: async () => ({
      walletOperation: fixture.walletOperation,
      resultGroups: fixture.resultGroups,
      encodedToken: fixture.encodedToken,
    }),
  };
}

function outgoing() {
  const fixture = createRecipientDeliveryFixture();
  return {
    fixture,
    record: createDurableOutgoingRecipientDeliveryRecord({
      exactPayload: fixture.exactPayload,
    }),
  };
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
    creditedAmount: "1",
    creditVerification: { kind: "exact-amount" },
    businessEventId: "score-purchase/payment-1",
    creditedAtMs: 200,
  };
}

test("public SDK exposes only the recipient submission reader and rejects forgery", async () => {
  const sdk = await import("../src/index.ts");
  assert.equal("readDurableRecipientSubmissionAuthority" in sdk, true);
  assert.equal("issueDurableRecipientSubmissionAuthority" in sdk, false);

  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { exports: Record<string, unknown> };
  assert.equal(
    Object.hasOwn(
      packageJson.exports,
      "./durableRecipientSubmissionAuthority",
    ),
    false,
  );
  assert.equal(
    Object.hasOwn(packageJson.exports, "./durableRecipientSubmission"),
    true,
  );
  assert.throws(
    () =>
      readDurableRecipientSubmissionAuthority({
        kind: "durable-recipient-exact-submission",
      }),
    /authority is invalid/,
  );
});

test("pre-mint preparation binds the delivery policy and full recipient tuple", () => {
  const recipient = createRecipientDeliveryFixture();
  const userExport = createRecipientDeliveryFixture({
    policy: { kind: "user-export" },
  });
  assert.notEqual(
    recipient.preparation.intentFingerprint,
    userExport.preparation.intentFingerprint,
  );
  if (recipient.preparation.policy.kind !== "durable-recipient-ack") {
    throw new Error("missing recipient policy");
  }
  for (const [field, replacement] of [
    ["deliveryId", "payment-2"],
    ["accountSubject", "account:bob"],
    ["recipientKind", "other-service"],
    ["purpose", "market-funding"],
    ["destinationId", "market-2"],
    ["mintUrl", "https://other-mint.example"],
    ["unit", "usd"],
    ["requestedAmount", "2"],
    ["creditPolicy", { kind: "net-of-receive-fee" }],
  ] as const) {
    const changed = structuredClone(recipient.preparation);
    if (changed.policy.kind !== "durable-recipient-ack") {
      throw new Error("missing recipient policy");
    }
    changed.policy.recipient[field] = replacement;
    assert.throws(
      () => decodeDurableWalletSendDeliveryPreparation(changed),
      /fingerprint|preparation|credit policy/,
      field,
    );
  }
});

test("server recipient record contains no sender-local wallet authority", () => {
  const record = pending();
  assert.deepEqual(Object.keys(record).sort(), [
    "request",
    "schemaVersion",
    "state",
  ]);
  assert.equal("exactPayload" in record, false);
  assert.equal("walletOperationId" in record.request, false);
  assert.equal("resultFingerprint" in record.request, false);
});

test("client outgoing composition requires exact local payload authority", () => {
  const delivery = pending();
  assert.throws(
    () =>
      decodeDurableOutgoingRecipientDeliveryRecord({
        schemaVersion: 1,
        delivery,
      }),
    /fields are invalid/,
  );
  const { record } = outgoing();
  assert.throws(
    () =>
      decodeDurableOutgoingRecipientDeliveryRecord({
        ...record,
        exactPayload: {
          ...record.exactPayload,
          tokenDigest: "ab".repeat(32),
        },
      }),
    /conflicts/,
  );
  assert.throws(
    () =>
      decodeDurableOutgoingRecipientDeliveryRecord({
        ...record,
        delivery: {
          ...record.delivery,
          request: {
            ...record.delivery.request,
            creditPolicy: { kind: "net-of-receive-fee" },
          },
        },
      }),
    /conflicts/,
  );
});

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

test("net-of-receive-fee accepts only exact fee arithmetic", () => {
  const fixture = createRecipientDeliveryFixture({
    amount: 5,
    policy: {
      kind: "durable-recipient-ack",
      recipient: {
        deliveryId: "deposit-1",
        accountSubject: "account:alice",
        recipientKind: "matching-engine",
        purpose: "market-funding",
        destinationId: "market-1",
        mintUrl: "https://mint.example",
        unit: "sat",
        requestedAmount: "5",
        creditPolicy: {
          kind: "net-of-receive-fee",
        },
      },
    },
  });
  const record = createDurableOutgoingRecipientDeliveryRecord({
    exactPayload: fixture.exactPayload,
  }).delivery;
  const evidence = {
    kind: "credited" as const,
    request: record.request,
    receiptOperationId: "market-receipt/deposit-1",
    receivedAtMs: 100,
    creditedAmount: "4",
    creditVerification: {
      kind: "net-of-receive-fee" as const,
      receiveFeeAmount: "1",
    },
    businessEventId: "deposit-1",
    creditedAtMs: 200,
  };

  assert.equal(
    reduceDurableRecipientDelivery(record, evidence).state.kind,
    "credited",
  );
  for (const changed of [
    { ...evidence, creditVerification: undefined },
    {
      ...evidence,
      creditVerification: {
        kind: "net-of-receive-fee",
        receiveFeeAmount: "2",
      },
    },
    {
      ...evidence,
      creditVerification: { kind: "exact-amount" },
    },
  ]) {
    assert.throws(
      () => reduceDurableRecipientDelivery(record, changed),
      /credit|fields are invalid/,
    );
  }
});

test("exact-amount rejects the net-of-receive-fee verification variant", () => {
  const record = pending();
  assert.throws(
    () =>
      reduceDurableRecipientDelivery(record, {
        ...credited(record),
        creditedAmount: "1",
        creditVerification: {
          kind: "net-of-receive-fee",
          receiveFeeAmount: "0",
        },
      }),
    /credit/,
  );
  const adapterSelected = createDurableRecipientDeliveryRecord({
    ...record.request,
    encodedToken: createRecipientDeliveryFixture().encodedToken,
    creditPolicy: { kind: "net-of-receive-fee" },
  });
  assert.equal(adapterSelected.request.purpose, "participation-score");
  assert.equal(
    adapterSelected.request.creditPolicy.kind,
    "net-of-receive-fee",
  );
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
    ["requestedAmount", "6"],
    [
      "creditPolicy",
      { kind: "net-of-receive-fee" },
    ],
    ["tokenDigest", "ab".repeat(32)],
    ["encodedTokenBytes", 999],
  ] as const) {
    const evidence = credited(initial);
    evidence.request = { ...evidence.request, [field]: replacement };
    assert.throws(
      () => reduceDurableRecipientDelivery(initial, evidence),
      /request .* conflicts|credit policy|credit verification/,
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
    { creditedAmount: "4" },
    {
      creditVerification: {
        kind: "net-of-receive-fee",
        receiveFeeAmount: "0",
      },
    },
    { businessEventId: "score-purchase/foreign" },
    { creditedAtMs: 201 },
  ]) {
    assert.throws(
      () =>
        reduceDurableRecipientDelivery(terminal, {
          ...credited(initial),
          ...patch,
        }),
      /conflicts|credit verification/,
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
  assert.throws(
    () =>
      decodeDurableRecipientDeliveryRecord({
        ...record,
        request: {
          ...record.request,
          requestedAmount: "1".repeat(129),
        },
      }),
    /requested amount is invalid/,
  );
  const market = createRecipientDeliveryFixture({
    amount: 5,
    policy: {
      kind: "durable-recipient-ack",
      recipient: {
        deliveryId: "deposit-1",
        accountSubject: "account:alice",
        recipientKind: "matching-engine",
        purpose: "market-funding",
        destinationId: "market-1",
        mintUrl: "https://mint.example",
        unit: "sat",
        requestedAmount: "5",
        creditPolicy: {
          kind: "net-of-receive-fee",
        },
      },
    },
  });
  const marketRecord = createDurableOutgoingRecipientDeliveryRecord({
    exactPayload: market.exactPayload,
  }).delivery;
  assert.throws(
    () =>
      decodeDurableRecipientDeliveryEvidence({
        kind: "credited",
        request: marketRecord.request,
        receiptOperationId: "market-receipt/deposit-1",
        receivedAtMs: 100,
        creditedAmount: "4",
        creditVerification: {
          kind: "net-of-receive-fee",
          receiveFeeAmount: "1".repeat(129),
        },
        businessEventId: "deposit-1",
        creditedAtMs: 200,
      }),
    /receive fee amount is invalid/,
  );
});

test("recipient delivery reads status before one exact submit and keeps acceptance pending", async () => {
  const { record: initial, fixture } = outgoing();
  const calls: string[] = [];
  const result = await advanceDurableOutgoingRecipientDeliveryOnce({
    record: initial,
    exactPayloadStore: exactPayloadStore(fixture),
    transport: {
      readStatus: async (request) => {
        calls.push(`status:${request.deliveryId}`);
        return { kind: "not-found" };
      },
      submitExact: async (authority) => {
        const submission = readDurableRecipientSubmissionAuthority(authority);
        calls.push(`submit:${submission.request.deliveryId}`);
        assert.equal(submission.encodedToken, fixture.encodedToken);
        return { kind: "accepted" };
      },
    },
  });

  assert.deepEqual(calls, ["status:payment-1", "submit:payment-1"]);
  assert.equal(result.kind, "pending");
  assert.equal(result.source, "submit-accepted");
  assert.equal(result.record.delivery.state.kind, "pending");
});

test("recipient delivery closes from status without resubmitting", async () => {
  const { record: initial } = outgoing();
  let submits = 0;
  const result = await advanceDurableOutgoingRecipientDeliveryOnce({
    record: initial,
    exactPayloadStore: exactPayloadStore(),
    transport: {
      readStatus: async () => credited(initial.delivery),
      submitExact: async () => {
        submits += 1;
        return { kind: "accepted" };
      },
    },
  });

  assert.equal(submits, 0);
  assert.equal(result.kind, "credited");
  assert.equal(result.source, "status");
  assert.equal(result.record.delivery.state.kind, "credited");
});

test("received status suppresses submit and cannot regress on later not-found", async () => {
  const { record: initial } = outgoing();
  let submits = 0;
  const first = await advanceDurableOutgoingRecipientDeliveryOnce({
    record: initial,
    exactPayloadStore: exactPayloadStore(),
    transport: {
      readStatus: async () => received(initial.delivery),
      submitExact: async () => {
        submits += 1;
        return { kind: "accepted" };
      },
    },
  });
  assert.equal(first.kind, "received");
  assert.equal(first.source, "status");
  assert.equal(submits, 0);

  const second = await advanceDurableOutgoingRecipientDeliveryOnce({
    record: first.record,
    exactPayloadStore: exactPayloadStore(),
    transport: {
      readStatus: async () => ({ kind: "not-found" }),
      submitExact: async () => {
        submits += 1;
        return { kind: "accepted" };
      },
    },
  });
  assert.equal(second.kind, "received");
  assert.equal(second.source, "status");
  assert.equal(submits, 0);
});

test("recipient delivery accepts terminal submit evidence but not submit acceptance", async () => {
  const { record: initial } = outgoing();
  const result = await advanceDurableOutgoingRecipientDeliveryOnce({
    record: initial,
    exactPayloadStore: exactPayloadStore(),
    transport: {
      readStatus: async () => ({ kind: "not-found" }),
      submitExact: async () => ({
        kind: "evidence",
        evidence: credited(initial.delivery),
      }),
    },
  });

  assert.equal(result.kind, "credited");
  assert.equal(result.source, "submit-evidence");
  assert.equal(result.record.delivery.state.kind, "credited");
});

test("lost submit response is recovered by the next status-first attempt", async () => {
  const { record: initial } = outgoing();
  let creditedOnStatus = false;
  let submits = 0;
  const transport = {
    readStatus: async () =>
      creditedOnStatus
        ? credited(initial.delivery)
        : { kind: "not-found" as const },
    submitExact: async () => {
      submits += 1;
      creditedOnStatus = true;
      throw new Error("submit response was lost");
    },
  };

  await assert.rejects(
    () =>
      advanceDurableOutgoingRecipientDeliveryOnce({
        record: initial,
        exactPayloadStore: exactPayloadStore(),
        transport,
      }),
    /response was lost/,
  );
  const recovered = await advanceDurableOutgoingRecipientDeliveryOnce({
    record: initial,
    exactPayloadStore: exactPayloadStore(),
    transport,
  });

  assert.equal(submits, 1);
  assert.equal(recovered.kind, "credited");
  assert.equal(recovered.source, "status");
});

test("recipient coordinator rejects a substituted persisted token before transport", async () => {
  const { record: initial } = outgoing();
  let submitted = false;
  await assert.rejects(
    () =>
      advanceDurableOutgoingRecipientDeliveryOnce({
        record: structuredClone(initial),
        exactPayloadStore: {
          loadExactPayload: async () => {
            const fixture = createRecipientDeliveryFixture();
            return {
              walletOperation: fixture.walletOperation,
              resultGroups: fixture.resultGroups,
              encodedToken: `${fixture.encodedToken}foreign`,
            };
          },
        },
        transport: {
          readStatus: async () => ({ kind: "not-found" }),
          submitExact: async () => {
            submitted = true;
            return { kind: "accepted" };
          },
        },
      }),
    /token|exact payload conflicts/,
  );
  assert.equal(submitted, false);
});

test("recipient coordinator fails closed on substituted request and result evidence", async () => {
  const { record: initial } = outgoing();
  for (const evidence of [
    {
      ...credited(initial.delivery),
      request: {
        ...initial.delivery.request,
        accountSubject: "account:bob",
      },
    },
    {
      ...credited(initial.delivery),
      request: {
        ...initial.delivery.request,
        destinationId: "market-1",
      },
    },
    {
      ...credited(initial.delivery),
      request: {
        ...initial.delivery.request,
        tokenDigest: "ab".repeat(32),
      },
    },
    {
      ...credited(initial.delivery),
      request: {
        ...initial.delivery.request,
        requestedAmount: "6",
      },
    },
  ]) {
    await assert.rejects(
      () =>
        advanceDurableOutgoingRecipientDeliveryOnce({
          record: initial,
          exactPayloadStore: exactPayloadStore(),
          transport: {
            readStatus: async () => evidence,
            submitExact: async () => ({ kind: "accepted" }),
          },
        }),
      /conflicts|credit verification/,
    );
  }

  const afterReceipt = reduceDurableRecipientDelivery(
    initial.delivery,
    received(initial.delivery),
  );
  const afterReceiptOutgoing = {
    ...initial,
    delivery: afterReceipt,
  };
  await assert.rejects(
    () =>
      advanceDurableOutgoingRecipientDeliveryOnce({
        record: afterReceiptOutgoing,
        exactPayloadStore: exactPayloadStore(),
        transport: {
          readStatus: async () => ({
            ...credited(initial.delivery),
            receiptOperationId: "score-receipt/foreign",
          }),
          submitExact: async () => ({ kind: "accepted" }),
        },
      }),
    /receipt operation conflicts/,
  );
});
