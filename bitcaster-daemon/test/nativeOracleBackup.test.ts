import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { getPublicKey } from 'nostr-tools/pure'
import {
  decryptOracleBackupEvent,
  deriveDlcConditionId,
  type OracleBackupRecord,
  type OraclePrivateAuthority,
} from '@bitcaster-market/client-sdk'
import { bootstrapFreshDaemonProfile, readProfileSecretAuthority } from '../src/profileBootstrap.ts'
import { createDaemonStateSqliteSession } from '../src/stateSqlite.ts'
import { createNativeOracleCreationStore } from '../src/nativeOracleCreationStore.ts'
import {
  createNativeOracleHelperAdapter,
  type NativeOracleHelper,
} from '../src/nativeOracleHelper.ts'
import { prepareNativeMarketOracle } from '../src/nativeMarketOracle.ts'
import { publishNativeMarketOutcome } from '../src/nativeOraclePublicationCoordinator.ts'
import { publishNativeOracleBackup, retryNativeOracleBackup } from '../src/nativeOracleBackup.ts'

const executable = process.env.BITCASTER_TEST_NATIVE_ORACLE_HELPER
const helper = createNativeOracleHelperAdapter({ resolveExecutable: () => executable! })
const realHelper = {
  skip:
    executable === undefined
      ? 'Set BITCASTER_TEST_NATIVE_ORACLE_HELPER to the explicit prebuilt native helper.'
      : false,
}
const signer = '01'.repeat(32)
const publicKey = getPublicKey(Buffer.from(signer, 'hex'))
const destinations = {
  mintUrl: 'https://mint.example',
  engineUrl: 'https://engine.example',
  relayUrls: ['wss://first.example', 'wss://second.example'],
}
type Store = ReturnType<typeof createNativeOracleCreationStore>

async function importedFixture(eventId: string): Promise<OracleBackupRecord> {
  const announced = await helper.createEnum({
    oracleSecretKeyHex: signer,
    nonceSeedHex: '02'.repeat(32),
    reservedNonceIndex: 257,
    eventId,
    outcomes: ['Yes', 'No'],
    eventMaturityEpoch: 2_000_000_000,
    title: 'Test',
    description: 'Test event.',
  })
  const authority = JSON.parse(
    await helper.exportEnumAuthority({
      oracleSecretKeyHex: signer,
      nonceSeedHex: '02'.repeat(32),
      reservedNonceIndex: 257,
      announcementTlvHex: announced.announcementTlvHex,
      announcementEventJson: announced.announcementNostrEventJson,
      signedOutcome: null,
      attestationHex: null,
      attestationEventJson: null,
      publicationRecordJson: null,
    }),
  ) as OraclePrivateAuthority
  return {
    schemaVersion: 1,
    oraclePubkey: publicKey,
    oracleEventId: eventId,
    authority,
    destinations,
    conditionId: deriveDlcConditionId({ eventId, outcomeCount: 2, oraclePublicKeys: [publicKey] }),
  }
}

async function withOwner(
  kind: 'created' | 'imported',
  run: (directory: string, store: Store, conditionId: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'oracle-delivery-provider-'))
  const directory = join(root, 'profile')
  try {
    await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: destinations.engineUrl,
      mintUrl: destinations.mintUrl,
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: signer,
    })
    const store = createNativeOracleCreationStore(directory)
    let conditionId: string
    if (kind === 'imported') {
      const backup = await importedFixture('imported-delivery')
      await store.importBackup(backup, helper)
      conditionId = backup.conditionId
    } else {
      const secrets = await createDaemonStateSqliteSession(directory).read((database) =>
        readProfileSecretAuthority(database),
      )
      const created = await prepareNativeMarketOracle(
        {
          store,
          helper,
          oracleSecretKeyHex: signer,
          nonceSeedHex: secrets.nativeOracleNonceSeedHex,
        },
        {
          creationId: 'created-delivery',
          eventId: 'created-delivery-event',
          market: {
            title: 'Test',
            description: 'Test event.',
            outcomeType: 'yesno',
            outcomeDetails: [{ name: 'Yes' }, { name: 'No' }],
            maturityEpoch: 2_000_000_000,
            categoryTags: [],
            baseAsset: 'sat',
          },
          registration: { requiredFeeMsat: 0 },
          destination: {
            mintUrl: destinations.mintUrl,
            engineBaseUrl: destinations.engineUrl,
            relayUrls: destinations.relayUrls,
          },
        },
      )
      conditionId = created.record.announcement!.conditionId
    }
    await run(directory, store, conditionId)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function resolve(directory: string, store: Store, conditionId: string) {
  const secrets = await createDaemonStateSqliteSession(directory).read((database) =>
    readProfileSecretAuthority(database),
  )
  return publishNativeMarketOutcome(
    {
      store,
      helper,
      async readSigner() {
        return { secretKeyHex: signer, nonceSeedHex: secrets.nativeOracleNonceSeedHex }
      },
      async publishRelay(eventJson) {
        return { eventId: JSON.parse(eventJson).id }
      },
      async submitEvent() {
        throw new Error('Engine is unavailable.')
      },
      async readResolution() {
        throw new Error('Engine is unavailable.')
      },
    },
    conditionId,
    'Yes',
    undefined,
    { engineDelivery: 'relay-only' },
  )
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

for (const kind of ['created', 'imported'] as const) {
  test(
    `real SQLite ${kind} exact backup reopens and merges partial relay progress without exposing envelopes`,
    realHelper,
    async () => {
      await withOwner(kind, async (directory, store, conditionId) => {
        const staged = await store.prepareBackupDelivery(conditionId, helper, 100)
        assert.equal(staged.current?.mode, 'initial')
        const published: string[] = []
        await retryNativeOracleBackup(
          {
            store,
            async publishRelay(relayUrl, eventJson) {
              published.push(eventJson)
              if (relayUrl === destinations.relayUrls[1]) throw new Error('Relay is unavailable.')
              return { eventId: JSON.parse(eventJson).id, relayUrl }
            },
          },
          conditionId,
        )
        const cold = createNativeOracleCreationStore(directory)
        const partial = (await cold.readBackupDelivery(conditionId))!
        assert.ok(
          partial.current!.eventJson === staged.current!.eventJson,
          'Reopen changed saved envelope.',
        )
        assert.deepEqual(partial.current!.acknowledgedRelayIndexes, [0])
        await retryNativeOracleBackup(
          {
            store: cold,
            async publishRelay(relayUrl, eventJson) {
              assert.equal(relayUrl, destinations.relayUrls[1])
              assert.ok(eventJson === staged.current!.eventJson, 'Retry changed saved envelope.')
              return { eventId: JSON.parse(eventJson).id, relayUrl }
            },
          },
          conditionId,
        )
        assert.deepEqual(
          (await cold.readBackupDelivery(conditionId))!.current!.acknowledgedRelayIndexes,
          [0, 1],
        )
        assert.ok(
          published.every((eventJson) => eventJson === staged.current!.eventJson),
          'Retry changed saved envelope.',
        )
        const ordinary = await cold.readAuthorityByConditionId(conditionId)
        for (const forbidden of [
          'backupDelivery',
          'backupDeliveryJson',
          'eventJson',
          'terminalAdmission',
        ])
          assert.equal(forbidden in ordinary!, false)
        const exported = await decryptOracleBackupEvent({
          event: JSON.parse(staged.current!.eventJson),
          privateKey: Buffer.from(signer, 'hex'),
          validator: helper,
        })
        assert.ok(
          exported.authority.nonceScalarHex !== null,
          'Initial backup lost nonce authority.',
        )
        await assert.rejects(
          cold.confirmBackupDelivery(conditionId, {
            kind: 'backup',
            eventId: 'ab'.repeat(32),
            relayUrl: destinations.relayUrls[0],
          }),
        )
        assert.equal(
          (await cold.readBackupDelivery(conditionId))!.current!.eventId,
          staged.current!.eventId,
        )
      })
    },
  )

  test(
    `real SQLite ${kind} competing asynchronous installers admit one exact stage`,
    realHelper,
    async () => {
      await withOwner(kind, async (directory, first, conditionId) => {
        const arrived = deferred(),
          release = deferred()
        let calls = 0
        const delayed: NativeOracleHelper = {
          ...helper,
          async validateAuthority(...args) {
            const result = await helper.validateAuthority(...args)
            if (++calls === 2) arrived.resolve()
            await release.promise
            return result
          },
        }
        const second = createNativeOracleCreationStore(directory)
        const results = Promise.allSettled([
          first.prepareBackupDelivery(conditionId, delayed, 100),
          second.prepareBackupDelivery(conditionId, delayed, 100),
        ])
        await arrived.promise
        release.resolve()
        const settled = await results
        assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1)
        assert.equal(settled.filter((result) => result.status === 'rejected').length, 1)
        const saved =
          (await createNativeOracleCreationStore(directory).readBackupDelivery(conditionId))!
        const winner = settled.find((result) => result.status === 'fulfilled')!
        assert.ok(
          winner.status === 'fulfilled' && isDeepStrictEqual(winner.value, saved),
          'Winning stage did not survive reload.',
        )
      })
    },
  )

  test(
    `real SQLite ${kind} helper preparation loses CAS to a durable signing choice`,
    realHelper,
    async () => {
      await withOwner(kind, async (directory, store, conditionId) => {
        const arrived = deferred(),
          release = deferred()
        const delayed: NativeOracleHelper = {
          ...helper,
          async validateAuthority(...args) {
            const result = await helper.validateAuthority(...args)
            arrived.resolve()
            await release.promise
            return result
          },
        }
        const preparing = store.prepareBackupDelivery(conditionId, delayed, 100)
        await arrived.promise
        await createNativeOracleCreationStore(directory).chooseAuthorityOutcome(conditionId, 'Yes')
        release.resolve()
        await assert.rejects(preparing, /conflict/)
        assert.ok(
          (await store.readBackupDelivery(conditionId)) === null,
          'Unexpected backup stage.',
        )
        assert.equal((await store.readAuthorityByConditionId(conditionId))!.chosenOutcome, 'Yes')
      })
    },
  )

  test(
    `real SQLite ${kind} terminal preparation loses CAS to prior-stage acknowledgment`,
    realHelper,
    async () => {
      await withOwner(kind, async (directory, store, conditionId) => {
        const initial = await store.prepareBackupDelivery(conditionId, helper, 100)
        await resolve(directory, store, conditionId)
        const arrived = deferred(),
          release = deferred()
        const delayed: NativeOracleHelper = {
          ...helper,
          async validateAuthority(...args) {
            const summary = await helper.validateAuthority(...args)
            arrived.resolve()
            await release.promise
            return summary
          },
        }
        const candidate = store.prepareBackupDelivery(conditionId, delayed, 101)
        await arrived.promise
        await createNativeOracleCreationStore(directory).confirmBackupDelivery(conditionId, {
          kind: 'backup',
          eventId: initial.current!.eventId,
          relayUrl: destinations.relayUrls[0],
        })
        release.resolve()
        await assert.rejects(candidate, /conflict/)
        const saved = (await store.readBackupDelivery(conditionId))!
        assert.equal(saved.current!.eventId, initial.current!.eventId)
        assert.deepEqual(saved.current!.acknowledgedRelayIndexes, [0])
        assert.equal(saved.terminalAdmission, null)
      })
    },
  )

  test(
    `real SQLite ${kind} schema rejects malformed delivery fields and reader validates signatures`,
    realHelper,
    async () => {
      await withOwner(kind, async (directory, store, conditionId) => {
        const stage = await store.prepareBackupDelivery(conditionId, helper, 100)
        const session = createDaemonStateSqliteSession(directory)
        const table = kind === 'created' ? 'daemon_oracle_creations' : 'daemon_oracle_imports'
        for (const invalid of [
          { ...stage, schemaVersion: 2 },
          { ...stage, timestampHighWater: -1 },
          { ...stage, terminalCommitPending: true },
          { ...stage, knownEventIds: ['bad'] },
          { ...stage, relayUrls: [...stage.relayUrls, stage.relayUrls[0]] },
          { ...stage, current: { ...stage.current, acknowledgedRelayIndexes: [64] } },
          { ...stage, current: { ...stage.current, acknowledgedRelayIndexes: [0, 0] } },
          { ...stage, authority: { nonceScalarHex: 'invalid' } },
        ])
          await assert.rejects(
            session.transaction((database) =>
              database
                .prepare(`UPDATE ${table} SET backup_delivery_json=? WHERE condition_id=?`)
                .run(JSON.stringify(invalid), conditionId),
            ),
          )
        assert.equal(
          (await store.readBackupDelivery(conditionId))!.current!.eventId,
          stage.current!.eventId,
        )
        // The production reader independently validates crypto after the SQL shape checks.
        const malformedEvent = { ...JSON.parse(stage.current!.eventJson), sig: '00'.repeat(64) }
        const malformed = {
          ...stage,
          current: { ...stage.current, eventJson: JSON.stringify(malformedEvent) },
        }
        await session.transaction((database) => {
          database.exec(`DROP TRIGGER ${table}_delivery_monotonic`)
          database
            .prepare(`UPDATE ${table} SET backup_delivery_json=? WHERE condition_id=?`)
            .run(JSON.stringify(malformed), conditionId)
        })
        await assert.rejects(store.readBackupDelivery(conditionId), /invalid-state/)
        await assert.rejects(store.readAuthorityByConditionId(conditionId), /invalid-state/)
        await assert.rejects(
          createNativeOracleCreationStore(directory).readBackupDelivery(conditionId),
          /schema does not match/,
        )
      })
    },
  )

  test(
    `real SQLite ${kind} terminal stage precedes nonce retirement and deletion follows each relay acknowledgment`,
    realHelper,
    async () => {
      await withOwner(kind, async (directory, store, conditionId) => {
        const initial = await store.prepareBackupDelivery(conditionId, helper, 100)
        await resolve(directory, store, conditionId)
        const exact = (await store.readAuthorityByConditionId(conditionId))!
        const terminal = await store.prepareBackupDelivery(conditionId, helper, 99)
        assert.equal(terminal.current!.mode, 'terminal')
        assert.ok(terminal.timestampHighWater > initial.timestampHighWater)
        const decoded = await decryptOracleBackupEvent({
          event: JSON.parse(terminal.current!.eventJson),
          privateKey: Buffer.from(signer, 'hex'),
          validator: helper,
        })
        assert.ok(
          decoded.authority.nonceScalarHex === null,
          'Terminal backup retained nonce authority.',
        )
        assert.ok(
          decoded.authority.attestationEventJson === exact.attestation!.attestationNostrEventJson,
          'Terminal backup changed exact publication.',
        )
        assert.equal(decoded.authority.publicationRecordJson !== null, true)
        if (exact.kind === 'imported') assert.equal(exact.nonceAvailable, true)
        else assert.equal(exact.backupTerminal, false)
        await assert.rejects(store.commitBackupTerminal(conditionId, terminal.terminalAdmission!))
        assert.ok(
          isDeepStrictEqual(await store.readAuthorityByConditionId(conditionId), exact),
          'Unacknowledged replacement changed local authority or publication.',
        )
        assert.equal('terminalizeAuthority' in store, false)
        assert.equal('terminalizeImported' in store, false)
        const order: { relayUrl: string; kind: number; id: string }[] = []
        await retryNativeOracleBackup(
          {
            store,
            async publishRelay(relayUrl, eventJson) {
              const event = JSON.parse(eventJson)
              order.push({ relayUrl, kind: event.kind, id: event.id })
              if (relayUrl === destinations.relayUrls[1]) throw new Error('Relay is unavailable.')
              if (event.kind === 5) {
                assert.ok(
                  event.tags.some(
                    (tag: string[]) => tag[0] === 'e' && tag[1] === initial.current!.eventId,
                  ),
                  'Deletion lost predecessor ID.',
                )
                assert.equal(
                  event.tags.some((tag: string[]) => tag[0] === 'a'),
                  false,
                )
                assert.ok(
                  order.some(
                    (sent) => sent.relayUrl === relayUrl && sent.id === terminal.current!.eventId,
                  ),
                  'Deletion preceded replacement acknowledgment.',
                )
              }
              return { eventId: event.id, relayUrl }
            },
          },
          conditionId,
        )
        const pending =
          (await createNativeOracleCreationStore(directory).readBackupDelivery(conditionId))!
        assert.equal(pending.terminalCommitPending, false)
        assert.deepEqual(pending.current!.acknowledgedRelayIndexes, [0])
        assert.deepEqual(pending.deletion!.acknowledgedRelayIndexes, [0])
        const beforeCommit = await store.readAuthorityByConditionId(conditionId)
        if (beforeCommit!.kind === 'imported') assert.equal(beforeCommit!.nonceAvailable, false)
        else assert.equal(beforeCommit!.backupTerminal, true)
        await retryNativeOracleBackup(
          {
            store: createNativeOracleCreationStore(directory),
            async publishRelay(relayUrl, eventJson) {
              assert.equal(relayUrl, destinations.relayUrls[1])
              return { eventId: JSON.parse(eventJson).id, relayUrl }
            },
          },
          conditionId,
        )
        const finished = (await store.readBackupDelivery(conditionId))!
        assert.equal(finished.terminalCommitPending, false)
        assert.equal(finished.deletion, null)
        assert.equal(finished.timestampHighWater, terminal.timestampHighWater)
        const retired = (await store.readAuthorityByConditionId(conditionId))!
        assert.ok(
          isDeepStrictEqual(retired.attestation, exact.attestation),
          'Terminal commit changed exact publication.',
        )
        if (retired.kind === 'imported') assert.equal(retired.nonceAvailable, false)
        else {
          assert.equal(retired.backupTerminal, true)
          assert.equal((await store.readCreationSigner(retired.creationId)).publicKeyHex, publicKey)
          assert.ok(
            (
              await createDaemonStateSqliteSession(directory).read((database) =>
                readProfileSecretAuthority(database),
              )
            ).nativeOracleNonceSeedHex.length === 64,
          )
        }
        await assert.rejects(
          createDaemonStateSqliteSession(directory).transaction((database) =>
            database
              .prepare(
                `UPDATE daemon_oracle_${kind === 'created' ? 'creations' : 'imports'} SET backup_delivery_json=? WHERE condition_id=?`,
              )
              .run(JSON.stringify(initial), conditionId),
          ),
          /backwards/,
        )
        assert.equal(
          (await store.readBackupDelivery(conditionId))!.current!.eventId,
          terminal.current!.eventId,
        )
      })
    },
  )

  test(
    `real SQLite ${kind} failed local terminal commit reopens and retries without signer or helper`,
    realHelper,
    async () => {
      await withOwner(kind, async (directory, store, conditionId) => {
        await store.prepareBackupDelivery(conditionId, helper, 100)
        await resolve(directory, store, conditionId)
        const terminal = await store.prepareBackupDelivery(conditionId, helper, 101)
        for (const relayUrl of destinations.relayUrls)
          await store.confirmBackupDelivery(conditionId, {
            kind: 'backup',
            eventId: terminal.current!.eventId,
            relayUrl,
          })
        const beforeRefusal = await store.readAuthorityByConditionId(conditionId)
        await assert.rejects(
          store.commitBackupTerminal(conditionId, {
            ...terminal.terminalAdmission!,
            attestationEventId: '00'.repeat(32),
          }),
          /terminal-not-ready/,
        )
        assert.ok(
          isDeepStrictEqual(await store.readAuthorityByConditionId(conditionId), beforeRefusal),
          'Changed publication binding retired authority or changed exact publication.',
        )
        const faulting = createNativeOracleCreationStore(directory, {
          terminalCommitFault(phase) {
            if (phase === 'before-commit') throw new Error('Local commit failed.')
          },
        })
        await assert.rejects(
          faulting.commitBackupTerminal(conditionId, terminal.terminalAdmission!),
          /Local commit failed/,
        )
        const pending =
          (await createNativeOracleCreationStore(directory).readBackupDelivery(conditionId))!
        assert.equal(pending.terminalCommitPending, true)
        const exact = (await store.readAuthorityByConditionId(conditionId))!
        if (exact.kind === 'imported') assert.equal(exact.nonceAvailable, true)
        else assert.equal(exact.backupTerminal, false)
        await retryNativeOracleBackup(
          {
            store: createNativeOracleCreationStore(directory),
            async publishRelay(relayUrl, eventJson) {
              assert.equal(JSON.parse(eventJson).kind, 5)
              assert.ok(eventJson === terminal.deletion!.eventJson, 'Retry changed saved deletion.')
              return { eventId: JSON.parse(eventJson).id, relayUrl }
            },
          },
          conditionId,
        )
        assert.equal((await store.readBackupDelivery(conditionId))!.terminalCommitPending, false)
        assert.ok(
          (await store.readAuthorityByConditionId(conditionId))!.attestation!
            .attestationNostrEventJson === exact.attestation!.attestationNostrEventJson,
          'Terminal commit changed exact publication.',
        )
      })
    },
  )
}

test('native adapter persists a readable envelope before relay I/O', realHelper, async () => {
  await withOwner('imported', async (directory, store, conditionId) => {
    let sends = 0
    await publishNativeOracleBackup(
      {
        store,
        helper,
        nowSeconds: () => 100,
        async publishRelay(relayUrl, eventJson) {
          sends += 1
          assert.ok(
            (await createNativeOracleCreationStore(directory).readBackupDelivery(conditionId))!
              .current!.eventJson === eventJson,
            'Published envelope differs from durable stage.',
          )
          return { eventId: JSON.parse(eventJson).id, relayUrl }
        },
      },
      conditionId,
    )
    assert.equal(sends, 2)
  })
})

test(
  'native adapter never publishes a losing source candidate and reports fixed diagnostics',
  realHelper,
  async () => {
    await withOwner('imported', async (directory, store, conditionId) => {
      const arrived = deferred(),
        release = deferred()
      const delayed: NativeOracleHelper = {
        ...helper,
        async validateAuthority(...args) {
          const summary = await helper.validateAuthority(...args)
          arrived.resolve()
          await release.promise
          return summary
        },
      }
      let sends = 0
      const pending = publishNativeOracleBackup(
        {
          store,
          helper: delayed,
          nowSeconds: () => 100,
          async publishRelay(relayUrl, eventJson) {
            sends += 1
            return { relayUrl, eventId: JSON.parse(eventJson).id }
          },
        },
        conditionId,
      )
      await arrived.promise
      await createNativeOracleCreationStore(directory).chooseAuthorityOutcome(conditionId, 'Yes')
      release.resolve()
      const result = await pending
      assert.equal(sends, 0)
      assert.deepEqual(result.failures, ['preparation'])
      assert.ok(result.state === null, 'Failed preparation retained a stage.')
      assert.ok((await store.readBackupDelivery(conditionId)) === null, 'Unexpected backup stage.')
    })
  },
)

test(
  'native adapter retries exact deletion after its acknowledgment save fails',
  realHelper,
  async () => {
    await withOwner('imported', async (directory, store, conditionId) => {
      await store.prepareBackupDelivery(conditionId, helper, 100)
      await resolve(directory, store, conditionId)
      const terminal = await store.prepareBackupDelivery(conditionId, helper, 101)
      for (const relayUrl of destinations.relayUrls)
        await store.confirmBackupDelivery(conditionId, {
          kind: 'backup',
          eventId: terminal.current!.eventId,
          relayUrl,
        })
      let failSave = true
      const faulting = createNativeOracleCreationStore(directory, {
        backupDeliveryWriteFault(phase) {
          if (phase === 'before-commit' && failSave) {
            failSave = false
            throw new Error('Save failed.')
          }
        },
      })
      const sent: string[] = []
      await retryNativeOracleBackup(
        {
          store: faulting,
          async publishRelay(relayUrl, eventJson) {
            if (JSON.parse(eventJson).kind === 5) sent.push(eventJson)
            return { eventId: JSON.parse(eventJson).id, relayUrl }
          },
        },
        conditionId,
      )
      const saved =
        (await createNativeOracleCreationStore(directory).readBackupDelivery(conditionId))!
      assert.ok(
        saved.deletion!.eventJson === terminal.deletion!.eventJson,
        'Saved deletion changed.',
      )
      assert.deepEqual(saved.deletion!.acknowledgedRelayIndexes, [1])
      await retryNativeOracleBackup(
        {
          store: createNativeOracleCreationStore(directory),
          async publishRelay(relayUrl, eventJson) {
            assert.equal(relayUrl, destinations.relayUrls[0])
            sent.push(eventJson)
            return { eventId: JSON.parse(eventJson).id, relayUrl }
          },
        },
        conditionId,
      )
      assert.equal(sent.length, 3)
      assert.ok(
        sent.every((event) => event === terminal.deletion!.eventJson),
        'Deletion retry changed signed bytes.',
      )
      assert.equal((await store.readBackupDelivery(conditionId))!.deletion, null)
    })
  },
)

test(
  'native SQLite stage write fault prevents relay I/O and preserves source authority',
  realHelper,
  async () => {
    await withOwner('imported', async (directory, store, conditionId) => {
      const faulting = createNativeOracleCreationStore(directory, {
        backupDeliveryWriteFault(phase) {
          if (phase === 'before-commit') throw new Error('Stage commit failed.')
        },
      })
      let sends = 0
      const result = await publishNativeOracleBackup(
        {
          store: faulting,
          helper,
          nowSeconds: () => 100,
          async publishRelay(relayUrl, eventJson) {
            sends += 1
            return { relayUrl, eventId: JSON.parse(eventJson).id }
          },
        },
        conditionId,
      )
      assert.deepEqual(result.failures, ['preparation'])
      assert.equal(sends, 0)
      assert.ok(
        (await createNativeOracleCreationStore(directory).readBackupDelivery(conditionId)) === null,
        'Failed stage commit retained an envelope.',
      )
      assert.equal((await store.readAuthorityByConditionId(conditionId))!.kind, 'imported')
      assert.ok(
        (await store.readImportedAuthorityForSigning(conditionId)).nonceScalarHex !== null,
        'Stage failure retired nonce authority.',
      )
    })
  },
)
