import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { bootstrapFreshDaemonProfile, readProfileSecretAuthority } from '../src/profileBootstrap.ts'
import { deriveNostrPublicKey } from '../src/profileSecretProtection.ts'
import { createNativeOracleCreationStore } from '../src/nativeOracleCreationStore.ts'
import {
  prepareNativeMarketOracle,
  signNativeMarketOutcome,
  type NativeMarketCreationInput,
} from '../src/nativeMarketOracle.ts'
import type { NativeOracleHelper } from '../src/nativeOracleHelper.ts'
import {
  createNativeOracleHelperAdapter,
  resolveNativeOracleHelperPath,
} from '../src/nativeOracleHelper.ts'
import {
  publishNativeMarketOutcome,
  retryNativeMarketPublication,
  nativeOraclePublicationRpcResult,
  type NativeOraclePublicationPorts,
} from '../src/nativeOraclePublicationCoordinator.ts'
import { createDaemonStateSqliteSession } from '../src/stateSqlite.ts'
import {
  BitcasterEngineClient,
  createOracleBackupEvent,
  decryptOracleBackupEvent,
} from '@bitcaster-market/client-sdk'

const input: NativeMarketCreationInput = {
  registration: { requiredFeeMsat: 0 },
  creationId: 'creation-1',
  eventId: 'event-1',
  market: {
    title: ' Title\n',
    description: ' A\t description ',
    outcomeType: 'yesno',
    outcomeDetails: [{ name: 'Yes' }, { name: 'No' }],
    maturityEpoch: 2_000_000_000,
    categoryTags: ['Weather'],
    baseAsset: 'sat',
  },
  destination: {
    engineBaseUrl: 'https://engine.example',
    mintUrl: 'https://mint.example',
    relayUrls: ['wss://relay.example'],
  },
}

test('native creation stores exact artifacts before returning and retries without signing again', async () => {
  await withFixture(async (deps, directory) => {
    let creations = 0
    const original = deps.helper.createEnum
    deps.helper.createEnum = async (request) => {
      creations++
      assert.equal(
        (await deps.store.readCreation(input.creationId))?.nonceIndex,
        request.reservedNonceIndex,
      )
      assert.equal(request.title, 'Title')
      assert.equal(request.description, input.market.description)
      return original(request)
    }
    const first = await prepareNativeMarketOracle(deps, input)
    assert.ok(first.record.announcement)
    const reopened = { ...deps, store: createNativeOracleCreationStore(directory) }
    reopened.helper.assertAvailable = () => {
      throw new Error('helper removed after preparation')
    }
    const retry = await prepareNativeMarketOracle(reopened, input)
    assert.equal(
      retry.record.announcement?.announcementNostrEventJson,
      first.record.announcement.announcementNostrEventJson,
    )
    assert.equal(creations, 1)
    await assert.rejects(
      prepareNativeMarketOracle(reopened, {
        ...input,
        destination: { ...input.destination, mintUrl: 'https://other.example' },
      }),
      /conflict/,
    )
  })
})

test('native outcome choice rejects typos before commitment and survives interrupted signing', async () => {
  await withFixture(async (deps) => {
    const { record } = await prepareNativeMarketOracle(deps, input)
    const conditionId = record.announcement!.conditionId
    await assert.rejects(signNativeMarketOutcome(deps, conditionId, 'Typo'), /not in this market/)
    assert.equal((await deps.store.readCreation(input.creationId))?.chosenOutcome, null)
    const sign = deps.helper.signEnum
    deps.helper.signEnum = async () => {
      throw new Error('interrupted signing')
    }
    await assert.rejects(signNativeMarketOutcome(deps, conditionId, 'Yes'), /interrupted signing/)
    assert.equal((await deps.store.readCreation(input.creationId))?.chosenOutcome, 'Yes')
    await assert.rejects(signNativeMarketOutcome(deps, conditionId, 'No'), /different outcome/)
    deps.helper.signEnum = sign
    const resolved = await signNativeMarketOutcome(deps, conditionId, 'Yes')
    deps.helper.signEnum = async () => {
      throw new Error('must reuse stored attestation')
    }
    const retried = await signNativeMarketOutcome(deps, conditionId, 'Yes')
    assert.equal(
      retried.attestation?.attestationNostrEventJson,
      resolved.attestation?.attestationNostrEventJson,
    )
  })
})

test('missing native helper refuses a new creation before nonce allocation', async () => {
  await withFixture(async (deps) => {
    deps.helper.assertAvailable = () => {
      throw new Error('helper unavailable')
    }
    await assert.rejects(prepareNativeMarketOracle(deps, input), /helper unavailable/)
    assert.equal(await deps.store.readCreation(input.creationId), null)
    deps.helper.assertAvailable = () => {}
    assert.equal((await prepareNativeMarketOracle(deps, input)).record.nonceIndex, 0)
  })
})

test('new native market text overflow refuses before helper or nonce allocation', async () => {
  await withFixture(async (deps) => {
    let helperCalls = 0
    deps.helper.assertAvailable = () => {
      helperCalls++
    }
    for (const market of [
      { ...input.market, title: '題'.repeat(101) },
      { ...input.market, description: '説'.repeat(342) },
      { ...input.market, categoryTags: ['x'.repeat(4_096)] },
    ]) {
      await assert.rejects(
        prepareNativeMarketOracle(deps, { ...input, market }),
        /must fit within|limit|maximum|exceed|at most/i,
      )
      assert.equal(await deps.store.readCreation(input.creationId), null)
    }
    assert.equal(helperCalls, 0)
  })
})

test('new native creation reserves later backup capacity before helper or nonce allocation', async () => {
  await withFixture(async (deps) => {
    let helperCalls = 0
    deps.helper.assertAvailable = () => {
      helperCalls++
    }
    await assert.rejects(
      prepareNativeMarketOracle(deps, {
        ...input,
        destination: {
          ...input.destination,
          relayUrls: Array.from(
            { length: 24 },
            (_, index) => `wss://relay-${index}.example/${'x'.repeat(1800)}`,
          ),
        },
      }),
      /insufficient room for a recoverable oracle resolution/,
    )
    assert.equal(helperCalls, 0)
    assert.equal(await deps.store.readCreation(input.creationId), null)
  })
})

test('retained oversized native creations resume and resolve without new writer restrictions', async () => {
  await withFixture(async (deps) => {
    const legacy = {
      ...input,
      market: { ...input.market, title: '題'.repeat(201), description: '説'.repeat(2001) },
    }
    const reserved = await deps.store.reserveCreation(
      {
        creationId: legacy.creationId,
        eventId: legacy.eventId,
        canonicalInput: JSON.stringify({
          market: legacy.market,
          registration: legacy.registration,
          destination: legacy.destination,
        }),
      },
      deriveNostrPublicKey(deps.oracleSecretKeyHex),
    )
    const exactAnnouncement = '{"kind":88,"content":"retained original artifact"}'
    await deps.store.persistAnnouncement(reserved.creationId, {
      conditionId: 'aa'.repeat(32),
      announcementTlvHex: 'aabb',
      announcementNostrEventJson: exactAnnouncement,
    })
    deps.helper.createEnum = async () => {
      throw new Error('retained announcement must never be recreated')
    }
    const resumed = await prepareNativeMarketOracle(deps, legacy)
    assert.equal(resumed.record.announcement?.announcementNostrEventJson, exactAnnouncement)
    assert.equal(resumed.market.metadata.title, legacy.market.title)
    assert.equal(resumed.market.metadata.description, legacy.market.description)
    const resolved = await signNativeMarketOutcome(deps, 'aa'.repeat(32), 'Yes')
    assert.equal(resolved.announcement?.announcementNostrEventJson, exactAnnouncement)
    assert.equal(resolved.chosenOutcome, 'Yes')
  })
})

test('new interrupted native reservations retain exact description formatting on cold retry', async () => {
  await withFixture(async (deps, directory) => {
    const description = '  ## Rules\r\n\n- First  condition\n\t- Exception\n'
    const raw = { ...input, market: { ...input.market, description } }
    const create = deps.helper.createEnum
    let attempts = 0
    deps.helper.createEnum = async (request) => {
      attempts++
      assert.equal(request.description, description)
      if (attempts === 1) throw new Error('interrupted before announcement persisted')
      return create(request)
    }
    await assert.rejects(prepareNativeMarketOracle(deps, raw), /interrupted/)
    const reserved = (await deps.store.readCreation(raw.creationId))!
    assert.equal(JSON.parse(reserved.canonicalInput).oracleAnnouncementTagsVersion, 2)
    const resumed = await prepareNativeMarketOracle(
      { ...deps, store: createNativeOracleCreationStore(directory) },
      raw,
    )
    assert.equal(resumed.record.nonceIndex, reserved.nonceIndex)
    assert.equal(resumed.market.metadata.description, description)
    assert.equal(attempts, 2)
  })
})

test('saved unsigned reservations keep legacy code-point title formatting while fresh input refuses it', async () => {
  await withFixture(async (deps) => {
    const legacy = {
      ...input,
      market: { ...input.market, title: ` \n${'😀'.repeat(99)}界Z\t ` },
    }
    const expectedTitle = '😀'.repeat(99) + '界'
    let helperCalls = 0
    const create = deps.helper.createEnum
    deps.helper.createEnum = async (request) => {
      helperCalls++
      assert.equal(request.title, expectedTitle)
      assert.equal(Array.from(request.title).length, 100)
      assert.equal(request.description, 'A description')
      assert.equal(request.reservedNonceIndex, 0)
      assert.equal(request.eventId, legacy.eventId)
      return create(request)
    }
    await assert.rejects(prepareNativeMarketOracle(deps, legacy), /must fit within/)
    assert.equal(helperCalls, 0)
    assert.equal(await deps.store.readCreation(legacy.creationId), null)

    // Reproduce a pre-upgrade reservation whose helper response was never retained.
    const canonicalInput = JSON.stringify({
      market: legacy.market,
      registration: legacy.registration,
      destination: legacy.destination,
    })
    const reserved = await deps.store.reserveCreation(
      { creationId: legacy.creationId, eventId: legacy.eventId, canonicalInput },
      deriveNostrPublicKey(deps.oracleSecretKeyHex),
    )
    assert.equal(reserved.announcement, null)
    const resumed = await prepareNativeMarketOracle(deps, legacy)
    assert.equal(resumed.record.nonceIndex, reserved.nonceIndex)
    assert.equal(resumed.record.canonicalInput, canonicalInput)
    assert.equal(resumed.market.metadata.title, legacy.market.title)
    assert.ok(resumed.record.announcement)
    const retry = await prepareNativeMarketOracle(deps, legacy)
    assert.deepEqual(retry.record.announcement, resumed.record.announcement)
    assert.equal(helperCalls, 1)
  })
})

test('a different signer cannot resume or select an outcome before any effect', async () => {
  await withFixture(async (deps) => {
    const prepared = await prepareNativeMarketOracle(deps, input)
    let effects = 0
    deps.helper.assertAvailable = () => {
      effects++
    }
    const wrong = { ...deps, oracleSecretKeyHex: '44'.repeat(32) }
    await assert.rejects(prepareNativeMarketOracle(wrong, input), /requires signer/)
    await assert.rejects(
      signNativeMarketOutcome(wrong, prepared.record.announcement!.conditionId, 'Yes'),
      /requires signer/,
    )
    assert.equal(effects, 0)
    assert.equal((await deps.store.readCreation(input.creationId))?.chosenOutcome, null)
  })
})

test('an interrupted unpublished announcement retries its reserved nonce index', async () => {
  await withFixture(async (deps) => {
    const create = deps.helper.createEnum
    deps.helper.createEnum = async () => {
      throw new Error('helper response lost')
    }
    await assert.rejects(prepareNativeMarketOracle(deps, input), /helper response lost/)
    const reserved = await deps.store.readCreation(input.creationId)
    assert.equal(reserved?.nonceIndex, 0)
    assert.equal(reserved?.announcement, null)
    deps.helper.createEnum = async (request) => {
      assert.equal(request.reservedNonceIndex, 0)
      return create(request)
    }
    const retried = await prepareNativeMarketOracle(deps, input)
    assert.equal(retried.record.nonceIndex, 0)
    assert.ok(retried.record.announcement)
  })
})

async function withFixture(
  run: (
    deps: {
      store: ReturnType<typeof createNativeOracleCreationStore>
      helper: NativeOracleHelper
      oracleSecretKeyHex: string
      nonceSeedHex: string
    },
    directory: string,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-native-oracle-'))
  const directory = join(root, 'profile')
  try {
    await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
    })
    const store = createNativeOracleCreationStore(directory)
    const helper: NativeOracleHelper = {
      assertAvailable() {},
      async verifyEnum() {
        throw new Error('Fake helper cannot verify DLC artifacts.')
      },
      async createEnum(request) {
        return {
          eventId: request.eventId,
          oraclePublicKeyHex: 'ab'.repeat(32),
          announcementTlvHex: 'aabb',
          announcementNostrEventId: 'cd'.repeat(32),
          announcementNostrEventJson: '{"kind":88}',
        }
      },
      async signEnum(request) {
        assert.equal(
          (await store.readCreation(input.creationId))?.chosenOutcome,
          request.chosenOutcome,
        )
        return {
          eventId: request.eventId,
          chosenOutcome: request.chosenOutcome,
          attestationHex: 'ccdd',
          attestationNostrEventId: 'ef'.repeat(32),
          attestationNostrEventJson: '{"kind":89}',
        }
      },
    }
    await run(
      { store, helper, oracleSecretKeyHex: '22'.repeat(32), nonceSeedHex: '33'.repeat(32) },
      directory,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const realHelperPath =
  process.env.BITCASTER_TEST_NATIVE_ORACLE_HELPER ??
  (process.platform === 'win32' ? '' : resolveNativeOracleHelperPath())
const realCrypto = { skip: !existsSync(realHelperPath) }

test(
  'real native signed description and encrypted backup preserve raw multiline metadata and exact retry',
  realCrypto,
  async () => {
    await withFixture(async (deps, directory) => {
      const secrets = await createDaemonStateSqliteSession(directory).read((database) =>
        readProfileSecretAuthority(database),
      )
      deps.nonceSeedHex = secrets.nativeOracleNonceSeedHex

      const description =
        '  ## 判定条件\r\n\r\n- First  condition  \n\t- Exception\n\n```text\n  keep  spaces\n```\n'
      const market = { ...input, market: { ...input.market, description } }
      const helper = createNativeOracleHelperAdapter({ resolveExecutable: () => realHelperPath })
      const prepared = await prepareNativeMarketOracle({ ...deps, helper }, market)
      const exact = prepared.record.announcement!.announcementNostrEventJson
      assert.equal(
        JSON.parse(exact).tags.find((tag: string[]) => tag[0] === 'description')?.[1],
        description,
      )
      assert.equal(prepared.market.metadata.description, description)
      const backup = await deps.store.exportBackup(
        prepared.record.announcement!.conditionId,
        helper,
      )
      assert.equal(backup.authority.announcementEventJson, exact)
      const envelope = await createOracleBackupEvent({
        record: backup,
        privateKey: Buffer.from(deps.oracleSecretKeyHex, 'hex'),
        validator: helper,
        createdAt: 1_800_000_000,
      })
      const restored = await decryptOracleBackupEvent({
        event: envelope,
        privateKey: Buffer.from(deps.oracleSecretKeyHex, 'hex'),
        validator: helper,
      })
      assert.equal(restored.authority.announcementEventJson, exact)
      const retry = await prepareNativeMarketOracle(
        { ...deps, helper, store: createNativeOracleCreationStore(directory) },
        market,
      )
      assert.equal(retry.record.announcement!.announcementNostrEventJson, exact)
    })
  },
)

test(
  'real legacy unsigned reservation keeps its original collapsed description and exact signed retry',
  realCrypto,
  async () => {
    await withFixture(async (deps, directory) => {
      const secrets = await createDaemonStateSqliteSession(directory).read((database) =>
        readProfileSecretAuthority(database),
      )
      deps.nonceSeedHex = secrets.nativeOracleNonceSeedHex

      const description = '  ## Legacy\r\n\n- First  condition\n\t- Exception\n'
      const legacy = { ...input, market: { ...input.market, description } }
      await deps.store.reserveCreation(
        {
          creationId: legacy.creationId,
          eventId: legacy.eventId,
          canonicalInput: JSON.stringify({
            market: legacy.market,
            registration: legacy.registration,
            destination: legacy.destination,
          }),
        },
        deriveNostrPublicKey(deps.oracleSecretKeyHex),
      )
      const helper = createNativeOracleHelperAdapter({ resolveExecutable: () => realHelperPath })
      const prepared = await prepareNativeMarketOracle({ ...deps, helper }, legacy)
      const exact = prepared.record.announcement!.announcementNostrEventJson
      assert.equal(
        JSON.parse(exact).tags.find((tag: string[]) => tag[0] === 'description')?.[1],
        '## Legacy - First condition - Exception',
      )
      assert.equal(prepared.market.metadata.description, description)
      const backup = await deps.store.exportBackup(
        prepared.record.announcement!.conditionId,
        helper,
      )
      assert.equal(backup.authority.announcementEventJson, exact)
      const retry = await prepareNativeMarketOracle(
        { ...deps, helper, store: createNativeOracleCreationStore(directory) },
        legacy,
      )
      assert.equal(retry.record.announcement!.announcementNostrEventJson, exact)
      assert.equal(JSON.parse(retry.record.canonicalInput).oracleAnnouncementTagsVersion, undefined)
    })
  },
)

interface ResolutionFixture {
  attestedOutcome: string
  attestationEvent: { createdAt: number; tags: string[][]; pubkey: string }
  registeredAuthority: {
    eventId: string
    oracles: { noncePoint: string; announcementIdentity: string }[]
  }
  oracleWitness: { oracle_sigs: { oracle_sig: string }[] }
}

async function withPublication(
  run: (
    ports: NativeOraclePublicationPorts,
    conditionId: string,
    directory: string,
    calls: { signed: number; submitted: number; relayed: string[] },
  ) => Promise<void>,
) {
  await withFixture(async (deps, directory) => {
    const helper = createNativeOracleHelperAdapter({ resolveExecutable: () => realHelperPath })
    const calls = { signed: 0, submitted: 0, relayed: [] as string[] }
    const sign = helper.signEnum
    helper.signEnum = async (request) => {
      calls.signed++
      assert.equal(
        (await createNativeOracleCreationStore(directory).readCreation(input.creationId))
          ?.chosenOutcome,
        request.chosenOutcome,
      )
      return sign(request)
    }
    const prepared = await prepareNativeMarketOracle({ ...deps, helper }, input)
    const conditionId = prepared.record.announcement!.conditionId
    const ports: NativeOraclePublicationPorts = {
      store: deps.store,
      helper,
      readSigner: async () => ({
        secretKeyHex: (
          await createNativeOracleCreationStore(directory).readCreationSigner(input.creationId)
        ).secretKeyHex,
        nonceSeedHex: deps.nonceSeedHex,
      }),
      async publishRelay(eventJson) {
        const saved =
          await createNativeOracleCreationStore(directory).readByConditionId(conditionId)
        assert.ok(saved?.attestation)
        if (JSON.parse(eventJson).kind === 1111) assert.equal(saved.explanationEventJson, eventJson)
        else assert.equal(saved.attestation.attestationNostrEventJson, eventJson)
        calls.relayed.push(eventJson)
        return { eventId: JSON.parse(eventJson).id }
      },
      async submitEvent(id, eventJson) {
        calls.submitted++
        assert.equal(id, conditionId)
        const saved = await createNativeOracleCreationStore(directory).readByConditionId(id)
        assert.equal(saved?.attestation?.attestationNostrEventJson, eventJson)
        return { result: 'Closed' }
      },
      async readResolution(id) {
        const saved = (await createNativeOracleCreationStore(directory).readByConditionId(id))!
        if (saved.attestation === null) return null
        const announcement = saved.announcement!
        const attestation = saved.attestation
        const verified = await helper.verifyEnum({
          eventId: saved.eventId,
          oraclePublicKeyHex: saved.creatorPublicKeyHex,
          chosenOutcome: saved.chosenOutcome!,
          announcementTlvHex: announcement.announcementTlvHex,
          announcementNostrEventJson: announcement.announcementNostrEventJson,
          attestationHex: attestation.attestationHex,
          attestationNostrEventJson: attestation.attestationNostrEventJson,
        })
        const { created_at, ...event } = JSON.parse(attestation.attestationNostrEventJson)
        return {
          conditionId: id,
          attestedOutcome: saved.chosenOutcome,
          attestationEvent: { ...event, createdAt: created_at },
          registeredAuthority: {
            eventId: saved.eventId,
            outcomes: ['Yes', 'No'],
            threshold: 1,
            oracles: [
              {
                oraclePublicKey: saved.creatorPublicKeyHex,
                noncePoint: verified.noncePointHex,
                announcementIdentity: createHash('sha256')
                  .update(Buffer.from(announcement.announcementTlvHex, 'hex'))
                  .digest('hex'),
              },
            ],
          },
          oracleWitness: {
            oracle_sigs: [
              {
                oracle_pubkey: saved.creatorPublicKeyHex,
                oracle_sig: verified.oracleSignatureHex,
                outcome: saved.chosenOutcome,
              },
            ],
          },
        }
      },
    }
    await run(ports, conditionId, directory, calls)
  })
}

test(
  'native publication cold retry preserves exact artifacts and does not unlock or sign',
  realCrypto,
  async () => {
    await withPublication(async (ports, conditionId, directory, calls) => {
      const relay = ports.publishRelay
      const failed = await publishNativeMarketOutcome(
        {
          ...ports,
          publishRelay: async () => {
            throw new Error('relay unavailable')
          },
        },
        conditionId,
        'Yes',
        'Observed result. <b>Plain text</b>',
      )
      assert.deepEqual(failed.failures, ['relay', 'explanation-relay'])
      assert.ok(failed.record.engineEvidence)
      assert.equal(nativeOraclePublicationRpcResult(failed).result, 'Closed')
      assert.equal(nativeOraclePublicationRpcResult(failed).record.relayPublished, false)
      const coldStore = createNativeOracleCreationStore(directory)
      const saved = (await coldStore.readByConditionId(conditionId))!
      assert.equal(
        saved.attestation?.attestationNostrEventJson,
        failed.record.attestation?.eventJson,
      )
      assert.equal(saved.explanationEventJson, failed.record.explanationEventJson)
      const retried = await retryNativeMarketPublication(
        {
          ...ports,
          store: coldStore,
          publishRelay: relay,
          readSigner: async () => {
            throw new Error('Signer must not be read on retry.')
          },
        },
        conditionId,
      )
      assert.deepEqual(retried.failures, [])
      assert.equal(retried.record.relayPublished, true)
      assert.equal(retried.record.explanationRelayPublished, true)
      assert.equal(calls.signed, 1)
      assert.equal(calls.submitted, 1)
      assert.deepEqual(calls.relayed, [
        saved.attestation!.attestationNostrEventJson,
        saved.explanationEventJson,
      ])
      const session = createDaemonStateSqliteSession(directory)
      for (const sql of [
        "UPDATE daemon_oracle_creations SET chosen_outcome = 'No'",
        "UPDATE daemon_oracle_creations SET explanation_draft = 'Changed reason'",
        'UPDATE daemon_oracle_creations SET attestation_relay_published = 0',
        'UPDATE daemon_oracle_creations SET attestation_engine_evidence_json = NULL',
        'UPDATE daemon_oracle_creations SET explanation_event_json = NULL',
        'UPDATE daemon_oracle_creations SET explanation_relay_published = 0',
      ])
        await assert.rejects(
          session.transaction((database) => database.exec(sql)),
          /immutable/,
        )
      await assert.rejects(publishNativeMarketOutcome(ports, conditionId, 'No'), /conflicts/)
      assert.equal(calls.signed, 1)
    })
  },
)

test(
  'native first signing and unsigned retry refuse observed results or read failure before effects',
  realCrypto,
  async () => {
    await withPublication(async (ports, conditionId, _directory, calls) => {
      const observations = [
        async () => ({ conditionId, attestedOutcome: 'Yes' }),
        async () => ({ conditionId, attestedOutcome: 'No' }),
        async () => {
          throw new Error('engine unavailable')
        },
      ]
      let choices = 0
      let signerReads = 0
      const guarded = {
        ...ports,
        store: {
          ...ports.store,
          chooseAuthorityOutcome: async (
            ...args: Parameters<typeof ports.store.chooseAuthorityOutcome>
          ) => {
            choices++
            return ports.store.chooseAuthorityOutcome(...args)
          },
        },
        readSigner: async () => {
          signerReads++
          return ports.readSigner()
        },
      }
      for (const readResolution of observations) {
        await assert.rejects(
          publishNativeMarketOutcome(
            { ...guarded, readResolution },
            conditionId,
            'Yes',
            'New draft',
          ),
          /No new outcome was signed/,
        )
        const saved = (await ports.store.readAuthorityByConditionId(conditionId))!
        assert.equal(saved.chosenOutcome, null)
        assert.equal(saved.explanationDraft, null)
      }
      await ports.store.chooseAuthorityOutcome(conditionId, 'Yes', 'Original draft')
      for (const readResolution of observations) {
        await assert.rejects(
          retryNativeMarketPublication({ ...guarded, readResolution }, conditionId),
          /No new outcome was signed/,
        )
        const saved = (await ports.store.readAuthorityByConditionId(conditionId))!
        assert.equal(saved.chosenOutcome, 'Yes')
        assert.equal(saved.explanationDraft, 'Original draft')
        assert.equal(saved.attestation, null)
      }
      assert.equal(choices, 0)
      assert.equal(signerReads, 0)
      assert.equal(calls.signed, 0)
      assert.equal(calls.submitted, 0)
      assert.deepEqual(calls.relayed, [])
    })
  },
)

test(
  'native explicit relay-only first signing stays offline and exact retries never sign again',
  realCrypto,
  async () => {
    await withPublication(async (ports, conditionId, _directory, calls) => {
      let reads = 0
      const offline = {
        ...ports,
        readResolution: async () => {
          reads++
          throw new Error('engine unavailable')
        },
      }
      const signed = await publishNativeMarketOutcome(offline, conditionId, 'Yes', undefined, {
        engineDelivery: 'relay-only',
      })
      assert.equal(reads, 0)
      assert.equal(calls.signed, 1)
      assert.equal(calls.submitted, 0)
      assert.equal(signed.record.relayPublished, true)
      await assert.rejects(
        publishNativeMarketOutcome(offline, conditionId, 'No', undefined, {
          engineDelivery: 'relay-only',
        }),
        /conflicts/,
      )
      const retried = await retryNativeMarketPublication(
        {
          ...offline,
          readSigner: async () => {
            throw new Error('Exact retry must not read the signer')
          },
        },
        conditionId,
      )
      assert.deepEqual(retried.record.attestation, signed.record.attestation)
      assert.deepEqual(retried.failures, ['engine'])
      assert.equal(calls.signed, 1)
      assert.equal(reads, 1)
    })
  },
)

test(
  'native engine evidence reuses verification without another helper process',
  realCrypto,
  async () => {
    await withPublication(async (ports, conditionId) => {
      let verifications = 0
      const verify = ports.helper.verifyEnum
      ports.helper.verifyEnum = async (request) => {
        verifications++
        return verify(request)
      }
      const result = await publishNativeMarketOutcome(ports, conditionId, 'Yes')
      assert.ok(result.record.engineEvidence)
      assert.equal(nativeOraclePublicationRpcResult(result).result, 'Closed')
      // Two shared artifact checks, one engine fixture check, and one observed-evidence check.
      assert.equal(verifications, 4)
    })
  },
)

test(
  'native publication verifies the additive exact attestation through the real SDK read parser',
  realCrypto,
  async () => {
    await withPublication(async (ports, conditionId) => {
      const client = new BitcasterEngineClient({
        baseUrl: 'https://engine.example',
        fetchImpl: async () => {
          const result = await ports.readResolution(conditionId)
          return result === null ? new Response(null, { status: 404 }) : Response.json(result)
        },
      })
      const result = await publishNativeMarketOutcome(
        { ...ports, readResolution: (id) => client.getConditionAttestation(id) },
        conditionId,
        'Yes',
      )
      assert.ok(result.record.engineEvidence)
      assert.equal(nativeOraclePublicationRpcResult(result).result, 'Closed')
      assert.deepEqual(result.failures, [])
    })
  },
)

test(
  'native publication keeps relay success when engine evidence is unavailable and retries only engine',
  realCrypto,
  async () => {
    await withPublication(async (ports, conditionId, directory, calls) => {
      const failed = await publishNativeMarketOutcome(
        {
          ...ports,
          readResolution: async () =>
            (await ports.store.readAuthorityByConditionId(conditionId))?.attestation === null
              ? null
              : { result: 'Closed' },
        },
        conditionId,
        'Yes',
      )
      assert.deepEqual(failed.failures, ['engine'])
      assert.equal(failed.record.relayPublished, true)
      assert.equal(failed.record.engineEvidence, null)
      assert.equal(nativeOraclePublicationRpcResult(failed).result, undefined)
      const retried = await retryNativeMarketPublication(
        {
          ...ports,
          store: createNativeOracleCreationStore(directory),
          readSigner: async () => {
            throw new Error('Signer unavailable')
          },
        },
        conditionId,
      )
      assert.ok(retried.record.engineEvidence)
      assert.equal(calls.relayed.length, 1)
      assert.equal(calls.signed, 1)
      assert.equal(calls.submitted, 2)
    })
  },
)

test(
  'native publication saves choice and exact attestation before effects and retains interrupted choice',
  realCrypto,
  async () => {
    await withPublication(async (ports, conditionId, directory, calls) => {
      await assert.rejects(
        publishNativeMarketOutcome(
          {
            ...ports,
            store: {
              ...ports.store,
              chooseOutcome: async () => {
                throw new Error('choice save failed')
              },
            },
          },
          conditionId,
          'Yes',
        ),
        /choice save failed/,
      )
      assert.equal(calls.signed, 0)
      await assert.rejects(
        publishNativeMarketOutcome(
          {
            ...ports,
            store: {
              ...ports.store,
              persistAttestation: async () => {
                throw new Error('artifact save failed')
              },
            },
          },
          conditionId,
          'Yes',
        ),
        /artifact save failed/,
      )
      const cold = await createNativeOracleCreationStore(directory).readByConditionId(conditionId)
      assert.equal(cold?.chosenOutcome, 'Yes')
      assert.equal(cold?.attestation, null)
      assert.equal(calls.submitted, 0)
      assert.equal(calls.relayed.length, 0)
      await assert.rejects(publishNativeMarketOutcome(ports, conditionId, 'No'), /conflicts/)
      const completed = await publishNativeMarketOutcome(ports, conditionId, 'Yes')
      assert.ok(completed.record.engineEvidence)
    })
  },
)

test(
  'native retry signs an interrupted saved choice once with its original explanation draft',
  realCrypto,
  async () => {
    await withPublication(async (ports, conditionId, directory, calls) => {
      await assert.rejects(
        publishNativeMarketOutcome(
          {
            ...ports,
            readSigner: async () => {
              throw new Error('signer unavailable')
            },
          },
          conditionId,
          'Yes',
          'Original observed result.',
        ),
        /signer unavailable/,
      )
      const interrupted =
        await createNativeOracleCreationStore(directory).readByConditionId(conditionId)
      assert.equal(interrupted?.chosenOutcome, 'Yes')
      assert.equal(interrupted?.attestation, null)
      assert.equal(calls.signed, 0)
      const resumed = await retryNativeMarketPublication(
        { ...ports, store: createNativeOracleCreationStore(directory) },
        conditionId,
      )
      assert.deepEqual(resumed.failures, [])
      assert.equal(calls.signed, 1)
      assert.equal(resumed.record.chosenOutcome, 'Yes')
      assert.ok(resumed.record.engineEvidence)
      assert.equal(
        JSON.parse(resumed.record.explanationEventJson!).content,
        'Original observed result.',
      )
      const repeated = await retryNativeMarketPublication(
        {
          ...ports,
          store: createNativeOracleCreationStore(directory),
          readSigner: async () => {
            throw new Error('A saved signature must not be prepared again.')
          },
        },
        conditionId,
      )
      assert.equal(calls.signed, 1)
      assert.equal(repeated.record.attestation!.eventJson, resumed.record.attestation!.eventJson)
    })
  },
)

test(
  'native publication companion save or delivery failure does not invalidate resolution',
  realCrypto,
  async () => {
    await withPublication(async (ports, conditionId, directory) => {
      const persisted = ports.store.persistPublicationProgress
      const failed = await publishNativeMarketOutcome(
        {
          ...ports,
          store: {
            ...ports.store,
            persistPublicationProgress: (id, change) =>
              change.kind === 'explanation'
                ? Promise.reject(new Error('companion save failed'))
                : persisted(id, change),
          },
        },
        conditionId,
        'Yes',
        'Reason',
      )
      assert.deepEqual(failed.failures, ['explanation-preparation'])
      assert.ok(failed.record.engineEvidence)
      assert.equal(
        (await createNativeOracleCreationStore(directory).readByConditionId(conditionId))
          ?.explanationEventJson,
        null,
      )
      const added = await publishNativeMarketOutcome(
        {
          ...ports,
          publishRelay: async (eventJson) => {
            if (JSON.parse(eventJson).kind === 1111) throw new Error('companion relay failed')
            return ports.publishRelay(eventJson)
          },
        },
        conditionId,
        'Yes',
        'Reason',
      )
      assert.deepEqual(added.failures, ['explanation-relay'])
      assert.ok(added.record.engineEvidence)
      assert.ok(added.record.explanationEventJson)
    })
  },
)

test(
  'native companion preparation failure cold retry uses only the original immutable draft',
  realCrypto,
  async () => {
    await withPublication(async (ports, conditionId, directory, calls) => {
      let signerReads = 0
      const original = 'Original observed result. Ω'
      const failed = await publishNativeMarketOutcome(
        {
          ...ports,
          readSigner: async () => {
            if (++signerReads === 2) throw new Error('Companion preparation is unavailable.')
            return ports.readSigner()
          },
        },
        conditionId,
        'Yes',
        original,
      )
      assert.deepEqual(failed.failures, ['explanation-preparation'])
      assert.ok(failed.record.engineEvidence)
      const cold = createNativeOracleCreationStore(directory)
      const retained = (await cold.readByConditionId(conditionId))!
      assert.equal(retained.explanationDraft, original)
      assert.equal(retained.explanationEventJson, null)
      const exact89 = retained.attestation!.attestationNostrEventJson
      await assert.rejects(
        publishNativeMarketOutcome(
          { ...ports, store: cold },
          conditionId,
          'Yes',
          'Replacement text',
        ),
        /conflict/,
      )
      assert.equal(calls.signed, 1)
      const retried = await retryNativeMarketPublication({ ...ports, store: cold }, conditionId)
      assert.deepEqual(retried.failures, [])
      assert.equal(retried.record.attestation!.eventJson, exact89)
      assert.equal(JSON.parse(retried.record.explanationEventJson!).content, original)
      assert.equal(calls.signed, 1)
      assert.equal(calls.submitted, 1)
      const exact1111 = retried.record.explanationEventJson
      const again = await retryNativeMarketPublication(
        {
          ...ports,
          store: createNativeOracleCreationStore(directory),
          readSigner: async () => {
            throw new Error('Retained artifacts must not be signed again.')
          },
        },
        conditionId,
      )
      assert.equal(again.record.attestation!.eventJson, exact89)
      assert.equal(again.record.explanationEventJson, exact1111)
    })
  },
)

test(
  'native engine verification rejects substituted signed fields, authority and witness',
  realCrypto,
  async () => {
    await withPublication(async (ports, conditionId) => {
      const mutations = [
        (value: ResolutionFixture) => {
          value.attestationEvent.createdAt++
        },
        (value: ResolutionFixture) => {
          value.attestationEvent.tags = [['e', '00'.repeat(32)]]
        },
        (value: ResolutionFixture) => {
          value.attestationEvent.pubkey = '00'.repeat(32)
        },
        (value: ResolutionFixture) => {
          value.attestedOutcome = 'No'
        },
        (value: ResolutionFixture) => {
          value.registeredAuthority.eventId = 'other'
        },
        (value: ResolutionFixture) => {
          value.registeredAuthority.oracles[0].noncePoint = '00'.repeat(32)
        },
        (value: ResolutionFixture) => {
          value.registeredAuthority.oracles[0].announcementIdentity = '00'.repeat(32)
        },
        (value: ResolutionFixture) => {
          value.oracleWitness.oracle_sigs[0].oracle_sig = '00'.repeat(64)
        },
      ]
      for (const mutate of mutations) {
        const result = await publishNativeMarketOutcome(
          {
            ...ports,
            readResolution: async (id) => {
              const value = await ports.readResolution(id)
              if (value !== null) mutate(value as ResolutionFixture)
              return value
            },
          },
          conditionId,
          'Yes',
        )
        assert.deepEqual(result.failures, ['engine'])
        assert.equal(result.record.engineEvidence, null)
      }
      assert.ok((await retryNativeMarketPublication(ports, conditionId)).record.engineEvidence)
    })
  },
)

test(
  'native verify-only helper rejects foreign outcome and exact event parent without signing',
  realCrypto,
  async () => {
    await withPublication(async (ports, conditionId, _directory, calls) => {
      const result = await publishNativeMarketOutcome(ports, conditionId, 'Yes')
      const saved = (await ports.store.readByConditionId(conditionId))!
      const request = {
        eventId: saved.eventId,
        oraclePublicKeyHex: saved.creatorPublicKeyHex,
        chosenOutcome: 'Yes',
        announcementTlvHex: saved.announcement!.announcementTlvHex,
        announcementNostrEventJson: saved.announcement!.announcementNostrEventJson,
        attestationHex: result.record.attestation!.attestationHex,
        attestationNostrEventJson: result.record.attestation!.eventJson,
      }
      await assert.rejects(ports.helper.verifyEnum({ ...request, chosenOutcome: 'No' }))
      const event = JSON.parse(request.attestationNostrEventJson)
      event.tags = [['e', '00'.repeat(32)]]
      await assert.rejects(
        ports.helper.verifyEnum({ ...request, attestationNostrEventJson: JSON.stringify(event) }),
      )
      await assert.rejects(
        ports.helper.verifyEnum({ ...request, oraclePublicKeyHex: '00'.repeat(32) }),
      )
      assert.equal(calls.signed, 1)
    })
  },
)
