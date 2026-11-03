import type { Command } from 'commander'

/**
 * How a command handles the global `--dry-run` option.
 *
 * - `read-only`: the command changes nothing, so it runs normally.
 * - `supported`: the command prints its intended operation and changes nothing.
 * - `refused`: the command cannot show its effect without acting, so `--dry-run`
 *   is a usage error before any action.
 */
export type DryRunMode = 'read-only' | 'supported' | 'refused'

/**
 * One declaration for each command that has an action. An agent can rely on
 * `--dry-run`, so the CLI refuses to start when a command has no declaration.
 * A `supported` command must check the flag before any daemon call, payment,
 * relay or engine write, or saved-state change.
 */
export const DRY_RUN_MODES: Readonly<Record<string, DryRunMode>> = {
  health: 'read-only',
  market: 'read-only',
  'market watch': 'supported',
  'market list': 'read-only',
  'market show': 'read-only',
  'market comments': 'read-only',
  'market history': 'read-only',
  'market attestation': 'read-only',
  'market creator': 'read-only',
  'market funding': 'read-only',
  'market funding-head': 'read-only',
  'market funding-quote': 'read-only',
  'market fund begin': 'supported',
  'market fund resume': 'supported',
  'market create': 'supported',
  'market creation-resume': 'supported',
  'market creation-status': 'read-only',
  'market creation-quote': 'read-only',
  'market oracle-backup-list': 'read-only',
  'market oracle-backup-restore': 'supported',
  'market oracle-backup-status': 'read-only',
  'market oracle-backup-retry': 'supported',
  'market announcement-republish': 'supported',
  'market resolution-status': 'read-only',
  'market close': 'supported',
  'market liked': 'supported',
  'market like': 'supported',
  'market unlike': 'supported',
  'mint info': 'read-only',
  'mint list': 'read-only',
  'mint add': 'supported',
  'mint select': 'supported',
  'mint remove': 'supported',
  'relay list': 'read-only',
  'relay add': 'supported',
  'relay remove': 'supported',
  'wallet request create': 'supported',
  'wallet request status': 'supported',
  'wallet request recover': 'supported',
  'wallet request list': 'supported',
  'wallet request watch': 'supported',
  'wallet activity': 'supported',
  'wallet activity-sync': 'supported',
  'wallet watch': 'supported',
  'wallet balance': 'read-only',
  'wallet positions': 'read-only',
  'wallet portfolio': 'read-only',
  'wallet assets': 'read-only',
  'wallet invoice create': 'supported',
  'wallet invoice show': 'read-only',
  'wallet invoice hide': 'supported',
  'wallet invoice replace': 'supported',
  'wallet pay quote': 'supported',
  'wallet pay execute': 'supported',
  'wallet pay status': 'read-only',
  'wallet receive': 'supported',
  'wallet recover-seed': 'supported',
  'wallet send': 'supported',
  'wallet reclaim': 'supported',
  'wallet split': 'supported',
  'wallet consolidate-proofs': 'supported',
  'wallet consolidate': 'supported',
  'wallet retire-condition': 'supported',
  'wallet claim': 'supported',
  'wallet remove-preview': 'supported',
  'wallet remove': 'supported',
  'wallet operations': 'read-only',
  'wallet recover': 'supported',
  'score show': 'read-only',
  'score quote': 'supported',
  'score buy': 'supported',
  'score status': 'read-only',
  'order preview': 'read-only',
  'order capacity': 'read-only',
  'order fee-preview': 'read-only',
  'order submit': 'supported',
  'order status': 'read-only',
  'order wait': 'read-only',
  'order list': 'read-only',
  'order cancel': 'supported',
  'order book': 'read-only',
  'daemon status': 'read-only',
  'daemon config': 'supported',
  'daemon stop': 'refused',
  'daemon restart': 'refused',
  'daemon logs': 'read-only',
  'daemon init': 'refused',
  'config get': 'read-only',
  'config set': 'supported',
  'config path': 'read-only',
  'config list': 'read-only',
  'signer profile': 'supported',
  'signer show': 'read-only',
  'signer disconnect': 'supported',
  'signer connect': 'supported',
  'signer import': 'supported',
  'signer generate': 'supported',
  'signer export': 'supported',
  completion: 'read-only',
}

const MODE_HELP: Readonly<Record<DryRunMode, string>> = {
  'read-only':
    'Dry run: read-only. This command does not change funds, orders, markets, keys, or settings. It runs normally with --dry-run. The daemon must already run, because a dry run never starts it.',
  supported:
    'Dry run: supported. With --dry-run, this command prints {"dryRun": true, "method", "params"} for the intended operation. It does not change funds, orders, markets, keys, or settings.',
  refused:
    'Dry run: refused. With --dry-run, this command stops with exit code 2 before it does anything.',
}

export const DRY_RUN_PROGRAM_HELP = `
Dry run:
  Each command help states how the command handles --dry-run.
  supported  prints {"dryRun": true, "method", "params"} and changes nothing
  read-only  runs normally; it changes no funds, orders, markets, keys, or settings
  refused    stops with exit code 2 before it acts
  With --dry-run, the CLI does not start bitcaster-daemon.
  Put --dry-run before any "--" and give it no value.`

// Never print bearer tokens, seeds, private keys, or authorization values.
const REDACTED_KEYS = new Set([
  'authorization',
  'nostrSecretKeyHex',
  'nsec',
  'secretKeyHex',
  'sig',
  'token',
  'walletSeedHex',
])

const declaredModes = new WeakMap<Command, DryRunMode>()

/** Return the space-separated subcommand path, without the program name. */
export function commandPath(command: Command): string {
  const names: string[] = []
  for (let current: Command | null = command; current?.parent; current = current.parent) {
    names.unshift(current.name())
  }
  return names.join(' ')
}

/**
 * Attach each declared mode and its help line. Throw when a command with an
 * action has no declaration, when a declaration names no such command, or when
 * an executable subcommand exists, because it bypasses the preAction guard.
 */
export function applyDryRunModes(
  program: Command,
  declarations: Readonly<Record<string, DryRunMode>> = DRY_RUN_MODES,
): void {
  const unmatched = new Set(Object.keys(declarations))
  const undeclared: string[] = []
  const executables: string[] = []
  for (const command of descendants(program)) {
    if (isExecutable(command)) {
      executables.push(commandPath(command))
      continue
    }
    if (!hasAction(command)) continue
    const path = commandPath(command)
    if (!Object.hasOwn(declarations, path)) {
      undeclared.push(path)
      continue
    }
    const mode = declarations[path]!
    unmatched.delete(path)
    declaredModes.set(command, mode)
    command.addHelpText('after', `\n${MODE_HELP[mode]}`)
  }
  if (undeclared.length > 0 || unmatched.size > 0 || executables.length > 0) {
    throw new Error(
      [
        ...executables.map((path) => `Executable subcommand bypasses the --dry-run guard: ${path}`),
        ...undeclared.map((path) => `Command has no --dry-run declaration: ${path}`),
        ...[...unmatched].map((path) => `--dry-run declaration names no command: ${path}`),
      ].join('\n'),
    )
  }
}

export function dryRunModeOf(command: Command): DryRunMode | undefined {
  return declaredModes.get(command)
}

/** Return the usage error for `--dry-run`, or null when the command may run. */
export function dryRunRefusal(command: Command): string | null {
  const mode = declaredModes.get(command)
  const path = `bitcaster-cli ${commandPath(command)}`
  switch (mode) {
    case 'read-only':
    case 'supported':
      return null
    case 'refused':
      return `${path} refuses --dry-run. It cannot show its effect without acting. Nothing was changed.`
    case undefined:
      // Fail closed: an undeclared command could act for real.
      return `${path} has no --dry-run declaration, so --dry-run is refused. Nothing was changed.`
  }
}

/**
 * Refuse a literal --dry-run token that the option parser did not read, for
 * example one after "--". Commander passes such a token to the action as an
 * operand, so the command would act for real.
 */
export function unreadDryRunRefusal(argv: readonly string[], dryRun: boolean): string | null {
  if (dryRun) return null
  if (!argv.some((arg) => arg === '--dry-run' || arg.startsWith('--dry-run='))) return null
  return 'bitcaster-cli did not read --dry-run as an option. Put --dry-run before any "--" and give it no value. Nothing was changed.'
}

/** Print one dry-run preview shape. Remove secret fields at every depth. */
export function printDryRun(method: string, params: unknown = {}): void {
  process.stdout.write(
    `${JSON.stringify({ dryRun: true, method, params: redact(params) }, null, 2)}\n`,
  )
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !REDACTED_KEYS.has(key))
      .map(([key, child]) => [key, redact(child)]),
  )
}

function descendants(command: Command): Command[] {
  return command.commands.flatMap((child) => [child, ...descendants(child)])
}

function hasAction(command: Command): boolean {
  // Commander 12 keeps the action in a private field. If a later release
  // removes the field, every group counts as an action and needs a
  // declaration, so the CLI fails at startup instead of skipping a command.
  const handler = (command as unknown as { _actionHandler?: unknown })._actionHandler
  return handler !== null
}

function isExecutable(command: Command): boolean {
  // `.command(name, description)` sets this private Commander 12 field. Such a
  // subcommand runs as a separate process without the preAction hooks.
  return (command as unknown as { _executableHandler?: unknown })._executableHandler === true
}
