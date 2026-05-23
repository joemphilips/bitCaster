#!/usr/bin/env node

import {
  Mint as CashuMint,
  Wallet as CashuWallet,
  getEncodedToken,
  type MintQuoteResponse,
  type PartialMintQuoteResponse,
  type Proof,
} from '@cashu/cashu-ts'
import {
  CashuMintCtfSplitTransport,
  splitRootCompleteSet,
} from '../../bitcaster-client-sdk/src/ctfSplit.ts'

const [, , mode, mintUrl, rawAmount, conditionId, outcomeSetId] = process.argv
const jsonOutput = process.argv.includes('--json')

if (!mode || !mintUrl || !rawAmount) {
  usage()
}

const amountSats = Number(rawAmount)
if (!Number.isInteger(amountSats) || amountSats <= 0) {
  throw new Error(`amount must be a positive integer: ${rawAmount}`)
}

const sats = await mintRegularProofs(mintUrl, amountSats)
if (mode === 'sats') {
  printToken(mintUrl, sats)
} else if (mode === 'outcome') {
  if (!conditionId || !outcomeSetId) usage()
  const split = await splitRootCompleteSet(
    new CashuMintCtfSplitTransport(mintUrl),
    conditionId,
    sats,
    amountSats,
  )
  const selected = split[outcomeSetId]
  if (!selected?.length) {
    throw new Error(`CTF split did not return outcome set ${outcomeSetId}`)
  }
  printToken(mintUrl, selected)
} else {
  usage()
}

async function mintRegularProofs(
  mintUrl: string,
  amountSats: number,
): Promise<Proof[]> {
  const wallet = new CashuWallet(new CashuMint(mintUrl), { unit: 'sat' })
  await wallet.loadMint()
  const quote = await wallet.createMintQuote(amountSats)
  await waitForPaidQuote(wallet, quote)
  return wallet.mintProofs(amountSats, quote.quote)
}

async function waitForPaidQuote(
  wallet: CashuWallet,
  quote: MintQuoteResponse,
): Promise<void> {
  const deadline = Date.now() + 20_000
  let last: PartialMintQuoteResponse | null = null
  while (Date.now() < deadline) {
    last = await wallet.checkMintQuote(quote.quote)
    if (last.state === 'PAID' || last.state === 'ISSUED') return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`mint quote was not paid by fakewallet; last state=${last?.state ?? 'unknown'}`)
}

function printToken(mintUrl: string, proofs: Proof[]): void {
  const token = getEncodedToken({ mint: mintUrl, unit: 'sat', proofs })
  process.stdout.write(
    jsonOutput
      ? `${JSON.stringify({ mintUrl, token, proofs })}\n`
      : `${token}\n`,
  )
}

function usage(): never {
  process.stderr.write(
    'Usage: mint-token.ts sats <mint-url> <amount-sats> [--json]\n' +
      '       mint-token.ts outcome <mint-url> <amount-sats> <condition-id> <outcome-set-id> [--json]\n',
  )
  process.exit(1)
}
