import {
  Amount,
  CheckStateEnum,
  OutputData,
  type MintKeys,
  type OutputDataLike,
  type Proof,
  type ProofState,
} from '@cashu/cashu-ts'
import {
  allStates,
  createCtfProofOperationCompletion,
  deserializeOutputGroups,
  normalizeProofArray,
  prepareBoundedCtfProofOperation,
  restoreOutputGroups as defaultRestoreOutputGroups,
  serializeOutputDataArray,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
} from './ctfSplit.ts'
import {
  DURABLE_CUSTODY_COMPOSITE_ID_LIMIT_MAX,
  DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX,
} from './durableCustody.ts'
import { amountToNumber, computeInputFeeSatsForProofs, sumProofs } from './proofSelection.ts'
import {
  canonicalProofOperationMintIdentity,
  proofAuthority,
  proofOperationAuthorityDigest,
  requireProofArray,
  requireSameOperationAuthority,
} from './ctfProofOperationAuthority.ts'

export { canonicalProofOperationMintIdentity } from './ctfProofOperationAuthority.ts'

/**
 * Shared NUT-CTF redeem helpers.
 *
 * The mint is the sole authority that can condemn an outcome-token leg. The
 * terminal CDK error code below means the keyset's outcome collection does not
 * include the oracle-attested outcome.
 */
export const ORACLE_NOT_ATTESTED_OUTCOME_CODE = 13015

const authenticatedCtfRedeemTerminalEvidenceBrand: unique symbol = Symbol(
  'authenticated CTF redeem terminal evidence',
)

export interface AuthenticatedCtfRedeemTerminalEvidence {
  readonly [authenticatedCtfRedeemTerminalEvidenceBrand]: true
  readonly transportProvenance: 'authenticated-mint-transport'
  readonly operationId: string
  readonly normalizedMint: string
  readonly rejectionBody: { readonly code: typeof ORACLE_NOT_ATTESTED_OUTCOME_CODE }
}

export function readAuthenticatedCtfRedeemTerminalEvidence(
  evidence: AuthenticatedCtfRedeemTerminalEvidence,
): {
  transportProvenance: 'authenticated-mint-transport'
  operationId: string
  normalizedMint: string
  rejectionBody: { code: typeof ORACLE_NOT_ATTESTED_OUTCOME_CODE }
} {
  if (
    evidence?.[authenticatedCtfRedeemTerminalEvidenceBrand] !== true ||
    evidence.transportProvenance !== 'authenticated-mint-transport' ||
    typeof evidence.operationId !== 'string' ||
    evidence.operationId.length === 0 ||
    evidence.normalizedMint !== canonicalProofOperationMintIdentity(evidence.normalizedMint) ||
    evidence.rejectionBody?.code !== ORACLE_NOT_ATTESTED_OUTCOME_CODE ||
    Object.keys(evidence).length !== 4 ||
    Object.keys(evidence.rejectionBody).length !== 1
  ) {
    throw new Error('authenticated CTF redeem terminal evidence is invalid')
  }
  return {
    transportProvenance: evidence.transportProvenance,
    operationId: evidence.operationId,
    normalizedMint: evidence.normalizedMint,
    rejectionBody: { code: evidence.rejectionBody.code },
  }
}

export interface RedeemWallet {
  loadMint(): Promise<void>
  mint?: {
    getKeys(keysetId?: string): Promise<{ keysets: MintKeys[] }>
  }
  redeemOutcomeProofs(options: { inputs: Proof[]; outputs: OutputDataLike[] }): Promise<Proof[]>
  checkProofsStates?(proofs: Array<Pick<Proof, 'id' | 'secret'>>): Promise<ProofState[]>
}

export interface RedeemOutcomeLegResult {
  proofs: Proof[]
  losing: boolean
}

export interface CtfRedeemInputKeysetAuthority {
  readonly id: string
  readonly unit: string
  readonly input_fee_ppk?: number
}

interface RedeemOutcomeLegWithOperationParams {
  mintUrl: string
  operationId: string
  wallet: RedeemWallet
  proofOperationStore: CtfProofOperationStore
  conditionId: string
  outcome: string
  outcomeSetId?: string
  outcomeKeysetId?: string
  unit: string
  oracleWitness: string
  proofs: Proof[]
  outcomeKeyset?: CtfRedeemInputKeysetAuthority
  regularKeyset?: MintKeys
  restoreOutputGroups?: RestoreOutputGroups
  onLosingLeg?: (inputs: Proof[]) => Promise<void>
}

export class UneconomicCtfRedeemError extends Error {
  readonly code = 'CTF_REDEEM_UNECONOMIC' as const
  readonly grossInputSubunits: number
  readonly inputFeeSubunits: number

  constructor(grossInputSubunits: number, inputFeeSubunits: number) {
    super('CTF redeem input fee consumes the selected proof page')
    this.name = 'UneconomicCtfRedeemError'
    this.grossInputSubunits = grossInputSubunits
    this.inputFeeSubunits = inputFeeSubunits
  }
}

export type RestoreOutputGroups = (
  mintUrl: string,
  outputs: CtfProofOperationRecord['outputs'],
) => Promise<Record<string, Proof[]>>

export async function redeemOutcomeLegWithOperation(
  params: RedeemOutcomeLegWithOperationParams,
): Promise<RedeemOutcomeLegResult> {
  if (params.proofs.length === 0) return { proofs: [], losing: false }
  requireBoundedOracleWitness(params.oracleWitness)
  if (params.proofs.length > DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX) {
    throw new Error('CTF redeem input proof limit exceeded')
  }
  const inputs = normalizeProofArray(params.proofs)
  const grossInputSubunits = sumProofs(inputs)
  if (!Number.isSafeInteger(grossInputSubunits) || grossInputSubunits <= 0) {
    throw new Error('CTF redeem inputs must have a positive safe-integer total')
  }

  const existing = await params.proofOperationStore.getProofOperation(params.operationId)
  if (existing) {
    return resumeExistingCtfRedeem(params, existing, inputs, grossInputSubunits)
  }

  return prepareAndExecuteCtfRedeem(params, inputs, grossInputSubunits)
}

async function resumeExistingCtfRedeem(
  params: RedeemOutcomeLegWithOperationParams,
  existing: CtfProofOperationRecord,
  inputs: Proof[],
  grossInputSubunits: number,
): Promise<RedeemOutcomeLegResult> {
  const persistedOracleWitness = requireMatchingCtfRedeemOperation(existing, {
    operationId: params.operationId,
    mintUrl: params.mintUrl,
    conditionId: params.conditionId,
    outcome: params.outcome,
    outcomeSetId: params.outcomeSetId,
    outcomeKeysetId: params.outcomeKeysetId,
    outcomeInputFeePpk: params.outcomeKeyset?.input_fee_ppk,
    regularKeysetId: params.regularKeyset?.id,
    unit: params.unit,
    grossInputSubunits,
    inputs,
    oracleWitness: params.oracleWitness,
  })
  return resumeCtfRedeem({
    mintUrl: params.mintUrl,
    wallet: params.wallet,
    proofOperationStore: params.proofOperationStore,
    oracleWitness: persistedOracleWitness,
    onLosingLeg: params.onLosingLeg,
    entry: existing,
    restoreOutputGroups: params.restoreOutputGroups ?? defaultRestoreOutputGroups,
  })
}

async function prepareAndExecuteCtfRedeem(
  params: RedeemOutcomeLegWithOperationParams,
  inputs: Proof[],
  grossInputSubunits: number,
): Promise<RedeemOutcomeLegResult> {
  await params.wallet.loadMint()
  const outcomeKeyset =
    params.outcomeKeyset ??
    (await getExactKeyset(params.wallet, params.outcomeKeysetId ?? inputs[0]!.id, params.unit))
  const regularKeyset =
    params.regularKeyset ?? (await getActiveRegularKeyset(params.wallet, params.unit))
  const outcomeInputFeePpk = requireInputFeePpk(outcomeKeyset, 'CTF redeem outcome keyset')
  if (
    outcomeKeyset.id !== (params.outcomeKeysetId ?? inputs[0]!.id) ||
    outcomeKeyset.unit !== params.unit ||
    inputs.some(({ id }) => id !== outcomeKeyset.id)
  ) {
    throw new Error('CTF redeem outcome keyset authority is foreign')
  }
  const inputFeeSubunits = computeInputFeeSatsForProofs(inputs, {
    [outcomeKeyset.id]: outcomeInputFeePpk,
  })
  const netOutputSubunits = grossInputSubunits - inputFeeSubunits
  if (netOutputSubunits <= 0) {
    throw new UneconomicCtfRedeemError(grossInputSubunits, inputFeeSubunits)
  }
  const outputData = OutputData.createRandomData(Amount.from(netOutputSubunits), regularKeyset)

  await prepareBoundedCtfProofOperation(params.proofOperationStore, {
    operationId: params.operationId,
    kind: 'ctf-redeem',
    mintUrl: params.mintUrl,
    inputs,
    outputs: { regular: serializeOutputDataArray(outputData) },
    metadata: {
      conditionId: params.conditionId,
      outcome: params.outcome,
      ...(params.outcomeSetId === undefined ? {} : { outcomeSetId: params.outcomeSetId }),
      grossInputSubunits,
      inputFeeSubunits,
      netOutputSubunits,
      outcomeInputFeePpk,
      outcomeKeysetId: params.outcomeKeysetId ?? inputs[0]!.id,
      regularKeysetId: regularKeyset.id,
      unit: params.unit,
      oracleWitness: params.oracleWitness,
    },
  })

  return executeCtfRedeem({
    mintUrl: params.mintUrl,
    wallet: params.wallet,
    proofOperationStore: params.proofOperationStore,
    operationId: params.operationId,
    inputs,
    outputData,
    oracleWitness: params.oracleWitness,
    onLosingLeg: params.onLosingLeg,
  })
}

async function getExactKeyset(
  wallet: Pick<RedeemWallet, 'mint'>,
  keysetId: string,
  unit: string,
): Promise<MintKeys> {
  if (!wallet.mint?.getKeys) {
    throw new Error('Cashu wallet adapter does not expose mint keyset lookup')
  }
  const response = await wallet.mint.getKeys(keysetId)
  const keyset = response.keysets.find((candidate) => candidate.id === keysetId)
  if (!keyset || keyset.unit !== unit) {
    throw new Error(`Mint did not return exact ${unit} keyset ${keysetId}`)
  }
  return keyset
}

export function buildKeysetRedeemOperationId(params: {
  mintUrl: string
  unit: string
  conditionId: string
  keysetId: string
  proofs: readonly string[] | readonly Pick<Proof, 'secret'>[]
}): string {
  const secrets = params.proofs
    .map((value) => (typeof value === 'string' ? value : value.secret))
    .sort()
  const digest = proofOperationAuthorityDigest({
    domain: 'bitcaster:ctf-redeem-operation-id:v1',
    mintUrl: canonicalProofOperationMintIdentity(params.mintUrl),
    unit: params.unit,
    conditionId: params.conditionId.toLowerCase(),
    keysetId: params.keysetId,
    secrets,
  })
  return `ctf-redeem:${digest}`
}

export async function getActiveRegularKeyset(
  wallet: Pick<RedeemWallet, 'mint'>,
  unit: string,
): Promise<MintKeys> {
  if (!wallet.mint?.getKeys) {
    throw new Error('Cashu wallet adapter does not expose mint keyset lookup')
  }
  const response = await wallet.mint.getKeys()
  const keyset = response.keysets.find(
    (candidate) => candidate.unit === unit && candidate.active !== false,
  )
  if (!keyset) throw new Error(`Mint did not return an active regular ${unit} keyset`)
  return keyset
}

function requireMatchingCtfRedeemOperation(
  entry: CtfProofOperationRecord,
  request: {
    operationId: string
    mintUrl: string
    conditionId: string
    outcome: string
    outcomeSetId?: string
    outcomeKeysetId?: string
    outcomeInputFeePpk?: number
    regularKeysetId?: string
    unit: string
    grossInputSubunits: number
    inputs: Proof[]
    oracleWitness: string
  },
): string {
  if (entry.kind !== 'ctf-redeem') {
    throw new Error(`proof operation ${entry.operationId} is not a CTF redeem`)
  }
  const metadata = entry.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(`proof operation ${entry.operationId} has invalid CTF redeem metadata`)
  }
  const storedConditionId = requireText(
    metadata.conditionId,
    'stored CTF redeem conditionId',
  ).toLowerCase()
  const storedOutcomeKeysetId = requireText(
    metadata.outcomeKeysetId,
    'stored CTF redeem outcome keyset',
  )
  const storedRegularKeysetId =
    typeof metadata.regularKeysetId === 'string' ? metadata.regularKeysetId : null
  const storedOracleWitness = requireBoundedOracleWitness(metadata.oracleWitness)
  const storedGross = requirePositiveSafeInteger(
    metadata.grossInputSubunits,
    'stored CTF redeem gross input',
  )
  const storedFeePpk = requireNonnegativeSafeInteger(
    metadata.outcomeInputFeePpk,
    'stored CTF redeem input fee ppk',
  )
  const storedFee = requireNonnegativeSafeInteger(
    metadata.inputFeeSubunits,
    'stored CTF redeem input fee',
  )
  const storedNet = requirePositiveSafeInteger(
    metadata.netOutputSubunits,
    'stored CTF redeem net output',
  )
  if (
    storedFee !==
    computeInputFeeSatsForProofs(entry.inputs, { [storedOutcomeKeysetId]: storedFeePpk })
  ) {
    throw new Error(`proof operation ${entry.operationId} has invalid persisted CTF redeem fee`)
  }
  if (storedNet !== storedGross - storedFee) {
    throw new Error(
      `proof operation ${entry.operationId} has invalid persisted CTF redeem net output`,
    )
  }
  const storedAuthority = {
    operationId: entry.operationId,
    kind: entry.kind,
    mintUrl: canonicalProofOperationMintIdentity(entry.mintUrl),
    conditionId: storedConditionId,
    outcome: requireText(metadata.outcome, 'stored CTF redeem outcome'),
    outcomeSetId: optionalText(metadata.outcomeSetId, 'stored CTF redeem outcome set'),
    outcomeKeysetId: storedOutcomeKeysetId,
    regularKeysetId: requireText(storedRegularKeysetId, 'stored CTF redeem regular keyset'),
    unit: requireText(metadata.unit, 'stored CTF redeem unit'),
    grossInputSubunits: storedGross,
    inputFeeSubunits: storedFee,
    netOutputSubunits: storedNet,
    outcomeInputFeePpk: storedFeePpk,
    oracleWitness: storedOracleWitness,
    inputs: canonicalRedeemInputAuthority(entry.inputs),
  }
  const requestAuthority = {
    operationId: request.operationId,
    kind: 'ctf-redeem',
    mintUrl: canonicalProofOperationMintIdentity(request.mintUrl),
    conditionId: request.conditionId.toLowerCase(),
    outcome: request.outcome,
    outcomeSetId: request.outcomeSetId ?? storedAuthority.outcomeSetId,
    outcomeKeysetId: request.outcomeKeysetId ?? request.inputs[0]!.id,
    regularKeysetId: request.regularKeysetId ?? storedRegularKeysetId,
    unit: request.unit,
    grossInputSubunits: request.grossInputSubunits,
    inputFeeSubunits: storedFee,
    netOutputSubunits: storedNet,
    outcomeInputFeePpk: request.outcomeInputFeePpk ?? storedFeePpk,
    oracleWitness: request.oracleWitness,
    inputs: canonicalRedeemInputAuthority(request.inputs),
  }
  requireSameOperationAuthority(storedAuthority, requestAuthority, entry.operationId)
  return storedOracleWitness
}

function optionalText(value: unknown, context: string): string | null {
  if (value === undefined) return null
  return requireText(value, context)
}

function requireNonnegativeSafeInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${context} must be a non-negative safe integer`)
  }
  return value as number
}

function requireInputFeePpk(keyset: CtfRedeemInputKeysetAuthority, context: string): number {
  return requireNonnegativeSafeInteger(keyset.input_fee_ppk ?? 0, `${context} input_fee_ppk`)
}

function canonicalRedeemInputAuthority(proofs: readonly Proof[]): Record<string, unknown>[] {
  return requireProofArray(proofs, 'CTF redeem inputs')
    .sort(
      (left, right) =>
        left.secret.localeCompare(right.secret) ||
        left.id.localeCompare(right.id) ||
        amountToNumber(left.amount) - amountToNumber(right.amount),
    )
    .map(proofAuthority)
}

function requireText(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`)
  }
  return value
}

function requirePositiveSafeInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${context} must be a positive safe integer`)
  }
  return value as number
}

function requireBoundedOracleWitness(value: unknown): string {
  const witness = requireText(value, 'CTF redeem oracle witness')
  if (new TextEncoder().encode(witness).length > DURABLE_CUSTODY_COMPOSITE_ID_LIMIT_MAX) {
    throw new Error('CTF redeem oracle witness record byte limit exceeded')
  }
  return witness
}

export function isLosingLegError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const e = error as { code?: unknown }
    if (typeof e.code === 'number' && e.code === ORACLE_NOT_ATTESTED_OUTCOME_CODE) {
      return true
    }
  }
  return false
}

async function resumeCtfRedeem(params: {
  mintUrl: string
  entry: CtfProofOperationRecord
  wallet: RedeemWallet
  proofOperationStore: CtfProofOperationStore
  oracleWitness: string
  restoreOutputGroups: RestoreOutputGroups
  onLosingLeg?: (inputs: Proof[]) => Promise<void>
}): Promise<RedeemOutcomeLegResult> {
  const { entry } = params
  if (entry.kind !== 'ctf-redeem') {
    throw new Error(`proof operation ${entry.operationId} is not a CTF redeem`)
  }
  if (entry.state === 'completed') {
    return {
      proofs: requireCompletedCtfRedeemProofs(entry),
      losing: false,
    }
  }
  if (entry.state === 'Failed') {
    if (entry.failureCode === ORACLE_NOT_ATTESTED_OUTCOME_CODE) {
      return { proofs: [], losing: true }
    }
    throw new Error(
      `CTF redeem ${entry.operationId} failed with non-losing failure code ${entry.failureCode ?? 'unknown'}; refusing to condemn proofs`,
    )
  }
  await params.wallet.loadMint()
  if (!params.wallet.checkProofsStates) {
    throw new Error('Cashu wallet adapter does not support proof-state recovery checks')
  }

  const states = await params.wallet.checkProofsStates(
    entry.inputs.map(({ id, secret }) => ({ id, secret })),
  )
  if (allStates(states, CheckStateEnum.SPENT)) {
    const restored = await params.restoreOutputGroups(params.mintUrl, entry.outputs)
    const final = requireExactCtfRedeemProofs(
      restored.regular,
      redeemOutputs(entry),
      `restored CTF redeem ${entry.operationId}`,
    )
    await params.proofOperationStore.markProofOperationCompleted(
      entry.operationId,
      createCtfProofOperationCompletion('ctf-redeem', { regular: final }),
    )
    return { proofs: final, losing: false }
  }
  if (allStates(states, CheckStateEnum.UNSPENT)) {
    const outputData = deserializeOutputGroups(entry.outputs).regular ?? []
    if (outputData.length === 0) {
      throw new Error(`proof operation ${entry.operationId} has no redeem outputs`)
    }
    return executeCtfRedeem({
      mintUrl: params.mintUrl,
      wallet: params.wallet,
      proofOperationStore: params.proofOperationStore,
      operationId: entry.operationId,
      inputs: normalizeProofArray(entry.inputs),
      outputData,
      oracleWitness: params.oracleWitness,
      onLosingLeg: params.onLosingLeg,
    })
  }

  throw new Error(`Proof operation ${entry.operationId} is still pending at the mint`)
}

function requireCompletedCtfRedeemProofs(entry: CtfProofOperationRecord): Proof[] {
  const resultProofs = entry.resultProofs
  if (
    resultProofs === undefined ||
    !Array.isArray(resultProofs.regular) ||
    resultProofs.regular.length === 0 ||
    Object.keys(resultProofs).length !== 1
  ) {
    throw new Error(`completed CTF redeem ${entry.operationId} has invalid regular proofs`)
  }
  return requireExactCtfRedeemProofs(
    resultProofs.regular,
    redeemOutputs(entry),
    `completed CTF redeem ${entry.operationId}`,
  )
}

function redeemOutputs(entry: CtfProofOperationRecord): OutputDataLike[] {
  const groups = deserializeOutputGroups(entry.outputs)
  if (
    Object.keys(groups).length !== 1 ||
    !Array.isArray(groups.regular) ||
    groups.regular.length === 0
  ) {
    throw new Error(`CTF redeem ${entry.operationId} has invalid regular outputs`)
  }
  return groups.regular
}

function requireExactCtfRedeemProofs(
  value: unknown,
  outputs: readonly OutputDataLike[],
  context: string,
): Proof[] {
  const proofs = requireNonemptyCtfRedeemProofs(value, context)
  const keysetIds = new Set(outputs.map(({ blindedMessage }) => blindedMessage.id))
  const outputAmount = outputs.reduce(
    (sum, { blindedMessage }) => sum + amountToNumber(blindedMessage.amount),
    0,
  )
  if (proofs.some(({ id }) => !keysetIds.has(id)) || sumProofs(proofs) !== outputAmount) {
    throw new Error(`${context} does not match persisted output authority`)
  }
  return proofs
}

function requireNonemptyCtfRedeemProofs(value: unknown, context: string): Proof[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} has invalid regular proofs`)
  }
  return normalizeProofArray(value)
}

async function executeCtfRedeem(params: {
  mintUrl: string
  wallet: RedeemWallet
  proofOperationStore: CtfProofOperationStore
  operationId: string
  inputs: Proof[]
  outputData: OutputDataLike[]
  oracleWitness: string
  onLosingLeg?: (inputs: Proof[]) => Promise<void>
}): Promise<RedeemOutcomeLegResult> {
  try {
    const settled = await params.wallet.redeemOutcomeProofs({
      inputs: withOracleWitness(params.inputs, params.oracleWitness),
      outputs: params.outputData,
    })
    const final = requireExactCtfRedeemProofs(
      settled,
      params.outputData,
      `mint result for CTF redeem ${params.operationId}`,
    )
    await params.proofOperationStore.markProofOperationCompleted(
      params.operationId,
      createCtfProofOperationCompletion('ctf-redeem', { regular: final }),
    )
    return { proofs: final, losing: false }
  } catch (error) {
    if (isLosingLegError(error)) {
      if (!params.proofOperationStore.markProofOperationFailed) {
        throw new Error('proof operation store does not support terminal redeem failures')
      }
      await params.onLosingLeg?.(params.inputs)
      await params.proofOperationStore.markProofOperationFailed(
        params.operationId,
        'losing leg: mint returned OracleNotAttestedOutcome (13015)',
        captureAuthenticatedCtfRedeemTerminalEvidence(error, params.operationId, params.mintUrl),
      )
      return { proofs: [], losing: true }
    }
    throw error
  }
}

function captureAuthenticatedCtfRedeemTerminalEvidence(
  error: unknown,
  operationId: string,
  mintUrl: string,
): AuthenticatedCtfRedeemTerminalEvidence {
  if (!isLosingLegError(error)) {
    throw new Error('CTF redeem error is not an authenticated terminal rejection')
  }
  return Object.freeze({
    [authenticatedCtfRedeemTerminalEvidenceBrand]: true as const,
    transportProvenance: 'authenticated-mint-transport' as const,
    operationId,
    normalizedMint: canonicalProofOperationMintIdentity(mintUrl),
    rejectionBody: Object.freeze({ code: ORACLE_NOT_ATTESTED_OUTCOME_CODE }),
  })
}

function withOracleWitness(proofs: Proof[], witnessJson: string): Proof[] {
  return proofs.map((proof) => ({ ...proof, witness: witnessJson }))
}
