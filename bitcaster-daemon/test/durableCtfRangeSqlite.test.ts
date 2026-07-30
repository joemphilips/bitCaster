import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import {
  OutputData,
  createBlindSignature,
  createCtfAuthorizationOutputs,
  createCtfRangeManifest,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveCtfRangeRefundKey,
  deriveKeysetId,
  pointFromHex,
  type Proof,
} from '@cashu/cashu-ts'
import {
  createDurableCtfRangeCustodyBinding,
  createDurableCtfRangeOperation,
  deriveRootCtfOutcomeCollectionId,
  toDurableCtfRangeProofOperationInput,
  type DurableCtfRangeMintKeyset,
  type DurableCtfRangeOperation,
} from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import {
  applyDurableCustodyTransaction,
  resolveDurableCustodyProofOperationFacts,
  type DurableCustodyScope,
} from '@bitcaster-market/client-sdk'
import { bindDurableCustodyProofOperation } from '@bitcaster-market/client-sdk/durableCustodyProofOperationRecord'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { withDurableCustodyUnitOfWork } from '../src/durableCustodyUnitOfWork.ts'
import { DurableCustodySqliteStore } from '../src/durableCustodySqliteStore.ts'
import { createCustodyProofSqliteRow } from '../src/custodyProofSqliteRow.ts'
import { DurableCustodyTransactionSqlite } from '../src/durableCustodyTransactionSqlite.ts'
import { loadDaemonDurableCtfRangeAuthority } from '../src/durableCtfRangeSqlite.ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'

const CONDITION_ID = 'ab'.repeat(32)
const ROOT_PARENT = '0'.repeat(64)
const OUTCOME_COLLECTION = 'YES'
const INPUT_FEE_PPK = 100
const FINAL_EXPIRY = 200
const COORDINATOR_PUBLIC_KEY = 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'
const MINT_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 1])
const MINT_PUBLIC_KEY = `02${'79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'}`
const MINT_KEYS = { '1': MINT_PUBLIC_KEY, '2': MINT_PUBLIC_KEY, '4': MINT_PUBLIC_KEY }
const OUTCOME_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: OUTCOME_COLLECTION,
})
const OFFER_KEYSET_ID = deriveKeysetId(MINT_KEYS, {
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  expiry: FINAL_EXPIRY,
  versionByte: 1,
})
const RECEIVE_KEYSET_ID = deriveConditionalKeysetId({
  keys: MINT_KEYS,
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  final_expiry: FINAL_EXPIRY,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_COLLECTION_ID,
})

test('range authority survives restart and injected rollback exposes no partial link', async () => {
  const fixture = await createProfile()
  try {
    const scope = walletScope(fixture.walletScopeId)
    const operation = createRangeOperation()
    const binding = await createRangeBinding(scope, operation)
    const proofIds = binding.record.operation.reservation.inputs.map(({ proofId }) => proofId)
    const fence = await claimCustodyScopeLease(fixture.directory, {
      scopeId: fixture.walletScopeId,
      incarnationId: 'range-authority-test',
      observedAtMs: 2,
    })

    await withDurableCustodyUnitOfWork(fixture.directory, fence, 3, (database) => {
      const store = new DurableCustodySqliteStore(database)
      proofIds.forEach((proofId, index) =>
        store.putProofCas(
          proofRow(fixture.walletScopeId, operation, operation.inputs[index]!, proofId),
          null,
        ),
      )
    })
    await assert.rejects(
      () =>
        persistRangeBinding(fixture.directory, fence, 4, binding, (phase) => {
          if (phase === 'before-commit') throw new Error('injected range authority rollback')
        }),
      /injected range authority rollback/,
    )

    await assertRolledBack(fixture.directory, fixture.walletScopeId, proofIds)
    await assert.rejects(
      () =>
        persistRangeBinding(fixture.directory, fence, 5, binding, (phase) => {
          if (phase === 'after-commit') throw new Error('injected post-commit restart')
        }),
      /injected post-commit restart/,
    )

    const database = await openDaemonStateSqlite(fixture.directory)
    try {
      const store = new DurableCustodySqliteStore(database)
      const custodyOperationId = binding.record.operation.operationId
      const restored = loadDaemonDurableCtfRangeAuthority(store, custodyOperationId)
      assert.ok(restored)
      assert.equal(
        isDeepStrictEqual(restored.operation, operation),
        true,
        'restarted range operation must equal the exact persisted authority',
      )
      assert.equal(
        isDeepStrictEqual(
          restored.record.operation.reservation.inputs,
          binding.record.operation.reservation.inputs,
        ),
        true,
        'restarted operation must retain its exact ordered proof link',
      )
      for (const proofId of proofIds) {
        assert.equal(store.getProof(fixture.walletScopeId, proofId)?.selectability, 'locked')
        assert.equal(
          store.getProof(fixture.walletScopeId, proofId)?.reservationOperationId,
          custodyOperationId,
        )
      }
      assert.equal(
        (
          database
            .prepare(
              `SELECT count(*) AS count FROM custody_proof_reservations
               WHERE scope_id = ? AND operation_id = ?`,
            )
            .get(fixture.walletScopeId, custodyOperationId) as { count: number }
        ).count,
        2,
      )
      assert.equal(
        (database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys,
        1,
      )
      assert.equal(
        (database.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
        'wal',
      )
      assert.equal(
        (database.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous,
        2,
      )
      database
        .prepare(
          `UPDATE custody_proofs SET curve = 'bls12-381', dleq_state = 'not-present'
           WHERE scope_id = ? AND proof_id = ?`,
        )
        .run(fixture.walletScopeId, proofIds[0]!)
      assert.throws(() => loadDaemonDurableCtfRangeAuthority(store, custodyOperationId), /curve/)
      database
        .prepare(
          `UPDATE custody_proofs SET
             curve = 'secp256k1', dleq_state = 'verified', amount = amount + 1
           WHERE scope_id = ? AND proof_id = ?`,
        )
        .run(fixture.walletScopeId, proofIds[0]!)
      assert.throws(
        () => loadDaemonDurableCtfRangeAuthority(store, custodyOperationId),
        /proof material authority|persisted proof authority/,
      )
    } finally {
      database.close()
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

async function createProfile() {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-range-sqlite-'))
  const bootstrapped = await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: 'https://mint.example',
    walletSeedHex: '11'.repeat(32),
    nostrSecretKeyHex: '22'.repeat(32),
    initializedAtMs: 1,
  })
  return { directory, ...bootstrapped }
}

function walletScope(scopeId: string): DurableCustodyScope {
  return {
    scopeKind: 'wallet',
    walletId: scopeId.slice('custody:wallet:'.length),
    scopeId,
  }
}

function createRangeOperation(): DurableCtfRangeOperation {
  const seed = new Uint8Array(64).fill(7)
  const operationId = 'daemon-range-operation-1'
  const manifest = createCtfRangeManifest({
    seed,
    operationId,
    receiveKeyset: { id: RECEIVE_KEYSET_ID, active: true, keys: MINT_KEYS },
    offerKeyset: { id: OFFER_KEYSET_ID, active: true, keys: MINT_KEYS },
    maxReceive: '3',
    maxChange: '3',
    maxEntries: 4,
  })
  const refundKey = deriveCtfRangeRefundKey(seed, operationId)
  const inputs = createCtfAuthorizationOutputs({
    seed,
    operationId,
    offerKeysetId: OFFER_KEYSET_ID,
    amounts: ['2', '2'],
    commitment: manifest.commitment,
    expiry: 100,
    expiryContext: expiryContext(),
    refund: refundKey.publicKey,
    coordinatorPublicKey: COORDINATOR_PUBLIC_KEY,
    poolPolicy: { rateN: '1', rateD: '1', minReceive: '1', maxDebit: '4' },
  }).map(signOutput)
  return createDurableCtfRangeOperation({
    operationId,
    sourceOperationId: 'daemon-range-prepare-1',
    authorizationId: 'daemon-range-authorization-1',
    mintUrl: 'https://mint.example',
    unit: 'msat',
    conditionId: CONDITION_ID,
    parentCollectionId: ROOT_PARENT,
    coordinatorPublicKey: COORDINATOR_PUBLIC_KEY,
    offerKeysetId: OFFER_KEYSET_ID,
    receiveKeysetId: RECEIVE_KEYSET_ID,
    keysetLookup: keysetLookup(),
    expiryObservation: expiryObservation(),
    expiry: 100,
    policy: { rateN: '1', rateD: '1', minReceive: '1', maxDebit: '4' },
    refundKey,
    inputFeePpkByKeyset: { [OFFER_KEYSET_ID]: INPUT_FEE_PPK },
    inputs,
    manifest,
  })
}

function expiryContext() {
  return {
    now: 10,
    maxExpirySeconds: 100,
    condition: { condition_id: CONDITION_ID, keysets: { YES: RECEIVE_KEYSET_ID } },
    conditionalKeysets: [
      { id: RECEIVE_KEYSET_ID, condition_id: CONDITION_ID, final_expiry: FINAL_EXPIRY },
    ],
  }
}

function expiryObservation() {
  return {
    canonicalMintUrl: 'https://mint.example',
    freshness: 'fresh' as const,
    observedAt: 10,
    maxExpirySeconds: 100,
    conditionKeysetIds: [RECEIVE_KEYSET_ID],
    conditionalKeysets: [
      {
        keysetId: RECEIVE_KEYSET_ID,
        conditionId: CONDITION_ID,
        unit: 'msat',
        inputFeePpk: INPUT_FEE_PPK,
        finalExpiry: FINAL_EXPIRY,
        outcomeCollectionId: OUTCOME_COLLECTION_ID,
        keys: MINT_KEYS,
      },
    ],
  }
}

function keysetLookup() {
  return {
    canonicalMintUrl: 'https://mint.example',
    freshness: 'fresh' as const,
    regularKeysets: [
      {
        keysetId: OFFER_KEYSET_ID,
        unit: 'msat',
        active: true,
        inputFeePpk: INPUT_FEE_PPK,
        finalExpiry: FINAL_EXPIRY,
      },
    ],
    conditionalKeysets: [
      {
        keysetId: RECEIVE_KEYSET_ID,
        unit: 'msat',
        active: true,
        conditionId: CONDITION_ID,
        outcomeCollection: OUTCOME_COLLECTION,
        outcomeCollectionId: OUTCOME_COLLECTION_ID,
        inputFeePpk: INPUT_FEE_PPK,
        finalExpiry: FINAL_EXPIRY,
      },
    ],
  }
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
      dleq: {
        e: Buffer.from(dleq.e).toString('hex'),
        s: Buffer.from(dleq.s).toString('hex'),
      },
    },
    { id: output.blindedMessage.id, keys: MINT_KEYS },
  )
}

function mintKeysets(operation: DurableCtfRangeOperation) {
  return new Map<string, DurableCtfRangeMintKeyset>(
    [operation.keysetAuthority.offer, operation.keysetAuthority.receive].map((authority) => [
      authority.keysetId,
      {
        canonicalMintUrl: operation.mintUrl,
        id: authority.keysetId,
        unit: authority.unit,
        keys: MINT_KEYS,
        inputFeePpk: authority.inputFeePpk,
        finalExpiry: authority.finalExpiry,
      },
    ]),
  )
}

async function createRangeBinding(scope: DurableCustodyScope, operation: DurableCtfRangeOperation) {
  const keysets = mintKeysets(operation)
  const facts = await resolveDurableCustodyProofOperationFacts({
    operation: toDurableCtfRangeProofOperationInput(operation),
    resolveMintKeys: async () =>
      new Map(
        [...keysets].map(([id, keyset]) => [
          id,
          {
            id,
            unit: keyset.unit,
            keys: keyset.keys,
            final_expiry: keyset.finalExpiry ?? undefined,
          },
        ]),
      ),
    requireDleq: true,
  })
  return createDurableCtfRangeCustodyBinding({
    scope,
    operation,
    facts,
    mintKeysets: keysets,
    inventoryAccountId: null,
    boundary: {
      method: 'POST',
      path: '/v1/range-authorizations',
      idempotencyKey: operation.authorizationId,
      requestBody: { authorizationId: operation.authorizationId },
    },
  })
}

function proofRow(
  scopeId: string,
  operation: DurableCtfRangeOperation,
  proof: DurableCtfRangeOperation['inputs'][number],
  proofId: string,
) {
  const row = createCustodyProofSqliteRow({
    scopeId,
    normalizedMint: operation.mintUrl,
    unit: operation.unit,
    proof,
    baseAsset: 'sat',
    conditionId: null,
    outcomeSetId: null,
    productBinding: null,
    signatureVerified: true,
    dleqState: proof.dleq === null ? 'not-present' : 'verified',
    nut07State: 'UNSPENT',
    selectability: 'selectable',
    storageClass: 'pinned-operation-bound-deterministic',
    reservationOperationId: null,
    revision: 0,
    nowMs: 3,
  })
  assert.equal(row.proofId, proofId)
  return row
}

async function persistRangeBinding(
  directory: string,
  fence: Awaited<ReturnType<typeof claimCustodyScopeLease>>,
  observedAtMs: number,
  binding: Awaited<ReturnType<typeof createRangeBinding>>,
  injectFault?: (phase: 'transaction-opened' | 'before-commit' | 'after-commit') => void,
): Promise<void> {
  await withDurableCustodyUnitOfWork(
    directory,
    fence,
    observedAtMs,
    (database) => {
      const transaction = new DurableCustodyTransactionSqlite(
        database,
        binding.record.scope.scopeId,
        observedAtMs,
      )
      applyDurableCustodyTransaction(
        transaction,
        {
          scope: binding.record.scope,
          owner: {
            incarnationId: fence.incarnationId,
            fencingEpoch: fence.fencingEpoch,
            observedAtMs,
          },
          operationRows: [
            { operationId: binding.record.operation.operationId, expectedRevision: null },
          ],
        },
        (selected) => bindDurableCustodyProofOperation(selected, binding.record, binding.artifacts),
      )
    },
    { injectFault },
  )
}

async function assertRolledBack(
  directory: string,
  scopeId: string,
  proofIds: readonly string[],
): Promise<void> {
  const database = await openDaemonStateSqlite(directory)
  try {
    for (const table of [
      'custody_operations',
      'custody_artifacts',
      'custody_operation_inputs',
      'custody_proof_reservations',
      'custody_active_work',
    ]) {
      const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
        count: number
      }
      assert.equal(row.count, 0, `${table} must not expose rolled-back range authority`)
    }
    const store = new DurableCustodySqliteStore(database)
    for (const proofId of proofIds) {
      const proof = store.getProof(scopeId, proofId)
      assert.equal(proof?.selectability, 'selectable')
      assert.equal(proof?.reservationOperationId, null)
    }
  } finally {
    database.close()
  }
}
