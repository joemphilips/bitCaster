import { getPublicKey } from 'nostr-tools/pure'
import {
  listOracleBackups,
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
  const author = getPublicKey(await ports.readPrivateKey())
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const result = await (ports.queryRelay ?? queryNativeOracleBackupRelay)({
      relayUrl,
      signal: controller.signal,
      maxEvents: 32,
      maxBytes: 32 * 96 * 1024,
      filter: { kinds: [30078], authors: [author], '#v': ['1'], ids: [eventId], limit: 1 },
    })
    const selected = result.events.find(
      (event) =>
        typeof event === 'object' && event !== null && 'id' in event && event.id === eventId,
    )
    if (selected === undefined) throw new NativeOracleBackupMissingError()
    // The store obtains its own matching local key and commits authenticated source atomically.
    const owner = await ports.store.importBackupEnvelope(selected, relayUrl, ports.helper)
    return nativeOracleBackupStatus(ports.store, owner)
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
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
