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
  computeGrossCtfInputAmountSats,
  splitRootCompleteSet,
  type CtfConditionInfo,
  type CtfRootPartitionSelection,
} from '../../bitcaster-client-sdk/src/ctfSplit.ts'
import {
  canonicalizeOutcomeSet,
  complementOutcomeSetId,
  parseOutcomeSetId,
} from '../../bitcaster-client-sdk/src/outcomeSets.ts'

const [, , mode, mintUrl, rawAmount, conditionId, outcomeSetId] = process.argv
const jsonOutput = process.argv.includes('--json')
const ROOT_COLLECTION_ID = '0'.repeat(64)

if (!mode || !mintUrl || !rawAmount) {
  usage()
}

const amountSats = Number(rawAmount)
if (!Number.isInteger(amountSats) || amountSats <= 0) {
  throw new Error(`amount must be a positive integer: ${rawAmount}`)
}

if (mode === 'sats') {
  const sats = await mintRegularProofs(mintUrl, amountSats)
  printToken(mintUrl, sats)
} else if (mode === 'outcome') {
  if (!conditionId || !outcomeSetId) usage()
  const sats = await mintRegularProofsForCtfSplit(mintUrl, amountSats)
  const condition = await getCtfCondition(mintUrl, conditionId)
  const selection = selectMintRootPartitionForOutcome(condition, outcomeSetId)
  const split = await splitRootCompleteSet(
    new CashuMintCtfSplitTransport(mintUrl),
    conditionId,
    sats,
    amountSats,
    {},
    selection,
  )
  const selectedKey = resolveSplitOutcomeSetKey(split, outcomeSetId)
  const selected = selectedKey ? split[selectedKey] : undefined
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

async function mintRegularProofsForCtfSplit(
  mintUrl: string,
  faceAmountSats: number,
): Promise<Proof[]> {
  const wallet = new CashuWallet(new CashuMint(mintUrl), { unit: 'sat' })
  await wallet.loadMint()
  const grossAmountSats = computeGrossCtfInputAmountSats({
    faceAmountSats,
    wallet,
  })
  const quote = await wallet.createMintQuote(grossAmountSats)
  await waitForPaidQuote(wallet, quote)
  return wallet.mintProofs(grossAmountSats, quote.quote)
}

async function getCtfCondition(
  mintUrl: string,
  conditionId: string,
): Promise<CtfConditionInfo> {
  const mint = new CashuMint(mintUrl) as CashuMint & {
    getCtfCondition(conditionId: string): Promise<CtfConditionInfo>
  }
  return mint.getCtfCondition(conditionId)
}

function selectMintRootPartitionForOutcome(
  condition: CtfConditionInfo,
  outcomeSetId: string,
): CtfRootPartitionSelection {
  const target = canonicalizeOutcomeSet(parseOutcomeSetId(outcomeSetId))
  const matches = condition.partitions
    .filter(
      (partition) =>
        partition.collateral === 'sat' &&
        partition.parent_collection_id === ROOT_COLLECTION_ID &&
        Object.keys(partition.keysets).length === 2,
    )
    .filter((partition) =>
      Object.keys(partition.keysets).some(
        (collection) =>
          canonicalizeOutcomeSet(parseOutcomeSetId(collection)) === target,
      ),
    )

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one root sat CTF partition for condition ${condition.condition_id} containing outcome set ${outcomeSetId}, found ${matches.length}`,
    )
  }

  const universe = Object.keys(matches[0].keysets).flatMap(parseOutcomeSetId)
  const complement = complementOutcomeSetId(universe, outcomeSetId)
  if (!target || !complement) {
    throw new Error(
      `Could not derive complementary root outcome set for condition ${condition.condition_id} and outcome set ${outcomeSetId}`,
    )
  }

  return {
    keepOutcomeSetId: outcomeSetId,
    lockOutcomeSetId: complement,
  }
}

function resolveSplitOutcomeSetKey(
  split: Record<string, Proof[]>,
  outcomeSetId: string,
): string | null {
  const target = canonicalizeOutcomeSet(parseOutcomeSetId(outcomeSetId))
  return (
    Object.keys(split).find(
      (collection) =>
        canonicalizeOutcomeSet(parseOutcomeSetId(collection)) === target,
    ) ?? null
  )
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
