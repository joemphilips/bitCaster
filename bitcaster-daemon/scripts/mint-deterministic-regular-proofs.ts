#!/usr/bin/env node

import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import {
  Mint as CashuMint,
  Wallet as CashuWallet,
  type MintQuoteResponse,
  type PartialMintQuoteResponse,
} from '@cashu/cashu-ts'

const MAX_WALLET_SEED_FILE_BYTES = 256
const [, , mintUrl, rawAmount, ...options] = process.argv
const walletSeedHexFile = parseWalletSeedHexFile(options)
const amountSats = parseAmount(rawAmount)

const walletSeed = await readOwnerPrivateWalletSeedHexFile(walletSeedHexFile)
try {
  await mintDeterministicRegularProofs(mintUrl, amountSats, walletSeed)
  process.stdout.write('minted deterministic regular proofs\n')
} finally {
  walletSeed.fill(0)
}

function parseWalletSeedHexFile(options: readonly string[]): string {
  if (!mintUrl || !rawAmount || options.length !== 2 || options[0] !== '--wallet-seed-hex-file') {
    usage()
  }
  const path = options[1]
  if (!path) usage()
  return path
}

function parseAmount(value: string | undefined): number {
  const amount = Number(value)
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('amount must be a positive safe integer')
  }
  return amount
}

async function mintDeterministicRegularProofs(
  mintUrl: string,
  amountSats: number,
  walletSeed: Uint8Array,
): Promise<void> {
  const mint = new CashuMint(mintUrl)
  const keysets = await mint.getKeySets()
  const keyset = keysets.keysets.find(
    (candidate) =>
      candidate.active && candidate.unit === 'sat' && /^01[0-9a-f]{64}$/.test(candidate.id),
  )
  if (!keyset) {
    throw new Error('mint did not return an active NUT-02 V2 secp256k1 sat keyset')
  }

  const wallet = new CashuWallet(mint, {
    unit: 'sat',
    keysetId: keyset.id,
    bip39seed: walletSeed,
    secretsPolicy: 'deterministic',
  })
  await wallet.loadMint()
  const quote = await wallet.createMintQuote(amountSats)
  await waitForPaidQuote(wallet, quote)
  const proofs = await wallet.mintProofs(amountSats, quote.quote)
  if (proofs.length === 0 || proofs.some((proof) => proof.id !== keyset.id)) {
    throw new Error('mint did not return deterministic proofs for the selected V2 keyset')
  }
}

async function waitForPaidQuote(wallet: CashuWallet, quote: MintQuoteResponse): Promise<void> {
  const deadline = performance.now() + 20_000
  let last: PartialMintQuoteResponse | null = null
  while (performance.now() < deadline) {
    last = await wallet.checkMintQuote(quote.quote)
    if (last.state === 'PAID' || last.state === 'ISSUED') return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`mint quote was not paid by fakewallet; last state=${last?.state ?? 'unknown'}`)
}

async function readOwnerPrivateWalletSeedHexFile(path: string): Promise<Uint8Array> {
  if (process.platform === 'win32') {
    throw new Error(
      '--wallet-seed-hex-file is not supported on Windows until ACL validation exists',
    )
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) throw new Error('--wallet-seed-hex-file must name a regular file')
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error('--wallet-seed-hex-file must not be accessible by group or other users')
    }
    if (metadata.size > MAX_WALLET_SEED_FILE_BYTES) {
      throw new Error(`--wallet-seed-hex-file exceeds ${MAX_WALLET_SEED_FILE_BYTES} bytes`)
    }
    const seedHex = (await readBoundedFile(file)).toString('utf8').trim()
    if (!/^[0-9a-f]{128}$/.test(seedHex)) {
      throw new Error('wallet seed must be a 64-byte lowercase hex value')
    }
    return Uint8Array.from(Buffer.from(seedHex, 'hex'))
  } finally {
    await file.close()
  }
}

async function readBoundedFile(file: Awaited<ReturnType<typeof open>>): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  while (total <= MAX_WALLET_SEED_FILE_BYTES) {
    const remaining = MAX_WALLET_SEED_FILE_BYTES + 1 - total
    const buffer = Buffer.allocUnsafe(Math.min(64, remaining))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, total)
    if (bytesRead === 0) break
    chunks.push(buffer.subarray(0, bytesRead))
    total += bytesRead
  }
  if (total > MAX_WALLET_SEED_FILE_BYTES) {
    throw new Error(`--wallet-seed-hex-file exceeds ${MAX_WALLET_SEED_FILE_BYTES} bytes`)
  }
  return Buffer.concat(chunks, total)
}

function usage(): never {
  process.stderr.write(
    'Usage: mint-deterministic-regular-proofs.ts <mint-url> <amount-sats> ' +
      '--wallet-seed-hex-file <path>\n',
  )
  process.exit(1)
}
