import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bytesToHex } from '@noble/curves/utils.js'
import {
  Amount,
  CheckStateEnum,
  Mint as CashuMint,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  pointFromHex,
  type CounterSource,
  type Proof,
} from '@cashu/cashu-ts'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '@bitcaster-market/client-sdk'
import {
  mintDenominationKeys,
  mintDenominationPrivateKey,
} from '../../bitcaster-client-sdk/test/support/mintDenominationKeys.ts'
import { createCustodyProofSqliteRow } from '../src/custodyProofSqliteRow.ts'
import { DurableCustodySqliteStore } from '../src/durableCustodySqliteStore.ts'
import { withDurableCustodyUnitOfWork } from '../src/durableCustodyUnitOfWork.ts'
import { DaemonDurableOutgoingCashuCoordinator } from '../src/durableOutgoingCashuCoordinator.ts'
import { prepareNativeConditionRegistrationFee } from '../src/nativeConditionRegistrationFee.ts'
import { NativeWalletPaymentOps } from '../src/nativeWalletPaymentOps.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { addAvailableProofs } from '../src/state.ts'
import { createWallet, quoteMarketFundingCashu } from '../src/walletOps.ts'

const MINT_URL = 'https://mint.example'
const SEED_HEX = '11'.repeat(64)
const SEED = Buffer.from(SEED_HEX, 'hex')
const ROOT = Uint8Array.from([...new Uint8Array(31), 9])
const DENOMINATIONS = Array.from({ length: 16 }, (_, power) => String(2 ** power))
const KEYS = mintDenominationKeys(ROOT, DENOMINATIONS)
const INPUT_FEE_PPK = 1_000
const KEYSET_ID = deriveKeysetId(KEYS, {
  unit: 'msat',
  versionByte: 1,
  input_fee_ppk: INPUT_FEE_PPK,
})
const INVOICE = 'lnbc1approveddebit'
/** A wallet after some use: several proofs of each small denomination. */
const HELD_AMOUNTS = DENOMINATIONS.slice(1, 12).flatMap((amount) => Array<number>(4).fill(+amount))

test('a send quote is the same for the same spendable proofs', async () => {
  await withWallet(async ({ coordinator, openWallet }) => {
    const debits = new Set<number>()
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const quote = await coordinator.quoteSend({
        amountMsat: 1_000,
        mintUrl: MINT_URL,
        wallet: await openWallet(),
      })
      debits.add(quote.totalWalletDebitMsat)
    }
    assert.equal(debits.size, 1, `quotes differ: ${[...debits].sort((a, b) => a - b).join(', ')}`)
  })
})

test('a registration fee quote that the caller approves exactly is paid', async () => {
  await withWallet(async ({ coordinator, openWallet, walletFactory }) => {
    for (let creation = 0; creation < 8; creation += 1) {
      const wallet = await openWallet()
      const approved = await coordinator.quoteSend({
        amountMsat: 1_000,
        mintUrl: MINT_URL,
        wallet,
      })
      const paid = await prepareNativeConditionRegistrationFee(
        { coordinator },
        {
          creationId: `creation-${creation}`,
          mintUrl: MINT_URL,
          requiredFeeMsat: 1_000,
          maxWalletDebitMsat: approved.totalWalletDebitMsat,
          seed: SEED,
          wallet,
          createWallet: walletFactory,
        },
      )
      assert.equal(paid.kind, 'prepared')
      const transfer = await coordinator.loadTransfer(paid.transferId!)
      assert.equal(
        amountToNumber(transfer!.walletSendOperation.preview.fees),
        approved.sendPreparationFeeMsat,
        'the execution must use the quoted inputs',
      )
    }
  })
})

test('a debit below the quoted debit is still refused', async () => {
  await withWallet(async ({ coordinator, openWallet, walletFactory }) => {
    const wallet = await openWallet()
    const quote = await coordinator.quoteSend({ amountMsat: 1_000, mintUrl: MINT_URL, wallet })
    await assert.rejects(
      prepareNativeConditionRegistrationFee(
        { coordinator },
        {
          creationId: 'below-the-quote',
          mintUrl: MINT_URL,
          requiredFeeMsat: 1_000,
          maxWalletDebitMsat: quote.totalWalletDebitMsat - 1,
          seed: SEED,
          wallet,
          createWallet: walletFactory,
        },
      ),
      {
        name: 'ApprovedWalletDebitExceededError',
        message: 'condition registration fee exceeds the approved wallet debit',
      },
    )
    await assert.rejects(
      coordinator.execute({
        transferId: 'below-the-quote',
        amountMsat: 1_000,
        mintUrl: MINT_URL,
        wallet,
        seed: SEED,
        createWallet: walletFactory,
        maxWalletDebitMsat: quote.totalWalletDebitMsat - 1,
      }),
      {
        name: 'ApprovedWalletDebitExceededError',
        message: 'outgoing wallet debit exceeds the approved maximum',
      },
    )
  })
})

test('a market funding quote is the same for the same spendable proofs', async () => {
  await withWallet(async ({ profile, deps }) => {
    const debits = new Set<number>()
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const quote = await quoteMarketFundingCashu({
        requestedAmountMsat: 10_000,
        outcomeCount: 2,
        profile,
        secrets: { walletSeedHex: SEED_HEX },
        deps,
      })
      debits.add(quote.totalWalletDebitMsat)
    }
    assert.equal(debits.size, 1, `quotes differ: ${[...debits].sort((a, b) => a - b).join(', ')}`)
  })
})

test('a payment quote is the same for the same spendable proofs', async () => {
  await withWallet(async ({ profile, deps, directory, getFence }) => {
    const ops = new NativeWalletPaymentOps({
      profile,
      secrets: { walletSeedHex: SEED_HEX },
      getFence,
      deps,
      directory,
    })
    const debits = new Set<number>()
    for (let attempt = 0; attempt < 20; attempt += 1)
      debits.add((await ops.quote({ invoice: INVOICE })).totalWalletDebitMsat)
    assert.equal(debits.size, 1, `quotes differ: ${[...debits].sort((a, b) => a - b).join(', ')}`)
  })
})

/** Run with a custody wallet that uses the production wallet factory and cashu-ts selection. */
async function withWallet(
  run: (fixture: Awaited<ReturnType<typeof openFixture>>) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-approved-debit-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  try {
    await run(await openFixture(directory))
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
}

async function openFixture(directory: string) {
  await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: MINT_URL,
    walletSeedHex: SEED_HEX,
    nostrSecretKeyHex: '22'.repeat(32),
  })
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: 'wallet',
    walletId: deriveDurableCustodyWalletId(SEED),
  })
  const fence = await claimCustodyScopeLease(directory, {
    scopeId,
    incarnationId: 'approved-debit-test',
    observedAtMs: Date.now(),
  })
  const proofs = HELD_AMOUNTS.map((amount, index) => heldProof(amount, index))
  await addAvailableProofs(MINT_URL, proofs, { kind: 'sats', baseAsset: 'sat', unit: 'msat' })
  await withDurableCustodyUnitOfWork(directory, fence, Date.now(), (database) => {
    new DurableCustodySqliteStore(database).putProofBatchCas(
      proofs.map((proof) => ({
        proof: createCustodyProofSqliteRow({
          scopeId,
          normalizedMint: MINT_URL,
          unit: 'msat',
          proof,
          baseAsset: 'sat',
          conditionId: null,
          outcomeSetId: null,
          productBinding: null,
          signatureVerified: true,
          dleqState: 'verified',
          nut07State: 'UNSPENT',
          selectability: 'selectable',
          storageClass: 'pinned-operation-bound-deterministic',
          reservationOperationId: null,
          revision: 0,
          nowMs: Date.now(),
        }),
        expectedRevision: null,
      })),
    )
  })
  const getFence = () => fence
  const deps = { getCustodyFence: getFence, createCashuMint: () => signingMint() }
  const walletFactory = (source?: CounterSource) =>
    createWallet(MINT_URL, { walletSeedHex: SEED_HEX }, deps, 'sat', 'msat', undefined, source)
  return {
    directory,
    deps,
    getFence,
    profile: {
      engineBaseUrl: 'https://engine.example',
      mintUrl: MINT_URL,
      initializedAt: new Date(1).toISOString(),
    },
    coordinator: new DaemonDurableOutgoingCashuCoordinator(directory, getFence, deps),
    walletFactory,
    openWallet: async () => {
      const wallet = walletFactory()
      await wallet.loadMint()
      return wallet
    },
  }
}

function signingMint(): CashuMint {
  const mint = new CashuMint(MINT_URL)
  const meta = { id: KEYSET_ID, unit: 'msat', active: true, input_fee_ppk: INPUT_FEE_PPK }
  mint.getInfo = async () => ({
    nuts: { '5': { methods: [{ method: 'bolt11', unit: 'msat' }], disabled: false } },
  })
  mint.getKeySets = async () => ({ keysets: [meta] })
  mint.getKeys = async () => ({ keysets: [{ ...meta, keys: KEYS }] })
  mint.swap = async ({ outputs }) => ({
    signatures: outputs.map((output) => blindSignature(output)),
  })
  mint.check = async ({ Ys }) => ({
    states: Ys.map((Y) => ({ Y, state: CheckStateEnum.UNSPENT, witness: null })),
  })
  mint.createMeltQuoteBolt11 = async () => ({
    quote: 'payment-quote',
    amount: Amount.from(900),
    fee_reserve: Amount.from(100),
    unit: 'msat',
    state: 'UNPAID',
    request: INVOICE,
    expiry: Math.floor(Date.now() / 1_000) + 600,
    payment_preimage: null,
  })
  return mint
}

function blindSignature(output: { readonly amount: unknown; readonly B_: string }) {
  const key = mintDenominationPrivateKey(ROOT, String(amountToNumber(output.amount)))
  const point = pointFromHex(output.B_)
  const dleq = createDLEQProof(point, key)
  return {
    id: KEYSET_ID,
    amount: Amount.from(amountToNumber(output.amount)),
    C_: createBlindSignature(point, key, KEYSET_ID).C_.toHex(true),
    dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
  }
}

function heldProof(amount: number, index: number): Proof {
  const output = OutputData.createSingleData(
    amount,
    KEYSET_ID,
    `held-${index}`,
    BigInt(1_000 + index),
  )
  const proof = output.toProof(blindSignature(output.blindedMessage), { id: KEYSET_ID, keys: KEYS })
  return {
    id: proof.id,
    amount: proof.amount,
    secret: proof.secret,
    C: proof.C,
    dleq: { ...proof.dleq!, r: proof.dleq!.r ?? null },
    p2pkE: null,
    witness: null,
  } as unknown as Proof
}
