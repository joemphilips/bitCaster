import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalizeEvent } from 'nostr-tools/pure'
import {
  publishOracleOutcome,
  retryOraclePublication,
  snapshotOraclePublicationRecord,
  mergeOraclePublicationRecords,
  type OraclePublicationAdapters,
  type OraclePublicationRecord,
} from '../src/oraclePublication.ts'
import {
  oracleFixture,
  oracleTestKey,
  otherOracleTestKey,
  signedExplanation,
} from './fixtures/oraclePublication.ts'

test('restore merges complementary delivery evidence and preserves exact artifacts', () => {
  const fixture = oracleFixture()
  const signed: OraclePublicationRecord = {
    binding: fixture.binding,
    chosenOutcome: 'YES',
    attestation: fixture.artifact,
    relayPublished: false,
    engineEvidence: null,
    explanationEventJson: null,
    explanationRelayPublished: false,
  }
  const relay = { ...signed, relayPublished: true }
  const engine = { ...signed, engineEvidence: fixture.evidence }
  const merged = mergeOraclePublicationRecords(relay, engine)!
  assert.equal(merged.relayPublished, true)
  assert.deepEqual(merged.engineEvidence, fixture.evidence)
  assert.equal(merged.attestation!.eventJson, fixture.artifact.eventJson)
  assert.deepEqual(mergeOraclePublicationRecords(merged, signed), merged)
  assert.deepEqual(mergeOraclePublicationRecords(merged, null), merged)
  assert.deepEqual(mergeOraclePublicationRecords(null, merged), merged)
  assert.equal(mergeOraclePublicationRecords(null, null), null)
  assert.notEqual(merged, relay)
  assert.equal(relay.engineEvidence, null)
})

test('restore retains a saved choice and artifact when the incoming record is unsigned', () => {
  const fixture = oracleFixture()
  const signed: OraclePublicationRecord = {
    binding: fixture.binding,
    chosenOutcome: 'YES',
    attestation: fixture.artifact,
    relayPublished: true,
    engineEvidence: null,
    explanationEventJson: null,
    explanationRelayPublished: false,
  }
  const unsigned = { ...signed, attestation: null, relayPublished: false }
  assert.deepEqual(mergeOraclePublicationRecords(signed, unsigned), signed)
  assert.throws(
    () => mergeOraclePublicationRecords(signed, { ...unsigned, chosenOutcome: 'NO' }),
    /authority conflicts/,
  )
  assert.throws(
    () =>
      mergeOraclePublicationRecords(signed, {
        ...signed,
        attestation: { ...fixture.artifact, eventJson: ` ${fixture.artifact.eventJson}` },
      }),
    /artifact conflicts/,
  )
})

test('restore accepts reordered metadata while retaining the exact signed event bytes', () => {
  const fixture = oracleFixture()
  const previous: OraclePublicationRecord = {
    binding: fixture.binding,
    chosenOutcome: 'YES',
    attestation: fixture.artifact,
    relayPublished: true,
    engineEvidence: fixture.evidence,
    explanationEventJson: null,
    explanationRelayPublished: false,
  }
  const incoming = {
    ...previous,
    attestation: {
      eventJson: fixture.artifact.eventJson,
      attestationHex: fixture.artifact.attestationHex,
    },
    engineEvidence: Object.fromEntries(Object.entries(fixture.evidence).reverse()),
  } as OraclePublicationRecord
  assert.deepEqual(mergeOraclePublicationRecords(previous, incoming), previous)
})

function harness() {
  const fixture = oracleFixture()
  let saved: OraclePublicationRecord | null = null
  const calls: string[] = []
  const sent: string[] = []
  function retain(record: OraclePublicationRecord) {
    saved = structuredClone(record)
    return structuredClone(record)
  }
  const adapters: OraclePublicationAdapters = {
    store: {
      async read() {
        return structuredClone(saved)
      },
      async saveChoice(binding, outcome) {
        calls.push('save-choice')
        return retain({
          binding,
          chosenOutcome: outcome,
          attestation: null,
          relayPublished: false,
          engineEvidence: null,
          explanationEventJson: null,
          explanationRelayPublished: false,
        })
      },
      async saveAttestation(_, artifact) {
        calls.push('save-attestation')
        return retain({ ...saved!, attestation: artifact })
      },
      async saveExplanation(_, eventJson) {
        calls.push('save-explanation')
        return retain({ ...saved!, explanationEventJson: eventJson })
      },
      async confirmRelay() {
        calls.push('save-relay')
        return retain({ ...saved!, relayPublished: true })
      },
      async confirmEngine(_, evidence) {
        calls.push('save-engine')
        return retain({ ...saved!, engineEvidence: evidence })
      },
      async confirmExplanationRelay() {
        calls.push('save-explanation-relay')
        return retain({ ...saved!, explanationRelayPublished: true })
      },
    },
    async prepareAttestation() {
      calls.push('prepare')
      return fixture.artifact
    },
    async verifyAttestation() {
      calls.push('verify')
      return fixture.evidence
    },
    async publishRelay(json) {
      const event = JSON.parse(json)
      calls.push(event.kind === 1111 ? 'explanation-relay' : 'relay')
      sent.push(json)
      return { eventId: event.id }
    },
    async submitEngine(_, json) {
      calls.push('engine')
      sent.push(json)
      return fixture.evidence
    },
    async prepareExplanation(context, content) {
      calls.push('prepare-explanation')
      return signedExplanation(context, content)
    },
  }
  return {
    ...fixture,
    adapters,
    calls,
    sent,
    reload: () => structuredClone(saved),
    retain,
  }
}

test('relay-only publication skips engine contact and later synchronizes the exact saved event', async () => {
  const h = harness()
  h.adapters.submitEngine = async (_, json) => {
    h.calls.push('engine')
    h.sent.push(json)
    return h.evidence
  }
  const first = await publishOracleOutcome(h.adapters, h.binding, 'YES', undefined, {
    engineDelivery: 'relay-only',
  })
  assert.equal(h.calls.includes('engine'), false)
  assert.equal(first.record.relayPublished, true)
  assert.equal(first.record.engineEvidence, null)
  assert.equal(first.failures.length, 0)
  h.adapters.prepareAttestation = async () => {
    throw new Error('Signer unavailable after restore')
  }
  const second = await retryOraclePublication(h.adapters, h.binding)
  assert.equal(second.record.engineEvidence?.attestationEventId, h.evidence.attestationEventId)
  assert.equal(h.sent.length, 2)
  assert.equal(
    h.sent[0] === h.artifact.eventJson && h.sent[1] === h.artifact.eventJson,
    true,
    'Saved artifact changed.',
  )
})

test('an invalid delivery mode refuses before local signing or external effects', async () => {
  const h = harness()
  await assert.rejects(
    publishOracleOutcome(h.adapters, h.binding, 'YES', undefined, {
      engineDelivery: 'unknown' as 'relay-only',
    }),
    /delivery mode is invalid/,
  )
  assert.equal(h.calls.length, 0)
  assert.equal(h.reload(), null)
})

test('choice and exact signed events are saved before any delivery', async () => {
  const h = harness()
  const result = await publishOracleOutcome(h.adapters, h.binding, 'YES', 'The result is YES.')
  assert.deepEqual(h.calls, [
    'save-choice',
    'prepare',
    'verify',
    'save-attestation',
    'verify',
    'prepare-explanation',
    'save-explanation',
    'relay',
    'save-relay',
    'engine',
    'save-engine',
    'explanation-relay',
    'save-explanation-relay',
  ])
  assert.deepEqual(result.failures, [])
  assert.equal(h.sent[0], h.artifact.eventJson)
  assert.equal(h.sent[1], h.artifact.eventJson)
  assert.equal(h.sent[2], result.record.explanationEventJson)
  assert.equal(result.record.engineEvidence?.attestationEventId, h.evidence.attestationEventId)
})

test('choice save and attestation save failures prevent all external effects', async () => {
  for (const stage of ['saveChoice', 'saveAttestation'] as const) {
    const h = harness()
    h.adapters.store[stage] = async () => {
      h.calls.push('failed-save')
      throw new Error('Store unavailable')
    }
    await assert.rejects(publishOracleOutcome(h.adapters, h.binding, 'YES'), /Store unavailable/)
    assert.equal(h.sent.length, 0)
    assert.equal(h.calls.includes('engine'), false)
    if (stage === 'saveChoice') assert.equal(h.calls.includes('prepare'), false)
    else assert.equal(h.reload()?.chosenOutcome, 'YES')
  }
})

test('a false successful attestation save also prevents delivery', async () => {
  const h = harness()
  h.adapters.store.saveAttestation = async () => h.reload()!
  await assert.rejects(publishOracleOutcome(h.adapters, h.binding, 'YES'), /not saved/)
  assert.equal(h.sent.length, 0)
})

test('immutable outcome choice survives interrupted preparation', async () => {
  const h = harness()
  h.adapters.prepareAttestation = async () => {
    throw new Error('Interrupted local signing')
  }
  await assert.rejects(publishOracleOutcome(h.adapters, h.binding, 'YES'), /Interrupted/)
  assert.equal(h.reload()?.chosenOutcome, 'YES')
  await assert.rejects(publishOracleOutcome(h.adapters, h.binding, 'NO'), /conflicts/)
  assert.equal(h.sent.length, 0)
})

test('relay failure does not prevent engine success or lose signed artifacts', async () => {
  const h = harness()
  h.adapters.publishRelay = async () => {
    h.calls.push('relay-failed')
    throw new Error('Relay unavailable')
  }
  const result = await publishOracleOutcome(h.adapters, h.binding, 'YES')
  assert.deepEqual(result.failures, ['relay'])
  assert.equal(result.record.relayPublished, false)
  assert.equal(result.record.engineEvidence?.outcome, 'YES')
  assert.equal(h.reload()?.attestation?.eventJson, h.artifact.eventJson)
  assert.equal(h.calls.indexOf('relay-failed') < h.calls.indexOf('engine'), true)
})

test('engine failure retains relay success and reload retries the exact saved event', async () => {
  const h = harness()
  h.adapters.submitEngine = async (_, json) => {
    h.sent.push(json)
    h.calls.push('engine-failed')
    throw new Error('Engine unavailable')
  }
  const first = await publishOracleOutcome(h.adapters, h.binding, 'YES')
  assert.deepEqual(first.failures, ['engine'])
  assert.equal(first.record.relayPublished, true)
  assert.equal(first.record.engineEvidence, null)
  const persisted = JSON.parse(JSON.stringify(h.reload())) as OraclePublicationRecord
  h.retain(persisted)
  h.adapters.prepareAttestation = async () => {
    throw new Error('Retry must not sign')
  }
  h.adapters.submitEngine = async (_, json) => {
    h.sent.push(json)
    return h.evidence
  }
  const retried = await retryOraclePublication(h.adapters, h.binding)
  assert.deepEqual(retried.failures, [])
  assert.equal(retried.record.engineEvidence?.attestationEventId, h.evidence.attestationEventId)
  assert.equal(h.sent.length, 3)
  assert.equal(
    h.sent.every((json) => json === h.artifact.eventJson),
    true,
  )
  assert.equal(h.calls.filter((call) => call === 'prepare').length, 1)
  assert.equal(h.calls.filter((call) => call === 'relay').length, 1)
})

test('generic engine success and matching HTTP shape are not verified evidence', async () => {
  for (const evidence of [
    { result: 'Closed' },
    { ...oracleFixture().evidence, outcome: 'NO' },
    { ...oracleFixture().evidence, attestationEventId: 'f'.repeat(64) },
  ]) {
    const h = harness()
    h.adapters.submitEngine = async () => evidence as never
    const result = await publishOracleOutcome(h.adapters, h.binding, 'YES')
    assert.deepEqual(result.failures, ['engine'])
    assert.equal(result.record.engineEvidence, null)
    assert.equal(h.reload()?.relayPublished, true)
  }
})

test('foreign signer, outcome evidence, parent, or artifact body is rejected before saving', async () => {
  for (const change of ['signer', 'outcome', 'parent', 'body'] as const) {
    const h = harness()
    if (change === 'outcome')
      h.adapters.verifyAttestation = async () => ({
        ...h.evidence,
        outcome: 'NO',
      })
    else
      h.adapters.prepareAttestation = async () => ({
        attestationHex: h.artifact.attestationHex,
        eventJson: JSON.stringify(
          finalizeEvent(
            {
              kind: 89,
              created_at: 1_700_000_001,
              tags: [['e', change === 'parent' ? 'f'.repeat(64) : h.announcement.id]],
              content: change === 'body' ? 'AA==' : h.attestation.content,
            },
            change === 'signer' ? otherOracleTestKey : oracleTestKey,
          ),
        ),
      })
    await assert.rejects(publishOracleOutcome(h.adapters, h.binding, 'YES'), /foreign|binding|body/)
    assert.equal(h.calls.includes('save-attestation'), false)
    assert.equal(h.sent.length, 0)
  }
})

test('a different announcement or registered condition cannot replace the saved binding', async () => {
  const h = harness()
  await publishOracleOutcome(h.adapters, h.binding, 'YES')
  const announcement = finalizeEvent(
    { kind: 88, created_at: 9, tags: [], content: h.announcement.content },
    oracleTestKey,
  )
  await assert.rejects(
    publishOracleOutcome(
      h.adapters,
      { ...h.binding, announcementEventJson: JSON.stringify(announcement) },
      'YES',
    ),
    /conflicts/,
  )
  await assert.rejects(
    publishOracleOutcome(h.adapters, { ...h.binding, conditionId: 'f'.repeat(64) }, 'YES'),
    /binding/,
  )
})

test('companion preparation or save failure leaves resolution valid and sends no unsaved companion', async () => {
  for (const change of ['sign', 'save', 'text', 'signer'] as const) {
    const h = harness()
    if (change === 'sign')
      h.adapters.prepareExplanation = async () => {
        throw new Error('Companion signing unavailable')
      }
    if (change === 'save')
      h.adapters.store.saveExplanation = async () => {
        throw new Error('Companion store unavailable')
      }
    if (change === 'signer')
      h.adapters.prepareExplanation = async (context, content) => {
        const event = JSON.parse(signedExplanation(context, content))
        return JSON.stringify(finalizeEvent(event, otherOracleTestKey))
      }
    const result = await publishOracleOutcome(
      h.adapters,
      h.binding,
      'YES',
      change === 'text' ? '界'.repeat(1_366) : 'Result explanation',
    )
    assert.deepEqual(result.failures, ['explanation-preparation'])
    assert.equal(result.record.engineEvidence?.outcome, 'YES')
    assert.equal(result.record.relayPublished, true)
    assert.equal(result.record.explanationEventJson, null)
    assert.equal(h.sent.length, 2)
  }
})

test('companion publication failure and exact companion retry do not alter accepted resolution', async () => {
  const h = harness()
  const publish = h.adapters.publishRelay
  h.adapters.publishRelay = async (json) => {
    if (JSON.parse(json).kind === 1111) {
      h.sent.push(json)
      throw new Error('Companion relay unavailable')
    }
    return publish(json)
  }
  const first = await publishOracleOutcome(h.adapters, h.binding, 'YES', 'Result explanation')
  assert.deepEqual(first.failures, ['explanation-relay'])
  assert.equal(first.record.engineEvidence?.outcome, 'YES')
  assert.equal(first.record.explanationRelayPublished, false)
  h.adapters.prepareExplanation = async () => {
    throw new Error('Retry must not sign companion')
  }
  h.adapters.publishRelay = publish
  const retried = await retryOraclePublication(h.adapters, h.binding)
  assert.deepEqual(retried.failures, [])
  assert.equal(retried.record.explanationRelayPublished, true)
  assert.equal(retried.record.explanationEventJson, first.record.explanationEventJson)
  assert.equal(h.sent[2], h.sent[3])
  const changed = await publishOracleOutcome(h.adapters, h.binding, 'YES', 'Changed explanation')
  assert.deepEqual(changed.failures, ['explanation-preparation'])
  assert.equal(changed.record.explanationEventJson, first.record.explanationEventJson)
})

test('delivery confirmation save failures do not block the other destination', async () => {
  const h = harness()
  h.adapters.store.confirmRelay = async () => {
    throw new Error('Progress store unavailable')
  }
  const result = await publishOracleOutcome(h.adapters, h.binding, 'YES')
  assert.deepEqual(result.failures, ['relay'])
  assert.equal(result.record.engineEvidence?.outcome, 'YES')
  assert.equal(result.record.attestation?.eventJson, h.artifact.eventJson)
})

test('tampered saved artifacts fail validation on reload before any retry effect', async () => {
  const h = harness()
  await publishOracleOutcome(h.adapters, h.binding, 'YES')
  const stored = h.reload()!
  h.retain({
    ...stored,
    attestation: { ...stored.attestation!, attestationHex: 'aacc' },
  })
  h.sent.length = 0
  await assert.rejects(retryOraclePublication(h.adapters, h.binding), /body/)
  assert.equal(h.sent.length, 0)
})

test('loaded records retain their immutable binding regardless of object property order', async () => {
  const h = harness()
  await publishOracleOutcome(h.adapters, h.binding, 'YES')
  const stored = h.reload()!
  h.retain({
    ...stored,
    binding: {
      outcomes: [...h.binding.outcomes],
      oraclePubkey: h.binding.oraclePubkey,
      oracleEventId: h.binding.oracleEventId,
      announcementEventJson: h.binding.announcementEventJson,
      conditionId: h.binding.conditionId,
    },
  })
  const snapshot = snapshotOraclePublicationRecord(h.reload()!)
  assert.equal(snapshot.attestation?.eventJson, h.artifact.eventJson)
  const result = await retryOraclePublication(h.adapters, h.binding)
  assert.deepEqual(result.failures, [])
  assert.equal(h.sent.length, 2)
})

test('a false choice save or regressing confirmation cannot authorize delivery progress', async () => {
  const h = harness()
  const saveChoice = h.adapters.store.saveChoice
  h.adapters.store.saveChoice = async (binding, outcome) => ({
    ...(await saveChoice(binding, outcome)),
    chosenOutcome: 'NO',
  })
  await assert.rejects(publishOracleOutcome(h.adapters, h.binding, 'YES'), /conflicts/)
  assert.equal(h.calls.includes('prepare'), false)
  const other = harness()
  other.adapters.store.confirmEngine = async () => ({
    ...other.reload()!,
    relayPublished: false,
    engineEvidence: other.evidence,
  })
  const result = await publishOracleOutcome(other.adapters, other.binding, 'YES')
  assert.deepEqual(result.failures, ['engine'])
  assert.equal(result.record.relayPublished, true)
  assert.equal(result.record.engineEvidence, null)
})

test('wrong relay acknowledgment cannot confirm publication but engine still runs', async () => {
  const h = harness()
  h.adapters.publishRelay = async () => ({ eventId: 'f'.repeat(64) })
  const result = await publishOracleOutcome(h.adapters, h.binding, 'YES')
  assert.deepEqual(result.failures, ['relay'])
  assert.equal(result.record.relayPublished, false)
  assert.equal(result.record.engineEvidence?.outcome, 'YES')
  assert.equal(h.calls.includes('save-relay'), false)
})

test('false companion save cannot publish an unsaved event or block accepted resolution', async () => {
  const h = harness()
  h.adapters.store.saveExplanation = async () => h.reload()!
  const result = await publishOracleOutcome(h.adapters, h.binding, 'YES', 'Result explanation')
  assert.deepEqual(result.failures, ['explanation-preparation'])
  assert.equal(result.record.engineEvidence?.outcome, 'YES')
  assert.equal(h.sent.length, 2)
})

test('all verified preparation evidence fields must match the immutable publication', async () => {
  for (const name of [
    'conditionId',
    'oracleEventId',
    'oraclePubkey',
    'outcome',
    'announcementEventId',
    'attestationEventId',
  ] as const) {
    const h = harness()
    h.adapters.verifyAttestation = async () => ({
      ...h.evidence,
      [name]: 'foreign',
    })
    await assert.rejects(publishOracleOutcome(h.adapters, h.binding, 'YES'), /foreign/)
    assert.equal(h.sent.length, 0)
    assert.equal(h.calls.includes('save-attestation'), false)
  }
})

test('companion delivery remains independent when both resolution destinations fail', async () => {
  const h = harness()
  const publish = h.adapters.publishRelay
  h.adapters.publishRelay = async (json) => {
    if (JSON.parse(json).kind === 89) throw new Error('Attestation relay unavailable')
    return publish(json)
  }
  h.adapters.submitEngine = async () => {
    throw new Error('Engine unavailable')
  }
  const result = await publishOracleOutcome(h.adapters, h.binding, 'YES', 'Result explanation')
  assert.deepEqual(result.failures, ['relay', 'engine'])
  assert.equal(result.record.relayPublished, false)
  assert.equal(result.record.engineEvidence, null)
  assert.equal(result.record.explanationRelayPublished, true)
  assert.equal(result.record.attestation?.eventJson, h.artifact.eventJson)
})
