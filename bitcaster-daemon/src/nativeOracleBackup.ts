import {
  deliverOracleBackup,
  retryOracleBackupDelivery,
  type OracleBackupDeliveryState,
} from '@bitcaster-market/client-sdk'
import type { createNativeOracleCreationStore } from './nativeOracleCreationStore.ts'
import type { NativeOracleHelper } from './nativeOracleHelper.ts'

export interface NativeOracleBackupPorts {
  readonly store: ReturnType<typeof createNativeOracleCreationStore>
  readonly helper: NativeOracleHelper
  readonly nowSeconds: () => number
  readonly publishRelay: (
    relayUrl: string,
    eventJson: string,
  ) => Promise<{ eventId: string; relayUrl: string }>
}

function deliveryPorts(ports: NativeOracleBackupPorts) {
  return {
    store: {
      read: ports.store.readBackupDelivery.bind(ports.store),
      prepare: (conditionId: string) =>
        ports.store.prepareBackupDelivery(conditionId, ports.helper, ports.nowSeconds()),
      confirm: ports.store.confirmBackupDelivery.bind(ports.store),
      commitTerminal: ports.store.commitBackupTerminal.bind(ports.store),
    },
    publishRelay: ports.publishRelay,
  }
}

/** Prepare and save under the owner CAS before any relay publication. */
export function publishNativeOracleBackup(ports: NativeOracleBackupPorts, conditionId: string) {
  return deliverOracleBackup(deliveryPorts(ports), conditionId)
}

/** Replay saved envelopes and deletion events without signer or helper work. */
export function retryNativeOracleBackup(
  ports: Pick<NativeOracleBackupPorts, 'store' | 'publishRelay'>,
  conditionId: string,
) {
  return retryOracleBackupDelivery(
    {
      store: {
        read: ports.store.readBackupDelivery.bind(ports.store),
        prepare: async (): Promise<OracleBackupDeliveryState> => {
          throw new Error('Private oracle backup preparation is unavailable.')
        },
        confirm: ports.store.confirmBackupDelivery.bind(ports.store),
        commitTerminal: ports.store.commitBackupTerminal.bind(ports.store),
      },
      publishRelay: ports.publishRelay,
    },
    conditionId,
  )
}
