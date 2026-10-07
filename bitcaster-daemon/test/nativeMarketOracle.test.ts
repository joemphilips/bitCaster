import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
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
import { BitcasterEngineClient } from '@bitcaster-market/client-sdk'

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
      assert.equal(request.description, 'A description')
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
        const announcement = saved.announcement!
        const attestation = saved.attestation!
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
        fetchImpl: async () => Response.json(await ports.readResolution(conditionId)),
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
        { ...ports, readResolution: async () => ({ result: 'Closed' }) },
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
              mutate(value as ResolutionFixture)
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
