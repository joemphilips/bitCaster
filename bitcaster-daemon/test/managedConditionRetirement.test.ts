import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import {
  HttpResponseError,
  MintOperationError,
  deriveConditionalKeysetId,
  type Proof,
} from '@cashu/cashu-ts'
import { deriveRootCtfOutcomeCollectionId } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'
import { ORACLE_NOT_ATTESTED_OUTCOME_CODE } from '@bitcaster-market/client-sdk/ctfRedeem'
import { createCtfProofOperationCompletion } from '@bitcaster-market/client-sdk/ctfSplit'
import { deriveDlcConditionId } from '@bitcaster-market/client-sdk/managedConditionInventory'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import {
  addAvailableProofs,
  completeDurableOutgoingWalletSendFromDatabase,
  completeManagedConditionRedeemFenced,
  prepareProofOperationWithExactReservation,
  readState,
  writeState,
} from '../src/state.ts'
import { createDaemonCounterSource } from '../src/walletOps.ts'
import {
  retireDaemonConditionInventory,
  retireResolvedDaemonConditions,
} from '../src/managedConditionRetirement.ts'
import { withDurableCustodyUnitOfWork } from '../src/durableCustodyUnitOfWork.ts'
import { readProfile } from '../src/profile.ts'
import {
  CTF_KEYSET_ID,
  FakeRetirementWallet,
  REGULAR_KEYS,
  REGULAR_KEYSET_ID,
  outcomeKeyset,
  proof,
} from './support/retirementWallet.ts'
import {
  FAR_MATURITY_EPOCH,
  pendingResolution,
  resolvedResolution,
  unavailableResolution,
  type ConditionResultFixture,
} from './support/conditionResolutionStub.ts'
import type { ConditionResolution } from '@bitcaster-market/client-sdk/conditionResolution'
import type { DaemonConditionResolution } from '../src/nativeConditionResolution.ts'

const roots: string[] = []
const REGULAR_KEY = bytesToHex(
  secp256k1.getPublicKey(Uint8Array.from([...new Uint8Array(31), 1]), true),
)
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))))

async function createRetirementFixture(count = 65) {
  const previous = process.env.BITCASTER_DAEMON_HOME
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-retirement-'))
  roots.push(root)
  const directory = join(root, 'profile')
  process.env.BITCASTER_DAEMON_HOME = directory
  const seed = '11'.repeat(64)
  const bootstrap = await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: 'https://mint.example',
    walletSeedHex: seed,
    nostrSecretKeyHex: '22'.repeat(32),
    rpcToken: 'R'.repeat(43),
    initializedAtMs: 1_700_000_000_000,
  })
  const fence = await claimCustodyScopeLease(directory, {
    scopeId: bootstrap.walletScopeId,
    incarnationId: 'managed-condition-retirement-test',
    observedAtMs: 1_700_000_000_100,
  })
  const oraclePrivateKey = Uint8Array.from([...new Uint8Array(31), 1])
  const oraclePublicKey = bytesToHex(schnorr.getPublicKey(oraclePrivateKey))
  const eventId = 'daemon-retirement-test'
  const conditionId = deriveDlcConditionId({
    eventId,
    outcomeCount: 2,
    oraclePublicKeys: [oraclePublicKey],
  })
  const signature = signOutcome('YES', oraclePrivateKey)
  const inputs = Array.from({ length: count }, (_, index) =>
    proof(CTF_KEYSET_ID, `conditional-input-${index.toString().padStart(3, '0')}`, 1),
  )
  await addAvailableProofs('https://mint.example', inputs, {
    kind: 'Outcome',
    conditionId,
    outcomeSetId: 'YES',
    baseAsset: 'sat',
    unit: 'msat',
  })
  const profile = await readProfile()
  assert.ok(profile)
  const wallet = new FakeRetirementWallet()
  const result: ConditionResultFixture = {
    conditionId,
    attestedOutcome: 'YES',
    oracleWitness: {
      oracle_sigs: [{ oracle_pubkey: oraclePublicKey, oracle_sig: signature, outcome: 'YES' }],
    },
    registeredAuthority: {
      eventId,
      outcomes: ['YES', 'NO'],
      threshold: 1,
      oracles: [
        {
          oraclePublicKey,
          noncePoint: signature.slice(0, 64),
          announcementIdentity: createHash('sha256')
            .update(Buffer.from([1]))
            .digest('hex'),
        },
      ],
    },
  }
  const common = {
    conditionId,
    profile,
    secrets: { walletSeedHex: seed },
    fence,
    intentKind: 'explicit-user-command' as const,
    resolution: resolvedResolution(result),
    walletDependencies: {
      createCashuWallet: () => wallet,
      resolveInputFeePpkByKeyset: async () => ({ [CTF_KEYSET_ID]: 0 }),
    },
  }

  return {
    directory,
    fence,
    oraclePrivateKey,
    oraclePublicKey,
    signature,
    profile,
    wallet,
    result,
    common,
    conditionId,
    dispose: async () => {
      if (previous === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = previous
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('automatic retirement reads only the conditions that the wallet still holds', async () => {
  const { directory, profile, fence, common, result, conditionId, dispose } =
    await createRetirementFixture(1)
  try {
    // One condition has only retained or retired proofs. It is history, not a holding.
    const history = 'cd'.repeat(32)
    await addAvailableProofs('https://mint.example', [proof(CTF_KEYSET_ID, 'history-proof', 1)], {
      kind: 'Outcome',
      conditionId: history,
      outcomeSetId: 'YES',
      baseAsset: 'sat',
      unit: 'msat',
    })
    const database = await openDaemonStateSqlite(directory)
    try {
      database
        .prepare(
          `UPDATE target_wallet_proofs SET state = 'locked', reserved_by = 'retained:history'
           WHERE condition_id = ?`,
        )
        .run(history)
    } finally {
      database.close()
    }
    const requested: Array<{ conditionId: string; signal: AbortSignal | undefined }> = []
    const results = await retireResolvedDaemonConditions({
      profile,
      secrets: common.secrets,
      fence,
      resolution: {
        read: async (id, options) => {
          requested.push({ conditionId: id, signal: options.signal })
          return pendingResolution(result).read(id, options)
        },
      },
      walletDependencies: common.walletDependencies,
    })
    assert.deepEqual(results, {
      results: [],
      awaitingAttestation: [],
      discoveryFailures: [],
      nextMaturityMs: FAR_MATURITY_EPOCH * 1000,
    })
    assert.deepEqual(
      requested.map((entry) => entry.conditionId),
      [conditionId],
    )
    assert.ok(requested[0]!.signal instanceof AbortSignal, 'the resolution read has no time bound')
  } finally {
    await dispose()
  }
})

test('a resolution read that does not answer in time is a discovery failure', async () => {
  const { profile, fence, common, conditionId, dispose } = await createRetirementFixture(1)
  try {
    const results = await retireResolvedDaemonConditions({
      profile,
      secrets: common.secrets,
      fence,
      // The time bound is the behavior under test, so this test uses a real 1 ms timer.
      resolutionReadTimeoutMs: 1,
      // This reader ignores the signal. The time bound still ends the read.
      resolution: { read: () => new Promise(() => {}) },
      walletDependencies: common.walletDependencies,
    })
    assert.deepEqual(results, {
      results: [],
      awaitingAttestation: [],
      discoveryFailures: [{ conditionId, error: 'condition resolution read timed out' }],
      nextMaturityMs: null,
    })
  } finally {
    await dispose()
  }
})

test('an engine close before the announced maturity waits for a retry, then retires once', async () => {
  const { profile, fence, common, result, conditionId, wallet, dispose } =
    await createRetirementFixture(1)
  try {
    const discover = (resolution: typeof common.resolution, closed: readonly string[]) =>
      retireResolvedDaemonConditions({
        profile,
        secrets: common.secrets,
        fence,
        resolution,
        walletDependencies: common.walletDependencies,
        closedConditionIds: new Set(closed),
      })
    const unreadable = pendingResolution(result)
    // Before its maturity the condition is not due. The scan only reports the maturity.
    assert.deepEqual(await discover(unreadable, []), {
      results: [],
      awaitingAttestation: [],
      discoveryFailures: [],
      nextMaturityMs: FAR_MATURITY_EPOCH * 1000,
    })
    // The engine close hint makes the condition due before the attestation is verifiable.
    assert.deepEqual(await discover(unreadable, [conditionId]), {
      results: [],
      awaitingAttestation: [conditionId],
      discoveryFailures: [],
      nextMaturityMs: null,
    })
    assert.equal(wallet.redeemCalls, 0)
    assert.deepEqual(await discover(common.resolution, [conditionId]), {
      results: [{ conditionId, error: null }],
      awaitingAttestation: [],
      discoveryFailures: [],
      nextMaturityMs: null,
    })
    const redeemed = wallet.redeemCalls
    assert.ok(redeemed > 0)
    // A later retry finds nothing held, so the claim does not happen again.
    assert.deepEqual(await discover(common.resolution, [conditionId]), {
      results: [],
      awaitingAttestation: [],
      discoveryFailures: [],
      nextMaturityMs: null,
    })
    assert.equal(wallet.redeemCalls, redeemed)
  } finally {
    await dispose()
  }
})

test('a failure after the retirement starts stays an unfinished retirement', async () => {
  const { profile, fence, common, conditionId, wallet, dispose } = await createRetirementFixture(1)
  try {
    wallet.error = new Error('mint unavailable')
    const results = await retireResolvedDaemonConditions({
      profile,
      secrets: common.secrets,
      fence,
      resolution: common.resolution,
      walletDependencies: common.walletDependencies,
    })
    // The redeem started, so the daemon must finish this retirement before it uses funds.
    assert.equal(wallet.redeemCalls, 1)
    assert.equal(results.results.length, 1)
    assert.equal(results.results[0]!.conditionId, conditionId)
    assert.notEqual(results.results[0]!.error, null)
    assert.deepEqual(results.awaitingAttestation, [])
    assert.deepEqual(results.discoveryFailures, [])
  } finally {
    await dispose()
  }
})

test('a retirement failure reports a mint answer only as fixed text', async () => {
  // A mint answer can quote long text, such as a blinded message or a proof Y point.
  const raw = `Token already spent: ${'02ab'.repeat(40)}`
  const { profile, fence, common, conditionId, dispose } = await createRetirementFixture(1)
  try {
    for (const [failure, expected] of [
      [
        new Error('retirement failed', { cause: new MintOperationError(11001, raw) }),
        'mint request was refused (mint code 11001)',
      ],
      [new HttpResponseError(raw, 502), 'mint request failed (HTTP 502)'],
    ] as const) {
      const results = await retireResolvedDaemonConditions({
        profile,
        secrets: common.secrets,
        fence,
        resolution: {
          read: async () => {
            throw failure
          },
        },
        walletDependencies: common.walletDependencies,
      })
      assert.deepEqual(results, {
        results: [],
        awaitingAttestation: [],
        discoveryFailures: [{ conditionId, error: expected }],
        nextMaturityMs: null,
      })
    }
  } finally {
    await dispose()
  }
})

/** Start a retirement, then fail before its first page is prepared. */
async function startRetirementWithoutPage(
  fixture: Awaited<ReturnType<typeof createRetirementFixture>>,
): Promise<void> {
  const getKeys = fixture.wallet.mint.getKeys
  fixture.wallet.mint.getKeys = async () => {
    throw new Error('mint keys are unavailable')
  }
  await assert.rejects(
    retireDaemonConditionInventory({ ...fixture.common, acknowledge: true }),
    /mint keys are unavailable/,
  )
  fixture.wallet.mint.getKeys = getKeys
  assert.equal(await retirementRedeemOperations(), 0)
}

async function retirementRedeemOperations(): Promise<number> {
  return Object.values((await readState())!.proofOperations).filter(
    (operation) => operation.metadata.purpose === 'managed-condition-retirement',
  ).length
}

/** The same registration with another announced nonce. The frozen witness does not verify. */
function changedNonce(
  result: ConditionResultFixture,
  oraclePublicKey: string,
): ConditionResultFixture {
  return {
    ...result,
    registeredAuthority: {
      ...result.registeredAuthority,
      oracles: [{ ...result.registeredAuthority.oracles[0]!, noncePoint: oraclePublicKey }],
    },
  }
}

function mintRecord(
  result: ConditionResultFixture,
  state: ConditionResolution['state'],
): DaemonConditionResolution {
  return {
    read: async (id, options) => ({
      ...(await pendingResolution(result).read(id, options)),
      state,
    }),
  }
}

test('a started retirement prepares no page that the mint cannot redeem', async () => {
  const fixture = await createRetirementFixture(1)
  const { common, result, wallet, oraclePublicKey, dispose } = fixture
  try {
    await startRetirementWithoutPage(fixture)
    const changed = changedNonce(result, oraclePublicKey)
    for (const [resolution, refusal] of [
      // The mint does not answer, so the daemon cannot verify the frozen witness.
      [unavailableResolution, /mint condition information is unavailable/],
      // The witness does not verify, and the mint has no result to use instead.
      [pendingResolution(changed), /no mint result/],
      // The mint records another outcome, so it cannot redeem this page without a witness.
      [
        mintRecord(changed, { status: 'unverified', reportedOutcome: 'NO', reason: 'missing' }),
        /no mint result/,
      ],
    ] as const) {
      await assert.rejects(
        retireDaemonConditionInventory({ ...common, acknowledge: true, resolution }),
        refusal,
      )
      assert.equal(wallet.redeemCalls, 0)
      assert.equal(await retirementRedeemOperations(), 0)
    }
    // A readable registration verifies the frozen witness again. Each input carries it.
    const retired = await retireDaemonConditionInventory({
      ...common,
      acknowledge: true,
      resolution: pendingResolution(result),
    })
    assert.equal(retired.state, 'retired')
    assert.deepEqual(wallet.witnesses, [JSON.stringify(result.oracleWitness)])
  } finally {
    await dispose()
  }
})

test('a started retirement omits an unverifiable witness only when the mint records its outcome', async () => {
  const fixture = await createRetirementFixture(1)
  const { common, result, wallet, oraclePublicKey, dispose } = fixture
  try {
    await startRetirementWithoutPage(fixture)
    const retired = await retireDaemonConditionInventory({
      ...common,
      acknowledge: true,
      resolution: mintRecord(changedNonce(result, oraclePublicKey), {
        status: 'unverified',
        reportedOutcome: 'YES',
        reason: 'missing',
      }),
    })
    assert.equal(retired.state, 'retired')
    // The mint uses its recorded result for an input without a witness.
    assert.deepEqual(wallet.witnesses, [undefined])
  } finally {
    await dispose()
  }
})

test('daemon previews then atomically retires one verified condition inventory', async () => {
  const {
    directory,
    fence,
    oraclePrivateKey,
    oraclePublicKey,
    signature,
    profile,
    wallet,
    result,
    common,
    conditionId,
  } = await createRetirementFixture()
  // The same oracle result, registered for another event of the same oracle.
  const resultFor = (forCondition: string, forEvent: string): ConditionResultFixture => ({
    ...result,
    conditionId: forCondition,
    registeredAuthority: { ...result.registeredAuthority, eventId: forEvent },
  })

  assert.deepEqual(await retireDaemonConditionInventory({ ...common, acknowledge: false }), {
    conditionId,
    state: 'preview',
    action: 'redeem-winning-and-retain-losing',
    proofCount: 65,
    redeemableProofCount: 65,
    retainedProofCount: 0,
    grossAmountSubunits: 65,
    retainedAmountSubunits: 0,
    estimatedInputFeeSubunits: 0,
    netAmountSubunits: 65,
  })
  assert.equal(wallet.redeemCalls, 0)

  const retired = await retireDaemonConditionInventory({ ...common, acknowledge: true })
  assert.equal(retired.state, 'retired')
  assert.equal(wallet.redeemCalls, 2)
  const state = await readState()
  assert.ok(state)
  assert.equal(
    state.wallet.proofs
      .filter(({ asset }) => asset.kind === 'sats')
      .reduce((sum, { proof }) => sum + Number(proof.amount), 0),
    65,
  )
  await assertManagedRedeemCompletionIsTerminal({ directory, fence, state })
  await assert.rejects(
    addAvailableProofs('https://mint.example', [proof(CTF_KEYSET_ID, 'late-proof', 1)], {
      kind: 'Outcome',
      conditionId,
      outcomeSetId: 'YES',
      baseAsset: 'sat',
      unit: 'msat',
    }),
    /rejects new intent/,
  )

  const losingEventId = 'daemon-retirement-losing-test'
  const losingConditionId = deriveDlcConditionId({
    eventId: losingEventId,
    outcomeCount: 2,
    oraclePublicKeys: [oraclePublicKey],
  })
  const winningId = deriveConditionalKeysetId({
    keys: REGULAR_KEYS,
    unit: 'msat',
    conditionId: losingConditionId,
    outcomeCollectionId: deriveRootCtfOutcomeCollectionId({
      conditionId: losingConditionId,
      outcomeCollection: 'YES',
    }),
  })
  const losingInput = proof(winningId, 'conditional-winner-refused', 5)
  await addAvailableProofs('https://mint.example', [losingInput], {
    kind: 'Outcome',
    conditionId: losingConditionId,
    outcomeSetId: 'YES',
    baseAsset: 'sat',
    unit: 'msat',
  })
  const losingWallet = new FakeRetirementWallet(
    new MintOperationError(ORACLE_NOT_ATTESTED_OUTCOME_CODE, 'oracle not attested'),
  )
  losingWallet.conditional = { ...outcomeKeyset(), id: winningId }
  losingWallet.conditionInfo = {
    condition_id: losingConditionId,
    threshold: 1,
    collateral: 'msat',
    announcements: ['01'],
    attestation: {
      status: 'attested',
      winning_outcome: 'YES',
      oracle_sigs: [{ oracle_pubkey: oraclePublicKey, oracle_sig: signature, outcome: 'YES' }],
    },
  }
  await assert.rejects(
    retireDaemonConditionInventory({
      ...common,
      conditionId: losingConditionId,
      acknowledge: true,
      resolution: resolvedResolution(resultFor(losingConditionId, losingEventId)),
      walletDependencies: {
        createCashuWallet: () => losingWallet,
        resolveInputFeePpkByKeyset: async () => ({ [winningId]: 0 }),
      },
    }),
    /refusal remains pending/,
  )
  const afterLosing = (await readState())!
  const retained = afterLosing.wallet.proofs.find(
    ({ proof: held }) => held.secret === losingInput.secret,
  )!
  assert.equal(retained.state, 'reserved')
  const pending = Object.values(afterLosing.proofOperations).find((operation) =>
    operation.inputs.some(({ secret }) => secret === losingInput.secret),
  )!
  assert.equal(pending.state, 'prepared')
  assert.equal(pending.failureCode, undefined)
  assert.ok(pending.metadata.oracleResolutionContext)
  const database = await openDaemonStateSqlite(directory)
  database.close()
  const reopened = (await readState())!
  assert.deepEqual(reopened.proofOperations[pending.operationId], pending)
  assert.equal(
    reopened.wallet.proofs.find(({ proof: held }) => held.secret === losingInput.secret)!
      .reservedBy,
    pending.operationId,
  )

  for (const fault of ['signature', 'missing-dleq', 'wrong-secret', 'wrong-amount'] as const) {
    const event = `retirement-bad-output-${fault}`
    const badCondition = deriveDlcConditionId({
      eventId: event,
      outcomeCount: 2,
      oraclePublicKeys: [oraclePublicKey],
    })
    const badInput = proof(CTF_KEYSET_ID, `bad-output-input-${fault}`, 4)
    await addAvailableProofs(profile.mintUrl, [badInput], {
      kind: 'Outcome',
      conditionId: badCondition,
      outcomeSetId: 'YES',
      baseAsset: 'sat',
      unit: 'msat',
    })
    const badWallet = new FakeRetirementWallet()
    badWallet.alterResult = (proofs) =>
      proofs.map((proof) => ({
        ...proof,
        ...(fault === 'signature'
          ? { C: REGULAR_KEY }
          : fault === 'missing-dleq'
            ? { dleq: undefined }
            : fault === 'wrong-secret'
              ? { secret: 'foreign' }
              : { amount: 3 }),
      })) as Proof[]
    await assert.rejects(
      retireDaemonConditionInventory({
        ...common,
        conditionId: badCondition,
        acknowledge: true,
        resolution: resolvedResolution(resultFor(badCondition, event)),
        walletDependencies: {
          createCashuWallet: () => badWallet,
          resolveInputFeePpkByKeyset: async () => ({ [CTF_KEYSET_ID]: 0 }),
        },
      }),
    )
    const reopenedDatabase = await openDaemonStateSqlite(directory)
    reopenedDatabase.close()
    const state = (await readState())!
    const pending = Object.values(state.proofOperations).find((operation) =>
      operation.inputs.some(({ secret }) => secret === badInput.secret),
    )!
    assert.equal(pending.state, 'prepared')
    assert.equal(
      state.wallet.proofs.find(({ proof: held }) => held.secret === badInput.secret)!.reservedBy,
      pending.operationId,
    )
    assert.equal(
      state.wallet.proofs.some(({ proof: held }) =>
        pending.outputs.regular?.some((output) => output.secret === held.secret),
      ),
      false,
    )
  }

  const legacyEvent = 'retirement-legacy-output-keys'
  const legacyCondition = deriveDlcConditionId({
    eventId: legacyEvent,
    outcomeCount: 2,
    oraclePublicKeys: [oraclePublicKey],
  })
  await addAvailableProofs(profile.mintUrl, [proof(CTF_KEYSET_ID, 'legacy-original-input', 4)], {
    kind: 'Outcome',
    conditionId: legacyCondition,
    outcomeSetId: 'YES',
    baseAsset: 'sat',
    unit: 'msat',
  })
  const legacyResponse = resultFor(legacyCondition, legacyEvent)
  const legacyCommon = {
    ...common,
    conditionId: legacyCondition,
    resolution: resolvedResolution(legacyResponse),
  }
  await assert.rejects(
    retireDaemonConditionInventory({
      ...legacyCommon,
      acknowledge: true,
      walletDependencies: {
        createCashuWallet: () => new FakeRetirementWallet(new Error('legacy timeout')),
        resolveInputFeePpkByKeyset: async () => ({ [CTF_KEYSET_ID]: 0 }),
      },
    }),
    /legacy timeout/,
  )
  const legacyState = (await readState())!
  const legacyOperation = Object.values(legacyState.proofOperations).find((operation) =>
    operation.inputs.some(({ secret }) => secret === 'legacy-original-input'),
  )!
  delete legacyOperation.metadata.regularOutputKeysetAuthority
  legacyOperation.metadata.oracleWitness = JSON.stringify(legacyResponse.oracleWitness)
  await writeState(legacyState)
  const originalLegacy = JSON.parse(JSON.stringify(legacyOperation))
  await assert.rejects(
    retireDaemonConditionInventory({
      ...legacyCommon,
      acknowledge: true,
      walletDependencies: {
        createCashuWallet: () => new FakeRetirementWallet(),
        resolveInputFeePpkByKeyset: async () => ({ [CTF_KEYSET_ID]: 0 }),
      },
    }),
    /output keyset authority is absent/,
  )
  const legacyReopenedDatabase = await openDaemonStateSqlite(directory)
  legacyReopenedDatabase.close()
  const legacyReopened = (await readState())!
  assert.deepEqual(
    JSON.parse(JSON.stringify(legacyReopened.proofOperations[legacyOperation.operationId])),
    originalLegacy,
  )
  assert.equal(
    legacyReopened.wallet.proofs.find(({ proof }) => proof.secret === 'legacy-original-input')!
      .reservedBy,
    legacyOperation.operationId,
  )

  const retryEventId = 'daemon-retirement-restart-test'
  const retryConditionId = deriveDlcConditionId({
    eventId: retryEventId,
    outcomeCount: 2,
    oraclePublicKeys: [oraclePublicKey],
  })
  await addAvailableProofs(
    'https://mint.example',
    [proof(CTF_KEYSET_ID, 'conditional-restart', 4)],
    {
      kind: 'Outcome',
      conditionId: retryConditionId,
      outcomeSetId: 'YES',
      baseAsset: 'sat',
      unit: 'msat',
    },
  )
  const retryResponse = resultFor(retryConditionId, retryEventId)
  await assert.rejects(
    retireDaemonConditionInventory({
      ...common,
      conditionId: retryConditionId,
      acknowledge: true,
      resolution: resolvedResolution(retryResponse),
      walletDependencies: {
        createCashuWallet: () => new FakeRetirementWallet(new Error('mint timeout')),
        resolveInputFeePpkByKeyset: async () => ({ [CTF_KEYSET_ID]: 0 }),
      },
    }),
    /mint timeout/,
  )
  const restartWallet = new FakeRetirementWallet()
  const restartResult = await retireDaemonConditionInventory({
    ...common,
    conditionId: retryConditionId,
    acknowledge: true,
    // The prepared page replays its saved witness and request. It does not read the mint
    // record again, so an unavailable record does not stop it.
    resolution: unavailableResolution,
    walletDependencies: {
      createCashuWallet: () => restartWallet,
      resolveInputFeePpkByKeyset: async () => ({ [CTF_KEYSET_ID]: 0 }),
    },
  })
  assert.equal(restartResult.state, 'retired')
  assert.equal(restartWallet.redeemCalls, 1)

  const reservedEventId = 'daemon-retirement-reserved-test'
  const reservedConditionId = deriveDlcConditionId({
    eventId: reservedEventId,
    outcomeCount: 2,
    oraclePublicKeys: [oraclePublicKey],
  })
  const reservedProof = proof(CTF_KEYSET_ID, 'conditional-reserved', 3)
  const reservedAsset = {
    kind: 'Outcome' as const,
    conditionId: reservedConditionId,
    outcomeSetId: 'YES',
    baseAsset: 'sat' as const,
    unit: 'msat' as const,
  }
  await addAvailableProofs('https://mint.example', [reservedProof], reservedAsset)
  await prepareProofOperationWithExactReservation(
    {
      operationId: 'foreign-reservation',
      kind: 'wallet-send',
      mintUrl: 'https://mint.example',
      inputs: [reservedProof],
      outputs: { send: [] },
      metadata: { purpose: 'test-reservation' },
      reservationId: 'foreign-reservation',
      asset: reservedAsset,
    },
    { fence, observedAtMs: Date.now() },
  )
  assert.equal(
    (await readState())?.wallet.proofs.find(
      (record) => record.proof.secret === reservedProof.secret,
    )?.state,
    'reserved',
  )
  await assert.rejects(
    retireDaemonConditionInventory({
      ...common,
      conditionId: reservedConditionId,
      acknowledge: true,
      resolution: resolvedResolution(resultFor(reservedConditionId, reservedEventId)),
    }),
    /pending proof reservations/,
  )
  assert.equal(
    (await readState())?.wallet.proofs.find(
      (record) => record.proof.secret === reservedProof.secret,
    )?.state,
    'reserved',
  )
})

async function assertManagedRedeemCompletionIsTerminal(input: {
  directory: string
  fence: Awaited<ReturnType<typeof claimCustodyScopeLease>>
  state: NonNullable<Awaited<ReturnType<typeof readState>>>
}): Promise<void> {
  const operation = Object.values(input.state.proofOperations).find(
    (candidate) =>
      candidate.kind === 'ctf-redeem' &&
      candidate.state === 'completed' &&
      candidate.metadata.purpose === 'managed-condition-retirement',
  )
  assert.ok(operation)
  const payout = operation.resultProofs?.regular?.[0]
  assert.ok(payout)
  const spendOperationId = 'spend-managed-redeem-payout'
  await prepareProofOperationWithExactReservation(
    {
      operationId: spendOperationId,
      kind: 'wallet-send',
      mintUrl: operation.mintUrl,
      inputs: [payout],
      outputs: { keep: [], send: [] },
      metadata: { reservationId: spendOperationId, unit: 'msat' },
      reservationId: spendOperationId,
      asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
    },
    { fence: input.fence, observedAtMs: Date.now() },
  )
  await withDurableCustodyUnitOfWork(input.directory, input.fence, Date.now(), (database) =>
    completeDurableOutgoingWalletSendFromDatabase(database, {
      operationId: spendOperationId,
      reservationId: spendOperationId,
      unit: 'msat',
      keepProofs: [],
      sendProofs: [proof(REGULAR_KEYSET_ID, 'external-recipient', Number(payout.amount))],
      nowMs: Date.now(),
    }),
  )
  const exactCompletion = createCtfProofOperationCompletion('ctf-redeem', {
    regular: operation.resultProofs!.regular as Proof[],
  })
  await completeManagedConditionRedeemFenced(operation.operationId, exactCompletion, {
    fence: input.fence,
    observedAtMs: Date.now(),
  })
  assert.equal(
    (await readState())?.wallet.proofs.some(
      ({ proof: candidate }) => candidate.secret === payout.secret,
    ),
    false,
  )
  await assert.rejects(
    completeManagedConditionRedeemFenced(
      operation.operationId,
      createCtfProofOperationCompletion('ctf-redeem', {
        regular: [proof(REGULAR_KEYSET_ID, 'different-result', Number(payout.amount))],
      }),
      { fence: input.fence, observedAtMs: Date.now() },
    ),
    /completed with a different result/,
  )
}

function signOutcome(outcome: string, privateKey: Uint8Array): string {
  const message = taggedHash('DLC/oracle/attestation/v0', utf8ToBytes(outcome))
  return bytesToHex(schnorr.sign(message, privateKey, Uint8Array.from(new Uint8Array(32))))
}

function taggedHash(tag: string, message: Uint8Array): Uint8Array {
  const tagHash = sha256(utf8ToBytes(tag))
  return sha256(concatBytes(tagHash, tagHash, message))
}

async function retirementFundFacts(directory: string) {
  const database = await openDaemonStateSqlite(directory)
  try {
    return Object.fromEntries(
      [
        'target_wallet_proofs',
        'target_keyset_counters',
        'custody_keyset_counters',
        'target_proof_operations',
        'custody_operations',
        'custody_proofs',
        'custody_proof_reservations',
        'custody_artifacts',
      ].map((table) => [
        table,
        database
          .prepare(`SELECT * FROM ${table}`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort(),
      ]),
    )
  } finally {
    database.close()
  }
}

for (const phase of ['before-commit', 'after-commit'] as const)
  test(`retirement atomic preparation ${phase} keeps exact owner authority and paired counters`, async () => {
    const fixture = await createRetirementFixture(3)
    try {
      const before = await retirementFundFacts(fixture.directory)
      let intent: string | undefined
      let injected = 0
      const run = retireDaemonConditionInventory({
        ...fixture.common,
        acknowledge: true,
        walletDependencies: {
          ...fixture.common.walletDependencies,
          injectCustodyFault: (at) => {
            if (at === phase && injected === 0) {
              injected++
              throw new Error('retirement preparation fault')
            }
          },
        },
      })
      if (phase === 'before-commit') {
        await assert.rejects(run, /retirement preparation fault/)
        assert.deepEqual(await retirementFundFacts(fixture.directory), before)
        assert.equal(fixture.wallet.redeemCalls, 0)
        const database = await openDaemonStateSqlite(fixture.directory)
        try {
          const owner = database
            .prepare(
              'SELECT state, revision, retirement_intent_id FROM daemon_managed_condition_inventory',
            )
            .get()!
          assert.equal(owner.state, 'retiring')
          assert.equal(owner.revision, 1)
          intent = String(owner.retirement_intent_id)
          assert.ok(intent.length > 0)
        } finally {
          database.close()
        }
      } else {
        assert.equal((await run).state, 'retired')
        const saved = await retirementFundFacts(fixture.directory)
        assert.equal(saved.target_keyset_counters!.length, 1)
        assert.equal(saved.custody_keyset_counters!.length, 1)
        assert.equal(saved.target_proof_operations!.length, 1)
      }
      assert.equal(injected, 1)
      assert.equal(
        (await retireDaemonConditionInventory({ ...fixture.common, acknowledge: true })).state,
        'retired',
      )
      assert.equal(fixture.wallet.redeemCalls, 1)
      const database = await openDaemonStateSqlite(fixture.directory)
      try {
        const owner = database
          .prepare(
            'SELECT state, revision, retirement_intent_id FROM daemon_managed_condition_inventory',
          )
          .get()!
        assert.equal(owner.state, 'retired')
        assert.equal(owner.revision, 2)
        if (intent !== undefined) assert.equal(owner.retirement_intent_id, intent)
      } finally {
        database.close()
      }
      // Final inventory revision is newer than the saved page's bind revision.
      const after = await retirementFundFacts(fixture.directory)
      await retireDaemonConditionInventory({ ...fixture.common, acknowledge: true })
      assert.deepEqual(await retirementFundFacts(fixture.directory), after)
      assert.equal(fixture.wallet.redeemCalls, 1)
    } finally {
      await fixture.dispose()
    }
  })

for (const conflicts of [1, 3])
  test(`retirement ${conflicts} counter conflicts keep one pinned budget and exact fee`, async () => {
    const fixture = await createRetirementFixture(3)
    try {
      let drafts = 0
      const source = createDaemonCounterSource(
        () => ({ fence: fixture.fence, observedAtMs: Date.now() }),
        { normalizedMint: fixture.profile.mintUrl, unit: 'msat' },
      )
      const run = retireDaemonConditionInventory({
        ...fixture.common,
        acknowledge: true,
        walletDependencies: {
          ...fixture.common.walletDependencies,
          observeRedeemPrepared: async (owner, draft) => {
            assert.equal(owner, 'retirement')
            assert.equal(draft.metadata!.regularKeysetId, REGULAR_KEYSET_ID)
            assert.equal(draft.metadata!.netOutputSubunits, 3)
            assert.equal(draft.metadata!.inputFeeSubunits, 0)
            drafts++
            if (drafts <= conflicts) await source.reserve(REGULAR_KEYSET_ID, 1)
          },
        },
      })
      if (conflicts === 3) {
        await assert.rejects(run, /counter snapshot/)
        assert.equal(fixture.wallet.redeemCalls, 0)
        assert.equal(
          (await retirementFundFacts(fixture.directory)).target_proof_operations!.length,
          0,
        )
      } else {
        assert.equal((await run).state, 'retired')
        assert.equal(fixture.wallet.redeemCalls, 1)
      }
      assert.equal(drafts, conflicts === 3 ? 3 : 2)
    } finally {
      await fixture.dispose()
    }
  })

test('retirement differing saved winner submits exact saved outputs and does not bind twice', async () => {
  const fixture = await createRetirementFixture(3)
  try {
    let drafts = 0
    let losing: string[] = []
    let winning: string[] = []
    let failure: unknown
    const result = await retireDaemonConditionInventory({
      ...fixture.common,
      acknowledge: true,
      walletDependencies: {
        ...fixture.common.walletDependencies,
        observeRedeemPrepared: async (_owner, draft) => {
          drafts++
          losing = draft.outputs.regular!.map(({ blindedMessage }) => blindedMessage.B_)
          await createDaemonCounterSource(
            () => ({ fence: fixture.fence, observedAtMs: Date.now() }),
            { normalizedMint: fixture.profile.mintUrl, unit: 'msat' },
          ).reserve(REGULAR_KEYSET_ID, 1)
          fixture.wallet.error = new Error('winner controlled transport refusal')
          await assert.rejects(
            retireDaemonConditionInventory({ ...fixture.common, acknowledge: true }),
            /winner controlled/,
          )
          winning = fixture.wallet.requests[0]!.map(({ B_ }) => B_)
          assert.notDeepEqual(winning, losing)
          fixture.wallet.error = undefined
        },
      },
    }).catch((error: unknown) => {
      failure = error
      return null
    })
    assert.equal(drafts, 1)
    assert.equal(fixture.wallet.redeemCalls, 2)
    assert.deepEqual(
      fixture.wallet.requests[1]!.map(({ B_ }) => B_),
      winning,
    )
    assert.notDeepEqual(
      fixture.wallet.requests[1]!.map(({ B_ }) => B_),
      losing,
    )
    if (failure !== undefined) throw failure
    assert.equal(result!.state, 'retired')
    assert.equal((await retirementFundFacts(fixture.directory)).target_proof_operations!.length, 1)
  } finally {
    await fixture.dispose()
  }
})

for (const corrupt of ['historical', 'reservation', 'owner'] as const)
  test(`retirement prepared ${corrupt === 'historical' ? 'historical outputs recover without current keyset selection' : `foreign ${corrupt} refuses before metadata`}`, async () => {
    const fixture = await createRetirementFixture(3)
    try {
      fixture.wallet.error = new Error('controlled initial transport timeout')
      await assert.rejects(
        retireDaemonConditionInventory({ ...fixture.common, acknowledge: true }),
        /controlled initial/,
      )
      const saved = await retirementFundFacts(fixture.directory)
      assert.equal(saved.target_proof_operations!.length, 1)
      const initial = fixture.wallet.requests[0]
      fixture.wallet.error = undefined
      let metadata = 0
      fixture.wallet.mint.getKeys = async () => {
        metadata++
        throw new Error('current keys must not be selected')
      }
      fixture.wallet.mint.getKeySets = async () => {
        metadata++
        throw new Error('current keysets must not be selected')
      }
      if (corrupt !== 'historical') {
        const database = await openDaemonStateSqlite(fixture.directory)
        try {
          if (corrupt === 'reservation')
            database
              .prepare(
                "UPDATE target_wallet_proofs SET reserved_by = 'foreign-operation' WHERE state = 'reserved'",
              )
              .run()
          else
            database
              .prepare(
                "UPDATE daemon_managed_condition_inventory SET retirement_intent_id = 'foreign-owner-intent'",
              )
              .run()
        } finally {
          database.close()
        }
        const before = await retirementFundFacts(fixture.directory)
        await assert.rejects(
          retireDaemonConditionInventory({ ...fixture.common, acknowledge: true }),
          /reservation|incomplete|owner authority/,
        )
        assert.deepEqual(await retirementFundFacts(fixture.directory), before)
        assert.equal(fixture.wallet.redeemCalls, 1)
      } else {
        assert.equal(
          (await retireDaemonConditionInventory({ ...fixture.common, acknowledge: true })).state,
          'retired',
        )
        assert.equal(fixture.wallet.redeemCalls, 2)
        assert.deepEqual(fixture.wallet.requests[1], initial)
        const after = await retirementFundFacts(fixture.directory)
        assert.deepEqual(after.target_keyset_counters, saved.target_keyset_counters)
        assert.deepEqual(after.custody_keyset_counters, saved.custody_keyset_counters)
      }
      assert.equal(metadata, 0)
    } finally {
      await fixture.dispose()
    }
  })
