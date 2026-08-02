import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { CheckStateEnum, type MintKeys, type Proof } from '@cashu/cashu-ts'
import { ORACLE_NOT_ATTESTED_OUTCOME_CODE } from '@bitcaster-market/client-sdk/ctfRedeem'
import { deriveDlcConditionId } from '@bitcaster-market/client-sdk/managedConditionInventory'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import {
  addAvailableProofs,
  prepareProofOperationWithExactReservation,
  readState,
} from '../src/state.ts'
import { retireDaemonConditionInventory } from '../src/managedConditionRetirement.ts'
import { readProfile } from '../src/profile.ts'

const roots: string[] = []
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))))

test('daemon previews then atomically retires one verified condition inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-retirement-'))
  roots.push(root)
  const directory = join(root, 'profile')
  process.env.BITCASTER_DAEMON_HOME = directory
  const seed = '11'.repeat(32)
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
  const inputs = Array.from({ length: 65 }, (_, index) =>
    proof('ctf-keyset', `conditional-input-${index.toString().padStart(3, '0')}`, 1),
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
              announcementIdentity: '44'.repeat(32),
            },
          ],
        },
      }),
    },
    walletDependencies: {
      createCashuWallet: () => wallet,
      resolveInputFeePpkByKeyset: async () => ({ 'ctf-keyset': 0 }),
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
    state.wallet.proofs.some(
      (record) => record.asset.kind === 'Outcome' && record.asset.conditionId === conditionId,
    ),
    false,
  )
  assert.equal(
    state.wallet.proofs.some(
      (record) =>
        record.asset.kind === 'sats' &&
        record.proof.secret === 'regular-result:conditional-input-000',
    ),
    true,
  )
  await assert.rejects(
    addAvailableProofs('https://mint.example', [proof('ctf-keyset', 'late-proof', 1)], {
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
  const losingInput = proof('ctf-keyset', 'conditional-loser', 5)
  await addAvailableProofs('https://mint.example', [losingInput], {
    kind: 'Outcome',
    conditionId: losingConditionId,
    outcomeSetId: 'NO',
    baseAsset: 'sat',
    unit: 'msat',
  })
  const losingWallet = new FakeRetirementWallet({ code: ORACLE_NOT_ATTESTED_OUTCOME_CODE })
  await retireDaemonConditionInventory({
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
      resolveInputFeePpkByKeyset: async () => ({ 'ctf-keyset': 0 }),
    },
  })
  const afterLosing = await readState()
  const retained = afterLosing?.wallet.proofs.find(
    (record) => record.proof.secret === losingInput.secret,
  )
  assert.equal(retained?.state, 'locked')
  assert.equal(retained?.asset.kind, 'Outcome')

  const retryEventId = 'daemon-retirement-restart-test'
  const retryConditionId = deriveDlcConditionId({
    eventId: retryEventId,
    outcomeCount: 2,
    oraclePublicKeys: [oraclePublicKey],
  })
  await addAvailableProofs(
    'https://mint.example',
    [proof('ctf-keyset', 'conditional-restart', 4)],
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
        resolveInputFeePpkByKeyset: async () => ({ 'ctf-keyset': 0 }),
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
      resolveInputFeePpkByKeyset: async () => ({ 'ctf-keyset': 0 }),
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
  const reservedProof = proof('ctf-keyset', 'conditional-reserved', 3)
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

class FakeRetirementWallet {
  redeemCalls = 0
  private readonly error: unknown

  constructor(error?: unknown) {
    this.error = error
  }
  readonly mint = {
    getKeys: async (keysetId?: string) => ({
      keysets: [keysetId === 'ctf-keyset' ? outcomeKeyset() : regularKeyset()],
    }),
  }

  async loadMint(): Promise<void> {}

  async redeemOutcomeProofs(options: {
    inputs: Proof[]
    outputs: Array<{ blindedMessage: { amount: number; id: string } }>
  }): Promise<Proof[]> {
    this.redeemCalls += 1
    if (this.error !== undefined) throw this.error
    const amount = options.outputs.reduce(
      (sum, output) => sum + Number(output.blindedMessage.amount),
      0,
    )
    return [proof('regular-keyset', `regular-result:${options.inputs[0]?.secret}`, amount)]
  }

  async checkProofsStates() {
    return [{ state: CheckStateEnum.UNSPENT, secret: 'conditional-restart' }]
  }
}

function proof(id: string, secret: string, amount: number): Proof {
  return { id, secret, amount, C: `C-${secret}` } as Proof
}

function regularKeyset(): MintKeys {
  return {
    id: 'regular-keyset',
    unit: 'msat',
    active: true,
    input_fee_ppk: 0,
    keys: { 1: '02'.repeat(33), 2: '03'.repeat(33), 4: '04'.repeat(33) },
  } as unknown as MintKeys
}

function outcomeKeyset(): MintKeys {
  return { ...regularKeyset(), id: 'ctf-keyset' }
}

function signOutcome(outcome: string, privateKey: Uint8Array): string {
  const message = taggedHash('DLC/oracle/attestation/v0', utf8ToBytes(outcome))
  return bytesToHex(schnorr.sign(message, privateKey, Uint8Array.from(new Uint8Array(32))))
}

function taggedHash(tag: string, message: Uint8Array): Uint8Array {
  const tagHash = sha256(utf8ToBytes(tag))
  return sha256(concatBytes(tagHash, tagHash, message))
}
