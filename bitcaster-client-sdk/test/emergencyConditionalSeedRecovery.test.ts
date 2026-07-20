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
  fetchConditionalRecoveryNut07CommitAuthority as fetchConditionalRecoveryNut07CommitAuthorityRaw,
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
  failConditionalRecoverySessionClosed,
  issueConditionalRecoveryFreshExpiryEvidence,
  issueConditionalRecoveryAuthorityObservation,
  resumeConditionalCatalogueProgress,
  resumeConditionalRecoverySession,
  rehydrateConditionalRecoverySessionCapabilities,
  skipFreshlyIneligibleConditionalRecoveryKeyset,
  skipExpiredConditionalRecoveryKeyset,
  retainExpiredConditionalRecoveryKeyset,
  snapshotConditionalCatalogueCheckpoint,
  validateConditionalCataloguePage,
  validateConditionalRecoveryKeys,
  verifyConditionalRecoveryProofs,
  type CanonicalConditionalRecoveryProof,
  type CompletedConditionalRecoveryCatalogue,
  type ConditionalRecoveryAuthorityObservation,
  type ConditionalRecoverySessionCasPort,
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
  walletId = "22".repeat(32),
): ConditionalRecoveryWalletScope {
  return createConditionalRecoveryWalletScope({
    scopeId: deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId,
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
  targetInitialSessions.set(session.walletScope.scopeId + ":" + startCounter, session);
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

const targetInitialSessions = new Map<string, ConditionalRecoverySession>();

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
  let stagedRows: readonly CanonicalConditionalRecoveryProof[] = [];
  let stagedSession: ConditionalRecoverySession | null = null;
  let stagedRequestBytes = new Uint8Array();
  let stagedResponseBytes = new Uint8Array();
  let throwAfterRequestStageCommit = false;
  let throwAfterResponseStageCommit = false;
  let rejectNextRequestStage = false;
  let rejectNextResponseStage = false;
  let genericCasCount = 0;
  const port = {
    readCurrentDigest: () => latest,
    compareAndSwap: ({
      expectedDigest,
      successor,
    }: {
      expectedDigest: string | null;
      successor: { digest: string };
    }) => {
      genericCasCount += 1;
      if (latest !== expectedDigest) return false;
      latest = successor.digest;
      return true;
    },
    compareAndSwapStageNut09Request: async ({
      expectedDigest,
      successor,
      requestBytes,
    }: {
      expectedDigest: string;
      successor: ConditionalRecoverySession;
      requestBytes: Uint8Array;
    }) => {
      if (rejectNextRequestStage) {
        rejectNextRequestStage = false;
        return false;
      }
      if (latest !== expectedDigest) return false;
      stagedRequestBytes = new Uint8Array(requestBytes);
      stagedSession = successor;
      latest = successor.digest;
      if (throwAfterRequestStageCommit) {
        throwAfterRequestStageCommit = false;
        throw new Error("simulated crash after request stage commit");
      }
      return true;
    },
    compareAndSwapStageNut09Response: async ({
      expectedSessionDigest,
      successor,
      responseBytes,
      rows,
    }: {
      expectedSessionDigest: string;
      successor: ConditionalRecoverySession;
      responseBytes: Uint8Array;
      rows: readonly CanonicalConditionalRecoveryProof[];
    }) => {
      if (rejectNextResponseStage) {
        rejectNextResponseStage = false;
        return false;
      }
      if (latest !== expectedSessionDigest) return false;
      stagedResponseBytes = new Uint8Array(responseBytes);
      stagedRows = rows;
      stagedSession = successor;
      latest = successor.digest;
      if (throwAfterResponseStageCommit) {
        throwAfterResponseStageCommit = false;
        throw new Error("simulated crash after response stage commit");
      }
      return true;
    },
    compareAndSwapInsertUnique: ({
      expectedSessionDigest,
      successorSession,
      rows,
      nut07Authority,
    }: {
      expectedSessionDigest: string;
      successorSession: { digest: string };
      rows: readonly { proofIdentity: string }[];
      nut07Authority: { consumeForCommit: () => unknown };
    }) => {
      const proofIdentities = rows.map((row) => row.proofIdentity);
      if (
        latest !== expectedSessionDigest ||
        new Set(proofIdentities).size !== proofIdentities.length
      ) {
        return false;
      }
      nut07Authority.consumeForCommit();
      latest = successorSession.digest;
      return true;
    },
    compareAndSwapRetainExpiredKeyset: ({
      expectedSessionDigest,
      successorSession,
      nut07Authority,
    }: {
      expectedSessionDigest: string;
      successorSession: { digest: string };
      nut07Authority: { consumeForCommit: () => unknown };
    }) => {
      if (latest !== expectedSessionDigest) return false;
      nut07Authority.consumeForCommit();
      latest = successorSession.digest;
      return true;
    },
  };
  return {
    cas: port,
    admissionPort: port,
    readStagedRows: () => stagedRows,
    readStagedSession: () => stagedSession,
    readStagedRequestBytes: () => new Uint8Array(stagedRequestBytes),
    readGenericCasCount: () => genericCasCount,
    readStagedResponseBytes: () => new Uint8Array(stagedResponseBytes),
    throwAfterNextRequestStageCommit: () => {
      throwAfterRequestStageCommit = true;
    },
    throwAfterNextResponseStageCommit: () => {
      throwAfterResponseStageCommit = true;
    },
    rejectNextRequestStage: () => {
      rejectNextRequestStage = true;
    },
    rejectNextResponseStage: () => {
      rejectNextResponseStage = true;
    },
  };
}
async function acceptConditionalRecoveryNut09Response(input: {
  request: Parameters<
    typeof acceptConditionalRecoveryNut09ResponseRaw
  >[0]["request"];
  response: unknown;
  responseBytes?: number;
  authority: ConditionalRecoveryAuthorityObservation;
}) {
  const semantic = new TextEncoder().encode(JSON.stringify(input.response));
  const entityBytes = Math.max(semantic.byteLength, input.responseBytes ?? 0);
  const entity = new Uint8Array(entityBytes);
  entity.fill(0x20);
  entity.set(semantic);
  return acceptConditionalRecoveryNut09ResponseRaw({
    request: input.request,
    authority: input.authority,
    transport: {
      fetchNut09Entity: async ({ maxEntityBytes }) => {
        if (entity.byteLength > maxEntityBytes) {
          throw new Error("test NUT-09 stream exceeded transport byte bound");
        }
        return entity;
      },
    },
  });
}

async function classifyConditionalRecoveryNut07(input: {
  catalogue: CompletedConditionalRecoveryCatalogue;
  target: ValidatedConditionalRecoveryTarget;
  walletScope: ConditionalRecoveryWalletScope;
  proofBatch: Parameters<
    typeof fetchConditionalRecoveryNut07CommitAuthorityRaw
  >[0]["proofBatch"];
  response: unknown;
  responseBytes?: number;
}) {
  const semantic = new TextEncoder().encode(JSON.stringify(input.response));
  const entityBytes = Math.max(semantic.byteLength, input.responseBytes ?? 0);
  const entity = new Uint8Array(entityBytes);
  entity.fill(0x20);
  entity.set(semantic);
  return fetchConditionalRecoveryNut07CommitAuthorityRaw({
    catalogue: input.catalogue,
    target: input.target,
    walletScope: input.walletScope,
    proofBatch: input.proofBatch,
    transport: {
      fetchNut07Entity: async ({ maxEntityBytes }) => {
        if (entity.byteLength > maxEntityBytes) {
          throw new Error("test NUT-07 stream exceeded entity bound");
        }
        return entity;
      },
    },
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

test("direct-current rehydration binds the supplied port without caller lineage", async () => {
  const catalogue = await completedCatalogue();
  const selected = await targetFor(catalogue, 40);
  const encoded = encodeConditionalRecoverySession(
    selected.session,
    catalogue.walletScope,
  );
  const reopened = decodeConditionalRecoverySession(
    encoded,
    catalogue.walletScope,
  );
  let current = reopened.digest;
  const reopenedPort: ConditionalRecoverySessionCasPort = {
    readCurrentDigest: () => current,
    compareAndSwap: ({ expectedDigest, successor }) => {
      if (current !== expectedDigest) return false;
      current = successor.digest;
      return true;
    },
    compareAndSwapStageNut09Request: async () => false,
    compareAndSwapStageNut09Response: async () => false,
    compareAndSwapRetainExpiredKeyset: () => false,
    compareAndSwapInsertUnique: () => false,
  };
  const malformedStageEvidence = [
    { stage: "completed-catalogue", catalogue, unexpected: true },
    { stage: "conditional-keys", catalogue },
    {
      stage: "nut13-plan",
      catalogue,
      keysResponse: keysResponse(),
    },
    {
      stage: "nut09-request",
      catalogue,
      keysResponse: keysResponse(),
      derivationPort: { deriveSeedOutputs: () => [] },
    },
    {
      stage: "nut09-response",
      catalogue,
      keysResponse: keysResponse(),
      derivationPort: { deriveSeedOutputs: () => [] },
      requestBytes: new Uint8Array(),
      responseBytes: new Uint8Array(),
    },
  ];
  for (const malformed of malformedStageEvidence) {
    await assert.rejects(
      Reflect.apply(rehydrateConditionalRecoverySessionCapabilities, undefined, [
        reopened,
        malformed,
        reopenedPort,
      ]),
      /field/i,
    );
  }
  const capabilities =
    await rehydrateConditionalRecoverySessionCapabilities(
      reopened,
      {
        stage: "conditional-keys",
        catalogue,
        keysResponse: keysResponse(),
      },
      reopenedPort,
    );
  assert.equal(capabilities.session, reopened);
  assert.equal(capabilities.target?.metadata.id, KEYSET_ID);
  assert.equal(capabilities.plan, null);
  assert.equal(capabilities.request, null);
  assert.equal(capabilities.proofBatch, null);
  assert.equal(capabilities.verifiedProofs, null);
  const foreignPort: ConditionalRecoverySessionCasPort = {
    ...reopenedPort,
    readCurrentDigest: () => reopened.digest,
  };
  await assert.rejects(
    () =>
      rehydrateConditionalRecoverySessionCapabilities(
        reopened,
        {
          stage: "conditional-keys",
          catalogue,
          keysResponse: keysResponse(),
        },
        foreignPort,
      ),
    /different session port/i,
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
  const ports = linearPorts();
  const session = createConditionalRecoverySession({
    catalogue,
    walletScope: catalogue.walletScope,
    cas: ports.cas,
  });
  const skip = validateConditionalRecoveryKeys({
    catalogue,
    walletScope: catalogue.walletScope,
    keysetId: expiredId,
    response: keysResponse({ id: expiredId, final_expiry: finalExpiry }),
    responseBytes: 1,
    authority: await observation(catalogue),
    session,
  });
  assert.equal(skip.reason, "freshly-proven-ineligible");
  const skipped = skipFreshlyIneligibleConditionalRecoveryKeyset(skip);
  assert.equal(skipped.transition, "keyset-skipped");
  assert.equal(skipped.skipEvidence?.keysetId, expiredId);
  assert.equal(skipped.budget.transportBytes, skip.budget.transportBytes);
  const reopened = decodeConditionalRecoverySession(
    encodeConditionalRecoverySession(skipped, catalogue.walletScope),
    catalogue.walletScope,
  );
  const capabilities = await rehydrateConditionalRecoverySessionCapabilities(
    reopened,
    { stage: "keyset-skipped", catalogue },
    ports.cas,
  );
  assert.equal(capabilities.target, null);
  assert.throws(
    () => skipFreshlyIneligibleConditionalRecoveryKeyset(skip),
    /already consumed/i,
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
  walletScope = scope(),
) {
  const catalogue = await completedCatalogue(walletScope, rawMetadata);
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
  const request = await authorizeConditionalRecoveryNut09Request({
    catalogue,
    target,
    plan,
    walletScope: catalogue.walletScope,
    authority: await observation(catalogue),
  });
  const staleAuthority = await observation(catalogue);
  await assert.rejects(
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
      plan,
      request,
      fixtures,
      derivedOutputs,
      ports,
      initialSession: targetInitialSessions.get(
        catalogue.walletScope.scopeId + ":40",
      )!,
      proofs,
      charged,
      stagedProofRows: ports.readStagedRows(),
      states,
      admissionPort: ports.admissionPort,
      stagedSession: ports.readStagedSession(),
    };
  }
  const verified = verifyConditionalRecoveryProofs({
    catalogue,
    target,
    walletScope: catalogue.walletScope,
    proofBatch: charged,
    authority: await observation(catalogue),
  });
  const nut07Authority = await classifyConditionalRecoveryNut07({
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
    plan,
    request,
    fixtures,
    derivedOutputs,
    states,
    ports,
    initialSession: targetInitialSessions.get(
      catalogue.walletScope.scopeId + ":40",
    )!,
    nut07Authority,
    stagedProofRows: ports.readStagedRows(),
    stagedSession: ports.readStagedSession(),
    admissionPort: ports.admissionPort,
  };
}

test("request staging survives commit-before-return crash without generic CAS", async () => {
  const catalogue = await completedCatalogue();
  const target = await targetFor(catalogue, 75);
  const fixture = restoreFixture("request-stage-crash", 75);
  const derivedOutputs = [{
    counter: fixture.counter,
    ...fixture.output,
    Y: hashToCurve(new TextEncoder().encode(fixture.proof.secret)).toHex(true),
    unblind: fixture.unblind,
  }];
  const plan = await createSeedDerivedConditionalRecoveryPlan({
    catalogue,
    target,
    walletScope: catalogue.walletScope,
    startCounter: 75,
    count: 1,
    derivationPort: { deriveSeedOutputs: () => derivedOutputs },
    session: target.session,
  });
  const ports = targetPorts.get(target)!;
  const genericBefore = ports.readGenericCasCount();
  ports.rejectNextRequestStage();
  const rejectedRequestAuthority = await observation(catalogue);
  await assert.rejects(
    () =>
      authorizeConditionalRecoveryNut09Request({
        catalogue,
        target,
        plan,
        walletScope: catalogue.walletScope,
        authority: rejectedRequestAuthority,
      }),
    /request atomic staging CAS failed/i,
  );
  assert.equal(ports.readStagedRequestBytes().byteLength, 0);
  ports.throwAfterNextRequestStageCommit();
  const requestAuthority = await observation(catalogue);
  await assert.rejects(
    () =>
      authorizeConditionalRecoveryNut09Request({
        catalogue,
        target,
        plan,
        walletScope: catalogue.walletScope,
        authority: requestAuthority,
      }),
    /simulated crash after request stage commit/i,
  );
  assert.equal(ports.readGenericCasCount(), genericBefore);
  const stagedSession = ports.readStagedSession()!;
  assert.equal(stagedSession.transition, "nut09-request");
  const reopened = decodeConditionalRecoverySession(
    encodeConditionalRecoverySession(stagedSession, catalogue.walletScope),
    catalogue.walletScope,
  );
  const capabilities = await rehydrateConditionalRecoverySessionCapabilities(
    reopened,
    {
      stage: "nut09-request",
      catalogue,
      keysResponse: keysResponse(),
      derivationPort: { deriveSeedOutputs: () => derivedOutputs },
      requestBytes: ports.readStagedRequestBytes(),
    },
    ports.cas,
  );
  const authoritativeBytes = ports.readStagedRequestBytes();
  capabilities.request!.requestBytes.fill(0);
  let replayedBytes: Uint8Array | null = null;
  const replayAuthority = await observation(catalogue);
  await assert.rejects(
    () =>
      acceptConditionalRecoveryNut09ResponseRaw({
        request: capabilities.request!,
        authority: replayAuthority,
        transport: {
          fetchNut09Entity: ({ requestBytes }) => {
            replayedBytes = new Uint8Array(requestBytes);
            throw new Error("stop after replay capture");
          },
        },
      }),
    /stop after replay capture/i,
  );
  assert.equal(
    replayedBytes?.every(
      (value, index) => value === authoritativeBytes[index],
    ),
    true,
  );
});

test("empty response staging survives commit-before-return crash and rehydrates", async () => {
  const catalogue = await completedCatalogue(
    scope(),
    metadata({ final_expiry: 2_000_000_000 }),
  );
  const target = await targetFor(catalogue, 76);
  const fixture = restoreFixture("empty-response-stage-crash", 76);
  const derivedOutputs = [{
    counter: fixture.counter,
    ...fixture.output,
    Y: hashToCurve(new TextEncoder().encode(fixture.proof.secret)).toHex(true),
    unblind: fixture.unblind,
  }];
  const plan = await createSeedDerivedConditionalRecoveryPlan({
    catalogue,
    target,
    walletScope: catalogue.walletScope,
    startCounter: 76,
    count: 1,
    derivationPort: { deriveSeedOutputs: () => derivedOutputs },
    session: target.session,
  });
  const ports = targetPorts.get(target)!;
  const request = await authorizeConditionalRecoveryNut09Request({
    catalogue,
    target,
    plan,
    walletScope: catalogue.walletScope,
    authority: await observation(catalogue),
  });
  const genericBefore = ports.readGenericCasCount();
  ports.throwAfterNextResponseStageCommit();
  const responseBytes = new TextEncoder().encode(
    JSON.stringify({ outputs: [], signatures: [] }),
  );
  ports.rejectNextResponseStage();
  const rejectedResponseAuthority = await observation(catalogue);
  await assert.rejects(
    () =>
      acceptConditionalRecoveryNut09ResponseRaw({
        request,
        authority: rejectedResponseAuthority,
        transport: {
          fetchNut09Entity: () => responseBytes,
        },
      }),
    /response atomic staging CAS failed/i,
  );
  assert.equal(ports.readStagedResponseBytes().byteLength, 0);
  const responseAuthority = await observation(catalogue);
  await assert.rejects(
    () =>
      acceptConditionalRecoveryNut09ResponseRaw({
        request,
        authority: responseAuthority,
        transport: {
          fetchNut09Entity: () => responseBytes,
        },
      }),
    /simulated crash after response stage commit/i,
  );
  assert.equal(ports.readGenericCasCount(), genericBefore);
  assert.equal(ports.readStagedRows().length, 0);
  const stagedSession = ports.readStagedSession()!;
  assert.equal(stagedSession.transition, "nut09-response");
  const reopened = decodeConditionalRecoverySession(
    encodeConditionalRecoverySession(stagedSession, catalogue.walletScope),
    catalogue.walletScope,
  );
  const capabilities = await rehydrateConditionalRecoverySessionCapabilities(
    reopened,
    {
      stage: "nut09-response",
      catalogue,
      keysResponse: keysResponse(),
      derivationPort: { deriveSeedOutputs: () => derivedOutputs },
      requestBytes: ports.readStagedRequestBytes(),
      responseBytes: ports.readStagedResponseBytes(),
      stagedProofRows: [],
    },
    ports.cas,
  );
  assert.equal(capabilities.proofBatch?.proofCount, 0);
  const expiryAuthority = issueConditionalRecoveryFreshExpiryEvidence({
    catalogue,
    target: capabilities.target!,
    authority: await observation(catalogue, 2_000_000_000),
  });
  const skipped = skipExpiredConditionalRecoveryKeyset({
    session: capabilities.session,
    expiryAuthority,
    sessionPort: ports.cas,
  });
  assert.equal(skipped.transition, "keyset-skipped");
});

test("proof-verification reopen rederives exact batch and requires fresh NUT-07", async () => {
  const source = await proofHarness(metadata(), false);
  const verified = verifyConditionalRecoveryProofs({
    catalogue: source.catalogue,
    target: source.target,
    walletScope: source.catalogue.walletScope,
    proofBatch: source.charged,
    authority: await observation(source.catalogue),
  });
  const reopened = decodeConditionalRecoverySession(
    encodeConditionalRecoverySession(
      verified.session,
      source.catalogue.walletScope,
    ),
    source.catalogue.walletScope,
  );
  let current = reopened.digest;
  const sessionPort: ConditionalRecoverySessionCasPort = {
    readCurrentDigest: () => current,
    compareAndSwap: ({ expectedDigest, successor }) => {
      if (current !== expectedDigest) return false;
      current = successor.digest;
      return true;
    },
    compareAndSwapStageNut09Request: async () => false,
    compareAndSwapStageNut09Response: async () => false,
    compareAndSwapInsertUnique: ({
      expectedSessionDigest,
      successorSession,
      nut07Authority,
    }) => {
      if (current !== expectedSessionDigest) return false;
      nut07Authority.consumeForCommit();
      current = successorSession.digest;
      return true;
    },
    compareAndSwapRetainExpiredKeyset: () => false,
  };
  const responseSemantic = new TextEncoder().encode(
    JSON.stringify({
      outputs: source.fixtures.map((fixture) => fixture.output),
      signatures: source.fixtures.map((fixture) => fixture.signature),
    }),
  );
  const responseBytes = new Uint8Array(2_048);
  responseBytes.fill(0x20);
  responseBytes.set(responseSemantic);
  const alteredRequestBytes = new Uint8Array(source.request.requestBytes);
  alteredRequestBytes[alteredRequestBytes.byteLength - 1] ^= 1;
  await assert.rejects(
    () =>
      rehydrateConditionalRecoverySessionCapabilities(
        reopened,
        {
          stage: "proof-verification",
          catalogue: source.catalogue,
          keysResponse: keysResponse(),
          derivationPort: {
            deriveSeedOutputs: () => source.derivedOutputs,
          },
          requestBytes: alteredRequestBytes,
          responseBytes,
          stagedProofRows: source.stagedProofRows,
        },
        sessionPort,
      ),
    /request replay changed bytes/i,
  );
  const alteredResponseBytes = new Uint8Array(responseBytes);
  alteredResponseBytes[alteredResponseBytes.byteLength - 1] = 0x09;
  await assert.rejects(
    () =>
      rehydrateConditionalRecoverySessionCapabilities(
        reopened,
        {
          stage: "proof-verification",
          catalogue: source.catalogue,
          keysResponse: keysResponse(),
          derivationPort: {
            deriveSeedOutputs: () => source.derivedOutputs,
          },
          requestBytes: source.request.requestBytes,
          responseBytes: alteredResponseBytes,
          stagedProofRows: source.stagedProofRows,
        },
        sessionPort,
      ),
    /staged response does not match session bindings/i,
  );
  const capabilities =
    await rehydrateConditionalRecoverySessionCapabilities(
      reopened,
      {
        stage: "proof-verification",
        catalogue: source.catalogue,
        keysResponse: keysResponse(),
        derivationPort: {
          deriveSeedOutputs: () => source.derivedOutputs,
        },
        requestBytes: source.request.requestBytes,
        responseBytes,
        stagedProofRows: source.stagedProofRows,
      },
      sessionPort,
    );
  assert.ok(capabilities.target);
  assert.ok(capabilities.proofBatch);
  assert.ok(capabilities.verifiedProofs);
  const freshNut07 = await fetchConditionalRecoveryNut07CommitAuthorityRaw({
    catalogue: source.catalogue,
    target: capabilities.target,
    walletScope: source.catalogue.walletScope,
    proofBatch: capabilities.proofBatch,
    transport: {
      fetchNut07Entity: async () =>
        new TextEncoder().encode(JSON.stringify({ states: source.states })),
    },
  });
  const admitted = authorizeConditionalRecoveryAdmission({
    catalogue: source.catalogue,
    target: capabilities.target,
    verifiedProofs: capabilities.verifiedProofs,
    nut07Authority: freshNut07,
    walletScope: source.catalogue.walletScope,
    proofs: capabilities.proofBatch.proofs,
    authority: await observation(source.catalogue),
    admissionPort: sessionPort,
  });
  assert.equal(admitted.session.transition, "atomic-admission");
  assert.equal(current, admitted.session.digest);
});

test("fresh-process reopen reconstructs each proof pipeline stage from exact evidence", async () => {
  const source = await proofHarness(metadata(), false);
  assert.notEqual(source.stagedSession, null);
  const verified = verifyConditionalRecoveryProofs({
    catalogue: source.catalogue,
    target: source.target,
    walletScope: source.catalogue.walletScope,
    proofBatch: source.charged,
    authority: await observation(source.catalogue),
  });
  const responseSemantic = new TextEncoder().encode(
    JSON.stringify({
      outputs: source.fixtures.map((fixture) => fixture.output),
      signatures: source.fixtures.map((fixture) => fixture.signature),
    }),
  );
  const responseBytes = new Uint8Array(2_048);
  responseBytes.fill(0x20);
  responseBytes.set(responseSemantic);
  const planEvidence = {
    catalogue: source.catalogue,
    keysResponse: keysResponse(),
    derivationPort: { deriveSeedOutputs: () => source.derivedOutputs },
  };
  const requestEvidence = {
    ...planEvidence,
    requestBytes: source.request.requestBytes,
  };
  const batchEvidence = {
    ...requestEvidence,
    responseBytes,
    stagedProofRows: source.stagedProofRows,
  };
  const cases = [
    {
      session: source.target.session,
      evidence: {
        stage: "conditional-keys",
        catalogue: source.catalogue,
        keysResponse: keysResponse(),
      },
      expected: "target",
    },
    {
      session: source.plan.session,
      evidence: { stage: "nut13-plan", ...planEvidence },
      expected: "plan",
    },
    {
      session: source.request.session,
      evidence: { stage: "nut09-request", ...requestEvidence },
      expected: "request",
    },
    {
      session: source.stagedSession!,
      evidence: { stage: "nut09-response", ...batchEvidence },
      expected: "proofBatch",
    },
    {
      session: verified.session,
      evidence: { stage: "proof-verification", ...batchEvidence },
      expected: "verifiedProofs",
    },
  ] as const;
  for (const entry of cases) {
    const reopened = decodeConditionalRecoverySession(
      encodeConditionalRecoverySession(
        entry.session,
        source.catalogue.walletScope,
      ),
      source.catalogue.walletScope,
    );
    const port: ConditionalRecoverySessionCasPort = {
      readCurrentDigest: () => reopened.digest,
      compareAndSwap: () => false,
      compareAndSwapStageNut09Request: async () => false,
      compareAndSwapStageNut09Response: async () => false,
      compareAndSwapRetainExpiredKeyset: () => false,
      compareAndSwapInsertUnique: () => false,
    };
    const capabilities = await Reflect.apply(
      rehydrateConditionalRecoverySessionCapabilities,
      undefined,
      [reopened, entry.evidence, port],
    );
    assert.equal(capabilities.session, reopened);
    assert.notEqual(capabilities[entry.expected], null);
  }
  const nut07Authority = await classifyConditionalRecoveryNut07({
    catalogue: source.catalogue,
    target: source.target,
    walletScope: source.catalogue.walletScope,
    proofBatch: source.charged,
    response: { states: [...source.states].reverse() },
    responseBytes: 1_024,
  });
  const admitted = authorizeConditionalRecoveryAdmission({
    catalogue: source.catalogue,
    target: source.target,
    verifiedProofs: verified,
    nut07Authority,
    walletScope: source.catalogue.walletScope,
    proofs: source.proofs,
    authority: await observation(source.catalogue),
    admissionPort: source.admissionPort,
  });
  const reopenedAdmission = decodeConditionalRecoverySession(
    encodeConditionalRecoverySession(
      admitted.session,
      source.catalogue.walletScope,
    ),
    source.catalogue.walletScope,
  );
  const admissionPort: ConditionalRecoverySessionCasPort = {
    readCurrentDigest: () => reopenedAdmission.digest,
    compareAndSwap: () => false,
    compareAndSwapStageNut09Request: async () => false,
    compareAndSwapStageNut09Response: async () => false,
    compareAndSwapRetainExpiredKeyset: () => false,
    compareAndSwapInsertUnique: () => false,
  };
  const admissionCapabilities =
    await rehydrateConditionalRecoverySessionCapabilities(
      reopenedAdmission,
      {
        stage: "atomic-admission",
        catalogue: source.catalogue,
        keysResponse: keysResponse(),
      },
      admissionPort,
    );
  assert.equal(admissionCapabilities.target?.metadata.id, KEYSET_ID);
});
test("fresh-process reopen accepts an exact empty NUT-09 response", async () => {
  const catalogue = await completedCatalogue();
  const target = await targetFor(catalogue, 60);
  const fixture = restoreFixture("empty-reopen", 60);
  const derivedOutputs = [{
    counter: fixture.counter,
    ...fixture.output,
    Y: hashToCurve(new TextEncoder().encode(fixture.proof.secret)).toHex(true),
    unblind: fixture.unblind,
  }];
  const plan = await createSeedDerivedConditionalRecoveryPlan({
    catalogue,
    target,
    walletScope: catalogue.walletScope,
    startCounter: 60,
    count: 1,
    derivationPort: { deriveSeedOutputs: () => derivedOutputs },
    session: target.session,
  });
  const request = await authorizeConditionalRecoveryNut09Request({
    catalogue,
    target,
    plan,
    walletScope: catalogue.walletScope,
    authority: await observation(catalogue),
  });
  const charged = await acceptConditionalRecoveryNut09Response({
    request,
    response: { outputs: [], signatures: [] },
    responseBytes: 128,
    authority: await observation(catalogue),
  });
  const semantic = new TextEncoder().encode(
    JSON.stringify({ outputs: [], signatures: [] }),
  );
  const responseBytes = new Uint8Array(128);
  responseBytes.fill(0x20);
  responseBytes.set(semantic);
  const reopened = decodeConditionalRecoverySession(
    encodeConditionalRecoverySession(charged.session, catalogue.walletScope),
    catalogue.walletScope,
  );
  const port: ConditionalRecoverySessionCasPort = {
    readCurrentDigest: () => reopened.digest,
    compareAndSwap: () => false,
    compareAndSwapStageNut09Request: async () => false,
    compareAndSwapStageNut09Response: async () => false,
    compareAndSwapRetainExpiredKeyset: () => false,
    compareAndSwapInsertUnique: () => false,
  };
  const capabilities = await rehydrateConditionalRecoverySessionCapabilities(
    reopened,
    {
      stage: "nut09-response",
      catalogue,
      keysResponse: keysResponse(),
      derivationPort: { deriveSeedOutputs: () => derivedOutputs },
      requestBytes: request.requestBytes,
      responseBytes,
      stagedProofRows: [],
    },
    port,
  );
  assert.equal(capabilities.proofBatch?.proofCount, 0);
});

test("nut09-request reopen requires byte-identical dispatch replay before expiry handling", async () => {
  const catalogue = await completedCatalogue();
  const target = await targetFor(catalogue, 70);
  const fixture = restoreFixture("lost-dispatch", 70);
  const derivedOutputs = [{
    counter: fixture.counter,
    ...fixture.output,
    Y: hashToCurve(new TextEncoder().encode(fixture.proof.secret)).toHex(true),
    unblind: fixture.unblind,
  }];
  const plan = await createSeedDerivedConditionalRecoveryPlan({
    catalogue,
    target,
    walletScope: catalogue.walletScope,
    startCounter: 70,
    count: 1,
    derivationPort: { deriveSeedOutputs: () => derivedOutputs },
    session: target.session,
  });
  const request = await authorizeConditionalRecoveryNut09Request({
    catalogue,
    target,
    plan,
    walletScope: catalogue.walletScope,
    authority: await observation(catalogue),
  });
  const reopened = decodeConditionalRecoverySession(
    encodeConditionalRecoverySession(request.session, catalogue.walletScope),
    catalogue.walletScope,
  );
  const port: ConditionalRecoverySessionCasPort = {
    readCurrentDigest: () => reopened.digest,
    compareAndSwap: () => false,
    compareAndSwapStageNut09Request: async () => false,
    compareAndSwapStageNut09Response: async () => false,
    compareAndSwapRetainExpiredKeyset: () => false,
    compareAndSwapInsertUnique: () => false,
  };
  const changedRequest = new Uint8Array(request.requestBytes);
  changedRequest[changedRequest.byteLength - 1] ^= 1;
  await assert.rejects(
    () =>
      rehydrateConditionalRecoverySessionCapabilities(
        reopened,
        {
          stage: "nut09-request",
          catalogue,
          keysResponse: keysResponse(),
          derivationPort: { deriveSeedOutputs: () => derivedOutputs },
          requestBytes: changedRequest,
        },
        port,
      ),
    /request replay changed bytes/i,
  );
  await assert.rejects(
    Reflect.apply(rehydrateConditionalRecoverySessionCapabilities, undefined, [
      reopened,
      {
        stage: "nut09-request",
        catalogue,
        keysResponse: keysResponse(),
        derivationPort: { deriveSeedOutputs: () => derivedOutputs },
        requestBytes: request.requestBytes,
        responseBytes: new Uint8Array(),
      },
      port,
    ]),
    /unknown field/i,
  );
  const capabilities = await rehydrateConditionalRecoverySessionCapabilities(
    reopened,
    {
      stage: "nut09-request",
      catalogue,
      keysResponse: keysResponse(),
      derivationPort: { deriveSeedOutputs: () => derivedOutputs },
      requestBytes: request.requestBytes,
    },
    port,
  );
  assert.equal(
    capabilities.request!.requestBytes.byteLength,
    request.requestBytes.byteLength,
  );
  assert.equal(
    capabilities.request!.requestBytes.every(
      (value, index) => value === request.requestBytes[index],
    ),
    true,
  );
  const expiryAuthority = issueConditionalRecoveryFreshExpiryEvidence({
    catalogue,
    target: capabilities.target!,
    authority: await observation(catalogue, 2_000_000_000),
  });
  assert.throws(
    () =>
      skipExpiredConditionalRecoveryKeyset({
        session: reopened,
        expiryAuthority,
        sessionPort: port,
      }),
    /must replay before expiry handling/i,
  );
});

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
  const nut07Authority = await classifyConditionalRecoveryNut07({
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
    nut07Authority,
    walletScope: harness.catalogue.walletScope,
    proofs: harness.proofs,
    expiryAuthority,
    sessionPort: ports.cas,
  });
  assert.equal(successor.transition, "expired-keyset-retention");
  assert.equal(successor.currentBatch?.stagedBatchId, harness.charged.stagedBatchId);
  const reopenedRetention = decodeConditionalRecoverySession(
    encodeConditionalRecoverySession(
      successor,
      harness.catalogue.walletScope,
    ),
    harness.catalogue.walletScope,
  );
  const retentionCapabilities =
    await rehydrateConditionalRecoverySessionCapabilities(
      reopenedRetention,
      {
        stage: "expired-keyset-retention",
        catalogue: harness.catalogue,
      },
      ports.cas,
    );
  assert.equal(retentionCapabilities.target, null);
  const completedKeyset = completeConditionalRecoveryKeyset({
    session: retentionCapabilities.session,
    sessionPort: ports.cas,
    evidenceDigest: "ef".repeat(32),
  });
  assert.equal(completedKeyset.transition, "keyset-completed");
  const reopenedCompletedKeyset = decodeConditionalRecoverySession(
    encodeConditionalRecoverySession(
      completedKeyset,
      harness.catalogue.walletScope,
    ),
    harness.catalogue.walletScope,
  );
  const completedKeysetCapabilities =
    await rehydrateConditionalRecoverySessionCapabilities(
      reopenedCompletedKeyset,
      { stage: "keyset-completed", catalogue: harness.catalogue },
      ports.cas,
    );
  assert.equal(completedKeysetCapabilities.target, null);
  const mismatchedCatalogue = await completedCatalogue(
    harness.catalogue.walletScope,
    metadata({ registered_at: 1_700_000_001 }),
  );
  assert.throws(
    () =>
      completeConditionalRecoverySession({
        session: completedKeysetCapabilities.session,
        sessionPort: ports.cas,
        catalogue: mismatchedCatalogue,
      }),
    /catalogue digest/i,
  );
  const completedRecovery = completeConditionalRecoverySession({
    session: completedKeysetCapabilities.session,
    sessionPort: ports.cas,
    catalogue: harness.catalogue,
  });
  assert.equal(completedRecovery.transition, "recovery-completed");
  assert.throws(
    () =>
      completeConditionalRecoverySession({
        session: completedKeysetCapabilities.session,
        sessionPort: ports.cas,
        catalogue: harness.catalogue,
      }),
    /consumed/i,
  );
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



test("retention CAS false, omission, and failure invalidate NUT-07 authority and require refetch", async () => {
  const harness = await proofHarness(metadata(), false);
  const ports = targetPorts.get(harness.target)!;
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
  const fetchNut07 = () =>
    classifyConditionalRecoveryNut07({
      catalogue: harness.catalogue,
      target: harness.target,
      walletScope: harness.catalogue.walletScope,
      proofBatch: harness.charged,
      response: { states: [...harness.states].reverse() },
      responseBytes: 1_024,
    });
  const originalRetention = ports.cas.compareAndSwapRetainExpiredKeyset;
  ports.cas.compareAndSwapRetainExpiredKeyset = () => false;
  const staleAuthority = await fetchNut07();
  assert.throws(
    () =>
      retainExpiredConditionalRecoveryKeyset({
        catalogue: harness.catalogue,
        target: harness.target,
        verifiedProofs: verified,
        nut07Authority: staleAuthority,
        walletScope: harness.catalogue.walletScope,
        proofs: harness.proofs,
        expiryAuthority,
        sessionPort: ports.cas,
      }),
    /retention CAS failed/i,
  );
  assert.throws(
    () =>
      retainExpiredConditionalRecoveryKeyset({
        catalogue: harness.catalogue,
        target: harness.target,
        verifiedProofs: verified,
        nut07Authority: staleAuthority,
        walletScope: harness.catalogue.walletScope,
        proofs: harness.proofs,
        expiryAuthority,
        sessionPort: ports.cas,
      }),
    /authority is invalid/i,
  );
  const omissionExpiry = issueConditionalRecoveryFreshExpiryEvidence({
    catalogue: harness.catalogue,
    target: harness.target,
    authority: await observation(harness.catalogue, 2_000_000_000),
  });
  const omittedAuthority = await fetchNut07();
  ports.cas.compareAndSwapRetainExpiredKeyset = () => true;
  assert.throws(
    () =>
      retainExpiredConditionalRecoveryKeyset({
        catalogue: harness.catalogue,
        target: harness.target,
        verifiedProofs: verified,
        nut07Authority: omittedAuthority,
        walletScope: harness.catalogue.walletScope,
        proofs: harness.proofs,
        expiryAuthority: omissionExpiry,
        sessionPort: ports.cas,
      }),
    /omitted NUT-07 commit consumption/i,
  );
  const failureExpiry = issueConditionalRecoveryFreshExpiryEvidence({
    catalogue: harness.catalogue,
    target: harness.target,
    authority: await observation(harness.catalogue, 2_000_000_000),
  });
  const failedAuthority = await fetchNut07();
  ports.cas.compareAndSwapRetainExpiredKeyset = ({ nut07Authority }) => {
    nut07Authority.consumeForCommit();
    throw new Error("test transaction rollback");
  };
  assert.throws(
    () =>
      retainExpiredConditionalRecoveryKeyset({
        catalogue: harness.catalogue,
        target: harness.target,
        verifiedProofs: verified,
        nut07Authority: failedAuthority,
        walletScope: harness.catalogue.walletScope,
        proofs: harness.proofs,
        expiryAuthority: failureExpiry,
        sessionPort: ports.cas,
      }),
    /transaction rollback/i,
  );
  ports.cas.compareAndSwapRetainExpiredKeyset = originalRetention;
  const freshExpiry = issueConditionalRecoveryFreshExpiryEvidence({
    catalogue: harness.catalogue,
    target: harness.target,
    authority: await observation(harness.catalogue, 2_000_000_000),
  });
  const freshAuthority = await fetchNut07();
  const retained = retainExpiredConditionalRecoveryKeyset({
    catalogue: harness.catalogue,
    target: harness.target,
    verifiedProofs: verified,
    nut07Authority: freshAuthority,
    walletScope: harness.catalogue.walletScope,
    proofs: harness.proofs,
    expiryAuthority: freshExpiry,
    sessionPort: ports.cas,
  });
  assert.equal(retained.transition, "expired-keyset-retention");
});

test("conditional recovery keeps UNKNOWN mint state fail closed", async () => {
  const harness = await proofHarness();
  const states = harness.proofs.map((proof, index) => ({
    Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
    state: index === 0 ? "UNKNOWN" : "UNSPENT",
    witness: null,
  }));
  await assert.rejects(
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

for (const [name, commitTime] of [
  ["monotonic regression", 99],
  ["deadline expiry", 5_101],
] as const) {
  test(`NUT-07 commit authority rejects ${name}`, async () => {
    let monotonicNow = 100;
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: () => monotonicNow,
    });
    try {
      const harness = await proofHarness(metadata(), false);
      const verified = verifyConditionalRecoveryProofs({
        catalogue: harness.catalogue,
        target: harness.target,
        walletScope: harness.catalogue.walletScope,
        proofBatch: harness.charged,
        authority: await observation(harness.catalogue),
      });
      const nut07Authority = await classifyConditionalRecoveryNut07({
        catalogue: harness.catalogue,
        target: harness.target,
        walletScope: harness.catalogue.walletScope,
        proofBatch: harness.charged,
        response: { states: [...harness.states].reverse() },
        responseBytes: 1_024,
      });
      const expiryObservation = await observation(harness.catalogue);
      monotonicNow = commitTime;
      assert.throws(
        () =>
          authorizeConditionalRecoveryAdmission({
            catalogue: harness.catalogue,
            target: harness.target,
            verifiedProofs: verified,
            nut07Authority,
            walletScope: harness.catalogue.walletScope,
            proofs: harness.proofs,
            authority: expiryObservation,
            admissionPort: harness.admissionPort,
          }),
        /monotonic age is invalid/i,
      );
    } finally {
      Reflect.deleteProperty(performance, "now");
    }
  });
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
  const request = await authorizeConditionalRecoveryNut09Request({
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
    const request = await authorizeConditionalRecoveryNut09Request({
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
  const firstRequest = await authorizeConditionalRecoveryNut09Request({
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
  const secondRequest = await authorizeConditionalRecoveryNut09Request({
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
  assert.equal(decoded.digest, secondBatch.session.digest);
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
  const request = await authorizeConditionalRecoveryNut09Request({
    catalogue,
    target,
    plan,
    walletScope: catalogue.walletScope,
    authority: await observation(catalogue),
  });
  const authoritativeRequestBytes = new Uint8Array(request.requestBytes);
  request.requestBytes[0] ^= 1;
  let dispatchedRequestBytes: Uint8Array | null = null;
  const replayAuthority = await observation(catalogue);
  await assert.rejects(
    () =>
      acceptConditionalRecoveryNut09ResponseRaw({
        request,
        authority: replayAuthority,
        transport: {
          fetchNut09Entity: ({ requestBytes }) => {
            dispatchedRequestBytes = new Uint8Array(requestBytes);
            throw new Error("stop after dispatch capture");
          },
        },
      }),
    /stop after dispatch capture/i,
  );
  assert.equal(
    dispatchedRequestBytes?.byteLength,
    authoritativeRequestBytes.byteLength,
  );
  assert.equal(
    dispatchedRequestBytes?.every(
      (value, index) => value === authoritativeRequestBytes[index],
    ),
    true,
  );
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
    const request = await authorizeConditionalRecoveryNut09Request({
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
