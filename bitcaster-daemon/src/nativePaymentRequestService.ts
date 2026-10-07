import { awaitAbortable } from '@bitcaster-market/client-sdk/engineClient'
import {
  NativePaymentRequestOps,
  type NativePaymentRequestView,
} from './nativePaymentRequestOps.ts'
import type { NativePaymentRequestReceiptStatus } from './nativePaymentRequestReceiptCoordinator.ts'
import type { NativePaymentRequestIndexPage } from './nativePaymentRequestReceiptSqlite.ts'
import type { DaemonWatchEvent } from './protocol.ts'
import { profileDir, type DaemonProfile } from './profile.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import type { WalletOpsDependencies, WalletOpsSecrets } from './walletOps.ts'
import { subscribeToDaemonWalletHoldingsCommits } from './stateSqlite.ts'

/** The receiver owns NIP-17 and relay I/O. Abort must cancel an in-progress subscription. */
export interface NativePaymentRequestReceiver {
  readonly nprofile: string
  subscribe(input: {
    readonly signal: AbortSignal
    readonly onContent: (content: string) => Promise<void>
    readonly onclose?: () => void
  }): Promise<{ close(): void | Promise<void> }>
}

/** Production entry composes the same receive/import authority as ordinary wallet operations. */
export function createNativePaymentRequestService(input: {
  readonly profile: DaemonProfile
  readonly secrets: WalletOpsSecrets
  readonly getFence: () => CustodyScopeFence
  readonly receiver: NativePaymentRequestReceiver
  readonly isCustodyReady: () => boolean
  readonly triggerCustodyRecovery: () => void
  readonly deps?: WalletOpsDependencies
}): NativePaymentRequestService {
  return new NativePaymentRequestService({
    ops: new NativePaymentRequestOps(input),
    receiver: input.receiver,
    isCustodyReady: input.isCustodyReady,
    triggerCustodyRecovery: input.triggerCustodyRecovery,
  })
}

/** Own one process receiver. Watch cancellation does not discard a pending request. */
export class NativePaymentRequestService {
  readonly #ops: Pick<
    NativePaymentRequestOps,
    'create' | 'status' | 'list' | 'receive' | 'recover' | 'hasUncreditedRequests'
  >
  readonly #receiver: NativePaymentRequestReceiver
  readonly #isCustodyReady: () => boolean
  readonly #triggerCustodyRecovery: () => void
  readonly #listeners = new Set<() => void>()
  readonly #watchClosers = new Set<() => void>()
  readonly #unsubscribeCommit: () => void
  #controller: AbortController | undefined
  #connection: { close(): void | Promise<void> } | undefined
  #opening: Promise<void> | undefined
  #stopped = false

  constructor(input: {
    readonly ops: Pick<
      NativePaymentRequestOps,
      'create' | 'status' | 'list' | 'receive' | 'recover' | 'hasUncreditedRequests'
    >
    readonly receiver: NativePaymentRequestReceiver
    readonly isCustodyReady: () => boolean
    readonly triggerCustodyRecovery: () => void
    readonly directory?: string
  }) {
    this.#ops = input.ops
    this.#receiver = input.receiver
    this.#isCustodyReady = input.isCustodyReady
    this.#triggerCustodyRecovery = input.triggerCustodyRecovery
    this.#unsubscribeCommit = subscribeToDaemonWalletHoldingsCommits(
      input.directory ?? profileDir(),
      () => this.#invalidate(),
    )
  }

  async create(input: { readonly requestId?: string } = {}): Promise<NativePaymentRequestView> {
    if (this.#stopped || !this.#isCustodyReady())
      throw new Error('native payment request receiver is unavailable')
    const request = await this.#ops.create({ ...input, nprofile: this.#receiver.nprofile })
    await this.#ensureReceiver()
    return request
  }

  status(input: { readonly requestId: string }): Promise<NativePaymentRequestReceiptStatus> {
    return this.#ops.status(input)
  }

  list(input: {
    readonly cursor: string | null
    readonly limit?: number
  }): Promise<NativePaymentRequestIndexPage> {
    return this.#ops.list(input)
  }

  async recover(input: { readonly requestId: string }): Promise<NativePaymentRequestReceiptStatus> {
    try {
      return await this.#ops.recover(input)
    } finally {
      this.#invalidate()
      this.#triggerCustodyRecovery()
    }
  }

  /** Call after the existing startup or manual funds recovery updates its write gate. */
  async resumeReceiving(): Promise<boolean> {
    if (this.#stopped) return false
    if (!this.#isCustodyReady()) {
      await this.#pauseReceiver()
      return false
    }
    if (!(await this.#ops.hasUncreditedRequests())) {
      await this.#pauseReceiver()
      this.#invalidate()
      return false
    }
    await this.#ensureReceiver()
    this.#invalidate()
    return true
  }

  async stop(): Promise<void> {
    if (this.#stopped) return
    this.#stopped = true
    this.#controller?.abort()
    this.#unsubscribeCommit()
    for (const close of [...this.#watchClosers]) close()
    this.#listeners.clear()
    const connection = this.#connection
    this.#connection = undefined
    try {
      await connection?.close()
    } catch {
      throw new Error('native payment request receiver shutdown failed')
    }
  }

  watch(
    requestId: string,
    signal: AbortSignal,
  ): AsyncIterable<DaemonWatchEvent<NativePaymentRequestReceiptStatus>> {
    let closed = this.#stopped || signal.aborted
    let dirty = true
    let wake: (() => void) | undefined
    let previous = ''
    const invalidate = () => {
      dirty = true
      wake?.()
      wake = undefined
    }
    const close = () => {
      closed = true
      wake?.()
      wake = undefined
      this.#listeners.delete(invalidate)
      this.#watchClosers.delete(close)
      signal.removeEventListener('abort', close)
    }
    this.#listeners.add(invalidate)
    this.#watchClosers.add(close)
    signal.addEventListener('abort', close, { once: true })
    const source: AsyncIterable<DaemonWatchEvent<NativePaymentRequestReceiptStatus>> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          while (!closed) {
            if (!dirty)
              await new Promise<void>((resolve) => {
                wake = resolve
              })
            if (closed) break
            dirty = false
            let status: NativePaymentRequestReceiptStatus
            try {
              status = await this.#ops.status({ requestId })
            } catch {
              close()
              throw new Error('native payment request status is unavailable')
            }
            if (closed) break
            const fingerprint = JSON.stringify(status)
            if (fingerprint === previous) continue
            previous = fingerprint
            if (status.state === 'credited') close()
            return {
              done: false,
              value: { type: 'event', event: 'wallet-request-status', data: status },
            }
          }
          close()
          return { done: true, value: undefined }
        },
        return: async () => {
          close()
          return { done: true, value: undefined }
        },
      }),
    }
    if (closed) close()
    return source
  }

  #invalidate(): void {
    for (const listener of this.#listeners) listener()
  }

  async #pauseReceiver(): Promise<void> {
    this.#controller?.abort()
    this.#opening = undefined
    const connection = this.#connection
    this.#connection = undefined
    await connection?.close()
  }

  async #ensureReceiver(): Promise<void> {
    if (this.#stopped || !this.#isCustodyReady())
      throw new Error('native payment request receiver is unavailable')
    if (this.#connection !== undefined) return
    if (this.#opening !== undefined) return this.#opening
    const controller = new AbortController()
    this.#controller = controller
    const opened = Promise.resolve()
      .then(() =>
        this.#receiver.subscribe({
          signal: controller.signal,
          onclose: () => {
            if (this.#controller !== controller) return
            controller.abort()
            this.#connection = undefined
            this.#opening = undefined
          },
          onContent: async (content) => {
            if (this.#stopped || controller.signal.aborted) return
            if (!this.#isCustodyReady()) {
              await this.#pauseReceiver()
              return
            }
            try {
              const received = await this.#ops.receive(content)
              if (received !== null) this.#invalidate()
            } catch {
              this.#invalidate()
              this.#triggerCustodyRecovery()
            }
          },
        }),
      )
      .then(async (connection) => {
        if (controller.signal.aborted || this.#stopped) {
          await connection.close()
          return
        }
        this.#connection = connection
      })
    const opening = awaitAbortable(opened, controller.signal).catch(() => {
      throw new Error('native payment request receiver is unavailable')
    })
    this.#opening = opening
    try {
      await opening
    } finally {
      if (this.#opening === opening) this.#opening = undefined
    }
  }
}
