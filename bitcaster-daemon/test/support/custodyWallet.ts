import { bytesToHex } from '@noble/curves/utils.js'
import {
  Amount,
  CheckStateEnum,
  Mint as CashuMint,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  hashToCurve,
  pointFromHex,
  type CounterSource,
  type Proof,
} from '@cashu/cashu-ts'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '@bitcaster-market/client-sdk'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mintDenominationKeys,
  mintDenominationPrivateKey,
} from '../../../bitcaster-client-sdk/test/support/mintDenominationKeys.ts'
import { createCustodyProofSqliteRow } from '../../src/custodyProofSqliteRow.ts'
import { DurableCustodySqliteStore } from '../../src/durableCustodySqliteStore.ts'
import { withDurableCustodyUnitOfWork } from '../../src/durableCustodyUnitOfWork.ts'
import { DaemonDurableOutgoingCashuCoordinator } from '../../src/durableOutgoingCashuCoordinator.ts'
import { bootstrapFreshDaemonProfile } from '../../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../../src/profileFencing.ts'
import { addAvailableProofs, readState, type StoredOutputData } from '../../src/state.ts'
import {
  createWallet,
  deserializeOutputGroups,
  type WalletOpsDependencies,
} from '../../src/walletOps.ts'

export const MINT_URL = 'https://mint.example'
export const SEED_HEX = '11'.repeat(64)
export const SEED = Buffer.from(SEED_HEX, 'hex')
const ROOT = Uint8Array.from([...new Uint8Array(31), 9])
export const DENOMINATIONS = Array.from({ length: 16 }, (_, power) => 2 ** power)
const KEYS = mintDenominationKeys(ROOT, DENOMINATIONS.map(String))
const INPUT_FEE_PPK = 1_000
const KEYSET_ID = deriveKeysetId(KEYS, {
  unit: 'msat',
  versionByte: 1,
  input_fee_ppk: INPUT_FEE_PPK,
})
/** A larger wallet holds proofs without DLEQ. A payment request cannot spend them, a send can. */
const DLEQ_PROOF_LIMIT = 64
export const INVOICE = 'lnbc1approveddebit'
const FEE_RESERVE_MSAT = 10
const PAYMENT_EXPIRY = Math.floor(Date.now() / 1_000) + 600
/** The transfer is saved and minted before the recipient fails. */
export const OFFLINE_RECIPIENT = {
  getDurableRecipientDeliveryStatus: async () => null,
  submitDurableRecipientDelivery: async () => {
    throw new Error('recipient is offline')
  },
}

/** Run with a custody wallet that uses the production wallet factory and cashu-ts. */
export async function withCustodyWallet(
  heldAmounts: readonly number[],
  run: (fixture: Awaited<ReturnType<typeof openFixture>>) => Promise<void>,
  options: { readonly dleq?: boolean; readonly paymentMsat?: number } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-custody-wallet-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  try {
    await run(await openFixture(directory, heldAmounts, options))
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
}

async function openFixture(
  directory: string,
  heldAmounts: readonly number[],
  options: { readonly dleq?: boolean; readonly paymentMsat?: number },
) {
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
    incarnationId: 'custody-wallet-test',
    observedAtMs: Date.now(),
  })
  const proofs = heldAmounts.map((amount, index) =>
    (options.dleq ?? heldAmounts.length <= DLEQ_PROOF_LIMIT)
      ? heldProof(amount, index)
      : heldProofWithoutDleq(amount, index),
  )
  await addAvailableProofs(MINT_URL, proofs, { kind: 'sats', baseAsset: 'sat', unit: 'msat' })
  await withDurableCustodyUnitOfWork(directory, fence, Date.now(), (database) => {
    new DurableCustodySqliteStore(database).putProofBatchCas(
      proofs.map((proof) => ({
        proof: createCustodyProofSqliteRow({
          scopeId,
          normalizedMint: MINT_URL,
          unit: 'msat',
          proof: custodyMaterial(proof),
          baseAsset: 'sat',
          conditionId: null,
          outcomeSetId: null,
          productBinding: null,
          signatureVerified: true,
          dleqState: proof.dleq === undefined ? 'not-present' : 'verified',
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
  const mint = new SigningMint(options.paymentMsat ?? 1_000)
  const deps: WalletOpsDependencies = {
    getCustodyFence: getFence,
    createCashuMint: () => mint.client(),
    restoreOutputGroups: async (_mintUrl, outputs) => mint.restore(outputs),
  }
  const walletFactory = (source?: CounterSource) =>
    createWallet(MINT_URL, { walletSeedHex: SEED_HEX }, deps, 'sat', 'msat', undefined, source)
  return {
    directory,
    deps,
    mint,
    getFence,
    profile: {
      engineBaseUrl: 'https://engine.example',
      mintUrl: MINT_URL,
      initializedAt: new Date(1).toISOString(),
    },
    coordinator: new DaemonDurableOutgoingCashuCoordinator(directory, getFence, deps),
    /** The amounts that the wallet table and custody can spend. They must agree. */
    spendableAmounts: async () => readSpendableAmounts(directory, fence),
    walletFactory,
    openWallet: async () => {
      const wallet = walletFactory()
      await wallet.loadMint()
      return wallet
    },
  }
}

/** A mint that signs each swap once and reports the spent inputs. */
class SigningMint {
  /** The next payments succeed. Without it the mint gives no payment answer. */
  payInvoices = false
  payments = 0
  readonly #paymentMsat: number

  constructor(paymentMsat: number) {
    this.#paymentMsat = paymentMsat
  }

  /** The next swap spends its inputs and signs its outputs, but the answer is lost. */
  loseNextSwapAnswer = false
  swaps = 0
  inputFeesMsat = 0
  readonly #spent = new Set<string>()

  client(): CashuMint {
    const mint = new CashuMint(MINT_URL)
    const meta = { id: KEYSET_ID, unit: 'msat', active: true, input_fee_ppk: INPUT_FEE_PPK }
    mint.getInfo = async () => ({
      nuts: { '5': { methods: [{ method: 'bolt11', unit: 'msat' }], disabled: false } },
    })
    mint.getKeySets = async () => ({ keysets: [meta] })
    mint.getKeys = async () => ({ keysets: [{ ...meta, keys: KEYS }] })
    mint.swap = async ({ inputs, outputs }) => {
      const fee = total(inputs) - total(outputs)
      if (fee !== Math.ceil((inputs.length * INPUT_FEE_PPK) / 1_000))
        throw new Error('swap is not balanced')
      for (const { secret } of inputs) {
        if (this.#spent.has(proofY(secret))) throw new Error('swap input is spent')
        this.#spent.add(proofY(secret))
      }
      this.swaps += 1
      this.inputFeesMsat += fee
      if (this.loseNextSwapAnswer) {
        this.loseNextSwapAnswer = false
        throw new Error('swap answer is lost')
      }
      return { signatures: outputs.map((output) => blindSignature(output)) }
    }
    mint.check = async ({ Ys }) => ({
      states: Ys.map((Y) => ({
        Y,
        state: this.#spent.has(Y) ? CheckStateEnum.SPENT : CheckStateEnum.UNSPENT,
        witness: null,
      })),
    })
    const payment = () => ({
      quote: 'payment-quote',
      amount: Amount.from(this.#paymentMsat - FEE_RESERVE_MSAT),
      fee_reserve: Amount.from(FEE_RESERVE_MSAT),
      unit: 'msat',
      state: 'UNPAID' as const,
      request: INVOICE,
      expiry: PAYMENT_EXPIRY,
      payment_preimage: null,
    })
    mint.createMeltQuoteBolt11 = async () => payment()
    mint.checkMeltQuote = async () => payment()
    mint.melt = async (_method, { inputs, outputs = [] }) => {
      if (!this.payInvoices) throw new Error('no payment answer')
      for (const { secret } of inputs) this.#spent.add(proofY(secret))
      this.payments += 1
      // The payment used no fee, so the whole reserve returns as change.
      const change = splitAmount(FEE_RESERVE_MSAT).map((amount, index) =>
        blindSignature({ amount, B_: outputs[index]!.B_ }),
      )
      return { ...payment(), state: 'PAID' as const, change }
    }
    return mint
  }

  restore(groups: Record<string, StoredOutputData[]>): Record<string, Proof[]> {
    return Object.fromEntries(
      Object.entries(deserializeOutputGroups(groups)).map(([group, outputs]) => [
        group,
        outputs.map((output) =>
          output.toProof(blindSignature(output.blindedMessage), { id: KEYSET_ID, keys: KEYS }),
        ),
      ]),
    )
  }
}

function splitAmount(amount: number): number[] {
  return DENOMINATIONS.filter((value) => Math.floor(amount / value) % 2 === 1)
}

function proofY(secret: string): string {
  return hashToCurve(new TextEncoder().encode(secret)).toHex(true)
}

function total(values: readonly { readonly amount: unknown }[]): number {
  return values.reduce((sum, { amount }) => sum + amountToNumber(amount), 0)
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
  return output.toProof(blindSignature(output.blindedMessage), { id: KEYSET_ID, keys: KEYS })
}

/** A valid signature without a DLEQ proof. Thousands of proofs with DLEQ take minutes to sign. */
function heldProofWithoutDleq(amount: number, index: number): Proof {
  const secret = `held-${index}`
  const key = mintDenominationPrivateKey(ROOT, String(amount))
  return {
    id: KEYSET_ID,
    amount: Amount.from(amount),
    secret,
    C: createBlindSignature(pointFromHex(proofY(secret)), key, KEYSET_ID).C_.toHex(true),
  }
}

function custodyMaterial(proof: Proof) {
  return {
    id: proof.id,
    amount: proof.amount,
    secret: proof.secret,
    C: proof.C,
    dleq: proof.dleq ?? null,
    p2pkE: null,
    witness: null,
  }
}

async function readSpendableAmounts(
  directory: string,
  fence: Awaited<ReturnType<typeof claimCustodyScopeLease>>,
): Promise<number[]> {
  const custody = await withDurableCustodyUnitOfWork(directory, fence, Date.now(), (database) =>
    database
      .prepare("SELECT amount FROM custody_proofs WHERE selectability = 'selectable'")
      .all()
      .map((row) => Number(row.amount)),
  )
  const wallet = (await readState()).wallet.proofs
    .filter(({ state }) => state === 'available')
    .map(({ proof }) => amountToNumber(proof.amount))
  const sorted = (values: number[]) => values.sort((a, b) => a - b)
  if (JSON.stringify(sorted(custody)) !== JSON.stringify(sorted(wallet)))
    throw new Error('the wallet table and custody hold different proofs')
  return sorted(custody)
}
