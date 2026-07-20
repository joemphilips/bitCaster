import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { deriveConditionalKeysetId } from '@cashu/cashu-ts'
import { deriveDurableCustodyScopeId } from '@bitcaster-market/client-sdk/durableCustody'
import {
  createConditionalCatalogueProgress,
  createConditionalRecoverySession,
  createConditionalRecoveryWalletScope,
  decodeConditionalRecoveryCapability,
  finalizeConditionalRecoveryCatalogue,
  issueConditionalRecoveryAuthorityObservation,
  validateConditionalCataloguePage,
  type CompletedConditionalRecoveryCatalogue,
  type ConditionalRecoveryAuthorityPort,
  type ConditionalRecoveryNut13DerivationPort,
  type ConditionalRecoveryWalletScope,
} from '@bitcaster-market/client-sdk/emergencyConditionalSeedRecovery'
import {
  createConditionalSeedRecoveryHandoffPort,
  createConditionalSeedRecoverySqlitePort,
  readCurrentConditionalRecoveryEvidence,
} from '../src/conditionalSeedRecoverySqlite.ts'
import { driveConditionalSeedRecovery } from '../src/conditionalSeedRecoveryCoordinator.ts'
import { ensureDaemonStateSchema } from '../src/stateSqlite.ts'

const CONDITION_ID = '11'.repeat(32)
const OUTCOME_COLLECTION_ID =
  '51bdecc2e0ef4b3779c4e9f14968f40284f510607974560ee51ff7639d781804'
const PUBLIC_KEY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const KEYS = { '1': PUBLIC_KEY }
const KEYSET_ID = deriveConditionalKeysetId({
  keys: KEYS,
  unit: 'sat',
  final_expiry: 2_000_000_000,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_COLLECTION_ID,
})
const RECOVERY_ID = 'conditional-fresh-process'
const EMPTY_RESPONSE = new TextEncoder().encode(
  JSON.stringify({ outputs: [], signatures: [] }),
)

function walletScope(): ConditionalRecoveryWalletScope {
  return createConditionalRecoveryWalletScope({
    scopeId: deriveDurableCustodyScopeId({
      scopeKind: 'wallet',
      walletId: '22'.repeat(32),
    }),
    mintUrl: 'https://mint.example/',
    unit: 'sat',
  })
}

function mintInfo(): unknown {
  return {
    nuts: {
      CTF: {
        supported: true,
        conditional_keyset_catalogue: { version: 1, max_page_size: 2 },
      },
    },
  }
}

function authorityPort(): ConditionalRecoveryAuthorityPort {
  return {
    fetchMintInfo: () => mintInfo(),
    readWallClockMs: () => 1_800_000_000 * 1_000,
    advanceAndReadHighWater: ({ observedUnixSeconds }) => observedUnixSeconds,
  }
}

async function catalogue(): Promise<CompletedConditionalRecoveryCatalogue> {
  const scope = walletScope()
  const capability = decodeConditionalRecoveryCapability(mintInfo())
  assert.notEqual(capability, null)
  const progress = createConditionalCatalogueProgress({
    capability: capability!,
    walletScope: scope,
  })
  const terminal = validateConditionalCataloguePage({
    requestedCursor: null,
    response: {
      keysets: [
        {
          id: KEYSET_ID,
          unit: 'sat',
          active: false,
          final_expiry: 2_000_000_000,
          condition_id: CONDITION_ID,
          outcome_collection: 'YES',
          outcome_collection_id: OUTCOME_COLLECTION_ID,
          registered_at: 1_700_000_000,
        },
      ],
      complete: true,
    },
    responseBytes: 512,
    progress,
  })
  return finalizeConditionalRecoveryCatalogue({
    terminalPage: terminal,
    authority: await issueConditionalRecoveryAuthorityObservation({
      subject: terminal,
      port: authorityPort(),
    }),
    ordinaryKeysetIds: [],
  })
}

function keysResponse(): unknown {
  return {
    keysets: [
      {
        id: KEYSET_ID,
        unit: 'sat',
        active: false,
        final_expiry: 2_000_000_000,
        keys: KEYS,
      },
    ],
  }
}

const derivationPort: ConditionalRecoveryNut13DerivationPort = {
  deriveSeedOutputs: ({ startCounter, count }) =>
    Array.from({ length: count }, (_, offset) => ({
      counter: startCounter + offset,
      id: KEYSET_ID,
      amount: '0',
      B_: PUBLIC_KEY,
      Y: PUBLIC_KEY,
      unblind: () => {
        throw new Error('empty restore response must not unblind a signature')
      },
    })),
}

function openDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path)
  database.exec(
    'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000',
  )
  return database
}

function initializeOrdinaryJob(database: DatabaseSync, scope: ConditionalRecoveryWalletScope): void {
  ensureDaemonStateSchema(database)
  database.prepare(
    'INSERT INTO daemon_state_metadata (singleton, schema_version) VALUES (1, 3)',
  ).run()
  database.prepare(
    `INSERT INTO daemon_seed_recovery_jobs (
      wallet_scope_id, mint_url, unit, recovery_id, schema_version,
      disclosure_acknowledged, state, phase, revision, cursor_kind,
      current_cursor, current_cursor_digest, capability_version,
      capability_max_page_size, page_count, keyset_count, transport_bytes,
      serialized_bytes, work_units, proof_count, imported_proofs,
      ignored_spent_proofs, retained_pending_proofs, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 3, 1, 'completed', 'completed', 0, 'ordinary',
      NULL, NULL, NULL, NULL, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1)`,
  ).run(scope.scopeId, scope.mintUrl, scope.unit, RECOVERY_ID)
}

async function driveInput(
  database: DatabaseSync,
  completed: CompletedConditionalRecoveryCatalogue,
  faultHook?: Parameters<typeof createConditionalSeedRecoverySqlitePort>[0]['faultHook'],
) {
  const sessionPort = createConditionalSeedRecoverySqlitePort({
    database,
    recoveryId: RECOVERY_ID,
    faultHook,
  })
  return {
    database,
    recoveryId: RECOVERY_ID,
    walletScope: completed.walletScope,
    sessionPort,
    catalogue: completed,
    derivationPort,
    authorityPort: authorityPort(),
    keysPort: {
      fetchKeys: async () => ({ response: keysResponse(), responseBytes: 256 }),
    },
    nut09Transport: {
      fetchNut09Entity: async () => EMPTY_RESPONSE,
    },
    nut07Transport: {
      fetchNut07Entity: async () => {
        throw new Error('empty restore must not fetch NUT-07')
      },
    },
    batchSize: 1,
  }
}
async function runChild(path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', import.meta.filename],
      {
        env: {
          ...process.env,
          NODE_TEST_CONTEXT: undefined,
          CONDITIONAL_RECOVERY_CHILD_DB: path,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let output = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve(output)
      else reject(new Error(`fresh recovery child failed (${code}): ${output}`))
    })
  })
}

const childPath = process.env.CONDITIONAL_RECOVERY_CHILD_DB
if (childPath !== undefined) {
  test('fresh child rehydrates request with a new adapter and commits empty response before return', async () => {
    const database = openDatabase(childPath)
    try {
      const completed = await catalogue()
      const persistedRequest = database.prepare(
        'SELECT request_bytes FROM daemon_seed_recovery_requests',
      ).get()?.request_bytes
      assert.ok(persistedRequest instanceof Uint8Array)
      let dispatched: Uint8Array | undefined
      const input = await driveInput(database, completed, (stage) => {
        if (stage === 'after-response-commit') {
          throw new Error('simulated process loss after response commit')
        }
      })
      input.nut09Transport = {
        fetchNut09Entity: async ({ requestBytes }) => {
          dispatched = Uint8Array.from(requestBytes)
          return EMPTY_RESPONSE
        },
      }
      await assert.rejects(
        () => driveConditionalSeedRecovery({ ...input, maxSteps: 1 }),
        /simulated process loss after response commit/,
      )
      assert.equal(
        Buffer.from(dispatched!).equals(Buffer.from(persistedRequest)),
        true,
        'fresh process must replay the exact staged request bytes',
      )
      const evidence = readCurrentConditionalRecoveryEvidence(
        database,
        RECOVERY_ID,
        completed.walletScope,
      )
      assert.equal(evidence?.session.transition, 'nut09-response')
      assert.equal(evidence?.stagedProofRows.length, 0)
      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM daemon_seed_recovery_batches').get()?.count,
        1,
      )
      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM daemon_seed_recovery_staged_proofs').get()?.count,
        0,
      )
    } finally {
      database.close()
    }
  })
} else {
  test('request and empty response survive commit-before-return loss across a fresh process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bitcaster-conditional-recovery-'))
    const path = join(directory, 'state.sqlite')
    try {
      const database = openDatabase(path)
      const completed = await catalogue()
      initializeOrdinaryJob(database, completed.walletScope)
      const handoff = createConditionalSeedRecoveryHandoffPort({
        database,
        recoveryId: RECOVERY_ID,
        expectedJobRevision: 0,
        catalogue: completed,
        registeredAt: 2,
      })
      createConditionalRecoverySession({
        catalogue: completed,
        walletScope: completed.walletScope,
        cas: handoff,
      })
      const input = await driveInput(database, completed, (stage) => {
        if (stage === 'after-request-commit') {
          throw new Error('simulated process loss after request commit')
        }
      })
      await assert.rejects(
        () => driveConditionalSeedRecovery({ ...input, maxSteps: 3 }),
        /simulated process loss after request commit/,
      )
      assert.equal(
        readCurrentConditionalRecoveryEvidence(
          database,
          RECOVERY_ID,
          completed.walletScope,
        )?.session.transition,
        'nut09-request',
      )
      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM daemon_seed_recovery_requests').get()?.count,
        1,
      )
      database.close()
      const childOutput = await runChild(path)
      assert.match(childOutput, /fresh child rehydrates request/)
      const reopened = openDatabase(path)
      try {
        const evidence = readCurrentConditionalRecoveryEvidence(
          reopened,
          RECOVERY_ID,
          completed.walletScope,
        )
        assert.equal(evidence?.session.transition, 'nut09-response')
        assert.equal(evidence?.stagedProofRows.length, 0)
        assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), [])
      } finally {
        reopened.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}
