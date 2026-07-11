import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRealDaemonSwapOps } from '../src/swapProtocolAdapter.ts'
import {
  emptyDaemonState,
  readState,
  writeState,
  type CashuProofRecord,
} from '../src/state.ts'
import {
  DURABLE_TRADE_SESSION_SCHEMA_VERSION,
  type DurableTradeSession,
} from '@bitcaster-market/client-sdk/durableTradeRecovery'

test('real daemon swap adapter maps SDK daemon context to atomic-swap operations', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-swap-adapter-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  const calls: string[] = []
  try {
    const initial = emptyDaemonState()
    initial.durableTradeSessions['trade-seller'] = durableSession('trade-seller', 'seller')
    await writeState(initial)
    const ops = createRealDaemonSwapOps({
      nut07PollDeadlineMs: 10,
      nut07PollIntervalMs: 1,
      async loadAtomicSwapModule() {
        return {
          async splitProofsForExactSend(params) {
            calls.push(
              `splitExact:${params.operationId}:${params.amountSats}:${params.sourceProofs[0].secret}`,
            )
            await params.proofOperationStore?.prepareProofOperation({
              operationId: params.operationId ?? 'missing',
              kind: 'proof-split',
              mintUrl: params.mintUrl,
              inputs: params.sourceProofs,
              outputs: {
                send: [output('split-send-secret')],
                keep: [output('split-keep-secret')],
              },
              metadata: { amount: params.amountSats, fees: 0, keysetId: 'keyset-100' },
            })
            await params.proofOperationStore?.markProofOperationCompleted(
              params.operationId ?? 'missing',
              {
                send: [proof(params.amountSats, 'split-send')],
                keep: [proof(1, 'split-change')],
              },
            )
            return {
              sendProofs: [proof(params.amountSats, 'split-send')],
              changeProofs: [proof(1, 'split-change')],
              spentProofs: params.sourceProofs,
            }
          },
          async sellerPrepareSwap(ctx, proofs, options) {
            calls.push(
              `sellerPrepare:${options?.operationId}:${ctx.ephemeralKey.privateKey.length}:${proofs[0].secret}`,
            )
            await options?.proofOperationStore?.prepareProofOperation({
              operationId: options.operationId ?? 'missing',
              kind: 'swap-lock',
              mintUrl: ctx.mintUrl,
              inputs: proofs,
              outputs: {
                send: [output('send-secret')],
              },
              metadata: { amount: 100, fees: 0, keysetId: 'keyset-100' },
            })
            await options?.proofOperationStore?.markProofOperationCompleted(
              options.operationId ?? 'missing',
              { send: [proof(100, 'seller-locked')] },
            )
            return {
              adaptorPointCipher: 'cipher-a',
              lockedProofsCipher: 'cipher-s',
              adaptorPoint: {
                secret: new Uint8Array([0xaa]),
                point: new Uint8Array([0xbb]),
              },
              lockedProofs: [proof(100, 'seller-locked')],
              changeProofs: [proof(1, 'seller-change')],
            }
          },
          async sellerPreparePrelockedSwap(ctx, lockedProofs) {
            calls.push(
              `sellerPrelocked:${ctx.tradeId}:${lockedProofs[0].secret}`,
            )
            return {
              adaptorPointCipher: 'cipher-ca',
              lockedProofsCipher: 'cipher-cs',
              adaptorPoint: {
                secret: new Uint8Array([0xdd]),
                point: new Uint8Array([0xee]),
              },
              lockedProofs,
              changeProofs: [],
            }
          },
          async sellerLockOutcomeProofs(ctx, outcomeProofs, amountSats, options) {
            calls.push(
              `sellerLockOutcome:${options?.operationId}:${ctx.tradeId}:${amountSats}:${outcomeProofs[0].secret}`,
            )
            return {
              lockedProofs: [proof(amountSats, 'outcome-locked')],
              changeProofs: [proof(1, 'outcome-change')],
            }
          },
          async buyerPrepareSwap(
            ctx,
            adaptorPointCipher,
            lockedProofsSellerCipher,
            proofs,
            amountSats,
            options,
          ) {
            calls.push(
              `buyerPrepare:${options?.operationId}:${ctx.role}:${amountSats}:${adaptorPointCipher}:${lockedProofsSellerCipher}:${proofs[0].secret}`,
            )
            return {
              lockedProofsCipher: 'cipher-b',
              lockedProofs: [proof(42, 'buyer-locked')],
              changeProofs: [],
              preSigsHex: ['pre-b'],
              sellerPreSigsHex: ['pre-s'],
            }
          },
          async sellerClaimSwap(ctx, adaptorPoint, lockedProofsBuyerCipher, options) {
            calls.push(
              `sellerClaim:${options?.operationId}:${ctx.tradeId}:${adaptorPoint.secret[0]}:${adaptorPoint.point[0]}:${lockedProofsBuyerCipher}`,
            )
            return [proof(42, 'seller-claim')]
          },
          async buyerExtractSecret(_mintUrl, spentProofs, preSigsHex) {
            calls.push(`buyerExtract:${spentProofs[0].secret}:${preSigsHex[0]}`)
            return new Uint8Array([0xcc])
          },
          async buyerClaimSwap(
            ctx,
            adaptorSecret,
            lockedProofsSellerCipher,
            sellerPreSigsHex,
            options,
          ) {
            calls.push(
              `buyerClaim:${options?.operationId}:${ctx.tradeId}:${adaptorSecret[0]}:${lockedProofsSellerCipher}:${sellerPreSigsHex[0]}`,
            )
            return [proof(100, 'buyer-claim')]
          },
        }
      },
      async loadCtfSplitModule() {
        return {
          async splitRootCompleteSetForSwap(params) {
            calls.push(
              `ctfSplit:${params.operationId}:${params.conditionId}:${params.keepOutcomeSetId}:${params.lockOutcomeSetId}:${params.p2pk.pubkey.length}`,
            )
            await params.proofOperationStore.prepareProofOperation({
              operationId: params.operationId,
              kind: 'ctf-split',
              mintUrl: params.mintUrl,
              inputs: params.collateralProofs,
              outputs: {
                YES: [output('yes-output')],
                NO: [output('no-output')],
              },
              metadata: { amount: params.amountSats },
            })
            await params.proofOperationStore.markProofOperationCompleted(
              params.operationId,
              {
                YES: [proof(100, 'keep-proof')],
                NO: [proof(100, 'lock-proof')],
              },
            )
            return {
              resolvedKeepOutcomeSetId: 'YES',
              resolvedLockOutcomeSetId: 'NO',
              lockCollections: ['NO'],
              keepCollections: ['YES'],
              lockedProofs: [proof(100, 'lock-proof')],
              keepProofs: [proof(100, 'keep-proof')],
              proofsByCollection: {
                YES: [proof(100, 'keep-proof')],
                NO: [proof(100, 'lock-proof')],
              },
              spentSatProofs: params.collateralProofs,
            }
          },
        }
      },
    })

    const sellerOpen = await ops.sellerOpen(ctx('seller', 'trade-seller'), [proof(100, 'seller-input')])
    assert.equal(sellerOpen.adaptorSecretHex, 'aa')
    assert.equal(sellerOpen.adaptorPointHex, 'bb')

    const sellerPrelocked = await ops.sellerOpenPrelocked(ctx('seller', 'trade-seller'), [
      proof(100, 'prelocked-input'),
    ])
    assert.equal(sellerPrelocked.adaptorSecretHex, 'dd')
    assert.equal(sellerPrelocked.adaptorPointHex, 'ee')

    const buyerRespond = await ops.buyerRespond(
      ctx('buyer', 'trade-buyer'),
      { adaptorPoint: 'cipher-a', lockedProofsSeller: 'cipher-s' },
      [proof(42, 'buyer-input')],
      42,
    )
    assert.deepEqual(buyerRespond.preSigsHex, ['pre-b'])

    const sellerLockedOutcome = await ops.sellerLockOutcomeProofs(
      ctx('seller', 'trade-seller'),
      [proof(101, 'outcome-input')],
      100,
      'trade-seller/seller-inventory-lock',
    )
    assert.equal(sellerLockedOutcome.lockedProofs[0].secret, 'outcome-locked')

    const mint = await ops.sellerOpenMint(
      ctx('seller', 'trade-seller'),
      {
        conditionId: 'cond',
        keepOutcomeSetId: 'YES',
        lockOutcomeSetId: 'NO',
        amountSats: 100,
      },
      [proof(100, 'sat-collateral')],
    )
    assert.equal(mint.adaptorSecretHex, 'dd')
    assert.equal(mint.resolvedLockOutcomeSetId, 'NO')

    await ops.sellerClaim(ctx('seller', 'trade-seller'), 'aa', 'bb', 'cipher-b')
    await ops.buyerClaim(ctx('buyer', 'trade-buyer'), {
      lockedProofs: [proof(42, 'buyer-locked')],
      preSigsHex: ['pre-b'],
      lockedProofsSellerCipher: 'cipher-s',
      sellerPreSigsHex: ['pre-s'],
    })

    assert.deepEqual(calls, [
      'sellerPrepare:trade-seller/seller-lock:32:seller-input',
      'sellerPrelocked:trade-seller:prelocked-input',
      'buyerPrepare:trade-buyer/buyer-lock:buyer:42:cipher-a:cipher-s:buyer-input',
      'sellerLockOutcome:trade-seller/seller-inventory-lock:trade-seller:100:outcome-input',
      'ctfSplit:trade-seller/seller-mint-ctf-split:cond:YES:NO:2',
      'sellerPrelocked:trade-seller:lock-proof',
      'sellerClaim:trade-seller/seller-claim:trade-seller:170:187:cipher-b',
      'buyerExtract:buyer-locked:pre-b',
      'buyerClaim:trade-buyer/buyer-claim:trade-buyer:204:cipher-s:pre-s',
    ])
    const state = await readState()
    assert.equal(
      state?.proofOperations['trade-seller/seller-lock'].state,
      'completed',
    )
    assert.equal(
      state?.proofOperations['trade-seller/seller-lock'].outputs.send[0].secret,
      'send-secret',
    )
    assert.equal(
      state?.proofOperations['trade-seller/seller-lock'].durableTradeRecovery?.operationKey,
      'trade-seller/seller-lock',
    )
    assert.equal(
      state?.proofOperations['trade-seller/seller-lock'].durableTradeRecovery?.role,
      'seller',
    )
    assert.equal(
      state?.proofOperations['trade-seller/seller-mint-ctf-split'].state,
      'completed',
    )
    assert.equal(state?.durableTradeSessions['trade-seller']?.stage, 'reconciliation-complete')
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

function ctx(role: 'seller' | 'buyer', tradeId: string) {
  return {
    tradeId,
    role,
    ephemeralKey: {
      privateKeyHex: '11'.repeat(32),
      publicKey: `02${'11'.repeat(32)}`,
    },
    counterpartyPubkey: `03${'22'.repeat(32)}`,
    sellerLocktime: 120,
    buyerLocktime: 60,
    mintUrl: 'http://mint.test',
  }
}

function durableSession(
  tradeId: string,
  role: 'seller' | 'buyer',
): DurableTradeSession {
  const localProtocolPubkey = `02${'11'.repeat(32)}`
  const counterpartyProtocolPubkey = `03${'22'.repeat(32)}`
  return {
    schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
    revision: 0,
    tradeId,
    role,
    localProtocolPubkey,
    counterpartyProtocolPubkey,
    mintUrl: 'http://mint.test',
    sellerLocktimeSecs: 120,
    buyerLocktimeSecs: 60,
    ephemeralKeyHandle: {
      keyId: `${tradeId}-key`,
      tradeId,
      role,
      localProtocolPubkey,
      counterpartyProtocolPubkey,
      mintUrl: 'http://mint.test',
      sellerLocktimeSecs: 120,
      buyerLocktimeSecs: 60,
    },
    stage: 'intent',
    expectedProofOperations: [],
    proofOperations: [],
    receivedCiphers: {},
    outboundCiphers: {},
  }
}

function proof(amount: number, secret: string): CashuProofRecord {
  return {
    id: `keyset-${amount}`,
    amount,
    secret,
    C: `c-${secret}`,
  }
}

function output(secret: string) {
  return {
    blindedMessage: {
      amount: 100,
      id: 'keyset-100',
      B_: 'blinded',
    },
    blindingFactor: '01',
    secret,
  }
}
