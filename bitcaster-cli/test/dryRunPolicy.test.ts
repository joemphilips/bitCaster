import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { Command } from 'commander'
import { applyDryRunModes, dryRunRefusal, unreadDryRunRefusal } from '../src/dryRunPolicy.ts'

const execFileAsync = promisify(execFile)
const MAIN = join(import.meta.dirname, '..', 'src', 'main.ts')
const TREE_PRELOAD = join(import.meta.dirname, 'dryRunTreePreload.mjs')

// These commands change no funds, orders, markets, keys, or settings, so they
// run normally with --dry-run. Every other command must preview or refuse.
const READ_ONLY_COMMANDS = [
  'completion',
  'config get',
  'config list',
  'config path',
  'daemon logs',
  'daemon status',
  'health',
  'market',
  'market attestation',
  'market comments',
  'market creation-quote',
  'market creation-status',
  'market creator',
  'market funding',
  'market funding-head',
  'market funding-quote',
  'market history',
  'market list',
  'market oracle-backup-list',
  'market oracle-backup-status',
  'market resolution-status',
  'market show',
  'mint info',
  'mint list',
  'order book',
  'order capacity',
  'order fee-preview',
  'order list',
  'order preview',
  'order recovery',
  'order status',
  'order wait',
  'relay list',
  'score show',
  'score status',
  'signer show',
  'wallet assets',
  'wallet balance',
  'wallet invoice show',
  'wallet operations',
  'wallet pay status',
  'wallet portfolio',
  'wallet positions',
]

test('every CLI command declares its dry-run mode', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--experimental-strip-types', '--import', TREE_PRELOAD, MAIN],
    { env: { ...process.env, NODE_NO_WARNINGS: '1' } },
  )
  const commands = JSON.parse(stdout) as Array<{
    path: string
    hasAction: boolean
    mode: string | null
  }>
  const actionable = commands.filter((command) => command.hasAction)
  assert.ok(actionable.length > 90, 'the walk must reach the registered command tree')
  assert.deepEqual(
    actionable.filter((command) => command.mode === null).map((command) => command.path),
    [],
  )
  const withMode = (mode: string) =>
    actionable
      .filter((command) => command.mode === mode)
      .map((command) => command.path)
      .sort()
  assert.deepEqual(withMode('refused'), ['daemon init', 'daemon restart', 'daemon stop'])
  assert.deepEqual(withMode('read-only'), READ_ONLY_COMMANDS)
  for (const path of [
    'market fund begin',
    'market fund resume',
    'wallet receive',
    'order cancel',
    'order retry',
  ])
    assert.ok(withMode('supported').includes(path), path)
})

test('a command with an action and no dry-run declaration fails CLI startup', () => {
  const program = new Command('bitcaster-cli')
  program.command('health').action(() => {})
  program
    .command('wallet')
    .command('send <amount>')
    .action(() => {})
  program
    .command('market')
    .action(() => {})
    .command('list')
    .action(() => {})
  assert.throws(
    () => applyDryRunModes(program, { health: 'read-only', 'market list': 'read-only' }),
    {
      message:
        'Command has no --dry-run declaration: wallet send\n' +
        'Command has no --dry-run declaration: market',
    },
  )
})

test('a dry-run declaration that names no command fails CLI startup', () => {
  const program = new Command('bitcaster-cli')
  program.command('health').action(() => {})
  assert.throws(
    () => applyDryRunModes(program, { health: 'read-only', 'wallet send': 'supported' }),
    { message: '--dry-run declaration names no command: wallet send' },
  )
})

test('the declared mode decides whether --dry-run may reach the command action', () => {
  const program = new Command('bitcaster-cli')
  const balance = program.command('balance').action(() => {})
  const send = program.command('send').action(() => {})
  const init = program
    .command('daemon')
    .command('init')
    .action(() => {})
  applyDryRunModes(program, { balance: 'read-only', send: 'supported', 'daemon init': 'refused' })
  assert.equal(dryRunRefusal(balance), null)
  assert.equal(dryRunRefusal(send), null)
  assert.equal(
    dryRunRefusal(init),
    'bitcaster-cli daemon init refuses --dry-run. It cannot show its effect without acting. Nothing was changed.',
  )
  const undeclared = new Command('bitcaster-cli').command('stray').action(() => {})
  assert.equal(
    dryRunRefusal(undeclared),
    'bitcaster-cli stray has no --dry-run declaration, so --dry-run is refused. Nothing was changed.',
  )
})

test('an executable subcommand fails CLI startup because it bypasses the guard', () => {
  const program = new Command('bitcaster-cli')
  program.command('health').action(() => {})
  // A description argument makes Commander run a separate executable.
  program.command('plugin', 'Run bitcaster-cli-plugin')
  assert.throws(() => applyDryRunModes(program, { health: 'read-only' }), {
    message: 'Executable subcommand bypasses the --dry-run guard: plugin',
  })
})

test('a --dry-run token that the option parser did not read is refused', () => {
  const refusal =
    'bitcaster-cli did not read --dry-run as an option. Put --dry-run before any "--" and give it no value. Nothing was changed.'
  assert.equal(
    unreadDryRunRefusal(['order', 'cancel', 'm', 'o', '--', '--dry-run'], false),
    refusal,
  )
  assert.equal(unreadDryRunRefusal(['wallet', 'send', '25', '--', '--dry-run=1'], false), refusal)
  assert.equal(unreadDryRunRefusal(['--dry-run', 'wallet', 'send', '25'], true), null)
  assert.equal(unreadDryRunRefusal(['wallet', 'send', '25', '--dry-runner'], false), null)
  assert.equal(unreadDryRunRefusal(['wallet', 'send', '25'], false), null)
})
