import { mintDenominationKeys, mintDenominationPrivateKey } from './mintDenominationKeys.ts'
import { bytesToHex } from '@noble/curves/utils.js'
import {
  Amount,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveKeysetId,
  pointFromHex,
  type Proof,
  type SerializedBlindedMessage,
  type SerializedBlindedSignature,
} from '@cashu/cashu-ts'
import { deriveRootCtfOutcomeCollectionId } from '../../src/durableCtfRangeOperation.ts'
import {
  buildPersistedCtfRangeOrderPreparation,
  ctfRangeOrderPreparationKeysetLookup,
  type CtfRangeOrderRequest,
} from '../../src/ctfRangeOrderProtocol.ts'
import {
  createCtfRangePreparationIntent,
  createCounterCtfRangePreparation,
  reconstructCtfRangePreparation,
} from '../../src/ctfRangeOrderCounterPreparation.ts'
import { completeCtfRangeOrderAuthorization } from '../../src/ctfRangeOrderPreparation.ts'
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '../../src/durableCustody.ts'
const CONDITION_ID = 'ab'.repeat(32)
const OUTCOME_COLLECTION = 'YES'
const COMPLEMENT_COLLECTION = 'NO'
const COORDINATOR_PUBLIC_KEY = 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'
const MINT_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 1])
const KEYS = mintDenominationKeys(
  MINT_PRIVATE_KEY,
  Array.from({ length: 20 }, (_, index) => (1 << index).toString()),
)
const INPUT_FEE_PPK = 100
const FINAL_EXPIRY = 200
const MINT_URL = 'https://mint.example'
const OUTCOME_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: OUTCOME_COLLECTION,
})
const COMPLEMENT_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: COMPLEMENT_COLLECTION,
})
const REGULAR_KEYSET_ID = deriveKeysetId(KEYS, {
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  expiry: FINAL_EXPIRY,
  versionByte: 1,
})
const OUTCOME_KEYSET_ID = deriveConditionalKeysetId({
  keys: KEYS,
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  final_expiry: FINAL_EXPIRY,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_COLLECTION_ID,
})
const REVIEWED_FINAL_EXPIRY = 1_000
const REVIEWED_REGULAR_KEYSET_ID = deriveKeysetId(KEYS, {
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  expiry: REVIEWED_FINAL_EXPIRY,
  versionByte: 1,
})
const REVIEWED_OUTCOME_KEYSET_ID = deriveConditionalKeysetId({
  keys: KEYS,
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  final_expiry: REVIEWED_FINAL_EXPIRY,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_COLLECTION_ID,
})
const REVIEWED_COMPLEMENT_KEYSET_ID = deriveConditionalKeysetId({
  keys: KEYS,
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  final_expiry: REVIEWED_FINAL_EXPIRY,
  conditionId: CONDITION_ID,
  outcomeCollectionId: COMPLEMENT_COLLECTION_ID,
})

function regularKeyset() {
  return {
    canonicalMintUrl: MINT_URL,
    id: REGULAR_KEYSET_ID,
    unit: 'msat' as const,
    active: true as const,
    keys: KEYS,
    inputFeePpk: INPUT_FEE_PPK,
    finalExpiry: FINAL_EXPIRY,
  }
}

function outcomeKeyset() {
  return {
    canonicalMintUrl: MINT_URL,
    id: OUTCOME_KEYSET_ID,
    unit: 'msat' as const,
    active: true as const,
    keys: KEYS,
    inputFeePpk: INPUT_FEE_PPK,
    finalExpiry: FINAL_EXPIRY,
    registeredAt: 10,
  }
}

function expiryObservation() {
  return {
    canonicalMintUrl: MINT_URL,
    freshness: 'fresh' as const,
    observedAt: 10,
    maxExpirySeconds: 100,
    conditionKeysetIds: [OUTCOME_KEYSET_ID],
    conditionalKeysets: [
      {
        keysetId: OUTCOME_KEYSET_ID,
        conditionId: CONDITION_ID,
        unit: 'msat',
        inputFeePpk: INPUT_FEE_PPK,
        finalExpiry: FINAL_EXPIRY,
        outcomeCollection: OUTCOME_COLLECTION,
        outcomeCollectionId: OUTCOME_COLLECTION_ID,
        registeredAt: 10,
        keys: KEYS,
      },
    ],
  }
}

function rangeOrderRequest(): CtfRangeOrderRequest {
  return {
    clientOrderId: 'client-order-1',
    marketId: `${CONDITION_ID}-YES`,
    conditionId: CONDITION_ID,
    outcomeId: 'yes-id',
    tokenSide: 'Outcome',
    side: 'Buy',
    price: 2,
    maxQuotePaymentSubunits: 2,
    minQuotePaymentSubunits: null,
    amountSubunits: 1_000,
    minimumFillAmountSubunits: 1_000,
    baseAsset: 'sat',
    collateralUnit: 'msat',
    divisibility: 1_000,
    timeInForce: 'FOK',
    expiresAt: null,
    mintUrl: MINT_URL,
  }
}

function reviewedMintFacts() {
  const observation = {
    ...expiryObservation(),
    maxExpirySeconds: REVIEWED_FINAL_EXPIRY,
    conditionKeysetIds: [REVIEWED_OUTCOME_KEYSET_ID, REVIEWED_COMPLEMENT_KEYSET_ID],
    conditionalKeysets: [
      ...expiryObservation().conditionalKeysets.map((keyset) => ({
        ...keyset,
        keysetId: REVIEWED_OUTCOME_KEYSET_ID,
        finalExpiry: REVIEWED_FINAL_EXPIRY,
      })),
      {
        ...expiryObservation().conditionalKeysets[0]!,
        keysetId: REVIEWED_COMPLEMENT_KEYSET_ID,
        finalExpiry: REVIEWED_FINAL_EXPIRY,
        outcomeCollection: COMPLEMENT_COLLECTION,
        outcomeCollectionId: COMPLEMENT_COLLECTION_ID,
      },
    ],
  }
  return {
    registration: {
      normalizedMint: MINT_URL,
      conditionId: CONDITION_ID,
      canonicalParentCollectionId: null,
      unit: 'msat' as const,
      eventId: 'test-event',
      outcomes: ['YES', 'NO'],
      threshold: 1,
      oracles: [],
    },
    regular: [
      {
        ...regularKeyset(),
        id: REVIEWED_REGULAR_KEYSET_ID,
        finalExpiry: REVIEWED_FINAL_EXPIRY,
      },
    ],
    conditional: [
      {
        ...outcomeKeyset(),
        id: REVIEWED_OUTCOME_KEYSET_ID,
        finalExpiry: REVIEWED_FINAL_EXPIRY,
        conditionId: CONDITION_ID,
        outcomeCollection: OUTCOME_COLLECTION,
        outcomeCollectionId: OUTCOME_COLLECTION_ID,
        registeredAt: 10,
      },
      {
        ...outcomeKeyset(),
        id: REVIEWED_COMPLEMENT_KEYSET_ID,
        finalExpiry: REVIEWED_FINAL_EXPIRY,
        conditionId: CONDITION_ID,
        outcomeCollection: COMPLEMENT_COLLECTION,
        outcomeCollectionId: COMPLEMENT_COLLECTION_ID,
        registeredAt: 10,
      },
    ],
    maxInputs: 64,
    maxPoolEntries: 128,
    observation,
  }
}

function sequentialId(...ids: string[]): () => string {
  let index = 0
  return () => ids[index++] ?? 'unexpected-id'
}

function signOutput(output: OutputData): Proof {
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    mintDenominationPrivateKey(MINT_PRIVATE_KEY, output.blindedMessage.amount.toString()),
    output.blindedMessage.id,
  )
  const dleq = createDLEQProof(
    pointFromHex(output.blindedMessage.B_),
    mintDenominationPrivateKey(MINT_PRIVATE_KEY, output.blindedMessage.amount.toString()),
  )
  return output.toProof(
    {
      id: signature.id,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id: output.blindedMessage.id, keys: KEYS },
  )
}

function signBlindedMessage(output: SerializedBlindedMessage): SerializedBlindedSignature {
  const signature = createBlindSignature(
    pointFromHex(output.B_),
    mintDenominationPrivateKey(MINT_PRIVATE_KEY, output.amount.toString()),
    output.id,
  )
  const dleq = createDLEQProof(
    pointFromHex(output.B_),
    mintDenominationPrivateKey(MINT_PRIVATE_KEY, output.amount.toString()),
  )
  return {
    id: signature.id,
    amount: Amount.from(output.amount),
    C_: signature.C_.toHex(true),
    dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
  }
}

export function signedOwnerRangeFixture(
  options: {
    plain?: boolean
    side?: 'Buy' | 'Sell'
    seed?: Uint8Array
    id?: string
    offerStart?: number
    receiveStart?: number
  } = {},
) {
  const seed = options.seed ?? new Uint8Array(64).fill(7)
  const side = options.side ?? 'Buy'
  const id = options.id ?? 'owner-range'
  const base = buildPersistedCtfRangeOrderPreparation({
    request: {
      ...rangeOrderRequest(),
      side,
      maxQuotePaymentSubunits: side === 'Buy' ? 2 : null,
      minQuotePaymentSubunits: side === 'Sell' ? 2 : null,
    },
    coordinatorPublicKey: COORDINATOR_PUBLIC_KEY,
    mintFacts: reviewedMintFacts(),
    market: {
      outcomes: [
        { id: 'yes-id', label: 'YES' },
        { id: 'no-id', label: 'NO' },
      ],
    },
    nowUnixSeconds: 20,
    randomId: sequentialId(id, id + ':authorization'),
    authorizationLifetimeSeconds: 60,
  })
  const preparation =
    options.plain === false
      ? base
      : createCounterCtfRangePreparation({
          preparation: base,
          intent: createCtfRangePreparationIntent({
            scopeId: deriveDurableCustodyScopeId({
              scopeKind: 'wallet',
              walletId: deriveDurableCustodyWalletId(seed),
            }),
            request: base.request,
            feeConsentBytes: null,
            consolidateProofs: false,
          }).intent,
          seed,
          offerCounterStart: options.offerStart ?? 23,
          receiveCounterStart: options.receiveStart ?? 11,
        })
  const reconstructed = reconstructCtfRangePreparation(preparation, seed)
  const operation = completeCtfRangeOrderAuthorization({
    preparation: reconstructed,
    inputs: reconstructed.authorizationOutputs.map(signOutput),
    keysetLookup: ctfRangeOrderPreparationKeysetLookup(preparation),
    expiryObservation: preparation.expiryObservation,
    allowInsecureLoopbackHttp: false,
  })
  return { seed, preparation, operation, keys: KEYS, signOutput, signBlindedMessage }
}
