import assert from 'node:assert/strict'
import test from 'node:test'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import {
  assertManagedConditionInventoryMutation,
  completeManagedConditionInventoryRetirement,
  createManagedConditionInventoryState,
  createManagedConditionRetirementIntent,
  decodePersistedRegisteredDlcConditionAuthority,
  deriveDlcConditionId,
  persistVerifiedConditionResolution,
  startManagedConditionInventoryRetirement,
  verifyDlcConditionResolution,
  type DlcConditionResolutionEvidence,
  type ManagedConditionInventoryBinding,
  type ManagedConditionInventoryQuiescence,
  type PersistedManagedConditionOperationAuthority,
  type PersistedRegisteredDlcConditionAuthority,
  type VerifiedConditionResolution,
} from '../src/managedConditionInventory.ts'
import {
  deriveDurableCustodyOperationId,
  deriveDurableCustodyScopeId,
} from '../src/durableCustody.ts'

const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 1])
const SECOND_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 2])
const ORACLE_PUBLIC_KEY = bytesToHex(schnorr.getPublicKey(PRIVATE_KEY))
const SECOND_ORACLE_PUBLIC_KEY = bytesToHex(schnorr.getPublicKey(SECOND_PRIVATE_KEY))
const EVENT_ID = 'managed-condition-test'
const OUTCOMES = ['YES', 'NO'] as const
const CONDITION_ID = deriveDlcConditionId({
  eventId: EVENT_ID,
  outcomeCount: OUTCOMES.length,
  oraclePublicKeys: [ORACLE_PUBLIC_KEY],
})
const BINDING: ManagedConditionInventoryBinding = {
  scopeId: deriveDurableCustodyScopeId({
    scopeKind: 'condition-inventory',
    conditionId: CONDITION_ID,
    inventoryAccountId: 'condition:managed-test',
    normalizedMint: 'https://mint.example',
    unit: 'msat',
  }),
  normalizedMint: 'https://mint.example',
  unit: 'msat',
  conditionId: CONDITION_ID,
  canonicalParentCollectionId: null,
}
const QUIESCENT: ManagedConditionInventoryQuiescence = {
  earlierWorkCount: 0,
  unknownWorkCount: 0,
  corruptWorkCount: 0,
  pendingRetirementWorkCount: 0,
  selectableRetirementProofCount: 0,
  unappliedResultCount: 0,
}

test('SDK verifies and binds exact DLC resolution evidence', () => {
  const evidence = resolutionEvidence()
  const verified = verifyDlcConditionResolution(BINDING, registeredAuthority(evidence), evidence)

  assert.equal(verified.resolvedOutcome, 'YES')
  assert.match(verified.evidenceFingerprint, /^[0-9a-f]{64}$/)
  assert.equal(Object.isFrozen(verified), true)
  const persisted = persistVerifiedConditionResolution(verified)
  assert.equal(Object.getOwnPropertySymbols(persisted).length, 0)
  assert.equal(persisted.evidenceFingerprint, verified.evidenceFingerprint)
})

test('DLC resolution uses the independently restored oracle threshold', () => {
  const evidence = resolutionEvidence()
  const secondSignature = signOutcome('YES', SECOND_PRIVATE_KEY)
  const conditionId = deriveDlcConditionId({
    eventId: EVENT_ID,
    outcomeCount: OUTCOMES.length,
    oraclePublicKeys: [ORACLE_PUBLIC_KEY, SECOND_ORACLE_PUBLIC_KEY],
  })
  const binding = conditionBinding(conditionId)
  const registered = decodePersistedRegisteredDlcConditionAuthority({
    schemaVersion: 1,
    ...binding,
    eventId: EVENT_ID,
    outcomes: OUTCOMES,
    threshold: 2,
    oracles: [
      {
        oraclePublicKey: ORACLE_PUBLIC_KEY,
        noncePoint: evidence.attestations[0]!.signature.slice(0, 64),
        announcementIdentity: '44'.repeat(32),
      },
      {
        oraclePublicKey: SECOND_ORACLE_PUBLIC_KEY,
        noncePoint: secondSignature.slice(0, 64),
        announcementIdentity: '55'.repeat(32),
      },
    ],
  })

  assert.throws(
    () => verifyDlcConditionResolution(binding, registered, evidence),
    /threshold is not met/,
  )
  assert.doesNotThrow(() =>
    verifyDlcConditionResolution(binding, registered, {
      ...evidence,
      attestations: [
        ...evidence.attestations,
        { oraclePublicKey: SECOND_ORACLE_PUBLIC_KEY, signature: secondSignature },
      ],
    }),
  )
})

test('DLC registration rejects a condition ID that does not bind its oracle set', () => {
  assert.throws(
    () =>
      decodePersistedRegisteredDlcConditionAuthority({
        ...registeredAuthority(resolutionEvidence()),
        conditionId: '22'.repeat(32),
      }),
    /authority is foreign/,
  )
})

test('SDK accepts the CDK and engine DLC attestation parity fixture', () => {
  const oraclePublicKey = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e'
  const signature =
    'ab5cbc99b45a936368081a43a7f14c9be0a821ba5beba722c27d61cef31a78d9' +
    'ca67037f0b2d79d3a336533e5b28f9ad454273954ab06ab3adee38307d5fbcb0'
  const conditionId = deriveDlcConditionId({
    eventId: 'parity-event',
    outcomeCount: 2,
    oraclePublicKeys: [oraclePublicKey],
  })
  const binding = conditionBinding(conditionId)
  const evidence: DlcConditionResolutionEvidence = {
    schemaVersion: 1,
    source: 'dlc-oracle-attestation',
    attestations: [{ oraclePublicKey, signature }],
    resolvedOutcome: 'Yes',
  }
  const registered = decodePersistedRegisteredDlcConditionAuthority({
    schemaVersion: 1,
    ...binding,
    eventId: 'parity-event',
    outcomes: ['Yes', 'No'],
    threshold: 1,
    oracles: [
      {
        oraclePublicKey,
        noncePoint: signature.slice(0, 64),
        announcementIdentity: '11'.repeat(32),
      },
    ],
  })
  const verified = verifyDlcConditionResolution(binding, registered, evidence)

  assert.equal(verified.conditionId, conditionId)
  assert.equal(verified.resolvedOutcome, 'Yes')
})

test('DLC resolution rejects foreign, invalid, and oversized evidence', () => {
  const evidence = resolutionEvidence()
  const registered = registeredAuthority(evidence)
  assert.throws(
    () =>
      verifyDlcConditionResolution(
        { ...BINDING, conditionId: '22'.repeat(32) },
        registered,
        evidence,
      ),
    /foreign/,
  )
  assert.throws(
    () =>
      verifyDlcConditionResolution(BINDING, registered, {
        ...evidence,
        attestations: [{ ...evidence.attestations[0]!, signature: '00'.repeat(64) }],
      }),
    /signature/,
  )
  assert.throws(
    () =>
      verifyDlcConditionResolution(
        BINDING,
        {
          ...registered,
          oracles: [{ ...registered.oracles[0]!, noncePoint: '00'.repeat(32) }],
        },
        evidence,
      ),
    /signature/,
  )
  assert.throws(
    () =>
      verifyDlcConditionResolution(BINDING, registered, {
        ...evidence,
        resolvedOutcome: 'x'.repeat(65 * 1_024),
      }),
    /byte limit/,
  )
})

test('retirement rejects a structurally valid unverified resolution', () => {
  const verified = verifiedResolution()
  const unverified = {
    ...persistVerifiedConditionResolution(verified),
  } as unknown as VerifiedConditionResolution
  assert.throws(
    () =>
      startManagedConditionInventoryRetirement({
        current: createManagedConditionInventoryState(BINDING),
        resolution: unverified,
        retirementIntent: retirementIntent(),
        startedAtMs: 11,
      }),
    /not verified by the SDK/,
  )
})

test('retirement binds separate local intent and permits only exact retry', () => {
  const resolution = verifiedResolution()
  const intent = retirementIntent()
  const retiring = startManagedConditionInventoryRetirement({
    current: createManagedConditionInventoryState(BINDING),
    resolution,
    retirementIntent: intent,
    startedAtMs: 11,
  })

  assert.equal(retiring.state, 'retiring')
  assert.equal(retiring.revision, 1)
  assert.deepEqual(
    startManagedConditionInventoryRetirement({
      current: retiring,
      resolution,
      retirementIntent: intent,
      startedAtMs: 99,
    }),
    retiring,
  )
  assert.throws(
    () =>
      startManagedConditionInventoryRetirement({
        current: retiring,
        resolution,
        retirementIntent: { ...intent, intentId: 'other-policy' },
        startedAtMs: 12,
      }),
    /conflicts/,
  )
})

test('retirement completes only from exact quiescence evidence', () => {
  const retiring = retiringState()
  for (const key of Object.keys(QUIESCENT) as Array<keyof ManagedConditionInventoryQuiescence>) {
    assert.throws(
      () =>
        completeManagedConditionInventoryRetirement({
          current: retiring,
          quiescence: { ...QUIESCENT, [key]: 1 },
          completedAtMs: 20,
        }),
      /not quiescent/,
    )
  }
  assert.throws(
    () =>
      completeManagedConditionInventoryRetirement({
        current: retiring,
        quiescence: {
          ...QUIESCENT,
          foreignCount: 0,
        } as ManagedConditionInventoryQuiescence,
        completedAtMs: 20,
      }),
    /foreign fields/,
  )
  const retired = completeManagedConditionInventoryRetirement({
    current: retiring,
    quiescence: QUIESCENT,
    completedAtMs: 20,
  })
  assert.equal(retired.state, 'retired')
  assert.equal(retired.revision, 2)
})

test('recovery and retirement mutations require exact persisted operation rows', () => {
  const retiring = retiringState()
  const existing: PersistedManagedConditionOperationAuthority = {
    operationId: operationId('existing'),
    scopeId: BINDING.scopeId,
    inventoryRevisionAtBind: 0,
    purpose: 'existing-recovery',
    resolutionEvidenceFingerprint: null,
    retirementIntentId: null,
  }
  const redemption: PersistedManagedConditionOperationAuthority = {
    operationId: operationId('retirement'),
    scopeId: BINDING.scopeId,
    inventoryRevisionAtBind: 1,
    purpose: 'retirement-redemption',
    resolutionEvidenceFingerprint: retiring.resolution.evidenceFingerprint,
    retirementIntentId: retiring.retirementIntent.intentId,
  }

  assert.doesNotThrow(() =>
    assertManagedConditionInventoryMutation(retiring, {
      kind: 'exact-existing-recovery',
      authority: existing,
    }),
  )
  assert.doesNotThrow(() =>
    assertManagedConditionInventoryMutation(retiring, {
      kind: 'retirement-redemption',
      authority: redemption,
    }),
  )
  assert.throws(
    () =>
      assertManagedConditionInventoryMutation(retiring, {
        kind: 'exact-existing-recovery',
        authority: { ...existing, inventoryRevisionAtBind: 1 },
      }),
    /not bound before retirement/,
  )
})

test('new intent and proof retention follow the complete state matrix', () => {
  const active = createManagedConditionInventoryState(BINDING)
  const retiring = retiringState()
  const retired = completeManagedConditionInventoryRetirement({
    current: retiring,
    quiescence: QUIESCENT,
    completedAtMs: 20,
  })
  assert.doesNotThrow(() =>
    assertManagedConditionInventoryMutation(active, { kind: 'new-economic-intent' }),
  )
  assert.throws(() =>
    assertManagedConditionInventoryMutation(retiring, { kind: 'new-economic-intent' }),
  )
  assert.throws(() =>
    assertManagedConditionInventoryMutation(retired, { kind: 'new-economic-intent' }),
  )
  for (const state of [active, retiring, retired]) {
    assert.doesNotThrow(() =>
      assertManagedConditionInventoryMutation(state, { kind: 'proof-retention-or-audit' }),
    )
  }
})

function resolutionEvidence(): DlcConditionResolutionEvidence {
  return {
    schemaVersion: 1,
    source: 'dlc-oracle-attestation',
    attestations: [
      { oraclePublicKey: ORACLE_PUBLIC_KEY, signature: signOutcome('YES', PRIVATE_KEY) },
    ],
    resolvedOutcome: 'YES',
  }
}

function signOutcome(outcome: string, privateKey: Uint8Array): string {
  const message = taggedHash('DLC/oracle/attestation/v0', utf8ToBytes(outcome))
  return bytesToHex(schnorr.sign(message, privateKey, new Uint8Array(32)))
}

function registeredAuthority(
  evidence: DlcConditionResolutionEvidence,
): PersistedRegisteredDlcConditionAuthority {
  const signature = evidence.attestations[0]!.signature
  return decodePersistedRegisteredDlcConditionAuthority({
    schemaVersion: 1,
    ...BINDING,
    eventId: EVENT_ID,
    outcomes: OUTCOMES,
    threshold: 1,
    oracles: [
      {
        oraclePublicKey: ORACLE_PUBLIC_KEY,
        noncePoint: signature.slice(0, 64),
        announcementIdentity: '44'.repeat(32),
      },
    ],
  })
}

function verifiedResolution() {
  const evidence = resolutionEvidence()
  return verifyDlcConditionResolution(BINDING, registeredAuthority(evidence), evidence)
}

function retirementIntent() {
  return createManagedConditionRetirementIntent({
    binding: BINDING,
    kind: 'automated-service-policy',
    intentId: 'wallet-service-policy:v1',
    createdAtMs: 10,
  })
}

function retiringState() {
  return startManagedConditionInventoryRetirement({
    current: createManagedConditionInventoryState(BINDING),
    resolution: verifiedResolution(),
    retirementIntent: retirementIntent(),
    startedAtMs: 11,
  })
}

function operationId(suffix: string): string {
  return deriveDurableCustodyOperationId(BINDING.scopeId, {
    retainedOperationKey: `managed-condition-${suffix}`,
    binding: { kind: 'wallet', activityId: `managed-condition-${suffix}`, stage: 'receive' },
  })
}

function conditionBinding(conditionId: string): ManagedConditionInventoryBinding {
  return {
    ...BINDING,
    conditionId,
    scopeId: deriveDurableCustodyScopeId({
      scopeKind: 'condition-inventory',
      conditionId,
      inventoryAccountId: 'condition:managed-test',
      normalizedMint: 'https://mint.example',
      unit: 'msat',
    }),
  }
}

function taggedHash(tag: string, message: Uint8Array): Uint8Array {
  const tagHash = sha256(utf8ToBytes(tag))
  return sha256(concatBytes(tagHash, tagHash, message))
}
