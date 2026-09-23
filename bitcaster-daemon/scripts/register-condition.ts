#!/usr/bin/env node

import { Mint as CashuMint, Wallet as CashuWallet, type Proof } from '@cashu/cashu-ts'
import {
  parseCtfSettingsFromMintInfo,
  registrationFeeForPolicy,
  toWireAmountBearing,
} from '../../bitcaster-client-sdk/src/ctfRegistration.ts'
import { sumProofs } from '../../bitcaster-client-sdk/src/proofSelection.ts'

const [, , mintUrl, title, description, collateral, announcementsJson, outcomesJson, ticker] =
  process.argv
if (!mintUrl || !title || !description || !collateral || !announcementsJson || !outcomesJson) {
  usage()
}
if (ticker !== undefined && ticker.length === 0) usage()
if (collateral !== 'msat') {
  throw new Error(`seed condition registration requires msat collateral, received '${collateral}'`)
}

const announcements = parseStringArray(announcementsJson, 'announcements-json')
const outcomes = parseStringArray(outcomesJson, 'outcomes-json')
const tags = [['title', title], ['description', description], ...(ticker ? [['n', ticker]] : [])]
const info = await fetchMintInfo(mintUrl)
const settings = parseCtfSettingsFromMintInfo(info)
const requiredFeeSubunits = registrationFeeForPolicy(outcomes, settings, collateral)
const request = {
  threshold: 1,
  tags,
  announcements,
  condition_type: 'enum',
  collateral,
}

// Probe the metadata-only request before minting fee proofs. The mint returns
// the existing condition for an exact retry, so restarts do not mint or leak
// another fee payment. A new condition returns code 13044 and then needs the
// fee-bearing retry below.
const preflight = await postCondition(mintUrl, request)
if (preflight.response.ok) {
  process.stdout.write(`${preflight.body}\n`)
} else if (isRegistrationFeeInsufficient(preflight.body)) {
  const feeProofs =
    requiredFeeSubunits > 0 ? await mintRegularProofs(mintUrl, collateral, requiredFeeSubunits) : []
  const selectedTotalSubunits = sumProofs(feeProofs)
  if (selectedTotalSubunits !== requiredFeeSubunits) {
    throw new Error(
      `mint returned ${selectedTotalSubunits} msat registration fee proofs; expected ${requiredFeeSubunits}`,
    )
  }

  const registration = await postCondition(mintUrl, {
    ...request,
    fee: feeProofs.map(toWireProof),
  })
  if (!registration.response.ok) {
    throw new Error(`mint condition registration failed: ${registration.response.status}`)
  }
  process.stdout.write(`${registration.body}\n`)
} else {
  throw new Error(`mint condition preflight failed: ${preflight.response.status}`)
}

async function mintRegularProofs(
  mintUrl: string,
  unit: string,
  feeAmountSubunits: number,
): Promise<Proof[]> {
  const mint = new CashuMint(mintUrl)
  const wallet = new CashuWallet(mint, { unit })
  await wallet.loadMint()
  // NUT-04 quote issuance returns the requested face amount. input_fee_ppk
  // applies when proofs are spent, not when the quote is issued.
  const quote = await wallet.createMintQuote(feeAmountSubunits)
  await waitForPaidQuote(wallet, quote.quote)
  return wallet.mintProofs(feeAmountSubunits, quote.quote)
}

async function waitForPaidQuote(wallet: CashuWallet, quoteId: string): Promise<void> {
  const deadline = performance.now() + 20_000
  let lastState = 'unknown'
  while (performance.now() < deadline) {
    const quote = await wallet.checkMintQuote(quoteId)
    lastState = quote.state ?? 'unknown'
    if (lastState === 'PAID' || lastState === 'ISSUED') return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`mint quote was not paid by fakewallet; last state=${lastState}`)
}

async function fetchMintInfo(mintUrl: string): Promise<Record<string, unknown>> {
  const response = await fetch(new URL('/v1/info', mintUrl))
  if (!response.ok) {
    throw new Error(`mint info fetch failed: ${response.status}`)
  }
  return response.json() as Promise<Record<string, unknown>>
}

async function postCondition(
  mintUrl: string,
  request: Record<string, unknown>,
): Promise<{ response: Response; body: string }> {
  const response = await fetch(new URL('/v1/conditions', mintUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  return { response, body: await response.text() }
}

function isRegistrationFeeInsufficient(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { code?: unknown }
    return parsed.code === 13044
  } catch {
    return false
  }
}

function toWireProof(proof: Proof): Omit<Proof, 'amount'> & { amount: number } {
  return toWireAmountBearing(proof)
}

function parseStringArray(raw: string, name: string): string[] {
  const parsed = JSON.parse(raw)
  if (
    !Array.isArray(parsed) ||
    parsed.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    throw new Error(`${name} must be a JSON string array`)
  }
  return parsed
}

function usage(): never {
  process.stderr.write(
    'Usage: register-condition.ts <mint-url> <title> <description> <collateral> <announcements-json> <outcomes-json> [ticker]\n',
  )
  process.exit(1)
}
