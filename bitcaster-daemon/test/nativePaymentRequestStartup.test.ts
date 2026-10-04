import assert from 'node:assert/strict'
import test from 'node:test'
import { createAmountlessCashuPaymentRequest } from '@bitcaster-market/client-sdk/paymentRequest'
import { CheckStateEnum } from '@cashu/cashu-ts'
import { createNativePaymentRequestReceiver } from '../src/nativePaymentRequestReceiver.ts'
import { fakeReceiverWebSocket } from './fixtures/nativeReceiverWebSocket.ts'
import * as requests from '../src/nativePaymentRequestService.ts'
import { readProfile } from '../src/profile.ts'
import { readSecrets } from '../src/secrets.ts'
import { withDaemonStateSqliteTransaction } from '../src/stateSqlite.ts'
import { createCustodyReadinessTracker } from '../src/startupRecovery.ts'
import { dispatch, type EngineClientLike } from '../src/server.ts'
import {
  assertRedacted,
  message,
  SEED,
  serviceFixture,
} from './nativePaymentRequestServiceFixture.ts'

async function production(input: {
  readonly receiver: requests.NativePaymentRequestReceiver
  readonly isReady: () => boolean
  readonly fixture: Awaited<ReturnType<typeof serviceFixture>>
}) {
  const profile = await readProfile()
  const secrets = await readSecrets()
  assert.ok(profile)
  assert.ok(secrets)
  return requests.createNativePaymentRequestService({
    profile,
    secrets,
    getFence: input.fixture.deps.getCustodyFence!,
    deps: input.fixture.deps,
    receiver: input.receiver,
    isCustodyReady: input.isReady,
    triggerCustodyRecovery: () => {},
  })
}

test('production service recovers a pending receipt when saved transport relays cannot encode a new request', async () => {
  const f = await serviceFixture()
  let service: requests.NativePaymentRequestService | undefined
  const transport = fakeReceiverWebSocket()
  try {
    await f.ops.create({ requestId: 'request', nprofile: f.nprofile })
    f.control.failAfterMintEffect = true
    await assert.rejects(f.ops.receive(message()), {
      message: 'native payment request receive failed',
    })
    assert.equal((await f.ops.status({ requestId: 'request' })).state, 'pending')
    service = await production({
      fixture: f,
      isReady: () => true,
      receiver: createNativePaymentRequestReceiver({
        walletSeedHex: SEED,
        relayUrls: [`wss://relay.example/${'x'.repeat(256)}`],
        websocketImplementation: transport.implementation,
      }),
    })
    f.control.state = CheckStateEnum.SPENT
    f.control.restore = true
    await service.recover({ requestId: 'request' })
    assert.equal((await service.status({ requestId: 'request' })).state, 'credited')
    assert.equal((await service.list({ cursor: null })).rows.length, 1)
    assert.equal(f.counts.prepared, 1)
    assert.equal(f.counts.swaps, 1)
    assert.equal(await f.targetCount(), 2)
    await assert.rejects(service.create({ requestId: 'unencodable' }), {
      message: 'payment receive nprofile is invalid',
    })
    assert.equal(await f.requestCount(), 1)
    assert.equal(transport.sockets.length, 0)
  } finally {
    await service?.stop()
    await f.close()
  }
})

test('remote terminal close releases the exact service owner for later explicit resume', async () => {
  const f = await serviceFixture()
  let subscribed = 0
  const generations: Array<{ signal: AbortSignal; onclose?: () => void }> = []
  const service = new requests.NativePaymentRequestService({
    ops: f.ops,
    directory: f.directory,
    receiver: {
      nprofile: f.nprofile,
      subscribe: async (input) => {
        subscribed++
        generations.push(input)
        return { close: () => {} }
      },
    },
    isCustodyReady: () => true,
    triggerCustodyRecovery: () => {},
  })
  try {
    await service.create({ requestId: 'request' })
    generations[0]!.onclose?.()
    assert.equal(await service.resumeReceiving(), true)
    assert.equal(subscribed, 2, 'remote terminal owner prevented explicit resume')
    assert.equal(generations[0]!.signal.aborted, true)
    generations[0]!.onclose?.()
    assert.equal(generations[1]!.signal.aborted, false, 'old close cancelled the new owner')
  } finally {
    await service.stop()
    await f.close()
  }
})

test('production entry starts a retained awaiting request only after the current recovery gate update', async () => {
  const f = await serviceFixture()
  const readiness = createCustodyReadinessTracker({
    nonRetirementPending: true,
    retryPending: true,
    retirementPending: false,
  })
  let subscribed = 0
  let closed = 0
  const service = await production({
    fixture: f,
    isReady: readiness.isReady,
    receiver: {
      nprofile: f.nprofile,
      subscribe: async () => {
        assert.equal(readiness.isReady(), true)
        subscribed++
        return {
          close: () => {
            closed++
          },
        }
      },
    },
  })
  try {
    await f.ops.create({ requestId: 'request', nprofile: f.nprofile })
    assert.equal(await service.resumeReceiving(), false)
    assert.equal(subscribed, 0)
    const generation = readiness.beginAutomaticNonRetirementScan()
    assert.equal(readiness.completeAutomaticNonRetirementScan(generation, false, false), true)
    assert.equal(await service.resumeReceiving(), true)
    assert.equal(subscribed, 1)
    readiness.updateManualRecovery({
      nonRetirementPending: true,
      retryPending: true,
      retirementPending: false,
    })
    assert.equal(await service.resumeReceiving(), false)
    assert.equal(closed, 1)
    const recovered = await dispatch(
      { method: 'wallet.recover' },
      {
        ...f.deps,
        nativePaymentRequests: service,
        isCustodyReady: readiness.isReady,
        onManualCustodyRecoveryStatus: readiness.updateManualRecovery,
        createEngineClient: () => ({}) as EngineClientLike,
      },
    )
    assert.equal(recovered.ok, true)
    assert.equal(subscribed, 2)
    assert.equal((await service.status({ requestId: 'request' })).state, 'awaiting')
    assertRedacted(recovered)
  } finally {
    await service.stop()
    await f.close()
  }
})

test('bounded presence query skips credited-only history and finds later uncredited requests in the selected mint', async () => {
  const f = await serviceFixture()
  let subscribed = 0
  const service = await production({
    fixture: f,
    isReady: () => true,
    receiver: {
      nprofile: f.nprofile,
      subscribe: async () => {
        subscribed++
        return { close: () => {} }
      },
    },
  })
  try {
    assert.equal(await service.resumeReceiving(), false)
    await f.ops.create({ requestId: 'request', nprofile: f.nprofile })
    await f.ops.receive(message())
    await withDaemonStateSqliteTransaction(f.directory, (db) => {
      // Reuse one genuine applied operation for a large relational history fixture.
      // This creates no second custody credit and does not exercise receipt admission.
      const request =
        db.prepare(`INSERT INTO native_payment_requests SELECT scope_id, ?, normalized_mint,
        unit, receive_public_key, nprofile, ?, created_at_ms FROM native_payment_requests WHERE request_id = 'request'`)
      const receipt =
        db.prepare(`INSERT INTO native_payment_request_receipts SELECT scope_id, ?, source_fingerprint,
        receipt_kind, proof_count, input_amount_msat, group_count, regular_operation_id
        FROM native_payment_request_receipts WHERE request_id = 'request'`)
      for (let i = 0; i < 257; i++) {
        const id = `history-${i}`
        request.run(
          id,
          createAmountlessCashuPaymentRequest({
            id,
            mintUrl: 'https://mint.example',
            nprofile: f.nprofile,
          }).encoded,
        )
        receipt.run(`history-${i}`)
      }
      db.prepare(
        `INSERT INTO native_payment_requests SELECT scope_id, 'foreign', 'https://other.example',
        unit, receive_public_key, nprofile, encoded_request, created_at_ms FROM native_payment_requests WHERE request_id = 'request'`,
      ).run()
    })
    assert.equal(await f.ops.hasUncreditedRequests(), false)
    assert.equal(await service.resumeReceiving(), false)
    assert.equal(subscribed, 0)
    await f.ops.create({ requestId: 'zz-pending', nprofile: f.nprofile })
    assert.equal(await f.ops.hasUncreditedRequests(), true)
    assert.equal(await service.resumeReceiving(), true)
    assert.equal(subscribed, 1)
    assert.equal(f.counts.prepared, 1)
    assert.equal(await f.targetCount(), 2)
  } finally {
    await service.stop()
    await f.close()
  }
})
