import assert from "node:assert/strict";
import { test } from "node:test";
import type { Proof, SerializedBlindedMessage } from "@cashu/cashu-ts";
import {
  COLLATERAL_COLLECTION,
  computeConvertFeeSats,
  payoffVector,
  planCtfConsolidation,
  type CtfConsolidationParams,
} from "../src/ctfConsolidation.ts";

const CONDITION_ID = "b".repeat(64);
const OUTCOMES = ["A", "B", "C"];

test("T1 converts N-1 singletons plus collateral top-up into the missing complement", () => {
  const result = planCtfConsolidation(
    params("t1", {
      A: [proof("ks-A", 10, "a-10")],
      B: [proof("ks-B", 10, "b-10")],
      [COLLATERAL_COLLECTION]: [proof("ks-base", 1, "base-1")],
    }),
  );

  assert.equal(result.kind, "plan");
  if (result.kind !== "plan") return;
  assert.equal(result.feeSats, 1);
  assert.deepEqual(result.inputPayoff, { A: 11, B: 11, C: 1 });
  assert.deepEqual(result.outputPayoff, { A: 10, B: 10, C: 0 });
  assert.deepEqual(Object.keys(result.request.inputs).sort(), [
    COLLATERAL_COLLECTION,
    "A",
    "B",
  ]);
  assert.deepEqual(result.request.outputs["A|B"], [
    output("ks-A|B", 10, "A|B"),
  ]);
});

test("T2 extracts max collateral from the 3-outcome NegRisk complement case", () => {
  const result = planCtfConsolidation(
    params("t2", {
      "B|C": [proof("ks-B|C", 2, "not-a-2")],
      "A|C": [proof("ks-A|C", 2, "not-b-2")],
    }),
  );

  assert.equal(result.kind, "plan");
  if (result.kind !== "plan") return;
  assert.equal(result.feeSats, 1);
  assert.equal(result.collateralOutputSats, 1);
  assert.deepEqual(result.inputPayoff, { A: 2, B: 2, C: 4 });
  assert.deepEqual(result.outputPayoff, { A: 1, B: 1, C: 3 });
  assert.deepEqual(result.request.outputs[COLLATERAL_COLLECTION], [
    output("ks-base", 1, COLLATERAL_COLLECTION),
  ]);
  assert.deepEqual(result.request.outputs.C, [output("ks-C", 2, "C")]);
});

test("T3 converts a complete uniform holding into pure base collateral", () => {
  const result = planCtfConsolidation(
    params("t3", {
      A: [proof("ks-A", 10, "a-10")],
      B: [proof("ks-B", 10, "b-10")],
      C: [proof("ks-C", 10, "c-10")],
    }),
  );

  assert.equal(result.kind, "plan");
  if (result.kind !== "plan") return;
  assert.equal(result.feeSats, 1);
  assert.equal(result.collateralOutputSats, 9);
  assert.deepEqual(result.inputPayoff, { A: 10, B: 10, C: 10 });
  assert.deepEqual(result.outputPayoff, { A: 9, B: 9, C: 9 });
  assert.deepEqual(Object.keys(result.request.outputs), [
    COLLATERAL_COLLECTION,
  ]);
});

test("T2 skips when the fee floor consumes the available collateral gain", () => {
  const result = planCtfConsolidation(
    params("t2", {
      "B|C": [proof("ks-B|C", 1, "not-a-1")],
      "A|C": [proof("ks-A|C", 1, "not-b-1")],
    }),
  );

  assert.deepEqual(result, {
    kind: "noop",
    strategy: "t2",
    reason: "net-collateral-nonpositive",
    feeSats: 1,
    inputPayoff: { A: 1, B: 1, C: 2 },
  });
});

test("T1 accepts an outcome amount exactly equal to the fee floor", () => {
  const result = planCtfConsolidation(
    params("t1", {
      A: [proof("ks-A", 1, "a-1")],
      B: [proof("ks-B", 1, "b-1")],
      [COLLATERAL_COLLECTION]: [proof("ks-base", 1, "base-1")],
    }),
  );

  assert.equal(result.kind, "plan");
  if (result.kind !== "plan") return;
  assert.equal(result.feeSats, 1);
  assert.equal(result.collateralOutputSats, 0);
  assert.deepEqual(result.inputPayoff, { A: 2, B: 2, C: 1 });
  assert.deepEqual(result.outputPayoff, { A: 1, B: 1, C: 0 });
  assert.deepEqual(Object.keys(result.request.outputs), ["A|B"]);
  assert.deepEqual(result.request.outputs["A|B"], [
    output("ks-A|B", 1, "A|B"),
  ]);
});

test("T3 skips when F equals every input amount and outputs would net to zero", () => {
  const result = planCtfConsolidation(
    params("t3", {
      A: [proof("ks-A", 1, "a-1")],
      B: [proof("ks-B", 1, "b-1")],
      C: [proof("ks-C", 1, "c-1")],
    }),
  );

  assert.deepEqual(result, {
    kind: "noop",
    strategy: "t3",
    reason: "net-collateral-nonpositive",
    feeSats: 1,
    inputPayoff: { A: 1, B: 1, C: 1 },
  });
});

test("payoff conservation uses the computed fee floor and covers F greater than 1", () => {
  const proofsByCollection = {
    A: manyProofs("ks-A", 334, "a"),
    B: manyProofs("ks-B", 334, "b"),
    C: manyProofs("ks-C", 333, "c"),
  };
  const config = params("t3", proofsByCollection);
  const allProofs = Object.values(proofsByCollection).flat();
  const computedFee = computeConvertFeeSats(
    allProofs,
    config.inputFeePpkByKeyset,
  );

  assert.equal(allProofs.length, 1001);
  assert.equal(computedFee, 2);

  const result = planCtfConsolidation(config);
  assert.equal(result.kind, "plan");
  if (result.kind !== "plan") return;

  const inputPayoff = payoffVector(OUTCOMES, result.request.inputs);
  const outputPayoff = payoffVectorFromMessages(result.request.outputs);
  for (const outcome of OUTCOMES) {
    assert.equal(
      outputPayoff[outcome],
      inputPayoff[outcome] - computedFee,
      `${outcome} payoff should subtract computed F=${computedFee}`,
    );
  }
  assert.equal(result.feeSats, computedFee);
  assert.deepEqual(result.request.outputs[COLLATERAL_COLLECTION], [
    output("ks-base", 331, COLLATERAL_COLLECTION),
  ]);
  assert.deepEqual(result.request.outputs["A|B"], [
    output("ks-A|B", 1, "A|B"),
  ]);
});

function params(
  strategy: CtfConsolidationParams["strategy"],
  proofsByCollection: Record<string, Proof[]>,
): CtfConsolidationParams {
  return {
    conditionId: CONDITION_ID,
    outcomes: OUTCOMES,
    marketStatus: "pending",
    strategy,
    proofsByCollection,
    inputFeePpkByKeyset: {
      "ks-A": 1,
      "ks-B": 1,
      "ks-C": 1,
      "ks-A|B": 1,
      "ks-A|C": 1,
      "ks-B|C": 1,
      "ks-base": 1,
    },
    outputKeysetByCollection: {
      A: "ks-A",
      B: "ks-B",
      C: "ks-C",
      "A|B": "ks-A|B",
      "A|C": "ks-A|C",
      "B|C": "ks-B|C",
      [COLLATERAL_COLLECTION]: "ks-base",
    },
    makeOutputs: ({ collection, amountSats, keysetId }) => [
      output(keysetId, amountSats, collection),
    ],
  };
}

function proof(id: string, amount: number, label: string): Proof {
  return {
    id,
    amount,
    secret: `secret-${label}`,
    C: `C-${label}`,
  };
}

function manyProofs(id: string, count: number, label: string): Proof[] {
  return Array.from({ length: count }, (_, index) =>
    proof(id, 1, `${label}-${index}`),
  );
}

function output(
  keysetId: string,
  amount: number,
  collection: string,
): SerializedBlindedMessage {
  return {
    amount,
    id: keysetId,
    B_: `B-${collection}-${amount}`,
  };
}

function payoffVectorFromMessages(
  outputs: Record<string, SerializedBlindedMessage[]>,
): Record<string, number> {
  const proofsByCollection = Object.fromEntries(
    Object.entries(outputs).map(([collection, messages]) => [
      collection,
      messages.map(
        (message) =>
          ({
            id: message.id,
            amount: message.amount,
            secret: "",
            C: "",
          }) as Proof,
      ),
    ]),
  );
  return payoffVector(OUTCOMES, proofsByCollection);
}
