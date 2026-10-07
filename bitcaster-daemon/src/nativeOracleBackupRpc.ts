import { OracleBackupAccessError, OracleBackupDeliveryError } from '@bitcaster-market/client-sdk'
import { createNativeOracleCreationStore } from './nativeOracleCreationStore.ts'
import { createNativeOracleHelperAdapter } from './nativeOracleHelper.ts'
import { activeNativeConfig } from './nativeConfig.ts'
import { profileDir, readProfile } from './profile.ts'
import { readSecrets } from './secrets.ts'
import {
  listNativeOracleBackups,
  restoreNativeOracleBackup,
  nativeOracleBackupStatus,
  nativeOracleBackupStatusFromSnapshot,
  NativeOracleBackupMissingError,
  type NativeOracleBackupAccessPorts,
} from './nativeOracleBackupAccess.ts'
import { publishNativeOracleBackup } from './nativeOracleBackup.ts'
import { publishNativeOracleBackupEvent } from './nativeOracleBackupRelay.ts'
import { publishNativeOracleEvent } from './nativeOraclePublication.ts'
import { nativeOracleDestinations } from './nativeOracleCreationStore.ts'
import type { DaemonCommand, DaemonResponse } from './protocol.ts'

export type NativeOracleAccessCommand = Extract<
  DaemonCommand,
  {
    method:
      | 'market.oracle-backup-list'
      | 'market.oracle-backup-restore'
      | 'market.oracle-backup-status'
      | 'market.oracle-backup-retry'
      | 'market.announcement-republish'
  }
>
export interface NativeOracleAccessRpcPorts extends NativeOracleBackupAccessPorts {
  readonly publishBackup: typeof publishNativeOracleBackupEvent
  readonly publishAnnouncement: typeof publishNativeOracleEvent
  readonly nowSeconds: () => number
}

export async function createNativeOracleAccessRpcPorts(): Promise<NativeOracleAccessRpcPorts> {
  if (!(await readProfile())) throw new Error('Local oracle profile is unavailable.')
  return {
    store: createNativeOracleCreationStore(profileDir()),
    helper: createNativeOracleHelperAdapter(),
    relayUrls: activeNativeConfig().config.daemon.nostrRelays,
    async readPrivateKey() {
      const secrets = await readSecrets()
      if (secrets === null) throw new Error('Local oracle key is unavailable.')
      return Buffer.from(secrets.nostrSecretKeyHex, 'hex')
    },
    publishBackup: publishNativeOracleBackupEvent,
    publishAnnouncement: publishNativeOracleEvent,
    nowSeconds: () => Math.floor(Date.now() / 1000),
  }
}

export async function dispatchNativeOracleAccess(
  command: NativeOracleAccessCommand,
  supplied?: NativeOracleAccessRpcPorts,
): Promise<DaemonResponse> {
  try {
    const params: unknown = command.params
    if (typeof params !== 'object' || params === null || Array.isArray(params)) throw new Error()
    const ports = supplied ?? (await createNativeOracleAccessRpcPorts())
    switch (command.method) {
      case 'market.oracle-backup-list':
        if (command.params.relay !== undefined && typeof command.params.relay !== 'string')
          throw new Error()
        return {
          ok: true,
          result: await listNativeOracleBackups(ports, command.params.relay, command.params.cursor),
        }
      case 'market.oracle-backup-restore':
        if (typeof command.params.eventId !== 'string' || typeof command.params.relay !== 'string')
          throw new Error()
        return {
          ok: true,
          result: await restoreNativeOracleBackup(
            ports,
            command.params.eventId,
            command.params.relay,
          ),
        }
      case 'market.oracle-backup-status': {
        if (command.params.conditionId !== undefined) {
          if (command.params.cursor !== undefined || command.params.limit !== undefined)
            throw new Error()
          const owner = await ports.store.readAuthorityByConditionId(command.params.conditionId)
          if (owner === null) throw new Error()
          return { ok: true, result: await nativeOracleBackupStatus(ports.store, owner) }
        }
        const page = await ports.store.readAuthorityPage(command.params)
        return {
          ok: true,
          result: {
            statuses: page.items.map((item) =>
              nativeOracleBackupStatusFromSnapshot(item.owner, item.delivery),
            ),
            cursor: page.cursor,
          },
        }
      }
      case 'market.oracle-backup-retry': {
        const owner = await ports.store.readAuthorityByConditionId(command.params.conditionId)
        if (owner === null) throw new Error()
        const delivery = await publishNativeOracleBackup(
          { ...ports, publishRelay: ports.publishBackup },
          command.params.conditionId,
        )
        const current = await ports.store.readAuthorityByConditionId(command.params.conditionId)
        return {
          ok: true,
          result: {
            status: await nativeOracleBackupStatus(ports.store, current!),
            failures: delivery.failures,
          },
        }
      }
      case 'market.announcement-republish': {
        const owner = await ports.store.readAuthorityByConditionId(command.params.conditionId)
        if (owner?.announcement === null || owner === null) throw new Error()
        const result = await ports.publishAnnouncement(
          nativeOracleDestinations(owner).relayUrls,
          owner.announcement.announcementNostrEventJson,
        )
        return { ok: true, result }
      }
    }
  } catch (error) {
    if (
      error instanceof OracleBackupDeliveryError &&
      error.reason === 'terminal-backup-source-not-admitted'
    )
      return {
        ok: false,
        code: error.reason,
        error: 'This source version was not imported. Local exact retry remains available.',
      }
    if (error instanceof OracleBackupAccessError)
      return {
        ok: false,
        code: `oracle-backup-${error.reason}`,
        error:
          'Oracle backup access was refused. Check the selected owner, relay, and local status.',
      }
    if (error instanceof NativeOracleBackupMissingError)
      return {
        ok: false,
        code: 'oracle-backup-missing-event',
        error:
          'The selected oracle backup event is unavailable. Try another relay or refresh discovery.',
      }
    return {
      ok: false,
      code: 'oracle-backup-local-state',
      error:
        'Oracle backup operation did not complete. Check local status and retry the exact saved operation.',
    }
  }
}
