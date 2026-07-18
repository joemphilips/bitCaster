import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import vector from "../../test-vectors/encrypted-wallet-backup-v1.json" with { type: "json" };
import {
  Amount,
  CheckStateEnum,
  OutputData,
  createHTLCsecret,
  createP2PKsecret,
  getEncodedTokenV4,
  hashToCurve,
  type Proof,
  type ProofState,
} from "@cashu/cashu-ts";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decode } from "cborg";
import {
  planDurableBearerSpendReclaimIntent,
  completeDurableBearerSpendReclaim,
  createDurableBearerSpendDeliveryRecord,
  deriveDurableBearerSpendDeliveryRecordFingerprint,
  issueDurableBearerSpendReclaimCompletionCapability,
  reconcileDurableBearerSpendDelivery,
  reduceDurableBearerSpendReclaimLineage,
  type DurableBearerSpendDeliveryRecord,
} from "../src/durableBearerSpendDelivery.ts";
import {
  createDurableWalletReceiveOperation,
  deriveDurableWalletOperationAuthority,
} from "../src/durableWalletOperation.ts";
import { deriveDurableCustodyArtifactFingerprint } from "../src/durableCustody.ts";
import {
  describeDurableWalletSendToken,
} from "../src/durableWalletSendDelivery.ts";
import {
  createEncryptedWalletBackupKeyHandle,
  decryptEncryptedWalletBackupDataChunk,
  decryptEncryptedWalletBackupManifestPage,
  encodeEncryptedWalletBackupRequestProof,
  packEncryptedWalletBackupDataChunk,
  prepareEncryptedWalletBackupManifest,
  prepareEncryptedWalletBackupManifestHead,
  prepareEncryptedWalletBackupObject,
  prepareEncryptedWalletBackupRequestProof,
  prepareEncryptedWalletBackupPendingSendParent,
  prepareEncryptedWalletBackupPendingSendProgression,
  deriveEncryptedWalletBackupPendingSendRecordId,
  readAuthenticatedEncryptedWalletBackupHead,
  readPreparedEncryptedWalletBackupManifestHead,
  readPreparedEncryptedWalletBackupObject,
  restoreEncryptedWalletBackupPendingSendParent,
  restoreEncryptedWalletBackupPendingSend,
  type EncryptedWalletBackupCommittedPendingSendSnapshot,
  type EncryptedWalletBackupKeyHandle,
  type EncryptedWalletBackupPendingSendProgression,
  type EncryptedWalletBackupSnapshotSealStore,
  type PreparedEncryptedWalletBackupManifest,
  type PreparedEncryptedWalletBackupObject,
  type PreparedEncryptedWalletBackupRecord,
  ENCRYPTED_WALLET_BACKUP_VAULT_STORED_BYTES_MAX,
} from "../src/encryptedWalletBackup.ts";
import { encodeCanonicalBackupCbor } from "../src/encryptedWalletBackupCbor.ts";
import * as EncryptedWalletBackupApi from "../src/encryptedWalletBackup.ts";
import * as PublicSdk from "../src/index.ts";
import { generateFragmentedPendingSendGolden } from "./encryptedWalletBackupPendingSendGolden.ts";
import {
  createMaximumPlannerPendingSendFixture,
  createPendingSendFixture as createPendingParentFixture,
  exactPendingSendSnapshotStore as exactStore,
  pendingSendProof,
  planPendingSendEnvelope,
} from "./encryptedWalletBackupPendingSendFixture.ts";

const KEYSET_ID = "0011223344556677";
const MINT = "https://mint.example";
const POINT =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const SEED = new Uint8Array(64).fill(7);

test("committed pending-send parent round-trips ordered fixed-size fragments", async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: "pending-parent-test",
  });
  const unrelated = { ...proof(900), secret: "ab".repeat(32) };
  const fixture = createPendingParentFixture(256, {
    unselectedProofs: [unrelated],
  });
  const { encodedToken, walletOperation, deliveryRecord, snapshot } = fixture;
  const proofs = fixture.proofs;
  assert.equal(new Set(proofs.map((item) => item.secret)).size, 256);
  const store = exactStore(snapshot);

  const prepared = await prepareEncryptedWalletBackupPendingSendParent({
    keyHandle,
    recordId: snapshot.recordId,
    snapshotStore: store,
  });
  assert.ok(prepared.fragmentCount > 1);
  assert.match(prepared.parentCommitment, /^[0-9a-f]{64}$/);
  assert.equal(prepared.records.length, prepared.fragmentCount);
  const chunkGroups = group(prepared.records, 8);
  assert.ok(chunkGroups.length > 1);
  const chunks = chunkGroups.map(packEncryptedWalletBackupDataChunk);
  const objects = await Promise.all(
    chunks.map((chunk) =>
      prepareEncryptedWalletBackupObject({
        keyHandle,
        chunk,
        generation: 1,
      }),
    ),
  );
  const manifest = await prepareEncryptedWalletBackupManifest({
    keyHandle,
    generation: 1,
    snapshotNonce: new Uint8Array(16).fill(9),
    chunks: chunks.map((chunk, index) => ({ chunk, object: objects[index]! })),
    snapshotStore: exactSnapshotSealStore(),
  });
  assert.equal(manifest.recordCount, prepared.fragmentCount);
  const head = prepareEncryptedWalletBackupManifestHead({
    keyHandle,
    manifest,
    parent: null,
  });
  assert.equal(head.recordCount, prepared.fragmentCount);

  const restoreKeyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: "pending-parent-test",
  });
  const requestProof = await prepareEncryptedWalletBackupRequestProof({
    keyHandle: restoreKeyHandle,
    enrollmentEpoch: 1,
    method: "GET",
    url: "https://backup.example.test/v1/vaults/current-head",
    issuedAtUnixSeconds: 1_000,
    expiresAtUnixSeconds: 1_030,
    payload: new Uint8Array(),
    signal: AbortSignal.timeout(10_000),
  });
  const headEvidence = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle: restoreKeyHandle,
    enrollmentEpoch: 1,
    requestProof,
    remote: {
      async readCurrentHead() {
        return {
          status: "found" as const,
          enrollmentEpoch: 1,
          head: structuredClone(
            readPreparedEncryptedWalletBackupManifestHead(head),
          ),
        };
      },
    },
  });
  const pages = await Promise.all(
    manifest.pages.map((page) =>
      decryptEncryptedWalletBackupManifestPage({
        keyHandle: restoreKeyHandle,
        seed: SEED,
        object: structuredClone(readPreparedEncryptedWalletBackupObject(page)),
        headEvidence,
      }),
    ),
  );
  const remoteChunkObjects = objects.map((object) =>
    structuredClone(readPreparedEncryptedWalletBackupObject(object)),
  );
  const restoredChunks = await Promise.all(
    remoteChunkObjects.map((object) =>
      decryptEncryptedWalletBackupDataChunk({
        keyHandle: restoreKeyHandle,
        seed: SEED,
        object,
      }),
    ),
  );
  const chunkByObjectId = new Map(
    remoteChunkObjects.map((object, index) => [
      object.objectId,
      restoredChunks[index]!,
    ]),
  );
  const remoteEntries = pages
    .flatMap((page) =>
      page.entries
        .filter((entry) => entry.recordKindCode === 1)
        .map((entry) => ({ entry, page })),
    )
    .sort(
      (left, right) => left.entry.fragmentIndex - right.entry.fragmentIndex,
    );
  assert.equal(remoteEntries.length, prepared.fragmentCount);
  const fragmentSelections = remoteEntries.map(({ entry, page }) => ({
    recordId: entry.recordId,
    dataChunk: chunkByObjectId.get(entry.dataObjectId)!,
    manifestPage: page,
  }));
  assert.equal(
    fragmentSelections.every((selection) => selection.dataChunk !== undefined),
    true,
    "every remote fragment must resolve to one decrypted object",
  );
  const restored = restoreEncryptedWalletBackupPendingSendParent({
    keyHandle: restoreKeyHandle,
    headEvidence,
    fragments: fragmentSelections,
  });
  assert.equal(restored.recordId, snapshot.recordId);
  assert.equal(restored.encodedToken, encodedToken);
  assert.equal(
    describeDurableWalletSendToken(restored.encodedToken).tokenDigest,
    describeDurableWalletSendToken(encodedToken).tokenDigest,
  );
  assert.equal(restored.deliveryRecord.deliveryId, deliveryRecord.deliveryId);
  assert.equal(
    restored.walletOperation.operationId,
    walletOperation.operationId,
  );
  assert.equal(restored.walletOperation.preview.sendOutputs.length, 256);
  assert.equal(restored.deliveryRecord.proofEntries.length, 256);
  assert.equal(
    restored.walletOperation.requestFingerprint,
    deriveDurableWalletOperationAuthority(walletOperation).requestFingerprint,
  );
  assert.equal(
    restored.walletOperation.outputPlanFingerprint,
    deriveDurableWalletOperationAuthority(walletOperation)
      .outputPlanFingerprint,
  );
  assert.equal(
    proofOrderFingerprint(restored.deliveryRecord),
    proofOrderFingerprint(deliveryRecord),
  );
  assert.equal("unselectedProofs" in restored.walletOperation.preview, false);
  assert.equal(restored.walletOperation.preview.unselectedProofCount, 1);
  assert.equal(JSON.stringify(restored).includes(unrelated.secret), false);

  const oversizedSelections = new Proxy(fragmentSelections, {
    get(target, property, receiver) {
      if (property === "length") return 1_025;
      if (property === "map") throw new Error("oversized selection was mapped");
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(
    () =>
      restoreEncryptedWalletBackupPendingSendParent({
        keyHandle: restoreKeyHandle,
        headEvidence,
        fragments: oversizedSelections,
      }),
    /fragment selection count is invalid/,
  );

  assert.throws(
    () =>
      restoreEncryptedWalletBackupPendingSendParent({
        keyHandle: restoreKeyHandle,
        headEvidence,
        fragments: fragmentSelections.slice(1),
      }),
    /fragment set is invalid/,
  );
  assert.throws(
    () =>
      restoreEncryptedWalletBackupPendingSendParent({
        keyHandle: restoreKeyHandle,
        headEvidence,
        fragments: [fragmentSelections[0]!, ...fragmentSelections],
      }),
    /fragment set is invalid/,
  );
  assert.throws(
    () =>
      restoreEncryptedWalletBackupPendingSendParent({
        keyHandle: restoreKeyHandle,
        headEvidence,
        fragments: [
          fragmentSelections[1]!,
          fragmentSelections[0]!,
          ...fragmentSelections.slice(2),
        ],
      }),
    /fragment set is invalid/,
  );
  assert.throws(
    () =>
      restoreEncryptedWalletBackupPendingSendParent({
        keyHandle: restoreKeyHandle,
        headEvidence,
        fragments: [
          {
            ...fragmentSelections[0]!,
            dataChunk: restoredChunks.at(-1)!,
          },
          ...fragmentSelections.slice(1),
        ],
      }),
    /membership is invalid/,
  );
  const tamperedObject = structuredClone(remoteChunkObjects[0]!);
  tamperedObject.body[20] ^= 1;
  await assert.rejects(
    () =>
      decryptEncryptedWalletBackupDataChunk({
        keyHandle: restoreKeyHandle,
        seed: SEED,
        object: tamperedObject,
      }),
    /corrupt encrypted wallet backup object/,
  );
});

test("fragmented partial child round-trips only with its exact parent", async () => {
  const realm = "pending-child-test";
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm,
  });
  const fixture = createPendingParentFixture(256);
  const parent = await prepareEncryptedWalletBackupPendingSendParent({
    keyHandle,
    recordId: fixture.snapshot.recordId,
    snapshotStore: exactStore(fixture.snapshot),
  });
  const partialRecord = await reconcileFixtureDelivery(
    fixture.deliveryRecord,
    Array.from({ length: 256 }, (_, index) =>
      index % 2 === 0 ? CheckStateEnum.SPENT : CheckStateEnum.UNSPENT,
    ),
  );
  const childSnapshot = {
    ...fixture.snapshot,
    progression: "partial" as const,
    parentCommitment: parent.parentCommitment,
    deliveryRecord: partialRecord,
  };
  const child = await prepareEncryptedWalletBackupPendingSendProgression({
    keyHandle,
    recordId: childSnapshot.recordId,
    snapshotStore: exactStore(childSnapshot),
  });
  assert.ok(child.fragmentCount > 1);

  const remote = await roundTripPendingRecords({
    keyHandle,
    realm,
    records: [...parent.records, ...child.records],
  });
  const parentSelections = pendingSelections(remote, 1);
  const childSelections = pendingSelections(remote, 2);
  const restored = restoreEncryptedWalletBackupPendingSend({
    keyHandle: remote.restoreKeyHandle,
    headEvidence: remote.headEvidence,
    parentFragments: parentSelections,
    progressionFragments: childSelections,
  });
  assert.equal(restored.progression?.progression, "partial");
  assert.equal(
    restored.progression?.logicalRecordId,
    restored.parent.logicalRecordId,
  );
  assert.equal(
    restored.progression?.parentCommitment,
    restored.parent.parentCommitment,
  );
  assert.equal(
    restored.progression?.deliveryRecord.deliveryId,
    restored.parent.deliveryRecord.deliveryId,
  );
  assert.equal(restored.parent.encodedToken, fixture.encodedToken);
  assert.equal(
    deriveDurableBearerSpendDeliveryRecordFingerprint(restored.deliveryRecord),
    deriveDurableBearerSpendDeliveryRecordFingerprint(
      restoredNonterminalRecord(partialRecord),
    ),
  );
  assert.deepEqual(
    restored.deliveryRecord.proofEntries.map((entry) => entry.kind),
    Array.from({ length: 256 }, (_, index) =>
      index % 2 === 0 ? "spent" : "active",
    ),
  );

  const parentOnly = restoreEncryptedWalletBackupPendingSend({
    keyHandle: remote.restoreKeyHandle,
    headEvidence: remote.headEvidence,
    parentFragments: parentSelections,
    progressionFragments: [],
  });
  const allSpent = await reconcileFixtureDelivery(
    parentOnly.deliveryRecord,
    Array.from({ length: 256 }, () => CheckStateEnum.SPENT),
  );
  assert.equal(parentOnly.deliveryRecord.origin, "restored");
  assert.equal(allSpent.state.kind, "consumed");
  if (allSpent.state.kind === "consumed") {
    assert.equal(allSpent.state.actor, "unknown");
  }

  assert.throws(
    () =>
      restoreEncryptedWalletBackupPendingSend({
        keyHandle: remote.restoreKeyHandle,
        headEvidence: remote.headEvidence,
        parentFragments: parentSelections,
        progressionFragments: [childSelections[0]!, ...childSelections],
      }),
    /fragment set is invalid/,
  );
  assert.throws(
    () =>
      restoreEncryptedWalletBackupPendingSend({
        keyHandle: remote.restoreKeyHandle,
        headEvidence: remote.headEvidence,
        parentFragments: parentSelections,
        progressionFragments: childSelections.slice(1),
      }),
    /fragment set is invalid/,
  );
  assert.throws(
    () =>
      restoreEncryptedWalletBackupPendingSend({
        keyHandle: remote.restoreKeyHandle,
        headEvidence: remote.headEvidence,
        parentFragments: parentSelections,
        progressionFragments: [
          childSelections[1]!,
          childSelections[0]!,
          ...childSelections.slice(2),
        ],
      }),
    /fragment set is invalid/,
  );
  assert.throws(
    () =>
      restoreEncryptedWalletBackupPendingSend({
        keyHandle: remote.restoreKeyHandle,
        headEvidence: remote.headEvidence,
        parentFragments: parentSelections,
        progressionFragments: [
          { ...childSelections[0]!, recordId: parentSelections[0]!.recordId },
          ...childSelections.slice(1),
        ],
      }),
    /membership is invalid/,
  );

  const childObjectId = remote.pages
    .flatMap((page) => page.entries)
    .find((entry) => entry.recordKindCode === 2)!.dataObjectId;
  const tamperedChildObject = structuredClone(
    remote.wireObjects.find((object) => object.objectId === childObjectId)!,
  );
  tamperedChildObject.body[20] ^= 1;
  await assert.rejects(
    () =>
      decryptEncryptedWalletBackupDataChunk({
        keyHandle: remote.restoreKeyHandle,
        seed: SEED,
        object: tamperedChildObject,
      }),
    /corrupt encrypted wallet backup object/,
  );
});

test("manifest rejects child-only and multiple progression authorities", async () => {
  const realm = "pending-child-manifest-attack-test";
  const keyHandle = await createEncryptedWalletBackupKeyHandle({ seed: SEED, realm });
  const fixture = createPendingParentFixture(2);
  const parent = await prepareEncryptedWalletBackupPendingSendParent({
    keyHandle,
    recordId: fixture.snapshot.recordId,
    snapshotStore: exactStore(fixture.snapshot),
  });
  const progressions = await reducerDerivedProgressions(fixture);
  const children = await Promise.all(
    (["partial", "recipient-finalization"] as const).map((progression) =>
      prepareEncryptedWalletBackupPendingSendProgression({
        keyHandle,
        recordId: fixture.snapshot.recordId,
        snapshotStore: exactStore({
          ...fixture.snapshot,
          progression,
          parentCommitment: parent.parentCommitment,
          deliveryRecord: progressions.get(progression)!,
        }),
      }),
    ),
  );
  await assert.rejects(
    () => roundTripPendingRecords({ keyHandle, realm, records: children[0]!.records }),
    /progression manifest is invalid/,
  );
  await assert.rejects(
    () =>
      roundTripPendingRecords({
        keyHandle,
        realm,
        records: [...parent.records, ...children.flatMap(({ records }) => records)],
      }),
    /fragmented manifest is invalid/,
  );
});

test("generic parent-child data-chunk PUT and delegated-auth vector is exact", async () => {
  const expected = vector.expected.genericDataChunkPut;
  const realm = "generic-data-chunk-vector";
  const keyHandle = await createEncryptedWalletBackupKeyHandle({ seed: SEED, realm });
  const fixture = createPendingParentFixture(2);
  const parent = await prepareEncryptedWalletBackupPendingSendParent({
    keyHandle,
    recordId: fixture.snapshot.recordId,
    snapshotStore: exactStore(fixture.snapshot),
  });
  const partial = (await reducerDerivedProgressions(fixture)).get("partial")!;
  const child = await prepareEncryptedWalletBackupPendingSendProgression({
    keyHandle,
    recordId: fixture.snapshot.recordId,
    snapshotStore: exactStore({
      ...fixture.snapshot,
      progression: "partial",
      parentCommitment: parent.parentCommitment,
      deliveryRecord: partial,
    }),
  });
  const object = await prepareEncryptedWalletBackupObject({
    keyHandle,
    chunk: packEncryptedWalletBackupDataChunk([...parent.records, ...child.records]),
    generation: 1,
    runtime: deterministicBackupRuntime([
      new Uint8Array(16).fill(0x91),
      new Uint8Array(12).fill(0x92),
    ]),
  });
  const wire = readPreparedEncryptedWalletBackupObject(object);
  const attemptId = "93".repeat(16);
  const canonicalPutPayload = encodeCanonicalBackupCbor([
    1,
    "object-put",
    Uint8Array.from(Buffer.from(attemptId, "hex")),
    wire.kindCode,
    wire.realm,
    Uint8Array.from(Buffer.from(wire.vaultId, "hex")),
    Uint8Array.from(Buffer.from(wire.objectId, "hex")),
    wire.generation,
    wire.paddedLength,
    Uint8Array.from(Buffer.from(wire.digest, "hex")),
    wire.aad,
    wire.body,
  ]);
  const url = `https://backup.example.test/v1/encrypted-wallet-backup/realms/${realm}/vaults/${wire.vaultId}/objects/${wire.objectId}`;
  const requestProof = await prepareEncryptedWalletBackupRequestProof({
    keyHandle,
    enrollmentEpoch: 7,
    method: "PUT",
    url,
    issuedAtUnixSeconds: 1_700_000_100,
    expiresAtUnixSeconds: 1_700_000_130,
    payload: canonicalPutPayload,
    signal: AbortSignal.timeout(60_000),
    runtime: deterministicBackupRuntime([
      new Uint8Array(16).fill(0x94),
      new Uint8Array(32).fill(0x95),
    ]),
  });
  assert.equal(wire.realm, expected.realm);
  assert.equal(wire.vaultId, expected.vaultIdHex);
  assert.equal(keyHandle.requestAuthPublicKey, expected.backupPublicKeyHex);
  assert.equal(wire.generation, expected.generation);
  assert.equal(parent.records.length + child.records.length, expected.recordCount);
  assert.equal(parent.parentCommitment, expected.parentCommitmentHex);
  assert.equal(child.childCommitment, expected.childCommitmentHex);
  assert.equal(attemptId, expected.attemptIdHex);
  assert.equal(wire.objectId, expected.objectIdHex);
  assert.equal(wire.digest, expected.objectDigestHex);
  const expectedPut = decode(
    Uint8Array.from(Buffer.from(expected.canonicalPutPayloadHex, "hex")),
  ) as unknown[];
  assert.equal(
    Buffer.from(wire.aad).equals(Buffer.from(expectedPut[10] as Uint8Array)),
    true,
    "generic data-chunk AAD changed",
  );
  assert.equal(
    Buffer.from(wire.body).equals(Buffer.from(expectedPut[11] as Uint8Array)),
    true,
    "generic data-chunk body changed",
  );
  assert.equal(
    Buffer.from(canonicalPutPayload).toString("hex") ===
      expected.canonicalPutPayloadHex,
    true,
    "generic data-chunk PUT payload changed",
  );
  assert.equal(url, expected.objectUrl);
  assert.equal(requestProof.enrollmentEpoch, expected.enrollmentEpoch);
  assert.equal(requestProof.issuedAtUnixSeconds, expected.issuedAtUnixSeconds);
  assert.equal(requestProof.expiresAtUnixSeconds, expected.expiresAtUnixSeconds);
  assert.equal(requestProof.payloadDigest, expected.requestPayloadDigestHex);
  assert.equal(requestProof.signature, expected.requestSignatureHex);
  assert.equal(
    Buffer.from(encodeEncryptedWalletBackupRequestProof(requestProof)).toString(
      "hex",
    ) === expected.requestProofCborHex,
    true,
    "generic data-chunk delegated request proof changed",
  );
});

test("fragmented multi-data-chunk pending-send golden summary is exact", async () => {
  const actual = await generateFragmentedPendingSendGolden();
  assert.equal(
    isDeepStrictEqual(actual, vector.expected.fragmentedPendingSend),
    true,
    "fragmented pending-send golden summary changed",
  );
  assert.ok(actual.parentFragmentCount > 1);
  assert.ok(actual.dataChunkCount > 1);
});

test("every closed child progression is produced by the bearer reducers", async () => {
  const realm = "pending-child-progression-test";
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm,
  });
  const fixture = createPendingParentFixture(2);
  const parent = await prepareEncryptedWalletBackupPendingSendParent({
    keyHandle,
    recordId: fixture.snapshot.recordId,
    snapshotStore: exactStore(fixture.snapshot),
  });
  const progressionRecords = await reducerDerivedProgressions(fixture);
  for (const [progression, deliveryRecord] of progressionRecords) {
    const snapshot = {
      ...fixture.snapshot,
      progression,
      parentCommitment: parent.parentCommitment,
      deliveryRecord,
    };
    const child = await prepareEncryptedWalletBackupPendingSendProgression({
      keyHandle,
      recordId: snapshot.recordId,
      snapshotStore: exactStore(snapshot),
    });
    const remote = await roundTripPendingRecords({
      keyHandle,
      realm,
      records: [...parent.records, ...child.records],
    });
    const restored = restoreEncryptedWalletBackupPendingSend({
      keyHandle: remote.restoreKeyHandle,
      headEvidence: remote.headEvidence,
      parentFragments: pendingSelections(remote, 1),
      progressionFragments: pendingSelections(remote, 2),
    });
    assert.equal(restored.progression?.progression, progression);
    assert.equal(
      deriveDurableBearerSpendDeliveryRecordFingerprint(
        restored.deliveryRecord,
      ),
      deriveDurableBearerSpendDeliveryRecordFingerprint(
        progression === "cancellation-intent" || progression === "partial"
          ? restoredNonterminalRecord(deliveryRecord)
          : deliveryRecord,
      ),
    );
  }
});

test("restored nonterminal children cannot attribute a later all-spent observation", async () => {
  const realm = "pending-child-stale-authority-test";
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm,
  });
  const fixture = createPendingParentFixture(2);
  const parent = await prepareEncryptedWalletBackupPendingSendParent({
    keyHandle,
    recordId: fixture.snapshot.recordId,
    snapshotStore: exactStore(fixture.snapshot),
  });
  const progressions = await reducerDerivedProgressions(fixture);

  for (const progression of ["cancellation-intent", "partial"] as const) {
    const child = await prepareEncryptedWalletBackupPendingSendProgression({
      keyHandle,
      recordId: fixture.snapshot.recordId,
      snapshotStore: exactStore({
        ...fixture.snapshot,
        progression,
        parentCommitment: parent.parentCommitment,
        deliveryRecord: progressions.get(progression)!,
      }),
    });
    const remote = await roundTripPendingRecords({
      keyHandle,
      realm,
      records: [...parent.records, ...child.records],
    });
    const restored = restoreEncryptedWalletBackupPendingSend({
      keyHandle: remote.restoreKeyHandle,
      headEvidence: remote.headEvidence,
      parentFragments: pendingSelections(remote, 1),
      progressionFragments: pendingSelections(remote, 2),
    });
    const allSpent = await reconcileFixtureDelivery(
      restored.deliveryRecord,
      restored.deliveryRecord.proofEntries
        .filter((entry) => entry.kind === "active")
        .map(() => CheckStateEnum.SPENT),
    );
    assert.equal(allSpent.state.kind, "consumed");
    if (allSpent.state.kind === "consumed") {
      assert.equal(allSpent.state.actor, "unknown");
    }
  }
});

test("restored terminal children preserve their authenticated completion actor", async () => {
  const realm = "pending-child-terminal-authority-test";
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm,
  });
  const fixture = createPendingParentFixture(2);
  const parent = await prepareEncryptedWalletBackupPendingSendParent({
    keyHandle,
    recordId: fixture.snapshot.recordId,
    snapshotStore: exactStore(fixture.snapshot),
  });
  const progressions = await reducerDerivedProgressions(fixture);
  const expectedActors = new Map([
    ["recipient-finalization", "recipient"],
    ["reclaim-completion", "sender-reclaim"],
  ] as const);

  for (const [progression, expectedActor] of expectedActors) {
    const child = await prepareEncryptedWalletBackupPendingSendProgression({
      keyHandle,
      recordId: fixture.snapshot.recordId,
      snapshotStore: exactStore({
        ...fixture.snapshot,
        progression,
        parentCommitment: parent.parentCommitment,
        deliveryRecord: progressions.get(progression)!,
      }),
    });
    const remote = await roundTripPendingRecords({
      keyHandle,
      realm,
      records: [...parent.records, ...child.records],
    });
    const restored = restoreEncryptedWalletBackupPendingSend({
      keyHandle: remote.restoreKeyHandle,
      headEvidence: remote.headEvidence,
      parentFragments: pendingSelections(remote, 1),
      progressionFragments: pendingSelections(remote, 2),
    });
    assert.equal(restored.deliveryRecord.state.kind, "consumed");
    if (restored.deliveryRecord.state.kind === "consumed") {
      assert.equal(restored.deliveryRecord.state.actor, expectedActor);
    }
  }
});

test("public package exposes only the combined authenticated pending-send restore", () => {
  for (const api of [PublicSdk, EncryptedWalletBackupApi]) {
    assert.equal("bindEncryptedWalletBackupPendingSendRestore" in api, false);
    assert.equal(
      "restoreEncryptedWalletBackupPendingSendProgression" in api,
      false,
    );
    assert.equal("restoreEncryptedWalletBackupPendingSend" in api, true);
  }
});

test("maximum planner-reachable parent and child stay inside every backup bound", async () => {
  const realm = "pending-maximum-envelope-test";
  const maximum = createMaximumPlannerPendingSendFixture();
  const fixture = maximum.fixture;
  assert.equal(fixture.walletOperation.preview.sendOutputs.length, 256);
  assert.equal(
    fixture.walletOperation.preview.unselectedProofs.length,
    maximum.unselectedProofCount,
  );
  assert.equal(maximum.unselectedProofCount, 144);
  assert.equal(maximum.outputSecretPaddingBytes, 2);
  assert.throws(
    () =>
      planPendingSendEnvelope(
        256,
        Array.from({ length: 145 }, (_, index) => pendingSendProof(4_000 + index)),
        0,
      ),
    /storage limit/,
  );
  assert.throws(
    () =>
      planPendingSendEnvelope(
        256,
        Array.from({ length: 144 }, (_, index) => pendingSendProof(4_000 + index)),
        3,
      ),
    /storage limit/,
  );
  assert.throws(
    () => planPendingSendEnvelope(257, [], 0),
    /proof count limit/,
  );

  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm,
  });
  const parent = await prepareEncryptedWalletBackupPendingSendParent({
    keyHandle,
    recordId: fixture.snapshot.recordId,
    snapshotStore: exactStore(structuredClone(fixture.snapshot)),
  });
  const partialRecord = await reconcileFixtureDelivery(
    fixture.deliveryRecord,
    fixture.proofs.map((_, index) =>
      index === 0 ? CheckStateEnum.SPENT : CheckStateEnum.UNSPENT,
    ),
  );
  const childSnapshot = {
    ...structuredClone(fixture.snapshot),
    progression: "partial" as const,
    parentCommitment: parent.parentCommitment,
    deliveryRecord: partialRecord,
  };
  const child = await prepareEncryptedWalletBackupPendingSendProgression({
    keyHandle,
    recordId: childSnapshot.recordId,
    snapshotStore: exactStore(childSnapshot),
  });
  assert.ok(parent.fragmentCount <= 1_024);
  assert.ok(child.fragmentCount <= 1_024);
  const remote = await roundTripPendingRecords({
    keyHandle,
    realm,
    records: [...parent.records, ...child.records],
  });
  assert.ok(remote.head.storedBytes <= ENCRYPTED_WALLET_BACKUP_VAULT_STORED_BYTES_MAX);
  assert.ok(
    group([...parent.records, ...child.records], 8).every(
      (records) =>
        packEncryptedWalletBackupDataChunk(records).bindings.length <= 8,
    ),
  );
  const restored = restoreEncryptedWalletBackupPendingSend({
    keyHandle: remote.restoreKeyHandle,
    headEvidence: remote.headEvidence,
    parentFragments: pendingSelections(remote, 1),
    progressionFragments: pendingSelections(remote, 2),
  });
  assert.equal(restored.parent.encodedToken, fixture.encodedToken);
  assert.equal(restored.deliveryRecord.proofEntries.length, 256);
  assert.equal(
    deriveDurableBearerSpendDeliveryRecordFingerprint(restored.deliveryRecord),
    deriveDurableBearerSpendDeliveryRecordFingerprint(
      restoredNonterminalRecord(partialRecord),
    ),
  );
  assert.equal(
    restored.parent.walletOperation.requestFingerprint,
    deriveDurableWalletOperationAuthority(fixture.walletOperation)
      .requestFingerprint,
  );
  assert.equal(
    restored.parent.walletOperation.outputPlanFingerprint,
    deriveDurableWalletOperationAuthority(fixture.walletOperation)
      .outputPlanFingerprint,
  );
});

test("pending-send parent rejects modern 01 and 02 conditional keysets", async () => {
  const fixture = createPendingParentFixture(1);
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: "pending-parent-conditional-test",
  });
  const conditionalIds = [
    `01${"11".repeat(7)}`,
    `02${"11".repeat(7)}`,
    `01${"AA".repeat(7)}`,
    `02${"AA".repeat(7)}`,
  ];
  for (const conditionalId of conditionalIds) {
    const operation = structuredClone(fixture.walletOperation);
    Object.assign(operation.preview.inputs[0]!, { id: conditionalId });
    const operationSnapshot = {
      ...fixture.snapshot,
      walletOperation: operation,
    };
    await assert.rejects(
      prepareEncryptedWalletBackupPendingSendParent({
        keyHandle,
        recordId: operationSnapshot.recordId,
        snapshotStore: exactStore(operationSnapshot),
      }),
      /conditional pending-send operation is not backup eligible/,
    );

    const conditionalProofs = fixture.proofs.map((proof) => ({
      ...proof,
      id: conditionalId,
    }));
    const conditionalToken = getEncodedTokenV4({
      mint: MINT,
      unit: "sat",
      proofs: conditionalProofs,
    });
    assert.throws(
      () =>
        createDurableBearerSpendDeliveryRecord({
          deliveryId: fixture.deliveryRecord.deliveryId,
          walletId: fixture.deliveryRecord.walletId,
          parentOperationId: fixture.deliveryRecord.parentOperationId,
          payloadHandle: fixture.deliveryRecord.payloadHandle,
          mintUrl: fixture.deliveryRecord.mintUrl,
          unit: fixture.deliveryRecord.unit,
          encodedToken: conditionalToken,
          proofs: conditionalProofs,
          origin: "local",
          createdAtMs: fixture.deliveryRecord.createdAtMs,
        }),
      /durable bearer proof vector is invalid/,
    );
  }
});

test("pending-send parent binds the seed-derived vault to both custody scopes", async () => {
  const fixture = createPendingParentFixture(1);
  const foreignKey = await createEncryptedWalletBackupKeyHandle({
    seed: new Uint8Array(64).fill(8),
    realm: "pending-parent-seed-binding-test",
  });
  await assert.rejects(
    prepareEncryptedWalletBackupPendingSendParent({
      keyHandle: foreignKey,
      recordId: fixture.snapshot.recordId,
      snapshotStore: exactStore(fixture.snapshot),
    }),
    /snapshot identity is invalid/,
  );
});

test("pending-send parent rejects requested and persisted row identity mismatch", async () => {
  const fixture = createPendingParentFixture(1);
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: "pending-parent-row-binding-test",
  });
  await assert.rejects(
    prepareEncryptedWalletBackupPendingSendParent({
      keyHandle,
      recordId: "f".repeat(64),
      snapshotStore: {
        async withCommittedPendingSendSnapshot(_recordId, read) {
          return read(fixture.snapshot);
        },
      },
    }),
    /snapshot identity is invalid/,
  );
});

test("pending-send parent rejects real P2PK and HTLC secrets on every bearer surface", async () => {
  const fixture = createPendingParentFixture(1);
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: "pending-parent-secret-test",
  });
  const conditionalSecrets = [
    createP2PKsecret(POINT),
    createHTLCsecret("11".repeat(32)),
    JSON.stringify(["P2PK", {}]),
    JSON.stringify(["HTLC", null]),
    JSON.stringify(["P2PK"]),
    JSON.stringify(["HTLC", null, "extra"]),
    JSON.stringify([
      "FUTURE_LOCK",
      { nonce: "11".repeat(32), data: "future-condition" },
    ]),
    JSON.stringify(["FUTURE_LOCK", null]),
  ];
  for (const secret of conditionalSecrets) {
    for (const snapshot of conditionalSnapshots(fixture, secret)) {
      await assert.rejects(
        prepareEncryptedWalletBackupPendingSendParent({
          keyHandle,
          recordId: snapshot.recordId,
          snapshotStore: exactStore(snapshot),
        }),
        /conditional pending-send/,
      );
    }
  }
});

test("pending-send parent binds stable row identity to the custody parent operation", async () => {
  const fixture = createPendingParentFixture(1);
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: "pending-parent-operation-binding-test",
  });
  const deliveryRecord = {
    ...fixture.deliveryRecord,
    parentOperationId: "foreign-parent-operation",
  };
  const snapshot = {
    ...fixture.snapshot,
    recordId: deriveEncryptedWalletBackupPendingSendRecordId({
      walletId: deliveryRecord.walletId,
      parentOperationId: deliveryRecord.parentOperationId,
      deliveryId: deliveryRecord.deliveryId,
    }),
    deliveryRecord,
  };
  await assert.rejects(
    prepareEncryptedWalletBackupPendingSendParent({
      keyHandle,
      recordId: snapshot.recordId,
      snapshotStore: exactStore(snapshot),
    }),
    /snapshot identity is invalid/,
  );
});

test("pending-send parent rehydrates exact capabilities after structured-clone restart", async () => {
  const fixture = createPendingParentFixture(1);
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: "pending-parent-clone-test",
  });
  const prepared = await prepareEncryptedWalletBackupPendingSendParent({
    keyHandle,
    recordId: fixture.snapshot.recordId,
    snapshotStore: exactStore(structuredClone(fixture.snapshot)),
  });
  assert.equal(prepared.fragmentCount >= 1, true);
});

function conditionalSnapshots(
  fixture: ReturnType<typeof createPendingParentFixture>,
  secret: string,
): readonly EncryptedWalletBackupCommittedPendingSendSnapshot[] {
  const inputOperation = structuredClone(fixture.walletOperation);
  inputOperation.preview.inputs[0]!.secret = secret;
  const outputOperation = structuredClone(fixture.walletOperation);
  outputOperation.preview.sendOutputs[0]!.secret = bytesToHex(
    new TextEncoder().encode(secret),
  );
  const deliveryRecord = structuredClone(fixture.deliveryRecord);
  const firstEntry = deliveryRecord.proofEntries[0]!;
  if (firstEntry.kind !== "active") throw new Error("invalid test fixture");
  firstEntry.proof.secret = secret;
  return [
    { ...fixture.snapshot, walletOperation: inputOperation },
    { ...fixture.snapshot, walletOperation: outputOperation },
    { ...fixture.snapshot, deliveryRecord },
  ];
}

async function reducerDerivedProgressions(
  fixture: ReturnType<typeof createPendingParentFixture>,
): Promise<
  ReadonlyMap<
    Exclude<EncryptedWalletBackupPendingSendProgression, "parent">,
    DurableBearerSpendDeliveryRecord
  >
> {
  const allUnspent = await reconcileFixtureDelivery(
    fixture.deliveryRecord,
    fixture.proofs.map(() => CheckStateEnum.UNSPENT),
  );
  const intent = planDurableBearerSpendReclaimIntent(allUnspent);
  const cancellation = reduceDurableBearerSpendReclaimLineage(allUnspent, {
    kind: "prepared",
    ...intent,
  });
  const partial = await reconcileFixtureDelivery(
    fixture.deliveryRecord,
    fixture.proofs.map((_, index) =>
      index === 0 ? CheckStateEnum.SPENT : CheckStateEnum.UNSPENT,
    ),
  );
  const recipient = await reconcileFixtureDelivery(
    cancellation,
    fixture.proofs.map(() => CheckStateEnum.SPENT),
  );
  const rechecked = await reconcileFixtureDelivery(
    cancellation,
    fixture.proofs.map(() => CheckStateEnum.UNSPENT),
  );
  const submitted = reduceDurableBearerSpendReclaimLineage(rechecked, {
    kind: "submitted",
    ...intent,
  });
  const reclaim = completeDurableBearerSpendReclaim({
    record: submitted,
    capability: reclaimCompletionCapability(fixture, submitted, intent),
    completedAtMs: 5_000,
  });
  return new Map([
    ["cancellation-intent", cancellation],
    ["partial", partial],
    ["recipient-finalization", recipient],
    ["reclaim-completion", reclaim],
  ]);
}

function reclaimCompletionCapability(
  fixture: ReturnType<typeof createPendingParentFixture>,
  record: DurableBearerSpendDeliveryRecord,
  intent: ReturnType<typeof planDurableBearerSpendReclaimIntent>,
) {
  const output = new OutputData(
    {
      amount: Amount.from(intent.approvedReturnAmount),
      id: KEYSET_ID,
      B_: POINT,
    },
    2n,
    new TextEncoder().encode("44".repeat(32)),
    POINT,
  );
  const operation = createDurableWalletReceiveOperation({
    operationId: intent.operationId,
    mintUrl: MINT,
    unit: "sat",
    preview: {
      amount: Amount.from(intent.approvedReturnAmount),
      fees: Amount.from(intent.approvedFee),
      keysetId: KEYSET_ID,
      inputs: fixture.proofs,
      keepOutputs: [output],
    },
  });
  return issueDurableBearerSpendReclaimCompletionCapability({
    record,
    intent,
    walletOperation: operation,
    resultGroups: {
      receive: [
        {
          id: KEYSET_ID,
          amount: Amount.from(intent.approvedReturnAmount),
          secret: new TextDecoder().decode(output.secret),
          C: POINT,
        },
      ],
    },
  });
}

async function reconcileFixtureDelivery(
  record: DurableBearerSpendDeliveryRecord,
  states: readonly ProofState["state"][],
): Promise<DurableBearerSpendDeliveryRecord> {
  const activeProofs = record.proofEntries.flatMap((entry) =>
    entry.kind === "active" ? [entry.proof] : [],
  );
  return reconcileDurableBearerSpendDelivery({
    record,
    observedAtMs: (record.state.lastObservedAtMs ?? record.createdAtMs) + 1_000,
    checker: {
      async checkProofsStates() {
        return states.map((state, index) =>
          proofState(activeProofs[index]!, state),
        );
      },
    },
  });
}

function proofState(proof: Proof, state: ProofState["state"]): ProofState {
  return {
    Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
    state,
    witness: null,
  };
}

function proofOrderFingerprint(record: DurableBearerSpendDeliveryRecord): string {
  return deriveDurableCustodyArtifactFingerprint({
    domain: "pending-send-test-proof-order/v1",
    proofs: record.proofEntries.map((entry) =>
      entry.kind === "active" ? entry.proof.secret : entry.Y,
    ),
  });
}

function restoredNonterminalRecord(
  record: DurableBearerSpendDeliveryRecord,
): DurableBearerSpendDeliveryRecord {
  return { ...record, origin: "restored" };
}

async function roundTripPendingRecords(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly realm: string;
  readonly records: readonly PreparedEncryptedWalletBackupRecord[];
}) {
  const chunks = group(input.records, 8).map(
    packEncryptedWalletBackupDataChunk,
  );
  const objects = await Promise.all(
    chunks.map((chunk) =>
      prepareEncryptedWalletBackupObject({
        keyHandle: input.keyHandle,
        chunk,
        generation: 1,
      }),
    ),
  );
  const manifest = await prepareEncryptedWalletBackupManifest({
    keyHandle: input.keyHandle,
    generation: 1,
    snapshotNonce: new Uint8Array(16).fill(4),
    chunks: chunks.map((chunk, index) => ({ chunk, object: objects[index]! })),
    snapshotStore: exactSnapshotSealStore(),
  });
  return restorePendingRemote({ ...input, manifest, objects });
}

async function restorePendingRemote(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly realm: string;
  readonly manifest: PreparedEncryptedWalletBackupManifest;
  readonly objects: readonly PreparedEncryptedWalletBackupObject[];
}) {
  const head = prepareEncryptedWalletBackupManifestHead({
    keyHandle: input.keyHandle,
    manifest: input.manifest,
    parent: null,
  });
  const restoreKeyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: input.realm,
  });
  const headEvidence = await authenticatePendingHead(
    restoreKeyHandle,
    readPreparedEncryptedWalletBackupManifestHead(head),
  );
  const pages = await Promise.all(
    input.manifest.pages.map((page) =>
      decryptEncryptedWalletBackupManifestPage({
        keyHandle: restoreKeyHandle,
        seed: SEED,
        object: structuredClone(readPreparedEncryptedWalletBackupObject(page)),
        headEvidence,
      }),
    ),
  );
  const wireObjects = input.objects.map((object) =>
    structuredClone(readPreparedEncryptedWalletBackupObject(object)),
  );
  const dataChunks = await Promise.all(
    wireObjects.map((object) =>
      decryptEncryptedWalletBackupDataChunk({
        keyHandle: restoreKeyHandle,
        seed: SEED,
        object,
      }),
    ),
  );
  return {
    head,
    restoreKeyHandle,
    headEvidence,
    pages,
    wireObjects,
    dataChunks,
  };
}

async function authenticatePendingHead(
  keyHandle: EncryptedWalletBackupKeyHandle,
  head: ReturnType<typeof readPreparedEncryptedWalletBackupManifestHead>,
) {
  const requestProof = await prepareEncryptedWalletBackupRequestProof({
    keyHandle,
    enrollmentEpoch: 1,
    method: "GET",
    url: "https://backup.example.test/v1/vaults/current-head",
    issuedAtUnixSeconds: 1_000,
    expiresAtUnixSeconds: 1_030,
    payload: new Uint8Array(),
    signal: AbortSignal.timeout(10_000),
  });
  return readAuthenticatedEncryptedWalletBackupHead({
    keyHandle,
    enrollmentEpoch: 1,
    requestProof,
    remote: {
      async readCurrentHead() {
        return {
          status: "found" as const,
          enrollmentEpoch: 1,
          head: structuredClone(head),
        };
      },
    },
  });
}

function pendingSelections(
  remote: Awaited<ReturnType<typeof restorePendingRemote>>,
  recordKindCode: 1 | 2,
) {
  const chunkByObjectId = new Map(
    remote.wireObjects.map((object, index) => [
      object.objectId,
      remote.dataChunks[index]!,
    ]),
  );
  return remote.pages
    .flatMap((page) =>
      page.entries
        .filter((entry) => entry.recordKindCode === recordKindCode)
        .map((entry) => ({ entry, page })),
    )
    .sort((left, right) => left.entry.fragmentIndex - right.entry.fragmentIndex)
    .map(({ entry, page }) => ({
      recordId: entry.recordId,
      dataChunk: chunkByObjectId.get(entry.dataObjectId)!,
      manifestPage: page,
    }));
}

function group<T>(values: readonly T[], size: number): readonly T[][] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size),
  );
}

function deterministicBackupRuntime(values: readonly Uint8Array[]) {
  const queue = values.map((value) => value.slice());
  return {
    subtle: globalThis.crypto.subtle,
    getRandomValues<T extends ArrayBufferView | null>(target: T): T {
      const next = queue.shift();
      if (
        target === null ||
        next === undefined ||
        next.byteLength !== target.byteLength
      ) {
        throw new Error("deterministic backup runtime mismatch");
      }
      new Uint8Array(target.buffer, target.byteOffset, target.byteLength).set(next);
      return target;
    },
  };
}

function exactSnapshotSealStore(): EncryptedWalletBackupSnapshotSealStore {
  return {
    async sealCommittedBackupSnapshot<T>(expected, seal): Promise<T> {
      return seal(structuredClone(expected));
    },
  };
}

function proof(index: number): Proof {
  return {
    id: KEYSET_ID,
    amount: 1,
    secret: index.toString(16).padStart(64, "0"),
    C: POINT,
  };
}
