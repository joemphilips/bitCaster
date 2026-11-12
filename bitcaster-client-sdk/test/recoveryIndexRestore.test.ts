import assert from 'node:assert/strict'
import test from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import {
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveKeysetId,
  pointFromHex,
  type Proof,
  type SerializedBlindedMessage,
} from '@cashu/cashu-ts'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import {
  deriveRecoveryIndexKeys,
  type RecoveryIndexEntry,
  type RecoveryIndexKeysetAuthority,
} from '../src/recoveryIndexDocument.ts'
import {
  RECOVERY_INDEX_REALMS,
  createRecoveryIndexEngineStore,
} from '../src/recoveryIndexEngine.ts'
import {
  RECOVERY_INDEX_CLI_ALL_CONDITIONS_COMMAND,
  RECOVERY_INDEX_KEYSET_PROGRESS_START,
  RECOVERY_INDEX_RESTORE_COUNTER_BUDGET,
  RECOVERY_INDEX_RESTORE_GAP_LIMIT,
  planRecoveryIndexRestore,
  recoveryIndexCliGapCommand,
  runRecoveryIndexRestorePass,
  scanRecoveryIndexKeyset,
  seedCounterGapWarning,
  type RecoveryIndexKeysetProgress,
  type RecoveryIndexKeysetScan,
} from '../src/recoveryIndexRestore.ts'
import { RecoveryIndexSync } from '../src/recoveryIndexSync.ts'
import { createSeedRecoveryScanPolicy } from '../src/seedRecoveryScanPolicy.ts'
import {
  findSignedSeedOutputs,
  skipPastSignedSeedOutputs,
  type PlannedSeedOutput,
} from '../src/seedCounterGapScan.ts'
import { RecoveryIndexFakeEngine } from './support/recoveryIndexFakeEngine.ts'

const SEED = new Uint8Array(64).fill(5)
const MINT = 'https://mint.example.com'
const OTHER_MINT = 'https://other.example.com'
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 11])
const PUBLIC_KEY = bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true))
// The mint signs amount 1 only. A keyset needs one public key for each denomination.
const KEYS = {
  '1': PUBLIC_KEY,
  '2': bytesToHex(secp256k1.getPublicKey(Uint8Array.from([...new Uint8Array(31), 12]), true)),
}
const KEYSET: RecoveryIndexKeysetAuthority = {
  id: deriveKeysetId(KEYS, { unit: 'msat', versionByte: 1 }),
  unit: 'msat',
  keys: KEYS,
  inputFeePpk: 0,
  finalExpiry: null,
}
const ENTRY: RecoveryIndexEntry = { kind: 'regular', mintUrl: MINT, keysetId: KEYSET.id }

function hash(label: string): string {
  return bytesToHex(sha256(utf8ToBytes(label)))
}

function entryOf(label: string, mintUrl = MINT): RecoveryIndexEntry {
  return { kind: 'regular', mintUrl, keysetId: `01${hash(label)}` }
}

function outputOf(counter: number, keysetId = KEYSET.id): string {
  return OutputData.createSingleDeterministicData(0, SEED, counter, keysetId).blindedMessage.B_
}

/**
 * A mint for one keyset. It signs NUT-13 outputs at the given counters, with
 * a DLEQ, answers NUT-09 restores, and reports a NUT-07 state for each proof.
 */
function fakeMint(signedCounters: Iterable<number> = [], keysetId = KEYSET.id) {
  const signed = new Set<string>()
  const counterOfSecret = new Map<string, number>()
  const states = new Map<number, string>()
  const restored: SerializedBlindedMessage[][] = []
  const sign = (counters: Iterable<number>) => {
    for (const counter of counters) {
      const output = OutputData.createSingleDeterministicData(0, SEED, counter, keysetId)
      signed.add(output.blindedMessage.B_)
      counterOfSecret.set(new TextDecoder().decode(output.secret), counter)
    }
  }
  sign(signedCounters)
  const counterOf = (proof: Proof) => {
    const counter = counterOfSecret.get(proof.secret)
    if (counter === undefined) throw new Error('test proof counter is unknown')
    return counter
  }
  const restore = async (outputs: SerializedBlindedMessage[]) => {
    restored.push(outputs)
    const hits = outputs.filter(({ B_ }) => signed.has(B_))
    return {
      outputs: hits,
      signatures: hits.map((output) => {
        const blinded = pointFromHex(output.B_)
        const C_ = createBlindSignature(blinded, PRIVATE_KEY, keysetId).C_.toHex(true)
        const dleq = createDLEQProof(blinded, PRIVATE_KEY)
        return {
          id: keysetId,
          amount: 1,
          C_,
          dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
        }
      }),
    }
  }
  return {
    restored,
    restore,
    /** The mint signs these counters, as after a trade of some client. */
    sign,
    counterOf,
    setState(counter: number, state: string) {
      states.set(counter, state)
    },
    checkProofStates: async (proofs: readonly Proof[]) =>
      proofs.map((proof) => states.get(counterOf(proof)) ?? 'UNSPENT'),
    /** The NUT-09 part used by the order output check. */
    client: {
      restore: async ({ outputs }: { outputs: SerializedBlindedMessage[] }) => restore(outputs),
    },
    isSigned: (counter: number) => signed.has(outputOf(counter, keysetId)),
  }
}

async function scan(
  mint: ReturnType<typeof fakeMint>,
  options: {
    readonly progress?: RecoveryIndexKeysetProgress
    readonly maxScannedCounters?: number
    readonly gapLimit?: number
    readonly entry?: RecoveryIndexEntry
    readonly keyset?: RecoveryIndexKeysetAuthority
  } = {},
): Promise<RecoveryIndexKeysetScan> {
  return scanRecoveryIndexKeyset({
    seed: SEED,
    entry: options.entry ?? ENTRY,
    keyset: options.keyset ?? KEYSET,
    restore: mint.restore,
    checkProofStates: mint.checkProofStates,
    progress: options.progress ?? RECOVERY_INDEX_KEYSET_PROGRESS_START,
    maxScannedCounters: options.maxScannedCounters ?? RECOVERY_INDEX_RESTORE_COUNTER_BUDGET,
    ...(options.gapLimit === undefined ? {} : { gapLimit: options.gapLimit }),
  })
}

test('a restore scans the listed keysets, then the regular keysets, then the hinted keysets', () => {
  const listed = [entryOf('listed'), entryOf('foreign', OTHER_MINT), entryOf('regular one')]
  const regular = [entryOf('regular one'), entryOf('regular two')]
  const hints = [entryOf('hint'), entryOf('listed'), entryOf('regular two')]
  const plan = planRecoveryIndexRestore({ listed, walletMints: [MINT], regular, hints })
  assert.deepEqual(
    plan.targets.map(({ entry, source }) => [entry.keysetId, source]),
    [
      [entryOf('listed').keysetId, 'listed'],
      [entryOf('regular one').keysetId, 'listed'],
      [entryOf('regular two').keysetId, 'regular'],
      [entryOf('hint').keysetId, 'hint'],
    ],
  )
  // An entry of a mint that is not a wallet mint stays in the index, unscanned.
  assert.ok(isDeepStrictEqual(plan.foreignListed, [entryOf('foreign', OTHER_MINT)]))

  const noIndex = planRecoveryIndexRestore({ listed: null, walletMints: [MINT], regular, hints })
  assert.deepEqual(
    noIndex.targets.map(({ source }) => source),
    ['regular', 'regular', 'hint', 'hint'],
  )
})

test('a restore finds an output after 299 unused counters, but not after 300', async () => {
  const across299 = await scan(fakeMint([0, 300]))
  assert.equal(across299.status, 'complete')
  assert.equal(across299.progress.lastSignedCounter, 300)
  assert.equal(across299.unspent.length, 2)
  // ADR-051 cursor: the last signed counter plus 150; the next output uses plus 151.
  assert.equal(across299.nextOutputCounter, 451)

  const across300 = await scan(fakeMint([0, 301]))
  assert.equal(across300.status, 'complete')
  assert.equal(across300.progress.lastSignedCounter, 0)
  assert.equal(across300.unspent.length, 1)
  assert.equal(across300.nextOutputCounter, 151)
  assert.equal(across300.scannedCounters, 301)
})

test('a keyset with no signed output scans 300 counters and continues at counter 150', async () => {
  const mint = fakeMint([])
  const result = await scan(mint)
  assert.equal(result.status, 'complete')
  assert.equal(result.progress.lastSignedCounter, null)
  assert.equal(result.scannedCounters, RECOVERY_INDEX_RESTORE_GAP_LIMIT)
  assert.equal(result.nextOutputCounter, 150)
  assert.equal(mint.restored.flat().length, 300)
})

test('the CLI gap limit finds an output after a run that the GUI gap misses', async () => {
  const cliGap = createSeedRecoveryScanPolicy({ gapLimit: 701 }).gapLimit
  const result = await scan(fakeMint([0, 301, 1_000]), { gapLimit: cliGap })
  assert.equal(result.progress.lastSignedCounter, 1_000)
  assert.equal(result.unspent.length, 3)
  assert.equal(result.nextOutputCounter, 1_151)
  assert.equal(recoveryIndexCliGapCommand(cliGap), 'bitcaster wallet recover-seed --gap-limit 701')
  assert.equal(
    RECOVERY_INDEX_CLI_ALL_CONDITIONS_COMMAND,
    'bitcaster wallet recover-seed --all-conditions',
  )
  assert.throws(() => recoveryIndexCliGapCommand(0))
})

test('a restore admits only verified UNSPENT proofs and marks the lowest PENDING counter', async () => {
  const mint = fakeMint([3, 5, 7, 9])
  mint.setState(5, 'SPENT')
  mint.setState(7, 'PENDING')
  mint.setState(9, 'PENDING')
  const result = await scan(mint)
  assert.equal(result.unspent.length, 1)
  assert.equal(mint.counterOf(result.unspent[0]!), 3)
  assert.equal(result.spentCount, 1)
  assert.equal(result.pendingFromCounter, 7)
  assert.equal(result.nextOutputCounter, 160)

  const unknown = fakeMint([3])
  unknown.setState(3, 'UNKNOWN')
  await assert.rejects(scan(unknown), /state/)

  // A signature without a valid DLEQ admits nothing.
  const noDleq = fakeMint([3])
  const restore = async (outputs: SerializedBlindedMessage[]) => {
    const response = await noDleq.restore(outputs)
    return { ...response, signatures: response.signatures.map(({ dleq: _dleq, ...rest }) => rest) }
  }
  await assert.rejects(
    scanRecoveryIndexKeyset({
      seed: SEED,
      entry: ENTRY,
      keyset: KEYSET,
      restore,
      checkProofStates: noDleq.checkProofStates,
      progress: RECOVERY_INDEX_KEYSET_PROGRESS_START,
      maxScannedCounters: 1_000,
    }),
    /DLEQ/,
  )
})

test('a restore refuses mint keys that do not derive the listed keyset before it asks the mint', async () => {
  const mint = fakeMint([0])
  const otherKeys = { '1': PUBLIC_KEY }
  await assert.rejects(scan(mint, { keyset: { ...KEYSET, keys: otherKeys } }), /keyset/)
  const conditionId = hash('condition')
  const outcomeCollectionId = hash('collection')
  const conditionalId = deriveConditionalKeysetId({
    keys: KEYS,
    unit: 'msat',
    conditionId,
    outcomeCollectionId,
  })
  const conditional: RecoveryIndexEntry = {
    kind: 'conditional',
    mintUrl: MINT,
    keysetId: conditionalId,
    conditionId,
    outcomeCollectionId,
  }
  const wrongCollection = { ...conditional, outcomeCollectionId: hash('other collection') }
  const conditionalKeyset = { ...KEYSET, id: conditionalId }
  await assert.rejects(scan(mint, { entry: wrongCollection, keyset: conditionalKeyset }), /keyset/)
  assert.equal(mint.restored.length, 0)
  const conditionalMint = fakeMint([2], conditionalId)
  const result = await scan(conditionalMint, { entry: conditional, keyset: conditionalKeyset })
  assert.equal(result.progress.lastSignedCounter, 2)
})

test('a pass stops at its counter budget and the next pass continues with the same gap', async () => {
  const signed = [0, 250, 500, 750]
  const whole = await scan(fakeMint(signed))
  assert.equal(whole.nextOutputCounter, 901)

  const mint = fakeMint(signed)
  const progress = new Map<string, RecoveryIndexKeysetProgress>([
    ['k', RECOVERY_INDEX_KEYSET_PROGRESS_START],
  ])
  const results: RecoveryIndexKeysetScan[] = []
  const runPass = (counterBudget: number) =>
    runRecoveryIndexRestorePass({
      keysets: [...progress].map(([target, keysetProgress]) => ({
        target,
        progress: keysetProgress,
      })),
      counterBudget,
      scan: (_target, request) =>
        scanRecoveryIndexKeyset({
          seed: SEED,
          entry: ENTRY,
          keyset: KEYSET,
          restore: mint.restore,
          checkProofStates: mint.checkProofStates,
          ...request,
        }),
      commit: async (target, result) => {
        results.push(result)
        if (result.status === 'complete') progress.delete(target)
        else progress.set(target, result.progress)
      },
    })

  assert.deepEqual(await runPass(400), { status: 'budget', scannedCounters: 400 })
  assert.equal(results.at(-1)!.status, 'incomplete')
  assert.deepEqual(await runPass(RECOVERY_INDEX_RESTORE_COUNTER_BUDGET), {
    status: 'complete',
    scannedCounters: whole.scannedCounters - 400,
  })
  assert.equal(results.at(-1)!.nextOutputCounter, 901)
  assert.equal(
    results.reduce((total, result) => total + result.unspent.length, 0),
    whole.unspent.length,
  )
  assert.deepEqual(await runPass(RECOVERY_INDEX_RESTORE_COUNTER_BUDGET), {
    status: 'complete',
    scannedCounters: 0,
  })
})

test('the handoff warning names a CLI gap above the longest unused run before a signed output', () => {
  assert.equal(seedCounterGapWarning([0, 1, 299]), null)
  assert.deepEqual(seedCounterGapWarning([0, 1, 302]), { longestRun: 300, cliGapLimit: 301 })
  assert.deepEqual(seedCounterGapWarning([400, 402]), { longestRun: 400, cliGapLimit: 401 })
  assert.equal(seedCounterGapWarning([]), null)
})

/** Plan the plain NUT-13 outputs of `count` counters from `start`. */
function plainOutputs(start: number, count: number): PlannedSeedOutput[] {
  return Array.from({ length: count }, (_, index) => ({
    keysetId: KEYSET.id,
    counter: start + index,
    B_: outputOf(start + index),
  }))
}

test('an A to B to A device switch writes once, starts no scan loop, and reuses no signed output', async () => {
  const realm = RECOVERY_INDEX_REALMS.local
  const keys = deriveRecoveryIndexKeys(SEED, realm)
  const engine = new RecoveryIndexFakeEngine(realm)
  engine.nowSeconds = 1_800_000_000
  const mint = fakeMint()
  const device = (localEntries: RecoveryIndexEntry[]) =>
    new RecoveryIndexSync({
      store: createRecoveryIndexEngineStore({
        engineBaseUrl: engine.baseUrl,
        realm,
        keys,
        fetchImpl: engine.fetch,
        nowMs: () => engine.nowSeconds * 1000,
      }),
      keys,
      localEntries: async () => [...localEntries],
      verifyEntry: async () => true,
      nowMs: () => engine.nowSeconds * 1000,
    })

  // A trades at counters 0 to 9 of its first keyset and writes the index.
  const aLocal = [ENTRY]
  const a = device(aLocal)
  mint.sign(plainOutputs(0, 10).map(({ counter }) => counter))
  let aNext = 10
  assert.deepEqual(await a.upload(), { status: 'written', version: 1 })

  // B enters the seed: it reads the index and restores the listed keyset.
  const bLocal: RecoveryIndexEntry[] = []
  const b = device(bLocal)
  const bRead = await b.read('wallet-open')
  assert.ok(bRead.status === 'read' && isDeepStrictEqual(bRead.scan, [ENTRY]))
  const restored = await scan(mint)
  assert.equal(restored.unspent.length, 10)
  assert.equal(restored.nextOutputCounter, 160)
  bLocal.push(ENTRY)
  // B trades. Its outputs start 150 counters after the last signed output.
  mint.sign(plainOutputs(restored.nextOutputCounter!, 10).map(({ counter }) => counter))
  assert.deepEqual(await b.upload(), { status: 'current', version: 1 })

  // A opens again: the keyset is listed and has a local cursor, so no scan starts.
  const restoresBefore = mint.restored.length
  const aRead = await a.read('wallet-open')
  assert.ok(aRead.status === 'read' && aRead.scan.length === 0)
  assert.equal(mint.restored.length, restoresBefore)

  // A's next order of 200 outputs checks them before submit (ADR-037 decision 14).
  let planned = plainOutputs(aNext, 200)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const signed = await findSignedSeedOutputs(mint.client, planned)
    if (signed.length === 0) break
    const skip = await skipPastSignedSeedOutputs({
      mint: mint.client,
      seed: SEED,
      keysetId: KEYSET.id,
      fromCounter: aNext,
      signedCounters: signed.map(({ counter }) => counter),
    })
    aNext = skip.nextCounter
    planned = plainOutputs(aNext, 200)
  }
  // The submitted outputs reuse no output that B had signed: no penalty.
  assert.equal(aNext, 169 + 151)
  assert.ok(planned.every(({ counter }) => !mint.isSigned(counter)))
  mint.sign(planned.map(({ counter }) => counter))
  assert.deepEqual(await a.upload(), { status: 'current', version: 1 })

  // B opens again after A traded: no scan of its own keyset either.
  const bAgain = await b.read('wallet-open')
  assert.ok(bAgain.status === 'read' && bAgain.scan.length === 0)
  assert.equal(engine.count('PUT'), 1)
  assert.equal(aLocal.length, 1)
})
