import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { createNativePaymentRequestReceiver } from '../src/nativePaymentRequestReceiver.ts'
import { fakeReceiverWebSocket } from './fixtures/nativeReceiverWebSocket.ts'
import type { DaemonServerOptions } from '../src/server.ts'
import { updateNativeConfig } from '../src/nativeConfig.ts'
import { disconnectDaemonSigner } from '../src/secrets.ts'
import { releaseCustodyScopeLease } from '../src/profileFencing.ts'
import * as walletOps from '../src/walletOps.ts'
import { assertRedacted, SEED, serviceFixture } from './nativePaymentRequestServiceFixture.ts'

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'expected main lifecycle transition did not occur')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

test('actual disconnected main composes request recovery and closes request and local wallet watches before server shutdown', async () => {
  const f = await serviceFixture()
  const previousArgv = process.argv
  let options: DaemonServerOptions | undefined
  let blocked = true
  let subscribed = 0
  let scans = 0
  let watchClosed = false
  let liveWatchClosed: Promise<unknown> = Promise.resolve()
  const events: string[] = []
  const exits: number[] = []
  const signals = new Map<string, () => void>()
  const selected = [`wss://relay.example/${'x'.repeat(256)}`]
  const transport = fakeReceiverWebSocket()
  try {
    await f.ops.create({ requestId: 'request', nprofile: f.nprofile })
    await releaseCustodyScopeLease(f.directory, f.deps.getCustodyFence!(), Date.now())
    await disconnectDaemonSigner(0)
    updateNativeConfig((config) => ({
      ...config,
      daemon: { ...config.daemon, nostrRelays: selected, assetMonitoringEnabled: true },
    }))
    const once = process.once
    mock.method(
      process,
      'once',
      function (this: typeof process, event: string, listener: () => void) {
        if (event === 'SIGTERM' || event === 'SIGINT') {
          signals.set(event, listener)
          return this
        }
        return once.call(this, event, listener)
      },
    )
    mock.method(process, 'exit', (code: number) => {
      exits.push(code)
    })
    mock.module(new URL('../src/walletOps.ts', import.meta.url).href, {
      namedExports: {
        ...walletOps,
        recoverPreparedWalletSends: async () => {
          scans++
          return {
            recovered: [],
            pending: blocked ? [{ operationId: 'existing-pending', error: 'retry' }] : [],
          }
        },
      },
    })
    class Hub {
      async start() {}
      async stop() {
        events.push('hub-stop')
      }
      async trackOrder() {}
      async setManagedMarkets() {}
    }
    mock.module(new URL('../src/orderHubConnection.ts', import.meta.url).href, {
      namedExports: { SignalROrderLifecycleConnection: Hub },
    })
    mock.module(new URL('../src/marketHubConnection.ts', import.meta.url).href, {
      namedExports: { SignalRMarketHubConnection: Hub },
    })
    mock.module(new URL('../src/nativePaymentRequestReceiver.ts', import.meta.url).href, {
      namedExports: {
        createNativePaymentRequestReceiver: (input: {
          walletSeedHex: string
          relayUrls: readonly string[]
        }) => {
          assert.equal(input.walletSeedHex === SEED, true, 'main did not use wallet seed identity')
          assert.deepEqual(input.relayUrls, selected)
          const receiver = createNativePaymentRequestReceiver({
            ...input,
            websocketImplementation: transport.implementation,
          })
          return {
            get nprofile() {
              return receiver.nprofile
            },
            subscribe: async (subscription: Parameters<typeof receiver.subscribe>[0]) => {
              const pending = receiver.subscribe(subscription)
              setImmediate(() => transport.sockets.at(-1)!.open())
              const owner = await pending
              subscribed++
              return {
                close: () => {
                  owner.close()
                  events.push('receiver-close')
                },
              }
            },
          }
        },
      },
    })
    mock.module(new URL('../src/server.ts', import.meta.url).href, {
      namedExports: {
        startDaemonServer: async (input: DaemonServerOptions) => {
          options = input
          return {
            close: (done: () => void) => {
              assert.equal(watchClosed, true, 'server closed before request watch settled')
              void liveWatchClosed.then(() => {
                events.push('server-close')
                done()
              })
            },
          }
        },
      },
    })
    process.argv = [
      process.execPath,
      new URL('../src/main.ts', import.meta.url).pathname,
      '--datadir',
      f.directory,
      'run',
    ]
    await import('../src/main.ts')
    assert.ok(options?.nativePaymentRequests)
    assert.throws(
      () =>
        options!.watch!(
          { method: 'market.watch', params: { conditionIds: ['condition'] } },
          new AbortController().signal,
        ),
      { message: 'Application signer is disconnected.' },
    )
    assert.throws(
      () =>
        options!.watch!(
          { method: 'wallet.request.watch', params: { requestId: 'request' } },
          new AbortController().signal,
        ),
      { message: 'Payment request watches require the request service dispatcher' },
    )
    assert.equal(options.isCustodyReady?.(), false)
    assert.equal(subscribed, 0)
    blocked = false
    options.triggerCustodyRecovery?.()
    await until(() => subscribed === 1)
    assert.equal(options.isCustodyReady?.(), true)
    assert.equal(scans, 2)
    assert.equal(transport.sockets[0]!.url, selected[0])
    await assert.rejects(options.nativePaymentRequests.create({ requestId: 'unencodable' }), {
      message: 'payment receive nprofile is invalid',
    })
    assert.equal(await f.requestCount(), 1)
    assert.equal(
      (await options.nativePaymentRequests.status({ requestId: 'request' })).state,
      'awaiting',
    )
    const watch = options.nativePaymentRequests
      .watch('request', new AbortController().signal)
      [Symbol.asyncIterator]()
    await watch.next()
    const waiting = watch.next().then((result) => {
      watchClosed = result.done === true
    })
    const walletSource = await options.watch!(
      { method: 'wallet.watch' },
      new AbortController().signal,
    )
    const walletWatch = walletSource[Symbol.asyncIterator]()
    const localSnapshot = await walletWatch.next()
    assert.equal(localSnapshot.value?.event, 'wallet.snapshot')
    assert.equal(
      (localSnapshot.value?.data as { monitoring: { status: string } }).monitoring.status,
      'disabled',
    )
    liveWatchClosed = walletWatch.next().then(
      (result) => assert.equal(result.done, true),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'request aborted')
      },
    )
    signals.get('SIGTERM')!()
    await until(() => exits.length === 1)
    await waiting
    assert.deepEqual(exits, [0])
    assert.equal(events.filter((event) => event === 'receiver-close').length, 1)
    assert.ok(events.indexOf('receiver-close') < events.indexOf('server-close'))
    assertRedacted(events)
  } finally {
    await options?.nativePaymentRequests?.stop()
    process.argv = previousArgv
    mock.restoreAll()
    await f.close()
  }
})
