import assert from "node:assert/strict";
import test from "node:test";
import { hexToBytes } from "@noble/hashes/utils.js";
import { decode } from "cborg";
import {
  encodeCanonicalBackupCbor,
  preflightEncryptedDataChunkCbor,
  preflightEncryptedManifestPageCbor,
} from "../src/encryptedWalletBackupCbor.ts";
import {
  decodeEncryptedWalletBackupPendingSendProgressionFragment,
  derivePendingSendProgressionCommitment,
  derivePendingSendProgressionFragmentCommitment,
  derivePendingSendProgressionFragmentRecordId,
  encodePendingSendProgressionCode,
  validateEncryptedWalletBackupPendingSendProgressionFragments,
  type DecodedEncryptedWalletBackupPendingSendProgressionFragment,
  type EncryptedWalletBackupPendingSendChildProgression,
} from "../src/encryptedWalletBackupPendingSendProgressionCodec.ts";

const LOGICAL_ID = "11".repeat(32);
const PARENT_COMMITMENT = "22".repeat(32);

test("progression fragments bind exact order, parent, kind, and total commitment", () => {
  const decoded = progressionFragments("partial");
  const verified =
    validateEncryptedWalletBackupPendingSendProgressionFragments(decoded);
  assert.equal(verified.logicalRecordId, LOGICAL_ID);
  assert.equal(verified.parentCommitment, PARENT_COMMITMENT);
  assert.equal(verified.progression, "partial");
  assert.equal(verified.payload.byteLength, 16 * 1_024 + 3);

  for (const invalid of [
    decoded.slice(1),
    [decoded[1]!, decoded[0]!],
    [decoded[0]!, decoded[0]!],
  ]) {
    assert.throws(
      () =>
        validateEncryptedWalletBackupPendingSendProgressionFragments(invalid),
      /fragment set|commitment is invalid/,
    );
  }

  const tampered = structuredClone(decoded[0]!);
  tampered.fragment[0] ^= 1;
  assert.throws(
    () =>
      validateEncryptedWalletBackupPendingSendProgressionFragments([
        tampered,
        decoded[1]!,
      ]),
    /fragment is invalid/,
  );
  const foreign = { ...decoded[0]!, parentCommitment: "33".repeat(32) };
  assert.throws(
    () =>
      validateEncryptedWalletBackupPendingSendProgressionFragments([
        foreign,
        decoded[1]!,
      ]),
    /fragment is invalid/,
  );
});

test("progression fragment count rejects before traversing an oversized input", () => {
  const decoded = progressionFragments("recipient-finalization");
  const oversized = new Proxy(decoded, {
    get(target, property, receiver) {
      if (property === "length") return 1_025;
      if (property === Symbol.iterator) {
        throw new Error("oversized progression fragments were traversed");
      }
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(
    () =>
      validateEncryptedWalletBackupPendingSendProgressionFragments(oversized),
    /fragment set is invalid/,
  );
});

test("kind-2 data and manifest preflight reject closed-value and fragment attacks", () => {
  const fragment = decode(
    encodeCanonicalBackupCbor(encodeAndDecodeFragment({
      progression: "partial",
      fragment: new Uint8Array(1),
      fragmentIndex: 0,
      commitments: ["44".repeat(32)],
      childCommitment: "55".repeat(32),
    })),
  ) as unknown[];
  for (const mutate of [
    (value: unknown[]) => { value[6] = 4; },
    (value: unknown[]) => { value[8] = 1; value[9] = 1; },
    (value: unknown[]) => { value[10] = 16 * 1_024 * 1_024 + 1; },
  ]) {
    const attacked = structuredClone(fragment);
    mutate(attacked);
    assert.throws(
      () =>
        preflightEncryptedDataChunkCbor(
          encodeCanonicalBackupCbor([1, 1, [attacked]]),
        ),
      /shape/,
    );
  }

  const manifestEntry = [
    2,
    hexToBytes("66".repeat(32)),
    hexToBytes("67".repeat(32)),
    hexToBytes("68".repeat(16)),
    hexToBytes("69".repeat(32)),
    hexToBytes(LOGICAL_ID),
    hexToBytes(PARENT_COMMITMENT),
    4,
    hexToBytes("70".repeat(32)),
    0,
    1,
  ];
  assert.throws(
    () =>
      preflightEncryptedManifestPageCbor(
        encodeCanonicalBackupCbor([
          1,
          2,
          1,
          new Uint8Array(16),
          0,
          1,
          [manifestEntry],
        ]),
      ),
    /progression shape/,
  );
});

function progressionFragments(
  progression: EncryptedWalletBackupPendingSendChildProgression,
): readonly DecodedEncryptedWalletBackupPendingSendProgressionFragment[] {
  const fragments = [new Uint8Array(16 * 1_024).fill(7), new Uint8Array(3).fill(8)];
  const commitments = fragments.map((fragment, fragmentIndex) =>
    derivePendingSendProgressionFragmentCommitment({
      logicalRecordId: LOGICAL_ID,
      parentCommitment: PARENT_COMMITMENT,
      progression,
      fragmentIndex,
      fragmentCount: fragments.length,
      totalBytes: fragments.reduce((sum, item) => sum + item.byteLength, 0),
      fragment,
    }),
  );
  const childCommitment = derivePendingSendProgressionCommitment({
    logicalRecordId: LOGICAL_ID,
    parentCommitment: PARENT_COMMITMENT,
    progression,
    fragmentCommitments: commitments,
  });
  return fragments.map((fragment, fragmentIndex) =>
    decodeEncryptedWalletBackupPendingSendProgressionFragment(
      encodeAndDecodeFragment({
        progression,
        fragment,
        fragmentIndex,
        commitments,
        childCommitment,
      }),
    ),
  );
}

function encodeAndDecodeFragment(input: {
  readonly progression: EncryptedWalletBackupPendingSendChildProgression;
  readonly fragment: Uint8Array;
  readonly fragmentIndex: number;
  readonly commitments: readonly string[];
  readonly childCommitment: string;
}): unknown {
  const recordId = derivePendingSendProgressionFragmentRecordId({
    logicalRecordId: LOGICAL_ID,
    parentCommitment: PARENT_COMMITMENT,
    progression: input.progression,
    fragmentIndex: input.fragmentIndex,
  });
  const bytes = encodeCanonicalBackupCbor([
    1,
    2,
    hexToBytes(recordId),
    hexToBytes(input.commitments[input.fragmentIndex]!),
    hexToBytes(LOGICAL_ID),
    hexToBytes(PARENT_COMMITMENT),
    encodePendingSendProgressionCode(input.progression),
    hexToBytes(input.childCommitment),
    input.fragmentIndex,
    input.commitments.length,
    16 * 1_024 + 3,
    input.fragment,
  ]);
  return decode(bytes);
}
