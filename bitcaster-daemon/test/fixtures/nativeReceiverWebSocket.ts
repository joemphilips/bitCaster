import { EventEmitter } from 'node:events'
import type WebSocket from 'ws'

export function fakeReceiverWebSocket() {
  const sockets: FakeSocket[] = []
  class FakeSocket extends EventEmitter {
    static OPEN = 1
    static CLOSED = 3
    static CONNECTING = 0
    OPEN = 1
    CLOSED = 3
    CONNECTING = 0
    readyState = 0
    readonly url: string
    readonly options: WebSocket.ClientOptions
    isPaused = false
    closeCount = 0
    pauseCount = 0
    resumeCount = 0
    sent: string[] = []
    backlog: string[] = []
    #draining = false
    #residual = 0

    constructor(url: string, options: WebSocket.ClientOptions) {
      super()
      this.url = url
      this.options = options
      sockets.push(this)
    }
    open() {
      this.readyState = this.OPEN
      this.emit('open')
    }
    remoteClose() {
      this.readyState = this.CLOSED
      this.emit('close')
    }
    fail() {
      this.emit('error', new Error('untrusted transport details'))
    }
    terminate() {
      if (this.readyState === this.CLOSED) return
      this.closeCount += 1
      this.readyState = this.CLOSED
      this.backlog.length = 0
      this.emit('close')
    }
    pause() {
      this.isPaused = true
      this.pauseCount += 1
    }
    resume() {
      this.isPaused = false
      this.resumeCount += 1
      this.#drain()
    }
    send(value: string, callback?: (error?: Error) => void) {
      this.sent.push(value)
      callback?.()
    }
    archive(frames: string[], residual = 0) {
      this.backlog.push(...frames)
      this.#residual = residual
      this.#drain()
    }
    #drain() {
      if (this.#draining) return
      this.#draining = true
      try {
        while (
          this.readyState === this.OPEN &&
          this.backlog.length > 0 &&
          (!this.isPaused || this.#residual > 0)
        ) {
          if (this.isPaused) this.#residual -= 1
          this.emit('message', Buffer.from(this.backlog.shift()!), false)
        }
      } finally {
        this.#draining = false
      }
    }
  }
  return { sockets, implementation: FakeSocket as unknown as typeof WebSocket }
}
