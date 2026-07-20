import assert from "node:assert/strict";
import test from "node:test";
import {
  CONDITIONAL_RECOVERY_SESSION_SCHEMA_VERSION,
  createConditionalRecoveryWalletScope,
  decodeConditionalRecoverySession,
  encodeConditionalRecoverySession,
  rehydrateConditionalRecoverySessionCapabilities,
  validateConditionalRecoverySessionSuccessor,
} from "../src/emergencyConditionalSeedRecovery.ts";
import {
  advanceSession,
  freezeSession,
} from "../src/emergencyConditionalRecoveryCatalogue.ts";
import { deriveDurableCustodyScopeId } from "../src/durableCustody.ts";
import type {
  ConditionalRecoverySession,
  ConditionalRecoveryWalletScope,
} from "../src/emergencyConditionalRecoveryTypes.ts";

const HEX_A = "aa".repeat(32);
const HEX_B = "bb".repeat(32);
const KEYSET_A = `01${"11".repeat(32)}`;
const KEYSET_B = `01${"22".repeat(32)}`;
const scope: ConditionalRecoveryWalletScope =
  createConditionalRecoveryWalletScope({
    scopeId: deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: "22".repeat(32),
    }),
    mintUrl: "https://mint.example/",
    unit: "sat",
  });

function scan(overrides: Record<string, unknown> = {}) {
  return {
    startCounter: 10,
    nextCounter: 10,
    plannedStart: null,
    plannedCount: 0,
    totalRequestedOutputs: 0,
    totalReturnedProofs: 0,
    consecutiveEmptyOutputs: 0,
    ...overrides,
  };
}

function session(
  transition: ConditionalRecoverySession["transition"],
  overrides: Record<string, unknown> = {},
): ConditionalRecoverySession {
  return freezeSession({
    walletScope: scope,
    sequence: transition === "completed-catalogue" ? 0 : 1,
    predecessorDigest: transition === "completed-catalogue" ? null : HEX_A,
    transition,
    evidenceDigest: HEX_B,
    budget: {
      transportBytes: 0,
      serializedBytes: 0,
      workUnits: 0,
      proofCount: 0,
    },
    catalogueDigest: HEX_A,
    completedKeysetProofCount: 0,
    catalogueOrdinal: transition === "completed-catalogue" ? null : 0,
    activeKeysetId:
      transition === "completed-catalogue" ||
      transition === "keyset-skipped" ||
      transition === "recovery-completed" ||
      transition === "recovery-failed-closed"
        ? null
        : KEYSET_A,
    keysetMetadataDigest:
      transition === "completed-catalogue" ||
      transition === "keyset-skipped" ||
      transition === "recovery-completed" ||
      transition === "recovery-failed-closed"
        ? null
        : HEX_A,
    scan: scan(),
    currentBatch: null,
    keysetTerminalEvidence: null,
    skipEvidence:
      transition === "keyset-skipped"
        ? {
            catalogueOrdinal: 0,
            keysetId: KEYSET_A,
            reason: "freshly-proven-ineligible",
            authorityDigest: HEX_A,
          }
        : null,
    terminalEvidence:
      transition === "recovery-completed"
        ? { kind: "completed", catalogueLength: 1, digest: HEX_A }
        : transition === "recovery-failed-closed"
          ? { kind: "failed-closed", reasonDigest: HEX_A }
          : null,
    ...overrides,
  } as never);
}

function successor(
  predecessor: ConditionalRecoverySession,
  transition: ConditionalRecoverySession["transition"],
  overrides: Record<string, unknown> = {},
): ConditionalRecoverySession {
  return session(transition, {
    sequence: predecessor.sequence + 1,
    predecessorDigest: predecessor.digest,
    budget: predecessor.budget,
    completedKeysetProofCount: predecessor.completedKeysetProofCount,
    catalogueOrdinal: predecessor.catalogueOrdinal,
    activeKeysetId: predecessor.activeKeysetId,
    keysetMetadataDigest: predecessor.keysetMetadataDigest,
    scan: predecessor.scan,
    currentBatch: predecessor.currentBatch,
    ...overrides,
  });
}

test("direct rehydration rejects both terminal session variants", async () => {
  for (const transition of [
    "recovery-completed",
    "recovery-failed-closed",
  ] as const) {
    await assert.rejects(
      Reflect.apply(
        rehydrateConditionalRecoverySessionCapabilities,
        undefined,
        [session(transition), {}, {}],
      ),
      /terminal session has no rehydratable capabilities/i,
    );
  }
});

test("generic session CAS cannot produce either NUT-09 staged transition", () => {
  let genericCasCalls = 0;
  const port = {
    compareAndSwap: () => {
      genericCasCalls += 1;
      return true;
    },
  };
  for (const transition of ["nut09-request", "nut09-response"] as const) {
    assert.throws(
      () =>
        advanceSession(
          session("completed-catalogue"),
          port as never,
          transition,
          HEX_A,
          {
            transportBytes: 0,
            serializedBytes: 0,
            workUnits: 0,
            proofCount: 0,
          },
          scan(),
        ),
      /requires its atomic staging CAS/i,
    );
  }
  assert.equal(genericCasCalls, 0);
});

test("session-v2 codec is canonical, scope-bound, bounded, and fails closed on v1", () => {
  assert.equal(CONDITIONAL_RECOVERY_SESSION_SCHEMA_VERSION, 2);
  const original = session("completed-catalogue");
  const bytes = encodeConditionalRecoverySession(original, scope);
  const text = new TextDecoder().decode(bytes);
  assert.equal(text.includes("walletScope"), false);
  const decoded = decodeConditionalRecoverySession(bytes, scope);
  assert.equal(decoded.digest, original.digest);
  assert.equal(decoded.catalogueDigest, original.catalogueDigest);
  assert.throws(
    () => decodeConditionalRecoverySession(new TextEncoder().encode(` ${text}`), scope),
    /canonical/i,
  );
  assert.throws(
    () => decodeConditionalRecoverySession(bytes, { ...scope, unit: "usd" }),
    /scope|digest/i,
  );
  assert.throws(
    () =>
      decodeConditionalRecoverySession(
        new TextEncoder().encode(text.replace('"schemaVersion":2', '"schemaVersion":1')),
        scope,
      ),
    /unsupported|version/i,
  );
  assert.throws(
    () =>
      decodeConditionalRecoverySession(
        new TextEncoder().encode(
          text.replace(
            `"catalogueDigest":"${HEX_A}"`,
            `"catalogueDigest":"${HEX_B}"`,
          ),
        ),
        scope,
      ),
    /digest/i,
  );
  assert.throws(
    () => decodeConditionalRecoverySession(new Uint8Array(65_537), scope),
    /bound|large/i,
  );
  assert.throws(
    () =>
      decodeConditionalRecoverySession(
        new TextEncoder().encode(text.replace(/}$/, ',"unknown":true}')),
        scope,
      ),
    /fields|canonical/i,
  );
});

test("strict predecessor sequence and digest are mandatory", () => {
  const initial = session("completed-catalogue");
  const selected = successor(initial, "conditional-keys", {
    catalogueOrdinal: 0,
    activeKeysetId: KEYSET_A,
    keysetMetadataDigest: HEX_A,
  });
  validateConditionalRecoverySessionSuccessor(initial, selected);
  assert.throws(
    () =>
      validateConditionalRecoverySessionSuccessor(initial, {
        ...selected,
        sequence: selected.sequence + 1,
      }),
    /sequence/i,
  );
  assert.throws(
    () =>
      validateConditionalRecoverySessionSuccessor(initial, {
        ...selected,
        predecessorDigest: HEX_B,
      }),
    /predecessor|digest/i,
  );
  assert.throws(
    () =>
      validateConditionalRecoverySessionSuccessor(
        initial,
        successor(initial, "conditional-keys", {
          catalogueDigest: HEX_B,
          catalogueOrdinal: 0,
          activeKeysetId: KEYSET_A,
          keysetMetadataDigest: HEX_A,
        }),
      ),
    /immutable catalogue digest/i,
  );
});

test("deterministic plan, request, and staged batch bindings advance in exact order", () => {
  const selected = session("conditional-keys");
  const planned = successor(selected, "nut13-plan", {
    scan: scan({ plannedStart: 10, plannedCount: 2 }),
    currentBatch: {
      planDigest: HEX_A,
      planStart: 10,
      planCount: 2,
      requestDigest: null,
      batchDigest: null,
      stagedBatchId: null,
      returnedCount: null,
    },
  });
  const requested = successor(planned, "nut09-request", {
    currentBatch: { ...planned.currentBatch!, requestDigest: HEX_B },
  });
  const responded = successor(requested, "nut09-response", {
    budget: { ...requested.budget, proofCount: 1 },
    scan: scan({
      nextCounter: 12,
      totalRequestedOutputs: 2,
      totalReturnedProofs: 1,
    }),
    currentBatch: {
      ...requested.currentBatch!,
      batchDigest: HEX_A,
      stagedBatchId: "batch-1",
      returnedCount: 1,
    },
  });
  validateConditionalRecoverySessionSuccessor(selected, planned);
  validateConditionalRecoverySessionSuccessor(planned, requested);
  validateConditionalRecoverySessionSuccessor(requested, responded);
  const reboundRequest = successor(planned, "nut09-request", {
    currentBatch: { ...requested.currentBatch!, planDigest: HEX_B },
  });
  assert.throws(
    () =>
      validateConditionalRecoverySessionSuccessor(planned, reboundRequest),
    /plan|binding/i,
  );
  assert.throws(
    () => validateConditionalRecoverySessionSuccessor(requested, planned),
    /sequence|edge|successor/i,
  );
});

test("proof batches require verification, fresh NUT-07, and admission before replanning", () => {
  const response = session("nut09-response", {
    sequence: 4,
    budget: { transportBytes: 0, serializedBytes: 0, workUnits: 0, proofCount: 1 },
    scan: scan({
      nextCounter: 111,
      totalRequestedOutputs: 101,
      totalReturnedProofs: 1,
      consecutiveEmptyOutputs: 100,
    }),
    currentBatch: {
      planDigest: HEX_A,
      planStart: 0,
      planCount: 1,
      requestDigest: HEX_B,
      batchDigest: HEX_A,
      stagedBatchId: "batch-1",
      returnedCount: 1,
    },
  });
  assert.throws(
    () => validateConditionalRecoverySessionSuccessor(response, successor(response, "nut13-plan")),
    /edge|proof/i,
  );
  assert.throws(
    () =>
      validateConditionalRecoverySessionSuccessor(
        response,
        successor(response, "keyset-completed", {
          activeKeysetId: null,
          keysetMetadataDigest: null,
          currentBatch: null,
          keysetTerminalEvidence: {
            kind: "gap-limit",
            keysetId: KEYSET_A,
            gapLimit: 100,
            digest: HEX_A,
          },
        }),
      ),
    /proof|gap|edge/i,
  );
  const verified = successor(response, "proof-verification");
  const admitted = successor(verified, "atomic-admission");
  const nextPlan = successor(admitted, "nut13-plan", {
    scan: { ...admitted.scan, plannedStart: admitted.scan.nextCounter, plannedCount: 2 },
    currentBatch: {
      planDigest: HEX_B,
      planStart: admitted.scan.nextCounter,
      planCount: 2,
      requestDigest: null,
      batchDigest: null,
      stagedBatchId: null,
      returnedCount: null,
    },
  });
  validateConditionalRecoverySessionSuccessor(response, verified);
  validateConditionalRecoverySessionSuccessor(verified, admitted);
  validateConditionalRecoverySessionSuccessor(admitted, nextPlan);
});

test("empty scans alone satisfy gap completion and reset on the next keyset", () => {
  const response = session("nut09-response", {
    sequence: 4,
    scan: scan({
      nextCounter: 12,
      totalRequestedOutputs: 2,
      consecutiveEmptyOutputs: 2,
    }),
    currentBatch: {
      planDigest: HEX_A,
      planStart: 0,
      planCount: 1,
      requestDigest: HEX_B,
      batchDigest: HEX_A,
      stagedBatchId: null,
      returnedCount: 0,
    },
  });
  const completed = successor(response, "keyset-completed", {
    completedKeysetProofCount: 0,
    activeKeysetId: null,
    keysetMetadataDigest: null,
    currentBatch: null,
    keysetTerminalEvidence: {
      kind: "gap-limit",
      keysetId: KEYSET_A,
      gapLimit: 2,
      digest: HEX_A,
    },
  });
  validateConditionalRecoverySessionSuccessor(response, completed);
  const next = successor(completed, "conditional-keys", {
    catalogueOrdinal: 1,
    activeKeysetId: KEYSET_B,
    keysetMetadataDigest: HEX_B,
    scan: scan({ startCounter: 50, nextCounter: 50 }),
    keysetTerminalEvidence: null,
  });
  validateConditionalRecoverySessionSuccessor(completed, next);
  const bypass = successor(completed, "conditional-keys", {
    catalogueOrdinal: 2,
    activeKeysetId: KEYSET_B,
    keysetMetadataDigest: HEX_B,
    scan: scan({ startCounter: 50, nextCounter: 50 }),
    keysetTerminalEvidence: null,
  });
  assert.throws(
    () => validateConditionalRecoverySessionSuccessor(completed, bypass),
    /ordinal/i,
  );
  const revisit = successor(completed, "conditional-keys", {
    catalogueOrdinal: 1,
    activeKeysetId: KEYSET_A,
    keysetMetadataDigest: HEX_B,
    scan: scan({ startCounter: 50, nextCounter: 50 }),
    keysetTerminalEvidence: null,
  });
  assert.throws(
    () => validateConditionalRecoverySessionSuccessor(completed, revisit),
    /keyset|revisit/i,
  );
});

test("budget equation is cumulative across keysets and per-keyset scans", () => {
  assert.throws(
    () => session("conditional-keys", { completedKeysetProofCount: 2 }),
    /budget|proof/i,
  );
  const valid = session("nut09-response", {
    completedKeysetProofCount: 2,
    budget: { transportBytes: 0, serializedBytes: 0, workUnits: 0, proofCount: 5 },
    scan: scan({
      nextCounter: 13,
      totalRequestedOutputs: 3,
      totalReturnedProofs: 3,
    }),
    currentBatch: {
      planDigest: HEX_A,
      planStart: 0,
      planCount: 1,
      requestDigest: HEX_B,
      batchDigest: HEX_A,
      stagedBatchId: "batch-2",
      returnedCount: 3,
    },
  });
  assert.equal(valid.budget.proofCount, 5);
});

test("skip and terminal evidence are exact and terminal states have no successors", () => {
  const completed = session("keyset-completed", {
    catalogueOrdinal: 0,
    activeKeysetId: null,
    keysetMetadataDigest: null,
    keysetTerminalEvidence: {
      kind: "gap-limit",
      keysetId: KEYSET_A,
      gapLimit: 2,
      digest: HEX_A,
    },
  });
  const skipped = successor(completed, "keyset-skipped", {
    catalogueOrdinal: 1,
    activeKeysetId: null,
    keysetMetadataDigest: null,
    scan: scan({ startCounter: 0, nextCounter: 0 }),
    keysetTerminalEvidence: null,
    skipEvidence: {
      catalogueOrdinal: 1,
      keysetId: KEYSET_B,
      reason: "freshly-proven-ineligible",
      authorityDigest: HEX_B,
    },
  });
  validateConditionalRecoverySessionSuccessor(completed, skipped);
  const done = successor(skipped, "recovery-completed", {
    terminalEvidence: { kind: "completed", catalogueLength: 2, digest: HEX_A },
    skipEvidence: null,
  });
  validateConditionalRecoverySessionSuccessor(skipped, done);
  assert.throws(
    () => validateConditionalRecoverySessionSuccessor(done, successor(done, "recovery-completed")),
    /terminal|successor/i,
  );
  const failed = session("recovery-failed-closed");
  assert.throws(
    () => validateConditionalRecoverySessionSuccessor(failed, successor(failed, "recovery-completed")),
    /terminal|successor/i,
  );
});

