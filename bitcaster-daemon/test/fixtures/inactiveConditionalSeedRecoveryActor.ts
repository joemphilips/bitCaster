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
  verifyProofsForReceive,
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
import { deriveDurableCustodyScopeId } from '../../../bitcaster-client-sdk/src/durableCustody.ts'
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
  | 'deterministic-outputs'
  | 'split'
  | 'split-outputs'
  | 'split-submit'
  | 'issued-spentness'
  | 'issued-artifact'
  | 'listing'
  | 'fresh-profile'
  | 'recovery'
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
    fixture_oracle_registration: {
      eventId: string
      outcomes: string[]
      threshold: number
      oracles: { oraclePublicKey: string; noncePoint: string; announcement: string }[]
    }
  }
  witness: { oracle_sigs: unknown[] }
}
interface Observation {
  route: string
  cursor_present?: boolean
  limit_100?: boolean
  unfiltered?: boolean
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
  const regular = wallet.keyChain.getKeyset().toMintKeys()!
  assert.equal(regular.input_fee_ppk, 1, 'authentic regular keyset must carry the fixture fee')
  const grossCollateralMsat = computeGrossCtfInputAmountSubunits({
    faceAmountSubunits: amountMsat,
    keyset: { ...regular, input_fee_ppk: regular.input_fee_ppk! },
  })
  stage = 'mint-quote'
  const quote = await wallet.createMintQuote(grossCollateralMsat)
  stage = 'mint-payment'
  const deadline = Date.now() + 20_000
  let paid = false
  while (Date.now() < deadline) {
    const state = await wallet.checkMintQuote(quote.quote)
    if (state.state === 'PAID') {
      paid = true
      break
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.equal(paid, true, 'real FakeWallet quote must be paid')
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
  stage = 'deterministic-outputs'
  const seed = Buffer.from((await readFile(seedFile, 'utf8')).trim(), 'hex')
  const prepared = new Map<
    string,
    Awaited<ReturnType<typeof reserveAndConstructDurableSeedDerivedOutputs>>
  >()
  const counterSource = createEphemeralCounterSource()
  for (const [collection, id] of Object.entries(metadata.target.keysets)) {
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
    metadata.target.keysets,
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
  assert.equal(Object.keys(proofs).length, 2, 'actual split must issue both target outcomes')
  stage = 'issued-spentness'
  await assertUnspent(wallet, Object.values(proofs).flat())
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
  process.stdout.write('{"issued":true,"targetProofCount":4}\n')
}

async function assertUnspent(wallet: Wallet, proofs: Proof[]): Promise<void> {
  const states = await wallet.checkProofsStates(proofs)
  assert.equal(
    states.length === proofs.length && states.every((row) => row.state === 'UNSPENT'),
    true,
    'exact original proofs must remain unspent',
  )
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
  for (const [outcomeSetId, keysetId] of Object.entries(metadata.target.keysets)) {
    const page = await readAvailableWalletProofPage({
      mintUrl,
      keysetId,
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
      proofs.length === expected[outcomeSetId].length &&
        proofs.every((proof) =>
          expected[outcomeSetId].some((original) => sameProof(proof, original)),
        ) &&
        expected[outcomeSetId].every((original) =>
          proofs.some((proof) => sameProof(proof, original)),
        ),
      true,
      'native recovered proof identity and material must equal authentic issuance',
    )
    result[outcomeSetId] = proofs
  }
  const balance = await readDaemonWalletBalance(home)
  assert.equal(
    balance.outcomePositions.length,
    2,
    'native balance must contain only target outcomes',
  )
  for (const position of balance.outcomePositions) {
    assert.equal(
      position.conditionId === metadata.target.condition_id &&
        position.mintUrl === mintUrl &&
        Object.hasOwn(metadata.target.keysets, position.outcomeSetId),
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
  const mint = new Mint(mintUrl)
  const wallet = new Wallet(mint, { unit: 'msat' })
  await wallet.loadMint()
  await assertUnspent(wallet, Object.values(expected).flat())
  stage = 'listing'
  const first = await jsonFetch('/v1/conditional_keysets?limit=100')
  assert.equal(first.keysets.length, 100)
  assert.equal(
    first.keysets.every(
      (row: any) => row.unit === 'sat' && Object.values(metadata.foreign.keysets).includes(row.id),
    ),
    true,
    'first page must contain only real foreign-unit rows',
  )
  assert.equal(typeof first.next_cursor, 'string')
  const second = await jsonFetch(
    `/v1/conditional_keysets?limit=100&cursor=${encodeURIComponent(first.next_cursor)}`,
  )
  assert.equal(second.keysets.length, 2)
  assert.equal(second.next_cursor, null)
  assert.equal(
    second.keysets.every(
      (row: any) =>
        row.unit === 'msat' &&
        row.active === false &&
        Object.values(metadata.target.keysets).includes(row.id),
    ),
    true,
    'later real page must contain exactly both inactive target rows',
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
  const deadline = Date.now() + 150_000
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
  ]
  stage = 'recovery'
  do {
    assert.equal(
      ++invocations <= 3 && Date.now() < deadline,
      true,
      'offline recovery must finish within invocation and time bounds',
    )
    summary = await cli(args, Math.min(60_000, deadline - Date.now()))
  } while (summary.state === 'active')
  assert.equal(summary.state, 'completed')
  assert.equal(
    summary.selectedKeysetCount,
    3,
    'one regular and two target msat keysets must be selected',
  )
  stage = 'observations'
  const observations = (await jsonFetch('/fixture/observations')) as Observation[]
  const pages = observations.filter((row) => row.route === 'conditional-list')
  assert.equal(pages.length >= 2, true, 'recovery itself must fetch both pages')
  assert.equal(pages[0].cursor_present, false)
  assert.equal(pages[0].count, 100)
  assert.equal(pages[0].has_next, true)
  assert.equal(pages[1].cursor_present, true)
  assert.equal(pages[1].count, 2)
  assert.equal(pages[1].has_next, false)
  assert.equal(
    pages.every((row) => row.limit_100 && row.unfiltered),
    true,
    'actual recovery must list unfiltered limit-100 pages',
  )
  const restores = observations.filter((row) => row.route === 'restore')
  const foreign = new Set(Object.values(metadata.foreign.keysets))
  assert.equal(
    restores.every((row) => Object.keys(row.keyset_counts!).every((id) => !foreign.has(id))),
    true,
    'foreign-unit keys must receive no seed probes',
  )
  const discovery = restores.find((row) => row.count === 600)
  assert.equal(
    discovery !== undefined && Object.keys(discovery.keyset_counts!).length === 2,
    true,
    'recovery must use exactly 600 target discovery candidates',
  )
  for (const id of Object.values(metadata.target.keysets)) {
    assert.equal(discovery!.keyset_counts![id], 300)
    assert.equal(
      restores.reduce((count, row) => count + (row.keyset_counts![id] ?? 0), 0) >= 300,
      true,
      'each inactive keyset must receive its production discovery prefix',
    )
  }
  stage = 'exact-authority'
  await recoveredProofs(metadata, expected)
  const before = await authoritySnapshot()
  stage = 'repeat'
  const repeated = await cli(args, 60_000)
  assert.equal(repeated.state, 'completed')
  assert.equal(
    (await authoritySnapshot()) === before,
    true,
    'repeat recovery must not change proof, counter, condition, or roster authority',
  )
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
    stage = 'payout'
    const winner = afterRestart.Yes
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
        attestedOutcome: 'Yes',
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
      'Yes',
      'verified witness must resolve the winning outcome',
    )
    const seed = Buffer.from((await readFile(seedFile, 'utf8')).trim(), 'hex')
    const id = metadata.target.keysets.Yes
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
      outcomeCollection: 'Yes',
      inputKeyset: conditional!,
      regularKeyset: regular,
      inputs: winner,
      oracleWitness: resolution.evidence.canonicalOracleWitness,
      oracleResolutionContext: resolution.evidence.context,
      seed,
      counterSource: createEphemeralCounterSource(),
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
        payoutMsat === amountMsat - payoutFee &&
        payoutMsat + payoutFee === sumProofs(winner),
      true,
      'real payout and authentic fee must conserve exact recovered value',
    )
    verifyProofsForReceive(redeemed.proofs, (id) => wallet.keyChain.getKeyset(id), {
      requireDleq: true,
    })
    await assertUnspent(wallet, redeemed.proofs)
    const inputStates = await wallet.checkProofsStates(winner)
    assert.equal(
      inputStates.length === winner.length && inputStates.every((row) => row.state === 'SPENT'),
      true,
      'exact recovered redemption inputs must become spent',
    )
    await assertUnspent(wallet, afterRestart.No)
  } finally {
    if (daemon) await stopDaemon(daemon)
  }
  process.stdout.write(
    '{"recovered":true,"laterPageObserved":true,"foreignSeedProbes":0,"exactAuthority":true,"repeatAndRestart":true,"realPayout":true}\n',
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
