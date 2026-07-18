import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  rehydratePreparedEncryptedWalletBackupRecord,
  type EncryptedWalletBackupPreparedRecordSnapshot,
  type PersistedPreparedEncryptedWalletBackupRecord,
} from "../src/encryptedWalletBackupPreparedRecordPersistence.ts";
import {
  createEncryptedWalletBackupKeyHandle,
  packEncryptedWalletBackupDataChunk,
} from "../src/encryptedWalletBackup.ts";

interface WireRecord {
  readonly persisted: Omit<
    PersistedPreparedEncryptedWalletBackupRecord,
    "canonicalRecord" | "canonicalManifestEntry" | "authenticationTag"
  > & {
    readonly canonicalRecord: number[];
    readonly canonicalManifestEntry: number[];
    readonly authenticationTag: number[];
  };
  readonly snapshot: EncryptedWalletBackupPreparedRecordSnapshot;
}

interface RestartInput {
  readonly seed: number[];
  readonly realm: string;
  readonly records: WireRecord[];
}

const input = JSON.parse(readFileSync(0, "utf8")) as RestartInput;
const seed = Uint8Array.from(input.seed);
const keyHandle = await createEncryptedWalletBackupKeyHandle({
  seed,
  realm: input.realm,
  runtime: {
    subtle: webcrypto.subtle,
    getRandomValues(target: Uint8Array) {
      return webcrypto.getRandomValues(target);
    },
  },
});
const bindings: Array<{
  recordId: string;
  commitment: string;
  recordKindCode: number;
}> = [];
for (const { persisted: wire, snapshot } of input.records) {
  const persisted = {
    ...wire,
    canonicalRecord: Uint8Array.from(wire.canonicalRecord),
    canonicalManifestEntry: Uint8Array.from(wire.canonicalManifestEntry),
    authenticationTag: Uint8Array.from(wire.authenticationTag),
  };
  const record = await rehydratePreparedEncryptedWalletBackupRecord({
    keyHandle,
    seed,
    persisted,
    snapshotStore: {
      async withCommittedPreparedRecordSnapshot(recordId, read) {
        if (recordId !== snapshot.recordId)
          throw new Error("record id changed");
        return read(structuredClone(snapshot));
      },
    },
  });
  const binding = packEncryptedWalletBackupDataChunk([record]).bindings[0];
  const identity =
    binding && "proofId" in binding ? binding.proofId : binding?.recordId;
  const recordKindCode =
    binding && "proofId" in binding ? 0 : binding?.recordKindCode;
  if (
    identity !== wire.recordId ||
    binding?.commitment !== wire.commitment ||
    recordKindCode !== wire.recordKindCode
  ) {
    throw new Error("rehydrated record binding changed");
  }
  bindings.push({
    recordId: wire.recordId,
    commitment: wire.commitment,
    recordKindCode,
  });
}
process.stdout.write(JSON.stringify(bindings));
