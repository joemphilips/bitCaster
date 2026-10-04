import { AbstractRelay, type SubscriptionParams } from 'nostr-tools/abstract-relay'
import type { Filter } from 'nostr-tools/filter'
import { verifyEvent, type Event } from 'nostr-tools/pure'
import { awaitAbortable } from '@bitcaster-market/client-sdk/engineClient'
import { normalizeNostrRelayUrls } from '@bitcaster-market/client-sdk/nostrRelays'

export interface NativeNostrRelayOptions {
  signal?: AbortSignal
  websocketImplementation?: typeof WebSocket
  connectTimeoutMs?: number
  publishTimeoutMs?: number
  /** Receiver-only framing. Ordinary publication keeps its existing socket behavior. */
  awaitMessageCallbacks?: boolean
  maxMessageBytes?: number
  onclose?: () => void
}

export interface NativeNostrSubscriptionHandlers {
  onevent: (event: Event) => void | Promise<void>
  oneose?: () => void
  onclose?: () => void
  eoseTimeoutMs?: number
}

function timeoutMs(value: number | undefined, fallback: number): number {
  const timeout = value ?? fallback
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
    throw new Error('Nostr relay timeout is invalid.')
  }
  return timeout
}

/** The public constructor seam binds one socket to the exact validated endpoint. */
function exactWebSocketImplementation(
  url: string,
  implementation: typeof WebSocket,
  isClosed: () => boolean,
  capture: (socket: WebSocket) => void,
  dispose: () => void,
  dispatchMessage?: (callback: WebSocket['onmessage'], event: MessageEvent) => Promise<void>,
): typeof WebSocket {
  class ExactSocket {
    static OPEN = 1
    private socket: WebSocket

    constructor() {
      if (isClosed()) throw new Error('Nostr relay is closed.')
      this.socket = new implementation(url)
      capture(this.socket)
    }
    private guard<T extends globalThis.Event>(
      callback: ((this: WebSocket, event: T) => unknown) | null,
    ): ((this: WebSocket, event: T) => unknown) | null {
      return (
        callback &&
        ((event) => {
          if (!isClosed()) callback.call(this.socket, event)
        })
      )
    }
    get readyState() {
      return this.socket.readyState
    }
    get onopen() {
      return this.socket.onopen
    }
    set onopen(callback: WebSocket['onopen']) {
      this.socket.onopen = this.guard(callback)
    }
    get onclose() {
      return this.socket.onclose
    }
    set onclose(callback: WebSocket['onclose']) {
      this.socket.onclose = this.guard(callback)
    }
    get onerror() {
      return this.socket.onerror
    }
    set onerror(callback: WebSocket['onerror']) {
      this.socket.onerror = this.guard(callback)
    }
    get onmessage() {
      return this.socket.onmessage
    }
    set onmessage(callback: WebSocket['onmessage']) {
      this.socket.onmessage =
        dispatchMessage && callback
          ? (event) => dispatchMessage(callback, event)
          : this.guard(callback)
    }
    send(message: string) {
      // Upstream queues sends behind connection readiness. Cancellation must fence those sends too.
      if (!isClosed()) this.socket.send(message)
    }
    close() {
      dispose()
    }
  }
  // AbstractRelay uses only this socket surface with ping disabled.
  return ExactSocket as unknown as typeof WebSocket
}

/** One terminal connection owner. Reconnect requires a fresh explicitly selected instance. */
export class NativeNostrRelay {
  readonly url: string
  private relay: AbstractRelay
  private options: NativeNostrRelayOptions
  private lifetime = new AbortController()
  private socket?: WebSocket
  private socketDisposed = false
  private stopped = false
  private connection?: Promise<void>
  private connectionTimer?: ReturnType<typeof setTimeout>
  private connectTimeoutMs: number
  private subscriptions = new Set<() => void>()
  private abort = () => this.close()
  private messageCallback?: Promise<void>

  constructor(url: string, options: NativeNostrRelayOptions = {}) {
    this.url = normalizeNostrRelayUrls([url])[0]!
    this.options = options
    this.connectTimeoutMs = timeoutMs(options.connectTimeoutMs, 3_000)
    const publishTimeout = timeoutMs(options.publishTimeoutMs, 5_000)
    if (
      options.maxMessageBytes !== undefined &&
      (!Number.isSafeInteger(options.maxMessageBytes) || options.maxMessageBytes <= 0)
    )
      throw new Error('Nostr relay frame bound is invalid.')
    this.relay = new AbstractRelay(this.url, {
      verifyEvent,
      enableReconnect: false,
      enablePing: false,
      websocketImplementation: exactWebSocketImplementation(
        this.url,
        options.websocketImplementation ?? WebSocket,
        () => this.stopped,
        (socket) => {
          this.socket = socket
        },
        () => this.disposeSocket(),
        options.awaitMessageCallbacks || options.maxMessageBytes !== undefined
          ? (callback, event) => this.dispatchMessage(callback, event)
          : undefined,
      ),
    })
    // An untrusted notice must not reach a default logger.
    this.relay.onnotice = () => {}
    this.relay.onclose = () => this.close()
    this.relay.publishTimeout = publishTimeout
    options.signal?.addEventListener('abort', this.abort, { once: true })
    if (options.signal?.aborted) this.close()
  }

  get connected(): boolean {
    return !this.stopped && this.relay.connected
  }
  get closed(): boolean {
    return this.stopped
  }

  async connect(): Promise<void> {
    if (this.stopped) throw new Error('Nostr relay is closed.')
    if (!this.connection) this.connection = this.connectOnce()
    return this.connection
  }

  private async connectOnce(): Promise<void> {
    // Upstream abort overwrites onabort and does not own a connecting socket or attempt timer.
    this.connectionTimer = setTimeout(() => this.close(), this.connectTimeoutMs)
    try {
      await awaitAbortable(this.relay.connect(), this.lifetime.signal)
    } catch {
      this.close()
      throw new Error('Nostr relay connection failed.')
    } finally {
      clearTimeout(this.connectionTimer)
      this.connectionTimer = undefined
    }
  }

  subscribe(
    filters: readonly Filter[],
    handlers: NativeNostrSubscriptionHandlers,
  ): { close: () => void } {
    if (!this.connected) throw new Error('Nostr relay is not connected.')
    let stopped = false
    const params: SubscriptionParams = {
      onevent: (event) => {
        if (!this.stopped && !stopped) {
          const completion = handlers.onevent(event)
          if (completion !== undefined) {
            this.messageCallback = Promise.resolve(completion)
            // Observe a rejection even if a caller uses a non-awaiting socket implementation.
            void this.messageCallback.catch(() => this.close())
          }
        }
      },
      oneose: () => {
        if (!this.stopped && !stopped) handlers.oneose?.()
      },
      eoseTimeout: timeoutMs(handlers.eoseTimeoutMs, this.relay.baseEoseTimeout),
      onclose: () => {
        const unsolicited = !stopped
        stop()
        if (unsolicited && !this.stopped) handlers.onclose?.()
      },
    }
    const subscription = this.relay.subscribe([...filters], params)
    const stop = () => {
      if (stopped) return
      stopped = true
      this.subscriptions.delete(stop)
      // Public EOSE completion clears the upstream timer. Suppress its callback during cleanup.
      subscription.receivedEose()
      subscription.close()
    }
    this.subscriptions.add(stop)
    return { close: stop }
  }

  private async dispatchMessage(
    callback: WebSocket['onmessage'],
    event: MessageEvent,
  ): Promise<void> {
    if (this.stopped) return
    const limit = this.options.maxMessageBytes
    if (
      limit !== undefined &&
      (typeof event.data !== 'string' ||
        event.data.length > limit ||
        Buffer.byteLength(event.data) > limit)
    ) {
      this.close()
      return
    }
    this.messageCallback = undefined
    callback?.call(this.socket!, event)
    if (this.options.awaitMessageCallbacks && this.messageCallback)
      await awaitAbortable(this.messageCallback, this.lifetime.signal)
  }

  async publish(event: Event): Promise<void> {
    if (!this.connected) throw new Error('Nostr relay is not connected.')
    try {
      await awaitAbortable(this.relay.publish(event), this.lifetime.signal)
    } catch {
      throw new Error('Nostr relay publication failed.')
    }
  }

  close(): void {
    if (this.stopped) return
    this.stopped = true
    clearTimeout(this.connectionTimer)
    this.connectionTimer = undefined
    this.options.signal?.removeEventListener('abort', this.abort)
    for (const stop of [...this.subscriptions]) stop()
    this.relay.close()
    this.disposeSocket()
    this.lifetime.abort()
    this.options.onclose?.()
  }

  private disposeSocket(): void {
    if (!this.socket || this.socketDisposed) return
    this.socketDisposed = true
    this.socket.onopen = this.socket.onclose = this.socket.onerror = this.socket.onmessage = null
    try {
      this.socket.close()
    } catch {
      /* Terminal state remains authoritative. */
    }
  }
}

/** Selection is explicit. An empty list creates no connection owner and no socket. */
export function createNativeNostrRelays(
  urls: readonly string[],
  options: NativeNostrRelayOptions = {},
): NativeNostrRelay[] {
  return normalizeNostrRelayUrls(urls).map((url) => new NativeNostrRelay(url, options))
}
