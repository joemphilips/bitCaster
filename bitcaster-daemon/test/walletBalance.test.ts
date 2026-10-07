import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyDaemonState, summarizeWalletBalance, type StoredProofRecord } from '../src/state.ts'

const MINT = 'https://mint.example'
const OTHER_MINT = 'https://other-mint.example'
const DENOMINATIONS_MSAT = [8192, 1024, 512, 256, 16]
const BALANCE_STATES = [
  { state: 'available', field: 'availableSats', total: 'totalAvailableSats' },
  { state: 'reserved', field: 'reservedSats', total: 'totalReservedSats' },
  { state: 'locked', field: 'lockedSats', total: 'totalLockedSats' },
] as const

for (const { state, field, total } of BALANCE_STATES) {
  test(`wallet balance sums ${state} proof denominations before converting to sats`, () => {
    const wallet = emptyDaemonState()
    wallet.wallet.proofs = DENOMINATIONS_MSAT.map((amount) => outcomeProof(amount, state))
    const balance = summarizeWalletBalance(wallet)
    assert.equal(balance.byMint[0]![field], 10)
    assert.equal(balance.outcomePositions[0]![field], 10)
    assert.equal(balance[total], 10)
    for (const other of BALANCE_STATES.filter((entry) => entry.state !== state)) {
      assert.equal(balance.byMint[0]![other.field], 0)
      assert.equal(balance.outcomePositions[0]![other.field], 0)
      assert.equal(balance[other.total], 0)
    }
  })

  test(`wallet balance sums ${state} multi-mint totals in integer msat`, () => {
    const wallet = emptyDaemonState()
    wallet.wallet.proofs = [outcomeProof(100, state), outcomeProof(200, state, OTHER_MINT)]
    const balance = summarizeWalletBalance(wallet)
    assert.equal(balance.byMint[0]![field], 0.1)
    assert.equal(balance.byMint[1]![field], 0.2)
    assert.equal(balance[total], 0.3)
  })
}

test('wallet balance combines whole sats, conditional msat, and locked custody before display', () => {
  const wallet = emptyDaemonState()
  wallet.wallet.proofs = [
    { ...outcomeProof(2, 'available'), asset: { kind: 'sats', baseAsset: 'sat', unit: 'sat' } },
    outcomeProof(100, 'available'),
    outcomeProof(200, 'locked'),
  ]
  const balance = summarizeWalletBalance(wallet, [
    { mintUrl: MINT, unit: 'msat', amount: 100, conditionId: 'condition', outcomeSetId: 'Yes' },
    { mintUrl: OTHER_MINT, unit: 'sat', amount: 1, conditionId: null, outcomeSetId: null },
  ])
  assert.equal(balance.totalAvailableSats, 2.1)
  assert.equal(balance.totalLockedSats, 1.3)
  assert.equal(balance.byMint[0]!.lockedSats, 0.3)
  assert.equal(balance.outcomePositions[0]!.availableSats, 0.1)
  assert.equal(balance.outcomePositions[0]!.lockedSats, 0.3)
})

for (const otherMint of [MINT, OTHER_MINT]) {
  test(`wallet balance rejects an unsafe msat sum across ${otherMint === MINT ? 'one mint' : 'mints'}`, () => {
    const wallet = emptyDaemonState()
    wallet.wallet.proofs = [
      outcomeProof(2 ** 52, 'available'),
      outcomeProof(2 ** 52, 'available', otherMint),
    ]
    assert.throws(() => summarizeWalletBalance(wallet), /safe integer/)
  })
}

function outcomeProof(
  amount: number,
  state: StoredProofRecord['state'],
  mintUrl = MINT,
): StoredProofRecord {
  return {
    proof: { amount, secret: `fixture-${amount}-${state}`, C: 'fixture-signature' },
    mintUrl,
    state,
    asset: {
      kind: 'Outcome',
      conditionId: 'condition',
      outcomeSetId: 'Yes',
      baseAsset: 'sat',
      unit: 'msat',
    },
    createdAt: '2026-10-02T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
  }
}
