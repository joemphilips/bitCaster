import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { deriveKeysetId } from '@cashu/cashu-ts'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  bootstrapFreshDaemonProfile,
  readBootstrappedProfileSecrets,
} from '../../bitcaster-daemon/src/profileBootstrap.ts'
import { openDaemonStateSqlite } from '../../bitcaster-daemon/src/stateSqlite.ts'

const execute = promisify(execFile)
const mintUrl = 'https://mint.example'
const oldSeed = '01'.repeat(64)
const importedSeed = '02'.repeat(64)
const oldSigner = '03'.repeat(32)
const importedSigner = '04'.repeat(32)

test('actual CLI selects distinct wallet profiles for secure import and acknowledged recovery without changing unfinished old work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-wallet-profile-selection-'))
  try {
    const {
      oldDirectory,
      newDirectory,
      requestLog,
      seedFile,
      signerFile,
      oldProfile,
      oldFiles,
      run,
    } = await profileFixture(root)
    const initialized = await run(newDirectory, oldDirectory, [
      'daemon',
      'init',
      '--wallet-seed-hex-file',
      seedFile,
      '--nostr-secret-key-hex-file',
      signerFile,
    ])
    assert.match(initialized.stdout, /profile initialized/)
    assert.deepEqual(await profileFiles(oldDirectory), oldFiles, 'Old profile changed')
    const imported = await readBootstrappedProfileSecrets(newDirectory)
    assert.equal(imported!.walletSeedHex, importedSeed)
    assert.equal(imported!.nostrSecretKeyHex, importedSigner)

    const recoveryArgs = [
      'wallet',
      'recover-seed',
      '--wallet-seed-hex-file',
      seedFile,
      '--recovery-id',
      'imported-profile-recovery',
      '--mint',
      mintUrl,
      '--unit',
      'msat',
    ]
    const beforeAcknowledgment = await profileFiles(newDirectory)
    await assert.rejects(run(newDirectory, oldDirectory, recoveryArgs), (error: unknown) => {
      const failed = error as { code: number; stdout: string; stderr: string }
      assert.equal(failed.code, 2)
      assert.match(failed.stdout + failed.stderr, /requires --acknowledge-seed-disclosure/)
      assertRedacted(failed.stdout + failed.stderr)
      return true
    })
    assert.deepEqual(
      await profileFiles(newDirectory),
      beforeAcknowledgment,
      'Unacknowledged recovery changed the profile',
    )
    await assert.rejects(readFile(requestLog), { code: 'ENOENT' })
    const recovered = await run(newDirectory, oldDirectory, [
      ...recoveryArgs,
      '--acknowledge-seed-disclosure',
    ])
    assert.deepEqual(JSON.parse(recovered.stdout), {
      recoveryId: 'imported-profile-recovery',
      state: 'completed',
      selectedKeysetCount: 1,
      completedChildCount: 1,
      batchesProcessed: 1,
      gapLimit: 300,
    })
    const requests = (await readFile(requestLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(
      requests.filter((request) => request.path === '/v1/restore'),
      [{ path: '/v1/restore', method: 'POST', outputCount: 300 }],
    )
    for (const [selected, ignored, publicKeyHex] of [
      [oldDirectory, newDirectory, oldProfile.nostrPublicKeyHex],
      [newDirectory, oldDirectory, imported!.nostrPublicKeyHex],
    ]) {
      const shown = await run(selected!, ignored!, ['signer', 'show'])
      assert.deepEqual(JSON.parse(shown.stdout), { enabled: true, publicKeyHex, revision: 0 })
    }
    assert.notEqual(imported!.nostrPublicKeyHex, oldProfile.nostrPublicKeyHex)
    assert.deepEqual(await profileFiles(oldDirectory), oldFiles, 'Old profile changed')
    const retained = await readBootstrappedProfileSecrets(oldDirectory)
    assert.equal(retained!.walletSeedHex, oldSeed)
    assert.equal(retained!.nostrSecretKeyHex, oldSigner)
    assert.deepEqual(await profileFiles(oldDirectory), oldFiles, 'Old profile changed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function profileFixture(root: string) {
  const oldDirectory = join(root, 'old')
  const newDirectory = join(root, 'imported')
  const requestLog = join(root, 'mock-mint-requests.jsonl')
  const seedFile = join(root, 'wallet-seed.hex')
  const signerFile = join(root, 'nostr-secret-key.hex')
  const oldProfile = await bootstrapFreshDaemonProfile({
    directory: oldDirectory,
    engineBaseUrl: 'https://engine.example',
    mintUrl,
    walletSeedHex: oldSeed,
    nostrSecretKeyHex: oldSigner,
  })
  const database = await openDaemonStateSqlite(oldDirectory)
  try {
    insertPreparedWork(database, oldProfile.walletScopeId)
  } finally {
    database.close()
  }
  const oldFiles = await profileFiles(oldDirectory)
  await mkdir(newDirectory, { mode: 0o700 })
  await writeFile(
    join(newDirectory, 'config.json'),
    JSON.stringify({
      version: 2,
      daemon: {
        engineUrl: 'https://engine.example',
        mintUrl,
        mintUrls: [mintUrl],
        autoRetireResolvedConditionInventory: false,
        assetMonitoringEnabled: false,
        nostrRelays: [],
      },
      cli: { trustedEngineUrls: [] },
    }),
    { mode: 0o600 },
  )
  await writeFile(seedFile, `${importedSeed}\n`, { mode: 0o600 })
  await writeFile(signerFile, `${importedSigner}\n`, { mode: 0o600 })
  // Set the exact owner-only mode even when the test runner has a restrictive umask.
  await chmod(seedFile, 0o600)
  await chmod(signerFile, 0o600)
  const preload = mockMintPreload(requestLog, root)
  const run = async (selected: string, ignored: string, args: string[]) => {
    const result = await execute(
      process.execPath,
      [
        '--experimental-strip-types',
        join(import.meta.dirname, '../src/main.ts'),
        '--datadir',
        selected,
        ...args,
      ],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: `--max-old-space-size=4096 --import=${preload}`,
          NODE_NO_WARNINGS: '1',
          BITCASTER_DAEMON_HOME: ignored,
          BITCASTER_DAEMON_PASSPHRASE: '',
        },
        timeout: 30_000,
        maxBuffer: 128 * 1024,
      },
    )
    assertRedacted(result.stdout + result.stderr)
    return result
  }
  return { oldDirectory, newDirectory, requestLog, seedFile, signerFile, oldProfile, oldFiles, run }
}

async function profileFiles(
  directory: string,
): Promise<Record<string, { mode: number; byteLength: number; sha256: string }>> {
  const files: Record<string, { mode: number; byteLength: number; sha256: string }> = {}
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name)
    const metadata = await stat(path)
    assert.ok(metadata.isFile(), 'Profile fixture must contain only regular files')
    const bytes = await readFile(path)
    files[name] = {
      mode: metadata.mode & 0o777,
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  }
  return files
}

function assertRedacted(output: string): void {
  for (const secret of [oldSeed, importedSeed, oldSigner, importedSigner]) {
    assert.equal(output.includes(secret), false, 'CLI exposed a private fixture input')
  }
}

function insertPreparedWork(
  database: Awaited<ReturnType<typeof openDaemonStateSqlite>>,
  scopeId: string,
): void {
  for (const [id, kind] of [
    ['10'.repeat(32), 'exact-request'],
    ['20'.repeat(32), 'output-plan'],
  ]) {
    database
      .prepare(
        `INSERT INTO custody_artifacts (
      artifact_id, scope_id, artifact_kind, encoding, body, fingerprint,
      revision, private_material, created_at_ms
    ) VALUES (?, ?, ?, 'canonical-json', ?, ?, 0, 0, 0)`,
      )
      .run(id!, scopeId, kind!, Buffer.from('{}'), 'ff'.repeat(32))
  }
  database
    .prepare(
      `INSERT INTO target_proof_operations (
    operation_id, scope_id, kind, purpose, state, normalized_mint,
    request_artifact_id, output_artifact_id, result_artifact_id,
    result_proofs_digest, input_count, input_amount, last_error,
    reservation_id, created_at_ms, updated_at_ms
  ) VALUES ('prepared-profile-work', ?, 'wallet-send', 'wallet-send', 'prepared',
    'https://mint.example', ?, ?, NULL, NULL, 0, 0, NULL, NULL, 0, 0)`,
    )
    .run(scopeId, '10'.repeat(32), '20'.repeat(32))
}

function mockMintPreload(requestLog: string, fixtureHome: string): string {
  const keys = {
    '1': Buffer.from(secp256k1.getPublicKey(Buffer.from('05'.repeat(32), 'hex'), true)).toString(
      'hex',
    ),
  }
  const keyset = { id: deriveKeysetId(keys, { unit: 'msat', versionByte: 1 }), unit: 'msat', keys }
  return (
    'data:text/javascript,' +
    encodeURIComponent(`
    import net from 'node:net';
    import dgram from 'node:dgram';
    import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    import { appendFileSync } from 'node:fs';
    const forbidden = () => { throw Error('Socket I/O is forbidden in wallet profile evidence'); };
    net.Socket.prototype.connect = forbidden;
    dgram.createSocket = forbidden;
    os.homedir = () => ${JSON.stringify(fixtureHome)};
    syncBuiltinESMExports();
    globalThis.WebSocket = class { constructor() { forbidden(); } };
    const keyset = ${JSON.stringify(keyset)};
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
      if (url.origin !== ${JSON.stringify(mintUrl)} || url.search) forbidden();
      const path = url.pathname;
      const method = init.method ?? 'GET';
      let body;
      let outputCount;
      if (path === '/v1/info' && method === 'GET') body = { name: 'mock mint', nuts: {} };
      else if (path === '/v1/keysets' && method === 'GET') body = { keysets: [{ id: keyset.id, unit: 'msat', active: true, input_fee_ppk: 0 }] };
      else if ((path === '/v1/keys' || path === '/v1/keys/' + keyset.id) && method === 'GET') body = { keysets: [keyset] };
      else if (path === '/v1/conditional_keysets' && method === 'GET') body = { keysets: [] };
      else if (path === '/v1/restore' && method === 'POST') {
        const payload = JSON.parse(init.body);
        if (!Array.isArray(payload.outputs) || payload.outputs.some(output => output.id !== keyset.id)) forbidden();
        outputCount = payload.outputs.length;
        body = { outputs: [], signatures: [] };
      } else forbidden();
      appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify({ path, method, outputCount }) + '\\n');
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  `)
  )
}
