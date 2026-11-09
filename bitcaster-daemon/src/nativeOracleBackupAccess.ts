import { getPublicKey } from 'nostr-tools/pure'
import {
  listOracleBackups,
  fetchCurrentOracleBackupSelection,
  oracleBackupStatus,
  OracleBackupAccessError,
  type OracleBackupQueryRelay,
  type OracleBackupScanCursor,
  type OracleBackupDeliveryState,
} from '@bitcaster-market/client-sdk'
import {
  nativeOracleDestinations,
  nativeOraclePublicationRecord,
  type NativeOracleCreationStore,
  type NativeOracleAuthorityRecord,
} from './nativeOracleCreationStore.ts'
import { nativeOraclePublicationBinding } from './nativeOraclePublicationCoordinator.ts'
import type { NativeOracleHelper } from './nativeOracleHelper.ts'
import { queryNativeOracleBackupRelay } from './nativeOracleBackupRelay.ts'

export interface NativeOracleBackupAccessPorts {
  readonly store: NativeOracleCreationStore
  readonly helper: NativeOracleHelper
  readonly readPrivateKey: () => Promise<Uint8Array>
  readonly relayUrls: readonly string[]
  readonly queryRelay?: OracleBackupQueryRelay
}

export async function listNativeOracleBackups(
  ports: NativeOracleBackupAccessPorts,
  relay?: string,
  cursor?: OracleBackupScanCursor,
) {
  return listOracleBackups({
    privateKey: await ports.readPrivateKey(),
    validator: ports.helper,
    relayUrls: relay === undefined ? ports.relayUrls : [relay],
    cursor,
    queryRelay: ports.queryRelay ?? queryNativeOracleBackupRelay,
  })
}

export class NativeOracleBackupMissingError extends Error {
  constructor() {
    super('The selected oracle backup event is unavailable.')
  }
}

/** The selection is refetched independently. Cached descriptors never authorize import. */
export async function restoreNativeOracleBackup(
  ports: NativeOracleBackupAccessPorts,
  eventId: string,
  relayUrl: string,
) {
  if (!/^[0-9a-f]{64}$/.test(eventId)) throw new OracleBackupAccessError('invalid-envelope')
  const privateKey = await ports.readPrivateKey()
  const selected = await fetchCurrentOracleBackupSelection({
    author: getPublicKey(privateKey),
    privateKey,
    validator: ports.helper,
    eventId,
    sourceRelay: relayUrl,
    relayUrls: ports.relayUrls,
    queryRelay: ports.queryRelay ?? queryNativeOracleBackupRelay,
  })
  // The store obtains its own matching local key and commits authenticated source atomically.
  const owner = await ports.store.importBackupEnvelope(selected, relayUrl, ports.helper)
  return nativeOracleBackupStatus(ports.store, owner)
}

export async function nativeOracleBackupStatus(
  store: NativeOracleCreationStore,
  owner: NativeOracleAuthorityRecord,
) {
  return nativeOracleBackupStatusFromSnapshot(
    owner,
    await store.readBackupDelivery(owner.announcement!.conditionId),
  )
}

export function nativeOracleBackupStatusFromSnapshot(
  owner: NativeOracleAuthorityRecord,
  delivery: OracleBackupDeliveryState | null,
) {
  return {
    ownerKind: owner.kind,
    ...oracleBackupStatus({
      binding: nativeOraclePublicationBinding(owner),
      destinations: nativeOracleDestinations(owner),
      publication: nativeOraclePublicationRecord(owner),
      importComplete: true,
      delivery,
    }),
  }
}
