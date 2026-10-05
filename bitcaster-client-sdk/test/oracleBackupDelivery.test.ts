import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { announcementContentFromTlv } from '../src/oracleAnnouncementEncoding.ts'
import { deriveDlcConditionId } from '../src/managedConditionInventory.ts'
import {
  createOracleBackupEvent,
  decryptOracleBackupEvent,
  type OracleBackupRecord,
  type OracleBackupValidator,
} from '../src/oracleBackup.ts'
import {
  assertOracleBackupDeliveryOwner,
  buildTerminalOracleBackupRecord,
  commitOracleBackupDelivery,
  confirmOracleBackupDelivery,
  deliverOracleBackup,
  OracleBackupDeliveryError,
  prepareOracleBackupDelivery,
  retryOracleBackupDelivery,
  snapshotOracleBackupDeliveryState,
  type OracleBackupDeliveryState,
  type OracleBackupDeliveryStore,
} from '../src/oracleBackupDelivery.ts'
import type { OraclePublicationRecord } from '../src/oraclePublication.ts'
import { oracleTestKey } from './fixtures/oraclePublication.ts'

const tlv =
  'fdd824b127bb6f385afbef8d72af2a01ec50392df5d018ecb97244b3c04bb238fe3e050844767221012e8fe49eab82ebb3548d3ab6ed791a5cf044e09e508cb08fe749414f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aafdd8224d00011d86bc78a6d350059044168a50be4c3bda71b7a86d015a9ce253a2f419f445b477359400fdd80609000203594553024e4f1962726f777365722d6f7261636c652d72656772657373696f6e'
const now = 1_800_000_010
function fixture(relayUrls = ['wss://relay-one.example', 'wss://relay-two.example']) {
  const oraclePubkey = getPublicKey(oracleTestKey)
  const oracleEventId = 'browser-oracle-regression'
  const announcement = finalizeEvent(
    { kind: 88, created_at: now - 10, tags: [], content: announcementContentFromTlv(tlv)! },
    oracleTestKey,
  )
  const record: OracleBackupRecord = {
    schemaVersion: 1,
    oraclePubkey,
    oracleEventId,
    conditionId: deriveDlcConditionId({
      eventId: oracleEventId,
      outcomeCount: 2,
      oraclePublicKeys: [oraclePubkey],
    }),
    authority: {
      schemaVersion: 1,
      announcementTlvHex: tlv,
      announcementEventJson: JSON.stringify(announcement),
      nonceScalarHex: '01'.repeat(32),
      signedOutcome: null,
      attestationHex: null,
      attestationEventJson: null,
      publicationRecordJson: null,
    },
    destinations: {
      mintUrl: 'https://mint.example',
      engineUrl: 'https://engine.example',
      relayUrls,
    },
  }
  const validator: OracleBackupValidator = {
    async validateAuthority() {
      return {
        eventId: oracleEventId,
        oraclePubkey,
        outcomes: ['YES', 'NO'],
        noncePoint: '1d86bc78a6d350059044168a50be4c3bda71b7a86d015a9ce253a2f419f445b4',
      }
    },
  }
  const event = finalizeEvent(
    { kind: 89, created_at: now - 1, tags: [['e', announcement.id]], content: 'qrs=' },
    oracleTestKey,
  )
  const publication: OraclePublicationRecord = {
    binding: {
      conditionId: record.conditionId,
      oracleEventId,
      oraclePubkey,
      outcomes: ['YES', 'NO'],
      announcementEventJson: record.authority.announcementEventJson,
    },
    chosenOutcome: 'YES',
    attestation: { attestationHex: 'aabb', eventJson: JSON.stringify(event) },
    relayPublished: true,
    engineEvidence: null,
    explanationEventJson: null,
    explanationRelayPublished: false,
  }
  const terminal = buildTerminalOracleBackupRecord({
    binding: publication.binding,
    announcementTlvHex: tlv,
    destinations: record.destinations,
    publication,
  })
  return { record, terminal, publication, validator, announcement }
}
function prepare(
  f: ReturnType<typeof fixture>,
  previous: OracleBackupDeliveryState | null = null,
  terminal = false,
  clock = now,
) {
  return prepareOracleBackupDelivery({
    record: terminal ? f.terminal : f.record,
    previous,
    privateKey: oracleTestKey,
    validator: f.validator,
    nowSeconds: clock,
  })
}
function safeError(reason: OracleBackupDeliveryError['reason']) {
  return (error: unknown) => {
    assert.equal(error instanceof OracleBackupDeliveryError, true, 'Expected fixed delivery error.')
    assert.equal((error as OracleBackupDeliveryError).reason, reason)
    assert.equal((error as Error).message, `Private oracle backup delivery: ${reason}.`)
    return true
  }
}
function memoryStore(initial: OracleBackupDeliveryState, f: ReturnType<typeof fixture>) {
  let state = initial
  let failedCommit = false
  let failedConfirmation = false
  const store: OracleBackupDeliveryStore = {
    async read() {
      return structuredClone(state)
    },
    async prepare() {
      return structuredClone(state)
    },
    async confirm(_id, ack) {
      if (failedConfirmation) throw new Error('PRIVATE HELPER INPUT')
      state = confirmOracleBackupDelivery(state, ack)
      return structuredClone(state)
    },
    async commitTerminal(_id, admission) {
      if (failedCommit) throw new Error('PRIVATE HELPER INPUT')
      state = commitOracleBackupDelivery(state, admission, f.publication)
      return structuredClone(state)
    },
  }
  return {
    store,
    read: () => state,
    failCommit: (value: boolean) => {
      failedCommit = value
    },
    failConfirmation: (value: boolean) => {
      failedConfirmation = value
    },
  }
}

test('stages exact encrypted bytes and signer-free retry never prepares or encrypts progress', async () => {
  const f = fixture()
  const initial = await prepare(f)
  const store = memoryStore(initial, f)
  const sent: string[] = []
  store.store.prepare = async () => {
    throw new Error('Signer must not run.')
  }
  const adapters = {
    store: store.store,
    async publishRelay(relayUrl: string, eventJson: string) {
      sent.push(eventJson)
      return { relayUrl, eventId: JSON.parse(eventJson).id }
    },
  }
  store.failConfirmation(true)
  const first = await retryOracleBackupDelivery(adapters, f.record.conditionId)
  assert.equal(first.failures.join(','), 'backup-relay')
  store.failConfirmation(false)
  const retried = await retryOracleBackupDelivery(adapters, f.record.conditionId)
  assert.equal(retried.failures.length, 0)
  assert.equal(sent.length, 4)
  assert.equal(
    sent.every((value) => value === initial.current!.eventJson),
    true,
    'Saved ciphertext changed.',
  )
  const progress = await prepare(f, store.read())
  assert.equal(
    isDeepStrictEqual(progress, store.read()),
    true,
    'Initial progress made another version.',
  )
})

test('wrong relay/event and late initial acknowledgments refuse without terminal regression', async () => {
  const f = fixture()
  const initial = await prepare(f)
  for (const ack of [
    {
      kind: 'backup' as const,
      eventId: '00'.repeat(32),
      relayUrl: f.record.destinations.relayUrls[0],
    },
    {
      kind: 'backup' as const,
      eventId: initial.current!.eventId,
      relayUrl: 'wss://foreign.example',
    },
    {
      kind: 'foreign' as 'backup',
      eventId: initial.current!.eventId,
      relayUrl: f.record.destinations.relayUrls[0],
    },
  ])
    assert.throws(
      () => confirmOracleBackupDelivery(initial, ack),
      safeError('invalid-acknowledgment'),
    )
  const terminal = await prepare(f, initial, true)
  assert.throws(
    () =>
      confirmOracleBackupDelivery(terminal, {
        kind: 'backup',
        eventId: initial.current!.eventId,
        relayUrl: f.record.destinations.relayUrls[0],
      }),
    safeError('invalid-acknowledgment'),
  )
  await assert.rejects(prepare(f, terminal), safeError('conflict'))
})

test('replacement timestamp exceeds ties, rollback and authenticated observations; overflow refuses', async () => {
  const f = fixture()
  const initial = await prepare(f)
  for (const clock of [now, now - 100]) {
    const terminal = await prepare(f, initial, true, clock)
    assert.equal(JSON.parse(terminal.current!.eventJson).created_at, now + 1)
  }
  const overflow = snapshotOracleBackupDeliveryState({
    ...initial,
    timestampHighWater: Number.MAX_SAFE_INTEGER,
  })
  await assert.rejects(prepare(f, overflow, true), safeError('overflow'))
  const observed = await createOracleBackupEvent({
    record: f.record,
    privateKey: oracleTestKey,
    createdAt: now + 100,
    validator: f.validator,
  })
  const staged = await prepareOracleBackupDelivery({
    record: f.record,
    previous: null,
    privateKey: oracleTestKey,
    validator: f.validator,
    nowSeconds: now,
    observedEvents: [observed],
  })
  assert.equal(JSON.parse(staged.current!.eventJson).created_at, now + 101)
  assert.equal(staged.knownEventIds[0], observed.id)
  const foreign = finalizeEvent({ ...observed, content: 'A'.repeat(132) }, oracleTestKey)
  await assert.rejects(
    prepareOracleBackupDelivery({
      record: f.record,
      previous: null,
      privateKey: oracleTestKey,
      validator: f.validator,
      nowSeconds: now,
      observedEvents: [foreign],
    }),
    safeError('invalid-source'),
  )
})

test('terminal DTO retains exact publication, nulls scalar, and needs no engine or explanation', async () => {
  const f = fixture()
  const initial = await prepare(f)
  const terminal = await prepare(f, initial, true)
  const restored = await decryptOracleBackupEvent({
    event: JSON.parse(terminal.current!.eventJson),
    privateKey: oracleTestKey,
    validator: f.validator,
  })
  assert.equal(restored.authority.nonceScalarHex, null)
  assert.equal(
    restored.authority.attestationEventJson === f.publication.attestation!.eventJson,
    true,
    'Exact public artifact changed.',
  )
  assert.equal(
    restored.authority.publicationRecordJson === f.terminal.authority.publicationRecordJson,
    true,
    'Exact publication changed.',
  )
  assert.equal(terminal.current!.generation, 2)
  assert.equal(terminal.knownEventIds[0], initial.current!.eventId)
  const retained = await prepare(f, terminal, true, now + 200)
  assert.equal(
    isDeepStrictEqual(retained, terminal),
    true,
    'Terminal progress regenerated ciphertext.',
  )
  for (const publication of [
    { ...f.publication, relayPublished: false },
    { ...f.publication, attestation: null },
  ]) {
    assert.throws(
      () =>
        buildTerminalOracleBackupRecord({
          binding: f.publication.binding,
          announcementTlvHex: tlv,
          destinations: f.record.destinations,
          publication,
        }),
      safeError('terminal-not-ready'),
    )
  }
  await assert.rejects(
    prepareOracleBackupDelivery({
      record: f.record,
      previous: null,
      privateKey: null,
      validator: f.validator,
      nowSeconds: now,
    }),
    safeError('preparation-key-unavailable'),
  )
})

test('per-relay replacement acknowledgments gate exact e-only deletion and partial retry', async () => {
  const f = fixture()
  const terminal = await prepare(f, await prepare(f), true)
  const deletion = JSON.parse(terminal.deletion!.eventJson)
  assert.equal(
    deletion.tags.some(([name]: string[]) => name === 'a'),
    false,
  )
  assert.equal(
    JSON.stringify(deletion.tags),
    JSON.stringify([
      ['e', terminal.knownEventIds[0]],
      ['k', '30078'],
    ]),
  )
  assert.throws(
    () =>
      confirmOracleBackupDelivery(terminal, {
        kind: 'deletion',
        eventId: deletion.id,
        relayUrl: terminal.relayUrls[0],
      }),
    safeError('invalid-acknowledgment'),
  )
  const store = memoryStore(terminal, f)
  const calls: string[] = []
  let secondOffline = true
  const adapters = {
    store: store.store,
    async publishRelay(relayUrl: string, eventJson: string) {
      const event = JSON.parse(eventJson)
      calls.push(`${relayUrl}:${event.kind}`)
      if (secondOffline && relayUrl === terminal.relayUrls[1]) throw new Error('PRIVATE TRANSPORT')
      return { relayUrl, eventId: event.id }
    },
  }
  const first = await retryOracleBackupDelivery(adapters, f.record.conditionId)
  assert.equal(first.failures.join(','), 'backup-relay')
  assert.equal(
    calls.join(','),
    `${terminal.relayUrls[0]}:30078,${terminal.relayUrls[1]}:30078,${terminal.relayUrls[0]}:5`,
  )
  assert.equal(first.state!.deletion!.acknowledgedRelayIndexes.join(','), '0')
  assert.equal(first.state!.terminalCommitPending, false)
  secondOffline = false
  const second = await retryOracleBackupDelivery(adapters, f.record.conditionId)
  assert.equal(second.failures.length, 0)
  assert.equal(second.state!.deletion, null)
  assert.equal(second.state!.knownEventIds.length, 0)
  assert.equal(second.state!.timestampHighWater, now + 1)
  assert.equal(second.state!.terminalAdmission!.backupEventId, terminal.current!.eventId)
})

test('failed terminal mutation remains pending and succeeds on signer-free reload', async () => {
  const f = fixture()
  const terminal = await prepare(f, await prepare(f), true)
  const store = memoryStore(terminal, f)
  store.failCommit(true)
  const adapters = {
    store: store.store,
    async publishRelay(relayUrl: string, eventJson: string) {
      return { relayUrl, eventId: JSON.parse(eventJson).id }
    },
  }
  const first = await retryOracleBackupDelivery(adapters, f.record.conditionId)
  assert.equal(first.failures.join(','), 'terminal-commit')
  assert.equal(first.state!.terminalCommitPending, true)
  store.failCommit(false)
  store.store.prepare = async () => {
    throw new Error('Signer absent.')
  }
  adapters.publishRelay = async () => {
    throw new Error('Already saved acknowledgments must not publish.')
  }
  const next = await retryOracleBackupDelivery(adapters, f.record.conditionId)
  assert.equal(next.failures.length, 0)
  assert.equal(next.state!.terminalCommitPending, false)
})

test('bounds reserve terminal history, enforce original destinations and actual UTF-8 state bytes', async () => {
  const f = fixture()
  const initial = await prepare(f)
  const knownEventIds = Array.from({ length: 63 }, (_, i) => (i + 1).toString(16).padStart(64, '0'))
  const full = snapshotOracleBackupDeliveryState({ ...initial, knownEventIds })
  const terminal = await prepare(f, full, true)
  assert.equal(terminal.knownEventIds.length, 64)
  assert.throws(
    () => snapshotOracleBackupDeliveryState({ ...initial, knownEventIds: terminal.knownEventIds }),
    safeError('invalid-state'),
  )
  await assert.rejects(
    prepare(fixture(Array.from({ length: 65 }, (_, i) => `wss://relay-${i}.example`))),
    safeError('invalid-state'),
  )
  assert.throws(
    () => snapshotOracleBackupDeliveryState({ ...initial, extra: '界'.repeat(90_000) }),
    safeError('oversized'),
  )
  const sameOwner = {
    binding: f.publication.binding,
    relayUrls: initial.relayUrls,
    publication: f.publication,
  }
  assertOracleBackupDeliveryOwner(initial, sameOwner)
  assertOracleBackupDeliveryOwner(terminal, sameOwner)
  assert.throws(
    () =>
      assertOracleBackupDeliveryOwner(terminal, {
        ...sameOwner,
        publication: { ...f.publication, relayPublished: false },
      }),
    safeError('conflict'),
  )
  assert.throws(
    () => assertOracleBackupDeliveryOwner(initial, { ...sameOwner, relayUrls: [] }),
    safeError('conflict'),
  )
  assert.throws(
    () => commitOracleBackupDelivery(terminal, terminal.terminalAdmission!, f.publication),
    safeError('terminal-not-ready'),
  )
})

test('readback failure and helper diagnostics stay fixed before any external effect', async () => {
  const f = fixture()
  const initial = await prepare(f)
  const store = memoryStore(initial, f)
  let sent = 0
  store.store.read = async () => null
  const result = await deliverOracleBackup(
    {
      store: store.store,
      async publishRelay() {
        sent++
        throw new Error('SECRET CIPHERTEXT')
      },
    },
    f.record.conditionId,
  )
  assert.equal(result.failures.join(','), 'preparation')
  assert.equal(sent, 0)
  await assert.rejects(
    prepareOracleBackupDelivery({
      record: f.record,
      previous: null,
      privateKey: oracleTestKey,
      validator: {
        async validateAuthority() {
          throw new Error('PRIVATE SCALAR')
        },
      },
      nowSeconds: now,
    }),
    safeError('invalid-source'),
  )
  const empty = await prepare(fixture([]))
  const emptyStore = memoryStore(empty, fixture([]))
  const pending = await retryOracleBackupDelivery(
    {
      store: emptyStore.store,
      async publishRelay() {
        sent++
        throw new Error()
      },
    },
    empty.binding.conditionId,
  )
  assert.equal(pending.failures.join(','), 'no-relays')
  assert.equal(sent, 0)
})

test('foreign transport acknowledgments never become durable progress', async () => {
  const f = fixture()
  const initial = await prepare(f)
  for (const mismatch of ['event', 'relay']) {
    const store = memoryStore(initial, f)
    const result = await retryOracleBackupDelivery(
      {
        store: store.store,
        async publishRelay(relayUrl: string) {
          return {
            relayUrl: mismatch === 'relay' ? 'wss://foreign.example' : relayUrl,
            eventId: mismatch === 'event' ? '00'.repeat(32) : initial.current!.eventId,
          }
        },
      },
      f.record.conditionId,
    )
    assert.equal(result.failures.join(','), 'backup-relay')
    assert.equal(store.read().current!.acknowledgedRelayIndexes.length, 0)
  }
})

test('deletion confirmation failure retries exact saved request after reload', async () => {
  const f = fixture(['wss://relay-one.example'])
  const terminal = await prepare(f, await prepare(f), true)
  const store = memoryStore(terminal, f)
  const confirm = store.store.confirm
  let failed = true
  store.store.confirm = async (id, ack) => {
    if (failed && ack.kind === 'deletion') throw new Error('PRIVATE SAVE INPUT')
    return confirm(id, ack)
  }
  const deletionBytes: string[] = []
  const adapters = {
    store: store.store,
    async publishRelay(relayUrl: string, eventJson: string) {
      const event = JSON.parse(eventJson)
      if (event.kind === 5) deletionBytes.push(eventJson)
      return { relayUrl, eventId: event.id }
    },
  }
  const first = await retryOracleBackupDelivery(adapters, f.record.conditionId)
  assert.equal(first.failures.join(','), 'deletion-relay')
  assert.equal(store.read().deletion!.acknowledgedRelayIndexes.length, 0)
  assert.equal(store.read().knownEventIds.length, 1)
  failed = false
  store.store.prepare = async () => {
    throw new Error('Signer absent.')
  }
  const second = await retryOracleBackupDelivery(adapters, f.record.conditionId)
  assert.equal(second.failures.length, 0)
  assert.equal(deletionBytes.length, 2)
  assert.equal(
    deletionBytes.every((value) => value === terminal.deletion!.eventJson),
    true,
    'Deletion retry changed bytes.',
  )
})

test('only full authenticated backup provenance can reserve observed IDs', async () => {
  const f = fixture()
  const observed = await createOracleBackupEvent({
    record: f.record,
    privateKey: oracleTestKey,
    createdAt: now + 40,
    validator: f.validator,
  })
  let validations = 0
  const refusedValidator = {
    async validateAuthority() {
      validations++
      if (validations === 2) throw new Error('SECRET CORE INPUT')
      return f.validator.validateAuthority('', f.record.oraclePubkey)
    },
  }
  await assert.rejects(
    prepareOracleBackupDelivery({
      record: f.record,
      previous: null,
      privateKey: oracleTestKey,
      validator: refusedValidator,
      nowSeconds: now,
      observedEvents: [observed],
    }),
    safeError('invalid-source'),
  )
  assert.equal(validations, 2)
  const prepared = await prepare(f)
  assert.throws(
    () => snapshotOracleBackupDeliveryState({ ...prepared, timestampHighWater: -1 }),
    safeError('invalid-state'),
  )
  assert.throws(
    () =>
      snapshotOracleBackupDeliveryState({
        ...prepared,
        current: { ...prepared.current, generation: 2 },
      }),
    safeError('invalid-state'),
  )
  assert.throws(
    () =>
      snapshotOracleBackupDeliveryState({
        ...prepared,
        terminalAdmission: {
          backupEventId: prepared.current!.eventId,
          announcementEventId: f.announcement.id,
          attestationEventId: JSON.parse(f.publication.attestation!.eventJson).id,
          generation: 2,
        },
      }),
    safeError('invalid-state'),
  )
})

test('delivery bounds relay fanout at four and merges every exact acknowledgment', async () => {
  const f = fixture(Array.from({ length: 9 }, (_, i) => `wss://relay-${i}.example`))
  const initial = await prepare(f)
  const store = memoryStore(initial, f)
  let active = 0
  let peak = 0
  let sent = 0
  const result = await retryOracleBackupDelivery(
    {
      store: store.store,
      async publishRelay(relayUrl: string, eventJson: string) {
        active++
        peak = Math.max(peak, active)
        sent++
        await new Promise<void>((resolve) => setImmediate(resolve))
        active--
        return { relayUrl, eventId: JSON.parse(eventJson).id }
      },
    },
    f.record.conditionId,
  )
  assert.equal(result.failures.length, 0)
  assert.equal(peak, 4)
  assert.equal(sent, 9)
  assert.equal(result.state!.current!.acknowledgedRelayIndexes.join(','), '0,1,2,3,4,5,6,7,8')
})
