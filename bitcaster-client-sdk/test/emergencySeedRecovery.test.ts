import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceEmergencySeedRecoveryCursor,
  classifyEmergencySeedRecoveryProof,
  createEmergencySeedRecoveryCursor,
  validateEmergencySeedRecoveryCursor,
} from "../src/emergencySeedRecovery.ts";
import {
  advanceSeedScan,
  classifySeedRecoveryMintState,
} from "../src/seedRecoveryCore.ts";

function cursor() {
  return createEmergencySeedRecoveryCursor({
    recoveryId: "recovery-1",
    mintUrl: "https://mint.example",
    unit: "sat",
    keysetId: "keyset-1",
  });
}

test("seed recovery advances exactly and stops after the trailing gap", () => {
  const afterSignature = advanceEmergencySeedRecoveryCursor(cursor(), {
    startCounter: 0,
    requestedCount: 300,
    lastCounterWithSignature: 298,
  });
  assert.equal(afterSignature.nextCounter, 300);
  assert.equal(afterSignature.trailingEmptyCounters, 1);
  assert.equal(afterSignature.state, "active");

  const completed = advanceEmergencySeedRecoveryCursor(afterSignature, {
    startCounter: 300,
    requestedCount: 300,
    lastCounterWithSignature: null,
  });
  assert.equal(completed.nextCounter, 600);
  assert.equal(completed.trailingEmptyCounters, 301);
  assert.equal(completed.state, "completed");
});

test("seed recovery rejects stale, oversized, and inconsistent cursors", () => {
  assert.throws(
    () =>
      advanceEmergencySeedRecoveryCursor(cursor(), {
        startCounter: 300,
        requestedCount: 300,
        lastCounterWithSignature: null,
      }),
    /stale counter/,
  );
  assert.throws(
    () =>
      advanceEmergencySeedRecoveryCursor(cursor(), {
        startCounter: 0,
        requestedCount: 301,
        lastCounterWithSignature: null,
      }),
    /batch size/,
  );
  assert.throws(
    () =>
      validateEmergencySeedRecoveryCursor({
        ...cursor(),
        state: "completed",
      }),
    /completion state/,
  );
});

test("only NUT-07 unspent proofs become selectable", () => {
  assert.equal(
    classifyEmergencySeedRecoveryProof("UNSPENT"),
    "import-selectable",
  );
  assert.equal(classifyEmergencySeedRecoveryProof("SPENT"), "ignore-spent");
  assert.equal(
    classifyEmergencySeedRecoveryProof("PENDING"),
    "retain-nonselectable",
  );
  assert.equal(classifyEmergencySeedRecoveryProof("UNKNOWN"), "fail-closed");
});

test("ordinary and conditional recovery share the exact scan and disposition corpus", () => {
  const cases = [
    { requestedCount: 3, lastOffset: 1, expectedGap: 1 },
    { requestedCount: 3, lastOffset: null, expectedGap: 4 },
    { requestedCount: 3, lastOffset: 2, expectedGap: 0 },
  ] as const;
  let ordinary = cursor();
  let conditional = {
    startCounter: 0,
    nextCounter: 0,
    totalRequestedOutputs: 0,
    totalReturnedProofs: 0,
    consecutiveEmptyOutputs: 0,
  };
  for (const testCase of cases) {
    const startCounter = ordinary.nextCounter;
    ordinary = advanceEmergencySeedRecoveryCursor(ordinary, {
      startCounter,
      requestedCount: testCase.requestedCount,
      lastCounterWithSignature:
        testCase.lastOffset === null
          ? null
          : startCounter + testCase.lastOffset,
    });
    conditional = advanceSeedScan(
      conditional,
      {
        startCounter,
        requestedCount: testCase.requestedCount,
        returnedCounterOffsets:
          testCase.lastOffset === null ? [] : [testCase.lastOffset],
      },
      { maxBatchSize: 300, maxTotalOutputs: 1_000 },
    );
    assert.equal(ordinary.nextCounter, conditional.nextCounter);
    assert.equal(
      ordinary.trailingEmptyCounters,
      conditional.consecutiveEmptyOutputs,
    );
    assert.equal(ordinary.trailingEmptyCounters, testCase.expectedGap);
  }

  const dispositionCorpus = [
    ["UNSPENT", "import-selectable", "selectable"],
    ["PENDING", "retain-nonselectable", "retain-nonselectable"],
    ["SPENT", "ignore-spent", "spent"],
    ["UNKNOWN", "fail-closed", "fail-closed"],
  ] as const;
  for (const [
    state,
    ordinaryDisposition,
    sharedDisposition,
  ] of dispositionCorpus) {
    assert.equal(
      classifyEmergencySeedRecoveryProof(state),
      ordinaryDisposition,
    );
    assert.equal(classifySeedRecoveryMintState(state), sharedDisposition);
  }
});
