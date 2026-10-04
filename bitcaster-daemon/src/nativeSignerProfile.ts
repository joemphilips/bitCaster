import {
  readNostrProfile,
  type NostrProfileQuery,
  type NostrProfileReadResult,
} from '@bitcaster-market/client-sdk'
import { NativeNostrRelay, type NativeNostrRelayOptions } from './nativeNostrRelay.ts'
import { readNativeConfig } from './nativeConfig.ts'
import { readSelectedDaemonSigner, type SelectedDaemonSigner } from './secrets.ts'

export interface NativeSignerProfileResult extends NostrProfileReadResult {
  readonly signer: SelectedDaemonSigner
}

/** A fresh public read never opens the secret authority or changes the selected signer. */
export async function readNativeSignerProfile(
  options: Pick<NativeNostrRelayOptions, 'websocketImplementation'> = {},
): Promise<NativeSignerProfileResult> {
  const signer = await readSelectedDaemonSigner()
  if (!signer.enabled)
    throw new Error('Signer is disconnected. Connect the saved signer before reading its profile.')
  const config = readNativeConfig()
  const result = await readNostrProfile(
    signer.publicKeyHex,
    config.config.daemon.nostrRelays,
    nativeProfileQuery(options),
  )
  const current = await readSelectedDaemonSigner()
  const currentConfig = readNativeConfig()
  if (
    current.revision !== signer.revision ||
    current.publicKeyHex !== signer.publicKeyHex ||
    current.enabled !== signer.enabled ||
    currentConfig.revision !== config.revision
  )
    throw new Error(
      'Signer or relay settings changed during the profile read. Retry with the current selection.',
    )
  return { signer, ...result }
}

function nativeProfileQuery(
  options: Pick<NativeNostrRelayOptions, 'websocketImplementation'>,
): NostrProfileQuery {
  return (url, filter, onEvent) =>
    new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        relay.close()
        if (error) reject(error)
        else resolve()
      }
      const relay = new NativeNostrRelay(url, {
        ...options,
        maxMessageBytes: 131_072,
        onclose: () => finish(new Error('Nostr profile relay closed.')),
      })
      const timer = setTimeout(() => finish(new Error('Nostr profile relay timed out.')), 8_000)
      void relay
        .connect()
        .then(() => {
          if (settled) return
          relay.subscribe([filter], {
            onevent: onEvent,
            oneose: () => finish(),
            onclose: () => finish(new Error('Nostr profile subscription closed.')),
            // The owned deadline must win over upstream synthetic EOSE on timeout.
            eoseTimeoutMs: 8_001,
          })
        })
        .catch(() => finish(new Error('Nostr profile relay connection failed.')))
    })
}
