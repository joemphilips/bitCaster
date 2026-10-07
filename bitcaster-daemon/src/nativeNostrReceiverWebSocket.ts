import WebSocket, { createWebSocketStream } from 'ws'
import { awaitAbortable } from '@bitcaster-market/client-sdk/engineClient'
import { NIP17_PAYMENT_REQUEST_FRAME_BYTES_MAX } from '@bitcaster-market/client-sdk/nip17PaymentRequest'

/** The receiver alone uses Node's public framed stream to apply inbound backpressure. */
export function createNativeNostrReceiverWebSocket(
  implementation: typeof WebSocket = WebSocket,
): typeof globalThis.WebSocket {
  class ReceiverSocket {
    static OPEN = WebSocket.OPEN
    readonly #socket: WebSocket
    readonly #stream: ReturnType<typeof createWebSocketStream>
    readonly #lifetime = new AbortController()
    #closed = false
    onopen: globalThis.WebSocket['onopen'] = null
    onclose: globalThis.WebSocket['onclose'] = null
    onerror: globalThis.WebSocket['onerror'] = null
    onmessage: globalThis.WebSocket['onmessage'] = null

    constructor(url: string) {
      this.#socket = new implementation(url, {
        maxPayload: NIP17_PAYMENT_REQUEST_FRAME_BYTES_MAX,
        perMessageDeflate: false,
        followRedirects: false,
      })
      this.#stream = createWebSocketStream(this.#socket, {
        readableObjectMode: true,
        readableHighWaterMark: 1,
      })
      this.#socket.on('open', this.#open)
      this.#socket.on('close', this.#remoteClose)
      this.#socket.on('error', this.#error)
      // Stream errors stay private. The terminal notification contains no raw error.
      this.#stream.on('error', this.#error)
      void this.#pump()
    }

    get readyState(): number {
      return this.#socket.readyState
    }
    send(message: string): void {
      if (!this.#closed) this.#socket.send(message)
    }
    close(): void {
      this.#finish(false)
    }

    readonly #open = () => {
      if (!this.#closed)
        this.onopen?.call(this as unknown as globalThis.WebSocket, new Event('open'))
    }
    readonly #remoteClose = () => this.#finish(true)
    readonly #error = () => this.#finish(true)

    async #pump(): Promise<void> {
      try {
        for await (const frame of this.#stream) {
          if (this.#closed) break
          if (
            typeof frame !== 'string' ||
            Buffer.byteLength(frame) > NIP17_PAYMENT_REQUEST_FRAME_BYTES_MAX
          )
            throw new Error('Nostr receiver frame is invalid.')
          const delivered = this.onmessage?.call(
            this as unknown as globalThis.WebSocket,
            new MessageEvent('message', { data: frame }),
          )
          await awaitAbortable(Promise.resolve(delivered), this.#lifetime.signal)
        }
      } catch {
        // The stream or callback can expose private data in its error. Do not forward it.
      } finally {
        this.#finish(true)
      }
    }

    #finish(remote: boolean): void {
      if (this.#closed) return
      this.#closed = true
      this.#lifetime.abort()
      this.#socket.off('open', this.#open)
      this.#socket.off('close', this.#remoteClose)
      if (this.#socket.readyState === WebSocket.CLOSED) this.#socket.off('error', this.#error)
      else this.#socket.once('close', () => this.#socket.off('error', this.#error))
      // Destroy owns connecting sockets as well as open sockets. It never waits on onContent.
      this.#stream.destroy()
      // A stream error can disable its termination path. The socket is still ours.
      if (this.#socket.readyState !== WebSocket.CLOSED) this.#socket.terminate()
      const notify = this.onclose
      this.onopen = this.onclose = this.onerror = this.onmessage = null
      if (remote)
        notify?.call(this as unknown as globalThis.WebSocket, new Event('close') as CloseEvent)
    }
  }
  // nostr-tools uses the standard property callbacks; the stream owns the Node socket.
  return ReceiverSocket as unknown as typeof globalThis.WebSocket
}
