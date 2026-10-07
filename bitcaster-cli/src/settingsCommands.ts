import { type Command } from 'commander'
import { normalizeEndpointUrl } from '@bitcaster-market/client-sdk'
import { normalizeNostrRelayUrl } from '@bitcaster-market/client-sdk/nostrRelays'
import {
  addNativeMint,
  addNativeRelay,
  listNativeMints,
  listNativeRelays,
  removeNativeMint,
  removeNativeRelay,
  selectNativeMint,
  type NativeSettingsOptions,
} from '@bitcaster-market/daemon/nativeSettings'
import type { NativeConfigSnapshot } from '@bitcaster-market/daemon/nativeConfig'
import { isCliSpawnedDaemonRunning, restartDaemon } from './rpc.ts'

export function registerSettingsCommands(program: Command, mint: Command): void {
  mint
    .command('list')
    .description('List saved mints and the selected mint without network access.')
    .action(() => printJson(listNativeMints()))
  const mintUrl = (url: string) => normalizeEndpointUrl(url, 'mint URL')
  registerMutation(
    mint,
    'add',
    'Add and select an msat mint.',
    addNativeMint,
    mintUrl,
    listNativeMints,
  )
  registerMutation(
    mint,
    'select',
    'Select a saved msat mint.',
    selectNativeMint,
    mintUrl,
    listNativeMints,
  )
  registerMutation(
    mint,
    'remove',
    'Remove a saved mint from configuration.',
    removeNativeMint,
    mintUrl,
    listNativeMints,
  )

  const relay = program.command('relay').description('Manage saved Nostr relay destinations.')
  relay
    .command('list')
    .description('List saved relays without network access.')
    .action(() => printJson(listNativeRelays()))
  registerMutation(
    relay,
    'add',
    'Add a Nostr relay.',
    addNativeRelay,
    normalizeNostrRelayUrl,
    listNativeRelays,
  )
  registerMutation(
    relay,
    'remove',
    'Remove a Nostr relay.',
    removeNativeRelay,
    normalizeNostrRelayUrl,
    listNativeRelays,
  )
}

type SettingsMutation = (
  url: string,
  options: NativeSettingsOptions,
) => NativeConfigSnapshot | Promise<NativeConfigSnapshot>

function registerMutation(
  parent: Command,
  name: string,
  description: string,
  operation: SettingsMutation,
  normalizeUrl: (url: string) => string,
  readSettings: (options: NativeSettingsOptions) => unknown,
): void {
  parent
    .command(`${name} <url>`)
    .description(description)
    .option(
      '--expected-revision <revision>',
      'Require this saved revision. Use missing for a new config.',
      parseRevision,
    )
    .addHelpText(
      'after',
      '\nSaved settings apply through daemon restart. Stored funds and recovery destinations remain unchanged.',
    )
    .action(async (value: string, options: { expectedRevision?: string }, command: Command) => {
      const url = normalizeUrl(value)
      const settingsOptions: NativeSettingsOptions =
        options.expectedRevision === undefined
          ? {}
          : {
              expectedRevision:
                options.expectedRevision === 'missing' ? null : options.expectedRevision,
            }
      if (command.optsWithGlobals<{ dryRun?: boolean }>().dryRun === true) {
        readSettings(settingsOptions)
        printJson({
          dryRun: true,
          method: `${parent.name()}.${name}`,
          params: { url, ...settingsOptions },
        })
        return
      }
      const snapshot = await operation(url, settingsOptions)
      const daemonRestarted = await applySavedSettings()
      printJson({
        ok: true,
        result: { config: snapshot.config, revision: snapshot.revision, daemonRestarted },
      })
    })
}

export async function applySavedSettings(): Promise<boolean> {
  if (await isCliSpawnedDaemonRunning()) {
    await restartDaemon()
    process.stderr.write('config.json updated; daemon restarted\n')
    return true
  }
  process.stderr.write('config.json updated; restart bitcaster-daemon to apply changes\n')
  return false
}

function parseRevision(value: string): string {
  if (value === 'missing') return value
  if (!/^[0-9a-f]{64}$/.test(value))
    throw new Error('expected revision must be 64 lowercase hex characters or missing')
  return value
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}
