import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceEmergencySeedRecoveryCursor,
  classifyEmergencySeedRecoveryProof,
  createEmergencySeedRecoveryCursor,
  validateEmergencySeedRecoveryCursor,
} from "../src/emergencySeedRecovery.ts";

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
  assert.equal(classifyEmergencySeedRecoveryProof("UNSPENT"), "import-selectable");
  assert.equal(classifyEmergencySeedRecoveryProof("SPENT"), "ignore-spent");
  assert.equal(
    classifyEmergencySeedRecoveryProof("PENDING"),
    "retain-nonselectable",
  );
  assert.equal(classifyEmergencySeedRecoveryProof("UNKNOWN"), "fail-closed");
});
