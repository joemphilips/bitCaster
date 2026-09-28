import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import {
  Amount,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveKeysetId,
  pointFromHex,
  type MintKeys,
  type Proof,
  type SerializedBlindedMessage,
  type SerializedBlindedSignature,
} from '@cashu/cashu-ts'
import {
  deriveDurableCustodyProofId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '@bitcaster-market/client-sdk'
import { deriveRootCtfOutcomeCollectionId } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import {
  completeCtfRangeOrderAuthorization,
  prepareCtfRangeOrderAuthorization,
} from '@bitcaster-market/client-sdk/ctfRangeOrderPreparation'
import {
  buildPersistedCtfRangeOrderPreparation,
  ctfRangeOrderPreparationKeysetLookup,
} from '@bitcaster-market/client-sdk/ctfRangeOrderProtocol'
import { encodeCtfRangeOrderPreparationArtifact } from '@bitcaster-market/client-sdk/ctfRangeOrderJournal'
import { planCtfRangeCapabilitySource } from '@bitcaster-market/client-sdk/ctfRangeCapabilitySourcePlan'
import {
  completeCtfRangeMixedSourceOperation,
  prepareCtfRangeMixedSourceOperation,
} from '@bitcaster-market/client-sdk/ctfRangeCollateralSourceOperation'
import type { DurableCustodyMintKeysetAuthority } from '@bitcaster-market/client-sdk/durableCustodyMintResult'
import {
  bindDaemonRangeMixedSourceInTransaction,
  commitDaemonCtfRangeSource,
  createDaemonRangeMixedSourceBinding,
  readDaemonRangeMixedSourceResult,
  stageDaemonRangeMixedSourceResult,
  storedSourceOutputs,
} from '../src/ctfRangeSourceState.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { withDurableCustodyUnitOfWork } from '../src/durableCustodyUnitOfWork.ts'
import { DurableCustodySqliteStore } from '../src/durableCustodySqliteStore.ts'
import { createCustodyProofSqliteRow } from '../src/custodyProofSqliteRow.ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'
import {
  emptyDaemonState,
  prepareCtfConsolidationProofOperationWithExactReservation,
  readState,
  writeState,
  type CashuProofRecord,
  type StoredProofAsset,
} from '../src/state.ts'
import { insertRangePreparation } from '../src/ctfRangeOrderJournalSqlite.ts'

const CONDITION_ID = 'ab'.repeat(32)
const OUTCOME_COLLECTION = 'YES'
const COMPLEMENT_COLLECTION = 'NO'
const COORDINATOR_PUBLIC_KEY = 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'
const MINT_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 1])
const MINT_PUBLIC_KEY = `02${'79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'}`
const MINT_URL = 'https://mint.example'
const WALLET_SEED_HEX = '11'.repeat(64)
const INPUT_FEE_PPK = 100
const FINAL_EXPIRY = 1_000
const KEYS = Object.fromEntries(
  Array.from({ length: 20 }, (_, index) => [(1 << index).toString(), MINT_PUBLIC_KEY]),
)
const OFFER_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
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
const OFFER_KEYSET_ID = deriveConditionalKeysetId({
  keys: KEYS,
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  final_expiry: FINAL_EXPIRY,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OFFER_COLLECTION_ID,
})
const COMPLEMENT_KEYSET_ID = deriveConditionalKeysetId({
  keys: KEYS,
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  final_expiry: FINAL_EXPIRY,
  conditionId: CONDITION_ID,
  outcomeCollectionId: COMPLEMENT_COLLECTION_ID,
})
const SEED = new Uint8Array(64).fill(7)

test('mixed range source commits and replays canonical authorization without legacy projection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-range-mixed-source-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  try {
    const bootstrapped = await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: MINT_URL,
      walletSeedHex: WALLET_SEED_HEX,
      nostrSecretKeyHex: '22'.repeat(32),
      initializedAtMs: 1,
    })
    const scopeId = bootstrapped.walletScopeId
    const fence = await claimCustodyScopeLease(directory, {
      scopeId,
      incarnationId: 'mixed-source-adapter-test',
      observedAtMs: 10,
    })
    const preparation = persistedPreparation()
    const preparedAuthorization = prepareCtfRangeOrderAuthorization(authorizationInput(preparation))
    const authorizationAmounts = preparedAuthorization.authorizationOutputs.map((output) =>
      output.blindedMessage.amount.toString(),
    )
    const offeredProof = signedProof(8_192, preparation.offerKeyset)
    const collateralProof = signedProof(64, preparation.receiveKeyset)
    const plan = planCtfRangeCapabilitySource({
      side: 'Sell',
      authorizationAmounts,
      offeredKeyset: preparation.offerKeyset,
      collateralKeyset: preparation.receiveKeyset,
      complementKeyset: preparation.complementKeyset,
      offeredCandidates: [offeredProof],
      collateralCandidates: [collateralProof],
      maxInputs: preparation.maxInputs,
      maxOutputs: 256,
    })
    assert.equal(plan.kind, 'mixed-source-ctf-convert')
    if (plan.kind !== 'mixed-source-ctf-convert') return
    const sourceOperation = await prepareCtfRangeMixedSourceOperation({
      preparation,
      seed: SEED,
      counterSource: testCounterSource(),
      plan,
    })
    const outerOperation = completeCtfRangeOrderAuthorization({
      preparation: preparedAuthorization,
      inputs: preparedAuthorization.authorizationOutputs.map(signOutput),
      keysetLookup: ctfRangeOrderPreparationKeysetLookup(preparation),
      expiryObservation: preparation.expiryObservation,
      allowInsecureLoopbackHttp: false,
    })

    await writeAvailableProofs([offeredProof, collateralProof])
    const conditionalAsset = outcomeAsset()
    const collateralAsset = regularAsset()
    const keysets = mixedKeysetAuthorities(preparation)
    const targetReservationId = 'range-source-reservation'
    const custodyReservationId = targetReservationId
    const binding = createDaemonRangeMixedSourceBinding({
      scope: {
        scopeKind: 'wallet',
        walletId: scopeId.slice('custody:wallet:'.length),
        scopeId,
      },
      operation: sourceOperation,
      preparation,
      keysets,
      reservationId: custodyReservationId,
    })
    const targetOperation = {
      operationId: preparation.sourceOperationId,
      kind: 'conditional-keyset-swap' as const,
      mintUrl: preparation.mintUrl,
      inputs: sourceOperation.inputs.map(toCashuProofRecord),
      outputs: storedSourceOutputs(sourceOperation),
      metadata: {
        purpose: 'ctf-range-authorization-source',
        sourceMode: 'mixed-source-ctf-convert',
        endpoint: 'POST /v1/ctf/convert',
        rangeOperationId: preparation.operationId,
        unit: 'msat',
        reservationId: targetReservationId,
        custodySourceOperationId: binding.record.operation.operationId,
        exactSourceOperation: sourceOperation,
      },
    }
    await withDurableCustodyUnitOfWork(directory, fence, 11, (database) => {
      seedCanonicalInputs(database, scopeId, [offeredProof, collateralProof], 11)
      insertRangePreparation(database, {
        scopeId,
        rangeOperationId: preparation.operationId,
        sourceOperationId: preparation.sourceOperationId,
        authorizationId: preparation.authorizationId,
        clientOrderId: preparation.request.clientOrderId,
        orderRouteId: preparation.request.marketId,
        normalizedMint: preparation.mintUrl,
        conditionId: preparation.conditionId,
        unit: 'msat',
        tokenSide: preparation.request.tokenSide,
        side: preparation.side,
        priceSubunits: preparation.priceNumerator,
        amountSubunits: preparation.amountSubunits,
        minimumFillAmountSubunits: preparation.request.minimumFillAmountSubunits,
        consolidateProofs: false,
        divisibility: preparation.divisibility,
        authorizationExpiresAtUnixSeconds: preparation.expiry,
        preparationBytes: encodeCtfRangeOrderPreparationArtifact(preparation),
        createdAtMs: 11,
      })
    })
    await prepareCtfConsolidationProofOperationWithExactReservation(
      {
        ...targetOperation,
        reservationId: targetReservationId,
        inputAssets: [conditionalAsset, collateralAsset],
      },
      { fence, observedAtMs: 12 },
      (database) => bindDaemonRangeMixedSourceInTransaction(database, binding, fence, 12),
    )

    const completed = await completeCtfRangeMixedSourceOperation({
      operation: sourceOperation,
      preparation,
      seed: SEED,
      transport: {
        postConvert: async (request) => ({
          signatures: Object.fromEntries(
            Object.entries(request.outputs).map(([collection, outputs]) => [
              collection,
              outputs.map(signBlindedMessage),
            ]),
          ),
        }),
      },
    })
    await withDurableCustodyUnitOfWork(directory, fence, 13, (database) => {
      stageDaemonRangeMixedSourceResult(
        database,
        binding.record.operation.operationId,
        completed,
        fence,
        13,
      )
    })

    const commit = () =>
      withDurableCustodyUnitOfWork(directory, fence, 14, (database) =>
        commitDaemonCtfRangeSource(database, outerOperation, 14, fence),
      )
    const beforeRejectedCommit = await mixedCustodySnapshot({
      directory,
      scopeId,
      custodyOperationId: binding.record.operation.operationId,
      targetReservationId,
      result: completed,
      inputs: [offeredProof, collateralProof],
    })
    const mismatchedOuterOperation = {
      ...outerOperation,
      inputs: outerOperation.inputs.map((proof, index) =>
        index === 0 ? { ...proof, secret: `${proof.secret}-substituted` } : proof,
      ),
    }
    await assert.rejects(
      withDurableCustodyUnitOfWork(directory, fence, 14, (database) =>
        commitDaemonCtfRangeSource(database, mismatchedOuterOperation, 14, fence),
      ),
      /daemon CTF range source authorization result is foreign/,
    )
    assert.deepEqual(
      await mixedCustodySnapshot({
        directory,
        scopeId,
        custodyOperationId: binding.record.operation.operationId,
        targetReservationId,
        result: completed,
        inputs: [offeredProof, collateralProof],
      }),
      beforeRejectedCommit,
    )
    const first = await commit()
    assert.equal(isDeepStrictEqual(first.authorization, completed.authorization), true)
    const firstState = await readState()
    const firstTarget = firstState?.proofOperations[preparation.sourceOperationId]
    assert.equal(firstTarget?.state, 'completed')
    assert.deepEqual(Object.keys(firstTarget?.resultProofs ?? {}).sort(), [
      'collateral-change',
      'offered-change',
    ])
    assert.equal(firstTarget?.resultProofs?.authorization, undefined)

    const snapshot = await mixedCustodySnapshot({
      directory,
      scopeId,
      custodyOperationId: binding.record.operation.operationId,
      targetReservationId,
      result: completed,
      inputs: [offeredProof, collateralProof],
    })
    assert.deepEqual(snapshot.targetReservationCounts, { offered: 0, collateral: 0 })
    assert.equal(snapshot.targetInputCount, 0)
    assert.equal(snapshot.canonicalReservationCount, 0)
    assert.equal(snapshot.targetAuthorizationCount, 0)
    assert.equal(snapshot.targetOfferedChangeCount, completed.offeredChange.length)
    assert.equal(snapshot.targetCollateralChangeCount, completed.collateralChange.length)
    assert.equal(snapshot.canonicalAuthorizationCount, completed.authorization.length)
    assert.equal(snapshot.canonicalOfferedChangeCount, completed.offeredChange.length)
    assert.equal(snapshot.canonicalCollateralChangeCount, completed.collateralChange.length)
    assert.deepEqual(
      await readMixedCanonicalAssets(
        await openDaemonStateSqlite(directory),
        scopeId,
        MINT_URL,
        completed,
      ),
      {
        authorization: { conditionId: CONDITION_ID, outcomeSetId: OUTCOME_COLLECTION },
        offeredChange: { conditionId: CONDITION_ID, outcomeSetId: OUTCOME_COLLECTION },
        collateralChange: { conditionId: null, outcomeSetId: null },
      },
    )

    // A target change can disappear after use. Replay must not recreate it.
    const spentChange = completed.offeredChange[0]
    assert.ok(spentChange)
    await withDurableCustodyUnitOfWork(directory, fence, 15, (database) => {
      const removed = database
        .prepare(
          `DELETE FROM target_wallet_proofs
           WHERE scope_id = ? AND normalized_mint = ? AND secret = ?`,
        )
        .run(scopeId, MINT_URL, spentChange.secret)
      assert.equal(removed.changes, 1)
    })
    const afterSpend = await mixedCustodySnapshot({
      directory,
      scopeId,
      custodyOperationId: binding.record.operation.operationId,
      targetReservationId,
      result: completed,
      inputs: [offeredProof, collateralProof],
    })
    assert.equal(afterSpend.targetOfferedChangeCount, completed.offeredChange.length - 1)

    // Re-open the profile to model recovery after restart. The helper must not
    // reinsert inputs or the spent target change.
    const replay = await withDurableCustodyUnitOfWork(directory, fence, 16, (database) =>
      commitDaemonCtfRangeSource(database, outerOperation, 16, fence),
    )
    assert.equal(isDeepStrictEqual(replay.authorization, completed.authorization), true)
    assert.deepEqual(
      await mixedCustodySnapshot({
        directory,
        scopeId,
        custodyOperationId: binding.record.operation.operationId,
        targetReservationId,
        result: completed,
        inputs: [offeredProof, collateralProof],
      }),
      afterSpend,
    )
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
})

function persistedPreparation() {
  const request = {
    clientOrderId: 'mixed-source-order',
    marketId: `${CONDITION_ID}-YES`,
    conditionId: CONDITION_ID,
    outcomeId: 'yes',
    tokenSide: 'Outcome' as const,
    side: 'Sell' as const,
    price: 2,
    amountSubunits: 1_000,
    minimumFillAmountSubunits: 1_000,
    baseAsset: 'sat' as const,
    collateralUnit: 'msat' as const,
    divisibility: 1_000,
    timeInForce: 'FOK' as const,
    expiresAt: null,
    mintUrl: MINT_URL,
  }
  const observation = {
    canonicalMintUrl: MINT_URL,
    freshness: 'fresh' as const,
    observedAt: 10,
    maxExpirySeconds: FINAL_EXPIRY,
    conditionKeysetIds: [OFFER_KEYSET_ID, COMPLEMENT_KEYSET_ID],
    conditionalKeysets: [
      {
        keysetId: OFFER_KEYSET_ID,
        conditionId: CONDITION_ID,
        unit: 'msat',
        inputFeePpk: INPUT_FEE_PPK,
        finalExpiry: FINAL_EXPIRY,
        outcomeCollection: OUTCOME_COLLECTION,
        outcomeCollectionId: OFFER_COLLECTION_ID,
        registeredAt: 10,
        keys: KEYS,
      },
      {
        keysetId: COMPLEMENT_KEYSET_ID,
        conditionId: CONDITION_ID,
        unit: 'msat',
        inputFeePpk: INPUT_FEE_PPK,
        finalExpiry: FINAL_EXPIRY,
        outcomeCollection: COMPLEMENT_COLLECTION,
        outcomeCollectionId: COMPLEMENT_COLLECTION_ID,
        registeredAt: 10,
        keys: KEYS,
      },
    ],
  }
  let idIndex = 0
  const ids = ['mixed-range-operation', 'mixed-source-operation', 'mixed-authorization']
  return buildPersistedCtfRangeOrderPreparation({
    request,
    coordinatorPublicKey: COORDINATOR_PUBLIC_KEY,
    mintFacts: {
      regular: [
        {
          canonicalMintUrl: MINT_URL,
          id: REGULAR_KEYSET_ID,
          unit: 'msat' as const,
          active: true as const,
          keys: KEYS,
          inputFeePpk: INPUT_FEE_PPK,
          finalExpiry: FINAL_EXPIRY,
        },
      ],
      conditional: [
        {
          canonicalMintUrl: MINT_URL,
          id: OFFER_KEYSET_ID,
          unit: 'msat' as const,
          active: true as const,
          keys: KEYS,
          inputFeePpk: INPUT_FEE_PPK,
          finalExpiry: FINAL_EXPIRY,
          conditionId: CONDITION_ID,
          outcomeCollection: OUTCOME_COLLECTION,
          outcomeCollectionId: OFFER_COLLECTION_ID,
          registeredAt: 10,
        },
        {
          canonicalMintUrl: MINT_URL,
          id: COMPLEMENT_KEYSET_ID,
          unit: 'msat' as const,
          active: true as const,
          keys: KEYS,
          inputFeePpk: INPUT_FEE_PPK,
          finalExpiry: FINAL_EXPIRY,
          conditionId: CONDITION_ID,
          outcomeCollection: COMPLEMENT_COLLECTION,
          outcomeCollectionId: COMPLEMENT_COLLECTION_ID,
          registeredAt: 10,
        },
      ],
      maxInputs: 64,
      maxPoolEntries: 128,
      observation,
    },
    market: {
      outcomes: [
        { id: 'yes', label: 'YES' },
        { id: 'no', label: 'NO' },
      ],
    },
    nowUnixSeconds: 20,
    randomId: () => ids[idIndex++]!,
  })
}

function authorizationInput(preparation: ReturnType<typeof persistedPreparation>) {
  const {
    version: _version,
    request: _request,
    complementKeyset: _complementKeyset,
    ...input
  } = preparation
  return { seed: SEED, ...input }
}

function testCounterSource() {
  let next = 0
  return {
    reserve: async (_keysetId: string, count: number) => {
      const range = { start: next, count }
      next += count
      return range
    },
    advanceToAtLeast: async (_keysetId: string, minNext: number) => {
      next = Math.max(next, minNext)
    },
  }
}

function signedProof(
  amount: number,
  keyset: ReturnType<typeof persistedPreparation>['offerKeyset'],
): Proof {
  const output = OutputData.createRandomData(Amount.from(amount), mintKeys(keyset))[0]!
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    MINT_PRIVATE_KEY,
    output.blindedMessage.id,
  )
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), MINT_PRIVATE_KEY)
  return output.toProof(
    {
      id: signature.id,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
      dleq: { e: hex(dleq.e), s: hex(dleq.s) },
    },
    { id: keyset.id, keys: keyset.keys },
  )
}

function signOutput(output: OutputData): Proof {
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    MINT_PRIVATE_KEY,
    output.blindedMessage.id,
  )
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), MINT_PRIVATE_KEY)
  return output.toProof(
    {
      id: signature.id,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
      dleq: { e: hex(dleq.e), s: hex(dleq.s) },
    },
    { id: output.blindedMessage.id, keys: KEYS },
  )
}

function signBlindedMessage(output: SerializedBlindedMessage): SerializedBlindedSignature {
  const signature = createBlindSignature(pointFromHex(output.B_), MINT_PRIVATE_KEY, output.id)
  const dleq = createDLEQProof(pointFromHex(output.B_), MINT_PRIVATE_KEY)
  return {
    id: signature.id,
    amount: Amount.from(output.amount),
    C_: signature.C_.toHex(true),
    dleq: { e: hex(dleq.e), s: hex(dleq.s) },
  }
}

function mintKeys(keyset: ReturnType<typeof persistedPreparation>['offerKeyset']): MintKeys {
  return {
    id: keyset.id,
    unit: 'msat',
    keys: keyset.keys,
    input_fee_ppk: keyset.inputFeePpk,
    final_expiry: keyset.finalExpiry,
  }
}

function mixedKeysetAuthorities(
  preparation: ReturnType<typeof persistedPreparation>,
): DurableCustodyMintKeysetAuthority[] {
  return [
    {
      canonicalMintUrl: MINT_URL,
      id: preparation.offerKeyset.id,
      unit: 'msat',
      keys: KEYS,
      inputFeePpk: INPUT_FEE_PPK,
      finalExpiry: FINAL_EXPIRY,
      identity: {
        kind: 'conditional',
        conditionId: CONDITION_ID,
        outcomeCollection: OUTCOME_COLLECTION,
        outcomeCollectionId: OFFER_COLLECTION_ID,
      },
    },
    {
      canonicalMintUrl: MINT_URL,
      id: preparation.receiveKeyset.id,
      unit: 'msat',
      keys: KEYS,
      inputFeePpk: INPUT_FEE_PPK,
      finalExpiry: FINAL_EXPIRY,
      identity: { kind: 'regular' },
    },
  ]
}

async function writeAvailableProofs(proofs: readonly Proof[]): Promise<void> {
  const state = emptyDaemonState()
  state.wallet.proofs = proofs.map((proof) => ({
    proof,
    mintUrl: MINT_URL,
    state: 'available',
    asset: proof.id === OFFER_KEYSET_ID ? outcomeAsset() : regularAsset(),
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(1).toISOString(),
  }))
  await writeState(state)
}

function seedCanonicalInputs(
  database: DatabaseSync,
  scopeId: string,
  proofs: readonly Proof[],
  nowMs: number,
): void {
  const store = new DurableCustodySqliteStore(database)
  for (const proof of proofs) {
    const outcome = proof.id === OFFER_KEYSET_ID
    const row = createCustodyProofSqliteRow({
      scopeId,
      normalizedMint: MINT_URL,
      unit: 'msat',
      proof: {
        ...proof,
        dleq: proof.dleq ?? null,
        witness: proof.witness ?? null,
        p2pkE: proof.p2pk_e ?? null,
      },
      baseAsset: 'sat',
      conditionId: outcome ? CONDITION_ID : null,
      outcomeSetId: outcome ? OUTCOME_COLLECTION : null,
      productBinding: null,
      signatureVerified: true,
      dleqState: proof.dleq == null ? 'not-present' : 'verified',
      nut07State: 'UNSPENT',
      selectability: 'retained',
      storageClass: 'terminal-replay-retained',
      reservationOperationId: null,
      revision: 0,
      nowMs,
    })
    store.putProofCas(row, null)
  }
}

function toCashuProofRecord(proof: Proof): CashuProofRecord {
  return {
    id: proof.id,
    amount: Number(proof.amount),
    secret: proof.secret,
    C: proof.C,
    ...(proof.dleq === undefined ? {} : { dleq: structuredClone(proof.dleq) }),
    ...(proof.witness === undefined ? {} : { witness: structuredClone(proof.witness) }),
    ...(proof.p2pk_e === undefined ? {} : { p2pk_e: proof.p2pk_e }),
  }
}

function outcomeAsset(): StoredProofAsset {
  return {
    kind: 'Outcome',
    conditionId: CONDITION_ID,
    outcomeSetId: OUTCOME_COLLECTION,
    baseAsset: 'sat',
    unit: 'msat',
  }
}

function regularAsset(): StoredProofAsset {
  return { kind: 'sats', baseAsset: 'sat', unit: 'msat' }
}

async function mixedCustodySnapshot(input: {
  readonly directory: string
  readonly scopeId: string
  readonly custodyOperationId: string
  readonly targetReservationId: string
  readonly result: Awaited<ReturnType<typeof completeCtfRangeMixedSourceOperation>>
  readonly inputs: readonly Proof[]
}) {
  const database = await openDaemonStateSqlite(input.directory)
  try {
    const offeredReservations = database
      .prepare(
        `SELECT count(*) AS count FROM target_wallet_proofs
         WHERE state = 'reserved' AND reserved_by = ? AND asset_kind = 'outcome'`,
      )
      .get(input.targetReservationId) as { count: number }
    const collateralReservations = database
      .prepare(
        `SELECT count(*) AS count FROM target_wallet_proofs
         WHERE state = 'reserved' AND reserved_by = ? AND asset_kind = 'sats'`,
      )
      .get(input.targetReservationId) as { count: number }
    const canonicalReservations = database
      .prepare(
        `SELECT count(*) AS count FROM custody_proof_reservations
         WHERE operation_id = ?`,
      )
      .get(input.custodyOperationId) as { count: number }
    const targetInputs = database
      .prepare(
        `SELECT count(*) AS count FROM target_wallet_proofs
         WHERE scope_id = ? AND normalized_mint = ?
           AND secret IN (?, ?)`,
      )
      .get(input.scopeId, MINT_URL, ...input.inputs.map(({ secret }) => secret)) as {
      count: number
    }
    const targetCountFor = (proofs: readonly Proof[]) =>
      proofs.reduce((count, proof) => {
        const row = database
          .prepare(
            `SELECT count(*) AS count FROM target_wallet_proofs
             WHERE scope_id = ? AND normalized_mint = ? AND secret = ?`,
          )
          .get(input.scopeId, MINT_URL, proof.secret) as { count: number }
        return count + row.count
      }, 0)
    const custody = new DurableCustodySqliteStore(database)
    const result = readDaemonRangeMixedSourceResult(
      database,
      input.custodyOperationId,
      input.scopeId,
    )
    assert.ok(result)
    const canonicalCountFor = (proofs: readonly Proof[]) =>
      proofs.reduce((count, proof) => {
        const id = deriveDurableCustodyProofId({
          scopeId: input.scopeId,
          normalizedMint: MINT_URL,
          unit: 'msat',
          keysetId: proof.id!,
          secret: proof.secret,
        })
        return count + Number(custody.getProof(input.scopeId, id) !== null)
      }, 0)
    return {
      targetReservationCounts: {
        offered: offeredReservations.count,
        collateral: collateralReservations.count,
      },
      targetInputCount: targetInputs.count,
      canonicalReservationCount: canonicalReservations.count,
      targetAuthorizationCount: targetCountFor(input.result.authorization),
      targetOfferedChangeCount: targetCountFor(input.result.offeredChange),
      targetCollateralChangeCount: targetCountFor(input.result.collateralChange),
      canonicalAuthorizationCount: canonicalCountFor(result.authorization),
      canonicalOfferedChangeCount: canonicalCountFor(result.offeredChange),
      canonicalCollateralChangeCount: canonicalCountFor(result.collateralChange),
    }
  } finally {
    database.close()
  }
}

function readMixedCanonicalAssets(
  database: DatabaseSync,
  scopeId: string,
  mintUrl: string,
  result: Awaited<ReturnType<typeof completeCtfRangeMixedSourceOperation>>,
) {
  try {
    const store = new DurableCustodySqliteStore(database)
    const assetFor = (proof: Proof) => {
      const proofId = deriveDurableCustodyProofId({
        scopeId,
        normalizedMint: mintUrl,
        unit: 'msat',
        keysetId: proof.id!,
        secret: proof.secret,
      })
      const row = store.getProof(scopeId, proofId)
      assert.ok(row)
      return { conditionId: row.conditionId, outcomeSetId: row.outcomeSetId }
    }
    return {
      authorization: assetFor(result.authorization[0]!),
      offeredChange: assetFor(result.offeredChange[0]!),
      collateralChange: assetFor(result.collateralChange[0]!),
    }
  } finally {
    database.close()
  }
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}
