import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { HttpResponseError, MintOperationError, type Proof } from '@cashu/cashu-ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'
import { ORACLE_NOT_ATTESTED_OUTCOME_CODE } from '@bitcaster-market/client-sdk/ctfRedeem'
import { deriveDlcConditionId } from '@bitcaster-market/client-sdk/managedConditionInventory'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import {
  addAvailableProofs,
  prepareProofOperationWithExactReservation,
  readAvailableCanonicalWalletProofPageFromDatabase,
  readState,
} from '../src/state.ts'
import { createDaemonCounterSource, sendWalletToken } from '../src/walletOps.ts'
import {
  resumeDaemonConditionRetirements,
  retireDaemonConditionInventory,
  retireResolvedDaemonConditions,
} from '../src/managedConditionRetirement.ts'
import { readProfile } from '../src/profile.ts'
import { dispatch } from '../src/server.ts'
import {
  CTF_KEYSET_ID,
  FakeRegularMint,
  FakeRetirementWallet,
  REGULAR_KEYSET_ID,
  holdOutcomeProofs,
  proof,
} from './support/retirementWallet.ts'
import { readActivityRows } from './nativeActivityTestHelpers.ts'
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

/** The test mint charges no input fee for any keyset. */
const noInputFees = async (_mintUrl: string, keysetIds: string[]) =>
  Object.fromEntries(keysetIds.map((keysetId) => [keysetId, 0]))

async function createRetirementFixture(
  count = 65,
  /** The amount of each held YES proof. */
  amount = 1,
  /** The input fee of the YES keyset. */
  inputFeePpk = 0,
) {
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
  const wallet = new FakeRetirementWallet()
  /** Custody receives these proofs as available positions. Each wallet learns the keyset. */
  const hold = (
    forCondition: string,
    outcomeCollection: string,
    proofs: ReadonlyArray<{ readonly secret: string; readonly amount: number }>,
    wallets: readonly FakeRetirementWallet[] = [wallet],
    keysetInputFeePpk = 0,
  ) =>
    holdOutcomeProofs({
      directory,
      fence,
      mintUrl: 'https://mint.example',
      conditionId: forCondition,
      outcomeCollection,
      proofs,
      wallets,
      inputFeePpk: keysetInputFeePpk,
    })
  await hold(
    conditionId,
    'YES',
    Array.from({ length: count }, (_, index) => ({
      secret: `conditional-input-${index.toString().padStart(3, '0')}`,
      amount,
    })),
    [wallet],
    inputFeePpk,
  )
  const profile = await readProfile()
  assert.ok(profile)
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
      resolveInputFeePpkByKeyset: noInputFees,
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
    hold,
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
    oraclePublicKey,
    signature,
    wallet,
    result,
    common,
    conditionId,
    hold,
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
  const losingWallet = new FakeRetirementWallet(
    new MintOperationError(ORACLE_NOT_ATTESTED_OUTCOME_CODE, 'oracle not attested'),
  )
  const {
    proofs: [losingInput],
  } = await hold(
    losingConditionId,
    'YES',
    [{ secret: 'conditional-winner-refused', amount: 4 }],
    [losingWallet],
  )
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
        resolveInputFeePpkByKeyset: noInputFees,
      },
    }),
    /refusal remains pending/,
  )
  const afterLosing = (await readState())!
  const retained = afterLosing.wallet.proofs.find(
    ({ proof: held }) => held.secret === losingInput!.secret,
  )!
  assert.equal(retained.state, 'reserved')
  const pending = Object.values(afterLosing.proofOperations).find((operation) =>
    operation.inputs.some(({ secret }) => secret === losingInput!.secret),
  )!
  assert.equal(pending.state, 'prepared')
  assert.equal(pending.failureCode, undefined)
  assert.ok(pending.metadata.oracleResolutionContext)
  const database = await openDaemonStateSqlite(directory)
  database.close()
  const reopened = (await readState())!
  assert.deepEqual(reopened.proofOperations[pending.operationId], pending)
  assert.equal(
    reopened.wallet.proofs.find(({ proof: held }) => held.secret === losingInput!.secret)!
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
    const badWallet = new FakeRetirementWallet()
    const {
      proofs: [badInput],
    } = await hold(
      badCondition,
      'YES',
      [{ secret: `bad-output-input-${fault}`, amount: 4 }],
      [badWallet],
    )
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
          resolveInputFeePpkByKeyset: noInputFees,
        },
      }),
    )
    const reopenedDatabase = await openDaemonStateSqlite(directory)
    reopenedDatabase.close()
    const state = (await readState())!
    const pending = Object.values(state.proofOperations).find((operation) =>
      operation.inputs.some(({ secret }) => secret === badInput!.secret),
    )!
    assert.equal(pending.state, 'prepared')
    assert.equal(
      state.wallet.proofs.find(({ proof: held }) => held.secret === badInput!.secret)!.reservedBy,
      pending.operationId,
    )
    assert.equal(
      state.wallet.proofs.some(({ proof: held }) =>
        pending.outputs.regular?.some((output) => output.secret === held.secret),
      ),
      false,
    )
  }

  const retryEventId = 'daemon-retirement-restart-test'
  const retryConditionId = deriveDlcConditionId({
    eventId: retryEventId,
    outcomeCount: 2,
    oraclePublicKeys: [oraclePublicKey],
  })
  const timeoutWallet = new FakeRetirementWallet(new Error('mint timeout'))
  const restartWallet = new FakeRetirementWallet()
  await hold(
    retryConditionId,
    'YES',
    [{ secret: 'conditional-restart', amount: 4 }],
    [timeoutWallet, restartWallet],
  )
  const retryResponse = resultFor(retryConditionId, retryEventId)
  await assert.rejects(
    retireDaemonConditionInventory({
      ...common,
      conditionId: retryConditionId,
      acknowledge: true,
      resolution: resolvedResolution(retryResponse),
      walletDependencies: {
        createCashuWallet: () => timeoutWallet,
        resolveInputFeePpkByKeyset: noInputFees,
      },
    }),
    /mint timeout/,
  )
  const restartResult = await retireDaemonConditionInventory({
    ...common,
    conditionId: retryConditionId,
    acknowledge: true,
    // The prepared page replays its saved witness and request. It does not read the mint
    // record again, so an unavailable record does not stop it.
    resolution: unavailableResolution,
    walletDependencies: {
      createCashuWallet: () => restartWallet,
      resolveInputFeePpkByKeyset: noInputFees,
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
  await hold(reservedConditionId, 'YES', [{ secret: 'conditional-reserved', amount: 2 }])
  const reservedAsset = {
    kind: 'Outcome' as const,
    conditionId: reservedConditionId,
    outcomeSetId: 'YES',
    baseAsset: 'sat' as const,
    unit: 'msat' as const,
  }
  const reservedProof = (await readState())!.wallet.proofs.find(
    (record) => record.proof.secret === 'conditional-reserved',
  )!.proof
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

/** The custody rows and redeem operations, grouped. Amounts are msat. */
async function custodyFacts(directory: string) {
  const database = await openDaemonStateSqlite(directory)
  try {
    const proofs = (outcome: boolean) =>
      database
        .prepare(
          `SELECT selectability, nut07_state AS state, COUNT(*) AS count, SUM(amount) AS total
           FROM custody_proofs WHERE condition_id IS ${outcome ? 'NOT ' : ''}NULL
           GROUP BY selectability, nut07_state ORDER BY selectability, nut07_state`,
        )
        .all()
        .map((row) => `${row.selectability}/${row.state}:${row.count}/${row.total}`)
    return {
      regular: proofs(false),
      outcome: proofs(true),
      redeems: database
        .prepare(
          `SELECT operation_state AS state, COUNT(*) AS count FROM custody_operations
           WHERE semantic_kind = 'ctf-redeem' GROUP BY operation_state ORDER BY operation_state`,
        )
        .all()
        .map((row) => `${row.state}:${row.count}`),
      reservations: Number(
        database.prepare('SELECT COUNT(*) AS count FROM custody_proof_reservations').get()!.count,
      ),
    }
  } finally {
    database.close()
  }
}

/** The regular msat that an order can spend: custody holds it with a verified DLEQ proof. */
async function orderSpendableMsat(directory: string, mintUrl: string): Promise<number> {
  const database = await openDaemonStateSqlite(directory)
  try {
    return readAvailableCanonicalWalletProofPageFromDatabase(database, {
      mintUrl,
      keysetId: REGULAR_KEYSET_ID,
      asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
      limit: 64,
    }).proofs.reduce((sum, { proof }) => sum + Number(proof.amount), 0)
  } finally {
    database.close()
  }
}

async function walletOutcomeRows(directory: string): Promise<string[]> {
  const database = await openDaemonStateSqlite(directory)
  try {
    return database
      .prepare(
        `SELECT outcome_set_id AS outcome, state, reserved_by AS reservedBy
         FROM target_wallet_proofs WHERE asset_kind = 'outcome' ORDER BY outcome_set_id`,
      )
      .all()
      .map(
        (row) =>
          `${row.outcome}/${row.state}${String(row.reservedBy).startsWith('retained:') ? '/retained' : ''}`,
      )
  } finally {
    database.close()
  }
}

async function payoutAmounts(directory: string): Promise<number[]> {
  return (await readActivityRows(directory))
    .filter((row) => row.item.type === 'payout_claimed')
    .map((row) => row.item.amountSubunits)
}

test('a retirement payout is custody funds that a send and an order can spend', async () => {
  const fixture = await createRetirementFixture(2, 4)
  const { directory, profile, fence, common, wallet } = fixture
  try {
    const retired = await retireDaemonConditionInventory({ ...common, acknowledge: true })
    assert.equal(retired.state, 'retired')
    assert.equal(wallet.redeemCalls, 1)
    // One transaction admits the payout as selectable custody and spends the inputs.
    assert.deepEqual(await custodyFacts(directory), {
      regular: ['selectable/UNSPENT:2/8'],
      outcome: ['spent/SPENT:2/8'],
      redeems: ['reconciled:1'],
      reservations: 0,
    })
    assert.equal(await orderSpendableMsat(directory, profile.mintUrl), 8)
    assert.deepEqual(await payoutAmounts(directory), [8])

    const regularMint = new FakeRegularMint()
    const sent = await sendWalletToken(4, profile, common.secrets, {
      getCustodyFence: () => fence,
      createCashuWallet: (_mint, _unit, source) =>
        regularMint.wallet(
          { mintUrl: profile.mintUrl, seedHex: common.secrets.walletSeedHex, fence },
          source,
        ),
    })
    assert.equal(sent.amountMsat, 4)
    assert.equal(await orderSpendableMsat(directory, profile.mintUrl), 4)

    // A later retirement and its resume find no work. The spent payout stays spent.
    const afterSend = await custodyFacts(directory)
    assert.equal(
      (await retireDaemonConditionInventory({ ...common, acknowledge: true })).state,
      'retired',
    )
    assert.deepEqual(await resumeDaemonConditionRetirements(common), [])
    assert.equal(wallet.redeemCalls, 1)
    assert.deepEqual(await custodyFacts(directory), afterSend)
    assert.deepEqual(await payoutAmounts(directory), [8])
  } finally {
    await fixture.dispose()
  }
})

test('a resumed retirement page sends the same request and admits the payout to custody', async () => {
  const fixture = await createRetirementFixture(1, 4)
  const { directory, profile, common, wallet, conditionId } = fixture
  try {
    wallet.loseResponse = true
    await assert.rejects(
      retireDaemonConditionInventory({ ...common, acknowledge: true }),
      /lost mint response/,
    )
    // The mint signed, but its answer did not arrive. Custody keeps the input reserved.
    assert.deepEqual(await custodyFacts(directory), {
      regular: [],
      outcome: ['locked/UNSPENT:1/4'],
      redeems: ['dispatch-intent:1'],
      reservations: 1,
    })
    assert.deepEqual(await payoutAmounts(directory), [])

    wallet.loseResponse = false
    assert.deepEqual(await resumeDaemonConditionRetirements(common), [{ conditionId, error: null }])
    assert.equal(wallet.redeemCalls, 2)
    assert.deepEqual(wallet.requests[1], wallet.requests[0])
    assert.deepEqual(await custodyFacts(directory), {
      regular: ['selectable/UNSPENT:1/4'],
      outcome: ['spent/SPENT:1/4'],
      redeems: ['reconciled:1'],
      reservations: 0,
    })
    assert.equal(await orderSpendableMsat(directory, profile.mintUrl), 4)
    assert.deepEqual(await payoutAmounts(directory), [4])
  } finally {
    await fixture.dispose()
  }
})

test('a losing retirement page is a terminal rejection that keeps its custody inputs', async () => {
  const fixture = await createRetirementFixture(1, 4)
  const { directory, profile, common, wallet, conditionId, hold } = fixture
  try {
    const { keyset: losing } = await hold(conditionId, 'NO', [
      { secret: 'losing-input', amount: 2 },
    ])
    wallet.losingKeysets.add(losing.id)
    const retired = await retireDaemonConditionInventory({ ...common, acknowledge: true })
    assert.equal(retired.state, 'retired')
    assert.equal(wallet.redeemCalls, 2)
    // The losing input stays unspent and retained, so no command spends it.
    assert.deepEqual(await custodyFacts(directory), {
      regular: ['selectable/UNSPENT:1/4'],
      outcome: ['retained/UNSPENT:1/2', 'spent/SPENT:1/4'],
      redeems: ['aborted:1', 'reconciled:1'],
      reservations: 0,
    })
    assert.deepEqual(await walletOutcomeRows(directory), ['NO/locked'])
    assert.equal(await orderSpendableMsat(directory, profile.mintUrl), 4)
    assert.deepEqual(await payoutAmounts(directory), [4])
  } finally {
    await fixture.dispose()
  }
})

test('an uneconomic retirement page keeps its proof and calls no mint', async () => {
  // The input fee of the only page equals its amount, so the redeem pays nothing.
  const fixture = await createRetirementFixture(1, 1, 1_000)
  const { directory, common, wallet } = fixture
  try {
    const retired = await retireDaemonConditionInventory({ ...common, acknowledge: true })
    assert.equal(retired.state, 'retired')
    assert.equal(wallet.redeemCalls, 0)
    // Accepted risk: custody keeps the uneconomic input selectable. The wallet keeps it as history.
    assert.deepEqual(await custodyFacts(directory), {
      regular: [],
      outcome: ['selectable/UNSPENT:1/1'],
      redeems: [],
      reservations: 0,
    })
    assert.deepEqual(await walletOutcomeRows(directory), ['YES/locked/retained'])
    assert.deepEqual(await payoutAmounts(directory), [])
  } finally {
    await fixture.dispose()
  }
})

async function inventoryRows(directory: string): Promise<number> {
  const database = await openDaemonStateSqlite(directory)
  try {
    return Number(
      database.prepare('SELECT COUNT(*) AS count FROM daemon_managed_condition_inventory').get()!
        .count,
    )
  } finally {
    database.close()
  }
}

test('a retirement does not start while custody lacks a position of the condition', async () => {
  const fixture = await createRetirementFixture(1, 4)
  const { directory, profile, fence, common, wallet, conditionId } = fixture
  try {
    // A wallet-only row: custody holds no proof of it, so the redeem cannot spend it.
    await addAvailableProofs(profile.mintUrl, [proof(CTF_KEYSET_ID, 'wallet-only-position', 2)], {
      kind: 'Outcome',
      conditionId,
      outcomeSetId: 'YES',
      baseAsset: 'sat',
      unit: 'msat',
    })
    const refusal = {
      code: 'condition-retirement-custody-incomplete',
      message:
        'custody does not hold every position of this condition, so the retirement does not start',
    }
    for (const acknowledge of [false, true])
      await assert.rejects(retireDaemonConditionInventory({ ...common, acknowledge }), refusal)
    assert.deepEqual(
      await dispatch(
        { method: 'wallet.retireCondition', params: { conditionId, acknowledge: true } },
        {
          ...common.walletDependencies,
          getCustodyFence: () => fence,
          conditionResolution: common.resolution,
        },
      ),
      { ok: false, code: refusal.code, error: refusal.message },
    )
    // The scan records a discovery failure. Nothing started, so no funds command waits for it.
    assert.deepEqual(
      await retireResolvedDaemonConditions({
        profile,
        secrets: common.secrets,
        fence,
        resolution: common.resolution,
        walletDependencies: common.walletDependencies,
      }),
      {
        results: [],
        awaitingAttestation: [],
        discoveryFailures: [{ conditionId, error: refusal.message }],
        nextMaturityMs: null,
      },
    )
    assert.deepEqual(await resumeDaemonConditionRetirements(common), [])
    assert.equal(wallet.redeemCalls, 0)
    assert.equal(await inventoryRows(directory), 0)
    assert.deepEqual(await walletOutcomeRows(directory), ['YES/available', 'YES/available'])
  } finally {
    await fixture.dispose()
  }
})
