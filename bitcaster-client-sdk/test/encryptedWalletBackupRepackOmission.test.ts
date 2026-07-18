import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeDurableCustodyRecord,
  deriveDurableCustodyOperationId,
  deriveDurableCustodyScopeId,
} from "../src/durableCustody.ts";
import { createEncryptedWalletBackupKeyHandle } from "../src/encryptedWalletBackup.ts";
import {
  authenticateEncryptedWalletBackupRepackOmissions,
  deserializeEncryptedWalletBackupRemovalIntent,
  ENCRYPTED_WALLET_BACKUP_REPACK_OMISSION_TRANSACTION_MAX_BYTES,
  measureEncryptedWalletBackupRepackOmissionEvidence,
  prepareEncryptedWalletBackupRemovalIntent,
  serializeEncryptedWalletBackupRemovalIntent,
  type EncryptedWalletBackupRepackOmissionEvidenceStore,
} from "../src/encryptedWalletBackupRepackOmission.ts";
import { readAuthenticatedEncryptedWalletBackupRepackOmission } from "../src/encryptedWalletBackupRepackOmissionAuthority.ts";

const SEED = new Uint8Array(64).fill(7);
const BINDING = {
  parentManifestDigest: "11".repeat(32),
  parentReferenceSetDigest: "22".repeat(32),
  targetGeneration: 2,
  snapshotNonce: "33".repeat(16),
  snapshotId: "snapshot-2",
  snapshotRevision: 2,
  sourceObjectId: "44".repeat(16),
  sourceObjectDigest: "55".repeat(32),
  recordKindCode: 0 as const,
  recordId: "66".repeat(32),
  commitment: "77".repeat(32),
};

test("explicit removal omission requires one exact authenticated committed intent", async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: "repack-removal-test",
  });
  const intent = await prepareEncryptedWalletBackupRemovalIntent({
    keyHandle,
    intentId: "remove-proof-1",
    binding: BINDING,
  });
  assert.deepEqual(
    deserializeEncryptedWalletBackupRemovalIntent(
      serializeEncryptedWalletBackupRemovalIntent(intent),
    ),
    intent,
  );
  const requests = [
    {
      binding: BINDING,
      evidence: {
        kind: "explicit-removal-intent" as const,
        intentId: intent.intentId,
      },
    },
  ];
  const authenticated = await authenticateEncryptedWalletBackupRepackOmissions({
    keyHandle,
    requests,
    store: exactIntentStore(intent),
  });
  assert.deepEqual(authenticated, [
    { recordId: BINDING.recordId, reason: "explicit-removal-intent" },
  ]);

  const authenticationTag = intent.authenticationTag.slice();
  authenticationTag[0] ^= 1;
  await assert.rejects(
    authenticateEncryptedWalletBackupRepackOmissions({
      keyHandle,
      requests,
      store: exactIntentStore({ ...intent, authenticationTag }),
    }),
    /authentication failed/,
  );
});

test("omission evidence callback cannot be skipped, repeated, deferred, or substituted", async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: "repack-removal-callback-test",
  });
  const intent = await prepareEncryptedWalletBackupRemovalIntent({
    keyHandle,
    intentId: "remove-proof-2",
    binding: BINDING,
  });
  const requests = [
    {
      binding: BINDING,
      evidence: {
        kind: "explicit-removal-intent" as const,
        intentId: intent.intentId,
      },
    },
  ];
  for (const mode of ["never", "double", "deferred", "substituted"] as const) {
    const store: EncryptedWalletBackupRepackOmissionEvidenceStore = {
      async withCommittedEncryptedWalletBackupRepackOmissionEvidenceBatch(
        _expected,
        _maximumBytes,
        use,
      ) {
        const evidence = [{ kind: "explicit-removal-intent" as const, intent }];
        if (mode === "never") return { skipped: true };
        if (mode === "deferred")
          return Promise.resolve().then(() => use(evidencePage(evidence)));
        const result = use(evidencePage(evidence));
        if (mode === "double") use(evidencePage(evidence));
        return mode === "substituted" ? { substituted: true } : result;
      },
    };
    await assert.rejects(
      authenticateEncryptedWalletBackupRepackOmissions({
        keyHandle,
        requests,
        store,
      }),
      /callback|exact/,
    );
  }
});

test("a reconciled applied custody operation authorizes its exact spent input", async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: "repack-spent-transition-test",
  });
  const operation = reconciledCustodyRecord(BINDING.recordId);
  const requests = [
    {
      binding: BINDING,
      evidence: {
        kind: "spent-transition" as const,
        operationId: operation.operation.operationId,
      },
    },
  ];
  const [authenticated] =
    await authenticateEncryptedWalletBackupRepackOmissions({
      keyHandle,
      requests,
      store: {
        async withCommittedEncryptedWalletBackupRepackOmissionEvidenceBatch(
          _expected,
          _maximumBytes,
          use,
        ) {
          return use(
            evidencePage([
              {
                kind: "spent-transition",
                operation: structuredClone(operation),
              },
            ]),
          );
        },
      },
    });
  const authority = readAuthenticatedEncryptedWalletBackupRepackOmission(
    authenticated,
    keyHandle,
  );
  assert.equal(authority.authorization.kind, "spent-transition");
  assert.equal(authority.recordId, BINDING.recordId);

  await assert.rejects(
    authenticateEncryptedWalletBackupRepackOmissions({
      keyHandle,
      requests: [
        {
          ...requests[0]!,
          binding: { ...BINDING, recordId: "99".repeat(32) },
        },
      ],
      store: {
        async withCommittedEncryptedWalletBackupRepackOmissionEvidenceBatch(
          _expected,
          _maximumBytes,
          use,
        ) {
          return use(evidencePage([{ kind: "spent-transition", operation }]));
        },
      },
    }),
    /spent transition is invalid/,
  );
});

test("omission evidence enforces exact one-MiB transaction accounting", async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: "repack-omission-byte-bound-test",
  });
  const operation = largeReconciledCustodyRecord();
  const row = { kind: "spent-transition" as const, operation };
  const rowBytes = measureEncryptedWalletBackupRepackOmissionEvidence(row);
  const count =
    Math.floor(
      ENCRYPTED_WALLET_BACKUP_REPACK_OMISSION_TRANSACTION_MAX_BYTES / rowBytes,
    ) + 1;
  assert.ok(count <= operation.operation.reservation.inputs.length);
  const requests = operation.operation.reservation.inputs
    .slice(0, count)
    .map(({ proofId }) => ({
      binding: { ...BINDING, recordId: proofId },
      evidence: {
        kind: "spent-transition" as const,
        operationId: operation.operation.operationId,
      },
    }));
  await assert.rejects(
    authenticateEncryptedWalletBackupRepackOmissions({
      keyHandle,
      requests,
      store: {
        async withCommittedEncryptedWalletBackupRepackOmissionEvidenceBatch(
          _expected,
          maximumBytes,
          use,
        ) {
          assert.equal(
            maximumBytes,
            ENCRYPTED_WALLET_BACKUP_REPACK_OMISSION_TRANSACTION_MAX_BYTES,
          );
          return use({
            evidence: requests.map(() => row),
            serializedBytes: maximumBytes,
          });
        },
      },
    }),
    /exceeds the transaction byte limit/,
  );
});

function exactIntentStore(
  intent: Awaited<ReturnType<typeof prepareEncryptedWalletBackupRemovalIntent>>,
): EncryptedWalletBackupRepackOmissionEvidenceStore {
  return {
    async withCommittedEncryptedWalletBackupRepackOmissionEvidenceBatch(
      _expected,
      _maximumBytes,
      use,
    ) {
      return use(
        evidencePage([
          {
            kind: "explicit-removal-intent",
            intent: structuredClone(intent),
          },
        ]),
      );
    },
  };
}

function evidencePage(
  evidence: Parameters<
    typeof measureEncryptedWalletBackupRepackOmissionEvidence
  >[0][],
) {
  return {
    evidence,
    serializedBytes: evidence.reduce(
      (total, row) =>
        total + measureEncryptedWalletBackupRepackOmissionEvidence(row),
      0,
    ),
  };
}

function reconciledCustodyRecord(proofId: string) {
  const scopeInput = {
    scopeKind: "wallet" as const,
    walletId: "aa".repeat(32),
  };
  const scope = {
    ...scopeInput,
    scopeId: deriveDurableCustodyScopeId(scopeInput),
  };
  const identity = {
    retainedOperationKey: "spent-proof-operation",
    binding: {
      kind: "trade" as const,
      tradeId: "trade-1",
      role: "seller" as const,
      stage: "lock" as const,
    },
  };
  return decodeDurableCustodyRecord({
    schemaVersion: 1,
    revision: 2,
    scope,
    operation: {
      operationId: deriveDurableCustodyOperationId(scope.scopeId, identity),
      retainedOperationKey: identity.retainedOperationKey,
      binding: {
        ...identity.binding,
        sessionId: "session-1",
        immutableTradeFingerprint: "ab".repeat(32),
        hasDependentOperation: false,
      },
      semanticKind: "swap-lock",
      state: "reconciled",
      terminalReplayEvidenceRequired: true,
      custodyContext: {
        normalizedMint: "https://mint.example",
        unit: "sat",
        inventoryAccountId: null,
      },
      reservation: {
        reservationId: "reservation-1",
        parentReservationId: null,
        inputs: [{ proofId, keysetId: "keyset-1", curve: "secp256k1" }],
      },
      exactRequest: {
        requestId: "request-1",
        requestFingerprint: "bc".repeat(32),
        payloadHandle: "payload-1",
        inputProofIds: [proofId],
        outputPlanFingerprint: "cd".repeat(32),
      },
      outputPlan: {
        outputPlanId: "output-plan-1",
        outputPlanFingerprint: "cd".repeat(32),
        outputMaterialHandle: "output-material-1",
      },
      privateMaterial: {
        materialHandle: "private-material-1",
        useId: "trade-1/seller/lock",
        publicFingerprint: "de".repeat(32),
      },
      result: {
        state: "applied",
        resultHandle: "result-1",
        resultFingerprint: "ef".repeat(32),
        outputPlanFingerprint: "cd".repeat(32),
      },
      verification: {
        outputPlanFingerprint: "cd".repeat(32),
        hasOutputs: true,
        keysetBindings: [
          {
            keysetId: "keyset-1",
            curve: "secp256k1",
            keysetFingerprint: "f1".repeat(32),
            requireDleq: true,
          },
        ],
        outputKeysets: [{ keysetId: "keyset-1", curve: "secp256k1" }],
      },
      delivery: {
        deliveryKind: "none",
        deliveryId: null,
        payloadHandle: null,
        payloadFingerprint: null,
        expiresAtMs: null,
        state: "none",
      },
      retry: {
        attempt: 0,
        nextAttemptAtMs: null,
        reason: "none",
      },
      horizon: {
        notBeforeMs: null,
        notAfterMs: 5_000,
        safetyMarginMs: 500,
        keysetExpiryMs: null,
      },
    },
    terminalTombstone: null,
  });
}

function largeReconciledCustodyRecord() {
  const proofIds = Array.from({ length: 45 }, (_, index) =>
    (index + 1).toString(16).padStart(64, "0"),
  );
  const record = structuredClone(reconciledCustodyRecord(proofIds[0]!));
  const keysets = proofIds.map((proofId, index) => ({
    proofId,
    keysetId: `keyset-${index}-${"k".repeat(380)}`,
    curve: "secp256k1" as const,
  }));
  record.operation.reservation.inputs = keysets;
  record.operation.exactRequest.inputProofIds = proofIds;
  record.operation.verification.keysetBindings = keysets.map(
    ({ keysetId, curve }, index) => ({
      keysetId,
      curve,
      keysetFingerprint: (index + 1).toString(16).padStart(64, "0"),
      requireDleq: true,
    }),
  );
  record.operation.verification.outputKeysets = [
    {
      keysetId: keysets[0]!.keysetId,
      curve: keysets[0]!.curve,
    },
  ];
  return decodeDurableCustodyRecord(record);
}
