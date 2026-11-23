import {
  mintDenominationKeys,
  mintDenominationPrivateKey,
} from '../../../bitcaster-client-sdk/test/support/mintDenominationKeys.ts'
import { utf8ToBytes, bytesToHex } from '@noble/hashes/utils.js'
import {
  CheckStateEnum,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  hashToCurve,
  pointFromHex,
  type MintKeys,
  type OutputDataLike,
  type Proof,
} from '@cashu/cashu-ts'
import { canonicalTestKeysetId } from './canonicalKeysetId.ts'

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

  constructor(error?: unknown) {
    this.error = error
  }
  conditional?: MintKeys
  conditionInfo?: unknown
  alterResult?: (proofs: Proof[]) => Proof[]
  readonly mint = {
    getCtfCondition: async () => {
      if (this.conditionInfo === undefined) throw new Error('condition info unavailable')
      return this.conditionInfo
    },
    getKeySets: async () => ({ keysets: [regularKeyset(), this.conditional ?? outcomeKeyset()] }),
    getKeys: async (keysetId?: string) => ({
      keysets: [
        keysetId === (this.conditional?.id ?? CTF_KEYSET_ID)
          ? (this.conditional ?? outcomeKeyset())
          : regularKeyset(),
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
    const result = options.outputs.map((output) => {
      const privateKey = mintDenominationPrivateKey(
        REGULAR_ROOT,
        String(output.blindedMessage.amount),
      )
      const signature = createBlindSignature(
        pointFromHex(output.blindedMessage.B_),
        privateKey,
        output.blindedMessage.id,
      )
      const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), privateKey)
      return output.toProof(
        {
          id: output.blindedMessage.id,
          amount: output.blindedMessage.amount,
          C_: signature.C_.toHex(true),
          dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
        },
        regularKeyset(),
      )
    })
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

export function outcomeKeyset(): MintKeys {
  return { ...regularKeyset(), id: CTF_KEYSET_ID }
}
