import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted state so `vi.mock` factories (which are hoisted above imports)
// can close over live references.
const mocks = vi.hoisted(() => {
  const walletState: {
    mints: { url: string }[]
  } = {
    mints: [],
  }
  return {
    walletState,
    addProofsSpy: vi.fn(async (_proofs: unknown[]) => {}),
    addActivitySpy: vi.fn(),
    markReceivedSpy: vi.fn(),
    encodeToken: vi.fn(
      (proofs: unknown[], mintUrl: string) =>
        `token:${mintUrl}:${(proofs as { amount: number }[]).reduce((s, p) => s + p.amount, 0)}`
    ),
    receiveToken: vi.fn(async (_token: string, _mintUrl: string) => [
      { secret: 'rotated-1', amount: 42, id: 'kid', C: 'C' },
    ]),
    ingressReceiveCashuToken: vi.fn(async (_token: string, _source: string, options?: { mintUrl?: string }) => ({
      added: !walletState.mints.some((m) => m.url === options?.mintUrl),
      mintUrl: options?.mintUrl ?? 'http://mint.example',
      source: 'nip17',
      amountSats: 42,
      proofs: [{ secret: 'rotated-1', amount: 42, id: 'kid', C: 'C' }],
    })),
  }
})

vi.mock('@/stores/wallet', () => ({
  useWalletStore: {
    getState: () => mocks.walletState,
  },
}))

vi.mock('@/stores/proof-db', () => ({
  addProofs: mocks.addProofsSpy,
}))

vi.mock('@/stores/activity-log', () => ({
  useActivityLogStore: {
    getState: () => ({ addActivity: mocks.addActivitySpy }),
  },
}))

vi.mock('@/stores/paymentRequestInbox', () => ({
  usePaymentRequestInbox: {
    getState: () => ({ markReceived: mocks.markReceivedSpy }),
  },
}))

vi.mock('../cashu', () => ({
  encodeToken: mocks.encodeToken,
}))

vi.mock('../walletOps', () => ({
  ingressReceiveCashuToken: mocks.ingressReceiveCashuToken,
}))

vi.mock('../nip17', () => ({
  deriveNostrKeyPair: vi.fn(() => ({
    privateKey: new Uint8Array(32),
    privateKeyHex: '00'.repeat(32),
    publicKey: '11'.repeat(32),
  })),
  subscribeNip17DMs: vi.fn(async () => () => {}),
}))

import {
  __handleIncomingDMForTests,
  __resetProcessedEventsForTests,
} from '../nip17-listener'

beforeEach(() => {
  mocks.walletState.mints = []
  // Reset all hoisted spies but preserve their identity so the mock is
  // still wired to the listener module's imports.
  mocks.addProofsSpy.mockClear()
  mocks.addActivitySpy.mockClear()
  mocks.markReceivedSpy.mockClear()
  mocks.encodeToken.mockClear()
  mocks.receiveToken.mockClear()
  mocks.ingressReceiveCashuToken.mockClear()
  __resetProcessedEventsForTests()
})

describe('nip17-listener', () => {
  it('normalizes payload mint URL and stores proofs under the canonical value', async () => {
    mocks.walletState.mints = [{ url: 'http://mint.example' }]

    const payload = {
      id: 'req-1',
      mint: 'http://mint.example/', // trailing slash — would fail exact-match
      unit: 'sat',
      proofs: [{ secret: 's1', amount: 42, id: 'kid', C: 'C' }],
    }
    await __handleIncomingDMForTests(JSON.stringify(payload))

    expect(mocks.ingressReceiveCashuToken).toHaveBeenCalledWith(
      'token:http://mint.example:42',
      'nip17',
      { mintUrl: 'http://mint.example' },
    )
    expect(mocks.addProofsSpy).toHaveBeenCalledTimes(1)
    const stored = mocks.addProofsSpy.mock.calls[0][0] as { mintUrl: string }[]
    expect(stored[0].mintUrl).toBe('http://mint.example')
    expect(mocks.markReceivedSpy).toHaveBeenCalledWith('req-1', 42)
  })

  it('auto-adds the mint when the payer uses a previously unconfigured one', async () => {
    mocks.walletState.mints = [{ url: 'http://other.mint' }]

    const payload = {
      id: 'req-2',
      mint: 'http://new.mint/',
      unit: 'sat',
      proofs: [{ secret: 's2', amount: 10, id: 'kid', C: 'C' }],
    }
    await __handleIncomingDMForTests(JSON.stringify(payload))

    expect(mocks.ingressReceiveCashuToken).toHaveBeenCalledWith(
      'token:http://new.mint:10',
      'nip17',
      { mintUrl: 'http://new.mint' },
    )
    expect(mocks.addProofsSpy).toHaveBeenCalledTimes(1)
    expect(mocks.markReceivedSpy).toHaveBeenCalledWith('req-2', 42)
  })

  it('dedups repeated DMs carrying the same payment payload', async () => {
    mocks.walletState.mints = [{ url: 'http://mint.example' }]

    const payload = {
      id: 'req-3',
      mint: 'http://mint.example',
      unit: 'sat',
      proofs: [{ secret: 's3', amount: 5, id: 'kid', C: 'C' }],
    }
    const body = JSON.stringify(payload)
    await __handleIncomingDMForTests(body)
    await __handleIncomingDMForTests(body)

    expect(mocks.addProofsSpy).toHaveBeenCalledTimes(1)
    expect(mocks.markReceivedSpy).toHaveBeenCalledTimes(1)
  })

  it('silently ignores non-JSON content', async () => {
    await __handleIncomingDMForTests('hello world')
    expect(mocks.addProofsSpy).not.toHaveBeenCalled()
    expect(mocks.markReceivedSpy).not.toHaveBeenCalled()
  })

  it('silently ignores JSON without proofs+mint', async () => {
    await __handleIncomingDMForTests(JSON.stringify({ id: 'x', message: 'hi' }))
    expect(mocks.addProofsSpy).not.toHaveBeenCalled()
    expect(mocks.markReceivedSpy).not.toHaveBeenCalled()
  })
})
