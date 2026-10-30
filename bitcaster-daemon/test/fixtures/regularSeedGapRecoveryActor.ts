// Parent E2E actor. Secret-bearing child output never leaves this process.
import assert from 'node:assert/strict'
import { ownedRecoveryCommand } from './ownedRecoveryCommand.ts'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Mint, Wallet, createEphemeralCounterSource } from '@cashu/cashu-ts'
import { seedRecoveryMnemonicBytes } from '../../../bitcaster-client-sdk/src/seedRecoveryMnemonic.ts'
import { deserializeDurableCustodyProofArtifact } from '../../../bitcaster-client-sdk/src/durableCustodyProofMaterial.ts'
import { configureDataDir } from '../../src/dataDir.ts'
import { readAvailableWalletProofPage } from '../../src/state.ts'

const [mintUrl, inputDirectory, home] = process.argv.slice(2)
const repo = resolve(import.meta.dirname, '../../..')
let stage = 'input'

async function command(script: string, args: string[]): Promise<any> {
  const output = await ownedRecoveryCommand(
    process.execPath,
    ['--experimental-strip-types', join(repo, script), '--datadir', home, ...args],
    repo,
    60_000,
  )
  return script.includes('daemon') || !output.trim() ? null : JSON.parse(output)
}

const cli = (args: string[]) => command('bitcaster-cli/src/main.ts', args)

async function main(): Promise<void> {
  configureDataDir(home)
  const phraseFile = join(inputDirectory, 'wallet-phrase.txt')
  const seed = seedRecoveryMnemonicBytes(await readFile(phraseFile, 'utf8'))
  const mint = new Mint(mintUrl)
  const discovery = new Wallet(mint, { unit: 'msat' })
  stage = 'issuance'
  await discovery.loadMint()
  const keyset = discovery.keyChain.getKeyset().id
  // Six unsigned positions model abandoned requests. Only counter six is signed.
  const wallet = new Wallet(mint, {
    unit: 'msat',
    bip39seed: seed,
    counterSource: createEphemeralCounterSource({ [keyset]: 6 }),
  })
  await wallet.loadMint()
  const quote = await wallet.createMintQuote(8192)
  const deadline = Date.now() + 20_000
  while ((await wallet.checkMintQuote(quote.quote)).state !== 'PAID') {
    assert.ok(Date.now() < deadline, 'owned FakeWallet payment deadline')
    // The test backend has no payment completion signal. Observe actual quote state.
    await new Promise((done) => setTimeout(done, 100))
  }
  const issued = await wallet.mintProofs(8192, quote.quote)
  assert.equal(issued.length, 1)
  assert.equal((await wallet.counters.snapshot())[keyset], 7)

  stage = 'fresh-profile'
  const seedFile = join(inputDirectory, 'wallet-seed.hex')
  await writeFile(seedFile, Buffer.from(seed).toString('hex'), { mode: 0o600, flag: 'wx' })
  await cli(['config', 'set', '--engine-url', 'http://127.0.0.1:1', '--mint-url', mintUrl])
  await command('bitcaster-daemon/src/main.ts', [
    'init',
    '--wallet-seed-hex-file',
    seedFile,
    '--nostr-secret-key-hex-file',
    join(inputDirectory, 'nostr-secret-key.hex'),
  ])
  const signer = await cli(['signer', 'show'])
  await cli(['signer', 'disconnect', '--expected-revision', String(signer.revision)])
  const page = () =>
    readAvailableWalletProofPage({
      mintUrl,
      keysetId: keyset,
      asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
      limit: 16,
    })
  assert.equal((await page()).proofs.length, 0)
  const recover = async (id: string, gap: number) => {
    let result: any
    for (let call = 0; call < 4; call++) {
      result = await cli([
        'wallet',
        'recover-seed',
        '--recovery-phrase-file',
        phraseFile,
        '--recovery-id',
        id,
        '--mint',
        mintUrl,
        '--unit',
        'msat',
        '--gap-limit',
        String(gap),
        '--acknowledge-seed-disclosure',
      ])
      if (result.state !== 'active') break
    }
    assert.equal(result.state, 'completed')
    assert.equal(result.selectedKeysetCount, 1)
    return result
  }
  stage = 'initial-scan'
  const first = await recover('regular-gap-short', 2)
  assert.equal(first.scannedRanges[0].nextCounter, 2)
  assert.equal((await page()).proofs.length, 0)
  const repeated = await recover('regular-gap-short', 2)
  assert.deepEqual(repeated.scannedRanges, first.scannedRanges)
  assert.equal(repeated.batchesProcessed, 0)
  stage = 'deeper-scan'
  const deeper = await recover('regular-gap-deeper', 8)
  assert.equal(deeper.scannedRanges[0].nextCounter, 15)
  const recovered = await page()
  assert.equal(recovered.nextCursor, null)
  assert.equal(recovered.proofs.length, 1)
  const actual = recovered.proofs[0]!.proof
  assert.equal(actual.id, issued[0]!.id)
  assert.equal(actual.secret, issued[0]!.secret)
  assert.equal(actual.C, issued[0]!.C)
  assert.equal(String(actual.amount), '8192')
  stage = 'spend'
  // Use the recovered material, not the retained original issuance, in the mint swap.
  const recoveredProof = deserializeDurableCustodyProofArtifact({
    schemaVersion: 1,
    id: actual.id,
    C: actual.C,
    secret: actual.secret,
    amount: String(actual.amount),
    dleq: actual.dleq ?? null,
    p2pkE: actual.p2pk_e ?? null,
    witness: actual.witness ?? null,
  })
  const spent = await wallet.send(4096, [recoveredProof])
  assert.ok(spent.send.length > 0)
  const states = await wallet.checkProofsStates(issued)
  assert.equal(states[0]!.state, 'SPENT')
  process.stdout.write(
    '{"initialGapStopped":true,"deeperRecovered":true,"exactProof":true,"realSpend":true}\n',
  )
}

main().catch(() => {
  process.stderr.write(`fixture-failure stage=${stage} code=operation_failed\n`)
  process.exitCode = 1
})
