import type { Event as NostrEvent } from 'nostr-tools/pure'

export interface BookmarkRelayFixtureOptions {
  readonly events?: readonly NostrEvent[]
  readonly failConnect?: boolean
  readonly failPublish?: boolean
  readonly onFrame?: (url: string, frame: unknown[]) => void
}

/** In-memory WebSocket boundary. Native relay filtering and signature checks remain real. */
export function bookmarkRelayFixture(options: BookmarkRelayFixtureOptions = {}) {
  const sockets: FakeSocket[] = []
  class FakeSocket {
    static OPEN = 1
    readyState = 0
    onopen: WebSocket['onopen'] = null
    onerror: WebSocket['onerror'] = null
    onclose: WebSocket['onclose'] = null
    onmessage: WebSocket['onmessage'] = null
    frames: unknown[][] = []
    closeCount = 0
    readonly url: string
    constructor(url: string) {
      this.url = url
      sockets.push(this)
      queueMicrotask(() => {
        if (this.readyState === 3) return
        if (options.failConnect)
          this.onerror?.call(this as unknown as WebSocket, new Event('error'))
        else {
          this.readyState = 1
          this.onopen?.call(this as unknown as WebSocket, new Event('open'))
        }
      })
    }
    send(value: string) {
      const frame = JSON.parse(value) as unknown[]
      this.frames.push(frame)
      options.onFrame?.(this.url, frame)
      queueMicrotask(() => {
        if (frame[0] === 'REQ') {
          for (const event of options.events ?? []) this.message(['EVENT', frame[1], event])
          this.message(['EOSE', frame[1]])
        } else if (frame[0] === 'EVENT') {
          const event = frame[1] as NostrEvent
          this.message(['OK', event.id, options.failPublish !== true, 'fixture'])
        }
      })
    }
    message(frame: unknown[]) {
      if (this.readyState === 3) return
      this.onmessage?.call(
        this as unknown as WebSocket,
        new MessageEvent('message', { data: JSON.stringify(frame) }),
      )
    }
    close() {
      this.closeCount += 1
      this.readyState = 3
      this.onclose?.call(this as unknown as WebSocket, new Event('close') as CloseEvent)
    }
  }
  return { sockets, websocketImplementation: FakeSocket as unknown as typeof WebSocket }
}
