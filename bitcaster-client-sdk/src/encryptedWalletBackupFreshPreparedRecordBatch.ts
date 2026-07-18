import type { EncryptedWalletBackupKeyHandle } from "./encryptedWalletBackup.ts";
import {
  sealPreparedEncryptedWalletBackupRecordBatch,
  type EncryptedWalletBackupPreparedRecordSnapshotBatchStore,
  type PersistedPreparedEncryptedWalletBackupRecord,
} from "./encryptedWalletBackupPreparedRecordPersistence.ts";
import type { PreparedEncryptedWalletBackupRecord } from "./encryptedWalletBackupRecord.ts";

export interface FreshEncryptedWalletBackupPreparedRecordBatch {
  readonly recordCount: number;
}

interface FreshBatchAuthority {
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly records: readonly PersistedPreparedEncryptedWalletBackupRecord[];
  consumed: boolean;
}

const FRESH_BATCHES = new WeakMap<object, FreshBatchAuthority>();

export async function sealFreshEncryptedWalletBackupPreparedRecordBatch(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly seed: Uint8Array;
  readonly records: readonly PreparedEncryptedWalletBackupRecord[];
  readonly snapshotStore: EncryptedWalletBackupPreparedRecordSnapshotBatchStore;
  readonly cooperativeYield?: () => void | Promise<void>;
}): Promise<FreshEncryptedWalletBackupPreparedRecordBatch> {
  const records = await sealPreparedEncryptedWalletBackupRecordBatch(input);
  const handle = Object.freeze({ recordCount: records.length });
  FRESH_BATCHES.set(handle, {
    keyHandle: input.keyHandle,
    records,
    consumed: false,
  });
  return handle;
}

export function consumeFreshEncryptedWalletBackupPreparedRecordBatch(
  value: FreshEncryptedWalletBackupPreparedRecordBatch,
  keyHandle: EncryptedWalletBackupKeyHandle,
) {
  const authority =
    typeof value === "object" && value !== null
      ? FRESH_BATCHES.get(value)
      : undefined;
  if (
    authority === undefined ||
    authority.keyHandle !== keyHandle ||
    authority.consumed
  )
    throw new Error("fresh prepared backup record batch is invalid");
  authority.consumed = true;
  return authority.records;
}
