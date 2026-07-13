import type {
  EncryptedWalletBackupKeyHandle,
  EncryptedWalletBackupManifestHead,
  PreparedEncryptedWalletBackupObject,
} from "./encryptedWalletBackup.ts";

interface PreparedManifestUploadAuthority {
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly objects: readonly PreparedEncryptedWalletBackupObject[];
  readonly repackedSourceObjectIdsByObjectId: ReadonlyMap<
    string,
    ReadonlySet<string>
  >;
}

export interface PreparedEncryptedWalletBackupUploadAuthority {
  readonly objects: readonly PreparedEncryptedWalletBackupObject[];
  readonly repackedSourceObjectIdsByObjectId: ReadonlyMap<
    string,
    ReadonlySet<string>
  >;
}

const PREPARED_MANIFEST_UPLOADS = new WeakMap<
  object,
  PreparedManifestUploadAuthority
>();

/** Internal capability issuer; deliberately absent from package exports. */
export function issuePreparedEncryptedWalletBackupUploadAuthority(
  head: EncryptedWalletBackupManifestHead,
  keyHandle: EncryptedWalletBackupKeyHandle,
  objects: readonly PreparedEncryptedWalletBackupObject[],
  repackedSourceObjectIdsByObjectId: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  PREPARED_MANIFEST_UPLOADS.set(head, {
    keyHandle,
    objects: Object.freeze([...objects]),
    repackedSourceObjectIdsByObjectId: new Map(
      [...repackedSourceObjectIdsByObjectId].map(([objectId, sourceIds]) => [
        objectId,
        new Set(sourceIds),
      ]),
    ),
  });
}

export function readPreparedEncryptedWalletBackupUploadAuthority(
  head: unknown,
  keyHandle: EncryptedWalletBackupKeyHandle,
): PreparedEncryptedWalletBackupUploadAuthority {
  const authority =
    typeof head === "object" && head !== null
      ? PREPARED_MANIFEST_UPLOADS.get(head)
      : undefined;
  if (authority === undefined || authority.keyHandle !== keyHandle) {
    throw new Error("prepared backup upload target is invalid");
  }
  return Object.freeze({
    objects: authority.objects,
    repackedSourceObjectIdsByObjectId: new Map(
      [...authority.repackedSourceObjectIdsByObjectId].map(
        ([objectId, sourceIds]) => [objectId, new Set(sourceIds)],
      ),
    ),
  });
}
