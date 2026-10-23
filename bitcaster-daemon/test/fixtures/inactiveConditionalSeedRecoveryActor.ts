import { requireValidCashuProofs } from '../../../bitcaster-client-sdk/src/cashuProofAdmission.ts'
// This parent E2E actor uses real clients. It prints only fixed, public summaries.
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  Amount,
  Mint,
  Wallet,
  CTSError,
  HttpResponseError,
  MintOperationError,
  NetworkError,
  createEphemeralCounterSource,
  type Proof,
} from '@cashu/cashu-ts'
import {
  CashuMintCtfSplitTransport,
  computeGrossCtfInputAmountSubunits,
  resolveInputFeePpkByProofKeyset,
  splitCompleteSet,
} from '../../../bitcaster-client-sdk/src/ctfSplit.ts'
import {
  computeInputFeeSubunitsForProofs,
  sumProofs,
} from '../../../bitcaster-client-sdk/src/proofSelection.ts'
import { reserveAndConstructDurableSeedDerivedOutputs } from '../../../bitcaster-client-sdk/src/durableSeedDerivedOutputs.ts'
import {
  buildKeysetRedeemOperationId,
  prepareDurableCtfRedeemOperation,
  executePreparedDurableCtfRedeem,
} from '../../../bitcaster-client-sdk/src/ctfRedeem.ts'
import {
  deserializeDurableCustodyProofArtifact,
  serializeDurableCustodyProofArtifact,
} from '../../../bitcaster-client-sdk/src/durableCustodyProofMaterial.ts'
import { createConditionOracleEvidenceResolver } from '../../../bitcaster-client-sdk/src/conditionOracleEvidence.ts'
import {
  deriveDurableCustodyProofId,
  deriveDurableCustodyScopeId,
} from '../../../bitcaster-client-sdk/src/durableCustody.ts'
import { configureDataDir } from '../../src/dataDir.ts'
import { openDaemonStateSqlite } from '../../src/stateSqlite.ts'
import { readAvailableWalletProofPage } from '../../src/state.ts'
import { readDaemonWalletBalance } from '../../src/walletBalance.ts'

const [mode, mintUrl, inputDirectory, home] = process.argv.slice(2)
const repo = resolve(import.meta.dirname, '../../..')
const amountMsat = 8_192
const recoveryId = 'd6-inactive-conditional-recovery'
const seedFile = join(inputDirectory, 'wallet-seed.hex')
type ActorStage =
  | 'input'
  | 'issuance'
  | 'load-mint'
  | 'mint-capability'
  | 'mint-quote'
  | 'mint-payment'
  | 'mint-collateral'
  | 'regular-control'
  | 'target-pagination'
  | 'deterministic-outputs'
  | 'split'
  | 'split-outputs'
  | 'split-submit'
  | 'issued-spentness'
  | 'issued-artifact'
  | 'listing'
  | 'fresh-profile'
  | 'recovery'
  | 'recovery-active-limit'
  | 'recovery-cli'
  | 'recovery-summary'
  | 'observations'
  | 'exact-authority'
  | 'repeat'
  | 'restart'
  | 'payout'
let stage: ActorStage = 'input'
interface Metadata {
  foreign: { condition_id: string; keysets: Record<string, string> }
  target: {
    condition_id: string
    keysets: Record<string, string>
    complement_collections: Record<string, string>
    split_keysets: Record<string, string>
    funded_collection: string
    winning_outcome: string
    fixture_oracle_registration: {
      eventId: string
      outcomes: string[]
      threshold: number
      oracles: { oraclePublicKey: string; noncePoint: string; announcement: string }[]
    }
  }
  witness: { oracle_sigs: unknown[] }
  witnesses: Record<string, { oracle_sigs: unknown[] }>
}
interface Observation {
  route: string
  cursor_present?: boolean
  limit_100?: boolean
  condition_id?: string
  no_active_or_unit_filter?: boolean
  count: number
  ids?: string[]
  has_next?: boolean
  keyset_counts?: Record<string, number>
}

async function jsonFetch(path: string): Promise<any> {
  const response = await fetch(`${mintUrl}${path}`, { signal: AbortSignal.timeout(10_000) })
  assert.equal(response.ok, true, 'fixture HTTP request must succeed')
  return response.json()
}

// Private outputs and errors stay in memory. A command failure exposes a fixed label.
async function command(script: string, args: string[], timeout = 45_000): Promise<any> {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', join(repo, script), '--datadir', home, ...args],
    {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    },
  )
  let output = ''
  let bytes = 0
  child.stdout!.on('data', (data: Buffer) => {
    bytes += data.length
    if (bytes > 2 * 1024 * 1024) child.kill('SIGKILL')
    else output += data.toString()
  })
  child.stderr!.on('data', () => {})
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
  try {
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', () => reject(new Error('fixture command could not start')))
      child.once('close', resolveExit)
    })
    assert.equal(
      code === 0,
      true,
      `fixture ${script.includes('cli') ? 'CLI' : 'daemon'} command must succeed`,
    )
    if (script === 'bitcaster-daemon/src/main.ts' && args[0] === 'init') return null
    return output.trim() ? JSON.parse(output) : null
  } finally {
    clearTimeout(timer)
  }
}
const cli = (args: string[], timeout?: number) =>
  command('bitcaster-cli/src/main.ts', args, timeout)

async function issue(metadata: Metadata): Promise<void> {
  stage = 'load-mint'
  const mint = new Mint(mintUrl)
  const wallet = new Wallet(mint, { unit: 'msat' })
  await wallet.loadMint()
  stage = 'mint-capability'
  assert.equal(
    wallet.getMintInfo().supportsMintMeltMethod('mint', 'bolt11', 'msat'),
    true,
    'fixture mint must advertise actual bolt11 msat capability',
  )
  stage = 'target-pagination'
  const conditionQuery = `condition_id=${metadata.target.condition_id}`
  const firstTargetPage = await jsonFetch(`/v1/conditional_keysets?limit=100&${conditionQuery}`)
  assert.equal(firstTargetPage.keysets.length, 100)
  assert.equal(typeof firstTargetPage.next_cursor, 'string')
  const secondTargetPage = await jsonFetch(
    `/v1/conditional_keysets?limit=100&${conditionQuery}&cursor=${encodeURIComponent(firstTargetPage.next_cursor)}`,
  )
  assert.equal(secondTargetPage.keysets.length, 2)
  assert.equal(secondTargetPage.next_cursor, null)
  assert.equal(
    [...firstTargetPage.keysets, ...secondTargetPage.keysets].every(
      (row: any) =>
        row.condition_id === metadata.target.condition_id &&
        row.unit === 'msat' &&
        row.active === true &&
        Object.values(metadata.target.keysets).includes(row.id),
    ),
    true,
    'registration pages must contain only the 102 authentic target descriptors',
  )
  const laterPageRow = secondTargetPage.keysets[0]
  assert.equal(
    laterPageRow.condition_id === metadata.target.condition_id &&
      laterPageRow.unit === 'msat' &&
      laterPageRow.active === true,
    true,
    'funded descriptor must come from this condition’s actual later page',
  )
  const fundedCollection = laterPageRow.outcome_collection as string
  const complement = metadata.target.complement_collections[fundedCollection]
  const fundedKeysetId = metadata.target.keysets[fundedCollection]
  const complementKeysetId = metadata.target.keysets[complement]
  assert.equal(
    fundedKeysetId === laterPageRow.id &&
      typeof complement === 'string' &&
      typeof complementKeysetId === 'string' &&
      complement !== fundedCollection,
    true,
    'funded later-page collection must have its actual registered complement',
  )
  metadata.target.split_keysets = {
    [fundedCollection]: fundedKeysetId,
    [complement]: complementKeysetId,
  }
  metadata.target.funded_collection = fundedCollection
  metadata.target.winning_outcome = fundedCollection.split('|')[0]!
  metadata.witness = metadata.witnesses[metadata.target.winning_outcome]!
  await writeFile(join(inputDirectory, 'public.json'), JSON.stringify(metadata))
  const regular = wallet.keyChain.getKeyset().toMintKeys()!
  assert.equal(regular.input_fee_ppk, 1, 'authentic regular keyset must carry the fixture fee')
  const grossCollateralMsat = computeGrossCtfInputAmountSubunits({
    faceAmountSubunits: amountMsat,
    keyset: { ...regular, input_fee_ppk: regular.input_fee_ppk! },
  })
  stage = 'mint-quote'
  const quote = await wallet.createMintQuote(grossCollateralMsat)
  stage = 'mint-payment'
  await waitForMintQuote(wallet, quote.quote)
  stage = 'mint-collateral'
  const collateral = await wallet.mintProofs(grossCollateralMsat, quote.quote)
  const collateralFee = computeInputFeeSubunitsForProofs(
    collateral,
    await resolveInputFeePpkByProofKeyset(mint, collateral),
  )
  assert.equal(
    collateralFee === 1 &&
      sumProofs(collateral) === grossCollateralMsat &&
      grossCollateralMsat === amountMsat + collateralFee,
    true,
    'authentic collateral and positive fee must preserve exact outcome value',
  )
  stage = 'regular-control'
  const seed = Buffer.from((await readFile(seedFile, 'utf8')).trim(), 'hex')
  const regularControlKeyset = wallet.keyChain.getKeyset().toMintKeys()!
  const controlCounterSource = createEphemeralCounterSource({ [regularControlKeyset.id]: 3 })
  const controlWallet = new Wallet(mint, {
    unit: 'msat',
    bip39seed: seed,
    counterSource: controlCounterSource,
  })
  await controlWallet.loadMint()
  assert.equal(
    controlWallet.keyChain.getKeyset().id,
    regularControlKeyset.id,
    'regular control must use the same active msat keyset as the target wallet',
  )
  const controlQuote = await controlWallet.createMintQuote(1)
  await waitForMintQuote(controlWallet, controlQuote.quote)
  const controlProofs = await controlWallet.mintProofs(1, controlQuote.quote)
  assert.equal(controlProofs.length, 1, 'mint must issue one real regular negative-control proof')
  const regularControlProof = controlProofs[0]!
  assert.equal(regularControlProof.id, regularControlKeyset.id)
  assert.equal(
    (await controlWallet.counters.snapshot())[regularControlKeyset.id],
    4,
    'regular control proof must consume exactly deterministic counter three',
  )
  requireValidCashuProofs([regularControlProof], (id) => controlWallet.keyChain.getKeyset(id))
  await assertUnspent(controlWallet, [regularControlProof])
  await writeFile(
    join(inputDirectory, 'regular-control-proof.json'),
    JSON.stringify(serializeDurableCustodyProofArtifact(regularControlProof)),
    { mode: 0o600, flag: 'wx' },
  )
  stage = 'deterministic-outputs'
  const prepared = new Map<
    string,
    Awaited<ReturnType<typeof reserveAndConstructDurableSeedDerivedOutputs>>
  >()
  const counterSource = createEphemeralCounterSource()
  for (const [collection, id] of Object.entries(metadata.target.split_keysets)) {
    const keyset = (await mint.getKeys(id)).keysets.find((row) => row.id === id)
    assert.equal(keyset !== undefined, true, 'authentic target keys must exist')
    const planned = await reserveAndConstructDurableSeedDerivedOutputs({
      seed,
      counterSource,
      keyset: keyset!,
      amounts: [amountMsat / 2, amountMsat / 2],
    })
    assert.equal(
      planned.plan.counterStart + planned.plan.counterCount < 300,
      true,
      'issued counters must fit discovery prefix',
    )
    prepared.set(collection, planned)
  }
  stage = 'split'
  const proofs = await splitCompleteSet(
    new CashuMintCtfSplitTransport(mintUrl),
    metadata.target.condition_id,
    collateral,
    metadata.target.split_keysets,
    amountMsat,
    {
      baseAsset: 'sat',
      makeOutputs: ({ collection }) => {
        stage = 'split-outputs'
        return [...prepared.get(collection)!.outputData]
      },
      onPrepared: async () => {
        stage = 'split-submit'
      },
    },
  )
  assert.deepEqual(
    Object.keys(proofs).sort(),
    Object.keys(metadata.target.split_keysets).sort(),
    'actual split must issue the observed later-page collection and its exact complement',
  )
  const issuedProofs = Object.values(proofs).flat()
  assert.equal(issuedProofs.length, 4, 'the two funded groups must issue four real proofs')
  type ConditionalMintKey = Awaited<ReturnType<typeof mint.getKeys>>['keysets'][number]
  const conditionalKeysets: Record<string, ConditionalMintKey> = {}
  for (const id of new Set(issuedProofs.map((proof) => proof.id))) {
    const keyset = (await mint.getKeys(id)).keysets.find((row) => row.id === id)
    assert.equal(
      keyset?.unit === 'msat' && keyset.input_fee_ppk === 1,
      true,
      'each issued proof must resolve to its authentic conditional keyset authority',
    )
    conditionalKeysets[id] = keyset!
  }
  requireValidCashuProofs(issuedProofs, (id) => conditionalKeysets[id]!)
  stage = 'issued-spentness'
  await assertUnspent(wallet, issuedProofs)
  stage = 'issued-artifact'
  await writeFile(
    join(inputDirectory, 'expected-proofs.json'),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(proofs).map(([outcome, rows]) => [
          outcome,
          rows.map(serializeDurableCustodyProofArtifact),
        ]),
      ),
    ),
    { mode: 0o600, flag: 'wx' },
  )
  process.stdout.write(
    `${JSON.stringify({ issued: true, targetProofCount: Object.values(proofs).flat().length })}\n`,
  )
}

async function assertUnspent(wallet: Wallet, proofs: Proof[]): Promise<void> {
  const states = await wallet.checkProofsStates(proofs)
  assert.equal(
    states.length === proofs.length && states.every((row) => row.state === 'UNSPENT'),
    true,
    'exact original proofs must remain unspent',
  )
}

async function waitForMintQuote(wallet: Wallet, quoteId: string): Promise<void> {
  // The owned FakeWallet pays local quotes asynchronously and exposes no completion signal.
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const state = await wallet.checkMintQuote(quoteId)
    if (state.state === 'PAID') return
    await new Promise((resolvePayment) => setTimeout(resolvePayment, 100))
  }
  assert.fail('fixture mint quote payment deadline exceeded')
}

function sameProof(left: Proof, right: Proof): boolean {
  return (
    left.id === right.id &&
    left.secret === right.secret &&
    left.C === right.C &&
    Amount.from(left.amount).equals(right.amount) &&
    isDeepStrictEqual(left.dleq, right.dleq) &&
    isDeepStrictEqual(left.witness, right.witness) &&
    left.p2pk_e === right.p2pk_e
  )
}

async function recoveredProofs(
  metadata: Metadata,
  expected: Record<string, Proof[]>,
): Promise<Record<string, Proof[]>> {
  const result: Record<string, Proof[]> = {}
  for (const [outcomeSetId, expectedProofs] of Object.entries(expected)) {
    const targetKeysetId = metadata.target.keysets[outcomeSetId]
    assert.equal(typeof targetKeysetId, 'string', 'funded collection must be registered')
    const page = await readAvailableWalletProofPage({
      mintUrl,
      keysetId: targetKeysetId,
      asset: {
        kind: 'Outcome',
        baseAsset: 'sat',
        unit: 'msat',
        conditionId: metadata.target.condition_id,
        outcomeSetId,
      },
      limit: 16,
    })
    assert.equal(page.nextCursor === null, true, 'bounded native proof page must terminate')
    const proofs: Proof[] = page.proofs.map((row) => {
      const proof = row.proof
      assert.equal(
        typeof proof.id === 'string' && typeof proof.C === 'string',
        true,
        'native proof material must have exact identity and signature',
      )
      return deserializeDurableCustodyProofArtifact({
        schemaVersion: 1,
        id: proof.id,
        C: proof.C,
        secret: proof.secret,
        amount: String(proof.amount),
        dleq: proof.dleq ?? null,
        p2pkE: proof.p2pk_e ?? null,
        witness: proof.witness ?? null,
      })
    })
    assert.equal(
      proofs.length === expectedProofs.length &&
        proofs.every((proof) => expectedProofs.some((original) => sameProof(proof, original))) &&
        expectedProofs.every((original) => proofs.some((proof) => sameProof(proof, original))),
      true,
      'native recovered proof identity and material must equal authentic issuance',
    )
    result[outcomeSetId] = proofs
  }
  const balance = await readDaemonWalletBalance(home)
  assert.equal(
    balance.outcomePositions.length,
    Object.keys(expected).length,
    'native balance must contain only the two funded target collections',
  )
  for (const position of balance.outcomePositions) {
    assert.equal(
      position.conditionId === metadata.target.condition_id &&
        position.mintUrl === mintUrl &&
        Object.hasOwn(expected, position.outcomeSetId),
      true,
      'balance must retain exact outcome authority',
    )
    assert.equal(position.availableSats, amountMsat / 1_000)
    assert.equal(position.reservedSats, 0)
    assert.equal(position.lockedSats, 0)
  }
  return result
}

async function authoritySnapshot(): Promise<string> {
  const database = await openDaemonStateSqlite(home)
  try {
    const tables = [
      'target_wallet_proofs',
      'custody_proofs',
      'target_keyset_counters',
      'custody_keyset_counters',
      'daemon_managed_condition_inventory',
      'seed_recovery_keysets',
    ]
    return JSON.stringify(
      tables.map((table) => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    )
  } finally {
    database.close()
  }
}

async function assertProofNotImported(proof: Proof): Promise<void> {
  const database = await openDaemonStateSqlite(home)
  try {
    const scopeRows = database
      .prepare("SELECT scope_id AS scopeId FROM custody_scopes WHERE scope_kind = 'wallet'")
      .all() as Array<{ scopeId: string }>
    assert.equal(scopeRows.length, 1, 'control proof check requires one wallet custody scope')
    const proofId = deriveDurableCustodyProofId({
      scopeId: scopeRows[0]!.scopeId,
      normalizedMint: mintUrl,
      unit: 'msat',
      keysetId: proof.id,
      secret: proof.secret,
    })
    const row = database
      .prepare('SELECT count(*) AS count FROM custody_proofs WHERE proof_id = ?')
      .get(proofId) as { count: number }
    assert.equal(row.count, 0, 'condition-scoped recovery must not import regular proof control')
  } finally {
    database.close()
  }
}

async function assertFreshProfile(): Promise<void> {
  const database = await openDaemonStateSqlite(home)
  try {
    for (const table of [
      'target_wallet_proofs',
      'custody_proofs',
      'target_keyset_counters',
      'custody_keyset_counters',
      'daemon_managed_condition_inventory',
      'seed_recovery_keysets',
      'seed_recovery_jobs',
    ]) {
      const count = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count
      assert.equal(count, 0, `fresh native ${table} must be empty`)
    }
  } finally {
    database.close()
  }
}

async function startDaemon(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      join(repo, 'bitcaster-daemon/src/main.ts'),
      '--datadir',
      home,
      'run',
    ],
    {
      cwd: repo,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    },
  )
  let spawnFailed = false
  child.once('error', () => {
    spawnFailed = true
  })
  const deadline = Date.now() + 25_000
  try {
    while (Date.now() < deadline) {
      assert.equal(!spawnFailed && child.exitCode === null, true, 'owned daemon must remain alive')
      try {
        await access(join(home, 'daemon.sock'))
        const health = await cli(['health'], 3_000)
        if (health.ok === true) return child
      } catch {
        /* Startup has a fixed deadline. */
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error('owned daemon startup deadline exceeded')
  } catch (error) {
    await stopDaemon(child)
    throw error
  }
}

async function stopDaemon(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  const stopped = new Promise<void>((r) => child.once('exit', () => r()))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  try {
    await stopped
  } finally {
    clearTimeout(timer)
  }
}

async function recover(metadata: Metadata): Promise<void> {
  configureDataDir(home)
  const artifacts = JSON.parse(
    await readFile(join(inputDirectory, 'expected-proofs.json'), 'utf8'),
  ) as Record<string, unknown[]>
  const expected = Object.fromEntries(
    Object.entries(artifacts).map(([outcome, rows]) => [
      outcome,
      rows.map(deserializeDurableCustodyProofArtifact),
    ]),
  )
  assert.deepEqual(
    Object.keys(expected).sort(),
    Object.keys(metadata.target.split_keysets).sort(),
    'only the two actual split output collections may have expected proofs',
  )
  const regularControl = deserializeDurableCustodyProofArtifact(
    JSON.parse(await readFile(join(inputDirectory, 'regular-control-proof.json'), 'utf8')),
  )
  assert.equal(Object.keys(metadata.target.keysets).length, 102)
  assert.equal(Object.keys(metadata.target.split_keysets).length, 2)
  const registeredOutcomes = metadata.target.fixture_oracle_registration.outcomes
  const fundedCollections = Object.keys(metadata.target.split_keysets)
  const fundedOutcomeSets = fundedCollections.map((collection) => collection.split('|'))
  assert.equal(
    fundedOutcomeSets[0]!.every((outcome) => !fundedOutcomeSets[1]!.includes(outcome)) &&
      [...fundedOutcomeSets[0]!, ...fundedOutcomeSets[1]!].sort().join('\0') ===
        [...registeredOutcomes].sort().join('\0'),
    true,
    'funded collections must form an exact complementary partition of the registered outcomes',
  )
  assert.equal(
    fundedCollections.includes(metadata.target.funded_collection),
    true,
    'winning collection must be one of the funded complementary groups',
  )
  assert.equal(
    fundedOutcomeSets.find((outcomes) => outcomes.includes(metadata.target.winning_outcome)) !==
      undefined,
    true,
    'chosen winning outcome must belong to a funded collection',
  )
  assert.equal(
    Object.values(metadata.target.keysets).includes(regularControl.id),
    false,
    'regular negative-control keyset must be distinct from target conditional keysets',
  )
  const mint = new Mint(mintUrl)
  const wallet = new Wallet(mint, { unit: 'msat' })
  await wallet.loadMint()
  await assertUnspent(wallet, Object.values(expected).flat())
  await assertUnspent(wallet, [regularControl])
  stage = 'listing'
  const conditionQuery = `condition_id=${metadata.target.condition_id}`
  const first = await jsonFetch(`/v1/conditional_keysets?limit=100&${conditionQuery}`)
  assert.equal(first.keysets.length, 100)
  assert.equal(
    first.keysets.every(
      (row: any) =>
        row.unit === 'msat' &&
        row.active === false &&
        row.condition_id === metadata.target.condition_id &&
        Object.values(metadata.target.keysets).includes(row.id),
    ),
    true,
    'first scoped page must contain only real target-condition rows',
  )
  assert.equal(typeof first.next_cursor, 'string')
  const second = await jsonFetch(
    `/v1/conditional_keysets?limit=100&${conditionQuery}&cursor=${encodeURIComponent(first.next_cursor)}`,
  )
  assert.equal(second.keysets.length, 2)
  assert.equal(second.next_cursor, null)
  assert.equal(
    second.keysets.every(
      (row: any) =>
        row.unit === 'msat' &&
        row.active === false &&
        row.condition_id === metadata.target.condition_id &&
        Object.values(metadata.target.keysets).includes(row.id),
    ),
    true,
    'later scoped page must contain exactly two inactive target rows',
  )
  assert.equal(
    second.keysets.some((row: any) =>
      Object.values(metadata.target.split_keysets).includes(row.id),
    ),
    true,
    'at least one actually funded keyset must be observed on the later page',
  )
  stage = 'fresh-profile'
  await cli(['config', 'set', '--engine-url', 'http://127.0.0.1:1', '--mint-url', mintUrl])
  await command('bitcaster-daemon/src/main.ts', [
    'init',
    '--wallet-seed-hex-file',
    seedFile,
    '--nostr-secret-key-hex-file',
    join(inputDirectory, 'nostr-secret-key.hex'),
  ])
  await assertFreshProfile()
  const signer = await cli(['signer', 'show'])
  await cli(['signer', 'disconnect', '--expected-revision', String(signer.revision)])
  const reset = await fetch(`${mintUrl}/fixture/reset`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(reset.status, 204)
  let summary: any
  let invocations = 0
  const recoveryStartedAt = Date.now()
  const deadline = Date.now() + 150_000
  // The daemon processes at most four keyset batches per invocation. This
  // fixture has 102 selected keys; the two funded keys may each need one
  // additional batch after their signature-bearing range.
  const maximumInvocations = Math.ceil(
    (Object.keys(metadata.target.keysets).length +
      Object.keys(metadata.target.split_keysets).length) /
      4,
  )
  const args = [
    'wallet',
    'recover-seed',
    '--wallet-seed-hex-file',
    seedFile,
    '--recovery-id',
    recoveryId,
    '--mint',
    mintUrl,
    '--unit',
    'msat',
    '--acknowledge-seed-disclosure',
    '--condition-id',
    metadata.target.condition_id,
    '--gap-limit',
    '4',
  ]
  stage = 'recovery'
  do {
    stage = 'recovery-active-limit'
    assert.equal(
      ++invocations <= maximumInvocations && Date.now() < deadline,
      true,
      'offline recovery must finish within invocation and time bounds',
    )
    stage = 'recovery-cli'
    summary = await cli(args, Math.min(60_000, deadline - Date.now()))
    stage = 'recovery-summary'
  } while (summary.state === 'active')
  const recoveryElapsedMs = Date.now() - recoveryStartedAt
  assert.equal(summary.state, 'completed')
  assert.equal(
    summary.selectedKeysetCount,
    102,
    'only the selected condition’s 102 keysets must be selected',
  )
  stage = 'observations'
  const observations = (await jsonFetch('/fixture/observations')) as Observation[]
  const pages = observations.filter((row) => row.route === 'conditional-list')
  assert.equal(
    pages.length,
    invocations * 2,
    'each bounded recovery invocation must validate both scoped pages',
  )
  for (let offset = 0; offset < pages.length; offset += 2) {
    const firstPage = pages[offset]!
    const secondPage = pages[offset + 1]!
    assert.equal(firstPage.cursor_present, false)
    assert.equal(firstPage.count, 100)
    assert.equal(firstPage.has_next, true)
    assert.equal(secondPage.cursor_present, true)
    assert.equal(secondPage.count, 2)
    assert.equal(secondPage.has_next, false)
  }
  assert.equal(
    pages.every(
      (row) =>
        row.limit_100 &&
        row.no_active_or_unit_filter &&
        row.condition_id === metadata.target.condition_id,
    ),
    true,
    'actual recovery must use the exact same condition on both limit-100 pages',
  )
  const listedIds = new Set(pages.flatMap((row) => row.ids ?? []))
  const target = new Set(Object.values(metadata.target.keysets))
  assert.equal(
    listedIds.size === 102 && [...target].every((id) => listedIds.has(id)),
    true,
    'scoped pages must contain every target keyset and no foreign keyset',
  )
  assert.equal(
    observations.some((row) => row.route === 'regular-list'),
    false,
    'condition-scoped recovery must not list regular keysets',
  )
  const restores = observations.filter((row) => row.route === 'restore')
  const foreign = new Set(Object.values(metadata.foreign.keysets))
  assert.equal(
    restores.every((row) =>
      Object.keys(row.keyset_counts!).every((id) => !foreign.has(id) && target.has(id)),
    ),
    true,
    'only selected-condition keys may receive recovery seed probes',
  )
  const fundedKeysets = new Set(Object.values(metadata.target.split_keysets))
  const expectedProbeCounts = Object.values(metadata.target.keysets).map((id) =>
    fundedKeysets.has(id) ? 2 + 4 : 4,
  )
  assert.equal(
    restores.reduce((total, row) => total + row.count, 0) ===
      expectedProbeCounts.reduce((total, count) => total + count, 0),
    true,
    'recovery must probe two real signed counters plus four gaps for funded keys and four gaps for empty keys',
  )
  for (const id of Object.values(metadata.target.keysets)) {
    assert.equal(
      restores.reduce((count, row) => count + (row.keyset_counts![id] ?? 0), 0),
      fundedKeysets.has(id) ? 6 : 4,
      'funded inactive keysets receive two signed-counter probes and four gaps; empty keys receive four gaps',
    )
  }
  assert.equal(
    restores.reduce((count, row) => count + (row.keyset_counts![regularControl.id] ?? 0), 0),
    0,
    'the real regular proof negative-control keyset must receive no restore probes',
  )
  await assertProofNotImported(regularControl)
  stage = 'exact-authority'
  await recoveredProofs(metadata, expected)
  await assertProofNotImported(regularControl)
  const before = await authoritySnapshot()
  stage = 'repeat'
  const repeated = await cli(args, 60_000)
  assert.equal(repeated.state, 'completed')
  assert.equal(
    (await authoritySnapshot()) === before,
    true,
    'repeat recovery must not change proof, counter, condition, or roster authority',
  )
  await assertProofNotImported(regularControl)
  let daemon: ChildProcess | undefined
  try {
    stage = 'restart'
    daemon = await startDaemon()
    const balance = await cli(['wallet', 'balance'])
    assert.equal(balance.ok, true)
    await stopDaemon(daemon)
    daemon = undefined
    const afterRestart = await recoveredProofs(metadata, expected)
    assert.equal(
      (await authoritySnapshot()) === before,
      true,
      'daemon restart must preserve exact recovered authority',
    )
    await assertProofNotImported(regularControl)
    stage = 'payout'
    const winner = afterRestart[metadata.target.funded_collection]
    const regular = wallet.keyChain.getKeyset().toMintKeys()!
    assert.equal(
      regular.unit === 'msat' && regular.active !== false,
      true,
      'redemption outputs require active regular msat keys',
    )
    const intended = metadata.target.fixture_oracle_registration
    const registeredAuthority = {
      eventId: intended.eventId,
      outcomes: intended.outcomes,
      threshold: intended.threshold,
      oracles: intended.oracles.map(({ oraclePublicKey, noncePoint, announcement }) => ({
        oraclePublicKey,
        noncePoint,
        announcementIdentity: bytesToHex(sha256(hexToBytes(announcement))),
      })),
    }
    const resolution = await createConditionOracleEvidenceResolver({
      maxEntries: 1,
    }).resolveFromMint({
      binding: {
        scopeId: deriveDurableCustodyScopeId({
          scopeKind: 'condition-inventory',
          inventoryAccountId: recoveryId,
          normalizedMint: mintUrl,
          unit: 'msat',
          conditionId: metadata.target.condition_id,
        }),
        normalizedMint: mintUrl,
        unit: 'msat',
        conditionId: metadata.target.condition_id,
        canonicalParentCollectionId: null,
      },
      fetchRegisteredAuthority: async () => registeredAuthority,
      fetchInitialAttestation: async () => ({
        conditionId: metadata.target.condition_id,
        attestedOutcome: metadata.target.winning_outcome,
        registeredAuthority,
        oracleWitness: metadata.witness,
      }),
      fetchConditionInfo: (includeOracleSigs) =>
        mint.getCtfCondition(metadata.target.condition_id, undefined, {
          include_oracle_sigs: includeOracleSigs,
          signal: AbortSignal.timeout(5_000),
        }),
    })
    assert.equal(
      resolution.evidence.status,
      'verified',
      'authentic intended oracle witness must verify',
    )
    if (resolution.evidence.status !== 'verified') throw new Error('fixture witness unverified')
    assert.equal(
      resolution.resolvedOutcome,
      metadata.target.winning_outcome,
      'verified witness must resolve the winning outcome',
    )
    const seed = Buffer.from((await readFile(seedFile, 'utf8')).trim(), 'hex')
    const id = metadata.target.keysets[metadata.target.funded_collection]
    const conditional = (await mint.getKeys(id)).keysets.find((row) => row.id === id)
    assert.equal(
      conditional?.unit === 'msat' && conditional.input_fee_ppk === 1,
      true,
      'redemption must use authentic conditional fee authority',
    )
    const payoutFee = computeInputFeeSubunitsForProofs(winner, {
      [id]: conditional!.input_fee_ppk!,
    })
    assert.equal(
      sumProofs(winner) === amountMsat && payoutFee === 1,
      true,
      'exact winning input must carry the authentic positive redemption fee',
    )
    const payoutCounterSource = createEphemeralCounterSource()
    await payoutCounterSource.advanceToAtLeast(regular.id, 4)
    const prepared = await prepareDurableCtfRedeemOperation({
      operationId: buildKeysetRedeemOperationId({
        mintUrl,
        unit: 'msat',
        conditionId: metadata.target.condition_id,
        keysetId: id,
        proofs: winner,
      }),
      mintUrl,
      conditionId: metadata.target.condition_id,
      outcomeCollection: metadata.target.funded_collection,
      inputKeyset: conditional!,
      regularKeyset: regular,
      inputs: winner,
      oracleWitness: resolution.evidence.canonicalOracleWitness,
      oracleResolutionContext: resolution.evidence.context,
      seed,
      counterSource: payoutCounterSource,
    })
    const redeemed = await executePreparedDurableCtfRedeem({
      operation: prepared.operation,
      seed,
      regularKeyset: regular,
      wallet,
    })
    assert.equal(
      redeemed.kind === 'redeemed',
      true,
      'recovered winning input must redeem through production SDK',
    )
    if (redeemed.kind !== 'redeemed') throw new Error('fixture payout missing')
    const payoutMsat = sumProofs(redeemed.proofs)
    assert.equal(
      redeemed.proofs.every((proof) => proof.id === regular.id) &&
        redeemed.proofs.every((proof) => proof.secret !== regularControl.secret) &&
        payoutMsat === amountMsat - payoutFee &&
        payoutMsat + payoutFee === sumProofs(winner),
      true,
      'real payout and authentic fee must conserve exact recovered value',
    )
    requireValidCashuProofs(redeemed.proofs, (id) => wallet.keyChain.getKeyset(id))
    await assertUnspent(wallet, redeemed.proofs)
    const inputStates = await wallet.checkProofsStates(winner)
    assert.equal(
      inputStates.length === winner.length && inputStates.every((row) => row.state === 'SPENT'),
      true,
      'exact recovered redemption inputs must become spent',
    )
    const losingCollection = Object.keys(metadata.target.split_keysets).find(
      (collection) => collection !== metadata.target.funded_collection,
    )
    assert.equal(typeof losingCollection, 'string')
    await assertUnspent(wallet, afterRestart[losingCollection!])
    await assertUnspent(wallet, [regularControl])
    await assertProofNotImported(regularControl)
  } finally {
    if (daemon) await stopDaemon(daemon)
  }
  process.stdout.write(
    `${JSON.stringify({
      recovered: true,
      laterPageObserved: true,
      foreignSeedProbes: 0,
      exactAuthority: true,
      repeatAndRestart: true,
      realPayout: true,
      regularControlExcluded: true,
      recoveryInvocationCount: invocations,
      selectedKeysetCount: summary.selectedKeysetCount,
      restoreProbeCount: restores.reduce((total, row) => total + row.count, 0),
      recoveryElapsedMs,
    })}\n`,
  )
}

try {
  assert.equal(mode === 'issue' || mode === 'recover', true, 'fixture mode must be explicit')
  const metadata = JSON.parse(
    await readFile(join(inputDirectory, 'public.json'), 'utf8'),
  ) as Metadata
  if (mode === 'issue') await issue(metadata)
  else await recover(metadata)
} catch (error) {
  // Inspect only error classes and bounded public status/code numbers, never detail or body.
  let code = 'operation_failed'
  if (error instanceof MintOperationError) {
    switch (error.code) {
      case 11006:
        code = 'mint_limit'
        break
      case 11013:
        code = 'mint_unit'
        break
      case 20003:
        code = 'mint_disabled'
        break
      case 20004:
        code = 'mint_lightning'
        break
      case 99999:
        code = 'mint_unknown'
        break
      default:
        code = 'mint_other'
        break
    }
  } else if (error instanceof NetworkError) code = 'network_error'
  else if (error instanceof HttpResponseError) code = 'http_response'
  else if (error instanceof CTSError) code = 'client_error'
  else if (error instanceof assert.AssertionError) code = 'assertion_failed'
  const httpStatus =
    error instanceof HttpResponseError &&
    Number.isInteger(error.status) &&
    error.status >= 100 &&
    error.status <= 599
      ? error.status
      : 'none'
  const mintCode =
    error instanceof MintOperationError &&
    Number.isInteger(error.code) &&
    error.code >= 0 &&
    error.code <= 99999
      ? error.code
      : 'none'
  process.stderr.write(
    `fixture-failure stage=${stage} code=${code} http_status=${httpStatus} mint_code=${mintCode}\n`,
  )
  process.exitCode = 1
}
