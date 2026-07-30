import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  appendRangePreparationConsolidation,
  bindRangePreparationCapability,
  decodeCanonicalRangePreparation,
  encodeCanonicalRangePreparation,
  insertRangePreparation,
  linkRangePreparationSource,
  pageActiveRangePreparations,
  readActiveRangePreparationByClientOrderId,
  readRangePreparation,
  readRangePreparationOperationLinks,
  transitionRangePreparation,
} from '../src/ctfRangeOrderJournalSqlite.ts'
import { FINAL_PROFILE_SCHEMA_SQL } from '../src/profileSchemaManifest.ts'
import { configureDaemonStateSqlite } from '../src/stateSqlite.ts'

const SCOPE_ID = `custody:wallet:${'11'.repeat(32)}`
const MINT_URL = 'https://mint.example'
const CAPABILITY = {
  artifactId: '11111111-1111-4111-8111-111111111111',
  bindingDigest: '22'.repeat(32),
  artifactDigest: '33'.repeat(32),
  orderId: '44444444-4444-4444-8444-444444444444',
} as const

test('range preparation insert is exact and canonical bytes fail closed', (t) => {
  const database = createDatabase()
  t.after(() => database.close())
  seedProofOperation(database, 'source-1', 'reservation-source-1', 'source')
  const input = preparationInput('range-1', 'source-1', 'client-1', 10)

  const inserted = insertRangePreparation(database, input)
  const replayed = insertRangePreparation(database, input)
  const restored = readRangePreparation(database, SCOPE_ID, input.rangeOperationId)

  assert.equal(inserted.rangeOperationId, input.rangeOperationId)
  assert.equal(replayed.revision, 0)
  assert.equal(restored?.clientOrderId, input.clientOrderId)
  assert.equal(
    Buffer.from(restored?.preparationBytes ?? []).toString('utf8'),
    '{"authorizationId":"authorization-range-1","rangeOperationId":"range-1"}',
  )
  assert.throws(
    () =>
      insertRangePreparation(database, {
        ...input,
        amountSubunits: input.amountSubunits + 1,
      }),
    /conflicts with its persisted authority/,
  )
  assert.throws(
    () =>
      insertRangePreparation(database, {
        ...preparationInput('range-foreign', 'source-foreign', 'client-foreign', 11),
        preparationBytes: Buffer.from('{"z":1, "a":2}'),
      }),
    /canonical/,
  )

  database
    .prepare(
      `UPDATE daemon_ctf_range_preparations
       SET preparation_body = ?
       WHERE scope_id = ? AND range_operation_id = ?`,
    )
    .run(Buffer.from('{"z":1,"a":2}'), SCOPE_ID, input.rangeOperationId)
  assert.throws(() => readRangePreparation(database, SCOPE_ID, input.rangeOperationId), /canonical/)
})

test('range preparation schema rejects partial capability and loose authority', (t) => {
  const database = createDatabase()
  t.after(() => database.close())
  const input = preparationInput('range-constraints', 'source-constraints', 'client-constraints', 1)
  const values = preparationValues(input)
  const statement = database.prepare(
    `INSERT INTO daemon_ctf_range_preparations (
       scope_id, range_operation_id, source_operation_id, source_kind,
       predecessor_range_operation_id, authorization_id,
       client_order_id, market_id, normalized_mint, condition_id, unit,
       token_side, side, price_subunits, amount_subunits, divisibility,
       authorization_expires_at_unix_seconds, preparation_body, lifecycle_state, revision,
       capability_artifact_id, capability_binding_digest, capability_artifact_digest,
       engine_order_id, created_at_ms, updated_at_ms
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     )`,
  )

  assert.throws(
    () =>
      statement.run(
        ...values.slice(0, 10),
        'sat',
        ...values.slice(11),
        'prepared',
        0,
        null,
        null,
        null,
        null,
        input.createdAtMs,
        input.createdAtMs,
      ),
    /constraint/,
  )
  assert.throws(
    () =>
      statement.run(
        ...values,
        'capability-bound',
        0,
        CAPABILITY.artifactId,
        null,
        CAPABILITY.artifactDigest,
        CAPABILITY.orderId,
        input.createdAtMs,
        input.createdAtMs,
      ),
    /constraint/,
  )

  assert.throws(
    () => seedWalletProof(database, 'available', 'unexpected-reservation'),
    /constraint/,
  )
  assert.throws(
    () =>
      insertRangePreparation(database, {
        ...preparationInput('range-full-price', 'source-full-price', 'client-full-price', 2),
        priceSubunits: 10_000,
      }),
    /constraint/,
  )
})

test('source and consolidation links are exact, idempotent, and ordered', (t) => {
  const database = createDatabase()
  t.after(() => database.close())
  seedProofOperation(database, 'source-links', null, 'source')
  seedProofOperation(database, 'consolidation-0', null, 'consolidation')
  seedProofOperation(database, 'consolidation-1', null, 'consolidation')
  const input = preparationInput('range-links', 'source-links', 'client-links', 2)
  insertRangePreparation(database, input)

  const source = {
    scopeId: SCOPE_ID,
    rangeOperationId: input.rangeOperationId,
    sourceOperationId: input.sourceOperationId,
    reservationId: 'reservation-source-links',
  }
  linkRangePreparationSource(database, source)
  linkRangePreparationSource(database, source)
  appendRangePreparationConsolidation(database, {
    scopeId: SCOPE_ID,
    rangeOperationId: input.rangeOperationId,
    round: 1,
    operationId: 'consolidation-1',
    reservationId: 'reservation-consolidation-1',
  })
  appendRangePreparationConsolidation(database, {
    scopeId: SCOPE_ID,
    rangeOperationId: input.rangeOperationId,
    round: 0,
    operationId: 'consolidation-0',
    reservationId: 'reservation-consolidation-0',
  })

  const links = readRangePreparationOperationLinks(database, SCOPE_ID, input.rangeOperationId)
  assert.equal(links.source?.reservationId, source.reservationId)
  assert.equal(links.consolidations.length, 2)
  assert.equal(links.consolidations[0]?.round, 0)
  assert.equal(links.consolidations[1]?.round, 1)
  assert.throws(
    () =>
      appendRangePreparationConsolidation(database, {
        scopeId: SCOPE_ID,
        rangeOperationId: input.rangeOperationId,
        round: 0,
        operationId: 'consolidation-1',
        reservationId: 'reservation-consolidation-1',
      }),
    /conflicts with its persisted link/,
  )
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO daemon_ctf_range_consolidations (
             scope_id, range_operation_id, round, operation_id,
             reservation_id, operation_purpose
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          SCOPE_ID,
          input.rangeOperationId,
          2,
          'missing-operation',
          'reservation-missing',
          'ctf-range-authorization-consolidation',
        ),
    /FOREIGN KEY/,
  )
})

test('active recovery pages use lifecycle and retain submitted orders until terminal', (t) => {
  const database = createDatabase()
  t.after(() => database.close())
  for (const [index, suffix] of ['a', 'b', 'c', 'd'].entries()) {
    insertRangePreparation(
      database,
      preparationInput(`range-${suffix}`, `source-${suffix}`, `client-${suffix}`, 20 + index),
    )
  }
  bindRangePreparationCapability(database, {
    scopeId: SCOPE_ID,
    rangeOperationId: 'range-b',
    expectedRevision: 0,
    capability: CAPABILITY,
    updatedAtMs: 30,
  })
  transitionRangePreparation(database, {
    scopeId: SCOPE_ID,
    rangeOperationId: 'range-c',
    expectedRevision: 0,
    from: 'prepared',
    to: 'terminal',
    updatedAtMs: 31,
  })
  insertSubmittedOrder(database, 'client-d')

  const page = pageActiveRangePreparations(database, {
    scopeId: SCOPE_ID,
    limit: 10,
  })
  assert.deepEqual(
    page.preparations.map(({ rangeOperationId }) => rangeOperationId),
    ['range-a', 'range-d', 'range-b'],
  )
  assert.equal(page.nextCursor, null)
  assert.equal(
    readActiveRangePreparationByClientOrderId(database, SCOPE_ID, 'client-d')?.rangeOperationId,
    'range-d',
  )
})

test('capability binding and lifecycle transitions use revision CAS', (t) => {
  const database = createDatabase()
  t.after(() => database.close())
  const input = preparationInput('range-transition', 'source-transition', 'client-transition', 5)
  insertRangePreparation(database, input)

  const bound = bindRangePreparationCapability(database, {
    scopeId: SCOPE_ID,
    rangeOperationId: input.rangeOperationId,
    expectedRevision: 0,
    capability: CAPABILITY,
    updatedAtMs: 6,
  })
  assert.equal(bound.lifecycleState, 'capability-bound')
  assert.equal(bound.revision, 1)
  assert.equal(insertRangePreparation(database, input).revision, 1)
  const submitted = transitionRangePreparation(database, {
    scopeId: SCOPE_ID,
    rangeOperationId: input.rangeOperationId,
    expectedRevision: 1,
    from: 'capability-bound',
    to: 'order-submitted',
    updatedAtMs: 7,
  })
  assert.equal(submitted.revision, 2)
  assert.throws(
    () =>
      transitionRangePreparation(database, {
        scopeId: SCOPE_ID,
        rangeOperationId: input.rangeOperationId,
        expectedRevision: 1,
        from: 'capability-bound',
        to: 'order-submitted',
        updatedAtMs: 8,
      }),
    /revision or lifecycle changed/,
  )

  const rejectedInput = preparationInput('range-rejected', 'source-rejected', 'client-rejected', 9)
  insertRangePreparation(database, rejectedInput)
  bindRangePreparationCapability(database, {
    scopeId: SCOPE_ID,
    rangeOperationId: rejectedInput.rangeOperationId,
    expectedRevision: 0,
    capability: {
      ...CAPABILITY,
      artifactId: '55555555-5555-4555-8555-555555555555',
      orderId: '66666666-6666-4666-8666-666666666666',
    },
    updatedAtMs: 10,
  })
  const rejected = transitionRangePreparation(database, {
    scopeId: SCOPE_ID,
    rangeOperationId: rejectedInput.rangeOperationId,
    expectedRevision: 1,
    from: 'capability-bound',
    to: 'submission-rejected',
    updatedAtMs: 11,
  })
  assert.equal(rejected.lifecycleState, 'submission-rejected')
  const terminal = transitionRangePreparation(database, {
    scopeId: SCOPE_ID,
    rangeOperationId: rejectedInput.rangeOperationId,
    expectedRevision: 2,
    from: 'submission-rejected',
    to: 'terminal',
    updatedAtMs: 12,
  })
  assert.equal(terminal.lifecycleState, 'terminal')
})

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  configureDaemonStateSqlite(database)
  database.exec(FINAL_PROFILE_SCHEMA_SQL.join(';\n'))
  database
    .prepare(
      `INSERT INTO custody_scopes (
         scope_id, scope_kind, wallet_id, wallet_seed_digest, created_at_ms
       ) VALUES (?, 'wallet', ?, ?, 0)`,
    )
    .run(SCOPE_ID, '11'.repeat(32), '22'.repeat(32))
  return database
}

function preparationInput(
  rangeOperationId: string,
  sourceOperationId: string,
  clientOrderId: string,
  createdAtMs: number,
) {
  return {
    scopeId: SCOPE_ID,
    rangeOperationId,
    sourceOperationId,
    sourceKind: 'wallet-prepared' as const,
    predecessorRangeOperationId: null,
    authorizationId: `authorization-${rangeOperationId}`,
    clientOrderId,
    marketId: 'condition-1-YES',
    normalizedMint: MINT_URL,
    conditionId: 'condition-1',
    unit: 'msat' as const,
    tokenSide: 'Outcome' as const,
    side: 'Buy' as const,
    priceSubunits: 5_000,
    amountSubunits: 100,
    divisibility: 10_000,
    authorizationExpiresAtUnixSeconds: 2_000_000_000,
    preparationBytes: encodeCanonicalRangePreparation({
      rangeOperationId,
      authorizationId: `authorization-${rangeOperationId}`,
    }),
    createdAtMs,
  }
}

function preparationValues(input: ReturnType<typeof preparationInput>): unknown[] {
  decodeCanonicalRangePreparation(input.preparationBytes)
  return [
    input.scopeId,
    input.rangeOperationId,
    input.sourceOperationId,
    input.sourceKind,
    input.predecessorRangeOperationId,
    input.authorizationId,
    input.clientOrderId,
    input.marketId,
    input.normalizedMint,
    input.conditionId,
    input.unit,
    input.tokenSide,
    input.side,
    input.priceSubunits,
    input.amountSubunits,
    input.divisibility,
    input.authorizationExpiresAtUnixSeconds,
    input.preparationBytes,
  ]
}

let artifactSequence = 1

function seedProofOperation(
  database: DatabaseSync,
  operationId: string,
  reservationId: string | null,
  purpose: 'source' | 'consolidation',
): void {
  const requestArtifactId = testArtifactId()
  const outputArtifactId = testArtifactId()
  insertArtifact(database, requestArtifactId, 'exact-request')
  insertArtifact(database, outputArtifactId, 'output-plan')
  database
    .prepare(
      `INSERT INTO target_proof_operations (
         operation_id, scope_id, kind, purpose, state, normalized_mint,
         request_artifact_id, output_artifact_id, result_artifact_id,
         result_proofs_digest, input_count, input_amount, last_error,
         reservation_id, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?, NULL, NULL, 0, 0, NULL, ?, 0, 0)`,
    )
    .run(
      operationId,
      SCOPE_ID,
      purpose === 'source' ? 'wallet-send' : 'ctf-consolidation',
      purpose === 'source'
        ? 'ctf-range-authorization-source'
        : 'ctf-range-authorization-consolidation',
      MINT_URL,
      requestArtifactId,
      outputArtifactId,
      reservationId,
    )
}

function insertArtifact(
  database: DatabaseSync,
  artifactId: string,
  kind: 'exact-request' | 'output-plan',
): void {
  database
    .prepare(
      `INSERT INTO custody_artifacts (
         artifact_id, scope_id, artifact_kind, encoding, body, fingerprint,
         revision, private_material, created_at_ms
       ) VALUES (?, ?, ?, 'canonical-json', ?, ?, 0, 0, 0)`,
    )
    .run(artifactId, SCOPE_ID, kind, Buffer.from('{}'), 'aa'.repeat(32))
}

function testArtifactId(): string {
  const id = artifactSequence.toString(16).padStart(64, '0')
  artifactSequence += 1
  return id
}

function insertSubmittedOrder(database: DatabaseSync, clientOrderId: string): void {
  database
    .prepare(
      `INSERT INTO daemon_orders (
         order_id, scope_id, market_id, status, revision, client_order_id,
         base_asset, divisibility, engine_status_present, created_at_ms, updated_at_ms
       ) VALUES (?, ?, 'condition-1-YES', 'resting', 0, ?, 'sat', 10000, 0, 0, 0)`,
    )
    .run(`engine-${clientOrderId}`, SCOPE_ID, clientOrderId)
}

function seedWalletProof(
  database: DatabaseSync,
  state: 'available' | 'reserved',
  reservedBy: string | null,
): void {
  database
    .prepare(
      `INSERT INTO target_wallet_proofs (
         proof_id, scope_id, normalized_mint, unit, keyset_id, amount,
         secret, signature, proof_body, state, reserved_by, asset_kind,
         condition_id, outcome_set_id, base_asset, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, 'msat', 'keyset', 1, 'secret', 'signature', ?,
         ?, ?, 'sats', NULL, NULL, 'sat', 0, 0)`,
    )
    .run('bb'.repeat(32), SCOPE_ID, MINT_URL, Buffer.from('{}'), state, reservedBy)
}
