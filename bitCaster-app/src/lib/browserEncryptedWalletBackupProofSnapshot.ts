import {
  prepareEncryptedWalletBackupProof,
  type EncryptedWalletBackupKeyHandle,
  type EncryptedWalletBackupCommittedProofSnapshot,
} from "@bitcaster/client-sdk/encryptedWalletBackup";
import type { EncryptedWalletBackupProofSnapshotStore } from "@bitcaster/client-sdk/encryptedWalletBackup";
import type { EncryptedWalletBackupFrozenSnapshotControl } from "@bitcaster/client-sdk/encryptedWalletBackupSnapshotAuthority";
import { requireEncryptedWalletBackupFrozenSnapshotControl } from "@bitcaster/client-sdk/encryptedWalletBackupSnapshotAuthority";
import {
  appendEncryptedWalletBackupFrozenSnapshotProofPage,
  beginEncryptedWalletBackupFrozenSnapshot,
  type PersistedEncryptedWalletBackupFrozenSnapshot,
} from "@bitcaster/client-sdk/encryptedWalletBackupSnapshotPersistence";
import { sealEncryptedWalletBackupFrozenSnapshot } from "@bitcaster/client-sdk/encryptedWalletBackupSnapshotSeal";
import { sealPreparedEncryptedWalletBackupRecord } from "@bitcaster/client-sdk/encryptedWalletBackupPreparedRecordPersistence";
import type {
  EncryptedWalletBackupPreparedRecordSnapshot,
  EncryptedWalletBackupPreparedRecordSnapshotStore,
} from "@bitcaster/client-sdk/encryptedWalletBackupPreparedRecordPersistence";
import {
  BrowserEncryptedWalletBackupProofSnapshotDexieStore,
  type BrowserEncryptedWalletBackupProofSnapshotPageItem,
} from "../stores/browser-encrypted-wallet-backup-proof-snapshot-dexie-store";
import { EncryptedWalletBackupPreparedSourceDexieStore } from "../stores/encrypted-wallet-backup-prepared-source-db";
import { EncryptedWalletBackupSnapshotManifestDexieStore } from "../stores/encrypted-wallet-backup-snapshot-manifest-db";
import type { BitcasterDB } from "../stores/proof-db";
import { withWalletProfileLock } from "./walletProfileLock";

type WalletLockManager = Pick<LockManager, "request">;

export interface BuildBrowserEncryptedWalletBackupProofSnapshotInput {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly seed: Uint8Array;
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly control: EncryptedWalletBackupFrozenSnapshotControl;
  readonly snapshotId: string;
  readonly snapshotRevision: number;
  readonly effectiveNowUnixSeconds: number;
  readonly signal: AbortSignal;
  readonly lockManager?: WalletLockManager;
}

/**
 * Builds one first snapshot from current proof authority.
 * A cancelled build stays incomplete. The caller must use a fresh snapshot namespace to rebuild it.
 */
export async function buildBrowserEncryptedWalletBackupProofSnapshot(
  input: BuildBrowserEncryptedWalletBackupProofSnapshotInput,
): Promise<PersistedEncryptedWalletBackupFrozenSnapshot> {
  return withWalletProfileLock(
    input.scopeId,
    () => buildLockedBrowserEncryptedWalletBackupProofSnapshot(input),
    input.lockManager,
  );
}

async function buildLockedBrowserEncryptedWalletBackupProofSnapshot(
  input: BuildBrowserEncryptedWalletBackupProofSnapshotInput,
): Promise<PersistedEncryptedWalletBackupFrozenSnapshot> {
  const stores = createStores(input);
  throwIfAborted(input.signal);
  let current = await beginEncryptedWalletBackupFrozenSnapshot({
    store: stores.snapshot,
    control: input.control,
  });
  let cursor: string | null = null;
  do {
    throwIfAborted(input.signal);
    const page = await stores.proofs.listEligibleCommittedProofSnapshotPage(cursor);
    throwIfAborted(input.signal);
    current = await appendPreparedPage({ input, stores, current, page: page.items });
    cursor = advanceCursor(cursor, page.nextCursor);
  } while (cursor !== null);
  throwIfAborted(input.signal);
  return sealEncryptedWalletBackupFrozenSnapshot({
    store: stores.snapshot,
    control: input.control,
    current,
  });
}

function createStores(input: BuildBrowserEncryptedWalletBackupProofSnapshotInput) {
  const authority = requireEncryptedWalletBackupFrozenSnapshotControl(input.control);
  if (
    authority.realm !== input.keyHandle.realm ||
    authority.vaultId !== input.keyHandle.vaultId ||
    authority.snapshotId !== input.snapshotId ||
    authority.snapshotRevision !== input.snapshotRevision
  ) {
    throw new Error("backup snapshot control does not match the requested snapshot");
  }
  return {
    proofs: new BrowserEncryptedWalletBackupProofSnapshotDexieStore({
      database: input.database,
      scopeId: input.scopeId,
      snapshotId: input.snapshotId,
      snapshotRevision: input.snapshotRevision,
    }),
    prepared: new EncryptedWalletBackupPreparedSourceDexieStore({
      database: input.database,
      scopeId: input.scopeId,
      realm: input.keyHandle.realm,
      vaultId: input.keyHandle.vaultId,
      generation: authority.generation,
    }),
    snapshot: new EncryptedWalletBackupSnapshotManifestDexieStore({
      database: input.database,
      scopeId: input.scopeId,
      realm: input.keyHandle.realm,
      vaultId: input.keyHandle.vaultId,
      snapshotId: input.snapshotId,
      snapshotRevision: input.snapshotRevision,
    }),
  };
}

async function appendPreparedPage(input: {
  readonly input: BuildBrowserEncryptedWalletBackupProofSnapshotInput;
  readonly stores: ReturnType<typeof createStores>;
  readonly current: PersistedEncryptedWalletBackupFrozenSnapshot;
  readonly page: readonly BrowserEncryptedWalletBackupProofSnapshotPageItem[];
}): Promise<PersistedEncryptedWalletBackupFrozenSnapshot> {
  if (input.page.length === 0) return input.current;
  const prepared = [];
  for (const item of input.page) {
    const record = await preparePageItem(item, input.input);
    prepared.push(record);
  }
  await input.stores.prepared.insertPreparedSourceBatch(prepared);
  return appendEncryptedWalletBackupFrozenSnapshotProofPage({
    store: input.stores.snapshot,
    control: input.input.control,
    current: input.current,
    keyHandle: input.input.keyHandle,
    seed: input.input.seed,
    preparedRecords: prepared,
    preparedSnapshotStore: input.stores.prepared,
  });
}

async function preparePageItem(
  item: BrowserEncryptedWalletBackupProofSnapshotPageItem,
  input: BuildBrowserEncryptedWalletBackupProofSnapshotInput,
) {
  const snapshotStore = pageItemSnapshotStore(item.snapshot);
  const record = await prepareEncryptedWalletBackupProof({
    ...item.proofInput,
    keyHandle: input.keyHandle,
    seed: input.seed,
    effectiveNowUnixSeconds: input.effectiveNowUnixSeconds,
    proofSnapshotStore: snapshotStore,
  });
  return sealPreparedEncryptedWalletBackupRecord({
    keyHandle: input.keyHandle,
    seed: input.seed,
    record,
    snapshotStore: pageItemPreparedRecordSnapshotStore(item.snapshot),
  });
}

function pageItemSnapshotStore(
  snapshot: EncryptedWalletBackupCommittedProofSnapshot,
): EncryptedWalletBackupProofSnapshotStore {
  return {
    async withCommittedProofSnapshot<T>(
      proofId: string,
      read: (row: EncryptedWalletBackupCommittedProofSnapshot) => T,
    ): Promise<T> {
      if (proofId !== snapshot.proofId)
        throw new Error("proof page item does not match its snapshot");
      return read(snapshot);
    },
  };
}

function pageItemPreparedRecordSnapshotStore(
  snapshot: EncryptedWalletBackupCommittedProofSnapshot,
): EncryptedWalletBackupPreparedRecordSnapshotStore {
  return {
    async withCommittedPreparedRecordSnapshot<T>(
      recordId: string,
      read: (row: EncryptedWalletBackupPreparedRecordSnapshot) => T,
    ): Promise<T> {
      if (recordId !== snapshot.proofId) throw new Error("prepared proof page item is invalid");
      return read({
        schemaVersion: 1,
        snapshotId: snapshot.snapshotId,
        snapshotRevision: snapshot.revision,
        recordId: snapshot.proofId,
        commitment: snapshot.proofCommitment,
        recordKindCode: 0,
      });
    },
  };
}

function advanceCursor(current: string | null, next: string | null): string | null {
  if (next !== null && current !== null && next <= current) {
    throw new Error("proof snapshot source cursor did not advance");
  }
  return next;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}
