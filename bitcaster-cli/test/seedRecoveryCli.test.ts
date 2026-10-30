import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { bootstrapFreshDaemonProfile } from '../../bitcaster-daemon/src/profileBootstrap.ts'
import test from 'node:test'

test('recover-seed accepts only acknowledged owner-private seed-file input', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-recovery-'))
  try {
    await writeFile(
      join(home, 'config.json'),
      `${JSON.stringify({
        version: 2,
        daemon: {
          engineUrl: 'http://localhost:5000',
          mintUrl: 'http://localhost:8085',
          mintUrls: ['http://localhost:8085'],
          autoRetireResolvedConditionInventory: false,
          assetMonitoringEnabled: false,
          nostrRelays: [],
        },
        cli: { trustedEngineUrls: [] },
      })}\n`,
      { mode: 0o600 },
    )
    const seedPath = join(home, 'wallet-seed.hex')
    const seed = 'ab'.repeat(64)
    await writeFile(seedPath, `${seed}\n`, { mode: 0o600 })
    const result = await runCli(home, [
      '--dry-run',
      'wallet',
      'recover-seed',
      '--wallet-seed-hex-file',
      seedPath,
      '--recovery-id',
      'recovery-1',
      '--mint',
      'https://mint.example',
      '--unit',
      'msat',
      '--acknowledge-seed-disclosure',
    ])
    assert.equal(result.code, 0)
    assert.match(result.stdout, /"recoveryId": "recovery-1"/)
    assert.doesNotMatch(result.stdout, /walletSeedHex/)
    assert.doesNotMatch(result.stdout, new RegExp(seed))

    const phrase =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    const phrasePath = join(home, 'recovery-phrase.txt')
    await writeFile(phrasePath, `${phrase}\n`, { mode: 0o600 })
    const phraseResult = await runCli(home, [
      '--dry-run',
      'wallet',
      'recover-seed',
      '--recovery-phrase-file',
      phrasePath,
      '--recovery-id',
      'phrase-recovery',
      '--mint',
      'https://mint.example',
      '--acknowledge-seed-disclosure',
    ])
    assert.equal(phraseResult.code, 0)
    assert.match(phraseResult.stdout, /"recoveryId": "phrase-recovery"/)
    assert.doesNotMatch(phraseResult.stdout, /walletSeedHex/)
    assert.doesNotMatch(phraseResult.stdout, new RegExp(phrase.split(' ')[0]))

    const invalidPhrasePath = join(home, 'invalid-recovery-phrase.txt')
    await writeFile(invalidPhrasePath, `${phrase.replace(/about$/, 'abandon')}\n`, { mode: 0o600 })
    const invalidPhrase = await runCli(home, [
      '--dry-run',
      'wallet',
      'recover-seed',
      '--recovery-phrase-file',
      invalidPhrasePath,
      '--recovery-id',
      'invalid-phrase',
      '--mint',
      'https://mint.example',
      '--acknowledge-seed-disclosure',
    ])
    assert.notEqual(invalidPhrase.code, 0)
    assert.match(invalidPhrase.stderr, /valid English BIP-39 mnemonic/)
    assert.doesNotMatch(`${invalidPhrase.stdout}\n${invalidPhrase.stderr}`, /abandon/)

    const ambiguousPhrase = await runCli(home, [
      '--dry-run',
      'wallet',
      'recover-seed',
      '--wallet-seed-hex-file',
      seedPath,
      '--recovery-phrase-file',
      phrasePath,
      '--recovery-id',
      'ambiguous',
      '--mint',
      'https://mint.example',
      '--acknowledge-seed-disclosure',
    ])
    assert.notEqual(ambiguousPhrase.code, 0)
    assert.match(
      ambiguousPhrase.stderr,
      /exactly one of --wallet-seed-hex-file or --recovery-phrase-file/,
    )

    const defaults = [
      '--dry-run',
      'wallet',
      'recover-seed',
      '--wallet-seed-hex-file',
      seedPath,
      '--recovery-id',
      'policy-default',
      '--mint',
      'https://mint.example',
      '--acknowledge-seed-disclosure',
    ]
    const defaultResult = await runCli(home, defaults)
    assert.equal(defaultResult.code, 0)
    assert.match(defaultResult.stdout, /"scope": "regular-msat"/)
    assert.match(defaultResult.stdout, /"gapLimit": 300/)
    const deeper = await runCli(home, [...defaults, '--gap-limit', '701'])
    assert.equal(deeper.code, 0)
    assert.match(deeper.stdout, /"gapLimit": 701/)
    for (const value of ['0', '-1', '1.5', '01', '2147483649']) {
      assert.notEqual((await runCli(home, [...defaults, '--gap-limit', value])).code, 0)
    }
    const condition = await runCli(home, [...defaults, '--condition-id', 'ab'.repeat(32)])
    assert.equal(condition.code, 0)
    assert.match(condition.stdout, /"scope": "condition"/)
    assert.match(condition.stdout, /"conditionId": "abababab/)
    assert.doesNotMatch(condition.stdout, new RegExp(seed))

    const offline = await recoveryCli(home, seedPath, false)
    assert.notEqual(offline.code, 0)
    assert.doesNotMatch(`${offline.stdout}\n${offline.stderr}`, /daemon not reachable/i)
    assert.equal(existsSync(join(home, 'daemon-autostart.pid')), false)

    const noAcknowledgement = await runCli(home, [
      '--dry-run',
      'wallet',
      'recover-seed',
      '--wallet-seed-hex-file',
      seedPath,
      '--recovery-id',
      'recovery-2',
      '--mint',
      'https://mint.example',
      '--unit',
      'msat',
    ])
    assert.notEqual(noAcknowledgement.code, 0)
    assert.match(noAcknowledgement.stderr, /acknowledge-seed-disclosure/)

    await chmod(seedPath, 0o640)
    const readable = await recoveryCli(home, seedPath)
    assert.notEqual(readable.code, 0)
    assert.match(readable.stderr, /group or other users/)

    await chmod(seedPath, 0o600)
    await chmod(phrasePath, 0o640)
    const readablePhrase = await runCli(home, [
      '--dry-run',
      'wallet',
      'recover-seed',
      '--recovery-phrase-file',
      phrasePath,
      '--recovery-id',
      'phrase-permission',
      '--mint',
      'https://mint.example',
      '--acknowledge-seed-disclosure',
    ])
    assert.notEqual(readablePhrase.code, 0)
    assert.match(readablePhrase.stderr, /group or other users/)
    await chmod(phrasePath, 0o600)
    const linkPath = join(home, 'wallet-seed-link.hex')
    await symlink(seedPath, linkPath)
    const linked = await recoveryCli(home, linkPath)
    assert.notEqual(linked.code, 0)
    assert.match(linked.stderr, /ELOOP|symbolic/i)
    const phraseLinkPath = join(home, 'recovery-phrase-link.txt')
    await symlink(phrasePath, phraseLinkPath)
    const linkedPhrase = await runCli(home, [
      '--dry-run',
      'wallet',
      'recover-seed',
      '--recovery-phrase-file',
      phraseLinkPath,
      '--recovery-id',
      'phrase-symlink',
      '--mint',
      'https://mint.example',
      '--acknowledge-seed-disclosure',
    ])
    assert.notEqual(linkedPhrase.code, 0)
    assert.match(linkedPhrase.stderr, /ELOOP|symbolic/i)

    const argvSecret = await runCli(home, [
      'wallet',
      'recover-seed',
      '--wallet-seed-hex-file',
      seedPath,
      '--recovery-id',
      'recovery-argv-rejected',
      '--mint',
      'https://mint.example',
      '--unit',
      'msat',
      '--acknowledge-seed-disclosure',
      '--wallet-seed-hex',
      seed,
    ])
    assert.notEqual(argvSecret.code, 0)
    const argvOutput = `${argvSecret.stdout}\n${argvSecret.stderr}`
    assert.match(argvOutput, /unknown option/)
    assert.doesNotMatch(argvOutput, new RegExp(seed))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('recover-seed rejects the sat product unit', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-recovery-sat-'))
  try {
    await writeFile(
      join(home, 'config.json'),
      `${JSON.stringify({
        version: 2,
        daemon: {
          engineUrl: 'http://localhost:5000',
          mintUrl: 'http://localhost:8085',
          mintUrls: ['http://localhost:8085'],
          autoRetireResolvedConditionInventory: false,
          assetMonitoringEnabled: false,
          nostrRelays: [],
        },
        cli: { trustedEngineUrls: [] },
      })}\n`,
      { mode: 0o600 },
    )
    const result = await runCli(home, [
      '--dry-run',
      'wallet',
      'recover-seed',
      '--wallet-seed-hex-file',
      join(home, 'missing-seed.hex'),
      '--recovery-id',
      'recovery-sat',
      '--mint',
      'https://mint.example',
      '--unit',
      'sat',
      '--acknowledge-seed-disclosure',
    ])
    assert.notEqual(result.code, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /unit must be msat/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('recover-seed help requires a stable recovery job id across invocations', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-recovery-help-'))
  try {
    const result = await runCli(home, ['wallet', 'recover-seed', '--help'])
    assert.equal(result.code, 0)
    assert.match(result.stdout, /Stable recovery job id/)
    assert.match(result.stdout, /Reuse it for later\s+invocations until recovery completes/)
    assert.doesNotMatch(result.stdout, /keyset-id/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('real CLI forwards condition and gap to the daemon capability-gated transport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-cli-scoped-'))
  const conditionId = 'ab'.repeat(32)
  try {
    const seedPath = join(root, 'seed.hex')
    await writeFile(seedPath, '07'.repeat(64), { mode: 0o600 })
    for (const supported of [false, true]) {
      const home = join(root, String(supported))
      await bootstrapFreshDaemonProfile({
        directory: home,
        engineBaseUrl: 'https://engine.example',
        mintUrl: 'https://mint.example',
        walletSeedHex: '07'.repeat(64),
        nostrSecretKeyHex: 'aa'.repeat(32),
        initializedAtMs: 1,
      })
      const log = join(root, `requests-${supported}.jsonl`)
      const loader = join(root, `fetch-${supported}.mjs`)
      await writeFile(
        loader,
        `
        import { appendFileSync } from 'node:fs';
        globalThis.fetch = async (input) => {
          const url = new URL(String(input));
          if (url.origin !== 'https://mint.example') throw new Error('unexpected mint');
          appendFileSync(${JSON.stringify(log)}, JSON.stringify({ path: url.pathname, condition: url.searchParams.get('condition_id') }) + '\\n');
          if (url.pathname === '/v1/info') return Response.json({ nuts: { CTF: { condition_keyset_filter: ${supported} } } });
          if (url.pathname !== '/v1/conditional_keysets' || url.searchParams.get('condition_id') !== '${conditionId}' || url.searchParams.has('active')) throw new Error('unscoped request');
          return Response.json({ keysets: [], next_cursor: null });
        };
      `,
        { mode: 0o600 },
      )
      const result = await runCli(
        home,
        [
          'wallet',
          'recover-seed',
          '--wallet-seed-hex-file',
          seedPath,
          '--recovery-id',
          'scope-forwarding',
          '--mint',
          'https://mint.example',
          '--acknowledge-seed-disclosure',
          '--condition-id',
          conditionId,
          '--gap-limit',
          '701',
        ],
        { NODE_OPTIONS: `--import=${pathToFileURL(loader).href}` },
        root,
      )
      assert.equal(existsSync(log), true, result.stderr)
      const requests = (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      if (supported) {
        assert.equal(result.code, 0, result.stderr)
        assert.ok(
          requests.some(
            (row) => row.path === '/v1/conditional_keysets' && row.condition === conditionId,
          ),
        )
        assert.match(result.stdout, /"gapLimit":\s*701/)
        assert.match(result.stdout, /"scope":\s*"condition"/)
        const database = new DatabaseSync(join(home, 'daemon-state.sqlite'), { readOnly: true })
        try {
          const row = database
            .prepare(
              `SELECT scan_scope, condition_selector, gap_limit, state
            FROM seed_recovery_jobs WHERE recovery_id = ?`,
            )
            .get('scope-forwarding')
          assert.deepEqual(
            { ...row },
            {
              scan_scope: 'condition',
              condition_selector: conditionId,
              gap_limit: 701,
              state: 'completed',
            },
          )
        } finally {
          database.close()
        }
      } else {
        assert.notEqual(result.code, 0)
        assert.match(result.stderr, /condition_keyset_filter support/)
        assert.deepEqual(requests, [{ path: '/v1/info', condition: null }])
      }
      assert.doesNotMatch(result.stdout + result.stderr, /0707070707070707/)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function recoveryCli(home: string, seedPath: string, dryRun = true) {
  return runCli(home, [
    ...(dryRun ? ['--dry-run'] : []),
    'wallet',
    'recover-seed',
    '--wallet-seed-hex-file',
    seedPath,
    '--recovery-id',
    'recovery-private',
    '--mint',
    'https://mint.example',
    '--unit',
    'msat',
    '--acknowledge-seed-disclosure',
  ])
}

async function runCli(
  home: string,
  args: readonly string[],
  extraEnv: Record<string, string> = {},
  outputDirectory = home,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...extraEnv }
  delete childEnv.NODE_TEST_CONTEXT
  const stdoutPath = join(outputDirectory, `stdout-${Date.now()}-${Math.random()}`)
  const stderrPath = join(outputDirectory, `stderr-${Date.now()}-${Math.random()}`)
  const stdoutFile = await open(stdoutPath, 'wx', 0o600)
  const stderrFile = await open(stderrPath, 'wx', 0o600)
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      join(import.meta.dirname, '..', 'src', 'main.ts'),
      '--datadir',
      home,
      ...args,
    ],
    {
      cwd: join(import.meta.dirname, '..'),
      env: childEnv,
      stdio: ['ignore', stdoutFile.fd, stderrFile.fd],
    },
  )
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode) => resolve(exitCode ?? 1))
  })
  await Promise.all([stdoutFile.close(), stderrFile.close()])
  const [stdout, stderr] = await Promise.all([
    readFile(stdoutPath, 'utf8'),
    readFile(stderrPath, 'utf8'),
  ])
  return { code, stdout, stderr }
}
