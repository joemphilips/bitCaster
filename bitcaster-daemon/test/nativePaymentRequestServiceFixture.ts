import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bytesToHex } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { nip19 } from 'nostr-tools'
import {
  Mint,
  Wallet,
  OutputData,
  CheckStateEnum,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  pointFromHex,
  type RequestOptions,
} from '@cashu/cashu-ts'
import { derivePaymentRequestReceiveKeyPair } from '@bitcaster-market/client-sdk/paymentRequest'
import { NativePaymentRequestOps } from '../src/nativePaymentRequestOps.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { emptyDaemonState, writeState } from '../src/state.ts'
import { withDaemonStateSqliteTransaction } from '../src/stateSqlite.ts'
import {
  createDaemonCounterSource,
  deserializeOutputGroups,
  type CashuWalletLike,
  type WalletOpsDependencies,
} from '../src/walletOps.ts'

export const MINT = 'https://mint.example'
export const SEED = '11'.repeat(64)
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 7])
const KEYS = { '1': bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true)) }
const ID = deriveKeysetId(KEYS, { unit: 'msat', versionByte: 1 })
function sign(output: OutputData) {
  const { id, B_, amount } = output.blindedMessage
  const signature = createBlindSignature(pointFromHex(B_), PRIVATE_KEY, id)
  const dleq = createDLEQProof(pointFromHex(B_), PRIVATE_KEY)
  return output.toProof(
    {
      id,
      amount,
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id, keys: KEYS },
  )
}
export const PROOFS = ['service-input-a', 'service-input-b'].map((secret) =>
  sign(OutputData.createSingleData(1, ID, secret, 19n)),
)
export function message(reverse = false) {
  return JSON.stringify({
    id: 'request',
    mint: MINT,
    unit: 'msat',
    proofs: reverse ? [...PROOFS].reverse() : PROOFS,
  })
}
export function assertRedacted(value: unknown) {
  const text = JSON.stringify(value)
  for (const secret of [
    SEED,
    ...PROOFS.flatMap((proof) => [proof.secret, proof.C]),
    'privateKey',
    'proof_body',
  ])
    assert.equal(text.includes(secret), false, 'private material in public output')
}

export async function serviceFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'native-request-service-'))
  const previous = process.env.BITCASTER_DAEMON_HOME
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('unmocked HTTP refused')
  }
  process.env.BITCASTER_DAEMON_HOME = directory
  const profile = {
    engineBaseUrl: 'https://engine.example',
    mintUrl: MINT,
    initializedAt: new Date().toISOString(),
  }
  const bootstrap = await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: profile.engineBaseUrl,
    mintUrl: MINT,
    walletSeedHex: SEED,
    nostrSecretKeyHex: '22'.repeat(32),
  })
  await writeState(emptyDaemonState())
  const fence = await claimCustodyScopeLease(directory, {
    scopeId: bootstrap.walletScopeId,
    incarnationId: 'request-service-test',
    observedAtMs: Date.now(),
  })
  const counts = { prepared: 0, swaps: 0, restores: 0 }
  const control = {
    failAfterMintEffect: false,
    state: CheckStateEnum.UNSPENT as CheckStateEnum,
    restore: false,
  }
  const deps: WalletOpsDependencies = {
    getCustodyFence: () => fence,
    resolveMintKeysetIds: async () => [ID],
    resolveTokenImportKeysets: async () => ({
      canonicalMintUrl: MINT,
      freshness: 'fresh',
      regularKeysets: [{ keysetId: ID, unit: 'msat', active: true }],
      conditionalKeysets: [],
    }),
    createCashuWallet: () => {
      const customRequest = async <T>(args: RequestOptions): Promise<T> => {
        const endpoint = new URL(args.endpoint).pathname
        if (endpoint === '/v1/info')
          return { name: 'mock mint', nuts: { '12': { supported: true } } } as T
        if (endpoint === '/v1/keysets')
          return { keysets: [{ id: ID, unit: 'msat', active: true, input_fee_ppk: 0 }] } as T
        if (endpoint === '/v1/keys')
          return { keysets: [{ id: ID, unit: 'msat', keys: KEYS, input_fee_ppk: 0 }] } as T
        if (endpoint === '/v1/checkstate') {
          const { Ys } = args.requestBody as { Ys: string[] }
          return { states: Ys.map((Y) => ({ Y, state: control.state, witness: null })) } as T
        }
        if (endpoint === '/v1/swap') {
          counts.swaps++
          const { outputs } = args.requestBody as {
            outputs: Array<{ id: string; amount: number; B_: string }>
          }
          const signatures = outputs.map((output) => {
            const signature = createBlindSignature(pointFromHex(output.B_), PRIVATE_KEY, output.id)
            const dleq = createDLEQProof(pointFromHex(output.B_), PRIVATE_KEY)
            return {
              id: output.id,
              amount: output.amount,
              C_: signature.C_.toHex(true),
              dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
            }
          })
          if (control.failAfterMintEffect) throw new Error(`mint failure ${PROOFS[0]!.secret}`)
          return { signatures } as T
        }
        throw new Error('unexpected mint endpoint')
      }
      const wallet = new Wallet(new Mint(MINT, { customRequest }), {
        unit: 'msat',
        bip39seed: Buffer.from(SEED, 'hex'),
        counterSource: createDaemonCounterSource(() => ({ fence, observedAtMs: Date.now() }), {
          normalizedMint: MINT,
          unit: 'msat',
        }),
      })
      const prepare = wallet.prepareSwapToReceive.bind(wallet)
      wallet.prepareSwapToReceive = async (...args) => {
        counts.prepared++
        return prepare(...args)
      }
      return wallet as unknown as CashuWalletLike
    },
    restoreOutputGroups: async (_mint, groups) => {
      counts.restores++
      return Object.fromEntries(
        Object.entries(deserializeOutputGroups(groups)).map(([group, outputs]) => [
          group,
          control.restore ? outputs.map(sign) : [],
        ]),
      )
    },
  }
  const createOps = () =>
    new NativePaymentRequestOps({
      profile,
      secrets: { walletSeedHex: SEED },
      getFence: () => fence,
      deps,
    })
  const ops = createOps()
  const nprofile = nip19.nprofileEncode({
    pubkey: derivePaymentRequestReceiveKeyPair(Buffer.from(SEED, 'hex')).publicKey,
    relays: ['wss://relay.example'],
  })
  return {
    directory,
    deps,
    ops,
    createOps,
    nprofile,
    counts,
    control,
    requestCount: () =>
      withDaemonStateSqliteTransaction(directory, (db) =>
        Number(db.prepare('SELECT count(*) n FROM native_payment_requests').get()!.n),
      ),
    targetCount: () =>
      withDaemonStateSqliteTransaction(directory, (db) =>
        Number(db.prepare('SELECT count(*) n FROM target_wallet_proofs').get()!.n),
      ),
    close: async () => {
      globalThis.fetch = previousFetch
      if (previous === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = previous
      await rm(directory, { recursive: true, force: true })
    },
  }
}
