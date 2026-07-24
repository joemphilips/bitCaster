#!/usr/bin/env node

import {
  Mint as CashuMint,
  Wallet as CashuWallet,
  getEncodedToken,
  type MintQuoteResponse,
  type MintKeys,
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
const exactOutput = process.argv.includes('--exact')
const msatsPerSat = 1_000
if (!mode || !mintUrl || !rawAmount) {
  usage()
}

const amountMinorUnits = Number(rawAmount)
if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
  throw new Error(`amount must be a positive integer: ${rawAmount}`)
}

if (mode === 'sats') {
  const sats = await mintRegularProofs(mintUrl, 'sat', amountMinorUnits)
  printToken(mintUrl, 'sat', sats)
} else if (mode === 'msats') {
  const msats = await mintRegularProofs(
    mintUrl,
    'msat',
    collateralAmountForUnit('msat', amountMinorUnits),
  )
  printToken(mintUrl, 'msat', msats)
} else if (mode === 'usd') {
  const usd = await mintRegularProofs(mintUrl, 'usd', amountMinorUnits)
  printToken(mintUrl, 'usd', usd)
} else if (mode === 'outcome' || mode === 'outcome-msats') {
  if (!conditionId || !outcomeSetId) usage()
  const unit = mode === 'outcome-msats' ? 'msat' : 'sat'
  const collateralAmount = collateralAmountForUnit(unit, amountMinorUnits)
  const sats = await mintRegularProofsForCtfSplit(mintUrl, unit, collateralAmount)
  const condition = await getCtfCondition(mintUrl, conditionId)
  const selection = selectMintRootPartitionForOutcome(condition, outcomeSetId, unit)
  const split = await splitRootCompleteSet(
    new CashuMintCtfSplitTransport(mintUrl),
    conditionId,
    sats,
    collateralAmount,
    {},
    selection,
  )
  const selectedKey = resolveSplitOutcomeSetKey(split, outcomeSetId)
  const selected = selectedKey ? split[selectedKey] : undefined
  if (!selected?.length) {
    throw new Error(`CTF split did not return outcome set ${outcomeSetId}`)
  }
  printToken(mintUrl, unit, selected)
} else {
  usage()
}

function collateralAmountForUnit(unit: CollateralTokenUnit, amountMinorUnits: number): number {
  if (unit === 'sat') return amountMinorUnits
  if (unit === 'usd') return amountMinorUnits
  const amountMsats = amountMinorUnits * msatsPerSat
  if (!Number.isSafeInteger(amountMsats)) {
    throw new Error(`amount is too large to scale from sats to msat: ${amountMinorUnits}`)
  }
  return amountMsats
}

async function mintRegularProofs(
  mintUrl: string,
  unit: CollateralTokenUnit,
  faceAmountSubunits: number,
): Promise<Proof[]> {
  const mint = new CashuMint(mintUrl)
  const keyset = await getActiveCollateralKeyset(mint, unit)
  const wallet = new CashuWallet(mint, { unit })
  await wallet.loadMint()
  const grossAmountSubunits = computeGrossCtfInputAmountSats({
    faceAmountSats: faceAmountSubunits,
    keyset: {
      id: keyset.id,
      keys: keyset.keys,
      input_fee_ppk: keyset.input_fee_ppk ?? 0,
    },
  })
  const mintAmountSubunits = exactOutput ? faceAmountSubunits : grossAmountSubunits
  const quote = await wallet.createMintQuote(mintAmountSubunits)
  await waitForPaidQuote(wallet, quote)
  return wallet.mintProofs(mintAmountSubunits, quote.quote)
}

async function mintRegularProofsForCtfSplit(
  mintUrl: string,
  unit: 'sat' | 'msat',
  faceAmountSats: number,
): Promise<Proof[]> {
  const mint = new CashuMint(mintUrl)
  const keyset = await getActiveCollateralKeyset(mint, unit)
  const wallet = new CashuWallet(mint, { unit })
  await wallet.loadMint()
  const grossAmountSats = computeGrossCtfInputAmountSats({
    faceAmountSats,
    keyset: {
      id: keyset.id,
      keys: keyset.keys,
      input_fee_ppk: keyset.input_fee_ppk ?? 0,
    },
  })
  const quote = await wallet.createMintQuote(grossAmountSats)
  await waitForPaidQuote(wallet, quote)
  return wallet.mintProofs(grossAmountSats, quote.quote)
}

type CollateralTokenUnit = 'sat' | 'msat' | 'usd'

async function getActiveCollateralKeyset(mint: CashuMint, unit: CollateralTokenUnit): Promise<MintKeys> {
  const active = (await mint.getKeySets()).keysets.find(
    (keyset) => keyset.active && keyset.unit === unit,
  )
  if (!active) {
    throw new Error(`mint did not return an active ${unit} collateral keyset`)
  }
  const response = await mint.getKeys(active.id)
  const keyset = response.keysets.find((candidate) => candidate.id === active.id)
  if (!keyset) {
    throw new Error(`mint did not return keys for keyset ${active.id}`)
  }
  return keyset
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
  unit: 'sat' | 'msat',
): CtfRootPartitionSelection {
  const target = canonicalizeOutcomeSet(parseOutcomeSetId(outcomeSetId))
  const keysetCollections = Object.keys(condition.keysets)
  const matches = keysetCollections.filter(
    (collection) =>
      canonicalizeOutcomeSet(parseOutcomeSetId(collection)) === target,
  )

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one root CTF keyset for condition ${condition.condition_id} containing outcome set ${outcomeSetId}, found ${matches.length}`,
    )
  }

  const universe = keysetCollections.flatMap(parseOutcomeSetId)
  const complement = complementOutcomeSetId(universe, outcomeSetId)
  if (!target || !complement) {
    throw new Error(
      `Could not derive complementary root outcome set for condition ${condition.condition_id} and outcome set ${outcomeSetId}`,
    )
  }

  return {
    keepOutcomeSetId: outcomeSetId,
    lockOutcomeSetId: complement,
    baseAsset: unit === 'msat' ? 'sat' : undefined,
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
  const deadline = performance.now() + 20_000
  let last: PartialMintQuoteResponse | null = null
  while (performance.now() < deadline) {
    last = await wallet.checkMintQuote(quote.quote)
    if (last.state === 'PAID' || last.state === 'ISSUED') return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`mint quote was not paid by fakewallet; last state=${last?.state ?? 'unknown'}`)
}

function printToken(mintUrl: string, unit: CollateralTokenUnit, proofs: Proof[]): void {
  const token = getEncodedToken({ mint: mintUrl, unit, proofs })
  process.stdout.write(
    jsonOutput
      ? `${JSON.stringify({ mintUrl, token, proofs })}\n`
      : `${token}\n`,
  )
}

function usage(): never {
  process.stderr.write(
    'Usage: mint-token.ts sats <mint-url> <amount-sats> [--json] [--exact]\n' +
      '       mint-token.ts msats <mint-url> <amount-sats> [--json] [--exact]\n' +
      '       mint-token.ts usd <mint-url> <amount-usd-subunits> [--json] [--exact]\n' +
      '       mint-token.ts outcome <mint-url> <amount-sats> <condition-id> <outcome-set-id> [--json]\n' +
      '       mint-token.ts outcome-msats <mint-url> <amount-sats> <condition-id> <outcome-set-id> [--json]\n',
  )
  process.exit(1)
}
