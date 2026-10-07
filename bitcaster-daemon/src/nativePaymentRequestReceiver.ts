import type WebSocket from 'ws'
import {
  decryptNip17PaymentRequestMessage,
  encodeNip17PaymentRequestNprofile,
  NIP17_PAYMENT_REQUEST_FRAME_BYTES_MAX,
} from '@bitcaster-market/client-sdk/nip17PaymentRequest'
import { derivePaymentRequestReceiveKeyPair } from '@bitcaster-market/client-sdk/paymentRequest'
import { normalizeNostrRelayUrls } from '@bitcaster-market/client-sdk/nostrRelays'
import { awaitAbortable } from '@bitcaster-market/client-sdk/engineClient'
import { NativeNostrRelay } from './nativeNostrRelay.ts'
import { createNativeNostrReceiverWebSocket } from './nativeNostrReceiverWebSocket.ts'

interface ReceiverSubscriptionInput {
  readonly signal: AbortSignal
  readonly onContent: (content: string) => Promise<void>
  readonly onclose?: () => void
}

const ARCHIVE_WINDOW_SECONDS = 7 * 24 * 60 * 60

/** Own seed-bound NIP-17 transport only. The service supplies the sole custody callback. */
export function createNativePaymentRequestReceiver(input: {
  readonly walletSeedHex: string
  readonly relayUrls: readonly string[]
  readonly websocketImplementation?: typeof WebSocket
  readonly connectTimeoutMs?: number
  readonly now?: () => number
}): {
  readonly nprofile: string
  subscribe(input: ReceiverSubscriptionInput): Promise<{ close(): void }>
} {
  if (!/^[0-9a-f]{128}$/.test(input.walletSeedHex))
    throw new Error('payment receive identity is invalid')
  const keys = derivePaymentRequestReceiveKeyPair(
    new Uint8Array(Buffer.from(input.walletSeedHex, 'hex')),
  )
  const relays = normalizeNostrRelayUrls(input.relayUrls)
  const implementation = createNativeNostrReceiverWebSocket(input.websocketImplementation)
  const now = input.now ?? Date.now

  return {
    get nprofile() {
      // Request encoding limits must not disable saved transport or receipt recovery.
      return encodeNip17PaymentRequestNprofile(keys.publicKey, relays)
    },
    async subscribe(subscription): Promise<{ close(): void }> {
      if (subscription.signal.aborted)
        throw new Error('native payment request receiver is unavailable')
      if (relays.length === 0) return { close() {} }
      const lifetime = new AbortController()
      const owners: NativeNostrRelay[] = []
      const active = new Set<NativeNostrRelay>()
      const pending = new Set<string>()
      let closed = false
      let starting = true
      const close = () => {
        if (closed) return
        closed = true
        subscription.signal.removeEventListener('abort', close)
        lifetime.abort()
        for (const relay of owners) relay.close()
        pending.clear()
      }
      const terminated = (relay: NativeNostrRelay) => {
        active.delete(relay)
        if (!closed && !starting && active.size === 0) {
          close()
          subscription.onclose?.()
        }
      }
      subscription.signal.addEventListener('abort', close, { once: true })
      const deliver = async (
        event: Parameters<typeof decryptNip17PaymentRequestMessage>[0]['wrap'],
        relay: NativeNostrRelay,
      ) => {
        if (closed || lifetime.signal.aborted || relay.closed) return
        const message = decryptNip17PaymentRequestMessage({
          wrap: event,
          privateKey: keys.privateKey,
        })
        if (message === null || pending.has(message.rumorId)) return
        pending.add(message.rumorId)
        try {
          await awaitAbortable(subscription.onContent(message.content), lifetime.signal)
        } catch {
          if (!closed) throw new Error('native payment request delivery failed')
        } finally {
          pending.delete(message.rumorId)
        }
      }

      try {
        for (const url of relays) {
          const relay = new NativeNostrRelay(url, {
            signal: lifetime.signal,
            websocketImplementation: implementation,
            connectTimeoutMs: input.connectTimeoutMs,
            awaitMessageCallbacks: true,
            maxMessageBytes: NIP17_PAYMENT_REQUEST_FRAME_BYTES_MAX,
            onclose: () => terminated(relay),
          })
          owners.push(relay)
        }
        await awaitAbortable(
          Promise.allSettled(
            owners.map(async (relay) => {
              await relay.connect()
              if (closed || relay.closed) return
              active.add(relay)
              relay.subscribe(
                [
                  {
                    kinds: [1059],
                    '#p': [keys.publicKey],
                    since: Math.floor(now() / 1_000) - ARCHIVE_WINDOW_SECONDS,
                  },
                ],
                {
                  onevent: (event) => deliver(event, relay),
                  onclose: () => relay.close(),
                },
              )
            }),
          ),
          lifetime.signal,
        )
        starting = false
        if (closed || active.size === 0) throw new Error()
        return { close }
      } catch {
        close()
        throw new Error('native payment request receiver is unavailable')
      }
    },
  }
}
