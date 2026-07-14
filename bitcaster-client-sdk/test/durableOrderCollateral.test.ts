import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDurableOrderCollateralPin,
  reduceDurableOrderCollateralPin,
} from '../src/durableOrderCollateral.ts'
import { deriveDurableCustodyScopeId } from '../src/durableCustody.ts'

const proof = (suffix: string, amount: number) => ({
  proofId: suffix.padStart(64, '0'),
  keysetId: '0011223344556677',
  amount,
  asset: { kind: 'base' as const },
})

function prepared() {
  return createDurableOrderCollateralPin({
    scopeId: deriveDurableCustodyScopeId({
      scopeKind: 'wallet',
      walletId: '11'.repeat(32),
    }),
    clientOrderId: 'client-order-1',
    marketId: 'condition-YES',
    mintUrl: 'https://mint.example',
    unit: 'sat',
    orderAmount: 10,
    requiredAmount: 7,
    submissionRequest: {
      clientOrderId: 'client-order-1',
      outcomeId: 'YES',
      tokenSide: 'Outcome',
      side: 'Buy',
      price: 70,
      amountSubunits: 10,
      timeInForce: 'GTC',
    },
    proofs: [proof('1', 4), proof('2', 4)],
  })
}

test('order collateral stays pinned across partial fills and releases only on terminal status', () => {
  const active = reduceDurableOrderCollateralPin(prepared(), {
    kind: 'bind-engine-order',
    expectedRevision: 0,
    orderId: 'order-1',
    status: 'resting',
    remainingAmount: 7,
  })
  const partial = reduceDurableOrderCollateralPin(active, {
    kind: 'observe-engine-order',
    expectedRevision: 1,
    orderId: 'order-1',
    status: 'partially_filled',
    remainingAmount: 3,
  })
  assert.equal(partial.state, 'active')
  assert.equal(partial.remainingOrderAmount, 10)
  assert.equal(partial.proofs.length, 2)

  const released = reduceDurableOrderCollateralPin(partial, {
    kind: 'record-fill',
    expectedRevision: 2,
    remainingOrderAmount: 0,
    proofs: [],
  })
  assert.equal(released.state, 'released')
  assert.equal(released.releaseReason, 'filled')
})

test('partial fill replaces exact pin proofs and enforces proportional coverage', () => {
  const active = reduceDurableOrderCollateralPin(prepared(), {
    kind: 'bind-engine-order',
    expectedRevision: 0,
    orderId: 'order-1',
    status: 'resting',
    remainingAmount: 10,
  })
  const nextProof = proof('3', 4)
  const partial = reduceDurableOrderCollateralPin(active, {
    kind: 'record-fill',
    expectedRevision: 1,
    remainingOrderAmount: 5,
    proofs: [nextProof],
  })
  assert.deepEqual(partial.proofs, [nextProof])
  assert.throws(
    () => reduceDurableOrderCollateralPin(active, {
      kind: 'record-fill',
      expectedRevision: 1,
      remainingOrderAmount: 8,
      proofs: [nextProof],
    }),
    /coverage is insufficient/,
  )
})

test('order collateral rejects duplicate coverage, foreign orders, and unsafe release', () => {
  const base = prepared()
  assert.throws(
    () => createDurableOrderCollateralPin({
      ...base,
      proofs: [proof('1', 4), proof('1', 4)],
    }),
    /duplicated/,
  )
  const active = reduceDurableOrderCollateralPin(base, {
    kind: 'bind-engine-order',
    expectedRevision: 0,
    orderId: 'order-1',
    status: 'resting',
    remainingAmount: 7,
  })
  assert.throws(
    () => reduceDurableOrderCollateralPin(active, {
      kind: 'observe-engine-order',
      expectedRevision: 1,
      orderId: 'order-2',
      status: 'cancelled',
      remainingAmount: 7,
    }),
    /another order/,
  )
  assert.throws(
    () => reduceDurableOrderCollateralPin(active, {
      kind: 'release-before-submit',
      expectedRevision: 1,
      reason: 'pre-submit-rejected',
    }),
    /submitted order/,
  )
})

test('order collateral accepts canonical internal HTTP mint URLs', () => {
  const pin = createDurableOrderCollateralPin({
    ...prepared(),
    mintUrl: 'http://mint.internal:8085',
  })
  assert.equal(pin.mintUrl, 'http://mint.internal:8085')
})

test('order collateral retains the exact GTC request and preflight authority', () => {
  const base = prepared()
  const pin = createDurableOrderCollateralPin({
    ...base,
    preflightSplit: {
      reservationId: base.pinId,
      conditionId: 'condition',
      keepOutcomeSetId: 'YES',
      lockOutcomeSetId: 'NO',
      amountSats: base.orderAmount,
    },
  })
  assert.deepEqual(pin.submissionRequest, base.submissionRequest)
  assert.equal(pin.preflightSplit?.reservationId, pin.pinId)

  assert.throws(
    () => createDurableOrderCollateralPin({
      ...base,
      submissionRequest: {
        ...base.submissionRequest,
        amountSubunits: base.orderAmount + 1,
      },
    }),
    /submission amount does not match/,
  )
  assert.throws(
    () => createDurableOrderCollateralPin({
      ...base,
      preflightSplit: {
        reservationId: 'foreign-reservation',
        conditionId: 'condition',
        keepOutcomeSetId: 'YES',
        lockOutcomeSetId: 'NO',
        amountSats: base.orderAmount,
      },
    }),
    /preflight split does not match/,
  )
})
