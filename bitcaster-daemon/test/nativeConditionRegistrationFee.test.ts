import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DurableOutgoingCashuTransfer } from '@bitcaster-market/client-sdk/durableOutgoingCashuTransfer'
import {
  deriveNativeConditionRegistrationFeeTransferId,
  prepareNativeConditionRegistrationFee,
} from '../src/nativeConditionRegistrationFee.ts'

const MINT_URL = 'https://mint.example'
const PROOF = {
  id: `01${'11'.repeat(32)}`,
  amount: '7',
  secret: 'fee-proof-secret',
  C: `02${'22'.repeat(32)}`,
  dleq: null,
  p2pkE: null,
  witness: null,
}

test('zero fee performs no wallet or durable coordinator work', async () => {
  const fixture = coordinatorFixture()
  const result = await prepareNativeConditionRegistrationFee(
    { coordinator: fixture.coordinator },
    { creationId: 'creation-zero', mintUrl: MINT_URL, requiredFeeMsat: 0 },
  )
  assert.equal(result.kind, 'fee-free')
  assert.equal(result.transferId, null)
  assert.equal(fixture.calls.length, 0)
})

test('fresh fee validates the registration cap and debit quote before sending', async () => {
  const tooLarge = coordinatorFixture()
  await assert.rejects(
    () =>
      prepareNativeConditionRegistrationFee(
        { coordinator: tooLarge.coordinator },
        { creationId: 'creation-cap', mintUrl: MINT_URL, requiredFeeMsat: 1_000_001 },
      ),
    /supported range/,
  )
  assert.equal(tooLarge.calls.length, 0)

  const overDebit = coordinatorFixture({ quoteFeeMsat: 4 })
  await assert.rejects(
    () =>
      prepareNativeConditionRegistrationFee(
        { coordinator: overDebit.coordinator },
        {
          creationId: 'creation-debit',
          mintUrl: MINT_URL,
          requiredFeeMsat: 7,
          maxWalletDebitMsat: 10,
          wallet: wallet,
        },
      ),
    /approved wallet debit/,
  )
  assert.deepEqual(overDebit.calls, ['loadTransfer', 'quoteSend'])
})

test('fresh fee executes one capped transfer and returns only classified unspent proofs', async () => {
  const fixture = coordinatorFixture({ quoteFeeMsat: 2, classification: 'unspent' })
  const result = await prepareNativeConditionRegistrationFee(
    { coordinator: fixture.coordinator },
    {
      creationId: 'creation-fresh',
      mintUrl: MINT_URL,
      seed: new Uint8Array(64),
      requiredFeeMsat: 7,
      maxWalletDebitMsat: 10,
      wallet,
    },
  )
  assert.equal(result.kind, 'prepared')
  assert.equal(result.transferId, deriveNativeConditionRegistrationFeeTransferId('creation-fresh'))
  assert.equal(result.feeProofs.length, 1)
  assert.equal(result.feeProofs[0]?.secret, PROOF.secret)
  assert.deepEqual(fixture.calls, [
    'loadTransfer',
    'quoteSend',
    'execute',
    'recover',
    'classifyBearerTransfer',
    'loadTransfer',
  ])
  assert.equal(fixture.executeCount, 1)
  assert.equal(fixture.executeSeedLength, 64)

  const retry = await prepareNativeConditionRegistrationFee(
    { coordinator: fixture.coordinator },
    {
      creationId: 'creation-fresh',
      mintUrl: MINT_URL,
      requiredFeeMsat: 7,
      wallet,
    },
  )
  assert.equal(retry.kind, 'prepared')
  assert.equal(fixture.executeCount, 1, 'retry created a second payment')
  assert.equal(fixture.calls.filter((call) => call === 'recover').length, 2)
})

test('prepared transfer retry uses recover and refuses a smaller caller debit maximum', async () => {
  const prepared = makeTransfer(
    deriveNativeConditionRegistrationFeeTransferId('prepared'),
    'prepared',
    7,
    3,
  )
  const fixture = coordinatorFixture({
    initial: prepared,
    recoverAs: 'delivery-pending',
    classification: 'unspent',
  })
  await assert.rejects(
    () =>
      prepareNativeConditionRegistrationFee(
        { coordinator: fixture.coordinator },
        {
          creationId: 'prepared',
          mintUrl: MINT_URL,
          requiredFeeMsat: 7,
          maxWalletDebitMsat: 9,
          wallet,
        },
      ),
    /exceeds the approved maximum/,
  )
  assert.deepEqual(fixture.calls, ['loadTransfer'])

  const resumed = await prepareNativeConditionRegistrationFee(
    { coordinator: fixture.coordinator },
    { creationId: 'prepared', mintUrl: MINT_URL, requiredFeeMsat: 7, wallet },
  )
  assert.equal(resumed.kind, 'prepared')
  assert.deepEqual(fixture.calls, [
    'loadTransfer',
    'loadTransfer',
    'recover',
    'classifyBearerTransfer',
    'loadTransfer',
  ])
  assert.equal(fixture.executeCount, 0)
})

test('nonterminal prepared recovery returns pending and never starts another send', async () => {
  const prepared = makeTransfer(
    deriveNativeConditionRegistrationFeeTransferId('nonterminal'),
    'prepared',
    7,
    1,
  )
  const fixture = coordinatorFixture({ initial: prepared, recoverThrows: true })
  const result = await prepareNativeConditionRegistrationFee(
    { coordinator: fixture.coordinator },
    { creationId: 'nonterminal', mintUrl: MINT_URL, requiredFeeMsat: 7, wallet },
  )
  assert.equal(result.kind, 'pending')
  assert.equal(result.feeProofs.length, 0)
  assert.deepEqual(fixture.calls, ['loadTransfer', 'recover'])
  assert.equal(fixture.executeCount, 0)
})

test('existing exact binding is required before recovery', async () => {
  const foreign = makeTransfer(
    deriveNativeConditionRegistrationFeeTransferId('binding'),
    'prepared',
    8,
    0,
  )
  const fixture = coordinatorFixture({ initial: foreign })
  await assert.rejects(
    () =>
      prepareNativeConditionRegistrationFee(
        { coordinator: fixture.coordinator },
        { creationId: 'binding', mintUrl: MINT_URL, requiredFeeMsat: 7, wallet },
      ),
    /conflicts with the request/,
  )
  assert.deepEqual(fixture.calls, ['loadTransfer'])
})

test('already-spent transfers return no proofs and need no new wallet operation', async () => {
  const spent = makeTransfer(
    deriveNativeConditionRegistrationFeeTransferId('spent'),
    'bearer-spent',
    7,
    1,
  )
  const fixture = coordinatorFixture({ initial: spent })
  const result = await prepareNativeConditionRegistrationFee(
    { coordinator: fixture.coordinator },
    { creationId: 'spent', mintUrl: MINT_URL, requiredFeeMsat: 7 },
  )
  assert.equal(result.kind, 'already-spent')
  assert.equal(result.feeProofs.length, 0)
  assert.deepEqual(fixture.calls, ['loadTransfer'])
})

test('partial and uncertain bearer outcomes remain pending without proofs', async () => {
  for (const classification of ['partial', 'uncertain'] as const) {
    const delivery = makeTransfer(
      deriveNativeConditionRegistrationFeeTransferId(classification),
      'delivery-pending',
      7,
      0,
    )
    const fixture = coordinatorFixture({ initial: delivery, classification })
    const result = await prepareNativeConditionRegistrationFee(
      { coordinator: fixture.coordinator },
      {
        creationId: classification,
        mintUrl: MINT_URL,
        requiredFeeMsat: 7,
        wallet,
      },
    )
    assert.equal(result.kind, 'pending')
    assert.equal(result.feeProofs.length, 0)
  }
})

function coordinatorFixture(
  options: {
    initial?: DurableOutgoingCashuTransfer
    quoteFeeMsat?: number
    classification?: 'unspent' | 'spent' | 'partial' | 'uncertain'
    recoverAs?: 'delivery-pending' | 'prepared'
    recoverThrows?: boolean
  } = {},
) {
  const calls: string[] = []
  let transfer = options.initial ?? null
  let executeCount = 0
  let executeSeedLength: number | undefined
  const classifyState = options.classification ?? 'unspent'
  const coordinator = {
    async loadTransfer(transferId: string) {
      calls.push('loadTransfer')
      return transfer?.transferId === transferId ? transfer : null
    },
    async quoteSend({ amountMsat }: { amountMsat: number }) {
      calls.push('quoteSend')
      return {
        amountMsat,
        sendPreparationFeeMsat: options.quoteFeeMsat ?? 0,
        totalWalletDebitMsat: amountMsat + (options.quoteFeeMsat ?? 0),
      }
    },
    async execute({
      transferId,
      amountMsat,
      mintUrl,
      seed,
    }: {
      transferId: string
      amountMsat: number
      mintUrl: string
      seed: Uint8Array
    }) {
      calls.push('execute')
      executeCount += 1
      executeSeedLength = seed.byteLength
      transfer = makeTransfer(
        transferId,
        'delivery-pending',
        amountMsat,
        options.quoteFeeMsat ?? 0,
        mintUrl,
      )
      return transfer
    },
    async recover({ transfer: persisted }: { transfer: DurableOutgoingCashuTransfer }) {
      calls.push('recover')
      if (options.recoverThrows) throw new Error('nonterminal wallet operation')
      transfer = makeTransfer(
        persisted.transferId,
        options.recoverAs ?? 'delivery-pending',
        Number(persisted.requestedAmount),
        Number(persisted.walletSendOperation.preview.fees),
        persisted.mintUrl,
      )
      return transfer
    },
    async classifyBearerTransfer({ transferId }: { transferId: string }) {
      calls.push('classifyBearerTransfer')
      if (transfer === null || transfer.transferId !== transferId)
        throw new Error('missing transfer')
      const deliveryState =
        classifyState === 'spent'
          ? 'bearer-spent'
          : classifyState === 'partial'
            ? 'bearer-partial'
            : 'delivery-pending'
      const token = transfer.token
      transfer = {
        ...transfer,
        deliveryState,
        token:
          token === null
            ? null
            : {
                ...token,
                unspentProofs: classifyState === 'unspent' ? token.proofs : null,
              },
      }
      return {
        transferId,
        mintUrl: transfer.mintUrl,
        unit: transfer.unit,
        deliveryState: classifyState === 'uncertain' ? 'delivery-pending' : deliveryState,
        tokenDigest: transfer.token?.sha256 ?? null,
        tokenLength: transfer.token?.encodedLength ?? null,
        returnedAmount: null,
        receiveFee: null,
      }
    },
  }
  return {
    coordinator: coordinator as never,
    calls,
    get executeCount() {
      return executeCount
    },
    get executeSeedLength() {
      return executeSeedLength
    },
  }
}

function makeTransfer(
  transferId: string,
  deliveryState: 'prepared' | 'delivery-pending' | 'bearer-spent',
  amountMsat: number,
  feesMsat: number,
  mintUrl = MINT_URL,
): DurableOutgoingCashuTransfer {
  const proofs = [PROOF]
  const token =
    deliveryState === 'prepared'
      ? null
      : {
          encodedToken: 'cashuBtest',
          sha256: 'ab'.repeat(32),
          encodedLength: 10,
          proofs,
          unspentProofs: null,
          custodyRevisions: [],
        }
  return {
    transferId,
    mintUrl,
    unit: 'msat',
    requestedAmount: String(amountMsat),
    recipientSequence: null,
    deliveryIntent: {
      policy: 'bearer-spend-classification',
      tokenBytesLimit: 61_440,
      tokenProofLimit: 512,
    },
    deliveryState,
    token,
    walletSendOperation: {
      operationId: transferId,
      kind: 'wallet-send',
      mintUrl,
      unit: 'msat',
      preview: { amount: String(amountMsat), fees: String(feesMsat) },
    },
  } as unknown as DurableOutgoingCashuTransfer
}

const wallet = {} as never
