import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  createEncryptedWalletBackupKeyHandle,
  packEncryptedWalletBackupDataChunk,
  prepareEncryptedWalletBackupManifest,
  prepareEncryptedWalletBackupManifestHead,
  prepareEncryptedWalletBackupObject,
  prepareEncryptedWalletBackupPendingSendParent,
  prepareEncryptedWalletBackupPendingSendProgression,
  readPreparedEncryptedWalletBackupManifestHead,
  type EncryptedWalletBackupRuntime,
  type PreparedEncryptedWalletBackupRecord,
} from "../src/encryptedWalletBackup.ts";
import {
  PENDING_SEND_FIXTURE_SEED,
  createPartialPendingSendDeliveryRecord,
  createPendingSendFixture,
  exactPendingSendSnapshotStore,
} from "./encryptedWalletBackupPendingSendFixture.ts";

export async function generateFragmentedPendingSendGolden() {
  const realm = "fragmented-pending-send-vector";
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: PENDING_SEND_FIXTURE_SEED,
    realm,
  });
  const pending = await prepareGoldenPendingRecords(keyHandle);
  const chunks = groupRecords(pending.records, 2).map(
    packEncryptedWalletBackupDataChunk,
  );
  const objects = await prepareGoldenDataObjects(keyHandle, chunks);
  const manifest = await prepareGoldenManifest(keyHandle, chunks, objects);
  const head = prepareEncryptedWalletBackupManifestHead({
    keyHandle,
    manifest,
    parent: null,
  });
  const headWire = readPreparedEncryptedWalletBackupManifestHead(head);
  return {
    realm,
    vaultIdHex: keyHandle.vaultId,
    sendProofCount: pending.sendProofCount,
    parentFragmentCount: pending.parentFragmentCount,
    childFragmentCount: pending.childFragmentCount,
    recordCount: pending.records.length,
    dataChunkCount: objects.length,
    parentCommitmentHex: pending.parentCommitmentHex,
    childCommitmentHex: pending.childCommitmentHex,
    dataObjects: objects.map(({ objectId, digest }) => ({ objectId, digest })),
    manifestPages: manifest.pages.map(({ objectId, digest }) => ({ objectId, digest })),
    head: goldenHeadSummary(head, headWire),
  };
}

async function prepareGoldenPendingRecords(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
) {
  const fixture = createPendingSendFixture(64);
  const parent = await prepareEncryptedWalletBackupPendingSendParent({
    keyHandle,
    recordId: fixture.snapshot.recordId,
    snapshotStore: exactPendingSendSnapshotStore(fixture.snapshot),
  });
  const partial = await createPartialPendingSendDeliveryRecord(
    fixture.deliveryRecord,
  );
  const childSnapshot = {
    ...fixture.snapshot,
    progression: "partial" as const,
    parentCommitment: parent.parentCommitment,
    deliveryRecord: partial,
  };
  const child = await prepareEncryptedWalletBackupPendingSendProgression({
    keyHandle,
    recordId: childSnapshot.recordId,
    snapshotStore: exactPendingSendSnapshotStore(childSnapshot),
  });
  return {
    sendProofCount: fixture.proofs.length,
    parentFragmentCount: parent.fragmentCount,
    childFragmentCount: child.fragmentCount,
    parentCommitmentHex: parent.parentCommitment,
    childCommitmentHex: child.childCommitment,
    records: [...parent.records, ...child.records],
  };
}

async function prepareGoldenDataObjects(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
  chunks: readonly ReturnType<typeof packEncryptedWalletBackupDataChunk>[],
) {
  return Promise.all(
    chunks.map((chunk, index) =>
      prepareEncryptedWalletBackupObject({
        keyHandle,
        chunk,
        generation: 1,
        runtime: deterministicGoldenRuntime([
          new Uint8Array(16).fill(0xa1 + index),
          new Uint8Array(12).fill(0xb1 + index),
        ]),
      }),
    ),
  );
}

function prepareGoldenManifest(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
  chunks: readonly ReturnType<typeof packEncryptedWalletBackupDataChunk>[],
  objects: readonly Awaited<ReturnType<typeof prepareEncryptedWalletBackupObject>>[],
) {
  return prepareEncryptedWalletBackupManifest({
    keyHandle,
    generation: 1,
    snapshotNonce: new Uint8Array(16).fill(0xc1),
    chunks: chunks.map((chunk, index) => ({ chunk, object: objects[index]! })),
    snapshotStore: acceptingGoldenSnapshotStore(),
    runtime: deterministicGoldenRuntime(
      Array.from({ length: 8 }, (_, index) => [
        new Uint8Array(16).fill(0xd1 + index),
        new Uint8Array(12).fill(0xe1 + index),
      ]).flat(),
    ),
  });
}

function goldenHeadSummary(
  head: ReturnType<typeof prepareEncryptedWalletBackupManifestHead>,
  wire: ReturnType<typeof readPreparedEncryptedWalletBackupManifestHead>,
) {
  return {
    generation: head.generation,
    manifestDigestHex: head.manifestDigest,
    referenceSetDigestHex: head.referenceSetDigest,
    canonicalHeadDigestHex: bytesToHex(sha256(wire.canonicalHead)),
    canonicalReferenceSetDigestHex: bytesToHex(
      sha256(wire.canonicalReferenceSet),
    ),
    objectCount: head.objectCount,
    storedBytes: head.storedBytes,
    recordCount: head.recordCount,
  };
}

function groupRecords(
  records: readonly PreparedEncryptedWalletBackupRecord[],
  size: number,
) {
  return Array.from(
    { length: Math.ceil(records.length / size) },
    (_, index) => records.slice(index * size, (index + 1) * size),
  );
}

function deterministicGoldenRuntime(
  values: readonly Uint8Array[],
): EncryptedWalletBackupRuntime {
  let offset = 0;
  return {
    subtle: globalThis.crypto.subtle,
    getRandomValues(target) {
      const value = values[offset++];
      if (value === undefined || value.byteLength !== target.byteLength) {
        throw new Error("unexpected pending-send golden randomness request");
      }
      target.set(value);
      return target;
    },
  };
}

function acceptingGoldenSnapshotStore() {
  return {
    async sealCommittedBackupSnapshot<T>(
      expected: unknown,
      seal: (value: never) => T,
    ): Promise<T> {
      return seal(expected as never);
    },
  };
}
