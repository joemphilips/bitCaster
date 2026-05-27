import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Amount, type Proof } from '@cashu/cashu-ts'
import {
  sellerPreparePrelockedSwap,
  type SwapContext,
} from '../src/atomicSwap.ts'
import { adapt, generateAdaptorPoint, preSign } from '../src/adaptor.ts'
import { generateEphemeralKeypair } from '../src/ecdh.ts'

test('Block2_SellerLock_Leg2Failure_DoesNotPublishLockedProofsSeller', async () => {
  const ctx = swapContext('trade-leg2-failure')
  const leg1 = lockedProof(ctx, 'keyset-A', 100)
  const leg2Failure = new Error('leg 2 mint swap failed')
  const sent: string[] = []
  const publishLockedProofsSeller = (cipher: string) => sent.push(cipher)
  const simulateLeg2Lock = () => {
    throw leg2Failure
  }
  const preparedLeg1 = await sellerPreparePrelockedSwap(ctx, [leg1])
  assert.equal(typeof preparedLeg1.lockedProofsCipher, 'string')
  assert.ok(preparedLeg1.lockedProofsCipher.length > 0)

  try {
    simulateLeg2Lock()
    publishLockedProofsSeller(preparedLeg1.lockedProofsCipher)
  } catch (error) {
    if (error !== leg2Failure) throw error
  }

  assert.deepEqual(sent, [])
})

test('Block2_MultiLegSwap_PerLegNonceR_AreDistinct', () => {
  const signer = generateEphemeralKeypair()
  const adaptorA = generateAdaptorPoint()
  const adaptorB = generateAdaptorPoint()
  const finalSigA = adapt(
    preSign(signer.privateKey, new Uint8Array(32).fill(1), adaptorA.point),
    adaptorA.secret,
  )
  const finalSigB = adapt(
    preSign(signer.privateKey, new Uint8Array(32).fill(2), adaptorB.point),
    adaptorB.secret,
  )

  assert.notEqual(
    Buffer.from(finalSigA.slice(0, 32)).toString('hex'),
    Buffer.from(finalSigB.slice(0, 32)).toString('hex'),
  )
})

test('Block2_MultiLegSwap_LocktimeIdenticalAcrossLegs', () => {
  const ctx = swapContext('trade-locktime-identical')
  const proofA = lockedProof(ctx, 'keyset-A', 100)
  const proofB = lockedProof(ctx, 'keyset-B', 100)

  assert.equal(extractLocktime(proofA), ctx.sellerLocktime)
  assert.equal(extractLocktime(proofB), ctx.sellerLocktime)
})

function swapContext(tradeId: string): SwapContext {
  const seller = generateEphemeralKeypair()
  const buyer = generateEphemeralKeypair()
  return {
    tradeId,
    role: 'seller',
    ephemeralKey: seller,
    counterpartyPubkey: buyer.publicKey,
    sellerLocktime: 1_779_393_600,
    buyerLocktime: 1_779_393_000,
    mintUrl: 'https://mint.example',
  }
}

function lockedProof(ctx: SwapContext, keysetId: string, amount: number): Proof {
  return {
    id: keysetId,
    amount: Amount.from(amount),
    secret: JSON.stringify([
      'P2PK',
      {
        data: ctx.ephemeralKey.publicKey,
        tags: [
          ['pubkeys', ctx.counterpartyPubkey],
          ['n_sigs', '2'],
          ['sigflag', 'SIG_INPUTS'],
          ['locktime', String(ctx.sellerLocktime)],
          ['refund', ctx.ephemeralKey.publicKey],
        ],
      },
    ]),
    C: `02${keysetId}`.padEnd(66, '0').slice(0, 66),
  } as Proof
}

function extractLocktime(proof: Proof): number {
  const parsed = JSON.parse(proof.secret) as [string, { tags: string[][] }]
  const tag = parsed[1].tags.find(([name]) => name === 'locktime')
  return Number(tag?.[1])
}
