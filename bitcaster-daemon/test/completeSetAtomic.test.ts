import {
  CheckStateEnum,
  MintOperationError,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  getEncodedToken,
  hashToCurve,
  pointFromHex,
  type MintKeys,
  type OutputData,
  type Proof,
} from '@cashu/cashu-ts'
import { bytesToHex } from '@noble/curves/utils.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { COLLATERAL_COLLECTION } from '@bitcaster-market/client-sdk/ctfConsolidation'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import type { CtfSplitTransport } from '@bitcaster-market/client-sdk/ctfSplit'
import { deriveRootCtfOutcomeCollectionId } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import { attestableCtfConditionFixture } from '../../bitcaster-client-sdk/test/support/ctfAnnouncementFixture.ts'
import {
  mintDenominationKeys,
  mintDenominationPrivateKey,
} from '../../bitcaster-client-sdk/test/support/mintDenominationKeys.ts'
import {
  completeSetConvertOperationId,
  splitWalletCompleteSet,
} from '../src/completeSetConversion.ts'
import { DurableCustodySqliteStore } from '../src/durableCustodySqliteStore.ts'
import { DaemonDurableWalletReceiveCoordinator } from '../src/durableWalletReceiveCoordinator.ts'
import { claimDaemonPosition } from '../src/nativePositionClaim.ts'
import { readSecrets } from '../src/secrets.ts'
import { dispatch } from '../src/server.ts'
import { addAvailableProofs, getProofOperation } from '../src/state.ts'
import { withDaemonStateSqliteTransaction } from '../src/stateSqlite.ts'
import { readDaemonWalletBalance } from '../src/walletBalance.ts'
import {
  deserializeOutputGroups,
  type CashuWalletLike,
  prepareRegularWalletReceive,
  recoverPreparedWalletSends,
  resumeCtfConsolidationOperation,
  sendWalletToken,
} from '../src/walletOps.ts'
import { serviceFixture, MINT, SEED } from './nativePaymentRequestServiceFixture.ts'
import { resolvedResolution } from './support/conditionResolutionStub.ts'

// The service fixture signs its regular keyset with this scalar and these denominations.
const MINT_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 7])
const KEYS = mintDenominationKeys(
  MINT_PRIVATE_KEY,
  Array.from({ length: 15 }, (_, index) => String(2 ** index)),
)
const SATS = { kind: 'sats', baseAsset: 'sat', unit: 'msat' } as const
const PROFILE = {
  mintUrl: MINT,
  engineBaseUrl: 'https://engine.example',
  initializedAt: new Date(0).toISOString(),
}
type Dependencies = Parameters<typeof splitWalletCompleteSet>[0]['deps']

function conditionalKeysets(conditionId: string, outcomes: readonly string[]) {
  return Object.fromEntries(
    outcomes.map((outcome) => [
      outcome,
      deriveConditionalKeysetId({
        keys: KEYS,
        unit: 'msat',
        input_fee_ppk: 1,
        conditionId,
        outcomeCollectionId: deriveRootCtfOutcomeCollectionId({
          conditionId,
          outcomeCollection: outcome,
        }),
      }),
    ]),
  )
}

function signOutput(output: OutputData, keys: MintKeys): Proof {
  const { id, B_, amount } = output.blindedMessage
  const signingKey = mintDenominationPrivateKey(MINT_PRIVATE_KEY, amount.toString())
  const signature = createBlindSignature(pointFromHex(B_), signingKey, id)
  const dleq = createDLEQProof(pointFromHex(B_), signingKey)
  return output.toProof(
    {
      id,
      amount,
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    keys,
  )
}

/**
 * Custody holds the funding from production receives. Each token [n, 1]
 * arrives as one n msat proof after the 1 msat receive fee. The mint answers
 * one CTF convert, and a test can lose the answer after the effect.
 */
async function fixture(options: { tokens?: number[][]; outcomes?: string[] } = {}) {
  const outcomes = options.outcomes ?? ['A', 'B']
  const eventId = `split-${outcomes.join('-')}`
  // The oracle can attest the first outcome after the split.
  const oracle = attestableCtfConditionFixture({ outcomes, eventId, winner: outcomes[0]! })
  const registration = oracle.registration
  const conditionId = registration.condition_id
  const partition = conditionalKeysets(conditionId, outcomes)
  const f = await serviceFixture({ defaultWallet: true, largeDenominations: true, inputFeePpk: 1 })
  try {
    const mint = f.deps.createCashuMint!(MINT)
    const regular = (await mint.getKeys()).keysets.find(
      (keyset) => Object.keys(keyset.keys).length === KEYS_COUNT,
    )!
    const keysById = new Map<string, MintKeys>([
      [regular.id, regular as MintKeys],
      ...Object.values(partition).map(
        (id) => [id, { id, unit: 'msat', input_fee_ppk: 1, keys: KEYS } as MintKeys] as const,
      ),
    ])
    for (const [index, amounts] of (options.tokens ?? [[128, 1]]).entries()) {
      const prepared = await prepareRegularWalletReceive({
        encodedToken: getEncodedToken({
          mint: MINT,
          unit: 'msat',
          proofs: amounts.map((amount, proof) =>
            f.mintProof(amount, `split-funding-${index}-${proof}`),
          ),
        }),
        mintUrl: MINT,
        unit: 'msat',
        secrets: { walletSeedHex: SEED },
        deps: f.deps,
      })
      await new DaemonDurableWalletReceiveCoordinator(
        f.directory,
        () => f.fence,
        f.deps.restoreOutputGroups!,
      ).execute(prepared)
    }
    const convert = {
      requests: [] as Array<Record<string, unknown>>,
      // A lost answer: the mint applies the convert, but the daemon receives no reply.
      loseAnswer: false,
      // A definite mint refusal code, before any effect.
      refuse: null as number | null,
      mintAttestation: undefined as Record<string, unknown> | undefined,
    }
    const transport: CtfSplitTransport = {
      getKeys: async (id) => keysById.get(id)!,
      getRootPartitionKeysets: async () => ({ ...partition }),
      postSplit: async () => {
        throw new Error('a new split posts one convert through the custody executor')
      },
    }
    const deps: Dependencies = {
      ...f.deps,
      createCtfSplitTransport: () => transport,
      fetchConsolidationCondition: async () =>
        new Response(
          JSON.stringify({
            ...registration,
            ...(convert.mintAttestation === undefined
              ? {}
              : { attestation: convert.mintAttestation }),
          }),
        ),
      resolveOutputKeysetByCollection: async () => ({ [COLLATERAL_COLLECTION]: regular.id }),
      resolveInputFeePpkByKeyset: async (_mint, ids) =>
        Object.fromEntries(ids.map((id) => [id, 1])),
      resolveMintKeysByKeyset: async (_mint, ids) =>
        Object.fromEntries(ids.map((id) => [id, keysById.get(id)!])),
      resolveDurableCustodyKeysets: async (_mint, ids) =>
        ids.map((id) => {
          const outcome = Object.entries(partition).find(([, keysetId]) => keysetId === id)?.[0]
          return {
            canonicalMintUrl: MINT,
            id,
            unit: 'msat',
            keys: KEYS,
            inputFeePpk: 1,
            finalExpiry: null,
            identity:
              outcome === undefined
                ? { kind: 'regular' as const }
                : {
                    kind: 'conditional' as const,
                    conditionId,
                    outcomeCollection: outcome,
                    outcomeCollectionId: deriveRootCtfOutcomeCollectionId({
                      conditionId,
                      outcomeCollection: outcome,
                    }),
                  },
          }
        }),
      ctfConvert: async (_mint, request, outputsByCollection) => {
        convert.requests.push(structuredClone(request) as unknown as Record<string, unknown>)
        if (convert.refuse !== null) throw new MintOperationError(convert.refuse, 'refused')
        const signed = Object.fromEntries(
          Object.entries(outputsByCollection).map(([collection, outputs]) => [
            collection,
            outputs.map((output) => signOutput(output, keysById.get(output.blindedMessage.id)!)),
          ]),
        )
        if (convert.loseAnswer) throw new Error('lost mint answer')
        return signed
      },
      restoreOutputGroups: async (_mint, groups) =>
        Object.fromEntries(
          Object.entries(deserializeOutputGroups(groups)).map(([collection, outputs]) => [
            collection,
            outputs.map((output) => signOutput(output, keysById.get(output.blindedMessage.id)!)),
          ]),
        ),
    }
    const secrets = (await readSecrets())!
    return {
      ...f,
      conditionId,
      convert,
      deps,
      /** Claim the winning first outcome through the claim code, against a redeeming mint. */
      claimWinner: async () => {
        const winner = outcomes[0]!
        const redeem = redeemingMint(conditionId, partition, regular as MintKeys, keysById)
        const result = await claimDaemonPosition({
          conditionId,
          outcomeCollection: winner,
          profile: PROFILE,
          secrets: { walletSeedHex: SEED },
          fence: f.fence,
          walletDependencies: { ...deps, createCashuWallet: () => redeem.wallet },
          resolution: resolvedResolution({
            conditionId,
            attestedOutcome: winner,
            oracleWitness: {
              oracle_sigs: [
                {
                  oracle_pubkey: oracle.oraclePublicKey,
                  oracle_sig: oracle.signature,
                  outcome: winner,
                },
              ],
            },
            registeredAuthority: {
              eventId,
              outcomes: [...outcomes],
              threshold: 1,
              oracles: [
                {
                  oraclePublicKey: oracle.oraclePublicKey,
                  noncePoint: oracle.signature.slice(0, 64),
                  announcementIdentity: createHash('sha256')
                    .update(Buffer.from(registration.announcements[0]!, 'hex'))
                    .digest('hex'),
                },
              ],
            },
          }),
        })
        return { result, redeemRequests: redeem.requests }
      },
      split: (amountMsat = 100, operationId = 'split-root', override: Dependencies = deps) =>
        splitWalletCompleteSet({
          operationId,
          conditionId,
          amountMsat,
          mintUrl: MINT,
          secrets,
          deps: override,
        }),
      dispatchSplit: (amountMsat: number, operationId: string, override: Dependencies = deps) =>
        dispatch(
          {
            method: 'wallet.splitCompleteSet',
            params: { conditionId, amountMsat, operationId },
          },
          override as never,
        ),
      send: (amountMsat: number, operationId: string) =>
        sendWalletToken(amountMsat, PROFILE, { walletSeedHex: SEED }, f.deps, MINT, operationId),
    }
  } catch (error) {
    await f.close()
    throw error
  }
}
const KEYS_COUNT = 15

/**
 * A mint that redeems winning outcome proofs into regular proofs. It signs the
 * exact outputs of each request, as the position claim tests do.
 */
function redeemingMint(
  conditionId: string,
  partition: Record<string, string>,
  regular: MintKeys,
  keysById: ReadonlyMap<string, MintKeys>,
) {
  const keysets = [
    { id: regular.id, unit: 'msat', active: true, input_fee_ppk: 1, keys: regular.keys },
    ...Object.entries(partition).map(([outcome, id]) => ({
      id,
      unit: 'msat',
      active: true,
      input_fee_ppk: 1,
      keys: KEYS,
      conditional: {
        condition_id: conditionId,
        outcome_collection: outcome,
        outcome_collection_id: deriveRootCtfOutcomeCollectionId({
          conditionId,
          outcomeCollection: outcome,
        }),
      },
    })),
  ] as unknown as MintKeys[]
  const requests: Array<{ readonly inputs: readonly Proof[] }> = []
  const wallet = {
    mint: {
      getKeySets: async () => ({ keysets }),
      getKeys: async (id?: string) => ({
        keysets: id === undefined ? keysets : keysets.filter((keyset) => keyset.id === id),
      }),
    },
    loadMint: async () => undefined,
    redeemOutcomeProofs: async ({
      inputs,
      outputs,
    }: {
      inputs: Proof[]
      outputs: OutputData[]
    }) => {
      requests.push({ inputs: structuredClone(inputs) })
      return outputs.map((output) => signOutput(output, keysById.get(output.blindedMessage.id)!))
    },
    checkProofsStates: async (proofs: Array<Pick<Proof, 'secret'>>) =>
      proofs.map(({ secret }) => ({
        Y: hashToCurve(new TextEncoder().encode(secret)).toHex(true),
        state: CheckStateEnum.UNSPENT,
        witness: null,
      })),
  }
  return { wallet: wallet as unknown as CashuWalletLike, requests }
}

/** Counts and amounts only; never proof bodies or secrets. */
async function custodyFacts(directory: string) {
  return withDaemonStateSqliteTransaction(directory, (database) => ({
    wallet: database
      .prepare(
        `SELECT asset_kind AS kind, coalesce(outcome_set_id, '*') AS collection, state,
           SUM(amount) AS total
         FROM target_wallet_proofs GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
      )
      .all()
      .map((row) => `${row.kind}/${row.collection}/${row.state}:${row.total}`),
    custody: database
      .prepare(
        `SELECT coalesce(outcome_set_id, '*') AS collection, selectability, nut07_state AS nut07,
           SUM(amount) AS total
         FROM custody_proofs GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
      )
      .all()
      .map((row) => `${row.collection}/${row.selectability}/${row.nut07}:${row.total}`),
    // An available wallet row without its exact unspent, verified custody row.
    walletOnly: Number(
      (
        database
          .prepare(
            `SELECT COUNT(*) AS n FROM target_wallet_proofs AS w
             WHERE w.state = 'available' AND NOT EXISTS (
               SELECT 1 FROM custody_proofs AS c
               WHERE c.scope_id = w.scope_id AND c.normalized_mint = w.normalized_mint
                 AND c.keyset_id = w.keyset_id AND c.amount = w.amount
                 AND c.condition_id IS w.condition_id AND c.outcome_set_id IS w.outcome_set_id
                 AND c.nut07_state = 'UNSPENT' AND c.signature_verified = 1
                 AND c.dleq_state = 'verified' AND c.reservation_operation_id IS NULL
                 AND c.selectability IN ('selectable', 'retained'))`,
          )
          .get() as { n: number }
      ).n,
    ),
    operations: database
      .prepare(`SELECT kind, state FROM target_proof_operations ORDER BY kind, state`)
      .all()
      .map((row) => `${row.kind}/${row.state}`),
  }))
}

function outputTotal(request: Record<string, unknown>, collection: string): number {
  const outputs = (request.outputs as Record<string, Array<{ amount: unknown }>>)[collection] ?? []
  return outputs.reduce((total, { amount }) => total + amountToNumber(amount), 0)
}

test('a split is one custody convert: its outputs and change enter custody and its input is spent', async () => {
  const f = await fixture()
  try {
    const swaps = f.counts.swaps
    const result = await f.split()
    assert.deepEqual(result, {
      operationId: 'split-root',
      conditionId: f.conditionId,
      amountMsat: 100,
      outcomeProofCounts: { A: 3, B: 3 },
    })
    assert.equal(f.counts.swaps, swaps, 'a split makes no regular swap')
    assert.equal(f.convert.requests.length, 1)
    const request = f.convert.requests[0]!
    assert.deepEqual(Object.keys(request.inputs as object), [COLLATERAL_COLLECTION])
    // One 128 msat input at 1 ppk: the fee is 1 msat, and 27 msat return as change.
    assert.equal(outputTotal(request, 'A'), 100)
    assert.equal(outputTotal(request, 'B'), 100)
    assert.equal(outputTotal(request, COLLATERAL_COLLECTION), 27)
    const facts = await custodyFacts(f.directory)
    assert.equal(facts.walletOnly, 0)
    assert.deepEqual(facts.wallet, [
      'outcome/A/available:100',
      'outcome/B/available:100',
      'sats/*/available:27',
    ])
    assert.deepEqual(facts.custody, [
      '*/retained/UNSPENT:27',
      '*/spent/SPENT:128',
      'A/retained/UNSPENT:100',
      'B/retained/UNSPENT:100',
    ])
    assert.ok(facts.operations.includes('ctf-consolidation/completed'))
  } finally {
    await f.close()
  }
})

test('a split whose input covers the gross amount exactly has no change output', async () => {
  const f = await fixture()
  try {
    // 128 msat pay 127 msat to each outcome and the 1 msat fee.
    await f.split(127)
    assert.deepEqual(Object.keys(f.convert.requests[0]!.outputs as object).sort(), ['A', 'B'])
    const facts = await custodyFacts(f.directory)
    assert.equal(facts.walletOnly, 0)
    assert.deepEqual(facts.wallet, ['outcome/A/available:127', 'outcome/B/available:127'])
  } finally {
    await f.close()
  }
})

test('a split pays each outcome of a market with three outcomes', async () => {
  const f = await fixture({ outcomes: ['A', 'B', 'C'] })
  try {
    const result = await f.split(64)
    assert.deepEqual(Object.keys(result.outcomeProofCounts).sort(), ['A', 'B', 'C'])
    const facts = await custodyFacts(f.directory)
    assert.equal(facts.walletOnly, 0)
    assert.deepEqual(facts.wallet, [
      'outcome/A/available:64',
      'outcome/B/available:64',
      'outcome/C/available:64',
      'sats/*/available:63',
    ])
  } finally {
    await f.close()
  }
})

test('a split takes the largest inputs first and pays one fee for them', async () => {
  // The receives leave many small proofs. 100 msat need several of them.
  const f = await fixture({
    tokens: [
      [64, 1],
      [32, 1],
      [8, 1],
    ],
  })
  try {
    const available = await withDaemonStateSqliteTransaction(f.directory, (database) =>
      database
        .prepare(`SELECT amount FROM target_wallet_proofs WHERE state = 'available'`)
        .all()
        .map((row) => Number(row.amount))
        .sort((left, right) => right - left),
    )
    await f.split()
    const inputs = (f.convert.requests[0]!.inputs as Record<string, Array<{ amount: unknown }>>)
      [COLLATERAL_COLLECTION]!.map(({ amount }) => amountToNumber(amount))
      .sort((left, right) => right - left)
    // At most 999 inputs cost 1 msat at 1 ppk. The largest proofs that cover 101 msat are used.
    let covered = 0
    const expected = available.filter((amount) => {
      if (covered >= 101) return false
      covered += amount
      return true
    })
    assert.deepEqual(inputs, expected)
    const change = covered - 1 - 100
    assert.deepEqual((await custodyFacts(f.directory)).wallet, [
      'outcome/A/available:100',
      'outcome/B/available:100',
      `sats/*/available:${available.reduce((sum, amount) => sum + amount, 0) - covered + change}`,
    ])
  } finally {
    await f.close()
  }
})

test('a claim redeems the winning outcome that a split made, and its payout enters custody', async () => {
  const f = await fixture()
  try {
    await f.split()
    const { result, redeemRequests } = await f.claimWinner()
    assert.equal(result.legs.length, 1)
    assert.equal(result.legs[0]!.state, 'completed')
    assert.equal(result.legs[0]!.oracleEvidence.status, 'verified')
    // Three outcome A proofs pay 100 msat and the 1 msat input fee of their keyset.
    assert.equal(result.legs[0]!.payoutAmountSubunits, 99)
    assert.equal(redeemRequests.length, 1)
    assert.equal(redeemRequests[0]!.inputs.length, 3)
    const facts = await custodyFacts(f.directory)
    assert.equal(facts.walletOnly, 0)
    assert.deepEqual(facts.wallet, ['outcome/B/available:100', 'sats/*/available:126'])
    assert.deepEqual(facts.custody, [
      '*/retained/UNSPENT:27',
      '*/selectable/UNSPENT:99',
      '*/spent/SPENT:128',
      'A/spent/SPENT:100',
      'B/retained/UNSPENT:100',
    ])
    // The payout and the split change pay a send that neither pays alone.
    await f.send(110, 'after-claim')
    assert.equal((await custodyFacts(f.directory)).walletOnly, 0)
  } finally {
    await f.close()
  }
})

test('the change of a split pays a later send, with and without the other funds', async () => {
  const f = await fixture({
    tokens: [
      [128, 1],
      [64, 1],
    ],
  })
  try {
    await f.split()
    // 27 msat of change and 64 msat of funds remain. Each send completes.
    await f.send(20, 'after-split-a')
    await f.send(60, 'after-split-b')
    const facts = await custodyFacts(f.directory)
    assert.equal(facts.walletOnly, 0)
    assert.equal(
      facts.operations.filter((operation) => operation === 'wallet-send/completed').length,
      2,
    )
  } finally {
    await f.close()
  }
})

test('a split retry with the same operation id returns the saved result', async () => {
  const f = await fixture()
  try {
    const first = await f.split()
    const facts = await custodyFacts(f.directory)
    assert.deepEqual(await f.split(), first)
    assert.equal(f.convert.requests.length, 1)
    assert.deepEqual(await custodyFacts(f.directory), facts)
    await assert.rejects(f.split(50), /operation id belongs to a different split/)
    assert.equal(f.convert.requests.length, 1)
  } finally {
    await f.close()
  }
})

for (const resume of ['retry', 'recovery'] as const)
  test(`a split with a lost mint answer finishes on ${resume} without a second convert`, async () => {
    const f = await fixture()
    try {
      f.convert.loseAnswer = true
      await assert.rejects(f.split(), /CTF consolidation mint result is uncertain/)
      f.convert.loseAnswer = false
      const conversions = async () =>
        (await custodyFacts(f.directory)).operations.filter((operation) =>
          operation.startsWith('ctf-consolidation/'),
        )
      assert.deepEqual(await conversions(), ['ctf-consolidation/prepared'])
      // The mint spent the input, so the exact saved outputs are restored.
      f.control.state = CheckStateEnum.SPENT
      if (resume === 'retry') await f.split()
      else
        assert.deepEqual(await recoverPreparedWalletSends(f.deps), {
          recovered: [completeSetConvertOperationId('split-root')],
          pending: [],
        })
      assert.equal(f.convert.requests.length, 1)
      const facts = await custodyFacts(f.directory)
      assert.equal(facts.walletOnly, 0)
      assert.deepEqual(facts.wallet, [
        'outcome/A/available:100',
        'outcome/B/available:100',
        'sats/*/available:27',
      ])
      assert.deepEqual(await conversions(), ['ctf-consolidation/completed'])
    } finally {
      await f.close()
    }
  })

for (const lost of ['preparation', 'completion'] as const)
  test(`a split whose ${lost} COMMIT reply is lost converts once and keeps canonical custody`, async () => {
    const f = await fixture()
    try {
      // The first commit binds the split before the mint. The second applies its result.
      let commits = 0
      const loseReply = {
        ...f.deps,
        injectCustodyFault: (phase: string) => {
          if (phase !== 'after-commit') return
          commits += 1
          if (commits === (lost === 'preparation' ? 1 : 2))
            throw new Error('controlled lost COMMIT reply')
        },
      }
      if (lost === 'preparation') {
        // The executor reads the saved operation and resumes it in the same call.
        const result = await f.split(100, 'split-root', loseReply)
        assert.deepEqual(result.outcomeProofCounts, { A: 3, B: 3 })
      } else {
        await assert.rejects(f.split(100, 'split-root', loseReply), /controlled lost COMMIT reply/)
        // A retry reads the completed operation and returns its saved result.
        assert.deepEqual((await f.split()).outcomeProofCounts, { A: 3, B: 3 })
      }
      assert.equal(f.convert.requests.length, 1)
      const facts = await custodyFacts(f.directory)
      assert.equal(facts.walletOnly, 0)
      assert.deepEqual(facts.custody, [
        '*/retained/UNSPENT:27',
        '*/spent/SPENT:128',
        'A/retained/UNSPENT:100',
        'B/retained/UNSPENT:100',
      ])
      assert.deepEqual(await recoverPreparedWalletSends(f.deps), { recovered: [], pending: [] })
      assert.deepEqual(await custodyFacts(f.directory), facts)
      assert.equal(f.convert.requests.length, 1)
    } finally {
      await f.close()
    }
  })

test('recovery does not admit again a split output that a later send spent', async () => {
  const f = await fixture()
  try {
    await f.split()
    // The change is the only regular fund, so the send spends it.
    await f.send(20, 'spend-change')
    const balance = await readDaemonWalletBalance(f.directory)
    const facts = await custodyFacts(f.directory)
    assert.deepEqual(await recoverPreparedWalletSends(f.deps), { recovered: [], pending: [] })
    assert.deepEqual(await readDaemonWalletBalance(f.directory), balance)
    assert.deepEqual(await custodyFacts(f.directory), facts)
  } finally {
    await f.close()
  }
})

test('recovery skips a completed split without a read of its custody artifacts', async () => {
  const f = await fixture()
  try {
    await f.split()
    const getArtifact = DurableCustodySqliteStore.prototype.getArtifact
    let artifactReads = 0
    DurableCustodySqliteStore.prototype.getArtifact = function (...args) {
      artifactReads += 1
      return getArtifact.apply(this, args)
    }
    try {
      assert.deepEqual(await recoverPreparedWalletSends(f.deps), { recovered: [], pending: [] })
    } finally {
      DurableCustodySqliteStore.prototype.getArtifact = getArtifact
    }
    // A completed split is final when custody shows its result as applied. Its saved
    // request, output plan and private material stay unread.
    assert.equal(artifactReads, 0)
  } finally {
    await f.close()
  }
})

test('one fenced read checks every finished split of a recovery pass', async () => {
  const f = await fixture({
    tokens: [
      [128, 1],
      [128, 1],
      [128, 1],
    ],
  })
  try {
    for (const id of ['first', 'second', 'third']) await f.split(100, id)
    const prepare = DatabaseSync.prototype.prepare
    let fenceReads = 0
    DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
      if (sql.includes('FROM custody_scope_state WHERE scope_id = ?')) fenceReads += 1
      return prepare.call(this, sql)
    } as typeof prepare
    try {
      assert.deepEqual(await recoverPreparedWalletSends(f.deps), { recovered: [], pending: [] })
    } finally {
      DatabaseSync.prototype.prepare = prepare
    }
    // The cost of a pass does not grow with the count of finished splits.
    assert.equal(fenceReads, 1)
  } finally {
    await f.close()
  }
})

test('a corrupt custody result state of one finished split leaves only that split pending', async () => {
  const f = await fixture({
    tokens: [
      [128, 1],
      [128, 1],
    ],
  })
  try {
    await f.split(100, 'finished')
    f.convert.loseAnswer = true
    await assert.rejects(f.split(100, 'lost-answer'), /CTF consolidation mint result is uncertain/)
    f.convert.loseAnswer = false
    // The mint spent the input of the lost answer, so recovery restores its saved outputs.
    f.control.state = CheckStateEnum.SPENT
    const finished = completeSetConvertOperationId('finished')
    await withDaemonStateSqliteTransaction(f.directory, (database) => {
      database.exec('PRAGMA ignore_check_constraints = ON')
      try {
        const changed = database
          .prepare(
            `UPDATE custody_operations SET result_state = 'corrupt'
             WHERE retained_operation_key = ?`,
          )
          .run(finished).changes
        assert.equal(changed, 1)
      } finally {
        database.exec('PRAGMA ignore_check_constraints = OFF')
      }
    })
    assert.deepEqual(await recoverPreparedWalletSends(f.deps), {
      recovered: [completeSetConvertOperationId('lost-answer')],
      pending: [{ operationId: finished, error: 'custody operation result state is invalid' }],
    })
    assert.equal(f.convert.requests.length, 2)
  } finally {
    await f.close()
  }
})

test('recovery from a stale prepared read does not bring back a split output that a later send spent', async () => {
  const f = await fixture()
  try {
    f.convert.loseAnswer = true
    await assert.rejects(f.split(), /CTF consolidation mint result is uncertain/)
    f.convert.loseAnswer = false
    // A recovery pass reads the prepared operation, and then the split finishes first.
    const stale = await getProofOperation(completeSetConvertOperationId('split-root'))
    assert.equal(stale?.state, 'prepared')
    f.control.state = CheckStateEnum.SPENT
    await f.split()
    f.control.state = CheckStateEnum.UNSPENT
    // The change is the only regular fund, so the send spends it.
    await f.send(20, 'spend-change')
    const balance = await readDaemonWalletBalance(f.directory)
    const facts = await custodyFacts(f.directory)
    // The recovery pass continues with the operation that it read before.
    await resumeCtfConsolidationOperation(stale!, f.deps)
    assert.equal(f.convert.requests.length, 1)
    assert.deepEqual(await custodyFacts(f.directory), facts)
    assert.deepEqual(await readDaemonWalletBalance(f.directory), balance)
  } finally {
    await f.close()
  }
})

test('a split refuses before any effect', async () => {
  const f = await fixture()
  try {
    const before = await custodyFacts(f.directory)
    // One 128 msat proof cannot pay 200 msat and its 1 msat input fee.
    const short = await f.dispatchSplit(200, 'short')
    assert.equal(short.ok, false)
    assert.equal(short.code, 'insufficient-funds')
    assert.deepEqual(short.result, { requiredMsat: 201, availableMsat: 128 })
    f.convert.mintAttestation = { status: 'attested', winning_outcome: 'A' }
    assert.deepEqual(await f.dispatchSplit(50, 'resolved'), {
      ok: false,
      code: 'market-not-pending',
      error: `market ${f.conditionId} is not pending`,
    })
    f.convert.mintAttestation = undefined
    const missing = await f.dispatchSplit(50, 'missing', {
      ...f.deps,
      fetchConsolidationCondition: async () => new Response('', { status: 404 }),
    })
    assert.equal(missing.code, 'market-not-found')
    assert.equal(f.convert.requests.length, 0)
    assert.deepEqual(await custodyFacts(f.directory), before)
  } finally {
    await f.close()
  }
})

test('a split that only funds outside custody could pay refuses before any effect', async () => {
  const f = await fixture()
  try {
    // A released split left this change only in the wallet table.
    await addAvailableProofs(MINT, [f.mintProof(64, 'released-change')], SATS)
    const before = await custodyFacts(f.directory)
    const refused = await f.dispatchSplit(150, 'needs-repair')
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'custody-repair-required')
    assert.equal(f.convert.requests.length, 0)
    assert.deepEqual(await custodyFacts(f.directory), before)
  } finally {
    await f.close()
  }
})

test('a split rolls back a fault before its commit and then succeeds', async () => {
  const f = await fixture()
  try {
    const before = await custodyFacts(f.directory)
    let faults = 0
    await assert.rejects(
      f.split(100, 'split-root', {
        ...f.deps,
        injectCustodyFault: (phase) => {
          if (phase === 'before-commit' && faults++ === 0)
            throw new Error('controlled preparation fault')
        },
      }),
      /controlled preparation fault/,
    )
    assert.deepEqual(await custodyFacts(f.directory), before)
    assert.equal(f.convert.requests.length, 0)
    await f.split()
    assert.equal(f.convert.requests.length, 1)
  } finally {
    await f.close()
  }
})

test('a split that the mint refuses for an attested condition releases its input for a new split', async () => {
  const f = await fixture()
  try {
    const before = await custodyFacts(f.directory)
    f.convert.refuse = 13042
    assert.deepEqual(await f.dispatchSplit(100, 'refused-root'), {
      ok: false,
      code: 'market-not-pending',
      error: `market ${f.conditionId} is not pending`,
    })
    f.convert.refuse = null
    const released = await custodyFacts(f.directory)
    assert.deepEqual(released.wallet, before.wallet)
    assert.equal(released.walletOnly, 0)
    assert.ok(released.operations.includes('ctf-consolidation/failed'))
    const retry = await f.dispatchSplit(100, 'refused-root')
    assert.equal(retry.ok, false)
    assert.match(String(retry.error), /new operation id/)
    // The released input pays a new split.
    assert.equal((await f.dispatchSplit(100, 'new-root')).ok, true)
    assert.equal(f.convert.requests.length, 2)
  } finally {
    await f.close()
  }
})

test('a split that one convert cannot hold refuses with its own code before any effect', async () => {
  const f = await fixture()
  try {
    const before = await custodyFacts(f.directory)
    const feeFree = await f.dispatchSplit(50, 'fee-free', {
      ...f.deps,
      resolveInputFeePpkByKeyset: async (_mint, ids) =>
        Object.fromEntries(ids.map((id) => [id, 0])),
    })
    assert.equal(feeFree.ok, false)
    assert.equal(feeFree.code, 'split-input-fee-zero')
    assert.equal(f.convert.requests.length, 0)
    assert.deepEqual(await custodyFacts(f.directory), before)
  } finally {
    await f.close()
  }
})

test('a split that needs more than 256 inputs refuses with its own code before any effect', async () => {
  // Two receives give 260 custody proofs of 16384 msat, after the 1 msat receive fee of each.
  const f = await fixture({
    tokens: [
      [...Array.from({ length: 200 }, () => 16_384), 1],
      [...Array.from({ length: 60 }, () => 16_384), 1],
    ],
  })
  try {
    const before = await custodyFacts(f.directory)
    // 256 inputs pay 4194304 msat less the 1 msat fee, so this amount needs a 257th input.
    const refused = await f.dispatchSplit(256 * 16_384, 'too-many-inputs')
    assert.equal(refused.ok, false)
    if (refused.ok) throw new Error('the split must refuse')
    assert.equal(refused.code, 'split-input-limit')
    // The command to consolidate proofs is removed, so the refusal does not name it.
    assert.doesNotMatch(refused.error, /consolidat/)
    assert.equal(f.convert.requests.length, 0)
    assert.deepEqual(await custodyFacts(f.directory), before)
  } finally {
    await f.close()
  }
})

test('a split whose partition has more groups than one convert holds refuses with its own code', async () => {
  const f = await fixture()
  try {
    const before = await custodyFacts(f.directory)
    // A valid market has at most eight outcomes, so only a foreign mint partition is this wide.
    const wide = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [`O${index}`, `wide-keyset-${index}`]),
    )
    const refused = await f.dispatchSplit(50, 'too-many-groups', {
      ...f.deps,
      resolveMintKeysByKeyset: async (_mint, ids) =>
        Object.fromEntries(
          ids.map((id) => [id, { id, unit: 'msat', input_fee_ppk: 1, keys: KEYS } as MintKeys]),
        ),
      createCtfSplitTransport: () => ({
        getKeys: async () => {
          throw new Error('a refused split reads no keys')
        },
        getRootPartitionKeysets: async () => ({ ...wide }),
        postSplit: async () => {
          throw new Error('a refused split posts nothing')
        },
      }),
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'split-group-limit')
    assert.equal(f.convert.requests.length, 0)
    assert.deepEqual(await custodyFacts(f.directory), before)
  } finally {
    await f.close()
  }
})

test('a split that needs more than 256 outputs refuses with its own code before any effect', async () => {
  // Twenty 16384 msat proofs arrive after the 1 msat receive fee.
  const f = await fixture({
    tokens: [[...Array.from({ length: 20 }, () => 16_384), 1]],
    outcomes: Array.from({ length: 8 }, (_, index) => `O${index}`),
  })
  try {
    const before = await custodyFacts(f.directory)
    // The twenty inputs pay 327679 msat and the 1 msat fee with no change. 327679 msat is
    // nineteen 16384 msat outputs and fourteen smaller outputs: 33 for each of 8 outcomes.
    const refused = await f.dispatchSplit(327_679, 'too-many-outputs')
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'split-output-limit')
    assert.equal(f.convert.requests.length, 0)
    assert.deepEqual(await custodyFacts(f.directory), before)
  } finally {
    await f.close()
  }
})
