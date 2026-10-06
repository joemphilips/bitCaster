import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import {
  decryptOracleBackupEvent,
  createOracleBackupEvent,
  buildTerminalOracleBackupRecord,
  deriveDlcConditionId,
  type OracleBackupRecord,
  type OraclePrivateAuthority,
} from '@bitcaster-market/client-sdk'
import { bootstrapFreshDaemonProfile, readProfileSecretAuthority } from '../src/profileBootstrap.ts'
import { createDaemonStateSqliteSession } from '../src/stateSqlite.ts'
import {
  createNativeOracleCreationStore,
  nativeOracleDestinations,
  nativeOraclePublicationRecord,
} from '../src/nativeOracleCreationStore.ts'
import {
  createNativeOracleHelperAdapter,
  type NativeOracleHelper,
} from '../src/nativeOracleHelper.ts'
import { prepareNativeMarketOracle } from '../src/nativeMarketOracle.ts'
import {
  publishNativeMarketOutcome,
  retryNativeMarketPublication,
  nativeOraclePublicationBinding,
} from '../src/nativeOraclePublicationCoordinator.ts'
import { publishNativeOracleBackup, retryNativeOracleBackup } from '../src/nativeOracleBackup.ts'
import {
  dispatchNativeOracleAccess,
  type NativeOracleAccessRpcPorts,
} from '../src/nativeOracleBackupRpc.ts'
import { dispatch } from '../src/server.ts'
import { updateNativeConfig } from '../src/nativeConfig.ts'
import { createHash } from 'node:crypto'
import { nativeOracleBackupStatus } from '../src/nativeOracleBackupAccess.ts'

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

function accessPorts(
  store: Store,
  overrides: Partial<NativeOracleAccessRpcPorts> = {},
): NativeOracleAccessRpcPorts {
  return {
    store,
    helper,
    relayUrls: ['wss://discovery.example'],
    readPrivateKey: async () => Buffer.from(signer, 'hex'),
    publishBackup: async (relayUrl, eventJson) => ({ relayUrl, eventId: JSON.parse(eventJson).id }),
    publishAnnouncement: async () => {
      throw new Error('Unexpected announcement publication.')
    },
    nowSeconds: () => 110,
    ...overrides,
  }
}

for (const kind of ['created', 'imported'] as const) {
  test(
    `real SQLite ${kind} authenticated envelope writes source provenance atomically and survives restart`,
    realHelper,
    async () => {
      await withOwner(kind, async (directory, store, conditionId) => {
        const backup = await store.exportBackup(conditionId, helper)
        const event = await createOracleBackupEvent({
          record: backup,
          privateKey: Buffer.from(signer, 'hex'),
          createdAt: 100,
          validator: helper,
        })
        const before = await store.readAuthorityByConditionId(conditionId)
        const failing = createNativeOracleCreationStore(directory, {
          importWriteFault(phase) {
            if (phase === 'before-commit') throw new Error('Atomic import failed.')
          },
        })
        await assert.rejects(
          failing.importBackupEnvelope(event, 'wss://source.example', helper),
          /Atomic import failed/,
        )
        assert.ok(
          isDeepStrictEqual(await store.readAuthorityByConditionId(conditionId), before),
          'Import changed authority before commit.',
        )
        assert.equal(await store.readBackupDelivery(conditionId), null)
        await store.importBackupEnvelope(event, 'wss://source.example', helper)
        const restarted = createNativeOracleCreationStore(directory)
        const source = (await restarted.readBackupDelivery(conditionId))!
        assert.equal(source.current, null)
        assert.deepEqual(source.knownEventIds, [event.id])
        assert.equal(source.timestampHighWater, 100)
        assert.deepEqual(source.relayUrls, destinations.relayUrls)
        assert.equal(source.terminalAdmission, null)
        assert.equal(source.terminalCommitPending, false)
        assert.ok(
          isDeepStrictEqual(await restarted.readAuthorityByConditionId(conditionId), before),
          'Restart changed imported authority.',
        )
        await restarted.importBackupEnvelope(event, 'wss://other-source.example', helper)
        assert.deepEqual(await restarted.readBackupDelivery(conditionId), source)
        const status = await nativeOracleBackupStatus(
          restarted,
          (await restarted.readAuthorityByConditionId(conditionId))!,
        )
        assert.equal(status.preparationPending, true)
        assert.equal(status.initial.acknowledgedRelays, 0)
        assert.doesNotMatch(
          JSON.stringify(status),
          /nonceScalarHex|eventJson|cipher|privateDto|secretKey/,
        )
      })
    },
  )

  test(
    `real SQLite ${kind} terminal stage refuses an unknown authenticated source without changing authority or exact retry`,
    realHelper,
    async () => {
      await withOwner(kind, async (directory, store, conditionId) => {
        const backup = await store.exportBackup(conditionId, helper)
        const event = await createOracleBackupEvent({
          record: backup,
          privateKey: Buffer.from(signer, 'hex'),
          createdAt: 100,
          validator: helper,
        })
        await store.importBackupEnvelope(event, 'wss://source.example', helper)
        await resolve(directory, store, conditionId)
        await store.prepareBackupDelivery(conditionId, helper, 101)
        const frozenOwner = await store.readAuthorityByConditionId(conditionId)
        const frozenDelivery = await store.readBackupDelivery(conditionId)
        const unknown = await createOracleBackupEvent({
          record: backup,
          privateKey: Buffer.from(signer, 'hex'),
          createdAt: 102,
          validator: helper,
        })
        const result = await dispatchNativeOracleAccess(
          {
            method: 'market.oracle-backup-restore',
            params: { eventId: unknown.id, relay: 'wss://source.example' },
          },
          accessPorts(store, {
            queryRelay: async (input) => {
              assert.deepEqual(input.filter.ids, [unknown.id])
              return { events: [unknown], complete: true }
            },
          }),
        )
        assert.equal(result.ok, false)
        assert.equal('code' in result && result.code, 'terminal-backup-source-not-admitted')
        assert.ok(
          isDeepStrictEqual(await store.readAuthorityByConditionId(conditionId), frozenOwner),
          'Refused source changed owner.',
        )
        assert.ok(
          isDeepStrictEqual(await store.readBackupDelivery(conditionId), frozenDelivery),
          'Refused source changed delivery.',
        )
        // A retained source remains idempotent after complete authentication.
        await store.importBackupEnvelope(event, 'wss://source.example', helper)
        assert.ok(
          isDeepStrictEqual(await store.readAuthorityByConditionId(conditionId), frozenOwner),
          'Refused source changed owner.',
        )
        assert.ok(
          isDeepStrictEqual(await store.readBackupDelivery(conditionId), frozenDelivery),
          'Refused source changed delivery.',
        )
      })
    },
  )
}

test(
  'real SQLite selected restore independently refetches; new authority and provenance commit or roll back together',
  realHelper,
  async () => {
    const backup = await importedFixture('fresh-access')
    const event = await createOracleBackupEvent({
      record: backup,
      privateKey: Buffer.from(signer, 'hex'),
      createdAt: 200,
      validator: helper,
    })
    await withOwner('imported', async (directory, store) => {
      const failing = createNativeOracleCreationStore(directory, {
        importWriteFault(phase) {
          if (phase === 'before-commit') throw new Error('raw secret failure')
        },
      })
      const refused = await dispatchNativeOracleAccess(
        {
          method: 'market.oracle-backup-restore',
          params: { eventId: event.id, relay: 'wss://source.example' },
        },
        accessPorts(failing, { queryRelay: async () => ({ events: [event], complete: true }) }),
      )
      assert.equal(refused.ok, false)
      assert.doesNotMatch(JSON.stringify(refused), /raw secret|nonceScalarHex|eventJson|cipher/)
      assert.equal(await store.readAuthorityByConditionId(backup.conditionId), null)
      let fetched = 0
      const restored = await dispatchNativeOracleAccess(
        {
          method: 'market.oracle-backup-restore',
          params: { eventId: event.id, relay: 'wss://source.example' },
        },
        accessPorts(store, {
          queryRelay: async (input) => {
            fetched++
            assert.deepEqual(input.filter.ids, [event.id])
            assert.equal(input.relayUrl, 'wss://source.example')
            return { events: [event], complete: true }
          },
        }),
      )
      assert.equal(restored.ok, true)
      assert.equal(fetched, 1)
      assert.doesNotMatch(JSON.stringify(restored), /nonceScalarHex|eventJson|privateDto|secretKey/)
      const restarted = createNativeOracleCreationStore(directory)
      assert.equal(
        (await restarted.readAuthorityByConditionId(backup.conditionId))!.kind,
        'imported',
      )
      assert.deepEqual((await restarted.readBackupDelivery(backup.conditionId))!.knownEventIds, [
        event.id,
      ])
      const exact = (await restarted.readAuthorityByConditionId(backup.conditionId))!.announcement!
        .announcementNostrEventJson
      const announcement = await dispatchNativeOracleAccess(
        { method: 'market.announcement-republish', params: { conditionId: backup.conditionId } },
        accessPorts(restarted, {
          helper: {} as NativeOracleHelper,
          readPrivateKey: async () => {
            throw new Error('Announcement retry cannot access keys.')
          },
          publishAnnouncement: async (relays, bytes) => {
            assert.deepEqual(relays, destinations.relayUrls)
            assert.equal(bytes, exact)
            return {
              eventId: JSON.parse(bytes).id,
              acceptedRelays: [...relays],
              rejectedRelayCount: 0,
            }
          },
        }),
      )
      assert.equal(announcement.ok, true)
      const signed = await resolve(directory, restarted, backup.conditionId)
      assert.equal(signed.record.chosenOutcome, 'Yes')
      assert.equal(signed.record.relayPublished, true)
      assert.ok(
        (await restarted.readAuthorityByConditionId(backup.conditionId))!.announcement!
          .announcementNostrEventJson === exact,
        'Imported signing changed the original announcement.',
      )
    })
  },
)

test(
  'real SQLite fresh scalar-null terminal restore republishes exact saved89 without key, preparation, or local backup admission',
  realHelper,
  async () => {
    await withOwner('imported', async (directory, store, conditionId) => {
      await resolve(directory, store, conditionId)
      const resolved = (await store.readAuthorityByConditionId(conditionId))!
      const terminal = buildTerminalOracleBackupRecord({
        binding: nativeOraclePublicationBinding(resolved),
        announcementTlvHex: resolved.announcement!.announcementTlvHex,
        destinations: nativeOracleDestinations(resolved),
        publication: nativeOraclePublicationRecord(resolved)!,
      })
      const event = await createOracleBackupEvent({
        record: terminal,
        privateKey: Buffer.from(signer, 'hex'),
        createdAt: 400,
        validator: helper,
      })
      const freshDirectory = join(directory, '..', 'fresh')
      await bootstrapFreshDaemonProfile({
        directory: freshDirectory,
        engineBaseUrl: destinations.engineUrl,
        mintUrl: destinations.mintUrl,
        walletSeedHex: '12'.repeat(64),
        nostrSecretKeyHex: signer,
      })
      const fresh = createNativeOracleCreationStore(freshDirectory)
      await fresh.importBackupEnvelope(event, 'wss://source.example', helper)
      const delivery = (await fresh.readBackupDelivery(conditionId))!
      assert.equal(delivery.current, null)
      assert.equal(delivery.terminalAdmission, null)
      const exact = resolved.attestation!.attestationNostrEventJson
      let sends = 0
      const result = await retryNativeMarketPublication(
        {
          store: createNativeOracleCreationStore(freshDirectory),
          helper: {} as NativeOracleHelper,
          readSigner: async () => {
            throw new Error('No signer is available.')
          },
          publishRelay: async (bytes) => {
            sends++
            assert.equal(bytes, exact)
            return { eventId: JSON.parse(bytes).id }
          },
          submitEvent: async () => {
            throw new Error('Relay-only must not contact engine.')
          },
          readResolution: async () => {
            throw new Error('Relay-only must not contact engine.')
          },
        },
        conditionId,
        { engineDelivery: 'relay-only', republishAttestation: true },
      )
      assert.equal(sends, 1)
      assert.deepEqual(result.failures, [])
      assert.ok(
        isDeepStrictEqual(await fresh.readBackupDelivery(conditionId), delivery),
        'Exact republication changed source delivery.',
      )
      assert.equal(
        (await fresh.readAuthorityByConditionId(conditionId))!.attestation!
          .attestationNostrEventJson,
        exact,
      )
    })
  },
)

test(
  'native RPC imported outcome relay-only makes zero engine calls and backup failure preserves durable primary result',
  realHelper,
  async () => {
    await withOwner('imported', async (directory, store, conditionId) => {
      const previousHome = process.env.BITCASTER_DAEMON_HOME
      process.env.BITCASTER_DAEMON_HOME = directory
      try {
        let engineCalls = 0,
          publications = 0
        const result = await dispatch(
          { method: 'market.attest', params: { conditionId, outcome: 'Yes', relayOnly: true } },
          {
            nativeOraclePublicationPorts: {
              store,
              helper,
              readSigner: async () => ({ secretKeyHex: signer, nonceSeedHex: '03'.repeat(32) }),
              publishRelay: async (bytes) => {
                publications++
                return { eventId: JSON.parse(bytes).id }
              },
              submitEvent: async () => {
                engineCalls++
                throw new Error()
              },
              readResolution: async () => {
                engineCalls++
                throw new Error()
              },
            },
            nativeOracleAccessPorts: accessPorts(store, {
              publishBackup: async () => {
                throw new Error('Backup relay unavailable.')
              },
            }),
          },
        )
        assert.equal(result.ok, true)
        assert.equal(engineCalls, 0)
        assert.equal(publications, 1)
        const saved =
          (await createNativeOracleCreationStore(directory).readAuthorityByConditionId(
            conditionId,
          ))!
        assert.equal(saved.chosenOutcome, 'Yes')
        assert.equal(saved.relayPublished, true)
        assert.equal(saved.engineEvidence, null)
        const pending = await nativeOracleBackupStatus(store, saved)
        assert.equal(pending.terminal.prepared, true)
        assert.equal(pending.terminal.replacementAcknowledgedRelays, 0)
        assert.equal(pending.terminal.localCommitPending, true)
      } finally {
        if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
        else process.env.BITCASTER_DAEMON_HOME = previousHome
      }
    })
  },
)

test(
  'native RPC later exact synchronization uses original stored engine after current configuration changes',
  realHelper,
  async () => {
    await withOwner('imported', async (directory, store, conditionId) => {
      await resolve(directory, store, conditionId)
      await publishNativeOracleBackup(
        {
          store,
          helper,
          nowSeconds: () => 100,
          publishRelay: async (relayUrl, bytes) => ({ relayUrl, eventId: JSON.parse(bytes).id }),
        },
        conditionId,
      )
      const saved = (await store.readAuthorityByConditionId(conditionId))!
      const exact = saved.attestation!.attestationNostrEventJson
      const verified = await helper.verifyEnum({
        eventId: saved.eventId,
        oraclePublicKeyHex: saved.creatorPublicKeyHex,
        chosenOutcome: saved.chosenOutcome!,
        announcementTlvHex: saved.announcement!.announcementTlvHex,
        announcementNostrEventJson: saved.announcement!.announcementNostrEventJson,
        attestationHex: saved.attestation!.attestationHex,
        attestationNostrEventJson: exact,
      })
      const { created_at, ...event } = JSON.parse(exact)
      const observed = {
        conditionId,
        attestedOutcome: 'Yes',
        attestationEvent: { ...event, createdAt: created_at },
        registeredAuthority: {
          eventId: saved.eventId,
          outcomes: ['Yes', 'No'],
          threshold: 1,
          oracles: [
            {
              oraclePublicKey: publicKey,
              noncePoint: verified.noncePointHex,
              announcementIdentity: createHash('sha256')
                .update(Buffer.from(saved.announcement!.announcementTlvHex, 'hex'))
                .digest('hex'),
            },
          ],
        },
        oracleWitness: {
          oracle_sigs: [
            { oracle_pubkey: publicKey, oracle_sig: verified.oracleSignatureHex, outcome: 'Yes' },
          ],
        },
      }
      updateNativeConfig(
        (config) => ({
          ...config,
          daemon: { ...config.daemon, engineUrl: 'https://changed.example' },
        }),
        { directory },
      )
      const previousHome = process.env.BITCASTER_DAEMON_HOME,
        previousFetch = globalThis.fetch
      process.env.BITCASTER_DAEMON_HOME = directory
      const requests: string[] = []
      globalThis.fetch = async (input, init) => {
        const url = String(input)
        requests.push(url)
        assert.ok(url.startsWith(destinations.engineUrl + '/api/v1/'))
        if (init?.method === 'POST') {
          assert.deepEqual(JSON.parse(String(init.body)), observed.attestationEvent)
          return new Response(JSON.stringify({ result: 'Closed' }), { status: 200 })
        }
        return new Response(JSON.stringify(observed), { status: 200 })
      }
      try {
        const result = await dispatch(
          { method: 'market.attestation-retry', params: { conditionId } },
          { nativeOracleHelper: helper },
        )
        assert.equal(result.ok, true)
        assert.equal(requests.length, 2)
        const synchronized = (await store.readAuthorityByConditionId(conditionId))!
        assert.equal(synchronized.attestation!.attestationNostrEventJson, exact)
        assert.ok(synchronized.engineEvidence !== null)
      } finally {
        globalThis.fetch = previousFetch
        if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
        else process.env.BITCASTER_DAEMON_HOME = previousHome
      }
    })
  },
)

test(
  'native automatic delivery replays an existing stage without a preparation helper or signer',
  realHelper,
  async () => {
    await withOwner('imported', async (directory, store, conditionId) => {
      const stage = await store.prepareBackupDelivery(conditionId, helper, 100)
      let sends = 0
      const result = await publishNativeOracleBackup(
        {
          store: createNativeOracleCreationStore(directory),
          helper: {} as NativeOracleHelper,
          nowSeconds: () => {
            throw new Error('Saved retry cannot prepare.')
          },
          publishRelay: async (relayUrl, bytes) => {
            sends++
            assert.ok(bytes === stage.current!.eventJson, 'Retry changed saved backup.')
            return { relayUrl, eventId: stage.current!.eventId }
          },
        },
        conditionId,
      )
      assert.equal(sends, 2)
      assert.deepEqual(result.failures, [])
      assert.equal(result.state!.current!.eventId, stage.current!.eventId)
    })
  },
)

test(
  'native list RPC returns safe actual-envelope metadata and fixed restore refusals without mutation',
  realHelper,
  async () => {
    await withOwner('imported', async (_directory, store, conditionId) => {
      const backup = await store.exportBackup(conditionId, helper)
      const event = await createOracleBackupEvent({
        record: backup,
        privateKey: Buffer.from(signer, 'hex'),
        createdAt: 200,
        validator: helper,
      })
      let queries = 0
      const listed = await dispatchNativeOracleAccess(
        { method: 'market.oracle-backup-list', params: {} },
        accessPorts(store, {
          queryRelay: async (input) => {
            queries++
            assert.equal(input.relayUrl, 'wss://discovery.example')
            assert.deepEqual(input.filter.kinds, [30078])
            assert.deepEqual(input.filter.authors, [publicKey])
            assert.deepEqual(input.filter['#v'], ['1'])
            assert.equal('#d' in input.filter, false)
            return { events: [event], complete: true }
          },
        }),
      )
      assert.equal(listed.ok, true)
      assert.equal(queries, 2)
      if (listed.ok) {
        const page = listed.result as {
          descriptors: { backupEventId: string; conditionId: string }[]
          discovery: string
        }
        assert.equal(page.descriptors.length, 1)
        assert.equal(page.descriptors[0].backupEventId, event.id)
        assert.equal(page.descriptors[0].conditionId, conditionId)
        assert.equal(page.discovery, 'relay-dependent')
      }
      assert.doesNotMatch(
        JSON.stringify(listed),
        /nonceScalarHex|eventJson|cipher|privateDto|secretKey/,
      )
      const before = await store.readAuthorityByConditionId(conditionId)
      const missing = await dispatchNativeOracleAccess(
        {
          method: 'market.oracle-backup-restore',
          params: { eventId: event.id, relay: 'wss://source.example' },
        },
        accessPorts(store, { queryRelay: async () => ({ events: [], complete: true }) }),
      )
      assert.equal('code' in missing && missing.code, 'oracle-backup-missing-event')
      const wrong = finalizeEvent(
        {
          kind: event.kind,
          created_at: event.created_at,
          tags: event.tags,
          content: event.content,
        },
        Buffer.from('03'.repeat(32), 'hex'),
      )
      const foreign = await dispatchNativeOracleAccess(
        {
          method: 'market.oracle-backup-restore',
          params: { eventId: wrong.id, relay: 'wss://source.example' },
        },
        accessPorts(store, { queryRelay: async () => ({ events: [wrong], complete: true }) }),
      )
      assert.equal('code' in foreign && foreign.code, 'oracle-backup-wrong-owner')
      const invalid = await dispatchNativeOracleAccess(
        {
          method: 'market.oracle-backup-restore',
          params: { eventId: event.id, relay: 'wss://source.example' },
        },
        accessPorts(store, {
          queryRelay: async () => ({
            events: [{ ...event, sig: '00'.repeat(64) }],
            complete: true,
          }),
        }),
      )
      assert.equal('code' in invalid && invalid.code, 'oracle-backup-invalid-envelope')
      assert.ok(
        isDeepStrictEqual(await store.readAuthorityByConditionId(conditionId), before),
        'Refused access changed owner.',
      )
      assert.equal(await store.readBackupDelivery(conditionId), null)
    })
  },
)

test(
  'native receiving owner captures the authenticated envelope before its first await',
  realHelper,
  async () => {
    await withOwner('imported', async (directory, store, conditionId) => {
      const backup = await store.exportBackup(conditionId, helper)
      const event = await createOracleBackupEvent({
        record: backup,
        privateKey: Buffer.from(signer, 'hex'),
        createdAt: 550,
        validator: helper,
      })
      const originalId = event.id
      const pending = store.importBackupEnvelope(event, 'wss://source.example', helper)
      event.id = '00'.repeat(32)
      event.created_at = 999
      event.content = 'caller mutated ciphertext'
      event.tags[0][1] = 'caller mutated binding'
      const restored = await pending
      assert.equal(restored.announcement!.conditionId, conditionId)
      assert.ok(
        restored.announcement!.announcementNostrEventJson ===
          backup.authority.announcementEventJson,
        'Caller mutation changed restored authority.',
      )
      const restarted = createNativeOracleCreationStore(directory)
      const delivery = (await restarted.readBackupDelivery(conditionId))!
      assert.deepEqual(delivery.knownEventIds, [originalId])
      assert.equal(delivery.timestampHighWater, 550)
      assert.equal(delivery.current, null)
      const retained = (await restarted.readImportedAuthorityForSigning(conditionId))!
      assert.ok(
        retained.nonceScalarHex === backup.authority.nonceScalarHex,
        'Caller mutation changed private signing authority.',
      )
    })
  },
)

test(
  'native local status pages mix created and imported owners, capture delivery, and resume after restart',
  realHelper,
  async () => {
    await withOwner('created', async (directory, store, createdConditionId) => {
      const expected = [createdConditionId]
      for (let index = 0; index < 4; index++) {
        const backup = await importedFixture(`local-status-page-${index}`)
        expected.push(backup.conditionId)
        const event = await createOracleBackupEvent({
          record: backup,
          privateKey: Buffer.from(signer, 'hex'),
          createdAt: 200 + index,
          validator: helper,
        })
        await store.importBackupEnvelope(event, 'wss://source.example', helper)
      }
      expected.sort()
      let cursor: string | undefined
      const observed: string[] = []
      const ownerKinds = new Set<string>()
      do {
        const restarted = createNativeOracleCreationStore(directory)
        const supplied = accessPorts({
          ...restarted,
          readBackupDelivery: async () => {
            throw new Error('Paged status must not reread each owner.')
          },
        })
        const result = await dispatchNativeOracleAccess(
          {
            method: 'market.oracle-backup-status',
            params: { limit: 2, ...(cursor === undefined ? {} : { cursor }) },
          },
          supplied,
        )
        assert.equal(result.ok, true)
        if (!result.ok) throw new Error('Status page failed.')
        const page = result.result as {
          statuses: {
            ownerKind: string
            binding: { conditionId: string }
            initial: { acknowledgedRelays: number }
          }[]
          cursor: string | null
        }
        assert.ok(page.statuses.length <= 2)
        for (const status of page.statuses) {
          observed.push(status.binding.conditionId)
          ownerKinds.add(status.ownerKind)
          assert.equal(status.initial.acknowledgedRelays, 0)
        }
        if (page.cursor !== null)
          assert.equal(page.cursor, page.statuses[page.statuses.length - 1].binding.conditionId)
        cursor = page.cursor ?? undefined
        assert.doesNotMatch(
          JSON.stringify(result),
          /nonceScalarHex|eventJson|cipher|privateDto|secretKey/,
        )
      } while (cursor !== undefined)
      assert.deepEqual(observed, expected)
      assert.deepEqual([...ownerKinds].sort(), ['created', 'imported'])
      assert.equal((await store.readAuthorityPage()).items.length, 5)
      assert.equal(
        (await store.readAuthorityPage({ cursor: 'f'.repeat(64), limit: 2 })).items.length,
        0,
      )
      const single = await dispatchNativeOracleAccess(
        { method: 'market.oracle-backup-status', params: { conditionId: createdConditionId } },
        accessPorts(store),
      )
      assert.equal(single.ok, true)
      assert.ok(single.ok && 'binding' in (single.result as object))
    })
  },
)

test(
  'native local status refuses invalid page bounds and single-owner paging options without mutation',
  realHelper,
  async () => {
    await withOwner('imported', async (_directory, store, conditionId) => {
      const before = await store.readAuthorityByConditionId(conditionId)
      for (const params of [
        { limit: 0 },
        { limit: 129 },
        { limit: 1.5 },
        { limit: null },
        { limit: '2' },
        { cursor: 'bad' },
        { cursor: 'A'.repeat(64) },
        { cursor: null },
        { conditionId, limit: 2 },
        { conditionId, cursor: 'f'.repeat(64) },
      ]) {
        const result = await dispatchNativeOracleAccess(
          { method: 'market.oracle-backup-status', params } as never,
          accessPorts(store),
        )
        assert.equal(result.ok, false)
        assert.equal('code' in result && result.code, 'oracle-backup-local-state')
      }
      assert.ok(
        isDeepStrictEqual(await store.readAuthorityByConditionId(conditionId), before),
        'Invalid paging changed owner.',
      )
    })
  },
)

test(
  'real SQLite encrypted restore into empty authority keeps its nonce isolated from a new native announcement',
  realHelper,
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-restored-nonce-isolation-'))
    const directory = join(root, 'profile')
    const passphrase = 'native-nonce-isolation-passphrase'
    try {
      await bootstrapFreshDaemonProfile({
        directory,
        engineBaseUrl: destinations.engineUrl,
        mintUrl: destinations.mintUrl,
        walletSeedHex: '11'.repeat(64),
        nostrSecretKeyHex: signer,
        passphrase,
      })
      const store = createNativeOracleCreationStore(directory, { passphrase })
      assert.equal((await store.readAuthorityPage()).items.length, 0)
      const backup = await importedFixture('restored-nonce-isolation')
      const event = await createOracleBackupEvent({
        record: backup,
        privateKey: Buffer.from(signer, 'hex'),
        createdAt: 600,
        validator: helper,
      })
      const restored = await dispatchNativeOracleAccess(
        {
          method: 'market.oracle-backup-restore',
          params: { eventId: event.id, relay: 'wss://source.example' },
        },
        accessPorts(store, {
          queryRelay: async (input) => {
            assert.deepEqual(input.filter.ids, [event.id])
            return { events: [event], complete: true }
          },
        }),
      )
      assert.equal(restored.ok, true)
      const reopened = createNativeOracleCreationStore(directory, { passphrase })
      const originalOwner = await reopened.readAuthorityByConditionId(backup.conditionId)
      const originalAuthority = await reopened.readImportedAuthorityForSigning(backup.conditionId)
      const originalProvenance = await reopened.readBackupDelivery(backup.conditionId)
      assert.equal(originalOwner?.kind, 'imported')
      assert.deepEqual(originalProvenance!.knownEventIds, [event.id])
      assert.equal(originalProvenance!.timestampHighWater, 600)
      assert.equal(originalProvenance!.current, null)
      const secrets = await createDaemonStateSqliteSession(directory).read((database) =>
        readProfileSecretAuthority(database, passphrase),
      )
      const created = await prepareNativeMarketOracle(
        {
          store: reopened,
          helper,
          oracleSecretKeyHex: signer,
          nonceSeedHex: secrets.nativeOracleNonceSeedHex,
        },
        {
          creationId: 'new-native-after-restore',
          eventId: 'new-native-after-restore-event',
          market: {
            title: 'Independent announcement',
            description: 'New native authority after an encrypted restore.',
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
      const newBackup = await reopened.exportBackup(
        created.record.announcement!.conditionId,
        helper,
      )
      const importedSummary = await helper.validateAuthority(
        JSON.stringify(originalAuthority),
        publicKey,
      )
      const newSummary = await helper.validateAuthority(
        JSON.stringify(newBackup.authority),
        publicKey,
      )
      assert.notEqual(newSummary.noncePoint, importedSummary.noncePoint)
      assert.notEqual(created.record.announcement!.conditionId, backup.conditionId)
      const finalStore = createNativeOracleCreationStore(directory, { passphrase })
      assert.ok(
        isDeepStrictEqual(
          await finalStore.readAuthorityByConditionId(backup.conditionId),
          originalOwner,
        ),
        'New announcement changed imported owner.',
      )
      assert.ok(
        isDeepStrictEqual(
          await finalStore.readImportedAuthorityForSigning(backup.conditionId),
          originalAuthority,
        ),
        'New announcement changed imported private authority.',
      )
      assert.ok(
        isDeepStrictEqual(
          await finalStore.readBackupDelivery(backup.conditionId),
          originalProvenance,
        ),
        'New announcement changed imported source provenance.',
      )
      assert.equal((await finalStore.readAuthorityPage()).items.length, 2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
