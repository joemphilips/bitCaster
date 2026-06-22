#!/usr/bin/env node

import {
  Amount,
  Mint as CashuMint,
  OutputData,
  Wallet as CashuWallet,
  type MintKeys,
  type OutputDataLike,
  type Proof,
  type SerializedBlindedMessage,
} from '@cashu/cashu-ts'
import {
  registrationFeeForPolicy as registrationFeeForSettings,
  toWireAmountBearing,
  type CtfDefaultKeysetCreation,
} from '../../bitcaster-client-sdk/src/ctfRegistration.ts'
import {
  sumProofs,
} from '../../bitcaster-client-sdk/src/proofSelection.ts'

type RegistrationOutputData = OutputDataLike & {
  blindedMessage: SerializedBlindedMessage
}

const [, , mintUrl, title, description, collateral, announcementsJson, outcomesJson] = process.argv
if (!mintUrl || !title || !description || !collateral || !announcementsJson || !outcomesJson) {
  usage()
}

const announcements = parseStringArray(announcementsJson, 'announcements-json')
const outcomes = parseStringArray(outcomesJson, 'outcomes-json')
const info = await fetchMintInfo(mintUrl)
const baseFeeSubunits = registrationFeeForPolicy(outcomes, info)
// Scale fee to the collateral unit (sat=1, msat=1000, milli-cent=100000)
const collateralScale = collateral === 'msat' ? 1000 : collateral === 'milli-cent' ? 100_000 : 1
const requiredFeeSubunits = baseFeeSubunits * collateralScale
const feeProofs =
  requiredFeeSubunits > 0
    ? await mintRegularProofs(mintUrl, collateral, requiredFeeSubunits)
    : []
const selectedTotalSubunits = sumProofs(feeProofs)
const changeOutputs =
  selectedTotalSubunits > requiredFeeSubunits
    ? await prepareRegularBlankOutputs(
      mintUrl,
      collateral,
      selectedTotalSubunits - requiredFeeSubunits,
    )
    : []

const response = await fetch(new URL('/v1/conditions', mintUrl), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    threshold: 1,
    tags: [
      ['title', title],
      ['description', description],
    ],
    announcements,
    condition_type: 'enum',
    collateral,
    ...(feeProofs.length > 0 ? { fee: feeProofs.map(toWireProof) } : {}),
    ...(changeOutputs.length > 0
      ? { outputs: changeOutputs.map((output) => toWireBlindedMessage(output.blindedMessage)) }
      : {}),
  }),
})
const body = await response.text()
if (!response.ok) {
  throw new Error(`mint condition registration failed: ${response.status} ${body}`)
}
process.stdout.write(`${body}\n`)

async function mintRegularProofs(
  mintUrl: string,
  unit: string,
  feeAmountSubunits: number,
): Promise<Proof[]> {
  const mint = new CashuMint(mintUrl)
  const keyset = await getActiveCollateralKeyset(mint, unit)
  const wallet = new CashuWallet(mint, { unit })
  await wallet.loadMint()
  // Mint enough to cover both the required fee and the mint's input fee.
  // The mint deducts input_fee_ppk per proof during minting, so we need to
  // over-mint by the estimated fee and return change outputs.
  const inputFeePpk = keyset.input_fee_ppk ?? 0
  const estimatedProofCount = Math.ceil(Math.log2(feeAmountSubunits + 1)) + 1
  const estimatedInputFee = Math.ceil((estimatedProofCount * inputFeePpk) / 1000)
  const grossAmount = feeAmountSubunits + estimatedInputFee
  const quote = await wallet.createMintQuote(grossAmount)
  await waitForPaidQuote(wallet, quote.quote)
  return wallet.mintProofs(grossAmount, quote.quote)
}

async function prepareRegularBlankOutputs(
  mintUrl: string,
  unit: string,
  changeAmountSubunits: number,
): Promise<RegistrationOutputData[]> {
  const mint = new CashuMint(mintUrl)
  const keyset = await getActiveCollateralKeyset(mint, unit)
  return OutputData.createRandomData(
    Amount.from(changeAmountSubunits),
    keyset,
  ) as RegistrationOutputData[]
}

async function getActiveCollateralKeyset(
  mint: CashuMint,
  unit: string,
): Promise<MintKeys> {
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

async function waitForPaidQuote(
  wallet: CashuWallet,
  quoteId: string,
): Promise<void> {
  const deadline = Date.now() + 20_000
  let lastState = 'unknown'
  while (Date.now() < deadline) {
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
    throw new Error(`mint info fetch failed: ${response.status} ${await response.text()}`)
  }
  return response.json() as Promise<Record<string, unknown>>
}

function registrationFeeForPolicy(
  outcomes: string[],
  info: Record<string, unknown>,
): number {
  const ctf = ((info.nuts as Record<string, unknown> | undefined)?.CTF ??
    {}) as Record<string, unknown>
  const defaultKeysetCreation = ctf.default_keyset_creation
  const base = toNonNegativeInteger(ctf.registration_fee_base, 'registration_fee_base')
  const perKeyset = toNonNegativeInteger(
    ctf.registration_fee_per_keyset,
    'registration_fee_per_keyset',
  )
  if (
    defaultKeysetCreation !== 'none' &&
    defaultKeysetCreation !== 'one-vs-rest' &&
    defaultKeysetCreation !== 'all'
  ) {
    throw new Error(`Unsupported mint CTF default_keyset_creation: ${String(defaultKeysetCreation)}`)
  }
  return registrationFeeForSettings(outcomes, {
    defaultKeysetCreation: defaultKeysetCreation as CtfDefaultKeysetCreation,
    registrationFeeBase: base,
    registrationFeePerKeyset: perKeyset,
  })
}

function toWireProof(proof: Proof): Omit<Proof, 'amount'> & { amount: number } {
  return toWireAmountBearing(proof)
}

function toWireBlindedMessage(
  output: SerializedBlindedMessage,
): Omit<SerializedBlindedMessage, 'amount'> & { amount: number } {
  return toWireAmountBearing(output)
}

function toNonNegativeInteger(value: unknown, fieldName: string): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' || typeof value === 'bigint'
        ? Number(value)
        : undefined
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`mint CTF ${fieldName} is missing or invalid`)
  }
  return parsed
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
    'Usage: register-condition.ts <mint-url> <title> <description> <collateral> <announcements-json> <outcomes-json>\n',
  )
  process.exit(1)
}
