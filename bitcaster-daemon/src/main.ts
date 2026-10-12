#!/usr/bin/env node

import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { profileDir } from './profile.ts'
import { createDaemonSecrets, createDaemonSecretsFromImport } from './secrets.ts'
import { bootstrapFreshDaemonProfile } from './profileBootstrap.ts'
import { configureDataDir } from './dataDir.ts'
import { readNativeConfig } from './nativeConfig.ts'

const MAX_SECRET_HEX_FILE_BYTES = 256
const SECRET_FILE_READ_CHUNK_BYTES = 128

const { command, args, dataDir } = parseInvocation(process.argv.slice(2))
configureDataDir(dataDir)

switch (command) {
  case 'init': {
    const initOptions = parseInitOptions(args)
    const config = readNativeConfig(true).config
    const importedSecrets = await resolveImportedSecrets(initOptions)
    const secrets =
      importedSecrets === null
        ? createDaemonSecrets()
        : createDaemonSecretsFromImport({
            walletSeedHex: importedSecrets.walletSeedHex,
            nostrSecretKeyHex: importedSecrets.nostrSecretKeyHex,
          })
    await bootstrapFreshDaemonProfile({
      directory: profileDir(),
      engineBaseUrl: config.daemon.engineUrl,
      mintUrl: config.daemon.mintUrl,
      walletSeedHex: secrets.walletSeedHex,
      nostrSecretKeyHex: secrets.nostrSecretKeyHex,
      nostrPublicKeyHex: secrets.nostrPublicKeyHex,
      nativeOracleNonceSeedHex: secrets.nativeOracleNonceSeedHex,
      passphrase: process.env.BITCASTER_DAEMON_PASSPHRASE || undefined,
    })
    process.stdout.write('bitcaster-daemon profile initialized\n')
    break
  }
  case 'recover-seed': {
    const options = parseRecoverSeedOptions(args)
    const { runOfflineDaemonSeedRecovery } = await import('./emergencySeedRecovery.ts')
    const result = await runOfflineDaemonSeedRecovery(options)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    break
  }
  case 'run': {
    const { runDaemonRuntime } = await import('./daemonRuntime.ts')
    await runDaemonRuntime()
    break
  }
  default:
    process.stderr.write(`Unknown command: ${command}\n`)
    process.stderr.write(`Usage:
  bitcaster-daemon [--datadir <path>] init [--wallet-seed-hex-file <path>]
                         [--nostr-secret-key-hex-file <path>]
  bitcaster-daemon [--datadir <path>] recover-seed --wallet-seed-hex-file <path>
                         --recovery-id <id> --mint <url> --unit <msat>
                         --acknowledge-seed-disclosure
  bitcaster-daemon [--datadir <path>] run
`)
    process.exitCode = 1
}

function parseRecoverSeedOptions(args: readonly string[]): {
  recoveryId: string
  mintUrl: string
  unit: 'sat' | 'msat'
  walletSeedHexFile: string
  disclosureAcknowledged: true
} {
  let recoveryId: string | undefined
  let mintUrl: string | undefined
  let unit: 'sat' | 'msat' | undefined
  let walletSeedHexFile: string | undefined
  let disclosureAcknowledged = false
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    if (option === '--acknowledge-seed-disclosure') {
      disclosureAcknowledged = true
      continue
    }
    const value = requiredArg(args[++index], option ?? 'recover-seed option')
    if (option === '--recovery-id') recoveryId = value
    else if (option === '--mint') mintUrl = value
    else if (option === '--unit' && value === 'msat') unit = value
    else if (option === '--unit') throw new Error('recover-seed unit must be msat')
    else if (option === '--wallet-seed-hex-file') walletSeedHexFile = value
    else throw new Error(`Unknown recover-seed option: ${option}`)
  }
  if (!disclosureAcknowledged) {
    throw new Error('recover-seed requires --acknowledge-seed-disclosure')
  }
  if (unit === undefined) throw new Error('recover-seed unit must be msat')
  return {
    recoveryId: requiredArg(recoveryId, '--recovery-id'),
    mintUrl: requiredArg(mintUrl, '--mint'),
    unit,
    walletSeedHexFile: requiredArg(walletSeedHexFile, '--wallet-seed-hex-file'),
    disclosureAcknowledged: true,
  }
}

function parseInvocation(argv: string[]): {
  command: string
  args: string[]
  dataDir?: string
} {
  const args = [...argv]
  let dataDir: string | undefined
  if (args[0]?.startsWith('--datadir=')) {
    dataDir = requiredArg(args[0].slice('--datadir='.length), '--datadir')
    args.splice(0, 1)
  } else if (args[0] === '--datadir') {
    dataDir = requiredArg(args[1], '--datadir')
    args.splice(0, 2)
  }
  return {
    command: args.shift() ?? 'run',
    args,
    ...(dataDir === undefined ? {} : { dataDir }),
  }
}

function parseInitOptions(args: string[]): {
  walletSeedHexFile?: string
  nostrSecretKeyHexFile?: string
} {
  const options: {
    walletSeedHexFile?: string
    nostrSecretKeyHexFile?: string
  } = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--wallet-seed-hex-file') {
      options.walletSeedHexFile = requiredArg(args[++i], '--wallet-seed-hex-file')
    } else if (arg === '--nostr-secret-key-hex-file') {
      options.nostrSecretKeyHexFile = requiredArg(args[++i], '--nostr-secret-key-hex-file')
    } else {
      throw new Error(`Unknown init option: ${arg}`)
    }
  }
  return options
}

async function resolveImportedSecrets(options: {
  walletSeedHexFile?: string
  nostrSecretKeyHexFile?: string
}): Promise<{ walletSeedHex: string; nostrSecretKeyHex: string } | null> {
  const walletSeedHex = options.walletSeedHexFile
    ? await readSecretHexFile(options.walletSeedHexFile, '--wallet-seed-hex-file')
    : undefined
  const nostrSecretKeyHex = options.nostrSecretKeyHexFile
    ? await readSecretHexFile(options.nostrSecretKeyHexFile, '--nostr-secret-key-hex-file')
    : undefined
  if (!walletSeedHex && !nostrSecretKeyHex) return null
  if (!walletSeedHex || !nostrSecretKeyHex) {
    throw new Error(
      '--wallet-seed-hex-file and --nostr-secret-key-hex-file must be supplied together',
    )
  }
  return { walletSeedHex, nostrSecretKeyHex }
}

async function readSecretHexFile(path: string, option: string): Promise<string> {
  if (process.platform === 'win32') {
    throw new Error(
      `${option} is not supported on Windows until ACL and reparse-point validation is available`,
    )
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) throw new Error(`${option} must name a regular file`)
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error(`${option} must not be accessible by group or other users`)
    }
    if (metadata.size > MAX_SECRET_HEX_FILE_BYTES) {
      throw new Error(`${option} exceeds ${MAX_SECRET_HEX_FILE_BYTES} bytes`)
    }
    const value = (await readBoundedSecretFile(file, option)).toString('utf8').trim()
    if (!value) throw new Error(`${option} was empty`)
    return value
  } finally {
    await file.close()
  }
}

async function readBoundedSecretFile(
  file: Awaited<ReturnType<typeof open>>,
  option: string,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  while (total <= MAX_SECRET_HEX_FILE_BYTES) {
    const remaining = MAX_SECRET_HEX_FILE_BYTES + 1 - total
    const buffer = Buffer.allocUnsafe(Math.min(SECRET_FILE_READ_CHUNK_BYTES, remaining))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, total)
    if (bytesRead === 0) break
    chunks.push(buffer.subarray(0, bytesRead))
    total += bytesRead
  }
  if (total > MAX_SECRET_HEX_FILE_BYTES) {
    throw new Error(`${option} exceeds ${MAX_SECRET_HEX_FILE_BYTES} bytes`)
  }
  return Buffer.concat(chunks, total)
}

function requiredArg(value: string | undefined, option: string): string {
  if (value) return value
  throw new Error(`Missing value for ${option}`)
}
