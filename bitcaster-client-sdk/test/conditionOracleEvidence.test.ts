import { d4ConditionalKeyset } from './support/d4OracleFixture.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { Proof } from '@cashu/cashu-ts'
import {
  createConditionOracleEvidenceResolver,
  prepareCtfVerifiedLosingAuthority,
  requireCtfVerifiedLosingAuthority,
  prepareConditionOracleWitnessFromMintInfo,
} from '../src/conditionOracleEvidence.ts'
import { deriveDurableCustodyScopeId } from '../src/durableCustody.ts'
import type { PersistedRegisteredDlcConditionAuthority } from '../src/managedConditionInventory.ts'

const registered = JSON.parse(
  readFileSync(new URL('./fixtures/d4/registered-authority.json', import.meta.url), 'utf8'),
) as PersistedRegisteredDlcConditionAuthority
Object.assign(registered, {
  scopeId: deriveDurableCustodyScopeId({
    scopeKind: 'condition-inventory',
    conditionId: registered.conditionId,
    inventoryAccountId: 'd4-fixture',
    normalizedMint: registered.normalizedMint,
    unit: registered.unit,
  }),
})
const producer = JSON.parse(
  readFileSync(new URL('./fixtures/d4/condition-info.json', import.meta.url), 'utf8'),
)
const witness = { oracle_sigs: producer.attestation.oracle_sigs }
const conditional = d4ConditionalKeyset({
  '1': '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
})
const inputs = [{ id: conditional.id, amount: 1, secret: 'exact-proof', C: '02' }] as Proof[]

test('real CDK response verifies against intended registration and caches exact result', async () => {
  const resolver = createConditionOracleEvidenceResolver({ maxEntries: 1 })
  let calls = 0
  const fetchWitness = async () => {
    calls++
    return witness
  }
  const first = await resolver.resolve({ registered, resolvedOutcome: 'YES', fetchWitness })
  assert.equal(first.status, 'verified')
  const cached = await resolver.resolve({ registered, resolvedOutcome: 'YES', fetchWitness })
  assert.equal(cached, first)
  assert.equal(calls, 1)
  assert.equal(
    (await resolver.resolve({ registered, resolvedOutcome: 'NO', fetchWitness })).status,
    'unverified',
  )
  assert.equal(calls, 2)
  await resolver.resolve({ registered, resolvedOutcome: 'YES', fetchWitness })
  assert.equal(calls, 3)
})

test('missing intended registration, missing signatures, failure and invalid nonce stay unverified', async () => {
  const resolver = createConditionOracleEvidenceResolver()
  for (const request of [
    { registered: undefined, fetchWitness: async () => witness },
    { registered, fetchWitness: async () => undefined },
    {
      registered,
      fetchWitness: async () => {
        throw new Error('offline')
      },
    },
    {
      registered: {
        ...registered,
        oracles: [{ ...registered.oracles[0]!, noncePoint: '11'.repeat(32) }],
      },
      fetchWitness: async () => witness,
    },
  ])
    assert.equal(
      (await resolver.resolve({ ...request, resolvedOutcome: 'YES' })).status,
      'unverified',
    )
})

test('registration changes invalidate cached evidence without trusting condition ID alone', async () => {
  const resolver = createConditionOracleEvidenceResolver()
  assert.equal(
    (
      await resolver.resolve({
        registered,
        resolvedOutcome: 'YES',
        fetchWitness: async () => witness,
      })
    ).status,
    'verified',
  )
  const changed = {
    ...registered,
    oracles: [{ ...registered.oracles[0]!, noncePoint: '11'.repeat(32) }],
  }
  assert.equal(
    (
      await resolver.resolve({
        registered: changed,
        resolvedOutcome: 'YES',
        fetchWitness: async () => witness,
      })
    ).status,
    'unverified',
  )
})

test('only exact enum losing collection gets authority and full context survives serialized reload', async () => {
  const evidence = await createConditionOracleEvidenceResolver().resolve({
    registered,
    resolvedOutcome: 'YES',
    fetchWitness: async () => witness,
  })
  assert.equal(evidence.status, 'verified')
  if (evidence.status !== 'verified') throw new Error('fixture is not verified')
  const request = {
    resolution: evidence.context,
    operationId: 'exact-operation',
    mintUrl: registered.normalizedMint,
    conditionId: registered.conditionId,
    outcomeCollection: 'NO',
    inputs,
    inputKeysets: [conditional],
  }
  const losing = prepareCtfVerifiedLosingAuthority(request)
  const reloaded = JSON.parse(JSON.stringify(losing))
  assert.equal(
    requireCtfVerifiedLosingAuthority(reloaded, request).resolution.evidence.resolvedOutcome,
    'YES',
  )
  for (const mutation of [
    { outcomeCollection: 'YES' },
    { operationId: 'other-operation' },
    { mintUrl: 'https://foreign.example' },
    { inputs: [{ ...inputs[0]!, secret: 'foreign-proof' }] },
  ]) {
    assert.throws(() => requireCtfVerifiedLosingAuthority(reloaded, { ...request, ...mutation }))
  }
  assert.throws(() => prepareCtfVerifiedLosingAuthority({ ...request, outcomeCollection: 'YES' }))
  assert.throws(() =>
    requireCtfVerifiedLosingAuthority({
      ...reloaded,
      resolution: {
        ...reloaded.resolution,
        evidence: { ...reloaded.resolution.evidence, attestations: [] },
      },
    }),
  )
})

test('full producer response binds exact announcements threshold and result', () => {
  assert.equal(
    Array.isArray(
      prepareConditionOracleWitnessFromMintInfo(registered, 'YES', producer).oracle_sigs,
    ),
    true,
  )
  for (const change of [
    { threshold: 2 },
    { announcements: [] },
    { collateral: 'msat' },
    { condition_id: '11'.repeat(32) },
    { attestation: { ...producer.attestation, winning_outcome: 'NO' } },
  ])
    assert.throws(() =>
      prepareConditionOracleWitnessFromMintInfo(registered, 'YES', { ...producer, ...change }),
    )
})

test('shared mint resolver reads current result but fetches signatures only on cache miss', async () => {
  const resolver = createConditionOracleEvidenceResolver()
  const requests: boolean[] = []
  const input = {
    binding: registered,
    fetchRegisteredAuthority: async () => registered,
    fetchConditionInfo: async (includeOracleSigs: boolean) => {
      requests.push(includeOracleSigs)
      return producer
    },
  }
  assert.equal((await resolver.resolveFromMint(input)).evidence.status, 'verified')
  assert.equal((await resolver.resolveFromMint(input)).evidence.status, 'verified')
  assert.equal(requests.join(','), 'false,true,false')
  const offline = await resolver.resolveFromMint({
    ...input,
    fetchRegisteredAuthority: async () => {
      throw new Error('engine offline')
    },
  })
  assert.equal(offline.evidence.status, 'unverified')
  assert.equal(offline.resolvedOutcome, 'YES')
  const changed = await resolver.resolveFromMint({
    ...input,
    fetchConditionInfo: async () => ({
      ...producer,
      attestation: { ...producer.attestation, winning_outcome: 'NO' },
    }),
  })
  assert.equal(changed.evidence.status, 'unverified')
  assert.equal(changed.resolvedOutcome, 'NO')
})

test('cached evidence cannot authorize changed current mint registration under same result and ID', async () => {
  for (const changed of [
    { ...producer, threshold: 2 },
    { ...producer, announcements: [producer.announcements[0].slice(0, -2) + '00'] },
    { ...producer, collateral: 'msat' },
  ]) {
    const resolver = createConditionOracleEvidenceResolver()
    let signatures = 0
    const request = {
      binding: registered,
      fetchRegisteredAuthority: async () => registered,
      fetchConditionInfo: async (include: boolean) => {
        if (include) signatures++
        return producer
      },
    }
    assert.equal((await resolver.resolveFromMint(request)).evidence.status, 'verified')
    assert.equal(
      (await resolver.resolveFromMint({ ...request, fetchConditionInfo: async () => changed }))
        .evidence.status,
      'unverified',
    )
    assert.equal(signatures, 1)
    assert.equal((await resolver.resolveFromMint(request)).evidence.status, 'verified')
    assert.equal(signatures, 2)
  }
})

test('initial redemption verifies engine witness against current mint registration', async () => {
  const resolver = createConditionOracleEvidenceResolver()
  const input = {
    binding: registered,
    fetchRegisteredAuthority: async () => registered,
    fetchConditionInfo: async () => ({ ...producer, attestation: { status: 'pending' } }),
    fetchInitialAttestation: async () => ({
      conditionId: registered.conditionId,
      registeredAuthority: registered,
      attestedOutcome: 'YES',
      oracleWitness: prepareConditionOracleWitnessFromMintInfo(registered, 'YES', producer),
    }),
  }
  assert.equal((await resolver.resolveFromMint(input)).evidence.status, 'verified')
  assert.equal(
    (
      await resolver.resolveFromMint({
        ...input,
        fetchConditionInfo: async () => ({
          ...producer,
          threshold: 99,
          attestation: { status: 'pending' },
        }),
      })
    ).evidence.status,
    'unverified',
  )
})

test('initial resolution accepts omitted status but refuses foreign or invalid engine evidence', async () => {
  const response = {
    conditionId: registered.conditionId,
    registeredAuthority: registered,
    attestedOutcome: 'YES',
    oracleWitness: prepareConditionOracleWitnessFromMintInfo(registered, 'YES', producer),
  }
  const request = {
    binding: registered,
    fetchRegisteredAuthority: async () => registered,
    fetchConditionInfo: async () => ({ ...producer, attestation: undefined }),
    fetchInitialAttestation: async () => response,
  }
  assert.equal(
    (await createConditionOracleEvidenceResolver().resolveFromMint(request)).evidence.status,
    'verified',
  )
  for (const change of [
    { conditionId: 'ff'.repeat(32) },
    { attestedOutcome: 'NO' },
    { oracleWitness: { oracle_sigs: [] } },
    { registeredAuthority: { ...registered, threshold: 99 } },
  ]) {
    assert.equal(
      (
        await createConditionOracleEvidenceResolver().resolveFromMint({
          ...request,
          fetchInitialAttestation: async () => ({ ...response, ...change }),
        })
      ).evidence.status,
      'unverified',
    )
  }
  for (const status of ['violation', 'unknown']) {
    const result = await createConditionOracleEvidenceResolver().resolveFromMint({
      ...request,
      fetchConditionInfo: async () => ({ ...producer, attestation: { status } }),
      fetchInitialAttestation: async () => {
        throw new Error('must not fetch initial evidence')
      },
    })
    assert.equal(result.evidence.status, 'unverified')
    if (result.evidence.status === 'unverified') assert.equal(result.evidence.reason, 'invalid')
  }
})

test('initial registration mismatch clears cached evidence before later witness validation', async () => {
  const resolver = createConditionOracleEvidenceResolver()
  let threshold = producer.threshold
  let witness: unknown = prepareConditionOracleWitnessFromMintInfo(registered, 'YES', producer)
  const request = {
    binding: registered,
    fetchRegisteredAuthority: async () => registered,
    fetchConditionInfo: async () => ({
      ...producer,
      threshold,
      attestation: { status: 'pending' },
    }),
    fetchInitialAttestation: async () => ({
      conditionId: registered.conditionId,
      registeredAuthority: registered,
      attestedOutcome: 'YES',
      oracleWitness: witness,
    }),
  }
  assert.equal((await resolver.resolveFromMint(request)).evidence.status, 'verified')
  threshold = 99
  assert.equal((await resolver.resolveFromMint(request)).evidence.status, 'unverified')
  threshold = producer.threshold
  witness = { oracle_sigs: [] }
  assert.equal((await resolver.resolveFromMint(request)).evidence.status, 'unverified')
})
