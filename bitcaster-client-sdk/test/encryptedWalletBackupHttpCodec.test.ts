import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { encode, rfc8949EncodeOptions } from "cborg";
import { createEncryptedWalletBackupKeyHandle } from "../src/encryptedWalletBackup.ts";
import {
  encodeCanonicalBackupCbor,
  structurallyPreflightEncryptedBackupAccountRequestCbor,
  structurallyPreflightEncryptedBackupAttemptAbortCbor,
} from "../src/encryptedWalletBackupCbor.ts";
import {
  executeEncryptedWalletBackupAccountOperation,
  prepareEncryptedWalletBackupAccountOperation,
} from "../src/encryptedWalletBackupEnrollment.ts";
import {
  decodeEncryptedWalletBackupHttpResponse,
  encodeEncryptedWalletBackupHttpResponse,
  encryptedWalletBackupHttpResponseMaximumBytes,
  type EncryptedWalletBackupHttpOperation,
  type EncryptedWalletBackupHttpResponseContext,
  type EncryptedWalletBackupHttpResponseValue,
} from "../src/encryptedWalletBackupHttpCodec.ts";

const REQUEST_DIGEST = "10".repeat(32);
const OPERATION_ID = "11".repeat(16);
const INTENT_DIGEST = "12".repeat(32);
const VAULT_ID = "13".repeat(32);
const PUBLIC_KEY = "14".repeat(32);
const OBJECT_ID = "15".repeat(16);
const SNAPSHOT_NONCE = "17".repeat(16);
const REALM = "codec-test";
const EXPECTED_PUBLIC_VECTOR_CASES = new Set([
  "account enroll committed active",
  "account revoke committed revoked",
  "account delete committed deleted",
  "account conflict",
  "epoch active",
  "epoch absent",
  "head found",
  "head absent",
  "object absent",
  "PUT stored",
  "PUT already-stored",
  "DELETE deleted",
  "DELETE already-deleted",
  "abort abandoned",
  "abort already-abandoned",
  "abort already-finalized",
  "CAS committed",
  "CAS conflict",
  "error invalid-request",
  "error unauthorized",
  "error not-found",
  "error conflict",
  "error replay-rejected",
  "error quota-exceeded",
  "error rate-limited",
  "error overloaded",
  "error unavailable",
  "inherited generation-1 proof chunk under head generation 2",
  "current generation-2 proof chunk under head generation 2",
  "current generation-2 manifest under head generation 2",
  "future generation-3 proof chunk under head generation 2",
  "stale generation-1 manifest under head generation 2",
  "indefinite array",
  "unknown discriminator",
  "wrong arity",
  "unknown error",
  "illegal retry-after",
  "noncanonical integer",
  "trailing byte",
]);
const OBJECT_CONTEXTS = new Map<
  string,
  EncryptedWalletBackupHttpResponseContext
>();

const REFERENCE_SET = encodeCanonicalBackupCbor([1, "reference-set", [], []]);
const HEAD = encodeCanonicalBackupCbor([
  1,
  "manifest-head",
  REALM,
  hexToBytes(VAULT_ID),
  hexToBytes(PUBLIC_KEY),
  1,
  null,
  hexToBytes(SNAPSHOT_NONCE),
  [],
  [],
  0,
  0,
  sha256(REFERENCE_SET),
]);
const HEAD_GENERATION_2 = encodeCanonicalBackupCbor([
  1,
  "manifest-head",
  REALM,
  hexToBytes(VAULT_ID),
  hexToBytes(PUBLIC_KEY),
  2,
  [1, sha256(HEAD)],
  hexToBytes("18".repeat(16)),
  [],
  [],
  0,
  0,
  sha256(REFERENCE_SET),
]);

test("backup HTTP codec accepts every closed success tuple", () => {
  const cases: readonly {
    value: EncryptedWalletBackupHttpResponseValue;
    context: EncryptedWalletBackupHttpResponseContext;
    check(
      result: ReturnType<typeof decodeEncryptedWalletBackupHttpResponse>,
    ): void;
  }[] = [
    {
      value: {
        kind: "account-result",
        operationId: OPERATION_ID,
        intentDigest: INTENT_DIGEST,
        result: "committed",
        enrollmentEpoch: 1,
        lifecycle: "active",
      },
      context: accountContext("account-enroll"),
      check: (result) => {
        assert.equal(result.operation, "account-enroll");
        assert.equal("authority" in result, false);
        assert.equal(result.result, "committed");
      },
    },
    {
      value: {
        kind: "account-result",
        operationId: OPERATION_ID,
        intentDigest: INTENT_DIGEST,
        result: "conflict",
        enrollmentEpoch: 7,
        lifecycle: "deleted",
      },
      context: accountContext("account-delete"),
      check: (result) => assert.equal(result.result, "conflict"),
    },
    {
      value: {
        kind: "account-result",
        operationId: OPERATION_ID,
        intentDigest: INTENT_DIGEST,
        result: "committed",
        enrollmentEpoch: 2,
        lifecycle: "revoked",
      },
      context: accountContext("account-revoke"),
      check: (result) => assert.equal(result.result, "committed"),
    },
    {
      value: {
        kind: "account-result",
        operationId: OPERATION_ID,
        intentDigest: INTENT_DIGEST,
        result: "committed",
        enrollmentEpoch: 3,
        lifecycle: "deleted",
      },
      context: accountContext("account-delete"),
      check: (result) => assert.equal(result.result, "committed"),
    },
    {
      value: {
        kind: "enrollment-epoch-result",
        requestDigest: REQUEST_DIGEST,
        result: "active",
        enrollmentEpoch: 3,
      },
      context: requestContext("enrollment-epoch"),
      check: (result) => assert.equal(result.result, "active"),
    },
    {
      value: {
        kind: "enrollment-epoch-result",
        requestDigest: REQUEST_DIGEST,
        result: "not-enrolled",
      },
      context: requestContext("enrollment-epoch"),
      check: (result) => assert.equal(result.result, "not-enrolled"),
    },
    {
      value: {
        kind: "head-result",
        requestDigest: REQUEST_DIGEST,
        result: "found",
        enrollmentEpoch: 2,
        canonicalHead: HEAD,
        canonicalReferenceSet: REFERENCE_SET,
      },
      context: requestContextForHead(),
      check: (result) => {
        assert.equal(result.result, "found");
        if (result.result !== "found") throw new Error("expected found head");
        assert.equal(
          bytesToHex(sha256(result.canonicalHead)),
          bytesToHex(sha256(HEAD)),
        );
      },
    },
    {
      value: {
        kind: "head-result",
        requestDigest: REQUEST_DIGEST,
        result: "not-found",
        enrollmentEpoch: 2,
      },
      context: requestContextForHead(),
      check: (result) => assert.equal(result.result, "not-found"),
    },
    {
      value: objectResponse({
        kindCode: 1,
        generation: 1,
        currentHeadGeneration: 2,
      }),
      context: objectContext({ kindCode: 1, currentHeadGeneration: 2 }),
      check: (result) => {
        assert.equal(result.result, "found");
        if (result.result !== "found") throw new Error("expected found object");
        assert.equal(
          result.generation,
          1,
          "inherited proof chunks may predate the head",
        );
        assert.equal(result.encryptedBody.byteLength, 262_172);
      },
    },
    {
      value: {
        kind: "object-result",
        requestDigest: REQUEST_DIGEST,
        result: "not-found",
      },
      context: objectContext({ kindCode: 1, currentHeadGeneration: 2 }),
      check: (result) => assert.equal(result.result, "not-found"),
    },
    ...(["stored", "already-stored"] as const).map((result) => ({
      value: {
        kind: "object-put-result" as const,
        requestDigest: REQUEST_DIGEST,
        result,
      },
      context: requestContext("object-put"),
      check: (
        decoded: ReturnType<typeof decodeEncryptedWalletBackupHttpResponse>,
      ) => assert.equal(decoded.result, result),
    })),
    ...(["deleted", "already-deleted"] as const).map((result) => ({
      value: {
        kind: "object-delete-result" as const,
        requestDigest: REQUEST_DIGEST,
        result,
      },
      context: requestContext("object-delete"),
      check: (
        decoded: ReturnType<typeof decodeEncryptedWalletBackupHttpResponse>,
      ) => {
        assert.equal(decoded.result, result);
        assert.equal(decoded.effectClass, "remote-garbage-maintenance-only");
        assert.equal("authority" in decoded, false);
        assert.equal("receipt" in decoded, false);
        assert.equal("head" in decoded, false);
        assert.equal("eviction" in decoded, false);
      },
    })),
    ...(["abandoned", "already-abandoned", "already-finalized"] as const).map(
      (result) => ({
        value: {
          kind: "upload-attempt-abort-result" as const,
          requestDigest: REQUEST_DIGEST,
          result,
        },
        context: requestContext("upload-attempt-abort"),
        check: (
          decoded: ReturnType<typeof decodeEncryptedWalletBackupHttpResponse>,
        ) => assert.equal(decoded.result, result),
      }),
    ),
    ...(["committed", "conflict"] as const).map((result) => ({
      value: {
        kind: "head-cas-result" as const,
        requestDigest: REQUEST_DIGEST,
        result,
      },
      context: requestContext("head-cas"),
      check: (
        decoded: ReturnType<typeof decodeEncryptedWalletBackupHttpResponse>,
      ) => assert.equal(decoded.result, result),
    })),
  ];

  for (const item of cases) {
    const body = encodeEncryptedWalletBackupHttpResponse(item.value);
    const decoded = decodeEncryptedWalletBackupHttpResponse({
      ...item.context,
      httpStatus: 200,
      body,
    } as Parameters<typeof decodeEncryptedWalletBackupHttpResponse>[0]);
    item.check(decoded);
  }
});

test("committed account lifecycle results cannot cross operation boundaries", () => {
  const cases = [
    ["account-enroll", "revoked"],
    ["account-revoke", "active"],
    ["account-delete", "active"],
  ] as const;
  for (const [operation, lifecycle] of cases) {
    assert.throws(
      () =>
        decodeEncryptedWalletBackupHttpResponse({
          ...accountContext(operation),
          httpStatus: 200,
          body: encodeEncryptedWalletBackupHttpResponse({
            kind: "account-result",
            operationId: OPERATION_ID,
            intentDigest: INTENT_DIGEST,
            result: "committed",
            enrollmentEpoch: 2,
            lifecycle,
          }),
        }),
      /lifecycle/,
      `${operation} must reject ${lifecycle}`,
    );
  }
});

test("semantic absence is a request-bound 200 result and generic 404 has no authority", () => {
  const semanticAbsence = encodeEncryptedWalletBackupHttpResponse({
    kind: "object-result",
    requestDigest: REQUEST_DIGEST,
    result: "not-found",
  });
  assert.equal(
    decodeEncryptedWalletBackupHttpResponse({
      ...objectContext({ kindCode: 1, currentHeadGeneration: 2 }),
      httpStatus: 200,
      body: semanticAbsence,
    }).result,
    "not-found",
  );
  assert.throws(
    () =>
      decodeEncryptedWalletBackupHttpResponse({
        ...objectContext({ kindCode: 1, currentHeadGeneration: 2 }),
        expectedRequestDigest: "ff".repeat(32),
        httpStatus: 200,
        body: semanticAbsence,
      }),
    /request digest/,
  );

  const genericNotFound = decodeEncryptedWalletBackupHttpResponse({
    ...objectContext({ kindCode: 1, currentHeadGeneration: 2 }),
    httpStatus: 404,
    body: encodeEncryptedWalletBackupHttpResponse({
      kind: "error",
      code: "not-found",
      retryAfterSeconds: null,
    }),
  });
  assert.equal(genericNotFound.result, "error");
  assert.equal("authority" in genericNotFound, false);
  assert.equal("retryable" in genericNotFound, false);
  assert.equal("object" in genericNotFound, false);
});

test("head GET binds one complete canonical head/reference unit to its exact context", () => {
  const good = encodeEncryptedWalletBackupHttpResponse({
    kind: "head-result",
    requestDigest: REQUEST_DIGEST,
    result: "found",
    enrollmentEpoch: 2,
    canonicalHead: HEAD,
    canonicalReferenceSet: REFERENCE_SET,
  });
  assert.equal(
    decodeEncryptedWalletBackupHttpResponse({
      ...requestContextForHead(),
      httpStatus: 200,
      body: good,
    }).result,
    "found",
  );
  assert.equal(
    decodeEncryptedWalletBackupHttpResponse({
      ...requestContextForHead(),
      httpStatus: 200,
      body: encodeEncryptedWalletBackupHttpResponse({
        kind: "head-result",
        requestDigest: REQUEST_DIGEST,
        result: "found",
        enrollmentEpoch: 2,
        canonicalHead: HEAD_GENERATION_2,
        canonicalReferenceSet: REFERENCE_SET,
      }),
    }).result,
    "found",
  );

  const mismatchedReferences = encodeCanonicalBackupCbor([
    1,
    "reference-set",
    [[hexToBytes(OBJECT_ID), new Uint8Array(32).fill(0x41)]],
    [],
  ]);
  const rawMismatch = encode(
    [
      1,
      "head-result",
      hexToBytes(REQUEST_DIGEST),
      "found",
      2,
      HEAD,
      mismatchedReferences,
    ],
    rfc8949EncodeOptions,
  );
  assert.throws(
    () =>
      decodeEncryptedWalletBackupHttpResponse({
        ...requestContextForHead(),
        httpStatus: 200,
        body: rawMismatch,
      }),
    /reference set|head/,
  );

  for (const context of [
    { ...requestContextForHead(), expectedRealm: "foreign" },
    { ...requestContextForHead(), expectedVaultId: "aa".repeat(32) },
    { ...requestContextForHead(), expectedBackupPublicKey: "bb".repeat(32) },
  ]) {
    assert.throws(() =>
      decodeEncryptedWalletBackupHttpResponse({
        ...context,
        httpStatus: 200,
        body: good,
      }),
    );
  }
});

test("the operation, HTTP status, error code, and retry-after matrix is closed", () => {
  const operations: readonly EncryptedWalletBackupHttpOperation[] = [
    "account-enroll",
    "account-revoke",
    "account-delete",
    "enrollment-epoch",
    "head-get",
    "object-get",
    "object-put",
    "object-delete",
    "upload-attempt-abort",
    "head-cas",
  ];
  const statusCodes = [400, 401, 404, 409, 429, 503] as const;
  const errorCodes = [
    "invalid-request",
    "unauthorized",
    "not-found",
    "conflict",
    "replay-rejected",
    "quota-exceeded",
    "rate-limited",
    "overloaded",
    "unavailable",
  ] as const;
  const codeForStatus = new Map<number, readonly string[]>([
    [400, ["invalid-request"]],
    [401, ["unauthorized"]],
    [404, ["not-found"]],
    [409, ["conflict", "replay-rejected"]],
    [429, ["rate-limited", "quota-exceeded"]],
    [503, ["overloaded", "unavailable"]],
  ]);

  for (const operation of operations) {
    assert.ok(
      encryptedWalletBackupHttpResponseMaximumBytes(operation, 200) > 0,
    );
    for (const status of statusCodes) {
      assert.equal(
        encryptedWalletBackupHttpResponseMaximumBytes(operation, status),
        128,
      );
    }
  }
  for (const status of [199, 201, 402, 500, 504]) {
    assert.throws(() =>
      encryptedWalletBackupHttpResponseMaximumBytes("object-get", status),
    );
  }

  for (const operation of operations) {
    for (const httpStatus of statusCodes) {
      for (const code of errorCodes) {
        const quotaAllowed =
          code !== "quota-exceeded" ||
          operation === "object-put" ||
          operation === "head-cas";
        const allowed =
          codeForStatus.get(httpStatus)!.includes(code) && quotaAllowed;
        const body = encodeEncryptedWalletBackupHttpResponse({
          kind: "error",
          code,
          retryAfterSeconds: null,
        });
        const run = () =>
          decodeEncryptedWalletBackupHttpResponse({
            ...contextFor(operation),
            httpStatus,
            body,
          } as Parameters<typeof decodeEncryptedWalletBackupHttpResponse>[0]);
        if (allowed) {
          assert.equal(run().result, "error");
        } else {
          assert.throws(run, /HTTP response/);
        }
      }
    }
  }

  for (const code of ["rate-limited", "overloaded", "unavailable"] as const) {
    const status = code === "rate-limited" ? 429 : 503;
    for (const retryAfterSeconds of [null, 1, 3_600] as const) {
      const result = decodeEncryptedWalletBackupHttpResponse({
        ...requestContext("object-put"),
        httpStatus: status,
        body: encodeEncryptedWalletBackupHttpResponse({
          kind: "error",
          code,
          retryAfterSeconds,
        }),
      });
      assert.equal(result.retryAfterSeconds, retryAfterSeconds);
    }
  }
  for (const retryAfterSeconds of [0, 3_601, -1, 1.5]) {
    assert.throws(
      () =>
        encodeEncryptedWalletBackupHttpResponse({
          kind: "error",
          code: "rate-limited",
          retryAfterSeconds,
        }),
      /retry-after/,
    );
  }
  assert.throws(
    () =>
      encodeEncryptedWalletBackupHttpResponse({
        kind: "error",
        code: "conflict",
        retryAfterSeconds: 1,
      }),
    /retry-after/,
  );
});

test("object GET strictly binds AAD, identity, digest, and head generation", () => {
  const inherited = objectResponse({
    kindCode: 1,
    generation: 1,
    currentHeadGeneration: 2,
  });
  const inheritedBody = encodeEncryptedWalletBackupHttpResponse(inherited);
  assert.equal(
    decodeEncryptedWalletBackupHttpResponse({
      ...objectContext({ kindCode: 1, currentHeadGeneration: 2 }),
      httpStatus: 200,
      body: inheritedBody,
    }).result,
    "found",
  );

  const manifest = objectResponse({
    kindCode: 2,
    generation: 2,
    currentHeadGeneration: 2,
  });
  assert.equal(
    decodeEncryptedWalletBackupHttpResponse({
      ...objectContext({ kindCode: 2, currentHeadGeneration: 2 }),
      httpStatus: 200,
      body: encodeEncryptedWalletBackupHttpResponse(manifest),
    }).result,
    "found",
  );

  const failures: readonly [
    string,
    EncryptedWalletBackupHttpResponseValue,
    EncryptedWalletBackupHttpResponseContext,
  ][] = [
    [
      "future proof generation",
      objectResponse({ kindCode: 1, generation: 3, currentHeadGeneration: 2 }),
      objectContext({ kindCode: 1, currentHeadGeneration: 2 }),
    ],
    [
      "old manifest generation",
      objectResponse({ kindCode: 2, generation: 1, currentHeadGeneration: 2 }),
      objectContext({ kindCode: 2, currentHeadGeneration: 2 }),
    ],
    [
      "wrong expected digest",
      inherited,
      {
        ...objectContext({ kindCode: 1, currentHeadGeneration: 2 }),
        expectedObjectDigest: "ee".repeat(32),
      },
    ],
    [
      "wrong expected object ID",
      inherited,
      {
        ...objectContext({ kindCode: 1, currentHeadGeneration: 2 }),
        expectedObjectId: "ef".repeat(16),
      },
    ],
  ];
  for (const [name, value, context] of failures) {
    assert.throws(
      () =>
        decodeEncryptedWalletBackupHttpResponse({
          ...context,
          httpStatus: 200,
          body: encodeEncryptedWalletBackupHttpResponse(value),
        } as Parameters<typeof decodeEncryptedWalletBackupHttpResponse>[0]),
      undefined,
      name,
    );
  }

  const wrongAad = objectResponse({
    kindCode: 1,
    generation: 1,
    currentHeadGeneration: 2,
  });
  if (wrongAad.kind !== "object-result" || wrongAad.result !== "found")
    throw new Error("fixture");
  const alteredAad = encodeCanonicalBackupCbor([
    1,
    1,
    REALM,
    hexToBytes(VAULT_ID),
    hexToBytes("ab".repeat(16)),
    1,
    262_144,
  ]);
  assert.throws(
    () =>
      decodeEncryptedWalletBackupHttpResponse({
        ...objectContext({ kindCode: 1, currentHeadGeneration: 2 }),
        httpStatus: 200,
        body: encodeEncryptedWalletBackupHttpResponse({
          ...wrongAad,
          aad: alteredAad,
        }),
      }),
    /AAD/,
  );
});

test("strict response preflight rejects hostile and noncanonical CBOR", () => {
  const valid = encodeEncryptedWalletBackupHttpResponse({
    kind: "object-put-result",
    requestDigest: REQUEST_DIGEST,
    result: "stored",
  });
  const wrongValues = [
    [1, "object-put-result", hexToBytes(REQUEST_DIGEST)],
    [1, "object-put-result", hexToBytes(REQUEST_DIGEST), "unknown"],
    [2, "object-put-result", hexToBytes(REQUEST_DIGEST), "stored"],
    [1, "object-put-result", new Uint8Array(31), "stored"],
    [1, "unknown", hexToBytes(REQUEST_DIGEST), "stored"],
    [1, "error", "invalid-request", 1],
    [
      1,
      "head-result",
      hexToBytes(REQUEST_DIGEST),
      "found",
      0,
      HEAD,
      REFERENCE_SET,
    ],
  ];
  for (const value of wrongValues) {
    assert.throws(
      () =>
        decodeEncryptedWalletBackupHttpResponse({
          ...requestContext("object-put"),
          httpStatus: 200,
          body: encode(value, rfc8949EncodeOptions),
        }),
      undefined,
      "wrong tuple must fail closed",
    );
  }

  const noncanonicalVersion = new Uint8Array(valid.byteLength + 1);
  noncanonicalVersion[0] = valid[0]!;
  noncanonicalVersion[1] = 0x18;
  noncanonicalVersion[2] = 0x01;
  noncanonicalVersion.set(valid.subarray(2), 3);
  const hostile = [
    Uint8Array.of(0x9f, 0xff),
    Uint8Array.of(0xa0),
    Uint8Array.of(0xc0, 0x80),
    Uint8Array.of(0xf9, 0x00, 0x00),
    new Uint8Array([...valid, 0]),
    valid.slice(0, -1),
    noncanonicalVersion,
    new Uint8Array(266_273),
  ];
  for (const body of hostile) {
    assert.throws(
      () =>
        decodeEncryptedWalletBackupHttpResponse({
          ...requestContext("object-put"),
          httpStatus: 200,
          body,
        }),
      undefined,
      "hostile CBOR must fail preflight",
    );
  }
});

test("raw hostile object responses and cross-operation substitutions fail closed", () => {
  const base = objectResponse({
    kindCode: 1,
    generation: 1,
    currentHeadGeneration: 2,
  });
  if (base.kind !== "object-result" || base.result !== "found") {
    throw new Error("object fixture is invalid");
  }
  const mutatedBody = base.encryptedBody.slice();
  mutatedBody[mutatedBody.byteLength - 1] ^= 1;
  assert.throws(
    () =>
      decodeEncryptedWalletBackupHttpResponse({
        ...objectContext({ kindCode: 1, currentHeadGeneration: 2 }),
        httpStatus: 200,
        body: encodeRawFoundObjectResponse({
          ...base,
          encryptedBody: mutatedBody,
        }),
      }),
    /digest/,
  );

  const mismatchedAad = encodeCanonicalBackupCbor([
    1,
    1,
    REALM,
    hexToBytes(VAULT_ID),
    hexToBytes(OBJECT_ID),
    2,
    262_144,
  ]);
  const mismatchedDigest = framedDigest(mismatchedAad, base.encryptedBody);
  assert.throws(
    () =>
      decodeEncryptedWalletBackupHttpResponse({
        ...objectContext({ kindCode: 1, currentHeadGeneration: 2 }),
        expectedObjectDigest: mismatchedDigest,
        httpStatus: 200,
        body: encodeRawFoundObjectResponse({
          ...base,
          objectDigest: mismatchedDigest,
          aad: mismatchedAad,
        }),
      }),
    /AAD/,
  );

  const stored = encodeEncryptedWalletBackupHttpResponse({
    kind: "object-put-result",
    requestDigest: REQUEST_DIGEST,
    result: "stored",
  });
  assert.throws(() =>
    decodeEncryptedWalletBackupHttpResponse({
      ...requestContext("head-cas"),
      httpStatus: 200,
      body: stored,
    }),
  );
  assert.throws(
    () =>
      decodeEncryptedWalletBackupHttpResponse({
        operation: "object-put",
        expectedRequestDigest: "ff".repeat(32),
        httpStatus: 200,
        body: stored,
      }),
    /request digest/,
  );
});

test("operation-specific response caps reject a valid tuple for the wrong operation", () => {
  const objectBody = encodeEncryptedWalletBackupHttpResponse(
    objectResponse({ kindCode: 1, generation: 1, currentHeadGeneration: 1 }),
  );
  assert.ok(objectBody.byteLength > 262_144);
  assert.throws(
    () =>
      decodeEncryptedWalletBackupHttpResponse({
        ...requestContext("object-put"),
        httpStatus: 200,
        body: objectBody,
      }),
    /size|operation/,
  );
});

test("account and abort requests have bounded strict CBOR preflights", () => {
  const account = encodeCanonicalBackupCbor([
    1,
    "backup-account-request",
    Uint8Array.of(1),
    hexToBytes(INTENT_DIGEST),
    "test",
    Uint8Array.of(2),
  ]);
  const abort = encodeCanonicalBackupCbor([
    1,
    "upload-attempt-abort",
    hexToBytes(OPERATION_ID),
    hexToBytes(INTENT_DIGEST),
  ]);
  assert.doesNotThrow(() =>
    structurallyPreflightEncryptedBackupAccountRequestCbor(account),
  );
  assert.doesNotThrow(() =>
    structurallyPreflightEncryptedBackupAttemptAbortCbor(abort),
  );
  for (const body of [
    Uint8Array.of(0xa0),
    new Uint8Array([...account, 0]),
    new Uint8Array(20_481),
    encodeCanonicalBackupCbor([
      1,
      "x".repeat(22),
      Uint8Array.of(1),
      hexToBytes(INTENT_DIGEST),
      "test",
      Uint8Array.of(2),
    ]),
  ]) {
    assert.throws(() =>
      structurallyPreflightEncryptedBackupAccountRequestCbor(body),
    );
  }
  for (const body of [
    Uint8Array.of(0x9f, 0xff),
    abort.slice(0, -1),
    new Uint8Array(129),
    encodeCanonicalBackupCbor([
      1,
      "x".repeat(20),
      hexToBytes(OPERATION_ID),
      hexToBytes(INTENT_DIGEST),
    ]),
  ]) {
    assert.throws(() =>
      structurallyPreflightEncryptedBackupAttemptAbortCbor(body),
    );
  }
});

test("account result binding rejects mixups before the durable callback", async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: new Uint8Array(64).fill(7),
    realm: "account-codec",
  });
  const operation = await prepareEncryptedWalletBackupAccountOperation({
    keyHandle,
    action: "enroll",
    url: "https://backup.example.test/v1/encrypted-wallet-backup/realms/account-codec/vaults:enroll",
    operationId: OPERATION_ID,
    expectedEnrollmentEpoch: 0,
    signal: AbortSignal.timeout(60_000),
    authorizationPort: {
      async authorizeBackupAccountOperation() {
        return { scheme: "test", authorization: new Uint8Array([1]) };
      },
    },
  });
  let commits = 0;
  await assert.rejects(
    () =>
      executeEncryptedWalletBackupAccountOperation({
        operation,
        remote: {
          async executeAccountOperation() {
            return {
              status: "committed" as const,
              operationId: "ff".repeat(16),
              intentDigest: operation.intentDigest,
              enrollmentEpoch: 1,
              lifecycle: "active" as const,
            };
          },
        },
        store: {
          async commitAccountOperationResult<T>(
            record: Parameters<
              Parameters<
                typeof executeEncryptedWalletBackupAccountOperation
              >[0]["store"]["commitAccountOperationResult"]
            >[0],
            commit: (stored: typeof record) => T,
          ): Promise<T> {
            commits += 1;
            return commit(record);
          },
        },
      }),
    /operation id/,
  );
  await assert.rejects(
    () =>
      executeEncryptedWalletBackupAccountOperation({
        operation,
        remote: {
          async executeAccountOperation() {
            return {
              status: "committed" as const,
              operationId: operation.operationId,
              intentDigest: "ff".repeat(32),
              enrollmentEpoch: 1,
              lifecycle: "active" as const,
            };
          },
        },
        store: {
          async commitAccountOperationResult<T>(
            record: Parameters<
              Parameters<
                typeof executeEncryptedWalletBackupAccountOperation
              >[0]["store"]["commitAccountOperationResult"]
            >[0],
            commit: (stored: typeof record) => T,
          ): Promise<T> {
            commits += 1;
            return commit(record);
          },
        },
      }),
    /intent digest/,
  );
  assert.equal(commits, 0);
});

test("public JSON vectors freeze every success/error tuple and hostile case", async () => {
  const vectors = JSON.parse(
    await readFile(
      new URL(
        "../../test-vectors/encrypted-wallet-backup-http-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as HttpVectors;
  assert.equal(vectors.version, 1);
  assert.ok(Array.isArray(vectors.canonical));
  assert.ok(Array.isArray(vectors.constructed));
  assert.ok(Array.isArray(vectors.hostileConstructed));
  assert.ok(Array.isArray(vectors.hostile));
  const names = [
    ...vectors.canonical.map((item) => item.name),
    ...vectors.constructed.map((item) => item.name),
    ...vectors.hostileConstructed.map((item) => item.name),
    ...vectors.hostile.map((item) => item.name),
  ];
  assert.equal(
    new Set(names).size,
    names.length,
    "vector names must be unique",
  );
  assert.deepEqual(
    names.slice().sort(),
    [...EXPECTED_PUBLIC_VECTOR_CASES].sort(),
    "public HTTP vector case set must remain complete and exact",
  );
  for (const item of vectors.canonical) {
    const body = hexToBytes(item.cborHex);
    const structured = structuredCanonicalVector(item.name);
    if (structured !== null) {
      assert.deepEqual(
        encodeEncryptedWalletBackupHttpResponse(structured),
        body,
        `${item.name} encoder output must match frozen public CBOR`,
      );
    }
    const decoded = decodeEncryptedWalletBackupHttpResponse({
      ...vectorContext(item),
      httpStatus: item.httpStatus,
      body,
    } as Parameters<typeof decodeEncryptedWalletBackupHttpResponse>[0]);
    assert.equal(decoded.result, item.expectedResult);
  }
  for (const item of vectors.constructed) {
    const body = materializeConstructedVector(item);
    const decoded = decodeEncryptedWalletBackupHttpResponse({
      operation: "object-get",
      expectedRequestDigest: item.requestDigest,
      expectedKindCode: item.kindCode,
      expectedRealm: item.realm,
      expectedVaultId: item.vaultId,
      expectedObjectId: item.objectId,
      expectedObjectDigest: item.objectDigest,
      currentHeadGeneration: item.currentHeadGeneration,
      httpStatus: item.httpStatus,
      body,
    });
    assert.equal(decoded.result, item.expectedResult);
  }
  for (const item of vectors.hostileConstructed) {
    const body = materializeConstructedVector(item);
    assert.throws(
      () =>
        decodeEncryptedWalletBackupHttpResponse({
          operation: "object-get",
          expectedRequestDigest: item.requestDigest,
          expectedKindCode: item.kindCode,
          expectedRealm: item.realm,
          expectedVaultId: item.vaultId,
          expectedObjectId: item.objectId,
          expectedObjectDigest: item.objectDigest,
          currentHeadGeneration: item.currentHeadGeneration,
          httpStatus: item.httpStatus,
          body,
        }),
      /generation/,
      item.name,
    );
  }
  for (const item of vectors.hostile) {
    assert.throws(
      () =>
        decodeEncryptedWalletBackupHttpResponse({
          ...contextFor(item.operation),
          httpStatus: item.httpStatus,
          body: hexToBytes(item.cborHex),
        } as Parameters<typeof decodeEncryptedWalletBackupHttpResponse>[0]),
      undefined,
      item.name,
    );
  }
});

function accountContext(
  operation: "account-enroll" | "account-revoke" | "account-delete",
): EncryptedWalletBackupHttpResponseContext {
  return {
    operation,
    expectedOperationId: OPERATION_ID,
    expectedIntentDigest: INTENT_DIGEST,
  };
}

function requestContext(
  operation: Exclude<
    EncryptedWalletBackupHttpOperation,
    | "account-enroll"
    | "account-revoke"
    | "account-delete"
    | "object-get"
    | "head-get"
  >,
): EncryptedWalletBackupHttpResponseContext {
  return { operation, expectedRequestDigest: REQUEST_DIGEST };
}

function objectContext(input: {
  kindCode: 1 | 2;
  currentHeadGeneration: number;
}): EncryptedWalletBackupHttpResponseContext {
  const cacheKey = `${input.kindCode}:${input.currentHeadGeneration}`;
  const cached = OBJECT_CONTEXTS.get(cacheKey);
  if (cached !== undefined) return cached;
  const generation = input.kindCode === 1 ? 1 : input.currentHeadGeneration;
  const fixture = objectResponse({
    kindCode: input.kindCode,
    generation,
    currentHeadGeneration: input.currentHeadGeneration,
  });
  if (fixture.kind !== "object-result" || fixture.result !== "found") {
    throw new Error("object context fixture is invalid");
  }
  const context: EncryptedWalletBackupHttpResponseContext = Object.freeze({
    operation: "object-get",
    expectedRequestDigest: REQUEST_DIGEST,
    expectedKindCode: input.kindCode,
    expectedRealm: REALM,
    expectedVaultId: VAULT_ID,
    expectedObjectId: OBJECT_ID,
    expectedObjectDigest: fixture.objectDigest,
    currentHeadGeneration: input.currentHeadGeneration,
  });
  OBJECT_CONTEXTS.set(cacheKey, context);
  return context;
}

function contextFor(
  operation: EncryptedWalletBackupHttpOperation,
): EncryptedWalletBackupHttpResponseContext {
  switch (operation) {
    case "account-enroll":
    case "account-revoke":
    case "account-delete":
      return accountContext(operation);
    case "object-get":
      return objectContext({ kindCode: 1, currentHeadGeneration: 2 });
    case "head-get":
      return { ...requestContextForHead(), expectedEnrollmentEpoch: 2 };
    case "enrollment-epoch":
    case "object-put":
    case "object-delete":
    case "upload-attempt-abort":
    case "head-cas":
      return requestContext(operation);
    default:
      return assertNever(operation);
  }
}

function requestContextForHead(): Extract<
  EncryptedWalletBackupHttpResponseContext,
  { operation: "head-get" }
> {
  return {
    operation: "head-get",
    expectedRequestDigest: REQUEST_DIGEST,
    expectedEnrollmentEpoch: 2,
    expectedRealm: REALM,
    expectedVaultId: VAULT_ID,
    expectedBackupPublicKey: PUBLIC_KEY,
  };
}

function objectResponse(input: {
  kindCode: 1 | 2;
  generation: number;
  currentHeadGeneration: number;
}): EncryptedWalletBackupHttpResponseValue {
  void input.currentHeadGeneration;
  const paddedLength = input.kindCode === 1 ? 262_144 : 65_536;
  const aad = encodeCanonicalBackupCbor([
    1,
    input.kindCode,
    REALM,
    hexToBytes(VAULT_ID),
    hexToBytes(OBJECT_ID),
    input.generation,
    paddedLength,
  ]);
  const encryptedBody = new Uint8Array(paddedLength + 28).fill(0x31);
  const objectDigest = framedDigest(aad, encryptedBody);
  return {
    kind: "object-result",
    requestDigest: REQUEST_DIGEST,
    result: "found",
    kindCode: input.kindCode,
    realm: REALM,
    vaultId: VAULT_ID,
    objectId: OBJECT_ID,
    generation: input.generation,
    paddedLength,
    objectDigest,
    aad,
    encryptedBody,
  };
}

function encodeRawFoundObjectResponse(
  value: Extract<
    EncryptedWalletBackupHttpResponseValue,
    { kind: "object-result"; result: "found" }
  >,
): Uint8Array {
  return encodeCanonicalBackupCbor([
    1,
    "object-result",
    hexToBytes(value.requestDigest),
    "found",
    value.kindCode,
    value.realm,
    hexToBytes(value.vaultId),
    hexToBytes(value.objectId),
    value.generation,
    value.paddedLength,
    hexToBytes(value.objectDigest),
    value.aad,
    value.encryptedBody,
  ]);
}

function framedDigest(aad: Uint8Array, body: Uint8Array): string {
  return bytesToHex(
    sha256
      .create()
      .update(uint32be(aad.byteLength))
      .update(aad)
      .update(body)
      .digest(),
  );
}

function uint32be(value: number): Uint8Array {
  return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
}

function vectorContext(
  item: HttpVector,
): EncryptedWalletBackupHttpResponseContext {
  const context = contextFor(item.operation);
  if (item.operation === "object-get" && item.expectedResult === "found") {
    return {
      ...objectContext({
        kindCode: item.objectKindCode ?? 1,
        currentHeadGeneration: item.currentHeadGeneration ?? 2,
      }),
      expectedObjectDigest:
        item.objectDigest ??
        (
          objectResponse({
            kindCode: item.objectKindCode ?? 1,
            generation:
              item.objectKindCode === 2 ? (item.currentHeadGeneration ?? 2) : 1,
            currentHeadGeneration: item.currentHeadGeneration ?? 2,
          }) as Extract<
            EncryptedWalletBackupHttpResponseValue,
            { kind: "object-result"; result: "found" }
          >
        ).objectDigest,
    };
  }
  return context;
}

function assertNever(value: never): never {
  throw new Error(`unhandled operation: ${String(value)}`);
}

function assertConstructedVectorSafe(item: ConstructedHttpVector): void {
  assert.equal(item.operation, "object-get");
  assert.equal(item.httpStatus, 200);
  assert.ok(item.kindCode === 1 || item.kindCode === 2);
  const expectedBodyLength = item.kindCode === 1 ? 262_172 : 65_564;
  assert.ok(Number.isSafeInteger(item.encryptedBodyLength));
  assert.equal(item.encryptedBodyLength, expectedBodyLength);
  assert.ok(item.encryptedBodyLength <= 262_172);
  assert.match(item.encryptedBodyFillHex, /^[0-9a-f]{2}$/);
  assert.ok(Number.isSafeInteger(item.generation) && item.generation >= 1);
  assert.ok(
    Number.isSafeInteger(item.currentHeadGeneration) &&
      item.currentHeadGeneration >= 1,
  );
  assert.match(item.requestDigest, /^[0-9a-f]{64}$/);
  assert.match(item.vaultId, /^[0-9a-f]{64}$/);
  assert.match(item.objectId, /^[0-9a-f]{32}$/);
  assert.match(item.objectDigest, /^[0-9a-f]{64}$/);
  assert.match(item.aadHex, /^(?:[0-9a-f]{2})+$/);
  assert.match(item.cborSha256, /^[0-9a-f]{64}$/);
  assert.ok(Number.isSafeInteger(item.cborLength) && item.cborLength > 0);
  assert.ok(
    item.cborLength <=
      encryptedWalletBackupHttpResponseMaximumBytes("object-get", 200),
  );
}

function materializeConstructedVector(item: ConstructedHttpVector): Uint8Array {
  assertConstructedVectorSafe(item);
  const encryptedBody = new Uint8Array(item.encryptedBodyLength).fill(
    Number.parseInt(item.encryptedBodyFillHex, 16),
  );
  const body = encodeEncryptedWalletBackupHttpResponse({
    kind: "object-result",
    requestDigest: item.requestDigest,
    result: "found",
    kindCode: item.kindCode,
    realm: item.realm,
    vaultId: item.vaultId,
    objectId: item.objectId,
    generation: item.generation,
    paddedLength: item.kindCode === 1 ? 262_144 : 65_536,
    objectDigest: item.objectDigest,
    aad: hexToBytes(item.aadHex),
    encryptedBody,
  });
  assert.equal(body.byteLength, item.cborLength);
  assert.equal(bytesToHex(sha256(body)), item.cborSha256);
  return body;
}

function structuredCanonicalVector(
  name: string,
): EncryptedWalletBackupHttpResponseValue | null {
  switch (name) {
    case "account enroll committed active":
      return {
        kind: "account-result",
        operationId: OPERATION_ID,
        intentDigest: INTENT_DIGEST,
        result: "committed",
        enrollmentEpoch: 1,
        lifecycle: "active",
      };
    case "account revoke committed revoked":
      return {
        kind: "account-result",
        operationId: OPERATION_ID,
        intentDigest: INTENT_DIGEST,
        result: "committed",
        enrollmentEpoch: 2,
        lifecycle: "revoked",
      };
    case "account delete committed deleted":
      return {
        kind: "account-result",
        operationId: OPERATION_ID,
        intentDigest: INTENT_DIGEST,
        result: "committed",
        enrollmentEpoch: 3,
        lifecycle: "deleted",
      };
    case "account conflict":
      return {
        kind: "account-result",
        operationId: OPERATION_ID,
        intentDigest: INTENT_DIGEST,
        result: "conflict",
        enrollmentEpoch: 7,
        lifecycle: "deleted",
      };
    default:
      return null;
  }
}

interface HttpVector {
  name: string;
  operation: EncryptedWalletBackupHttpOperation;
  httpStatus: number;
  cborHex: string;
  expectedResult: string;
  objectKindCode?: 1 | 2;
  currentHeadGeneration?: number;
  objectDigest?: string;
}

interface HttpVectors {
  version: 1;
  canonical: HttpVector[];
  constructed: ConstructedHttpVector[];
  hostileConstructed: ConstructedHttpVector[];
  hostile: Omit<HttpVector, "expectedResult">[];
}

interface ConstructedHttpVector {
  name: string;
  operation: "object-get";
  httpStatus: 200;
  expectedResult: "found" | "reject";
  kindCode: 1 | 2;
  generation: number;
  currentHeadGeneration: number;
  realm: string;
  vaultId: string;
  objectId: string;
  requestDigest: string;
  encryptedBodyFillHex: string;
  encryptedBodyLength: number;
  aadHex: string;
  objectDigest: string;
  cborLength: number;
  cborSha256: string;
}
