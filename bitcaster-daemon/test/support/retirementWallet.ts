import {
  mintDenominationKeys,
  mintDenominationPrivateKey,
} from '../../../bitcaster-client-sdk/test/support/mintDenominationKeys.ts'
import { utf8ToBytes, bytesToHex } from '@noble/hashes/utils.js'
import {
  CheckStateEnum,
  Mint,
  MintOperationError,
  OutputData,
  Wallet,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveKeysetId,
  hashToCurve,
  pointFromHex,
  type CounterSource,
  type MintKeys,
  type OutputDataLike,
  type Proof,
  type RequestOptions,
} from '@cashu/cashu-ts'
import { deriveRootCtfOutcomeCollectionId } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import { DurableWalletProofImportCoordinator } from '../../src/durableWalletProofImportCoordinator.ts'
import type { CustodyScopeFence } from '../../src/profileFencing.ts'
import { ensureState } from '../../src/state.ts'
import { createDaemonCounterSource } from '../../src/walletOps.ts'
import { canonicalTestKeysetId } from './canonicalKeysetId.ts'

/** A keyset id for a wallet-only outcome row. Custody cannot hold a proof of it. */
export const CTF_KEYSET_ID = canonicalTestKeysetId('managed-retirement:ctf')
export const REGULAR_ROOT = Uint8Array.from([...new Uint8Array(31), 1])
export const REGULAR_KEYS = mintDenominationKeys(REGULAR_ROOT, ['1', '2', '4'])
export const REGULAR_KEYSET_ID = deriveKeysetId(REGULAR_KEYS, {
  unit: 'msat',
  versionByte: 1,
  input_fee_ppk: 0,
})

/** A fake mint wallet that signs exact redeem outputs with the regular test keys. */
export class FakeRetirementWallet {
  requests: Array<Array<{ id: string; amount: string; B_: string }>> = []
  /** The witness of each redeemed input, in request order. */
  witnesses: Array<string | undefined> = []
  redeemCalls = 0
  error: unknown
  /** The mint signs the outputs, but its answer does not arrive. */
  loseResponse = false
  /** The mint answers 13015 for an input of these keysets: the outcome lost. */
  readonly losingKeysets = new Set<string>()
  /** The conditional keysets of the held positions, by keyset id. */
  readonly conditionals = new Map<string, MintKeys>()

  constructor(error?: unknown) {
    this.error = error
  }
  conditionInfo?: unknown
  alterResult?: (proofs: Proof[]) => Proof[]
  readonly mint = {
    getCtfCondition: async () => {
      if (this.conditionInfo === undefined) throw new Error('condition info unavailable')
      return this.conditionInfo
    },
    getKeySets: async () => ({ keysets: [regularKeyset(), ...this.conditionals.values()] }),
    getKeys: async (keysetId?: string) => ({
      keysets: [
        (keysetId === undefined ? undefined : this.conditionals.get(keysetId)) ?? regularKeyset(),
      ],
    }),
  }

  async loadMint(): Promise<void> {}

  async redeemOutcomeProofs(options: {
    inputs: Proof[]
    outputs: OutputDataLike[]
  }): Promise<Proof[]> {
    this.requests.push(
      options.outputs.map(({ blindedMessage }) => ({
        ...blindedMessage,
        amount: String(blindedMessage.amount),
      })),
    )
    this.witnesses.push(
      ...options.inputs.map((input) =>
        typeof input.witness === 'string' ? input.witness : undefined,
      ),
    )
    this.redeemCalls += 1
    if (this.error !== undefined) throw this.error
    if (options.inputs.some(({ id }) => this.losingKeysets.has(id)))
      throw new MintOperationError(13015, 'oracle did not attest this outcome')
    const result = options.outputs.map((output) => signOutput(output, regularKeyset()))
    if (this.loseResponse) throw new Error('lost mint response')
    return this.alterResult?.(result) ?? result
  }

  async checkProofsStates(proofs: Array<Pick<Proof, 'secret'>>) {
    return proofs.map(({ secret }) => ({
      Y: hashToCurve(new TextEncoder().encode(secret)).toHex(true),
      state: CheckStateEnum.UNSPENT,
      witness: null,
    }))
  }
}

/** A wallet-only proof without a valid signature. */
export function proof(id: string, secret: string, amount: number): Proof {
  return { id, secret, amount, C: hashToCurve(utf8ToBytes(secret)).toHex(true) } as Proof
}

export function regularKeyset(): MintKeys {
  return {
    id: REGULAR_KEYSET_ID,
    unit: 'msat',
    active: true,
    input_fee_ppk: 0,
    keys: REGULAR_KEYS,
  } as unknown as MintKeys
}

/** The conditional keyset of one root outcome collection. The regular test keys sign it. */
export function conditionalKeyset(
  conditionId: string,
  outcomeCollection: string,
  inputFeePpk = 0,
): MintKeys {
  const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({ conditionId, outcomeCollection })
  return {
    id: deriveConditionalKeysetId({
      keys: REGULAR_KEYS,
      unit: 'msat',
      conditionId,
      outcomeCollectionId,
      input_fee_ppk: inputFeePpk,
    }),
    unit: 'msat',
    active: true,
    input_fee_ppk: inputFeePpk,
    keys: REGULAR_KEYS,
    conditional: {
      condition_id: conditionId,
      outcome_collection: outcomeCollection,
      outcome_collection_id: outcomeCollectionId,
    },
  } as MintKeys
}

/** A proof that the test mint signed, with a DLEQ proof. The amount is one key amount. */
export function signedProof(keyset: MintKeys, secret: string, amount: number): Proof {
  return signOutput(OutputData.createSingleData(amount, keyset.id, secret, 1n), keyset)
}

/**
 * Receive outcome proofs through the production import, so custody holds each
 * one as an available position. Each given wallet learns the conditional keyset.
 */
export async function holdOutcomeProofs(input: {
  readonly directory: string
  readonly fence: CustodyScopeFence
  readonly mintUrl: string
  readonly conditionId: string
  readonly outcomeCollection: string
  readonly proofs: ReadonlyArray<{ readonly secret: string; readonly amount: number }>
  readonly inputFeePpk?: number
  readonly wallets?: readonly FakeRetirementWallet[]
}): Promise<{ readonly keyset: MintKeys; readonly proofs: Proof[] }> {
  // The daemon state must exist first. A first state write replaces the wallet rows.
  await ensureState()
  const keyset = conditionalKeyset(input.conditionId, input.outcomeCollection, input.inputFeePpk)
  for (const wallet of input.wallets ?? []) wallet.conditionals.set(keyset.id, keyset)
  const proofs = input.proofs.map(({ secret, amount }) => signedProof(keyset, secret, amount))
  const importer = new DurableWalletProofImportCoordinator(input.directory, () => input.fence)
  await importer.importOutcomeProofs({
    mintUrl: input.mintUrl,
    proofs,
    asset: {
      kind: 'Outcome',
      conditionId: input.conditionId,
      outcomeSetId: input.outcomeCollection,
      baseAsset: 'sat',
      unit: 'msat',
    },
    keysets: [
      {
        canonicalMintUrl: input.mintUrl,
        id: keyset.id,
        unit: 'msat',
        keys: REGULAR_KEYS,
        inputFeePpk: input.inputFeePpk ?? 0,
        finalExpiry: null,
        identity: {
          kind: 'conditional',
          conditionId: input.conditionId,
          outcomeCollection: input.outcomeCollection,
          outcomeCollectionId: deriveRootCtfOutcomeCollectionId({
            conditionId: input.conditionId,
            outcomeCollection: input.outcomeCollection,
          }),
        },
      },
    ],
    checkProofsStates: async (held) =>
      held.map(({ secret }) => ({
        Y: hashToCurve(utf8ToBytes(secret)).toHex(true),
        state: CheckStateEnum.UNSPENT,
        witness: null,
      })),
  })
  return { keyset, proofs }
}

/** A regular mint for sends. It signs swap outputs with the regular test keys. */
export class FakeRegularMint {
  readonly spent = new Set<string>()
  swaps = 0

  wallet(
    input: {
      readonly mintUrl: string
      readonly seedHex: string
      readonly fence: CustodyScopeFence
    },
    source?: CounterSource,
  ): Wallet {
    const customRequest = async <T>({ endpoint, requestBody }: RequestOptions): Promise<T> => {
      const route = new URL(endpoint).pathname
      if (route === '/v1/info')
        return { name: 'mock mint', nuts: { '12': { supported: true } } } as T
      if (
        route === '/v1/keysets' ||
        route === '/v1/keys' ||
        route === `/v1/keys/${REGULAR_KEYSET_ID}`
      )
        return { keysets: [regularKeyset()] } as T
      if (route === '/v1/checkstate') {
        const { Ys } = requestBody as { Ys: string[] }
        return {
          states: Ys.map((Y) => ({
            Y,
            state: this.spent.has(Y) ? CheckStateEnum.SPENT : CheckStateEnum.UNSPENT,
            witness: null,
          })),
        } as T
      }
      if (route === '/v1/swap') {
        const body = requestBody as {
          inputs: Proof[]
          outputs: Array<{ id: string; amount: number; B_: string }>
        }
        const Ys = body.inputs.map(({ secret }) => hashToCurve(utf8ToBytes(secret)).toHex(true))
        if (Ys.some((Y) => this.spent.has(Y))) throw new Error('fake mint input is spent')
        const signatures = body.outputs.map(({ id, amount, B_ }) => {
          const key = mintDenominationPrivateKey(REGULAR_ROOT, String(amount))
          const dleq = createDLEQProof(pointFromHex(B_), key)
          return {
            id,
            amount,
            C_: createBlindSignature(pointFromHex(B_), key, id).C_.toHex(true),
            dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
          }
        })
        for (const Y of Ys) this.spent.add(Y)
        this.swaps += 1
        return { signatures } as T
      }
      throw new Error('unexpected fake mint endpoint')
    }
    return new Wallet(new Mint(input.mintUrl, { customRequest }), {
      unit: 'msat',
      bip39seed: Buffer.from(input.seedHex, 'hex'),
      counterSource:
        source ??
        createDaemonCounterSource(() => ({ fence: input.fence, observedAtMs: Date.now() }), {
          normalizedMint: input.mintUrl,
          unit: 'msat',
        }),
    })
  }
}

function signOutput(output: OutputDataLike, keyset: MintKeys): Proof {
  const key = mintDenominationPrivateKey(REGULAR_ROOT, String(output.blindedMessage.amount))
  const signature = createBlindSignature(pointFromHex(output.blindedMessage.B_), key, keyset.id)
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), key)
  return output.toProof(
    {
      id: keyset.id,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    keyset,
  )
}
