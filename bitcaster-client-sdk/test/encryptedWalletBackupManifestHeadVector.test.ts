import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { encodeCanonicalBackupCbor } from "../src/encryptedWalletBackupCbor.ts";
import { validateEncryptedWalletBackupManifestHeadUnit } from "../src/encryptedWalletBackupManifestHead.ts";

interface ReferenceInput {
  readonly objectIdHex: string;
  readonly digestHex: string;
}

interface ManifestHeadInput {
  readonly realm: string;
  readonly vaultIdHex: string;
  readonly backupPublicKeyHex: string;
  readonly generation: number;
  readonly parent: null | Readonly<{
    readonly generation: number;
    readonly manifestDigestHex: string;
  }>;
  readonly snapshotNonceHex: string;
  readonly pageReferences: readonly ReferenceInput[];
  readonly chunkReferences: readonly ReferenceInput[];
  readonly recordCount: number;
  readonly storedBytes: number;
}

interface ManifestHeadVector {
  readonly inputs: ManifestHeadInput;
  readonly canonicalHeadHex: string;
  readonly canonicalReferenceSetHex: string;
  readonly manifestDigestHex: string;
  readonly referenceSetDigestHex: string;
}

const vector = JSON.parse(
  await readFile(
    new URL(
      "../../test-vectors/encrypted-wallet-backup-manifest-head-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Readonly<{
  readonly nonempty: ManifestHeadVector;
  readonly empty: ManifestHeadVector;
  readonly third: ManifestHeadVector;
}>;

test("SDK owns and exactly regenerates canonical manifest-head vectors", () => {
  for (const unit of [vector.nonempty, vector.empty, vector.third]) {
    const pageReferences = encodeReferences(unit.inputs.pageReferences);
    const chunkReferences = encodeReferences(unit.inputs.chunkReferences);
    const canonicalReferenceSet = encodeCanonicalBackupCbor([
      1,
      "reference-set",
      pageReferences,
      chunkReferences,
    ]);
    const canonicalHead = encodeCanonicalBackupCbor([
      1,
      "manifest-head",
      unit.inputs.realm,
      fromHex(unit.inputs.vaultIdHex),
      fromHex(unit.inputs.backupPublicKeyHex),
      unit.inputs.generation,
      unit.inputs.parent === null
        ? null
        : [
            unit.inputs.parent.generation,
            fromHex(unit.inputs.parent.manifestDigestHex),
          ],
      fromHex(unit.inputs.snapshotNonceHex),
      pageReferences,
      chunkReferences,
      unit.inputs.recordCount,
      unit.inputs.storedBytes,
      fromHex(unit.referenceSetDigestHex),
    ]);

    assert.equal(bytesToHex(canonicalHead), unit.canonicalHeadHex);
    assert.equal(
      bytesToHex(canonicalReferenceSet),
      unit.canonicalReferenceSetHex,
    );
    const validated = validateEncryptedWalletBackupManifestHeadUnit({
      canonicalHead,
      canonicalReferenceSet,
    });
    assert.equal(validated.manifestDigest, unit.manifestDigestHex);
    assert.equal(validated.referenceSetDigest, unit.referenceSetDigestHex);
  }
});

function encodeReferences(
  references: readonly ReferenceInput[],
): readonly (readonly [Uint8Array, Uint8Array])[] {
  return references.map((reference) => [
    fromHex(reference.objectIdHex),
    fromHex(reference.digestHex),
  ]);
}

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}
