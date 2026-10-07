import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { Command } from 'commander'
import { readNativeSignerProfile } from '@bitcaster-market/daemon/nativeSignerProfile'
import {
  decodePrivateNostrSignerKey,
  generatePrivateNostrSignerKey,
} from '@bitcaster-market/client-sdk'
import {
  disconnectDaemonSigner,
  readSecrets,
  readSelectedDaemonSigner,
  reconnectDaemonSigner,
  replaceDaemonSigner,
} from '@bitcaster-market/daemon/secrets'

interface SignerCommandContext {
  readonly isDryRun: () => boolean
}

export function registerSignerCommands(program: Command, context: SignerCommandContext): void {
  const signer = program
    .command('signer')
    .description('Manage the login signer without replacing the wallet.')
  signer
    .command('profile')
    .description(
      'Read and refresh public profile metadata from the selected relays. No stored cache.',
    )
    .action(async () => {
      if (context.isDryRun()) return print({ action: 'profile', dryRun: true })
      print(await readNativeSignerProfile())
    })
  signer
    .command('show')
    .description('Read public signer status. Never print its private key.')
    .action(async () => print(await readSelectedDaemonSigner()))
  for (const action of ['disconnect', 'connect'] as const) {
    signer
      .command(action)
      .description(
        `${action === 'connect' ? 'Enable' : 'Disable'} the saved signer. Stop the daemon first.`,
      )
      .requiredOption('--expected-revision <revision>', 'Revision returned by signer show')
      .action(async (options: { expectedRevision: string }) => {
        const revision = parseRevision(options.expectedRevision)
        if (context.isDryRun()) return print({ action, expectedRevision: revision, dryRun: true })
        print(
          await (action === 'connect'
            ? reconnectDaemonSigner(revision)
            : disconnectDaemonSigner(revision)),
        )
      })
  }
  signer
    .command('import')
    .description(
      'Import nsec, ncryptsec, or private hex from an owner-only file. Stop the daemon first.',
    )
    .requiredOption('--key-file <path>', 'Private key input file')
    .option(
      '--key-passphrase-file <path>',
      'Separate owner-only ncryptsec decryption passphrase file',
    )
    .requiredOption('--expected-revision <revision>', 'Revision returned by signer show')
    .action(
      async (options: {
        keyFile: string
        keyPassphraseFile?: string
        expectedRevision: string
      }) => {
        const expectedRevision = parseRevision(options.expectedRevision)
        const keyText = await readPrivateText(options.keyFile, 512)
        const passphrase =
          options.keyPassphraseFile === undefined
            ? undefined
            : (await readPrivateText(options.keyPassphraseFile, 4096)).replace(/\r?\n$/, '')
        const key = decodePrivateNostrSignerKey(keyText, passphrase)
        if (context.isDryRun())
          return print({
            action: 'import',
            expectedRevision,
            publicKeyHex: key.publicKeyHex,
            dryRun: true,
          })
        print(await replaceDaemonSigner({ expectedRevision, nostrSecretKeyHex: key.secretKeyHex }))
      },
    )
  signer
    .command('generate')
    .description(
      'Replace the signer with a new key. Back it up with signer export. Stop the daemon first.',
    )
    .requiredOption('--expected-revision <revision>', 'Revision returned by signer show')
    .action(async (options: { expectedRevision: string }) => {
      const expectedRevision = parseRevision(options.expectedRevision)
      if (context.isDryRun()) return print({ action: 'generate', expectedRevision, dryRun: true })
      print(
        await replaceDaemonSigner({
          expectedRevision,
          nostrSecretKeyHex: generatePrivateNostrSignerKey().secretKeyHex,
        }),
      )
    })
  signer
    .command('export')
    .description('Write the private nsec to a new owner-only file. Never print it.')
    .requiredOption(
      '--output-file <path>',
      'New private file; existing files are never overwritten',
    )
    .action(async (options: { outputFile: string }) => {
      if (context.isDryRun()) return print({ action: 'export', dryRun: true })
      const secrets = await readSecrets()
      if (secrets === null) throw new Error('Daemon signer is not initialized.')
      const key = decodePrivateNostrSignerKey(secrets.nostrSecretKeyHex)
      await writePrivateKey(options.outputFile, key.nsec)
      print({ publicKeyHex: key.publicKeyHex, exported: true })
    })
}

function parseRevision(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error('Signer revision must be a non-negative safe integer.')
  return Number(value)
}

async function readPrivateText(path: string, maxBytes: number): Promise<string> {
  assertPrivateFilesSupported()
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const metadata = await file.stat()
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid!())
      throw new Error('unsafe private input')
    const buffer = Buffer.alloc(maxBytes + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size)
      if (bytesRead === 0) break
      size += bytesRead
    }
    if (size === 0 || size > maxBytes) throw new Error('invalid private input size')
    return buffer.subarray(0, size).toString('utf8')
  } catch {
    throw new Error('Private input must be a readable, bounded, owner-only regular file.')
  } finally {
    await file?.close()
  }
}

async function writePrivateKey(path: string, nsec: string): Promise<void> {
  assertPrivateFilesSupported()
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    await file.writeFile(`${nsec}\n`, 'utf8')
    await file.sync()
  } catch {
    throw new Error('Private key export failed. Use a new private file path.')
  } finally {
    await file?.close()
  }
}

function assertPrivateFilesSupported(): void {
  if (process.platform === 'win32' || process.getuid === undefined)
    throw new Error('Private signer files require POSIX owner and permission checks.')
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}
