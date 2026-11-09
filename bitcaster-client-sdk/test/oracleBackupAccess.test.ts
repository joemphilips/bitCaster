import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { finalizeEvent, getPublicKey, verifiedSymbol, verifyEvent } from 'nostr-tools/pure'
import { announcementContentFromTlv } from '../src/oracleAnnouncementEncoding.ts'
import { deriveDlcConditionId } from '../src/managedConditionInventory.ts'
import {
  createOracleBackupEvent,
  type OracleBackupRecord,
  type OracleBackupValidator,
} from '../src/oracleBackup.ts'
import {
  listOracleBackups,
  fetchCurrentOracleBackupSelection,
  restoreOracleBackupEnvelope,
  oracleBackupStatus,
  OracleBackupAccessError,
  ORACLE_BACKUP_SCAN_FRAME_BYTES_MAX,
  type OracleBackupRelayQuery,
} from '../src/oracleBackupAccess.ts'
import {
  admitOracleBackupSource,
  buildTerminalOracleBackupRecord,
  prepareOracleBackupDelivery,
  confirmOracleBackupDelivery,
  commitOracleBackupDelivery,
  OracleBackupDeliveryError,
} from '../src/oracleBackupDelivery.ts'
import type { OraclePublicationRecord } from '../src/oraclePublication.ts'
import { oracleTestKey, otherOracleTestKey } from './fixtures/oraclePublication.ts'

const tlv =
  'fdd824b127bb6f385afbef8d72af2a01ec50392df5d018ecb97244b3c04bb238fe3e050844767221012e8fe49eab82ebb3548d3ab6ed791a5cf044e09e508cb08fe749414f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aafdd8224d00011d86bc78a6d350059044168a50be4c3bda71b7a86d015a9ce253a2f419f445b477359400fdd80609000203594553024e4f1962726f777365722d6f7261636c652d72656772657373696f6e'
function fixture() {
  const oraclePubkey = getPublicKey(oracleTestKey)
  const oracleEventId = 'browser-oracle-regression'
  const announcement = finalizeEvent(
    { kind: 88, created_at: 1, tags: [], content: announcementContentFromTlv(tlv)! },
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
      relayUrls: ['wss://relay.example'],
    },
  }
  let validations = 0
  const validator: OracleBackupValidator = {
    async validateAuthority() {
      validations++
      return {
        eventId: oracleEventId,
        oraclePubkey,
        outcomes: ['YES', 'NO'],
        noncePoint: '1d86bc78a6d350059044168a50be4c3bda71b7a86d015a9ce253a2f419f445b4',
      }
    },
  }
  const attestation = finalizeEvent(
    { kind: 89, created_at: 2, tags: [['e', announcement.id]], content: 'qrs=' },
    oracleTestKey,
  )
  const publication: OraclePublicationRecord = {
    binding: {
      conditionId: record.conditionId,
      oraclePubkey,
      oracleEventId,
      outcomes: ['YES', 'NO'],
      announcementEventJson: record.authority.announcementEventJson,
    },
    chosenOutcome: 'YES',
    attestation: { attestationHex: 'aabb', eventJson: JSON.stringify(attestation) },
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
  return {
    record,
    validator,
    publication,
    terminal,
    validations: () => validations,
    event: (createdAt: number, r = record) =>
      createOracleBackupEvent({ record: r, privateKey: oracleTestKey, validator, createdAt }),
  }
}
const relay = 'wss://relay.example'
const input = (f: ReturnType<typeof fixture>) => ({
  privateKey: oracleTestKey,
  validator: f.validator,
  relayUrls: [relay],
})
const source = (id = 'aa'.repeat(32), createdAt = 100) => ({
  eventId: id,
  createdAt,
  sourceRelay: relay,
})
const safe = (reason: OracleBackupAccessError['reason']) => (error: unknown) => {
  assert.equal(error instanceof OracleBackupAccessError, true, 'Expected safe access error.')
  assert.equal((error as OracleBackupAccessError).reason, reason)
  assert.equal((error as Error).message, `Private oracle backup access: ${reason}.`)
  return true
}

test('restore authenticates fresh envelope and returns safe metadata separately from authority', async () => {
  const f = fixture()
  const event = await f.event(100)
  const restored = await restoreOracleBackupEnvelope({ ...input(f), event, sourceRelay: relay })
  assert.equal(isDeepStrictEqual(restored.record, f.record), true, 'Private authority changed.')
  assert.equal(restored.source.eventId, event.id)
  assert.equal(restored.source.createdAt, 100)
  assert.equal(restored.descriptor.outcomes.join(','), 'YES,NO')
  assert.equal(restored.descriptor.state, 'unresolved')
  const json = JSON.stringify(restored.descriptor)
  assert.equal(json.includes('nonceScalarHex'), false)
  assert.equal(json.includes(event.content), false)
  await assert.rejects(
    restoreOracleBackupEnvelope({
      ...input(f),
      event,
      privateKey: otherOracleTestKey,
      sourceRelay: relay,
    }),
    safe('wrong-owner'),
  )
  const tampered = { ...event, content: 'A'.repeat(132) }
  await assert.rejects(
    restoreOracleBackupEnvelope({ ...input(f), event: tampered, sourceRelay: relay }),
    safe('invalid-envelope'),
  )
  f.validator.validateAuthority = async () => {
    throw new Error(f.record.authority.nonceScalarHex!)
  }
  await assert.rejects(
    restoreOracleBackupEnvelope({ ...input(f), event, sourceRelay: relay }),
    safe('invalid-envelope'),
  )
})

test('discovery scans the oldest bucket but lists only the newest observed identity', async () => {
  const f = fixture()
  const recent = await f.event(20)
  const oldest = await f.event(10)
  const sameTime = await f.event(10)
  const queries: OracleBackupRelayQuery[] = []
  const before = f.validations()
  const page = await listOracleBackups({
    ...input(f),
    relayUrls: ['wss://z.example', relay],
    queryRelay: async (q) => {
      queries.push(q)
      return {
        events: queries.length === 1 ? [recent, oldest] : [oldest, sameTime],
        complete: true,
      }
    },
  })
  assert.equal(queries.length, 2)
  assert.equal(queries[0].relayUrl, relay)
  assert.equal(queries[0].filter.limit, 32)
  assert.equal(queries[0].filter['#v'], undefined)
  assert.equal('d' in queries[0].filter, false)
  assert.equal(queries[1].filter.since, 10)
  assert.equal(queries[1].filter.until, 10)
  assert.equal(queries[1].filter.limit, 128)
  assert.equal(page.descriptors.length, 1)
  assert.equal(page.descriptors[0].backupEventId, recent.id)
  assert.equal(f.validations() - before, 3)
  assert.equal(page.cursor!.until, 9)
  assert.equal(page.observedRelayComplete, false)
  assert.equal(page.discovery, 'relay-dependent')
  assert.equal(page.partialReasons.includes('relay-dependent-history'), true)
  assert.equal(JSON.stringify(page.cursor).includes('nonce'), false)
  assert.equal(
    queries.every((q) => q.signal.aborted),
    true,
  )
})

test('unrelated authenticated NIP-78 records do not prevent automatic oracle recovery', async () => {
  const f = fixture()
  const backup = await f.event(20)
  const unrelated = finalizeEvent(
    {
      kind: 30078,
      created_at: 10,
      tags: [['d', 'bitcaster:creator-markets']],
      content: 'opaque unrelated application record',
    },
    oracleTestKey,
  )
  const before = f.validations()
  const queries: OracleBackupRelayQuery[] = []
  const page = await listOracleBackups({
    ...input(f),
    queryRelay: async (query) => {
      queries.push(query)
      return { events: queries.length === 1 ? [backup, unrelated] : [unrelated], complete: true }
    },
  })
  assert.equal(page.descriptors.length, 1)
  assert.equal(page.descriptors[0].backupEventId, backup.id)
  assert.deepEqual(page.partialReasons, ['relay-dependent-history'])
  assert.equal(queries[1].filter.since, 10)
  assert.equal(queries[1].filter.until, 10)
  assert.equal(page.cursor?.until, 9)
  assert.equal(f.validations() - before, 1)
})

test('unrelated-only NIP-78 page advances to older oracle history without authority validation', async () => {
  const f = fixture()
  const unrelated = finalizeEvent(
    {
      kind: 30078,
      created_at: 20,
      tags: [['d', 'other-app:settings']],
      content: 'opaque unrelated application record',
    },
    oracleTestKey,
  )
  const backup = await f.event(10)
  const before = f.validations()
  const queries: OracleBackupRelayQuery[] = []
  const first = await listOracleBackups({
    ...input(f),
    queryRelay: async (query) => {
      queries.push(query)
      return { events: [unrelated], complete: true }
    },
  })
  assert.deepEqual(first.partialReasons, ['relay-dependent-history'])
  assert.equal(first.descriptors.length, 0)
  assert.equal(first.observedRelayComplete, false)
  assert.equal(first.cursor?.until, 19)
  assert.equal(queries.length, 2)
  assert.equal(queries[1].filter.since, 20)
  assert.equal(f.validations(), before)
  const next = await listOracleBackups({
    ...input(f),
    cursor: first.cursor,
    queryRelay: async (query) => {
      if (query.filter.since === undefined) assert.equal(query.filter.until, 19)
      return { events: [backup], complete: true }
    },
  })
  assert.deepEqual(next.partialReasons, ['relay-dependent-history'])
  assert.equal(next.descriptors[0].backupEventId, backup.id)
})

test('authenticated malformed claimed oracle envelopes are not skipped as unrelated records', async () => {
  const f = fixture()
  const backup = await f.event(20)
  const before = f.validations()
  for (const tags of [
    [backup.tags[0], backup.tags[1], ['extra', 'value']],
    [['d', 'other-app:settings'], backup.tags[0], backup.tags[1]],
    [[backup.tags[0][0], backup.tags[0][1], 'extra'], backup.tags[1]],
  ]) {
    const malformed = finalizeEvent({ ...backup, tags }, oracleTestKey)
    const page = await listOracleBackups({
      ...input(f),
      queryRelay: async () => ({ events: [malformed], complete: true }),
    })
    assert.equal(page.descriptors.length, 0)
    assert.equal(page.partialReasons.includes('invalid-candidates'), true)
    assert.equal(f.validations(), before)
  }
})

test('cached verification cannot authenticate forged unrelated timestamps or advance a scan', async () => {
  const f = fixture()
  const unrelated = finalizeEvent(
    { kind: 30078, created_at: 100, tags: [['d', 'other-app:settings']], content: 'unrelated' },
    oracleTestKey,
  )
  const forged = { ...unrelated, created_at: 0 }
  assert.equal(forged[verifiedSymbol], true)
  assert.equal(verifyEvent(forged), true, 'The fixture must retain the library verification cache.')
  const cursor = {
    schemaVersion: 1 as const,
    author: f.record.oraclePubkey,
    relayUrls: [relay],
    relayIndex: 0,
    until: 200,
  }
  const before = f.validations()
  let queries = 0
  const page = await listOracleBackups({
    ...input(f),
    cursor,
    queryRelay: async () => {
      queries++
      return { events: [forged], complete: true }
    },
  })
  assert.equal(queries, 1)
  assert.equal(page.descriptors.length, 0)
  assert.equal(page.partialReasons.includes('invalid-candidates'), true)
  assert.equal(page.observedRelayComplete, false)
  assert.deepEqual(page.cursor, cursor)
  assert.equal(f.validations(), before)
})

test('cursor binds author and deterministic relay set; each relay starts with unset time', async () => {
  const f = fixture()
  const event = await f.event(0)
  let calls = 0
  const page = await listOracleBackups({
    ...input(f),
    relayUrls: ['wss://z.example', relay],
    queryRelay: async () => {
      calls++
      return { events: [event], complete: true }
    },
  })
  assert.equal(calls, 2)
  assert.equal(page.observedRelayComplete, true)
  assert.equal(page.cursor!.relayIndex, 1)
  assert.equal(page.cursor!.until, null)
  const last = await listOracleBackups({
    ...input(f),
    relayUrls: [relay, 'wss://z.example'],
    cursor: page.cursor,
    queryRelay: async (q) => {
      assert.equal(q.filter.until, undefined)
      return { events: [], complete: true }
    },
  })
  assert.equal(last.cursor, null)
  assert.equal(last.discovery, 'relay-dependent')
  for (const cursor of [
    { ...page.cursor!, author: '00'.repeat(32) },
    { ...page.cursor!, until: -1 },
    { ...page.cursor!, relayIndex: 2 },
    { ...page.cursor!, secret: 'not-allowed' },
  ])
    await assert.rejects(
      listOracleBackups({
        ...input(f),
        relayUrls: [relay, 'wss://z.example'],
        cursor,
        queryRelay: async () => {
          throw new Error('Must not run')
        },
      }),
      safe('invalid-cursor'),
    )
})

test('saturated duplicate bucket counts raw replies and refuses timestamp advancement', async () => {
  const f = fixture()
  const event = await f.event(100)
  let queries = 0
  const before = f.validations()
  const page = await listOracleBackups({
    ...input(f),
    queryRelay: async () => ({
      events: ++queries === 1 ? [event] : Array.from({ length: 128 }, () => event),
      complete: true,
    }),
  })
  assert.equal(page.descriptors.length, 1)
  assert.equal(f.validations() - before, 1)
  assert.equal(page.cursor!.until, null)
  assert.equal(page.partialReasons.includes('saturated-bucket'), true)
})

test('author kind and time filters are enforced locally before validator work', async () => {
  const f = fixture()
  const event = await f.event(100)
  const good = await f.event(90)
  const cursor = {
    schemaVersion: 1 as const,
    author: f.record.oraclePubkey,
    relayUrls: [relay],
    relayIndex: 0,
    until: 100,
  }
  const foreign = finalizeEvent({ ...event }, otherOracleTestKey)
  const wrongKind = finalizeEvent({ ...event, kind: 88 }, oracleTestKey)
  const wrongTime = await f.event(101)
  let calls = 0
  const before = f.validations()
  const page = await listOracleBackups({
    ...input(f),
    cursor,
    queryRelay: async () => ({
      events: ++calls === 1 ? [foreign, wrongKind, wrongTime, good] : [event, good],
      complete: true,
    }),
  })
  assert.equal(page.descriptors.length, 1)
  assert.equal(f.validations() - before, 1)
  assert.equal(page.cursor!.until, 89)
  assert.equal(page.partialReasons.includes('invalid-candidates'), true)
})

test('newest authenticated unsupported version suppresses old signing authority', async () => {
  const f = fixture()
  const old = await f.event(10)
  const future = finalizeEvent(
    { ...old, created_at: 20, tags: [old.tags[0], ['v', '3']] },
    oracleTestKey,
  )
  let calls = 0
  const page = await listOracleBackups({
    ...input(f),
    queryRelay: async (query) => {
      assert.equal(query.filter['#v'], undefined)
      return { events: ++calls === 1 ? [old, future] : [old], complete: true }
    },
  })
  assert.equal(page.descriptors.length, 0)
  assert.equal(page.partialReasons.includes('unsupported-version'), true)
})

test('terminal compact history blocks newer unresolved legacy authority in either arrival order', async () => {
  const f = fixture()
  const terminal = await createOracleBackupEvent({
    record: f.terminal,
    privateKey: oracleTestKey,
    createdAt: 10,
    validator: f.validator,
    writeVersion: 2,
  })
  const stale = await f.event(20)
  for (const events of [
    [terminal, stale],
    [stale, terminal],
  ]) {
    let queries = 0
    const page = await listOracleBackups({
      ...input(f),
      queryRelay: async () => ({ events: ++queries === 1 ? events : [terminal], complete: true }),
    })
    assert.equal(page.descriptors.length, 0)
    assert.equal(page.partialReasons.includes('lifecycle-regression'), true)
    await assert.rejects(
      fetchCurrentOracleBackupSelection({
        ...input(f),
        author: f.record.oraclePubkey,
        eventId: stale.id,
        sourceRelay: relay,
        queryRelay: async (q) => ({ events: q.filter.ids ? [stale] : events, complete: true }),
      }),
      safe('lifecycle-regression'),
    )
  }
})

test('selection rechecks stable identity across relays before importing an exact ID', async () => {
  const f = fixture()
  const old = await f.event(10)
  const recent = await f.event(20)
  const otherRelay = 'wss://other.example'
  const queries: OracleBackupRelayQuery[] = []
  const queryRelay = async (query: OracleBackupRelayQuery) => {
    queries.push(query)
    return {
      events: query.filter.ids ? [old] : query.relayUrl === otherRelay ? [recent] : [old],
      complete: true,
    }
  }
  await assert.rejects(
    fetchCurrentOracleBackupSelection({
      ...input(f),
      author: f.record.oraclePubkey,
      eventId: old.id,
      sourceRelay: relay,
      relayUrls: [relay, otherRelay],
      queryRelay,
    }),
    safe('stale-source'),
  )
  assert.equal(queries[0].filter.ids?.[0], old.id)
  assert.equal(
    queries.slice(1).every((q) => q.filter['#d']?.[0] === old.tags[0][1]),
    true,
  )
  assert.equal(
    queries.every((q) => q.filter['#v'] === undefined),
    true,
  )
})

test('selection refuses authenticated unsupported newest and incomplete observations', async () => {
  const f = fixture()
  const selected = await f.event(10)
  const future = finalizeEvent(
    { ...selected, created_at: 20, tags: [selected.tags[0], ['v', '3']] },
    oracleTestKey,
  )
  const base = {
    ...input(f),
    author: f.record.oraclePubkey,
    eventId: selected.id,
    sourceRelay: relay,
    relayUrls: [relay],
  }
  await assert.rejects(
    fetchCurrentOracleBackupSelection({
      ...base,
      queryRelay: async (q) => ({ events: q.filter.ids ? [selected] : [future], complete: true }),
    }),
    safe('unsupported-version'),
  )
  await assert.rejects(
    fetchCurrentOracleBackupSelection({
      ...base,
      queryRelay: async (q) => ({ events: [selected], complete: q.filter.ids !== undefined }),
    }),
    safe('incomplete-query'),
  )
  const observed = await fetchCurrentOracleBackupSelection({
    ...base,
    queryRelay: async () => ({
      events: [selected, { ...future, sig: '00'.repeat(64) }],
      complete: true,
    }),
  })
  assert.equal(observed.id, selected.id)
})

test('optional offline relays do not block a healthy source, but partial positive evidence does', async () => {
  const f = fixture()
  const selected = await f.event(10)
  const future = finalizeEvent(
    { ...selected, created_at: 20, tags: [selected.tags[0], ['v', '3']] },
    oracleTestKey,
  )
  const optional = 'wss://optional.example'
  const base = {
    ...input(f),
    author: f.record.oraclePubkey,
    eventId: selected.id,
    sourceRelay: relay,
    relayUrls: [optional, relay],
  }
  const observed = await fetchCurrentOracleBackupSelection({
    ...base,
    queryRelay: async (q) => {
      if (q.relayUrl === optional) throw new Error('offline')
      return { events: [selected], complete: true }
    },
  })
  assert.equal(observed.id, selected.id)
  await assert.rejects(
    fetchCurrentOracleBackupSelection({
      ...base,
      queryRelay: async (q) =>
        q.relayUrl === optional
          ? { events: [future], complete: false }
          : { events: [selected], complete: true },
    }),
    safe('unsupported-version'),
  )
})

test('selection bounds aggregate raw replies across optional relays', async () => {
  const f = fixture()
  const selected = await f.event(10)
  await assert.rejects(
    fetchCurrentOracleBackupSelection({
      ...input(f),
      author: f.record.oraclePubkey,
      eventId: selected.id,
      sourceRelay: relay,
      relayUrls: [relay, ...Array.from({ length: 7 }, (_, index) => `wss://r${index}.example`)],
      queryRelay: async (q) =>
        q.relayUrl === relay
          ? { events: [selected], complete: true }
          : {
              events: Array.from({ length: 30 }, () => ({ invalid: 'x'.repeat(90_000) })),
              complete: false,
            },
    }),
    safe('incomplete-query'),
  )
})

test('query failures incomplete EOSE bounds and abort preserve the input cursor', async () => {
  const f = fixture()
  const event = await f.event(100)
  for (const queryRelay of [
    async () => {
      throw new Error('PRIVATE TRANSPORT DETAIL')
    },
    async () => ({ events: [event], complete: false }),
    async () => ({ events: Array.from({ length: 33 }, () => event), complete: true }),
    async () => ({
      events: [{ ...event, content: 'x'.repeat(ORACLE_BACKUP_SCAN_FRAME_BYTES_MAX) }],
      complete: true,
    }),
  ]) {
    const page = await listOracleBackups({ ...input(f), queryRelay })
    assert.equal(page.cursor!.until, null)
    assert.equal(page.observedRelayComplete, false)
    assert.equal(JSON.stringify(page).includes('PRIVATE'), false)
  }
  const abort = new AbortController()
  abort.abort()
  let calls = 0
  const stopped = await listOracleBackups({
    ...input(f),
    signal: abort.signal,
    queryRelay: async () => {
      calls++
      return { events: [], complete: true }
    },
  })
  assert.equal(calls, 0)
  assert.equal(stopped.partialReasons.includes('deadline'), true)
})

test('source admission is provenance only; terminal restore requires no local acknowledgments', async () => {
  const f = fixture()
  const event = await f.event(100, f.terminal)
  const restored = await restoreOracleBackupEnvelope({ ...input(f), event, sourceRelay: relay })
  const state = admitOracleBackupSource({
    record: restored.record,
    source: restored.source,
    previous: null,
  })
  assert.equal(state.current, null)
  assert.equal(state.terminalAdmission, null)
  assert.equal(state.deletion, null)
  assert.equal(state.terminalCommitPending, false)
  assert.equal(state.knownEventIds[0], event.id)
  assert.equal(state.timestampHighWater, 100)
  assert.equal(restored.descriptor.state, 'terminal')
  const prepared = await prepareOracleBackupDelivery({
    record: f.terminal,
    previous: state,
    privateKey: oracleTestKey,
    validator: f.validator,
    nowSeconds: 10,
  })
  assert.equal(prepared.timestampHighWater, 101)
  assert.equal(prepared.current!.mode, 'terminal')
  const status = oracleBackupStatus({
    binding: f.publication.binding,
    destinations: f.record.destinations,
    publication: f.publication,
    importComplete: true,
    delivery: state,
  })
  assert.equal(status.preparationPending, true)
  assert.equal(status.publication.relayPublished, true)
  assert.equal(status.terminal.prepared, false)
  assert.equal(status.terminal.localCommitPending, false)
  assert.equal(JSON.stringify(status).includes('eventJson'), false)
})

test('retained duplicate stays idempotent; unknown source refuses frozen stage without mutation', async () => {
  const f = fixture()
  const first = admitOracleBackupSource({ record: f.record, source: source(), previous: null })
  const initial = await prepareOracleBackupDelivery({
    record: f.record,
    previous: first,
    privateKey: oracleTestKey,
    validator: f.validator,
    nowSeconds: 101,
  })
  const terminal = await prepareOracleBackupDelivery({
    record: f.terminal,
    previous: initial,
    privateKey: oracleTestKey,
    validator: f.validator,
    nowSeconds: 102,
  })
  const before = structuredClone(terminal)
  const duplicate = admitOracleBackupSource({
    record: f.terminal,
    source: source(),
    previous: terminal,
  })
  assert.equal(isDeepStrictEqual(duplicate, terminal), true, 'Duplicate changed progress.')
  assert.throws(
    () =>
      admitOracleBackupSource({
        record: f.terminal,
        source: source('bb'.repeat(32), 103),
        previous: terminal,
      }),
    (error) => {
      assert.equal(error instanceof OracleBackupDeliveryError, true)
      assert.equal(
        (error as OracleBackupDeliveryError).reason,
        'terminal-backup-source-not-admitted',
      )
      return true
    },
  )
  assert.equal(isDeepStrictEqual(before, terminal), true, 'Refusal mutated delivery state.')
  const currentSource = source(terminal.current!.eventId, terminal.timestampHighWater)
  assert.equal(
    isDeepStrictEqual(
      admitOracleBackupSource({ record: f.terminal, source: currentSource, previous: terminal }),
      terminal,
    ),
    true,
    'Current source was not idempotent.',
  )
  assert.equal(
    admitOracleBackupSource({
      record: f.terminal,
      source: source('bb'.repeat(32), 103),
      previous: null,
    }).current,
    null,
  )
})

test('source capacity reserves local initial slot; cleanup preserves timestamp high-water', async () => {
  const f = fixture()
  let state = admitOracleBackupSource({ record: f.record, source: source(), previous: null })
  for (let i = 1; i < 63; i++)
    state = admitOracleBackupSource({
      record: f.record,
      source: source(i.toString(16).padStart(64, '0'), 100 + i),
      previous: state,
    })
  assert.equal(state.knownEventIds.length, 63)
  assert.throws(
    () =>
      admitOracleBackupSource({
        record: f.record,
        source: source('bb'.repeat(32), 200),
        previous: state,
      }),
    (error) => (error as OracleBackupDeliveryError).reason === 'overflow',
  )
  const initial = await prepareOracleBackupDelivery({
    record: f.record,
    previous: state,
    privateKey: oracleTestKey,
    validator: f.validator,
    nowSeconds: 200,
  })
  const terminal = await prepareOracleBackupDelivery({
    record: f.terminal,
    previous: initial,
    privateKey: oracleTestKey,
    validator: f.validator,
    nowSeconds: 201,
  })
  assert.equal(terminal.knownEventIds.length, 64)
  const backed = confirmOracleBackupDelivery(terminal, {
    kind: 'backup',
    eventId: terminal.current!.eventId,
    relayUrl: relay,
  })
  const deleted = confirmOracleBackupDelivery(backed, {
    kind: 'deletion',
    eventId: backed.deletion!.eventId,
    relayUrl: relay,
  })
  const committed = commitOracleBackupDelivery(deleted, deleted.terminalAdmission!, f.publication)
  assert.equal(committed.knownEventIds.length, 0)
  assert.equal(committed.timestampHighWater >= 201, true)
})

test('status reconstructs incomplete pending no-relay and replacement progress without private bytes', async () => {
  const f = fixture()
  const common = {
    binding: f.publication.binding,
    destinations: f.record.destinations,
    publication: null,
    importComplete: false,
    delivery: null,
  }
  const pending = oracleBackupStatus(common)
  assert.equal(pending.importComplete, false)
  assert.equal(pending.preparationPending, true)
  assert.equal(pending.initial.prepared, false)
  const none = oracleBackupStatus({
    ...common,
    destinations: { ...f.record.destinations, relayUrls: [] },
    importComplete: true,
  })
  assert.equal(none.noRelays, true)
  const initial = await prepareOracleBackupDelivery({
    record: f.record,
    previous: null,
    privateKey: oracleTestKey,
    validator: f.validator,
    nowSeconds: 100,
  })
  const ack = confirmOracleBackupDelivery(initial, {
    kind: 'backup',
    eventId: initial.current!.eventId,
    relayUrl: relay,
  })
  const replaced = oracleBackupStatus({
    ...common,
    importComplete: true,
    publication: f.publication,
    delivery: ack,
  })
  assert.equal(replaced.initial.acknowledgedRelays, 1)
  assert.equal(replaced.terminal.prepared, false)
  assert.equal(replaced.preparationPending, true)
  const terminal = await prepareOracleBackupDelivery({
    record: f.terminal,
    previous: ack,
    privateKey: oracleTestKey,
    validator: f.validator,
    nowSeconds: 101,
  })
  const status = oracleBackupStatus({
    ...common,
    importComplete: true,
    publication: f.publication,
    delivery: terminal,
  })
  assert.equal(status.terminal.prepared, true)
  assert.equal(status.terminal.deletionRequired, true)
  assert.equal(status.terminal.localCommitPending, true)
  assert.equal(status.preparationPending, false)
  assert.equal(JSON.stringify(status).includes('nonce'), false)
  assert.equal(JSON.stringify(status).includes('eventJson'), false)
  assert.throws(
    () =>
      oracleBackupStatus({
        ...common,
        delivery: initial,
        destinations: { ...f.record.destinations, relayUrls: ['wss://foreign.example'] },
      }),
    safe('local-state'),
  )
})

test('abort during core validation schedules no more validators and preserves continuation', async () => {
  const f = fixture()
  const first = await f.event(100)
  const second = await f.event(90)
  const controller = new AbortController()
  let validationCalls = 0
  f.validator.validateAuthority = async () => {
    validationCalls++
    controller.abort()
    // The core port has no cancellation contract. Only this one operation can remain active.
    return new Promise(() => {})
  }
  const page = await listOracleBackups({
    ...input(f),
    signal: controller.signal,
    queryRelay: async () => ({ events: [first, second], complete: true }),
  })
  assert.equal(validationCalls, 1)
  assert.equal(page.descriptors.length, 0)
  assert.equal(page.partialReasons.includes('deadline'), true)
  assert.equal(page.cursor!.until, null)
})

test('source binding and original relays refuse conflicts without altering provenance', () => {
  const f = fixture()
  const state = admitOracleBackupSource({ record: f.record, source: source(), previous: null })
  const before = structuredClone(state)
  for (const record of [
    { ...f.record, conditionId: '00'.repeat(32) },
    {
      ...f.record,
      destinations: { ...f.record.destinations, relayUrls: ['wss://foreign.example'] },
    },
  ])
    assert.throws(
      () => admitOracleBackupSource({ record, source: source('bb'.repeat(32)), previous: state }),
      (error) => (error as OracleBackupDeliveryError).reason === 'conflict',
    )
  assert.equal(isDeepStrictEqual(state, before), true, 'Conflict altered source provenance.')
})

test('unauthenticated timestamp zero cannot terminate an observed relay scan', async () => {
  const f = fixture()
  const valid = await f.event(100)
  const forgedZero = { ...valid, created_at: 0 }
  let queries = 0
  const page = await listOracleBackups({
    ...input(f),
    queryRelay: async (q) => {
      queries++
      if (queries === 2) assert.equal(q.filter.since, 100)
      return { events: queries === 1 ? [forgedZero, valid] : [valid], complete: true }
    },
  })
  assert.equal(page.descriptors.length, 1)
  assert.equal(page.observedRelayComplete, false)
  assert.equal(page.cursor!.until, 99)
  assert.equal(page.partialReasons.includes('invalid-candidates'), true)
})
