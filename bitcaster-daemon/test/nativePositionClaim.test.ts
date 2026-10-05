import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { finalizeEvent } from 'nostr-tools/pure'
import {
  Amount,
  CheckStateEnum,
  Wallet,
  Mint,
  MintOperationError,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  deriveConditionalKeysetId,
  OutputData,
  getDecodedToken,
  type RequestOptions,
  hashToCurve,
  pointFromHex,
  type MintKeys,
  type OutputDataLike,
  type Proof,
} from '@cashu/cashu-ts'
import { deriveDlcConditionId } from '@bitcaster-market/client-sdk/managedConditionInventory'
import { createCtfProofOperationCompletion } from '@bitcaster-market/client-sdk/ctfSplit'
import { readVerifiedCtfLosingOutcomeEvidence } from '@bitcaster-market/client-sdk/ctfRedeem'
import { deriveRootCtfOutcomeCollectionId } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import { DurableWalletProofImportCoordinator } from '../src/durableWalletProofImportCoordinator.ts'
import { createDaemonCounterSource, sendWalletToken, receiveWalletToken } from '../src/walletOps.ts'
import { previewDaemonPositionRemove, removeDaemonPosition } from '../src/nativePositionRemove.ts'
import { DurableCustodySqliteStore } from '../src/durableCustodySqliteStore.ts'
import { claimDaemonPosition, recoverDaemonPositionClaims } from '../src/nativePositionClaim.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { readProfile } from '../src/profile.ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'
import { dispatch } from '../src/server.ts'
import {
  completePositionClaimRedeemFenced,
  failPositionClaimRedeemFenced,
  getProofOperation,
  listProofOperations,
  readState,
  releasePreparedProofReservationFenced,
  writeState,
  emptyDaemonState,
  addAvailableProofs,
} from '../src/state.ts'

const MINT = 'https://mint.example'
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 1])
const KEY = bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true))
const KEYS = Object.fromEntries([1, 2, 4, 8, 16, 32, 64].map((amount) => [amount, KEY]))
const REGULAR_ID = deriveKeysetId(KEYS, { unit: 'msat', versionByte: 1, input_fee_ppk: 0 })
const CONDITION_ID = deriveDlcConditionId({
  eventId: 'position-claim-fixture',
  outcomeCount: 2,
  oraclePublicKeys: [bytesToHex(schnorr.getPublicKey(PRIVATE_KEY))],
})
const HISTORICAL_ID = conditionalKeyset(CONDITION_ID, 'YES', 2500).id
const CURRENT_ID = conditionalKeyset(CONDITION_ID, 'YES', 1).id

test('trusted conditional import, winner Claim, and ordinary Send admit exact spendable successors', async () => {
  const fixture = await createFixture()
  try {
    await fixture.add('trusted-winner', CURRENT_ID)
    const claimed = await claimDaemonPosition(fixture.common)
    assert.equal(claimed.legs[0]?.state, 'completed')
    assert.equal(claimed.legs[0]?.payoutAmountSubunits, 7)
    const database = await openDaemonStateSqlite(fixture.directory)
    try {
      const canonical = database
        .prepare(
          "SELECT amount FROM custody_proofs WHERE condition_id IS NULL AND selectability = 'selectable'",
        )
        .all()
      assert.equal(
        canonical.length,
        3,
        'Claim must admit exact canonical successors before ordinary Send',
      )
      assert.equal(
        canonical.reduce((sum, row) => sum + Number(row.amount), 0),
        7,
      )
      const link = database
        .prepare(
          'SELECT custody_operation_id AS id FROM custody_position_claim_links WHERE target_operation_id = ?',
        )
        .get(claimed.legs[0]!.operationId)!
      const record = new DurableCustodySqliteStore(database).getOperation(String(link.id))!
      assert.notEqual(record.operation.operationId, claimed.legs[0]!.operationId)
      assert.equal(record.operation.retainedOperationKey, claimed.legs[0]!.operationId)
      assert.equal(record.operation.state, 'reconciled')
      assert.equal(
        database.prepare('SELECT count(*) AS count FROM custody_proof_reservations').get()!.count,
        0,
      )
      assert.equal(
        database
          .prepare(
            "SELECT count(*) AS count FROM custody_proofs WHERE condition_id IS NOT NULL AND nut07_state = 'SPENT'",
          )
          .get()!.count,
        1,
      )
    } finally {
      database.close()
    }
    const sent = await sendClaimProceeds(fixture)
    assert.equal(sent.amountMsat, 4)
    const token = getDecodedToken(sent.token, [REGULAR_ID])
    assert.equal(
      token.proofs.reduce((sum, proof) => sum + Number(proof.amount), 0),
      4,
    )
    await receiveClaimProceeds(sent.token, fixture.regularMint)
    assert.equal(fixture.wallet.requests.length, 1)
  } finally {
    await fixture.dispose()
  }
})

test('Claim persists the actual redeem_outcome request boundary', async () => {
  const fixture = await createFixture()
  try {
    await fixture.add('boundary-input', CURRENT_ID)
    const result = await claimDaemonPosition(fixture.common)
    const custody = await inspectClaim(fixture, result.legs[0]!.operationId)
    assert.equal(custody.record.operation.exactRequest.method, 'POST')
    assert.equal(custody.record.operation.exactRequest.path, '/v1/redeem_outcome')
    assert.equal(custody.record.operation.exactRequest.idempotencyKey, result.legs[0]!.operationId)
  } finally {
    await fixture.dispose()
  }
})

for (const metadata of [
  'omitted',
  'conflicting-fee',
  'conflicting-expiry',
  'changed-active-id',
] as const) {
  test(`Claim keeps exact regular keyset authority when keys metadata is ${metadata}`, async () => {
    const fixture = await createFixture()
    try {
      await fixture.add('metadata-input', CURRENT_ID)
      const regular = { ...keyset(REGULAR_ID), input_fee_ppk: 37, final_expiry: 2_000_000_000 }
      regular.id = deriveKeysetId(KEYS, {
        unit: 'msat',
        versionByte: 1,
        input_fee_ppk: regular.input_fee_ppk,
        expiry: regular.final_expiry,
      })
      fixture.wallet.keysets.delete(REGULAR_ID)
      fixture.wallet.keysets.set(regular.id, regular)
      let lookups = 0
      fixture.wallet.mint.getKeySets = async () => {
        lookups++
        return {
          keysets:
            metadata === 'changed-active-id' && lookups > 1
              ? [
                  keyset(REGULAR_ID),
                  ...[...fixture.wallet.keysets.values()].filter(
                    ({ conditional }) => conditional !== undefined,
                  ),
                ]
              : [...fixture.wallet.keysets.values()],
        }
      }
      fixture.wallet.mint.getKeys = async (id = regular.id) => ({
        keysets: [
          id === regular.id
            ? {
                id,
                unit: 'msat',
                keys: KEYS,
                ...(metadata === 'conflicting-fee' ? { input_fee_ppk: 38 } : {}),
                ...(metadata === 'conflicting-expiry'
                  ? { final_expiry: regular.final_expiry + 1 }
                  : {}),
              }
            : (fixture.wallet.keysets.get(id) ?? keyset(REGULAR_ID)),
        ],
      })
      if (metadata !== 'omitted') {
        await assert.rejects(
          claimDaemonPosition(fixture.common),
          /regular .*keyset|regular output keyset/,
        )
        assert.equal(fixture.wallet.requests.length, 0)
        assert.equal(
          Object.values((await readState())!.proofOperations).some(
            ({ metadata }) => metadata.purpose === 'position-claim',
          ),
          false,
        )
      } else {
        const result = await claimDaemonPosition(fixture.common)
        assert.equal(result.legs[0]?.state, 'completed')
        const custody = await inspectClaim(fixture, result.legs[0]!.operationId)
        const authority = custody.authority as {
          keysets: Array<{ id: string; inputFeePpk: number; finalExpiry: number }>
        }
        const saved = authority.keysets.find(({ id }) => id === regular.id)!
        assert.equal(saved.inputFeePpk, 37)
        assert.equal(saved.finalExpiry, 2_000_000_000)
        assert.equal(
          custody.successors.every(({ keysetId }) => keysetId === regular.id),
          true,
        )
      }
    } finally {
      await fixture.dispose()
    }
  })
}

for (const losing of [false, true])
  for (const fault of ['before-commit', 'after-commit'] as const) {
    test(`trusted Claim ${losing ? 'loser' : 'winner'} ${fault} preserves atomic custody through reopen and replay`, async () => {
      const fixture = await createFixture()
      try {
        const outcomeCollection = losing ? 'NO' : 'YES'
        await fixture.add('fault-input', CURRENT_ID, outcomeCollection)
        if (losing) fixture.wallet.error = new MintOperationError(13015, 'losing leg')
        let injected = false
        const common = {
          ...fixture.common,
          outcomeCollection,
          walletDependencies: {
            ...fixture.common.walletDependencies,
            injectCustodyFault: (phase: string) => {
              if (!injected && fixture.wallet.requests.length > 0 && phase === fault) {
                injected = true
                throw new Error('injected Claim commit boundary')
              }
            },
          },
        }
        if (fault === 'before-commit')
          assert.equal((await claimDaemonPosition(common)).legs[0]?.state, 'pending')
        else if (losing) assert.equal((await claimDaemonPosition(common)).legs[0]?.state, 'pending')
        else await assert.rejects(claimDaemonPosition(common), /injected Claim commit boundary/)
        assert.equal(injected, true)
        const target = Object.values((await readState())!.proofOperations).find(
          ({ metadata }) => metadata.purpose === 'position-claim',
        )!
        const before = await inspectClaim(fixture, target.operationId)
        assert.equal(
          before.record.operation.state,
          fault === 'before-commit' ? 'dispatch-intent' : losing ? 'aborted' : 'reconciled',
        )
        assert.equal(before.reservations, fault === 'before-commit' ? 1 : 0)
        assert.equal(before.active, fault === 'before-commit' ? 1 : 0)
        if (fault === 'before-commit') {
          assert.equal(before.predecessors[0]!.selectability, 'locked')
          assert.equal(before.successors.length, 0)
        }
        const identity = digest({
          operationId: before.record.operation.operationId,
          retained: before.record.operation.retainedOperationKey,
          authority: before.authority,
        })
        const replay = await claimDaemonPosition({ ...fixture.common, outcomeCollection })
        if (fault === 'before-commit')
          assert.equal(replay.legs[0]?.state, losing ? 'losing' : 'completed')
        else assert.equal(replay.legs.length, 0)
        const completed = await inspectClaim(fixture, target.operationId)
        assert.equal(
          digest({
            operationId: completed.record.operation.operationId,
            retained: completed.record.operation.retainedOperationKey,
            authority: completed.authority,
          }),
          identity,
        )
        assert.equal(completed.reservations, 0)
        assert.equal(completed.active, 0)
        assert.equal(completed.pins.includes('active-reservation'), false)
        assert.equal(completed.predecessors[0]!.nut07State, losing ? 'UNSPENT' : 'SPENT')
        assert.equal(completed.predecessors[0]!.selectability, losing ? 'retained' : 'spent')
        assert.equal(fixture.wallet.requests.length, fault === 'before-commit' ? 2 : 1)
        const frozen = digest(completed)
        await recoverDaemonPositionClaims(fixture.common)
        assert.equal(digest(await inspectClaim(fixture, target.operationId)), frozen)
        if (losing) {
          const rejection = completed.record.operation.terminalMintRejection!
          assert.equal(rejection.code, 13015)
          assert.equal(
            (completed.rejection as { transportOperationId: string }).transportOperationId,
            target.operationId,
          )
          assert.notEqual(completed.record.operation.operationId, target.operationId)
          const context = {
            profile: fixture.common.profile,
            fence: fixture.common.fence,
            conditionId: fixture.conditionId,
            outcomeCollection,
            isCustodyReady: () => true,
          }
          const preview = await previewDaemonPositionRemove(context)
          const removed = await removeDaemonPosition({ ...context, preview, acknowledge: true })
          assert.equal(removed.retiredProofCount, 1)
          const retired = await inspectClaim(fixture, target.operationId)
          assert.equal(retired.predecessors[0]!.selectability, 'retained')
          assert.equal(retired.predecessors[0]!.nut07State, 'UNSPENT')
          const beforeReplay = digest(retired)
          await claimDaemonPosition({ ...fixture.common, outcomeCollection })
          assert.equal(digest(await inspectClaim(fixture, target.operationId)), beforeReplay)
        } else await sendClaimProceeds(fixture)
      } finally {
        await fixture.dispose()
      }
    })
  }

for (const failure of [
  'missing-canonical',
  'foreign-canonical',
  'invalid-output',
  'foreign-output',
  'missing-dleq',
] as const) {
  test(`Claim refuses ${failure} without credit or premature canonical retirement`, async () => {
    const fixture = await createFixture()
    try {
      await fixture.add(
        'guard-input',
        CURRENT_ID,
        'YES',
        fixture.conditionId,
        8,
        failure !== 'missing-canonical',
      )
      if (failure === 'missing-canonical' || failure === 'foreign-canonical') {
        const database = await openDaemonStateSqlite(fixture.directory)
        try {
          if (failure === 'foreign-canonical')
            database.prepare("UPDATE custody_proofs SET outcome_set_id = 'NO'").run()
        } finally {
          database.close()
        }
        await assert.rejects(claimDaemonPosition(fixture.common), /canonical predecessor/)
        assert.equal(fixture.wallet.requests.length, 0)
        assert.equal(
          Object.values((await readState())!.proofOperations).some(
            ({ metadata }) => metadata.purpose === 'position-claim',
          ),
          false,
        )
      } else {
        fixture.wallet.alterResult = (proofs) =>
          proofs.map((proof, index) =>
            index !== 0
              ? proof
              : {
                  ...proof,
                  ...(failure === 'invalid-output'
                    ? { secret: 'foreign-secret' }
                    : failure === 'foreign-output'
                      ? { id: CURRENT_ID }
                      : { dleq: undefined }),
                },
          )
        const result = await claimDaemonPosition(fixture.common)
        assert.equal(result.legs[0]?.state, 'pending')
        const custody = await inspectClaim(fixture, result.legs[0]!.operationId)
        assert.equal(custody.record.operation.state, 'dispatch-intent')
        assert.equal(custody.predecessors[0]!.nut07State, 'UNSPENT')
        assert.equal(custody.reservations, 1)
        assert.equal(custody.successors.length, 0)
      }
    } finally {
      await fixture.dispose()
    }
  })
}

test('claim RPC selects only the exact position and charges each historical keyset fee', async () => {
  const fixture = await createFixture()
  try {
    await fixture.add('target-old', HISTORICAL_ID, 'YES', fixture.conditionId, 8)
    await fixture.add('target-new', CURRENT_ID, 'YES', fixture.conditionId, 8)
    await fixture.add('sibling', CURRENT_ID, 'NO', fixture.conditionId, 8)
    await fixture.add('foreign', CURRENT_ID, 'YES', 'ab'.repeat(32), 8)
    let monitoringCalls = 0
    const deps = {
      ...fixture.common.walletDependencies,
      getCustodyFence: () => fixture.common.fence,
      createEngineClient: () =>
        ({
          ...fixture.common.engine,
          getAssetMonitoringAssets: async () => {
            monitoringCalls++
            throw new Error('monitoring forbidden')
          },
          getPortfolio: async () => {
            monitoringCalls++
            throw new Error('monitoring forbidden')
          },
        }) as never,
    }
    const request = {
      method: 'wallet.claimPosition' as const,
      params: { conditionId: fixture.conditionId, outcomeCollection: 'YES' },
    }
    const response = await dispatch(request, deps)
    assert.equal(response.ok, true)
    const result = response.result as Awaited<ReturnType<typeof claimDaemonPosition>>
    assert.equal(result.legs.length, 2)
    assert.equal(
      result.legs.every((leg) => leg.state === 'completed'),
      true,
    )
    assert.equal(
      result.legs.reduce((sum, leg) => sum + leg.payoutAmountSubunits, 0),
      12,
    )
    assert.equal(
      fixture.wallet.requests
        .flatMap((request) => request.inputs)
        .every(({ secret }) => secret.startsWith('target-')),
      true,
    )
    const state = (await readState())!
    assert.equal(state.wallet.proofs.filter(({ asset }) => asset.kind === 'Outcome').length, 2)
    assert.equal(
      state.wallet.proofs
        .filter(({ asset }) => asset.kind === 'sats')
        .reduce((sum, { proof }) => sum + Number(proof.amount), 0),
      12,
    )
    assert.equal(monitoringCalls, 0)
    const status = await dispatch(
      { method: 'wallet.operations', params: { kind: 'ctf-redeem' } },
      deps,
    )
    assert.equal(JSON.stringify(status).includes('target-old'), false)
    assert.doesNotMatch(
      JSON.stringify(status),
      /oracleWitness|oracle_sigs|blindingFactor|"secret"|"inputs"|"outputs"/,
    )
    assert.equal(
      (await listProofOperations())
        .filter(({ operationId }) => operationId.startsWith('custody-operation:'))
        .every(({ operationId }) => result.legs.some((leg) => leg.operationId === operationId)),
      true,
    )
    const database = await openDaemonStateSqlite(fixture.directory)
    try {
      assert.equal(
        (
          database
            .prepare('SELECT count(*) AS count FROM daemon_managed_condition_inventory')
            .get() as { count: number }
        ).count,
        0,
      )
    } finally {
      database.close()
    }
  } finally {
    await fixture.dispose()
  }
})

test('claim entry recovers a lost response after restart with the exact witness, request, outputs, and operation ID', async (t) => {
  const fixture = await createFixture()
  try {
    await fixture.add('target-restart', HISTORICAL_ID)
    fixture.wallet.loseResponse = true
    const first = await claimDaemonPosition(fixture.common)
    assert.equal(first.legs[0]?.state, 'pending')
    const operationId = first.legs[0]!.operationId
    const prepared = (await getProofOperation(operationId))!
    assert.equal(prepared.state, 'prepared')
    assert.equal((await readState())!.wallet.proofs[0]?.state, 'reserved')
    const originalRequestHash = fixture.wallet.requestHash()
    const outputHash = digest(prepared.outputs)
    t.mock.method(Date, 'now', () => fixture.common.fence.leaseExpiresAtMs + 2)
    const nextFence = await claimCustodyScopeLease(fixture.directory, {
      scopeId: fixture.common.fence.scopeId,
      incarnationId: 'position-claim-restart-owner',
      observedAtMs: fixture.common.fence.leaseExpiresAtMs + 1,
    })
    // The restarted owner uses the same committed mint data and no fresh attestation.
    const restarted = {
      ...fixture.common,
      fence: nextFence,
      walletDependencies: {
        createCashuWallet: () => fixture.wallet,
        getCustodyFence: () => nextFence,
      },
      engine: {
        getConditionAttestation: async () => {
          throw new Error('fresh witness forbidden')
        },
      },
    }
    fixture.wallet.loseResponse = false
    const second = await claimDaemonPosition(restarted)
    assert.equal(second.legs[0]?.operationId, operationId)
    assert.equal(second.legs[0]?.state, 'completed')
    assert.equal(fixture.wallet.requests.length, 2)
    assert.equal(fixture.wallet.requestHash(), originalRequestHash)
    const completed = (await getProofOperation(operationId))!
    assert.equal(digest(completed.outputs), outputHash)
    assert.equal(digest(completed.metadata.oracleWitness), digest(prepared.metadata.oracleWitness))
    const state = (await readState())!
    const payoutCount = state.wallet.proofs.length
    assert.equal(
      state.wallet.proofs.every(({ asset }) => asset.kind === 'sats'),
      true,
    )
    await completePositionClaimRedeemFenced(
      operationId,
      createCtfProofOperationCompletion('ctf-redeem', { regular: fixture.wallet.results }),
      { fence: nextFence, observedAtMs: nextFence.leaseExpiresAtMs - 1 },
    )
    assert.equal((await readState())!.wallet.proofs.length, payoutCount)
    assert.equal((await recoverDaemonPositionClaims(restarted)).pending.length, 0)
    await sendClaimProceeds({ ...fixture, common: restarted })
  } finally {
    await fixture.dispose()
  }
})

test('uncertain and PENDING claims keep reservations and cannot fabricate terminal losing evidence', async () => {
  const fixture = await createFixture()
  try {
    await fixture.add('pending-input', HISTORICAL_ID)
    fixture.wallet.error = new Error(
      'OracleNotAttestedOutcome (13015) secret-bearing transport detail',
    )
    const first = await claimDaemonPosition(fixture.common)
    const operationId = first.legs[0]!.operationId
    fixture.wallet.states = CheckStateEnum.PENDING
    const before = await readState()
    const second = await claimDaemonPosition({
      ...fixture.common,
      engine: {
        getConditionAttestation: async () => {
          throw new Error('fresh witness forbidden')
        },
      },
    })
    assert.equal(second.legs[0]?.state, 'pending')
    assert.equal(fixture.wallet.requests.length, 1)
    assert.equal(
      isDeepStrictEqual(before, await readState()),
      true,
      'pending claim must keep custody unchanged',
    )
    assert.equal((await getProofOperation(operationId))?.failureCode, undefined)
    await assert.rejects(
      failPositionClaimRedeemFenced(
        operationId,
        '13015',
        {
          transportProvenance: 'authenticated-mint-transport',
          operationId,
          normalizedMint: MINT,
          rejectionBody: { code: 13015 },
        },
        { fence: fixture.common.fence, observedAtMs: Date.now() },
      ),
      /terminal evidence is invalid/,
    )
    assert.equal(
      isDeepStrictEqual(before, await readState()),
      true,
      'unsealed failure must keep custody unchanged',
    )
  } finally {
    await fixture.dispose()
  }
})

test('a committed mint response lost in transit restores exact outputs once through wallet.recover', async () => {
  const fixture = await createFixture()
  try {
    await fixture.add('committed-input', HISTORICAL_ID)
    fixture.wallet.loseResponse = true
    const first = await claimDaemonPosition(fixture.common)
    const operationId = first.legs[0]!.operationId
    const original = (await getProofOperation(operationId))!
    fixture.wallet.states = CheckStateEnum.SPENT
    let restores = 0
    const response = await dispatch(
      { method: 'wallet.recover' },
      {
        ...fixture.common.walletDependencies,
        getCustodyFence: () => fixture.common.fence,
        createEngineClient: () => fixture.common.engine as never,
        restoreOutputGroups: async (mintUrl, outputs) => {
          assert.equal(mintUrl, MINT)
          assert.equal(digest(outputs), digest(original.outputs))
          restores++
          return { regular: fixture.wallet.results }
        },
      },
    )
    assert.equal(response.ok, true)
    assert.equal((await getProofOperation(operationId))?.state, 'completed')
    assert.equal(restores, 1)
    await sendClaimProceeds(fixture)
    assert.equal(fixture.wallet.requests.length, 1)
    const count = (await readState())!.wallet.proofs.length
    const repeated = await claimDaemonPosition({
      ...fixture.common,
      engine: {
        getConditionAttestation: async () => {
          throw new Error('fresh witness forbidden')
        },
      },
    })
    assert.equal(repeated.legs.length, 0)
    assert.equal((await readState())!.wallet.proofs.length, count)
    assert.equal(restores, 1)
  } finally {
    await fixture.dispose()
  }
})

for (const uncertainty of [
  'mixed',
  'malformed',
  'unavailable',
  'missing-restored-output',
] as const) {
  test(`Claim recovery retains exact custody when mint evidence is ${uncertainty}`, async () => {
    const fixture = await createFixture()
    try {
      await fixture.add('uncertain-first', HISTORICAL_ID)
      await fixture.add('uncertain-second', HISTORICAL_ID)
      fixture.wallet.loseResponse = true
      const first = await claimDaemonPosition(fixture.common)
      const operationId = first.legs[0]!.operationId
      const before = digest(await inspectClaim(fixture, operationId))
      const targetBefore = digest(await getProofOperation(operationId))
      fixture.wallet.checkProofsStates = async (proofs) => {
        if (uncertainty === 'unavailable') throw new Error('state service unavailable')
        return proofs.map(({ secret }, index) => ({
          Y:
            uncertainty === 'malformed'
              ? 'invalid-input-identity'
              : hashToCurve(utf8ToBytes(secret)).toHex(true),
          state:
            uncertainty === 'mixed' && index === 0 ? CheckStateEnum.UNSPENT : CheckStateEnum.SPENT,
          witness: null,
        }))
      }
      let restores = 0
      const recovered = await claimDaemonPosition({
        ...fixture.common,
        engine: {
          getConditionAttestation: async () => {
            throw new Error('fresh witness forbidden')
          },
        },
        walletDependencies: {
          ...fixture.common.walletDependencies,
          restoreOutputGroups: async () => {
            restores++
            return { regular: [] }
          },
        },
      })
      assert.equal(recovered.legs[0]?.state, 'pending')
      assert.equal(fixture.wallet.requests.length, 1)
      assert.equal(restores, uncertainty === 'missing-restored-output' ? 1 : 0)
      assert.equal(digest(await inspectClaim(fixture, operationId)), before)
      assert.equal(digest(await getProofOperation(operationId)), targetBefore)
    } finally {
      await fixture.dispose()
    }
  })
}

test('authenticated losing evidence is typed, operation-bound, retained, and survives compatibility save', async () => {
  const fixture = await createFixture()
  try {
    await fixture.add('losing-input', HISTORICAL_ID, 'NO')
    fixture.wallet.error = new MintOperationError(13015, 'losing leg')
    const result = await claimDaemonPosition({ ...fixture.common, outcomeCollection: 'NO' })
    const operationId = result.legs[0]!.operationId
    assert.equal(result.legs[0]?.state, 'losing')
    const state = (await readState())!
    assert.equal(state.wallet.proofs[0]?.state, 'locked')
    assert.equal(state.wallet.proofs[0]?.proof.secret, 'losing-input')
    assert.equal(state.proofOperations[operationId]?.failureCode, 13015)
    const positions = await dispatch({ method: 'wallet.positions' })
    assert.equal(positions.ok, true)
    assert.equal(
      (
        positions.result as { positions: Array<{ conditionId: string; outcomeSetId: string }> }
      ).positions.some(
        (position) =>
          position.conditionId === fixture.conditionId && position.outcomeSetId === 'NO',
      ),
      true,
    )
    await writeState(state)
    assert.equal((await getProofOperation(operationId))?.failureCode, 13015)
    const evidence = await readVerifiedCtfLosingOutcomeEvidence({
      operationId,
      proof: { id: state.wallet.proofs[0]!.proof.id!, secret: 'losing-input' },
      store: {
        withCommittedProofOperation: async (_id, read) =>
          read((await getProofOperation(operationId))! as never),
      },
    })
    assert.equal(evidence.operationId, operationId)
    const database = await openDaemonStateSqlite(fixture.directory)
    try {
      assert.throws(
        () =>
          database
            .prepare(
              "UPDATE target_proof_operations SET state = 'prepared', last_error = NULL WHERE operation_id = ?",
            )
            .run(operationId),
        /CHECK constraint/,
      )
      assert.throws(
        () =>
          database
            .prepare(
              "UPDATE target_proof_operations SET kind = 'wallet-send' WHERE operation_id = ?",
            )
            .run(operationId),
        /CHECK constraint/,
      )
      assert.throws(
        () =>
          database
            .prepare('UPDATE target_proof_operations SET failure_code = 1 WHERE operation_id = ?')
            .run(operationId),
        /CHECK constraint/,
      )
      const canonical = database
        .prepare(
          'SELECT custody_operation_id AS id FROM custody_position_claim_links WHERE target_operation_id = ?',
        )
        .get(operationId)!
      assert.throws(
        () =>
          database
            .prepare(
              'UPDATE custody_position_claim_links SET custody_operation_id = custody_operation_id WHERE target_operation_id = ?',
            )
            .run(operationId),
        /mapping is immutable/,
      )
      assert.throws(
        () =>
          database
            .prepare('UPDATE custody_terminal_mint_rejections SET code = 1 WHERE operation_id = ?')
            .run(String(canonical.id)),
        /rejection is immutable/,
      )
      const terminal = database
        .prepare(
          'SELECT rejection_artifact_id AS id FROM custody_terminal_mint_rejections WHERE operation_id = ?',
        )
        .get(String(canonical.id))!
      assert.equal(
        database
          .prepare(
            'SELECT private_material AS private FROM custody_artifacts WHERE artifact_id = ?',
          )
          .get(String(terminal.id))!.private,
        1,
      )
    } finally {
      database.close()
    }
    assert.equal(
      (await listProofOperations()).find(({ operationId: id }) => id === operationId)?.failureCode,
      13015,
    )
  } finally {
    await fixture.dispose()
  }
})

test('stale fence, foreign reservation, and changed target refuse without partial custody mutation', async () => {
  for (const change of ['stale', 'foreign-reservation', 'changed-target'] as const) {
    const fixture = await createFixture()
    try {
      await fixture.add('refused-input', HISTORICAL_ID)
      fixture.wallet.error = new Error('timeout')
      const result = await claimDaemonPosition(fixture.common)
      const operationId = result.legs[0]!.operationId
      if (change === 'stale') {
        await claimCustodyScopeLease(fixture.directory, {
          scopeId: fixture.common.fence.scopeId,
          incarnationId: 'position-claim-foreign-owner',
          observedAtMs: fixture.common.fence.leaseExpiresAtMs + 1,
        })
      } else {
        const database = await openDaemonStateSqlite(fixture.directory)
        try {
          if (change === 'foreign-reservation')
            database
              .prepare('UPDATE target_wallet_proofs SET reserved_by = ? WHERE secret = ?')
              .run('foreign-operation', 'refused-input')
          else
            database
              .prepare('UPDATE target_wallet_proofs SET outcome_set_id = ? WHERE secret = ?')
              .run('NO', 'refused-input')
        } finally {
          database.close()
        }
      }
      const before = await readState()
      const payout = fixture.wallet.outputs.map((output) => signOutput(output))
      await assert.rejects(
        completePositionClaimRedeemFenced(
          operationId,
          createCtfProofOperationCompletion('ctf-redeem', { regular: payout }),
          { fence: fixture.common.fence, observedAtMs: Date.now() },
        ),
      )
      assert.equal(
        isDeepStrictEqual(before, await readState()),
        true,
        'refused completion must keep custody unchanged',
      )
      const calls = fixture.wallet.requests.length
      if (change === 'stale') await assert.rejects(claimDaemonPosition(fixture.common))
      else assert.equal((await claimDaemonPosition(fixture.common)).legs[0]?.state, 'pending')
      assert.equal(fixture.wallet.requests.length, calls)
    } finally {
      await fixture.dispose()
    }
  }
})

test('a losing historical-keyset leg does not block the next leg or get reselected on retry', async () => {
  const fixture = await createFixture('11'.repeat(64), 'NO')
  try {
    await fixture.add('losing-old', HISTORICAL_ID)
    await fixture.add('next-leg', CURRENT_ID)
    fixture.wallet.losingKeysets.add(HISTORICAL_ID)
    const result = await claimDaemonPosition(fixture.common)
    assert.equal(result.legs.length, 2)
    assert.equal(result.legs.filter((leg) => leg.state === 'losing').length, 1)
    assert.equal(result.legs.filter((leg) => leg.state === 'completed').length, 1)
    assert.equal(new Set(result.legs.map((leg) => leg.operationId)).size, 2)
    const state = (await readState())!
    assert.equal(state.wallet.proofs.filter(({ state }) => state === 'locked').length, 1)
    assert.equal(
      Object.values(state.proofOperations).filter(({ failureCode }) => failureCode === 13015)
        .length,
      1,
    )
    assert.equal((await claimDaemonPosition(fixture.common)).legs.length, 0)
    assert.equal(fixture.wallet.requests.length, 2)
  } finally {
    await fixture.dispose()
  }
})

test('a definitive non-losing refusal is not reported as a pending claim', async () => {
  const fixture = await createFixture()
  try {
    await fixture.add('refused-input', HISTORICAL_ID)
    fixture.wallet.error = new Error('timeout')
    const result = await claimDaemonPosition(fixture.common)
    const operationId = result.legs[0]!.operationId
    await releasePreparedProofReservationFenced(
      { operationId, reservationId: operationId, reason: 'definitive local refusal' },
      { fence: fixture.common.fence, observedAtMs: Date.now() },
    )
    await assert.rejects(claimDaemonPosition(fixture.common), /non-refusal failure/)
    assert.equal((await getProofOperation(operationId))?.state, 'Failed')
    assert.equal(fixture.wallet.requests.length, 1)
  } finally {
    await fixture.dispose()
  }
})

test('an unavailable target or uneconomic target refuses before preparation without selecting other value', async () => {
  for (const mode of ['reserved', 'locked', 'uneconomic'] as const) {
    const fixture = await createFixture()
    try {
      const unavailable = mode !== 'uneconomic'
      await fixture.add(
        'exact-input',
        HISTORICAL_ID,
        'YES',
        fixture.conditionId,
        unavailable ? 8 : 1,
      )
      await fixture.add('sibling-input', CURRENT_ID, 'NO')
      if (unavailable) {
        const database = await openDaemonStateSqlite(fixture.directory)
        try {
          database
            .prepare(
              "UPDATE target_wallet_proofs SET state = ?, reserved_by = 'foreign-operation' WHERE secret = 'exact-input'",
            )
            .run(mode)
        } finally {
          database.close()
        }
      }
      const before = await readState()
      await assert.rejects(
        claimDaemonPosition(fixture.common),
        unavailable ? /reserved or locked/ : /input fee consumes/,
      )
      assert.equal(
        isDeepStrictEqual(before, await readState()),
        true,
        'refused preparation must keep custody unchanged',
      )
      assert.equal(fixture.wallet.requests.length, 0)
    } finally {
      await fixture.dispose()
    }
  }
})

test('claim requires ready custody and redacts invalid requests before network I/O', async () => {
  const response = await dispatch(
    {
      method: 'wallet.claimPosition',
      params: { conditionId: 'ab'.repeat(32), outcomeCollection: 'YES' },
    },
    { isCustodyReady: () => false },
  )
  assert.equal(response.code, 'custody-recovery-pending')
  const fixture = await createFixture()
  try {
    const invalid = await dispatch({ method: 'wallet.claimPosition', params: null } as never, {
      ...fixture.common.walletDependencies,
      getCustodyFence: () => fixture.common.fence,
      createEngineClient: () => fixture.common.engine as never,
    })
    assert.equal(invalid.code, 'position-claim-refused')
    assert.equal(fixture.wallet.requests.length, 0)
  } finally {
    await fixture.dispose()
  }
})

async function createFixture(seed = '11'.repeat(64), resolvedOutcome = 'YES') {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-position-claim-'))
  const previous = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  const bootstrap = await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: MINT,
    walletSeedHex: seed,
    nostrSecretKeyHex: '22'.repeat(32),
  })
  const fence = await claimCustodyScopeLease(directory, {
    scopeId: bootstrap.walletScopeId,
    incarnationId: 'position-claim-fixture-owner',
    observedAtMs: Date.now(),
  })
  const eventId = 'position-claim-fixture'
  const oraclePublicKey = bytesToHex(schnorr.getPublicKey(PRIVATE_KEY))
  const { created_at, ...signedEvent } = finalizeEvent(
    { kind: 89, created_at: 1_900_000_000, tags: [['e', '44'.repeat(32)]], content: 'AQ==' },
    PRIVATE_KEY,
  )
  const tag = sha256(utf8ToBytes('DLC/oracle/attestation/v0'))
  const signature = bytesToHex(
    schnorr.sign(
      sha256(concatBytes(tag, tag, utf8ToBytes(resolvedOutcome))),
      PRIVATE_KEY,
      new Uint8Array(32),
    ),
  )
  const conditionId = deriveDlcConditionId({
    eventId,
    outcomeCount: 2,
    oraclePublicKeys: [oraclePublicKey],
  })
  const wallet = new ClaimWallet()
  wallet.conditionInfo = {
    condition_id: conditionId,
    threshold: 1,
    collateral: 'msat',
    announcements: ['01'],
    attestation: {
      status: 'attested',
      winning_outcome: resolvedOutcome,
      oracle_sigs: [
        { oracle_pubkey: oraclePublicKey, oracle_sig: signature, outcome: resolvedOutcome },
      ],
    },
  }

  await writeState(emptyDaemonState())
  const profile = (await readProfile())!
  const common = {
    conditionId,
    outcomeCollection: 'YES',
    profile,
    fence,
    secrets: { walletSeedHex: seed },
    walletDependencies: { createCashuWallet: () => wallet },
    engine: {
      getConditionAttestation: async () => ({
        conditionId,
        attestedOutcome: resolvedOutcome,
        attestationEvent: {
          id: signedEvent.id,
          pubkey: signedEvent.pubkey,
          createdAt: created_at,
          kind: 89 as const,
          tags: signedEvent.tags,
          content: signedEvent.content,
          sig: signedEvent.sig,
        },
        oracleWitness: {
          oracle_sigs: [
            { oracle_pubkey: oraclePublicKey, oracle_sig: signature, outcome: resolvedOutcome },
          ],
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
                .update(Buffer.from('AQ==', 'base64'))
                .digest('hex'),
            },
          ],
        },
      }),
    },
  }
  return {
    directory,
    wallet,
    conditionId,
    common,
    regularMint: new RegularMintTransport(),
    add: async (
      secret: string,
      id: string,
      outcome = 'YES',
      condition = conditionId,
      amount = 8,
      canonical = true,
    ) => {
      const conditional = conditionalKeyset(condition, outcome, id === HISTORICAL_ID ? 2500 : 1)
      wallet.keysets.set(conditional.id, conditional)
      const output = OutputData.createSingleData(amount, conditional.id, secret, 1n)
      const proof = signOutput(output, conditional)
      if (!canonical) {
        await addAvailableProofs(MINT, [proof], {
          kind: 'Outcome',
          conditionId: condition,
          outcomeSetId: outcome,
          baseAsset: 'sat',
          unit: 'msat',
        })
        return
      }
      await new DurableWalletProofImportCoordinator(directory, () => fence).importOutcomeProofs({
        mintUrl: MINT,
        proofs: [proof],
        asset: {
          kind: 'Outcome',
          conditionId: condition,
          outcomeSetId: outcome,
          baseAsset: 'sat',
          unit: 'msat',
        },
        keysets: [
          {
            canonicalMintUrl: MINT,
            id: conditional.id,
            unit: 'msat',
            keys: KEYS,
            inputFeePpk: conditional.input_fee_ppk ?? 0,
            finalExpiry: null,
            identity: {
              kind: 'conditional',
              conditionId: condition,
              outcomeCollection: outcome,
              outcomeCollectionId: deriveRootCtfOutcomeCollectionId({
                conditionId: condition,
                outcomeCollection: outcome,
              }),
            },
          },
        ],
        checkProofsStates: async (proofs) =>
          proofs.map(({ secret }) => ({
            Y: hashToCurve(utf8ToBytes(secret)).toHex(true),
            state: CheckStateEnum.UNSPENT,
            witness: null,
          })),
      })
    },
    dispose: async () => {
      if (previous === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = previous
      await rm(directory, { recursive: true, force: true })
    },
  }
}

class ClaimWallet {
  readonly keysets = new Map<string, MintKeys>([[REGULAR_ID, keyset(REGULAR_ID)]])
  requests: Array<{ inputs: Proof[]; outputs: Array<{ amount: number; id: string; B_: string }> }> =
    []
  outputs: OutputDataLike[] = []
  results: Proof[] = []
  error: Error | undefined
  losingKeysets = new Set<string>()
  loseResponse = false
  states: CheckStateEnum = CheckStateEnum.UNSPENT
  alterResult?: (proofs: Proof[]) => Proof[]
  conditionInfo: unknown
  evidenceError?: Error
  readonly mint = {
    getCtfCondition: async () => {
      if (this.evidenceError) throw this.evidenceError
      return this.conditionInfo
    },
    getKeySets: async () => ({
      keysets: [...this.keysets.values()],
    }),
    getKeys: async (id = REGULAR_ID) => ({ keysets: [this.keysets.get(id)!] }),
  }
  async loadMint() {}
  async redeemOutcomeProofs({
    inputs,
    outputs,
  }: {
    inputs: Proof[]
    outputs: OutputDataLike[]
  }): Promise<Proof[]> {
    this.requests.push({
      inputs,
      outputs: outputs.map(({ blindedMessage }) => ({
        ...blindedMessage,
        amount: Number(blindedMessage.amount),
      })),
    })
    this.outputs = outputs
    if (inputs.some(({ id }) => this.losingKeysets.has(id)))
      throw new MintOperationError(13015, 'losing leg')
    if (this.error) throw this.error
    this.results = outputs.map((output) =>
      signOutput(output, this.keysets.get(output.blindedMessage.id)!),
    )
    if (this.loseResponse) throw new Error('lost mint response')
    return this.alterResult?.(this.results) ?? this.results
  }
  async checkProofsStates(proofs: Array<Pick<Proof, 'secret'>>) {
    return proofs.map(({ secret }) => ({
      Y: hashToCurve(utf8ToBytes(secret)).toHex(true),
      state: this.states,
      witness: null,
    }))
  }
  requestHash() {
    return digest(this.requests.at(-1))
  }
}

function keyset(id: string): MintKeys {
  return {
    id,
    unit: 'msat',
    active: id !== HISTORICAL_ID,
    input_fee_ppk: id === HISTORICAL_ID ? 2500 : id === CURRENT_ID ? 1 : 0,
    keys: KEYS,
  } as unknown as MintKeys
}

function signOutput(output: OutputDataLike, authority = keyset(REGULAR_ID)): Proof {
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    PRIVATE_KEY,
    authority.id,
  )
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), PRIVATE_KEY)
  return output.toProof(
    {
      id: authority.id,
      amount: Amount.from(output.blindedMessage.amount),
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    authority,
  )
}

function conditionalKeyset(conditionId: string, outcome: string, input_fee_ppk: number): MintKeys {
  const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({
    conditionId,
    outcomeCollection: outcome,
  })
  return {
    id: deriveConditionalKeysetId({
      keys: KEYS,
      unit: 'msat',
      conditionId,
      outcomeCollectionId,
      input_fee_ppk,
    }),
    unit: 'msat',
    active: input_fee_ppk !== 2500,
    keys: KEYS,
    input_fee_ppk,
    conditional: {
      condition_id: conditionId,
      outcome_collection: outcome,
      outcome_collection_id: outcomeCollectionId,
    },
  } as MintKeys
}

async function sendClaimProceeds(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const wallet = fixture.regularMint.wallet(fixture)
  const sent = await sendWalletToken(4, fixture.common.profile, fixture.common.secrets, {
    getCustodyFence: () => fixture.common.fence,
    createCashuWallet: () => wallet,
  })
  assert.equal(fixture.regularMint.effects, 1)
  return sent
}

async function inspectClaim(fixture: Awaited<ReturnType<typeof createFixture>>, targetId: string) {
  const database = await openDaemonStateSqlite(fixture.directory)
  try {
    const link = database
      .prepare(
        'SELECT custody_operation_id AS id FROM custody_position_claim_links WHERE target_operation_id = ?',
      )
      .get(targetId)!
    const store = new DurableCustodySqliteStore(database)
    const record = store.getOperation(String(link.id))!
    const artifact = (reference: typeof record.operation.privateMaterial.exactPrivateMaterial) =>
      store.getArtifact({
        scopeId: record.scope.scopeId,
        operationId: record.operation.operationId,
        expectedOperationRevision: record.revision,
        reference,
      })!.artifact.artifact
    const count = (table: string) =>
      Number(
        database
          .prepare(`SELECT count(*) AS count FROM ${table} WHERE operation_id = ?`)
          .get(record.operation.operationId)!.count,
      )
    return {
      record,
      authority: artifact(record.operation.privateMaterial.exactPrivateMaterial),
      rejection:
        record.operation.terminalMintRejection === null
          ? null
          : artifact(record.operation.terminalMintRejection.exactRejection),
      reservations: count('custody_proof_reservations'),
      active: count('custody_active_work'),
      pins: record.operation.proofStorage.pinReasons,
      predecessors: record.operation.reservation.inputs.map(
        ({ proofId }) => store.getProof(record.scope.scopeId, proofId)!,
      ),
      successors: record.operation.proofStorage.lineage.successorProofIds
        .map((proofId) => store.getProof(record.scope.scopeId, proofId))
        .filter((proof) => proof !== null),
    }
  } finally {
    database.close()
  }
}

async function receiveClaimProceeds(token: string, mint: RegularMintTransport) {
  const recipient = await createFixture('33'.repeat(64))
  try {
    const wallet = mint.wallet(recipient)
    const result = await receiveWalletToken(
      token,
      recipient.common.profile,
      recipient.common.secrets,
      {
        getCustodyFence: () => recipient.common.fence,
        createCashuWallet: () => wallet,
        resolveMintKeysetIds: async () => [REGULAR_ID],
        resolveTokenImportKeysets: async () => ({
          canonicalMintUrl: MINT,
          freshness: 'fresh',
          regularKeysets: [{ keysetId: REGULAR_ID, unit: 'msat', active: true }],
          conditionalKeysets: [],
        }),
      },
    )
    assert.equal(result.amountMsat, 4)
    const consumed = getDecodedToken(token, [REGULAR_ID]).proofs
    const credited = (await readState())!.wallet.proofs.map(({ proof }) => proof)
    const consumedYs = new Set(
      consumed.map(({ secret }) => hashToCurve(utf8ToBytes(secret)).toHex(true)),
    )
    assert.equal(
      credited.every(({ secret }) => !consumedYs.has(hashToCurve(utf8ToBytes(secret)).toHex(true))),
      true,
      'Recipient credit must differ from consumed token',
    )
    assert.equal(
      (await wallet.checkProofsStates(consumed)).every(
        ({ state }) => state === CheckStateEnum.SPENT,
      ),
      true,
    )
    assert.equal(
      (await wallet.checkProofsStates(credited)).every(
        ({ state }) => state === CheckStateEnum.UNSPENT,
      ),
      true,
    )
    assert.equal(mint.effects, 2)
    assert.equal(
      (await readState())!.wallet.proofs.reduce((sum, { proof }) => sum + Number(proof.amount), 0),
      4,
    )
  } finally {
    await recipient.dispose()
  }
}

class RegularMintTransport {
  readonly spent = new Set<string>()
  effects = 0
  wallet(fixture: Awaited<ReturnType<typeof createFixture>>) {
    const customRequest = async <T>({ endpoint, requestBody }: RequestOptions): Promise<T> => {
      const route = new URL(endpoint).pathname
      if (route === '/v1/info')
        return { name: 'mock mint', nuts: { '12': { supported: true } } } as T
      if (route === '/v1/keysets') return { keysets: [keyset(REGULAR_ID)] } as T
      if (route === '/v1/keys' || route === `/v1/keys/${REGULAR_ID}`)
        return { keysets: [keyset(REGULAR_ID)] } as T
      if (route === '/v1/checkstate') {
        const { Ys } = requestBody as { Ys: string[] }
        return {
          states: Ys.map((Y) => ({
            Y,
            state: this.spent.has(Y) ? CheckStateEnum.SPENT : CheckStateEnum.UNSPENT,
            witness: null,
          })),
        } as T
      }
      if (route === '/v1/swap') {
        const body = requestBody as {
          inputs: Proof[]
          outputs: Array<{ id: string; amount: number; B_: string }>
        }
        const Ys = body.inputs.map(({ secret }) => hashToCurve(utf8ToBytes(secret)).toHex(true))
        assert.equal(
          Ys.some((Y) => this.spent.has(Y)),
          false,
          'Fake mint must reject spent inputs',
        )
        const signatures = body.outputs.map(({ id, amount, B_ }) => {
          const signature = createBlindSignature(pointFromHex(B_), PRIVATE_KEY, id)
          const dleq = createDLEQProof(pointFromHex(B_), PRIVATE_KEY)
          return {
            id,
            amount,
            C_: signature.C_.toHex(true),
            dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
          }
        })
        Ys.forEach((Y) => this.spent.add(Y))
        this.effects++
        return { signatures } as T
      }
      throw new Error('Unexpected fake mint endpoint')
    }
    return new Wallet(new Mint(MINT, { customRequest }), {
      unit: 'msat',
      bip39seed: Buffer.from(fixture.common.secrets.walletSeedHex, 'hex'),
      counterSource: createDaemonCounterSource(
        () => ({ fence: fixture.common.fence, observedAtMs: Date.now() }),
        { normalizedMint: MINT, unit: 'msat' },
      ),
    })
  }
}

function digest(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, current: unknown) =>
    typeof current === 'object' && current !== null && !Array.isArray(current)
      ? Object.fromEntries(
          Object.entries(current).sort(([left], [right]) => left.localeCompare(right)),
        )
      : current,
  )
  return createHash('sha256').update(canonical).digest('hex')
}

for (const evidence of [
  'unavailable',
  'missing-registration',
  'invalid-registration',
  'foreign-registration',
  'winning',
] as const) {
  test(`native ${evidence} refusal survives SQLite reopen without losing or Remove authority`, async () => {
    const fixture = await createFixture()
    try {
      await fixture.add('refusal-input', CURRENT_ID)
      fixture.wallet.error = new MintOperationError(13015, 'mint refusal')
      const common = { ...fixture.common }
      if (evidence === 'unavailable') fixture.wallet.evidenceError = new Error('evidence timeout')
      if (evidence === 'missing-registration')
        common.engine = { getConditionAttestation: async () => null } as never
      if (evidence === 'invalid-registration')
        (fixture.wallet.conditionInfo as { announcements: string[] }).announcements = ['02']
      if (evidence === 'foreign-registration')
        common.engine = {
          getConditionAttestation: async () => ({
            ...(await fixture.common.engine.getConditionAttestation()),
            conditionId: 'ff'.repeat(32),
          }),
        } as never
      const result = await claimDaemonPosition(common)
      assert.equal(result.legs[0]!.state, 'pending')
      assert.equal(
        result.legs[0]!.oracleEvidence!.status,
        evidence === 'winning' ? 'verified' : 'unverified',
      )
      const original = await inspectClaim(fixture, result.legs[0]!.operationId)
      assert.equal(original.record.operation.state, 'dispatch-intent')
      assert.equal(original.reservations, 1)
      assert.equal(original.predecessors[0]!.selectability, 'locked')
      const reopened = await openDaemonStateSqlite(fixture.directory)
      reopened.close()
      assert.equal((await claimDaemonPosition(common)).legs[0]!.state, 'pending')
      await assert.rejects(
        previewDaemonPositionRemove({ ...fixture.common, isCustodyReady: () => true }),
      )
      assert.equal((await inspectClaim(fixture, result.legs[0]!.operationId)).reservations, 1)
      if (evidence !== 'winning')
        assert.equal(
          (await getProofOperation(result.legs[0]!.operationId))!.metadata.oracleWitness,
          '',
        )
    } finally {
      await fixture.dispose()
    }
  })
}

test('native timeout then unverified refusal restores exact SPENT outputs after reopen', async () => {
  const fixture = await createFixture()
  try {
    await fixture.add('uncertain-refusal', CURRENT_ID)
    fixture.wallet.evidenceError = new Error('evidence unavailable')
    fixture.wallet.loseResponse = true
    const first = await claimDaemonPosition(fixture.common)
    const id = first.legs[0]!.operationId
    const frozen = (await getProofOperation(id))!
    const requestHash = fixture.wallet.requestHash()
    fixture.wallet.loseResponse = false
    fixture.wallet.error = new MintOperationError(13015, 'refusal after timeout')
    assert.equal((await claimDaemonPosition(fixture.common)).legs[0]!.state, 'pending')
    assert.equal(fixture.wallet.requestHash(), requestHash)
    assert.equal((await inspectClaim(fixture, id)).reservations, 1)
    const reopened = await openDaemonStateSqlite(fixture.directory)
    reopened.close()
    fixture.wallet.states = CheckStateEnum.SPENT
    const final = await claimDaemonPosition({
      ...fixture.common,
      walletDependencies: {
        ...fixture.common.walletDependencies,
        restoreOutputGroups: async () => ({ regular: fixture.wallet.results }),
      },
    })
    assert.equal(final.legs[0]!.state, 'completed')
    const completed = (await getProofOperation(id))!
    assert.equal(digest(completed.inputs), digest(frozen.inputs))
    assert.equal(digest(completed.outputs), digest(frozen.outputs))
    assert.equal(digest(completed.metadata), digest(frozen.metadata))
    assert.equal(fixture.wallet.requests.length, 2)
    assert.equal((await inspectClaim(fixture, id)).record.operation.state, 'reconciled')
  } finally {
    await fixture.dispose()
  }
})

test('native real producer sat evidence stays unverified for msat Claim while valid payout succeeds', async () => {
  const info = JSON.parse(
    readFileSync(new URL('./fixtures/d4/condition-info.json', import.meta.url), 'utf8'),
  )
  const registration = JSON.parse(
    readFileSync(new URL('./fixtures/d4/registered-authority.json', import.meta.url), 'utf8'),
  )
  assert.equal(
    createHash('sha256')
      .update(readFileSync(new URL('./fixtures/d4/condition-info.json', import.meta.url)))
      .digest('hex'),
    '941830cf8af43623452e9d08eb5d5953e64f481b753502413c50579ec7eadfcf',
  )
  assert.equal(info.collateral, 'sat')
  const fixture = await createFixture()
  try {
    // Native held keys are generated for msat. Captured producer oracle bytes remain sat.
    await fixture.add('real-producer-native', CURRENT_ID, 'YES', info.condition_id)
    fixture.wallet.conditionInfo = info
    const common = {
      ...fixture.common,
      conditionId: info.condition_id,
      engine: {
        getConditionAttestation: async () => ({
          conditionId: info.condition_id,
          registeredAuthority: registration,
        }),
      },
    }
    const result = await claimDaemonPosition(common as never)
    assert.equal(result.legs[0]!.state, 'completed')
    assert.equal(result.legs[0]!.oracleEvidence!.status, 'unverified')
    assert.ok(result.legs[0]!.payoutAmountSubunits > 0)
    assert.equal((await getProofOperation(result.legs[0]!.operationId))!.metadata.oracleWitness, '')
    assert.equal(
      fixture.wallet.requests[0]!.inputs.some((proof) => proof.witness !== undefined),
      false,
    )
    assert.equal(
      (await inspectClaim(fixture, result.legs[0]!.operationId)).record.operation.state,
      'reconciled',
    )
  } finally {
    await fixture.dispose()
  }
})
