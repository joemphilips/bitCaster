import assert from "node:assert/strict";
import test from "node:test";
import {
  blindMessage,
  constructUnblindedSignature,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  getPubKeyFromPrivKey,
  hashToCurve,
  pointFromBytes,
} from "@cashu/cashu-ts";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  CONDITIONAL_RECOVERY_MAX_CHECKPOINT_BYTES,
  CONDITIONAL_RECOVERY_MAX_PAGE_BYTES,
  advanceConditionalRecoveryHighWater,
  authorizeConditionalRecoveryAdmission,
  acceptConditionalRecoveryNut09Response as acceptConditionalRecoveryNut09ResponseRaw,
  authorizeConditionalRecoveryNut09Request,
  classifyConditionalRecoveryNut07,
  createConditionalCatalogueProgress,
  completeConditionalRecoveryKeyset,
  completeConditionalRecoverySession,
  createConditionalRecoverySession,
  createConditionalRecoveryWalletScope,
  createSeedDerivedConditionalRecoveryPlan,
  decodeConditionalRecoveryCapability,
  decodeConditionalRecoverySession,
  encodeConditionalCatalogueCheckpoint,
  encodeConditionalRecoverySession,
  finalizeConditionalRecoveryCatalogue,
  issueConditionalRecoveryFreshExpiryEvidence,
  issueConditionalRecoveryAuthorityObservation,
  resumeConditionalCatalogueProgress,
  resumeConditionalRecoverySession,
  rehydrateConditionalRecoverySessionCapabilities,
  retainExpiredConditionalRecoveryKeyset,
  snapshotConditionalCatalogueCheckpoint,
  validateConditionalCataloguePage,
  validateConditionalRecoveryKeys,
  verifyConditionalRecoveryProofs,
  type CompletedConditionalRecoveryCatalogue,
  type ConditionalRecoveryAuthorityObservation,
  type ConditionalRecoveryWalletScope,
  type ValidatedConditionalRecoveryTarget,
} from "../src/emergencyConditionalSeedRecovery.ts";
import { deriveDurableCustodyScopeId } from "../src/durableCustody.ts";

const CONDITION_ID = "11".repeat(32);
const OUTCOME_COLLECTION_ID =
  "51bdecc2e0ef4b3779c4e9f14968f40284f510607974560ee51ff7639d781804";
const PUBLIC_KEY =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const KEYS = { "1": PUBLIC_KEY };
const KEYSET_ID = deriveConditionalKeysetId({
  keys: KEYS,
  unit: "sat",
  final_expiry: 2_000_000_000,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_COLLECTION_ID,
});

function mintInfo(maxPageSize = 2): unknown {
  return {
    nuts: {
      CTF: {
        supported: true,
        conditional_keyset_catalogue: {
          version: 1,
          max_page_size: maxPageSize,
        },
      },
    },
  };
}

function scope(
  unit = "sat",
  mintUrl = "https://mint.example/",
): ConditionalRecoveryWalletScope {
  return createConditionalRecoveryWalletScope({
    scopeId: deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: "22".repeat(32),
    }),
    mintUrl,
    unit,
  });
}

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    id: KEYSET_ID,
    unit: "sat",
    active: false,
    final_expiry: 2_000_000_000,
    condition_id: CONDITION_ID,
    outcome_collection: "YES",
    outcome_collection_id: OUTCOME_COLLECTION_ID,
    registered_at: 1_700_000_000,
    ...overrides,
  };
}

function page(
  keysets: unknown[],
  nextCursor: string | null,
  complete: boolean,
) {
  return {
    keysets,
    ...(nextCursor === null ? {} : { next_cursor: nextCursor }),
    complete,
  };
}

function keysResponse(overrides: Record<string, unknown> = {}) {
  return {
    keysets: [
      {
        id: KEYSET_ID,
        unit: "sat",
        active: false,
        final_expiry: 2_000_000_000,
        keys: KEYS,
        ...overrides,
      },
    ],
  };
}

function progress(walletScope = scope()) {
  return createConditionalCatalogueProgress({
    capability: decodeConditionalRecoveryCapability(mintInfo())!,
    walletScope,
  });
}

function authorityPort(
  time = 1_800_000_000,
  observed: Array<Record<string, unknown>> = [],
) {
  return {
    fetchMintInfo: (walletScope: ConditionalRecoveryWalletScope) => {
      observed.push({ operation: "mint-info", ...walletScope });
      return mintInfo();
    },
    readWallClockMs: () => time * 1_000,
    advanceAndReadHighWater: (input: Record<string, unknown>) => {
      observed.push({ operation: "high-water", ...input });
      return time;
    },
  };
}

async function observation(
  subject: Parameters<
    typeof issueConditionalRecoveryAuthorityObservation
  >[0]["subject"],
  time = 1_800_000_000,
  observed: Array<Record<string, unknown>> = [],
): Promise<ConditionalRecoveryAuthorityObservation> {
  return issueConditionalRecoveryAuthorityObservation({
    subject,
    port: authorityPort(time, observed),
  });
}

async function completedCatalogue(
  walletScope = scope(),
  rawMetadata: Record<string, unknown> = metadata(),
): Promise<CompletedConditionalRecoveryCatalogue> {
  const terminal = validateConditionalCataloguePage({
    requestedCursor: null,
    response: page([rawMetadata], null, true),
    responseBytes: 1_024,
    progress: progress(walletScope),
  });
  return finalizeConditionalRecoveryCatalogue({
    terminalPage: terminal,
    authority: await observation(terminal),
    ordinaryKeysetIds: [],
  });
}

async function targetFor(
  catalogue: CompletedConditionalRecoveryCatalogue,
  startCounter = 0,
): Promise<ValidatedConditionalRecoveryTarget> {
  const ports = linearPorts();
  const session = createConditionalRecoverySession({
    catalogue,
    walletScope: catalogue.walletScope,
    cas: ports.cas,
    startCounter,
  });
  const target = validateConditionalRecoveryKeys({
    catalogue,
    walletScope: catalogue.walletScope,
    keysetId: KEYSET_ID,
    response: keysResponse({
      final_expiry: catalogue.keysets[0]!.finalExpiry,
    }),
    responseBytes: 1_024,
    authority: await observation(catalogue),
    session,
  });
  assert.notEqual(target, null);
  targetPorts.set(target!, ports);
  return target!;
}

const targetPorts = new WeakMap<
  ValidatedConditionalRecoveryTarget,
  ReturnType<typeof linearPorts>
>();

function verifiableProof(secret: string) {
  const privateKey = new Uint8Array(32);
  privateKey[31] = 1;
  const secretBytes = new TextEncoder().encode(secret);
  const r = 7n;
  const blinded = blindMessage(secretBytes, r);
  const dleq = createDLEQProof(blinded.B_, privateKey);
  const blindSignature = createBlindSignature(
    blinded.B_,
    privateKey,
    KEYSET_ID,
  );
  const signature = constructUnblindedSignature(
    blindSignature,
    r,
    secretBytes,
    pointFromBytes(getPubKeyFromPrivKey(privateKey)),
  );
  return {
    id: KEYSET_ID,
    amount: 1,
    secret,
    C: signature.C.toHex(true),
    dleq: {
      e: bytesToHex(dleq.e),
      s: bytesToHex(dleq.s),
      r: r.toString(16).padStart(64, "0"),
    },
  };
}

function restoreFixture(secret: string, counter: number) {
  const privateKey = new Uint8Array(32);
  privateKey[31] = 1;
  const secretBytes = new TextEncoder().encode(secret);
  const r = 7n;
  const blinded = blindMessage(secretBytes, r);
  const dleq = createDLEQProof(blinded.B_, privateKey);
  const blindSignature = createBlindSignature(
    blinded.B_,
    privateKey,
    KEYSET_ID,
  );
  const signature = constructUnblindedSignature(
    blindSignature,
    r,
    secretBytes,
    pointFromBytes(getPubKeyFromPrivKey(privateKey)),
  );
  return {
    counter,
    output: {
      id: KEYSET_ID,
      amount: "0",
      B_: blinded.B_.toHex(true),
    },
    signature: {
      id: KEYSET_ID,
      amount: "1",
      C_: blindSignature.C_.toHex(true),
      dleq: {
        e: bytesToHex(dleq.e),
        s: bytesToHex(dleq.s),
      },
    },
    proof: {
      id: KEYSET_ID,
      amount: 1,
      secret,
      C: signature.C.toHex(true),
      dleq: {
        e: bytesToHex(dleq.e),
        s: bytesToHex(dleq.s),
        r: r.toString(16).padStart(64, "0"),
      },
    },
    unblind: (rawSignature: unknown) => {
      const raw = rawSignature as {
        id: string;
        amount: string;
        C_: string;
        dleq: { e: string; s: string };
      };
      if (
        raw.id !== KEYSET_ID ||
        String(raw.amount) !== "1" ||
        raw.C_ !== blindSignature.C_.toHex(true) ||
        raw.dleq.e !== bytesToHex(dleq.e) ||
        raw.dleq.s !== bytesToHex(dleq.s)
      ) {
        throw new Error("raw signature mismatch");
      }
      return {
        id: KEYSET_ID,
        amount: 1,
        secret,
        C: signature.C.toHex(true),
        dleq: {
          e: bytesToHex(dleq.e),
          s: bytesToHex(dleq.s),
          r: r.toString(16).padStart(64, "0"),
        },
      };
    },
  };
}

function linearPorts() {
  let latest: string | null = null;
  const port = {
    readCurrentDigest: () => latest,
    compareAndSwap: ({
      expectedDigest,
      successor,
    }: {
      expectedDigest: string | null;
      successor: { digest: string };
    }) => {
      if (latest !== expectedDigest) return false;
      latest = successor.digest;
      return true;
    },
    compareAndSwapStageNut09Response: async ({
      expectedSessionDigest,
      successor,
    }: {
      expectedSessionDigest: string;
      successor: { digest: string };
    }) => {
      if (latest !== expectedSessionDigest) return false;
      latest = successor.digest;
      return true;
    },
    compareAndSwapInsertUnique: ({
      expectedSessionDigest,
      successorSession,
      rows,
    }: {
      expectedSessionDigest: string;
      successorSession: { digest: string };
      rows: readonly { proofIdentity: string }[];
    }) => {
      const proofIdentities = rows.map((row) => row.proofIdentity);
      if (
        latest !== expectedSessionDigest ||
        new Set(proofIdentities).size !== proofIdentities.length
      ) {
        return false;
      }
      latest = successorSession.digest;
      return true;
    },
    compareAndSwapRetainExpiredKeyset: async ({
      expectedSessionDigest,
      successor,
    }: {
      expectedSessionDigest: string;
      successor: { digest: string };
    }) => {
      if (latest !== expectedSessionDigest) return false;
      latest = successor.digest;
      return true;
    },
  };
  return { cas: port, admissionPort: port };
}
async function acceptConditionalRecoveryNut09Response(
  input: Omit<
    Parameters<typeof acceptConditionalRecoveryNut09ResponseRaw>[0],
    "responseBody"
  >,
) {
  return acceptConditionalRecoveryNut09ResponseRaw({
    ...input,
    responseBody: new TextEncoder().encode(JSON.stringify(input.response)),
  });
}

test("capability remains exact and ordinary mints are skipped", () => {
  assert.equal(decodeConditionalRecoveryCapability({ nuts: {} }), null);
  assert.equal(
    decodeConditionalRecoveryCapability({
      nuts: { CTF: { supported: false } },
    }),
    null,
  );
  assert.throws(
    () => decodeConditionalRecoveryCapability({ nuts: { ctf: {} } }),
    /exact CTF/i,
  );
  assert.throws(
    () =>
      decodeConditionalRecoveryCapability({
        nuts: { CTF: { supported: true } },
      }),
    /catalogue capability/i,
  );
});

test("live catalogue lineage rejects fabrication, truncation, and no-progress pages", () => {
  const initial = progress();
  assert.throws(
    () =>
      validateConditionalCataloguePage({
        requestedCursor: null,
        response: page([], "next", false),
        responseBytes: 1,
        progress: initial,
      }),
    /no item progress/i,
  );
  assert.throws(
    () =>
      validateConditionalCataloguePage({
        requestedCursor: null,
        response: page([metadata()], null, true),
        responseBytes: 1,
        progress: { ...initial },
      }),
    /live catalogue progress/i,
  );
});

test("only a live terminal page can finalize; persisted terminal flags never can", async () => {
  const first = validateConditionalCataloguePage({
    requestedCursor: null,
    response: page([metadata()], "next", false),
    responseBytes: 1_024,
    progress: progress(),
  });
  const checkpoint = snapshotConditionalCatalogueCheckpoint(first);
  const replayPort = {
    fetchPage: () => ({
      response: page([metadata()], "next", false),
      responseBytes: 1_024,
    }),
  };
  assert.equal(checkpoint.currentCursor, "next");
  await assert.rejects(
    () =>
      resumeConditionalCatalogueProgress(
        JSON.stringify({ ...checkpoint, keysets: [] }),
        replayPort,
      ),
    /replayed transcript/i,
  );
  const resumed = await resumeConditionalCatalogueProgress(
    new TextEncoder().encode(encodeConditionalCatalogueCheckpoint(first)),
    replayPort,
  );
  const terminal = validateConditionalCataloguePage({
    requestedCursor: "next",
    response: page([metadata()], null, true),
    responseBytes: 1_024,
    progress: resumed,
  });
  await assert.rejects(
    () =>
      resumeConditionalCatalogueProgress(
        encodeConditionalCatalogueCheckpoint(terminal),
        replayPort,
      ),
    /terminal checkpoint/i,
  );
  assert.throws(
    () =>
      finalizeConditionalRecoveryCatalogue({
        terminalPage: { ...terminal },
        authority: {} as ConditionalRecoveryAuthorityObservation,
        ordinaryKeysetIds: [],
      }),
    /live terminal page/i,
  );
  const catalogue = finalizeConditionalRecoveryCatalogue({
    terminalPage: terminal,
    authority: await observation(terminal),
    ordinaryKeysetIds: [],
  });
  assert.equal(catalogue.keysets.length, 1);
});

test("persisted catalogue checkpoint rejects oversized raw text before semantic decode", async () => {
  let replayCalls = 0;
  const oversizedMalformedJson = "{".padEnd(
    CONDITIONAL_RECOVERY_MAX_CHECKPOINT_BYTES + 1,
    " ",
  );
  await assert.rejects(
    () =>
      resumeConditionalCatalogueProgress(oversizedMalformedJson, {
        fetchPage: () => {
          replayCalls += 1;
          throw new Error("replay must not run");
        },
      }),
    /raw checkpoint exceeded its encoded byte bound/i,
  );
  assert.equal(replayCalls, 0);
});

test("persisted catalogue checkpoint rejects invalid UTF-8 and truncated bytes before replay", async () => {
  let replayCalls = 0;
  const replayPort = {
    fetchPage: () => {
      replayCalls += 1;
      throw new Error("replay must not run");
    },
  };
  await assert.rejects(
    () =>
      resumeConditionalCatalogueProgress(new Uint8Array([0xff]), replayPort),
    /valid UTF-8/i,
  );
  await assert.rejects(
    () =>
      resumeConditionalCatalogueProgress(
        new TextEncoder().encode('{"schemaVersion":1'),
        replayPort,
      ),
    /JSON is invalid/i,
  );
  assert.equal(replayCalls, 0);
});

test("authority is one-use and atomically binds the exact wallet scope", async () => {
  const walletScope = scope();
  const terminal = validateConditionalCataloguePage({
    requestedCursor: null,
    response: page([metadata()], null, true),
    responseBytes: 1,
    progress: progress(walletScope),
  });
  const observed: Array<Record<string, unknown>> = [];
  const authority = await observation(terminal, 1_800_000_000, observed);
  const catalogue = finalizeConditionalRecoveryCatalogue({
    terminalPage: terminal,
    authority,
    ordinaryKeysetIds: [],
  });
  assert.deepEqual(observed[1], {
    operation: "high-water",
    scopeId: walletScope.scopeId,
    mintUrl: walletScope.mintUrl,
    unit: walletScope.unit,
    observedUnixSeconds: 1_800_000_000,
  });
  assert.throws(
    () =>
      finalizeConditionalRecoveryCatalogue({
        terminalPage: terminal,
        authority,
        ordinaryKeysetIds: [],
      }),
    /already used/i,
  );
  assert.deepEqual(catalogue.walletScope, walletScope);
});

test("authority issuance rejects capability withdrawal, change, and regressed high-water", async () => {
  const terminal = validateConditionalCataloguePage({
    requestedCursor: null,
    response: page([metadata()], null, true),
    responseBytes: 1,
    progress: progress(),
  });
  for (const currentMintInfo of [
    { nuts: { CTF: { supported: false } } },
    mintInfo(3),
  ]) {
    await assert.rejects(
      () =>
        issueConditionalRecoveryAuthorityObservation({
          subject: terminal,
          port: {
            ...authorityPort(),
            fetchMintInfo: () => currentMintInfo,
          },
        }),
      /changed|withdrawn/i,
    );
  }
  await assert.rejects(
    () =>
      issueConditionalRecoveryAuthorityObservation({
        subject: terminal,
        port: {
          ...authorityPort(),
          advanceAndReadHighWater: () => 1_799_999_999,
        },
      }),
    /regressed/i,
  );
});

test("authority is subject-bound and remains consumed after downstream validation failure", async () => {
  const first = validateConditionalCataloguePage({
    requestedCursor: null,
    response: page([metadata()], null, true),
    responseBytes: 1,
    progress: progress(),
  });
  const second = validateConditionalCataloguePage({
    requestedCursor: null,
    response: page([metadata()], null, true),
    responseBytes: 1,
    progress: progress(),
  });
  const foreignAuthority = await observation(first);
  assert.throws(
    () =>
      finalizeConditionalRecoveryCatalogue({
        terminalPage: second,
        authority: foreignAuthority,
        ordinaryKeysetIds: [],
      }),
    /foreign/i,
  );

  const catalogue = finalizeConditionalRecoveryCatalogue({
    terminalPage: first,
    authority: foreignAuthority,
    ordinaryKeysetIds: [],
  });
  const ports = linearPorts();
  const session = createConditionalRecoverySession({
    catalogue,
    walletScope: catalogue.walletScope,
    cas: ports.cas,
  });
  const keyAuthority = await observation(catalogue);
  assert.throws(
    () =>
      validateConditionalRecoveryKeys({
        catalogue,
        walletScope: catalogue.walletScope,
        keysetId: KEYSET_ID,
        response: { keysets: [] },
        responseBytes: 1,
        authority: keyAuthority,
        session,
      }),
    /exactly one keyset/i,
  );
  assert.throws(
    () =>
      validateConditionalRecoveryKeys({
        catalogue,
        walletScope: catalogue.walletScope,
        keysetId: KEYSET_ID,
        response: keysResponse(),
        responseBytes: 1,
        authority: keyAuthority,
        session,
      }),
    /already used/i,
  );
});

test("expired conditional keysets never become recovery targets", async () => {
  const finalExpiry = 1_700_000_000;
  const expiredId = deriveConditionalKeysetId({
    keys: KEYS,
    unit: "sat",
    final_expiry: finalExpiry,
    conditionId: CONDITION_ID,
    outcomeCollectionId: OUTCOME_COLLECTION_ID,
  });
  const catalogue = await completedCatalogue(
    scope(),
    metadata({ id: expiredId, final_expiry: finalExpiry }),
  );
  const session = createConditionalRecoverySession({
    catalogue,
    walletScope: catalogue.walletScope,
    cas: linearPorts().cas,
  });
  assert.equal(
    validateConditionalRecoveryKeys({
      catalogue,
      walletScope: catalogue.walletScope,
      keysetId: expiredId,
      response: keysResponse({ id: expiredId, final_expiry: finalExpiry }),
      responseBytes: 1,
      authority: await observation(catalogue),
      session,
    }),
    null,
  );
});

test("off-unit catalogue metadata is retained but cannot become a target", async () => {
  const usdId = deriveConditionalKeysetId({
    keys: KEYS,
    unit: "usd",
    final_expiry: 2_000_000_000,
    conditionId: CONDITION_ID,
    outcomeCollectionId: OUTCOME_COLLECTION_ID,
  });
  const catalogue = await completedCatalogue(
    scope(),
    metadata({ id: usdId, unit: "usd" }),
  );
  assert.equal(catalogue.keysets[0]!.unit, "usd");
  const keyAuthority = await observation(catalogue);
  const session = createConditionalRecoverySession({
    catalogue,
    walletScope: catalogue.walletScope,
    cas: linearPorts().cas,
  });
  assert.throws(
    () =>
      validateConditionalRecoveryKeys({
        catalogue,
        walletScope: catalogue.walletScope,
        keysetId: usdId,
        response: keysResponse({ id: usdId, unit: "usd" }),
        responseBytes: 1,
        authority: keyAuthority,
        session,
      }),
    /foreign wallet unit/i,
  );
});

test("key authority is fresh and one-use, and cross-mint scope substitution fails", async () => {
  const catalogue = await completedCatalogue();
  const authority = await observation(catalogue);
  const ports = linearPorts();
  const input = {
    catalogue,
    walletScope: catalogue.walletScope,
    keysetId: KEYSET_ID,
    response: keysResponse(),
    responseBytes: 1,
    authority,
    session: createConditionalRecoverySession({
      catalogue,
      walletScope: catalogue.walletScope,
      cas: ports.cas,
    }),
  };
  assert.notEqual(validateConditionalRecoveryKeys(input), null);
  assert.throws(() => validateConditionalRecoveryKeys(input), /already used/i);
  const foreignAuthority = await observation(catalogue);
  assert.throws(
    () =>
      validateConditionalRecoveryKeys({
        ...input,
        walletScope: scope("sat", "https://other.example"),
        authority: foreignAuthority,
      }),
    /foreign/i,
  );
});

async function proofHarness(
  rawMetadata: Record<string, unknown> = metadata(),
  finishProofChecks = true,
) {
  const catalogue = await completedCatalogue(scope(), rawMetadata);
  const target = await targetFor(catalogue, 40);
  const fixtures = [
    restoreFixture("secret-one", 40),
    restoreFixture("secret-two", 41),
    restoreFixture("secret-three", 42),
  ];
  const derivedOutputs = fixtures.map((fixture) => ({
    counter: fixture.counter,
    ...fixture.output,
    Y: hashToCurve(new TextEncoder().encode(fixture.proof.secret)).toHex(true),
    unblind: fixture.unblind,
  }));
  const plan = await createSeedDerivedConditionalRecoveryPlan({
    catalogue,
    target,
    walletScope: catalogue.walletScope,
    startCounter: 40,
    count: derivedOutputs.length,
    derivationPort: { deriveSeedOutputs: () => derivedOutputs },
    session: target.session,
  });
  const ports = targetPorts.get(target)!;
  const request = authorizeConditionalRecoveryNut09Request({
    catalogue,
    target,
    plan,
    walletScope: catalogue.walletScope,
    authority: await observation(catalogue),
  });
  const staleAuthority = await observation(catalogue);
  assert.throws(
    () =>
      authorizeConditionalRecoveryNut09Request({
        catalogue,
        target,
        plan,
        walletScope: catalogue.walletScope,
        authority: staleAuthority,
      }),
    /stale|consumed/i,
  );
  const charged = await acceptConditionalRecoveryNut09Response({
    request,
    response: {
      outputs: fixtures.map((fixture) => fixture.output),
      signatures: fixtures.map((fixture) => fixture.signature),
    },
    responseBytes: 2_048,
    authority: await observation(catalogue),
  });
  const proofs = charged.proofs as ReturnType<typeof verifiableProof>[];
  const stateCorpus = ["UNSPENT", "PENDING", "SPENT"] as const;
  const states = proofs.map((proof, index) => ({
    Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
    state: stateCorpus[index]!,
    witness: null,
  }));
  if (!finishProofChecks) {
    return {
      catalogue,
      target,
      proofs,
      charged,
      states,
      admissionPort: ports.admissionPort,
    };
  }
  const verified = verifyConditionalRecoveryProofs({
    catalogue,
    target,
    walletScope: catalogue.walletScope,
    proofBatch: charged,
    authority: await observation(catalogue),
  });
  const nut07 = classifyConditionalRecoveryNut07({
    catalogue,
    target,
    walletScope: catalogue.walletScope,
    proofBatch: charged,
    response: { states: states.reverse() },
    responseBytes: 1_024,
  });
  return {
    catalogue,
    target,
    proofs,
    charged,
    verified,
    nut07,
    admissionPort: ports.admissionPort,
  };
}

test("shared mint-state dispositions drive every conditional admission bucket", async () => {
  const harness = await proofHarness();
  const result = authorizeConditionalRecoveryAdmission({
    ...harness,
    verifiedProofs: harness.verified,
    walletScope: harness.catalogue.walletScope,
    authority: await observation(harness.catalogue),
  });
  assert.equal(result.selectableProofs[0]!.secret, "secret-one");
  assert.equal(result.pendingProofs[0]!.secret, "secret-two");
  assert.equal(result.spentProofs[0]!.secret, "secret-three");
  assert.equal(result.selectableProofs.length, 1);
  assert.equal(result.pendingProofs.length, 1);
  assert.equal(result.spentProofs.length, 1);
  assert.equal(Object.isFrozen(result.selectableProofs[0]!), true);
  assert.equal("selectableProofIndexes" in result, false);
  assert.equal(result.session.transition, "atomic-admission");
  const continuationFixture = restoreFixture(
    "post-admission-continuation",
    result.session.scan.nextCounter,
  );
  const continuation = await createSeedDerivedConditionalRecoveryPlan({
    catalogue: harness.catalogue,
    target: harness.target,
    walletScope: harness.catalogue.walletScope,
    startCounter: result.session.scan.nextCounter,
    count: 1,
    derivationPort: {
      deriveSeedOutputs: () => [
        {
          counter: result.session.scan.nextCounter,
          ...continuationFixture.output,
          Y: hashToCurve(
            new TextEncoder().encode(continuationFixture.proof.secret),
          ).toHex(true),
          unblind: continuationFixture.unblind,
        },
      ],
    },
    session: result.session,
  });
  assert.equal(continuation.session.transition, "nut13-plan");
  const replayAuthority = await observation(harness.catalogue);
  assert.throws(
    () =>
      authorizeConditionalRecoveryAdmission({
        ...harness,
        verifiedProofs: harness.verified,
        walletScope: harness.catalogue.walletScope,
        authority: replayAuthority,
      }),
    /already consumed/i,
  );
});
test("fresh SDK expiry evidence selects the distinct locked retention CAS", async () => {
  const harness = await proofHarness(metadata(), false);
  const expiryAuthority = issueConditionalRecoveryFreshExpiryEvidence({
    catalogue: harness.catalogue,
    target: harness.target,
    authority: await observation(harness.catalogue, 2_000_000_000),
  });
  const verified = verifyConditionalRecoveryProofs({
    catalogue: harness.catalogue,
    target: harness.target,
    walletScope: harness.catalogue.walletScope,
    proofBatch: harness.charged,
    authority: await observation(harness.catalogue, 2_000_000_000),
    expiryEvidence: expiryAuthority,
  });
  const nut07 = classifyConditionalRecoveryNut07({
    catalogue: harness.catalogue,
    target: harness.target,
    walletScope: harness.catalogue.walletScope,
    proofBatch: harness.charged,
    response: { states: [...harness.states].reverse() },
    responseBytes: 1_024,
  });
  const ports = targetPorts.get(harness.target)!;
  const successor = await retainExpiredConditionalRecoveryKeyset({
    catalogue: harness.catalogue,
    target: harness.target,
    verifiedProofs: verified,
    nut07,
    walletScope: harness.catalogue.walletScope,
    proofs: harness.proofs,
    expiryAuthority,
    sessionPort: ports.cas,
  });
  assert.equal(successor.transition, "expired-keyset-retention");
  assert.equal(successor.currentBatch?.stagedBatchId, harness.charged.stagedBatchId);
  const completedKeyset = completeConditionalRecoveryKeyset({
    session: successor,
    sessionPort: ports.cas,
    evidenceDigest: "ef".repeat(32),
  });
  assert.equal(completedKeyset.transition, "keyset-completed");
  const completedRecovery = completeConditionalRecoverySession({
    session: completedKeyset,
    sessionPort: ports.cas,
    catalogueLength: 1,
    evidenceDigest: "fe".repeat(32),
  });
  assert.equal(completedRecovery.transition, "recovery-completed");
  assert.throws(
    () =>
      authorizeConditionalRecoveryAdmission({
        ...harness,
        walletScope: harness.catalogue.walletScope,
        authority: {} as ConditionalRecoveryAuthorityObservation,
        admissionPort: ports.admissionPort,
      }),
    /consumed|stale|invalid|foreign/i,
  );
});


test("conditional recovery keeps UNKNOWN mint state fail closed", async () => {
  const harness = await proofHarness();
  const states = harness.proofs.map((proof, index) => ({
    Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
    state: index === 0 ? "UNKNOWN" : "UNSPENT",
    witness: null,
  }));
  assert.throws(
    () =>
      classifyConditionalRecoveryNut07({
        catalogue: harness.catalogue,
        target: harness.target,
        walletScope: harness.catalogue.walletScope,
        proofBatch: harness.charged,
        response: { states },
        responseBytes: 1,
      }),
    /state is unknown/i,
  );
});

for (const [name, mutate] of [
  [
    "amount",
    (proofs: ReturnType<typeof verifiableProof>[]) => (proofs[0]!.amount = 2),
  ],
  [
    "C",
    (proofs: ReturnType<typeof verifiableProof>[]) =>
      (proofs[0]!.C = proofs[1]!.C),
  ],
  [
    "DLEQ",
    (proofs: ReturnType<typeof verifiableProof>[]) =>
      (proofs[0]!.dleq.e = "00".repeat(32)),
  ],
] as const) {
  test(
    "admission rejects post-verification " + name + " mutation",
    async () => {
      const harness = await proofHarness();
      mutate(harness.proofs);
      const authority = await observation(harness.catalogue);
      assert.throws(
        () =>
          authorizeConditionalRecoveryAdmission({
            ...harness,
            verifiedProofs: harness.verified,
            walletScope: harness.catalogue.walletScope,
            authority,
          }),
        /proof/i,
      );
    },
  );
}

test("admission rejects proof order, array, and object replacement", async () => {
  for (const replacement of ["order", "array", "object"] as const) {
    const harness = await proofHarness();
    let proofs = harness.proofs;
    if (replacement === "order") proofs = [...proofs].reverse();
    if (replacement === "array") proofs = [...proofs];
    if (replacement === "object") {
      proofs = [...proofs];
      proofs[0] = { ...proofs[0]! };
    }
    const authority = await observation(harness.catalogue);
    assert.throws(
      () =>
        authorizeConditionalRecoveryAdmission({
          ...harness,
          proofs,
          verifiedProofs: harness.verified,
          walletScope: harness.catalogue.walletScope,
          authority,
        }),
      /replaced|proof batch changed/i,
    );
  }
});

test("NUT-09 charges canonical proof bytes and exact transport cumulatively", async () => {
  const catalogue = await completedCatalogue();
  const target = await targetFor(catalogue, 90);
  const fixture = restoreFixture("budget-proof", 90);
  const budgetOutput = {
    counter: fixture.counter,
    ...fixture.output,
    Y: hashToCurve(new TextEncoder().encode(fixture.proof.secret)).toHex(true),
    unblind: fixture.unblind,
  };
  const plan = await createSeedDerivedConditionalRecoveryPlan({
    catalogue,
    target,
    walletScope: catalogue.walletScope,
    startCounter: fixture.counter,
    count: 1,
    derivationPort: { deriveSeedOutputs: () => [budgetOutput] },
    session: target.session,
  });
  const request = authorizeConditionalRecoveryNut09Request({
    catalogue,
    target,
    plan,
    walletScope: catalogue.walletScope,
    authority: await observation(catalogue),
  });
  const charged = await acceptConditionalRecoveryNut09Response({
    request,
    response: { outputs: [fixture.output], signatures: [fixture.signature] },
    responseBytes: 7_777,
    authority: await observation(catalogue),
  });
  assert.equal(
    charged.budget.transportBytes - target.budget.transportBytes,
    7_777,
  );
  assert.ok(charged.budget.serializedBytes > target.budget.serializedBytes);
  assert.equal(charged.budget.proofCount - target.budget.proofCount, 1);
});

test("zero-hit windows consume the same cumulative session transport budget", async () => {
  const catalogue = await completedCatalogue();
  const target = await targetFor(catalogue);
  let session = target.session;
  for (let counter = 0; counter < 4; counter += 1) {
    const fixture = restoreFixture(`empty-budget-${counter}`, counter);
    const plan = await createSeedDerivedConditionalRecoveryPlan({
      catalogue,
      target,
      walletScope: catalogue.walletScope,
      startCounter: counter,
      count: 1,
      derivationPort: {
        deriveSeedOutputs: () => [
          {
            counter,
            ...fixture.output,
            Y: hashToCurve(
              new TextEncoder().encode(fixture.proof.secret),
            ).toHex(true),
            unblind: fixture.unblind,
          },
        ],
      },
      session,
    });
    const request = authorizeConditionalRecoveryNut09Request({
      catalogue,
      target,
      plan,
      walletScope: catalogue.walletScope,
      authority: await observation(catalogue),
    });
    const responseAuthority = await observation(catalogue);
    if (counter === 3) {
      await assert.rejects(
        () =>
          acceptConditionalRecoveryNut09Response({
            request,
            response: { outputs: [], signatures: [] },
            responseBytes: CONDITIONAL_RECOVERY_MAX_PAGE_BYTES,
            authority: responseAuthority,
          }),
        /transport byte bound/i,
      );
      break;
    }
    const batch = await acceptConditionalRecoveryNut09Response({
      request,
      response: { outputs: [], signatures: [] },
      responseBytes: CONDITIONAL_RECOVERY_MAX_PAGE_BYTES,
      authority: responseAuthority,
    });
    assert.equal(batch.proofCount, 0);
    session = batch.session;
  }
});

test("two-batch scan advances across empty windows and resets the trailing gap on a hit", async () => {
  const catalogue = await completedCatalogue();
  const target = await targetFor(catalogue, 10);
  const fixtures = [10, 11, 12, 13].map((counter) =>
    restoreFixture(`scan-${counter}`, counter),
  );
  const rows = fixtures.map((fixture) => ({
    counter: fixture.counter,
    ...fixture.output,
    Y: hashToCurve(new TextEncoder().encode(fixture.proof.secret)).toHex(true),
    unblind: fixture.unblind,
  }));
  const firstPlan = await createSeedDerivedConditionalRecoveryPlan({
    catalogue,
    target,
    walletScope: catalogue.walletScope,
    startCounter: 10,
    count: 2,
    derivationPort: { deriveSeedOutputs: () => rows.slice(0, 2) },
    session: target.session,
  });
  const firstRequest = authorizeConditionalRecoveryNut09Request({
    catalogue,
    target,
    plan: firstPlan,
    walletScope: catalogue.walletScope,
    authority: await observation(catalogue),
  });
  const firstBatch = await acceptConditionalRecoveryNut09Response({
    request: firstRequest,
    response: { outputs: [], signatures: [] },
    responseBytes: 32,
    authority: await observation(catalogue),
  });
  assert.equal(firstBatch.proofCount, 0);
  assert.deepEqual(firstBatch.session.scan, {
    startCounter: 10,
    nextCounter: 12,
    plannedStart: null,
    plannedCount: 0,
    totalRequestedOutputs: 2,
    totalReturnedProofs: 0,
    consecutiveEmptyOutputs: 2,
  });
  assert.ok(
    firstBatch.session.budget.workUnits > firstRequest.session.budget.workUnits,
  );

  const secondPlan = await createSeedDerivedConditionalRecoveryPlan({
    catalogue,
    target,
    walletScope: catalogue.walletScope,
    startCounter: 12,
    count: 2,
    derivationPort: { deriveSeedOutputs: () => rows.slice(2) },
    session: firstBatch.session,
  });
  const secondRequest = authorizeConditionalRecoveryNut09Request({
    catalogue,
    target,
    plan: secondPlan,
    walletScope: catalogue.walletScope,
    authority: await observation(catalogue),
  });
  const secondBatch = await acceptConditionalRecoveryNut09Response({
    request: secondRequest,
    response: {
      outputs: [fixtures[2]!.output],
      signatures: [fixtures[2]!.signature],
    },
    responseBytes: 64,
    authority: await observation(catalogue),
  });
  assert.equal(secondBatch.proofCount, 1);
  assert.deepEqual(secondBatch.session.scan, {
    startCounter: 10,
    nextCounter: 14,
    plannedStart: null,
    plannedCount: 0,
    totalRequestedOutputs: 4,
    totalReturnedProofs: 1,
    consecutiveEmptyOutputs: 1,
  });
  assert.ok(
    secondBatch.session.budget.transportBytes >
      firstBatch.session.budget.transportBytes,
  );
  const encoded = encodeConditionalRecoverySession(
    secondBatch.session,
    catalogue.walletScope,
  );
  const decoded = decodeConditionalRecoverySession(
    encoded,
    catalogue.walletScope,
  );
  const resumed = rehydrateConditionalRecoverySessionCapabilities(
    decoded,
    { predecessor: secondRequest.session },
    targetPorts.get(target)!.cas,
  ).session;
  assert.deepEqual(resumed.budget, secondBatch.session.budget);
  assert.deepEqual(resumed.scan, secondBatch.session.scan);
  assert.throws(
    () => resumeConditionalRecoverySession(),
    /unsupported|decode and rehydrate/i,
  );
  const tampered = new Uint8Array(encoded);
  tampered[tampered.length - 2] ^= 1;
  assert.throws(
    () => decodeConditionalRecoverySession(tampered, catalogue.walletScope),
    /digest|JSON|canonical/i,
  );
});

test("NUT-13/NUT-09 reject oversized plans, foreign outputs, and request replay", async () => {
  const catalogue = await completedCatalogue();
  const target = await targetFor(catalogue, 120);
  const fixture = restoreFixture("bound-proof", 120);
  const planRow = {
    counter: fixture.counter,
    ...fixture.output,
    Y: hashToCurve(new TextEncoder().encode(fixture.proof.secret)).toHex(true),
    unblind: fixture.unblind,
  };
  await assert.rejects(
    () =>
      createSeedDerivedConditionalRecoveryPlan({
        catalogue,
        target,
        walletScope: catalogue.walletScope,
        startCounter: 0,
        count: 101,
        session: target.session,
        derivationPort: {
          deriveSeedOutputs: () =>
            Array.from({ length: 101 }, (_, index) => ({
              ...planRow,
              counter: index,
            })),
        },
      }),
    /plan size/i,
  );
  const plan = await createSeedDerivedConditionalRecoveryPlan({
    catalogue,
    target,
    walletScope: catalogue.walletScope,
    startCounter: fixture.counter,
    count: 1,
    derivationPort: { deriveSeedOutputs: () => [planRow] },
    session: target.session,
  });
  const request = authorizeConditionalRecoveryNut09Request({
    catalogue,
    target,
    plan,
    walletScope: catalogue.walletScope,
    authority: await observation(catalogue),
  });
  request.requestBytes[0] ^= 1;
  const replayAuthority = await observation(catalogue);
  await assert.rejects(
    () =>
      acceptConditionalRecoveryNut09Response({
        request,
        response: { outputs: [], signatures: [] },
        responseBytes: 1,
        authority: replayAuthority,
      }),
    /dispatched request bytes changed/i,
  );
  request.requestBytes[0] ^= 1;
  const foreign = restoreFixture("foreign-output", 121);
  const foreignAuthority = await observation(catalogue);
  await assert.rejects(
    () =>
      acceptConditionalRecoveryNut09Response({
        request,
        response: {
          outputs: [foreign.output],
          signatures: [foreign.signature],
        },
        responseBytes: 1,
        authority: foreignAuthority,
      }),
    /uniquely requested/i,
  );
  const accepted = await acceptConditionalRecoveryNut09Response({
    request,
    response: {
      outputs: [fixture.output],
      signatures: [fixture.signature],
    },
    responseBytes: 1,
    authority: await observation(catalogue),
  });
  assert.equal(accepted.proofCount, 1);
  await assert.rejects(
    () =>
      acceptConditionalRecoveryNut09Response({
        request,
        response: {
          outputs: [fixture.output],
          signatures: [fixture.signature],
        },
        responseBytes: 1,
        authority: {} as ConditionalRecoveryAuthorityObservation,
      }),
    /already used/i,
  );
});

for (const [field, mutateSignature] of [
  [
    "amount",
    (signature: ReturnType<typeof restoreFixture>["signature"]) => ({
      ...signature,
      amount: "2",
    }),
  ],
  [
    "C_",
    (signature: ReturnType<typeof restoreFixture>["signature"]) => ({
      ...signature,
      C_: PUBLIC_KEY,
    }),
  ],
  [
    "DLEQ",
    (signature: ReturnType<typeof restoreFixture>["signature"]) => ({
      ...signature,
      dleq: { ...signature.dleq, e: "00".repeat(32) },
    }),
  ],
] as const) {
  test(`NUT-09 rejects a prior proof against a different raw ${field}`, async () => {
    const catalogue = await completedCatalogue();
    const target = await targetFor(catalogue, 130);
    const fixture = restoreFixture("raw-signature-binding", 130);
    const plan = await createSeedDerivedConditionalRecoveryPlan({
      catalogue,
      target,
      walletScope: catalogue.walletScope,
      startCounter: fixture.counter,
      count: 1,
      derivationPort: {
        deriveSeedOutputs: () => [
          {
            counter: fixture.counter,
            ...fixture.output,
            Y: hashToCurve(
              new TextEncoder().encode(fixture.proof.secret),
            ).toHex(true),
            unblind: fixture.unblind,
          },
        ],
      },
      session: target.session,
    });
    const request = authorizeConditionalRecoveryNut09Request({
      catalogue,
      target,
      plan,
      walletScope: catalogue.walletScope,
      authority: await observation(catalogue),
    });
    const responseAuthority = await observation(catalogue);
    await assert.rejects(
      () =>
        acceptConditionalRecoveryNut09Response({
          request,
          response: {
            outputs: [fixture.output],
            signatures: [mutateSignature(fixture.signature)],
          },
          responseBytes: 1,
          authority: responseAuthority,
        }),
      /signature|unblind|proof/i,
    );
  });
}

test("atomic admission fails closed when session CAS or global uniqueness refuses", async () => {
  const harness = await proofHarness();
  const authority = await observation(harness.catalogue);
  assert.throws(
    () =>
      authorizeConditionalRecoveryAdmission({
        ...harness,
        verifiedProofs: harness.verified,
        walletScope: harness.catalogue.walletScope,
        authority,
        admissionPort: { compareAndSwapInsertUnique: () => false },
      }),
    /session CAS adapter|atomic admission/i,
  );
});

test("v3/BLS keyset ids remain excluded and high-water is monotonic", () => {
  assert.throws(
    () =>
      validateConditionalCataloguePage({
        requestedCursor: null,
        response: page([metadata({ id: "02" + "00".repeat(32) })], null, true),
        responseBytes: 1,
        progress: progress(),
      }),
    /v2 secp/i,
  );
  assert.equal(advanceConditionalRecoveryHighWater(200, 100_000), 200);
  assert.equal(advanceConditionalRecoveryHighWater(100, 200_999), 200);
});
