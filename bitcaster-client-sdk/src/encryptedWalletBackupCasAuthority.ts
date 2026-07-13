import type {
  EncryptedWalletBackupKeyHandle,
  EncryptedWalletBackupSyncAttemptStore,
  EncryptedWalletBackupSyncAttemptRecord,
  SealedEncryptedWalletBackupSyncAttempt,
} from "./encryptedWalletBackup.ts";

interface CoordinatedCasAuthority {
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly record: EncryptedWalletBackupSyncAttemptRecord;
  readonly store: EncryptedWalletBackupSyncAttemptStore;
}

const COORDINATED_CAS_AUTHORITIES = new WeakMap<
  object,
  CoordinatedCasAuthority
>();

export function issueCoordinatedEncryptedWalletBackupCasAttempt(
  record: EncryptedWalletBackupSyncAttemptRecord,
  keyHandle: EncryptedWalletBackupKeyHandle,
  store: EncryptedWalletBackupSyncAttemptStore,
): SealedEncryptedWalletBackupSyncAttempt {
  const privateRecord = Object.freeze({
    ...record,
    targetHead: Object.freeze({
      ...record.targetHead,
      parent:
        record.targetHead.parent === null
          ? null
          : Object.freeze({ ...record.targetHead.parent }),
    }),
    canonicalCasPayload: record.canonicalCasPayload.slice(),
  });
  const evidence = Object.freeze({
    state: "sealed" as const,
    record: Object.freeze({
      ...privateRecord,
      canonicalCasPayload: privateRecord.canonicalCasPayload.slice(),
    }),
  });
  COORDINATED_CAS_AUTHORITIES.set(evidence, {
    keyHandle,
    record: privateRecord,
    store,
  });
  return evidence;
}

export function readCoordinatedEncryptedWalletBackupCasAuthority(
  value: unknown,
): CoordinatedCasAuthority | undefined {
  return typeof value === "object" && value !== null
    ? COORDINATED_CAS_AUTHORITIES.get(value)
    : undefined;
}
