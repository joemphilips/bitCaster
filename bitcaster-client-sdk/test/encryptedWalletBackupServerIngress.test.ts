import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decode } from "cborg";
import { encodeCanonicalBackupCbor } from "../src/encryptedWalletBackupCbor.ts";
import {
  consumeEncryptedWalletBackupVerifiedRequestReplay,
  createEncryptedWalletBackupKeyHandle,
  EncryptedWalletBackupReplayStoreUnavailableError,
  prepareEncryptedWalletBackupEnrollmentEpochDiscoveryProof,
  prepareEncryptedWalletBackupRequestProof,
  verifyEncryptedWalletBackupRequestProofEvidence,
  type EncryptedWalletBackupKeyHandle,
  type EncryptedWalletBackupReplayStore,
  type EncryptedWalletBackupRequestMethod,
} from "../src/encryptedWalletBackup.ts";
import {
  ENCRYPTED_WALLET_BACKUP_ACCOUNT_REQUEST_MAX_BYTES,
  ENCRYPTED_WALLET_BACKUP_AUTHORIZATION_HEADER_MAX_CHARACTERS,
  ENCRYPTED_WALLET_BACKUP_HEAD_CAS_REQUEST_MAX_BYTES,
  ENCRYPTED_WALLET_BACKUP_OBJECT_PUT_REQUEST_MAX_BYTES,
  ENCRYPTED_WALLET_BACKUP_REQUEST_PROOF_MAX_BYTES,
  ENCRYPTED_WALLET_BACKUP_UPLOAD_ATTEMPT_ABORT_REQUEST_MAX_BYTES,
  EncryptedWalletBackupDelegatedRequestError,
  authenticateEnrollmentAuthorizedEncryptedWalletBackupDelegatedServerRequest,
  authenticateAndDecodeEncryptedWalletBackupDelegatedServerRequest,
  authenticateEncryptedWalletBackupDelegatedServerRequest,
  decodeEncryptedWalletBackupAuthorizationHeader,
  decodeEncryptedWalletBackupHeadCasRequest,
  decodeEncryptedWalletBackupObjectPutRequest,
  decodeEncryptedWalletBackupRequestProofClaims,
  decodeEncryptedWalletBackupUploadAttemptAbortRequest,
  encryptedWalletBackupDelegatedPayloadMaximumBytes,
  authorizeVerifiedEncryptedWalletBackupDelegatedServerRequest,
  verifyAndDecodeEncryptedWalletBackupDelegatedServerRequest,
  type EncryptedWalletBackupServerEnrollment,
  type EncryptedWalletBackupServerRoute,
} from "../src/encryptedWalletBackupServerCodec.ts";

const ORIGIN = "https://backup.example";
const REALM = "test";
const NOW = 1_800_000_000;
const VAULT_ID = "11".repeat(32);
const PUBLIC_KEY = "22".repeat(32);
const OBJECT_ID = "33".repeat(16);
const ATTEMPT_ID = "44".repeat(16);
const TARGET_DIGEST = "55".repeat(32);
const SEED = new Uint8Array(64).fill(23);
const EMPTY = new Uint8Array();

test("authorization decoder accepts exactly one canonical BackupV1 value", async () => {
  const fixture = await delegatedFixture({
    operation: "head-get",
    method: "GET",
    payload: EMPTY,
  });

  const canonicalProof =
    decodeEncryptedWalletBackupAuthorizationHeader(fixture.headerValues);
  const claims = decodeEncryptedWalletBackupRequestProofClaims(canonicalProof);

  assert.equal(claims.realm, REALM);
  assert.equal(claims.vaultId, fixture.keyHandle.vaultId);
  assert.equal(claims.requestAuthPublicKey, fixture.keyHandle.requestAuthPublicKey);
  assert.equal(claims.method, "GET");
  assert.equal(claims.url, fixture.url);
  assert.equal(
    ENCRYPTED_WALLET_BACKUP_REQUEST_PROOF_MAX_BYTES,
    4_096,
  );
  assert.equal(
    ENCRYPTED_WALLET_BACKUP_AUTHORIZATION_HEADER_MAX_CHARACTERS,
    5_471,
  );
});

test("authorization decoder rejects duplicates and every noncanonical raw form", async () => {
  const fixture = await delegatedFixture({
    operation: "head-get",
    method: "GET",
    payload: EMPTY,
  });
  const canonical = fixture.headerValues[0]!;
  const encoded = canonical.slice("BackupV1 ".length);
  const malformed = [
    [],
    [canonical, canonical],
    [` ${canonical}`],
    [`${canonical} `],
    [`BackupV1  ${encoded}`],
    [`backupv1 ${encoded}`],
    [`BackupV1 ${encoded}=`],
    [`BackupV1 ${encoded}\r`],
    [`BackupV1 ${encoded},${encoded}`],
    [`BackupV1 ${"a".repeat(5_463)}`],
  ];
  for (const raw of malformed) {
    assert.throws(
      () => decodeEncryptedWalletBackupAuthorizationHeader(raw),
      /authorization header is invalid/,
    );
  }
});

test("authorization proof limit accepts exact max and rejects max plus one", () => {
  const exact = new Uint8Array(
    ENCRYPTED_WALLET_BACKUP_REQUEST_PROOF_MAX_BYTES,
  );
  const over = new Uint8Array(
    ENCRYPTED_WALLET_BACKUP_REQUEST_PROOF_MAX_BYTES + 1,
  );
  assert.equal(
    `BackupV1 ${base64Url(exact)}`.length,
    ENCRYPTED_WALLET_BACKUP_AUTHORIZATION_HEADER_MAX_CHARACTERS,
  );
  assert.equal(
    decodeEncryptedWalletBackupAuthorizationHeader([
      `BackupV1 ${base64Url(exact)}`,
    ]).byteLength,
    ENCRYPTED_WALLET_BACKUP_REQUEST_PROOF_MAX_BYTES,
  );
  assert.throws(
    () =>
      decodeEncryptedWalletBackupAuthorizationHeader([
        `BackupV1 ${base64Url(over)}`,
      ]),
    /authorization header is invalid/,
  );
});

test("proof claim decoding allocation-bounds hostile canonical CBOR", () => {
  const hostile = encodeCanonicalBackupCbor([
    1,
    "backup-request-proof",
    Array.from({ length: 10_000 }, () => new Uint8Array()),
  ]);
  const header = `BackupV1 ${base64Url(hostile)}`;

  assert.throws(
    () =>
      decodeEncryptedWalletBackupRequestProofClaims(
        decodeEncryptedWalletBackupAuthorizationHeader([header]),
      ),
    /request proof/,
  );
});

test("delegated authentication binds configured origin, raw route, method, payload, and enrollment", async () => {
  const keyHandle = await createKeyHandle();
  const payload = headCasPayload({
    generation: 1,
    expectedManifestDigest: null,
    realm: keyHandle.realm,
    vaultId: keyHandle.vaultId,
    backupPublicKey: keyHandle.requestAuthPublicKey,
  }).payload;
  const fixture = await delegatedFixture({
    operation: "head-cas",
    method: "POST",
    payload,
    keyHandle,
  });
  const replay = replayStore();

  const result =
    await authenticateAndDecodeEncryptedWalletBackupDelegatedServerRequest({
      rawAuthorizationHeaderValues: fixture.headerValues,
      configuredOrigin: ORIGIN,
      rawTarget: fixture.rawTarget,
      method: "POST",
      route: fixture.route,
      payload,
      serverNowUnixSeconds: NOW,
      enrollment: activeEnrollment(fixture.keyHandle, 3),
      replayStore: replay.store,
    });

  assert.equal(result.authentication.kind, "authenticated");
  assert.equal(result.authentication.operation, "head-cas");
  assert.equal(result.authentication.claims.enrollmentEpoch, 3);
  assert.equal(result.decodedPayload.kind, "head-cas");
  assert.equal(replay.calls(), 1);
});

test("staged delegated verification is non-substitutable and defers replay persistence", async () => {
  const fixture = await delegatedFixture({
    operation: "head-get",
    method: "GET",
    payload: EMPTY,
  });
  const verified = verifyAndDecodeEncryptedWalletBackupDelegatedServerRequest({
    rawAuthorizationHeaderValues: fixture.headerValues,
    configuredOrigin: ORIGIN,
    rawTarget: fixture.rawTarget,
    method: "GET",
    route: fixture.route,
    payload: EMPTY,
    serverNowUnixSeconds: NOW,
  });
  const replay = replayStore();
  assert.equal(verified.state, "verified");
  assert.equal(verified.operation, "head-get");
  assert.equal(replay.calls(), 0);

  await assert.rejects(
    async () => {
      const authorized =
        authorizeVerifiedEncryptedWalletBackupDelegatedServerRequest({
          verifiedRequest: Object.freeze({ ...verified }),
          enrollment: activeEnrollment(fixture.keyHandle, 3),
        });
      await authenticateEnrollmentAuthorizedEncryptedWalletBackupDelegatedServerRequest({
        authorizedRequest: authorized,
        replayStore: replay.store,
      });
    },
    /verified delegated request is invalid/,
  );
  assert.equal(replay.calls(), 0);

  const authorized =
    authorizeVerifiedEncryptedWalletBackupDelegatedServerRequest({
      verifiedRequest: verified,
      enrollment: activeEnrollment(fixture.keyHandle, 3),
    });
  assert.equal(authorized.accountAdmission, "enrolled-account");
  assert.equal(replay.calls(), 0);
  assert.throws(
    () =>
      authorizeVerifiedEncryptedWalletBackupDelegatedServerRequest({
        verifiedRequest: verified,
        enrollment: activeEnrollment(fixture.keyHandle, 3),
      }),
    /verified delegated request is invalid/,
  );
  assert.equal(replay.calls(), 0);
  await assert.rejects(
    () =>
      authenticateEnrollmentAuthorizedEncryptedWalletBackupDelegatedServerRequest({
        authorizedRequest: Object.freeze({ ...authorized }),
        replayStore: replay.store,
      }),
    /enrollment-authorized delegated request is invalid/,
  );
  assert.equal(replay.calls(), 0);
  const authenticated =
    await authenticateEnrollmentAuthorizedEncryptedWalletBackupDelegatedServerRequest({
      authorizedRequest: authorized,
      replayStore: replay.store,
    });
  assert.equal(authenticated.authentication.kind, "authenticated");
  assert.equal(authenticated.decodedPayload.kind, "no-body");
  assert.equal(replay.calls(), 1);
  await assert.rejects(
    () =>
      authenticateEnrollmentAuthorizedEncryptedWalletBackupDelegatedServerRequest({
        authorizedRequest: authorized,
        replayStore: replay.store,
      }),
    /enrollment-authorized delegated request is invalid/,
  );
  assert.equal(replay.calls(), 1);
});

test("composed ingress authenticates and decodes every delegated route", async () => {
  for (const operation of delegatedOperations()) {
    const keyHandle = await createKeyHandle();
    const payload = payloadForOperation(operation, keyHandle);
    const fixture = await delegatedFixture({
      operation,
      method: methodForOperation(operation),
      payload,
      keyHandle,
    });
    const result =
      await authenticateAndDecodeEncryptedWalletBackupDelegatedServerRequest({
        rawAuthorizationHeaderValues: fixture.headerValues,
        configuredOrigin: ORIGIN,
        rawTarget: fixture.rawTarget,
        method: methodForOperation(operation),
        route: fixture.route,
        payload,
        serverNowUnixSeconds: NOW,
        enrollment: activeEnrollment(keyHandle, 3),
        replayStore: replayStore().store,
      });

    assert.equal(result.authentication.operation, operation);
    switch (operation) {
      case "enrollment-epoch":
      case "head-get":
      case "object-get":
      case "object-delete":
        assert.deepEqual(result.decodedPayload, {
          kind: "no-body",
          operation,
        });
        break;
      case "object-put":
      case "head-cas":
      case "upload-attempt-abort":
        assert.equal(result.decodedPayload.kind, operation);
        break;
    }
  }
});

test("malformed payloads for every delegated route fail before replay", async () => {
  const malformed = encodeCanonicalBackupCbor([1, "probe"]);
  for (const operation of delegatedOperations()) {
    const keyHandle = await createKeyHandle();
    const signedPayload = operation === "enrollment-epoch" ? EMPTY : malformed;
    const fixture = await delegatedFixture({
      operation,
      method: methodForOperation(operation),
      payload: signedPayload,
      keyHandle,
    });
    const replay = replayStore();
    await assert.rejects(
      () =>
        authenticateAndDecodeEncryptedWalletBackupDelegatedServerRequest({
          rawAuthorizationHeaderValues: fixture.headerValues,
          configuredOrigin: ORIGIN,
          rawTarget: fixture.rawTarget,
          method: methodForOperation(operation),
          route: fixture.route,
          payload: malformed,
          serverNowUnixSeconds: NOW,
          enrollment: activeEnrollment(keyHandle, 3),
          replayStore: replay.store,
        }),
      /delegated request rejected: invalid-request/,
    );
    assert.equal(replay.calls(), 0);
  }
});

test("legacy authentication cannot authenticate a malformed head CAS", async () => {
  const malformed = encodeCanonicalBackupCbor([1, "probe"]);
  const fixture = await delegatedFixture({
    operation: "head-cas",
    method: "POST",
    payload: malformed,
  });
  const replay = replayStore();
  await assert.rejects(
    () =>
      authenticateEncryptedWalletBackupDelegatedServerRequest({
        rawAuthorizationHeaderValues: fixture.headerValues,
        configuredOrigin: ORIGIN,
        rawTarget: fixture.rawTarget,
        method: "POST",
        route: fixture.route,
        payload: malformed,
        serverNowUnixSeconds: NOW,
        enrollment: activeEnrollment(fixture.keyHandle, 3),
        replayStore: replay.store,
      }),
    /delegated request rejected: invalid-request/,
  );
  assert.equal(replay.calls(), 0);
});

test("delegated request rejection exposes a closed server error code", async () => {
  const fixture = await delegatedFixture({
    operation: "head-get",
    method: "GET",
    payload: EMPTY,
  });
  await assert.rejects(
    authenticateEncryptedWalletBackupDelegatedServerRequest({
      rawAuthorizationHeaderValues: fixture.headerValues,
      configuredOrigin: ORIGIN,
      rawTarget: `${fixture.rawTarget}/other`,
      method: "GET",
      route: fixture.route,
      payload: EMPTY,
      serverNowUnixSeconds: NOW,
      enrollment: activeEnrollment(fixture.keyHandle, 3),
      replayStore: replayStore().store,
    }),
    (error: unknown) =>
      error instanceof EncryptedWalletBackupDelegatedRequestError
      && error.code === "invalid-request",
  );
});

test("route, origin, URL, method, and payload confusion fail closed", async () => {
  const cases: readonly Readonly<{
    mutate: (
      fixture: Awaited<ReturnType<typeof delegatedFixture>>,
    ) => Record<string, unknown>;
  }>[] = [
    {
      mutate: (fixture) => ({
        rawTarget: `${fixture.rawTarget}/other`,
      }),
    },
    {
      mutate: () => ({
        configuredOrigin: "https://other.example",
      }),
    },
    {
      mutate: () => ({
        method: "PUT",
      }),
    },
    {
      mutate: () => ({
        payload: encodeCanonicalBackupCbor([1, "changed"]),
      }),
    },
    {
      mutate: (fixture) => ({
        route: {
          ...fixture.route,
          routeVaultId: "66".repeat(32),
        },
      }),
    },
  ];
  for (const current of cases) {
    const keyHandle = await createKeyHandle();
    const payload = headCasPayload({
      generation: 1,
      expectedManifestDigest: null,
      realm: keyHandle.realm,
      vaultId: keyHandle.vaultId,
      backupPublicKey: keyHandle.requestAuthPublicKey,
    }).payload;
    const fixture = await delegatedFixture({
      operation: "head-cas",
      method: "POST",
      payload,
      keyHandle,
    });
    const replay = replayStore();
    await assert.rejects(
      () =>
        authenticateEncryptedWalletBackupDelegatedServerRequest({
          rawAuthorizationHeaderValues: fixture.headerValues,
          configuredOrigin: ORIGIN,
          rawTarget: fixture.rawTarget,
          method: "POST",
          route: fixture.route,
          payload,
          serverNowUnixSeconds: NOW,
          enrollment: activeEnrollment(fixture.keyHandle, 3),
          replayStore: replay.store,
          ...current.mutate(fixture),
        }),
      /delegated request rejected: (invalid-request|unauthorized)/,
    );
    assert.equal(replay.calls(), 0);
  }
});

test("stale, wrong-key, revoked, and missing enrollment fail before replay consumption", async () => {
  const fixture = await delegatedFixture({
    operation: "head-get",
    method: "GET",
    payload: EMPTY,
  });
  const enrollments: readonly EncryptedWalletBackupServerEnrollment[] = [
    activeEnrollment(fixture.keyHandle, 4),
    {
      ...activeEnrollment(fixture.keyHandle, 3),
      requestAuthPublicKey: "77".repeat(32),
    },
    { status: "not-enrolled" },
  ];

  for (const enrollment of enrollments) {
    const replay = replayStore();
    await assert.rejects(
      () =>
        authenticateEncryptedWalletBackupDelegatedServerRequest({
          rawAuthorizationHeaderValues: fixture.headerValues,
          configuredOrigin: ORIGIN,
          rawTarget: fixture.rawTarget,
          method: "GET",
          route: fixture.route,
          payload: EMPTY,
          serverNowUnixSeconds: NOW,
          enrollment,
          replayStore: replay.store,
        }),
      /delegated request rejected: unauthorized/,
    );
    assert.equal(replay.calls(), 0);
  }
});

test("proof self-verification fails before active enrollment is inspected", async () => {
  const fixture = await delegatedFixture({
    operation: "head-get",
    method: "GET",
    payload: EMPTY,
  });
  const proofTuple = decode(
    decodeEncryptedWalletBackupAuthorizationHeader(fixture.headerValues),
  );
  assert.ok(Array.isArray(proofTuple));
  proofTuple[13] = new Uint8Array(64);
  const invalidHeader = `BackupV1 ${base64Url(
    encodeCanonicalBackupCbor(proofTuple),
  )}`;
  let enrollmentReads = 0;
  const enrollment = new Proxy(activeEnrollment(fixture.keyHandle, 3), {
    get(target, property, receiver) {
      enrollmentReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const replay = replayStore();

  await assert.rejects(
    () =>
      authenticateAndDecodeEncryptedWalletBackupDelegatedServerRequest({
        rawAuthorizationHeaderValues: [invalidHeader],
        configuredOrigin: ORIGIN,
        rawTarget: fixture.rawTarget,
        method: "GET",
        route: fixture.route,
        payload: EMPTY,
        serverNowUnixSeconds: NOW,
        enrollment,
        replayStore: replay.store,
      }),
    /delegated request rejected: unauthorized/,
  );
  assert.equal(enrollmentReads, 0);
  assert.equal(replay.calls(), 0);
});

test("verified proof replay authority cannot be cloned or reconstructed", async () => {
  const fixture = await delegatedFixture({
    operation: "head-get",
    method: "GET",
    payload: EMPTY,
  });
  const verified = verifyEncryptedWalletBackupRequestProofEvidence({
    proof: decodeEncryptedWalletBackupAuthorizationHeader(fixture.headerValues),
    expectedMethod: "GET",
    expectedUrl: fixture.url,
    payload: EMPTY,
    serverNowUnixSeconds: NOW,
  });
  const replay = replayStore();
  const clone = Object.freeze({
    state: "verified" as const,
    claims: verified.claims,
  });

  await assert.rejects(
    () =>
      consumeEncryptedWalletBackupVerifiedRequestReplay({
        verifiedProof: clone,
        replayStore: replay.store,
      }),
    /verified request proof is invalid/,
  );
  assert.equal(replay.calls(), 0);

  const authenticated =
    await consumeEncryptedWalletBackupVerifiedRequestReplay({
      verifiedProof: verified,
      replayStore: replay.store,
    });
  assert.equal(authenticated.state, "authenticated");
  assert.equal(replay.calls(), 1);
});

test("replay consumption is exact and a repeated nonce is rejected", async () => {
  const fixture = await delegatedFixture({
    operation: "object-get",
    method: "GET",
    payload: EMPTY,
    objectId: OBJECT_ID,
  });
  const replay = replayStore();
  const input = {
    rawAuthorizationHeaderValues: fixture.headerValues,
    configuredOrigin: ORIGIN,
    rawTarget: fixture.rawTarget,
    method: "GET",
    route: fixture.route,
    payload: EMPTY,
    serverNowUnixSeconds: NOW,
    enrollment: activeEnrollment(fixture.keyHandle, 3),
    replayStore: replay.store,
  } as const;

  await authenticateEncryptedWalletBackupDelegatedServerRequest(input);
  await assert.rejects(
    () => authenticateEncryptedWalletBackupDelegatedServerRequest(input),
    /delegated request rejected: replay-rejected/,
  );
  assert.equal(replay.calls(), 2);
});

test("replay-store outages remain typed unavailable failures", async () => {
  const fixture = await delegatedFixture({
    operation: "head-get",
    method: "GET",
    payload: EMPTY,
  });
  await assert.rejects(
    () =>
      authenticateAndDecodeEncryptedWalletBackupDelegatedServerRequest({
        rawAuthorizationHeaderValues: fixture.headerValues,
        configuredOrigin: ORIGIN,
        rawTarget: fixture.rawTarget,
        method: "GET",
        route: fixture.route,
        payload: EMPTY,
        serverNowUnixSeconds: NOW,
        enrollment: activeEnrollment(fixture.keyHandle, 3),
        replayStore: {
          async consumeReplayNonce() {
            throw new Error("database unavailable");
          },
        },
      }),
    (error: unknown) =>
      error instanceof EncryptedWalletBackupReplayStoreUnavailableError,
  );
});

test("epoch discovery is self-authenticated and does not enumerate foreign enrollment", async () => {
  const keyHandle = await createKeyHandle();
  const route = routeFor("enrollment-epoch", keyHandle.vaultId);
  const rawTarget = pathFor(route);
  const proof =
    await prepareEncryptedWalletBackupEnrollmentEpochDiscoveryProof({
      keyHandle,
      url: `${ORIGIN}${rawTarget}`,
      issuedAtUnixSeconds: NOW - 1,
      expiresAtUnixSeconds: NOW + 30,
      signal: new AbortController().signal,
      runtime: deterministicRuntime(),
    });
  const headerValues = [`BackupV1 ${base64Url(encodeProof(proof))}`];
  const verified = verifyAndDecodeEncryptedWalletBackupDelegatedServerRequest({
    rawAuthorizationHeaderValues: headerValues,
    configuredOrigin: ORIGIN,
    rawTarget,
    method: "GET",
    route,
    payload: EMPTY,
    serverNowUnixSeconds: NOW,
  });
  const foreignAuthorized =
    authorizeVerifiedEncryptedWalletBackupDelegatedServerRequest({
      verifiedRequest: verified,
      enrollment: {
        ...activeEnrollment(keyHandle, 9),
        requestAuthPublicKey: "77".repeat(32),
      },
    });
  assert.equal(foreignAuthorized.accountAdmission, "not-applicable");

  const active = await authenticateEncryptedWalletBackupDelegatedServerRequest({
    rawAuthorizationHeaderValues: headerValues,
    configuredOrigin: ORIGIN,
    rawTarget,
    method: "GET",
    route,
    payload: EMPTY,
    serverNowUnixSeconds: NOW,
    enrollment: activeEnrollment(keyHandle, 9),
    replayStore: replayStore().store,
  });
  const absent = await authenticateEncryptedWalletBackupDelegatedServerRequest({
    rawAuthorizationHeaderValues: headerValues,
    configuredOrigin: ORIGIN,
    rawTarget,
    method: "GET",
    route,
    payload: EMPTY,
    serverNowUnixSeconds: NOW,
    enrollment: { status: "not-enrolled" },
    replayStore: replayStore().store,
  });
  const foreign = await authenticateEncryptedWalletBackupDelegatedServerRequest({
    rawAuthorizationHeaderValues: headerValues,
    configuredOrigin: ORIGIN,
    rawTarget,
    method: "GET",
    route,
    payload: EMPTY,
    serverNowUnixSeconds: NOW,
    enrollment: {
      ...activeEnrollment(keyHandle, 9),
      requestAuthPublicKey: "77".repeat(32),
    },
    replayStore: replayStore().store,
  });

  assert.deepEqual(active.discovery, {
    status: "active",
    enrollmentEpoch: 9,
  });
  assert.deepEqual(absent.discovery, { status: "not-enrolled" });
  assert.deepEqual(foreign.discovery, { status: "not-enrolled" });
});

test("object PUT decoder binds route, fixed lengths, AAD, and framed digest", () => {
  const valid = objectPutPayload();
  const decoded = decodeEncryptedWalletBackupObjectPutRequest({
    canonicalPayload: valid.payload,
    routeRealm: REALM,
    routeVaultId: VAULT_ID,
    routeObjectId: OBJECT_ID,
  });
  assert.equal(decoded.uploadAttemptId, ATTEMPT_ID);
  assert.equal(decoded.kindCode, 2);
  assert.equal(decoded.paddedLength, 65_536);
  assert.equal(decoded.encryptedBody.byteLength, 65_564);

  const mutations = [
    mutateTuple(valid.payload, 4, "other"),
    mutateTuple(valid.payload, 5, hexToBytes("66".repeat(32))),
    mutateTuple(valid.payload, 6, hexToBytes("77".repeat(16))),
    mutateTuple(valid.payload, 8, 262_144),
    mutateTuple(valid.payload, 9, new Uint8Array(32)),
    mutateTuple(valid.payload, 10, encodeCanonicalBackupCbor([1, 2])),
    mutateTuple(valid.payload, 11, new Uint8Array(65_565)),
  ];
  for (const payload of mutations) {
    assert.throws(
      () =>
        decodeEncryptedWalletBackupObjectPutRequest({
          canonicalPayload: payload,
          routeRealm: REALM,
          routeVaultId: VAULT_ID,
          routeObjectId: OBJECT_ID,
        }),
      /object PUT request is invalid/,
    );
  }
});

test("object PUT accepts the fixed data-chunk kind-one shape", () => {
  const valid = objectPutPayload({ kindCode: 1 });
  const decoded = decodeEncryptedWalletBackupObjectPutRequest({
    canonicalPayload: valid.payload,
    routeRealm: REALM,
    routeVaultId: VAULT_ID,
    routeObjectId: OBJECT_ID,
  });
  assert.equal(decoded.kindCode, 1);
  assert.equal(decoded.paddedLength, 262_144);
  assert.equal(decoded.encryptedBody.byteLength, 262_172);
});

test("object PUT route realm, vault, and object mismatches fail closed", () => {
  const valid = objectPutPayload();
  const routes = [
    { routeRealm: "other", routeVaultId: VAULT_ID, routeObjectId: OBJECT_ID },
    {
      routeRealm: REALM,
      routeVaultId: "66".repeat(32),
      routeObjectId: OBJECT_ID,
    },
    {
      routeRealm: REALM,
      routeVaultId: VAULT_ID,
      routeObjectId: "77".repeat(16),
    },
  ];
  for (const route of routes) {
    assert.throws(
      () =>
        decodeEncryptedWalletBackupObjectPutRequest({
          canonicalPayload: valid.payload,
          ...route,
        }),
      /object PUT request is invalid/,
    );
  }
});

test("head CAS decoder binds route, key, parent, generation, head, and references", () => {
  const genesis = headCasPayload({
    generation: 1,
    expectedManifestDigest: null,
  });
  const decoded = decodeEncryptedWalletBackupHeadCasRequest({
    canonicalPayload: genesis.payload,
    routeRealm: REALM,
    routeVaultId: VAULT_ID,
    enrolledRequestAuthPublicKey: PUBLIC_KEY,
  });
  assert.equal(decoded.target.generation, 1);
  assert.equal(decoded.expectedManifestDigest, null);

  const parentDigest = "88".repeat(32);
  const child = headCasPayload({
    generation: 2,
    expectedManifestDigest: parentDigest,
  });
  assert.equal(
    decodeEncryptedWalletBackupHeadCasRequest({
      canonicalPayload: child.payload,
      routeRealm: REALM,
      routeVaultId: VAULT_ID,
      enrolledRequestAuthPublicKey: PUBLIC_KEY,
    }).target.parent?.manifestDigest,
    parentDigest,
  );

  const invalid = [
    mutateTuple(genesis.payload, 3, hexToBytes(parentDigest)),
    headCasPayload({
      generation: 2,
      expectedManifestDigest: null,
    }).payload,
    headCasPayload({
      generation: 2,
      expectedManifestDigest: parentDigest,
      headParentDigest: "99".repeat(32),
    }).payload,
    headCasPayload({
      generation: 1,
      expectedManifestDigest: null,
      referenceDigest: "aa".repeat(32),
    }).payload,
  ];
  for (const payload of invalid) {
    assert.throws(
      () =>
        decodeEncryptedWalletBackupHeadCasRequest({
          canonicalPayload: payload,
          routeRealm: REALM,
          routeVaultId: VAULT_ID,
          enrolledRequestAuthPublicKey: PUBLIC_KEY,
        }),
      /head CAS request is invalid/,
    );
  }
});

test("head CAS route realm, vault, and enrolled key mismatches fail closed", () => {
  const valid = headCasPayload({
    generation: 1,
    expectedManifestDigest: null,
  });
  const bindings = [
    {
      routeRealm: "other",
      routeVaultId: VAULT_ID,
      enrolledRequestAuthPublicKey: PUBLIC_KEY,
    },
    {
      routeRealm: REALM,
      routeVaultId: "66".repeat(32),
      enrolledRequestAuthPublicKey: PUBLIC_KEY,
    },
    {
      routeRealm: REALM,
      routeVaultId: VAULT_ID,
      enrolledRequestAuthPublicKey: "77".repeat(32),
    },
  ];
  for (const binding of bindings) {
    assert.throws(
      () =>
        decodeEncryptedWalletBackupHeadCasRequest({
          canonicalPayload: valid.payload,
          ...binding,
        }),
      /head CAS request is invalid/,
    );
  }
});

test("upload-attempt abort decoder binds the exact route attempt", () => {
  const payload = encodeCanonicalBackupCbor([
    1,
    "upload-attempt-abort",
    hexToBytes(ATTEMPT_ID),
    hexToBytes(TARGET_DIGEST),
  ]);
  assert.deepEqual(
    decodeEncryptedWalletBackupUploadAttemptAbortRequest({
      canonicalPayload: payload,
      routeAttemptId: ATTEMPT_ID,
    }),
    {
      formatVersion: 1,
      uploadAttemptId: ATTEMPT_ID,
      targetManifestDigest: TARGET_DIGEST,
    },
  );
  assert.throws(
    () =>
      decodeEncryptedWalletBackupUploadAttemptAbortRequest({
        canonicalPayload: payload,
        routeAttemptId: "66".repeat(16),
      }),
    /upload-attempt abort request is invalid/,
  );
});

test("operation request maxima reject max plus one without unbounded decoding", () => {
  assert.equal(ENCRYPTED_WALLET_BACKUP_ACCOUNT_REQUEST_MAX_BYTES, 20 * 1_024);
  assert.equal(ENCRYPTED_WALLET_BACKUP_OBJECT_PUT_REQUEST_MAX_BYTES, 272 * 1_024);
  assert.equal(
    encryptedWalletBackupDelegatedPayloadMaximumBytes("object-put"),
    ENCRYPTED_WALLET_BACKUP_OBJECT_PUT_REQUEST_MAX_BYTES,
  );
  assert.equal(
    encryptedWalletBackupDelegatedPayloadMaximumBytes("head-cas"),
    ENCRYPTED_WALLET_BACKUP_HEAD_CAS_REQUEST_MAX_BYTES,
  );
  assert.equal(
    encryptedWalletBackupDelegatedPayloadMaximumBytes("upload-attempt-abort"),
    ENCRYPTED_WALLET_BACKUP_UPLOAD_ATTEMPT_ABORT_REQUEST_MAX_BYTES,
  );
  assert.equal(
    encryptedWalletBackupDelegatedPayloadMaximumBytes("head-get"),
    0,
  );

  const cases = [
    {
      maximum: ENCRYPTED_WALLET_BACKUP_OBJECT_PUT_REQUEST_MAX_BYTES,
      decode: (payload: Uint8Array) =>
        decodeEncryptedWalletBackupObjectPutRequest({
          canonicalPayload: payload,
          routeRealm: REALM,
          routeVaultId: VAULT_ID,
          routeObjectId: OBJECT_ID,
        }),
    },
    {
      maximum: ENCRYPTED_WALLET_BACKUP_HEAD_CAS_REQUEST_MAX_BYTES,
      decode: (payload: Uint8Array) =>
        decodeEncryptedWalletBackupHeadCasRequest({
          canonicalPayload: payload,
          routeRealm: REALM,
          routeVaultId: VAULT_ID,
          enrolledRequestAuthPublicKey: PUBLIC_KEY,
        }),
    },
    {
      maximum: ENCRYPTED_WALLET_BACKUP_UPLOAD_ATTEMPT_ABORT_REQUEST_MAX_BYTES,
      decode: (payload: Uint8Array) =>
        decodeEncryptedWalletBackupUploadAttemptAbortRequest({
          canonicalPayload: payload,
          routeAttemptId: ATTEMPT_ID,
        }),
    },
  ];
  for (const current of cases) {
    assert.throws(
      () => current.decode(new Uint8Array(current.maximum)),
      /request is invalid/,
    );
    assert.throws(
      () => current.decode(new Uint8Array(current.maximum + 1)),
      /request is invalid/,
    );
  }
});

test("noncanonical, trailing, and unknown request tuples fail closed", () => {
  const objectPut = objectPutPayload().payload;
  const headCas = headCasPayload({
    generation: 1,
    expectedManifestDigest: null,
  }).payload;
  const abort = encodeCanonicalBackupCbor([
    1,
    "upload-attempt-abort",
    hexToBytes(ATTEMPT_ID),
    hexToBytes(TARGET_DIGEST),
  ]);

  assert.throws(
    () =>
      decodeEncryptedWalletBackupObjectPutRequest({
        canonicalPayload: mutateTuple(objectPut, 1, "unknown-put"),
        routeRealm: REALM,
        routeVaultId: VAULT_ID,
        routeObjectId: OBJECT_ID,
      }),
    /object PUT request is invalid/,
  );
  assert.throws(
    () =>
      decodeEncryptedWalletBackupHeadCasRequest({
        canonicalPayload: concatenate(headCas, Uint8Array.of(0)),
        routeRealm: REALM,
        routeVaultId: VAULT_ID,
        enrolledRequestAuthPublicKey: PUBLIC_KEY,
      }),
    /head CAS request is invalid/,
  );
  assert.throws(
    () =>
      decodeEncryptedWalletBackupUploadAttemptAbortRequest({
        canonicalPayload: encodeVersionOneNoncanonically(abort),
        routeAttemptId: ATTEMPT_ID,
      }),
    /upload-attempt abort request is invalid/,
  );
});

async function delegatedFixture(input: {
  operation: EncryptedWalletBackupServerRoute["operation"];
  method: EncryptedWalletBackupRequestMethod;
  payload: Uint8Array;
  objectId?: string;
  keyHandle?: EncryptedWalletBackupKeyHandle;
}) {
  const keyHandle = input.keyHandle ?? (await createKeyHandle());
  const route = routeFor(
    input.operation,
    keyHandle.vaultId,
    input.objectId ?? OBJECT_ID,
  );
  const rawTarget = pathFor(route);
  const url = `${ORIGIN}${rawTarget}`;
  const proof =
    input.operation === "enrollment-epoch"
      ? await prepareEncryptedWalletBackupEnrollmentEpochDiscoveryProof({
          keyHandle,
          url,
          issuedAtUnixSeconds: NOW - 1,
          expiresAtUnixSeconds: NOW + 30,
          signal: new AbortController().signal,
          runtime: deterministicRuntime(),
        })
      : await prepareEncryptedWalletBackupRequestProof({
          keyHandle,
          enrollmentEpoch: 3,
          method: input.method,
          url,
          issuedAtUnixSeconds: NOW - 1,
          expiresAtUnixSeconds: NOW + 30,
          payload: input.payload,
          signal: new AbortController().signal,
          runtime: deterministicRuntime(),
        });
  return {
    keyHandle,
    route,
    rawTarget,
    url,
    headerValues: [`BackupV1 ${base64Url(encodeProof(proof))}`],
  };
}

function routeFor(
  operation: EncryptedWalletBackupServerRoute["operation"],
  vaultId: string,
  objectId = OBJECT_ID,
): EncryptedWalletBackupServerRoute {
  const common = { routeRealm: REALM, routeVaultId: vaultId } as const;
  switch (operation) {
    case "enrollment-epoch":
    case "head-get":
    case "head-cas":
      return { operation, ...common };
    case "object-get":
    case "object-put":
    case "object-delete":
      return { operation, ...common, routeObjectId: objectId };
    case "upload-attempt-abort":
      return { operation, ...common, routeAttemptId: ATTEMPT_ID };
  }
}

function delegatedOperations(): readonly EncryptedWalletBackupServerRoute["operation"][] {
  return [
    "enrollment-epoch",
    "head-get",
    "head-cas",
    "object-get",
    "object-put",
    "object-delete",
    "upload-attempt-abort",
  ];
}

function methodForOperation(
  operation: EncryptedWalletBackupServerRoute["operation"],
): EncryptedWalletBackupRequestMethod {
  switch (operation) {
    case "enrollment-epoch":
    case "head-get":
    case "object-get":
      return "GET";
    case "head-cas":
      return "POST";
    case "object-put":
      return "PUT";
    case "object-delete":
    case "upload-attempt-abort":
      return "DELETE";
  }
}

function payloadForOperation(
  operation: EncryptedWalletBackupServerRoute["operation"],
  keyHandle: EncryptedWalletBackupKeyHandle,
): Uint8Array {
  switch (operation) {
    case "enrollment-epoch":
    case "head-get":
    case "object-get":
    case "object-delete":
      return EMPTY;
    case "head-cas":
      return headCasPayload({
        generation: 1,
        expectedManifestDigest: null,
        realm: keyHandle.realm,
        vaultId: keyHandle.vaultId,
        backupPublicKey: keyHandle.requestAuthPublicKey,
      }).payload;
    case "object-put":
      return objectPutPayload({
        realm: keyHandle.realm,
        vaultId: keyHandle.vaultId,
      }).payload;
    case "upload-attempt-abort":
      return encodeCanonicalBackupCbor([
        1,
        "upload-attempt-abort",
        hexToBytes(ATTEMPT_ID),
        hexToBytes(TARGET_DIGEST),
      ]);
  }
}

function pathFor(route: EncryptedWalletBackupServerRoute): string {
  const base = `/v1/encrypted-wallet-backup/realms/${route.routeRealm}/vaults/${route.routeVaultId}`;
  switch (route.operation) {
    case "enrollment-epoch":
      return `${base}/enrollment-epoch`;
    case "head-get":
      return `${base}/head`;
    case "head-cas":
      return `${base}/head:compare-and-swap`;
    case "object-get":
    case "object-put":
    case "object-delete":
      return `${base}/objects/${route.routeObjectId}`;
    case "upload-attempt-abort":
      return `${base}/upload-attempts/${route.routeAttemptId}`;
  }
}

function activeEnrollment(
  keyHandle: EncryptedWalletBackupKeyHandle,
  enrollmentEpoch: number,
): EncryptedWalletBackupServerEnrollment {
  return {
    status: "active",
    realm: keyHandle.realm,
    vaultId: keyHandle.vaultId,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
    enrollmentEpoch,
  };
}

async function createKeyHandle(): Promise<EncryptedWalletBackupKeyHandle> {
  return createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: REALM,
    runtime: deterministicRuntime(),
  });
}

function deterministicRuntime() {
  let counter = 1;
  return {
    subtle: webcrypto.subtle,
    getRandomValues<T extends ArrayBufferView | null>(array: T): T {
      if (array === null) return array;
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(
        counter,
      );
      counter += 1;
      return array;
    },
  };
}

function replayStore(): {
  store: EncryptedWalletBackupReplayStore;
  calls(): number;
} {
  const seen = new Set<string>();
  let count = 0;
  return {
    store: {
      async consumeReplayNonce(input) {
        count += 1;
        if (seen.has(input.replayNonce)) return "replayed";
        seen.add(input.replayNonce);
        return "consumed";
      },
    },
    calls: () => count,
  };
}

function encodeProof(
  value: Awaited<ReturnType<typeof prepareEncryptedWalletBackupRequestProof>>,
): Uint8Array {
  return encodeCanonicalBackupCbor([
    1,
    "backup-request-proof",
    value.realm,
    hexToBytes(value.vaultId),
    hexToBytes(value.requestAuthPublicKey),
    value.enrollmentEpoch,
    value.method,
    value.url,
    value.issuedAtUnixSeconds,
    value.expiresAtUnixSeconds,
    hexToBytes(value.replayNonce),
    value.payloadLength,
    hexToBytes(value.payloadDigest),
    hexToBytes(value.signature),
  ]);
}

function objectPutPayload(input?: {
  kindCode?: 1 | 2;
  realm?: string;
  vaultId?: string;
  objectId?: string;
}): { payload: Uint8Array } {
  const kindCode = input?.kindCode ?? 2;
  const realm = input?.realm ?? REALM;
  const vaultId = input?.vaultId ?? VAULT_ID;
  const objectId = input?.objectId ?? OBJECT_ID;
  const paddedLength = kindCode === 1 ? 262_144 : 65_536;
  const body = new Uint8Array(paddedLength + 28).fill(91);
  const aad = encodeCanonicalBackupCbor([
    1,
    kindCode,
    realm,
    hexToBytes(vaultId),
    hexToBytes(objectId),
    1,
    paddedLength,
  ]);
  const digest = framedDigest(aad, body);
  return {
    payload: encodeCanonicalBackupCbor([
      1,
      "object-put",
      hexToBytes(ATTEMPT_ID),
      kindCode,
      realm,
      hexToBytes(vaultId),
      hexToBytes(objectId),
      1,
      paddedLength,
      digest,
      aad,
      body,
    ]),
  };
}

function headCasPayload(input: {
  generation: number;
  expectedManifestDigest: string | null;
  headParentDigest?: string;
  referenceDigest?: string;
  realm?: string;
  vaultId?: string;
  backupPublicKey?: string;
}): { payload: Uint8Array } {
  const realm = input.realm ?? REALM;
  const vaultId = input.vaultId ?? VAULT_ID;
  const backupPublicKey = input.backupPublicKey ?? PUBLIC_KEY;
  const references = encodeCanonicalBackupCbor([1, "reference-set", [], []]);
  const referenceDigest =
    input.referenceDigest === undefined
      ? sha256(references)
      : hexToBytes(input.referenceDigest);
  const parent =
    input.generation === 1
      ? null
      : [
          input.generation - 1,
          hexToBytes(
            input.headParentDigest ??
              input.expectedManifestDigest ??
              "00".repeat(32),
          ),
        ];
  const head = encodeCanonicalBackupCbor([
    1,
    "manifest-head",
    realm,
    hexToBytes(vaultId),
    hexToBytes(backupPublicKey),
    input.generation,
    parent,
    new Uint8Array(16),
    [],
    [],
    0,
    0,
    referenceDigest,
  ]);
  return {
    payload: encodeCanonicalBackupCbor([
      1,
      "head-cas",
      hexToBytes(ATTEMPT_ID),
      input.expectedManifestDigest === null
        ? null
        : hexToBytes(input.expectedManifestDigest),
      head,
      references,
    ]),
  };
}

function mutateTuple(
  payload: Uint8Array,
  index: number,
  value: unknown,
): Uint8Array {
  const decoded = decode(payload);
  assert.ok(Array.isArray(decoded));
  decoded[index] = value;
  return encodeCanonicalBackupCbor(decoded);
}

function framedDigest(aad: Uint8Array, body: Uint8Array): Uint8Array {
  return sha256
    .create()
    .update(
      Uint8Array.of(
        aad.byteLength >>> 24,
        aad.byteLength >>> 16,
        aad.byteLength >>> 8,
        aad.byteLength,
      ),
    )
    .update(aad)
    .update(body)
    .digest();
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

function encodeVersionOneNoncanonically(canonical: Uint8Array): Uint8Array {
  assert.ok(canonical.byteLength >= 2);
  assert.equal(canonical[1], 1);
  return concatenate(
    concatenate(canonical.subarray(0, 1), Uint8Array.of(0x18, 0x01)),
    canonical.subarray(2),
  );
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}
