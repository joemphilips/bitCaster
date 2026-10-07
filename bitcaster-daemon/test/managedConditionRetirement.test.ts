import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { finalizeEvent } from 'nostr-tools/pure'
import {
  CheckStateEnum,
  MintOperationError,
  deriveKeysetId,
  deriveConditionalKeysetId,
  createBlindSignature,
  createDLEQProof,
  pointFromHex,
  type OutputDataLike,
  hashToCurve,
  type MintKeys,
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
import { retireDaemonConditionInventory } from '../src/managedConditionRetirement.ts'
import { withDurableCustodyUnitOfWork } from '../src/durableCustodyUnitOfWork.ts'
import { readProfile } from '../src/profile.ts'
import { canonicalTestKeysetId } from './support/canonicalKeysetId.ts'

const roots: string[] = []
const CTF_KEYSET_ID = canonicalTestKeysetId('managed-retirement:ctf')
const REGULAR_KEY = bytesToHex(
  secp256k1.getPublicKey(Uint8Array.from([...new Uint8Array(31), 1]), true),
)
const REGULAR_KEYS = { 1: REGULAR_KEY, 2: REGULAR_KEY, 4: REGULAR_KEY }
const REGULAR_KEYSET_ID = deriveKeysetId(REGULAR_KEYS, {
  unit: 'msat',
  versionByte: 1,
  input_fee_ppk: 0,
})
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))))

test('daemon previews then atomically retires one verified condition inventory', async () => {
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
  const { created_at, ...signedEvent } = finalizeEvent(
    { kind: 89, created_at: 1_900_000_000, tags: [['e', '44'.repeat(32)]], content: 'AQ==' },
    oraclePrivateKey,
  )
  const inputs = Array.from({ length: 65 }, (_, index) =>
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
  const common = {
    conditionId,
    profile,
    secrets: { walletSeedHex: seed },
    fence,
    intentKind: 'explicit-user-command' as const,
    engine: {
      getConditionAttestation: async () => ({
        conditionId,
        attestedOutcome: 'YES',
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
            {
              oracle_pubkey: oraclePublicKey,
              oracle_sig: signature,
              outcome: 'YES',
            },
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
                .update(Buffer.from([1]))
                .digest('hex'),
            },
          ],
        },
      }),
    },
    walletDependencies: {
      createCashuWallet: () => wallet,
      resolveInputFeePpkByKeyset: async () => ({ [CTF_KEYSET_ID]: 0 }),
    },
  }

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
      engine: {
        getConditionAttestation: async () => ({
          ...(await common.engine.getConditionAttestation())!,
          conditionId: losingConditionId,
          registeredAuthority: {
            ...((await common.engine.getConditionAttestation())!.registeredAuthority as object),
            eventId: losingEventId,
          },
        }),
      },
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
        engine: {
          getConditionAttestation: async () => ({
            ...(await common.engine.getConditionAttestation()),
            conditionId: badCondition,
            registeredAuthority: {
              ...((await common.engine.getConditionAttestation()).registeredAuthority as object),
              eventId: event,
            },
          }),
        },
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
  const legacyResponse = {
    ...(await common.engine.getConditionAttestation()),
    conditionId: legacyCondition,
    registeredAuthority: {
      ...((await common.engine.getConditionAttestation()).registeredAuthority as object),
      eventId: legacyEvent,
    },
  }
  const legacyCommon = {
    ...common,
    conditionId: legacyCondition,
    engine: { getConditionAttestation: async () => legacyResponse },
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
  const retryResponse = {
    ...(await common.engine.getConditionAttestation())!,
    conditionId: retryConditionId,
    registeredAuthority: {
      ...((await common.engine.getConditionAttestation())!.registeredAuthority as object),
      eventId: retryEventId,
    },
  }
  await assert.rejects(
    retireDaemonConditionInventory({
      ...common,
      conditionId: retryConditionId,
      acknowledge: true,
      engine: { getConditionAttestation: async () => retryResponse },
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
    engine: { getConditionAttestation: async () => null },
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
      engine: {
        getConditionAttestation: async () => ({
          ...retryResponse,
          conditionId: reservedConditionId,
          registeredAuthority: {
            ...(retryResponse.registeredAuthority as object),
            eventId: reservedEventId,
          },
        }),
      },
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

class FakeRetirementWallet {
  redeemCalls = 0
  private readonly error: unknown

  constructor(error?: unknown) {
    this.error = error
  }
  conditional?: MintKeys
  conditionInfo?: unknown
  alterResult?: (proofs: Proof[]) => Proof[]
  readonly mint = {
    getCtfCondition: async () => {
      if (this.conditionInfo === undefined) throw new Error('condition info unavailable')
      return this.conditionInfo
    },
    getKeySets: async () => ({ keysets: [regularKeyset(), this.conditional ?? outcomeKeyset()] }),
    getKeys: async (keysetId?: string) => ({
      keysets: [
        keysetId === (this.conditional?.id ?? CTF_KEYSET_ID)
          ? (this.conditional ?? outcomeKeyset())
          : regularKeyset(),
      ],
    }),
  }

  async loadMint(): Promise<void> {}

  async redeemOutcomeProofs(options: {
    inputs: Proof[]
    outputs: OutputDataLike[]
  }): Promise<Proof[]> {
    this.redeemCalls += 1
    if (this.error !== undefined) throw this.error
    const privateKey = Uint8Array.from([...new Uint8Array(31), 1])
    const result = options.outputs.map((output) => {
      const signature = createBlindSignature(
        pointFromHex(output.blindedMessage.B_),
        privateKey,
        output.blindedMessage.id,
      )
      const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), privateKey)
      return output.toProof(
        {
          id: output.blindedMessage.id,
          amount: output.blindedMessage.amount,
          C_: signature.C_.toHex(true),
          dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
        },
        regularKeyset(),
      )
    })
    return this.alterResult?.(result) ?? result
  }

  async checkProofsStates(proofs: Array<Pick<Proof, 'secret'>>) {
    return proofs.map(({ secret }) => ({
      Y: hashToCurve(new TextEncoder().encode(secret)).toHex(true),
      state: CheckStateEnum.UNSPENT,
      witness: null,
    }))
  }
}

function proof(id: string, secret: string, amount: number): Proof {
  return { id, secret, amount, C: hashToCurve(utf8ToBytes(secret)).toHex(true) } as Proof
}

function regularKeyset(): MintKeys {
  return {
    id: REGULAR_KEYSET_ID,
    unit: 'msat',
    active: true,
    input_fee_ppk: 0,
    keys: REGULAR_KEYS,
  } as unknown as MintKeys
}

function outcomeKeyset(): MintKeys {
  return { ...regularKeyset(), id: CTF_KEYSET_ID }
}

function signOutcome(outcome: string, privateKey: Uint8Array): string {
  const message = taggedHash('DLC/oracle/attestation/v0', utf8ToBytes(outcome))
  return bytesToHex(schnorr.sign(message, privateKey, Uint8Array.from(new Uint8Array(32))))
}

function taggedHash(tag: string, message: Uint8Array): Uint8Array {
  const tagHash = sha256(utf8ToBytes(tag))
  return sha256(concatBytes(tagHash, tagHash, message))
}
