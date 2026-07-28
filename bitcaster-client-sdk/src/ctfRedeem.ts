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
import { DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX } from './durableCustody.ts'
import { amountToNumber } from './proofSelection.ts'
import {
  canonicalProofOperationMintIdentity,
  proofAuthority,
  proofOperationAuthorityDigest,
  requireProofArray,
  requireSameOperationAuthority,
} from './ctfProofOperationAuthority.ts'

/**
 * Shared NUT-CTF redeem helpers.
 *
 * The mint is the sole authority that can condemn an outcome-token leg. The
 * terminal CDK error code below means the keyset's outcome collection does not
 * include the oracle-attested outcome.
 */
export const ORACLE_NOT_ATTESTED_OUTCOME_CODE = 13015

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

export type RestoreOutputGroups = (
  mintUrl: string,
  outputs: CtfProofOperationRecord['outputs'],
) => Promise<Record<string, Proof[]>>

export async function redeemOutcomeLegWithOperation(params: {
  mintUrl: string
  operationId: string
  wallet: RedeemWallet
  proofOperationStore: CtfProofOperationStore
  conditionId: string
  outcome: string
  outcomeKeysetId?: string
  unit: string
  oracleWitness: string
  proofs: Proof[]
  regularKeyset?: MintKeys
  restoreOutputGroups?: RestoreOutputGroups
  onLosingLeg?: (inputs: Proof[]) => Promise<void>
}): Promise<RedeemOutcomeLegResult> {
  if (params.proofs.length === 0) return { proofs: [], losing: false }
  if (params.proofs.length > DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX) {
    throw new Error('CTF redeem input proof limit exceeded')
  }
  const inputs = normalizeProofArray(params.proofs)
  const amountSubunits = inputs.reduce((sum, proof) => sum + amountToNumber(proof.amount), 0)
  if (!Number.isSafeInteger(amountSubunits) || amountSubunits <= 0) {
    throw new Error('CTF redeem inputs must have a positive safe-integer total')
  }

  await params.wallet.loadMint()
  const existing = await params.proofOperationStore.getProofOperation(params.operationId)
  if (existing) {
    requireMatchingCtfRedeemOperation(existing, {
      operationId: params.operationId,
      mintUrl: params.mintUrl,
      conditionId: params.conditionId,
      outcome: params.outcome,
      outcomeKeysetId: params.outcomeKeysetId,
      regularKeysetId: params.regularKeyset?.id,
      unit: params.unit,
      amountSubunits,
      inputs,
    })
    return resumeCtfRedeem({
      mintUrl: params.mintUrl,
      wallet: params.wallet,
      proofOperationStore: params.proofOperationStore,
      oracleWitness: params.oracleWitness,
      onLosingLeg: params.onLosingLeg,
      entry: existing,
      restoreOutputGroups: params.restoreOutputGroups ?? defaultRestoreOutputGroups,
    })
  }

  const regularKeyset =
    params.regularKeyset ?? (await getActiveRegularKeyset(params.wallet, params.unit))
  const outputData = OutputData.createRandomData(Amount.from(amountSubunits), regularKeyset)

  await prepareBoundedCtfProofOperation(params.proofOperationStore, {
    operationId: params.operationId,
    kind: 'ctf-redeem',
    mintUrl: params.mintUrl,
    inputs,
    outputs: { regular: serializeOutputDataArray(outputData) },
    metadata: {
      conditionId: params.conditionId,
      outcome: params.outcome,
      amountSubunits,
      outcomeKeysetId: params.outcomeKeysetId ?? inputs[0]!.id,
      regularKeysetId: regularKeyset.id,
      unit: params.unit,
    },
  })

  return executeCtfRedeem({
    wallet: params.wallet,
    proofOperationStore: params.proofOperationStore,
    operationId: params.operationId,
    inputs,
    outputData,
    oracleWitness: params.oracleWitness,
    onLosingLeg: params.onLosingLeg,
  })
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
    outcomeKeysetId?: string
    regularKeysetId?: string
    unit: string
    amountSubunits: number
    inputs: Proof[]
  },
): void {
  if (entry.kind !== 'ctf-redeem') {
    throw new Error(`proof operation ${entry.operationId} is not a CTF redeem`)
  }
  const metadata = entry.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(`proof operation ${entry.operationId} has invalid CTF redeem metadata`)
  }
  const storedOutcomeKeysetId =
    typeof metadata.outcomeKeysetId === 'string' ? metadata.outcomeKeysetId : null
  const storedRegularKeysetId =
    typeof metadata.regularKeysetId === 'string' ? metadata.regularKeysetId : null
  const storedAuthority = {
    operationId: entry.operationId,
    kind: entry.kind,
    mintUrl: canonicalProofOperationMintIdentity(entry.mintUrl),
    conditionId: requireText(metadata.conditionId, 'stored CTF redeem conditionId').toLowerCase(),
    outcome: requireText(metadata.outcome, 'stored CTF redeem outcome'),
    outcomeKeysetId: requireText(storedOutcomeKeysetId, 'stored CTF redeem outcome keyset'),
    regularKeysetId: requireText(
      storedRegularKeysetId,
      'stored CTF redeem regular keyset',
    ),
    unit: requireText(metadata.unit, 'stored CTF redeem unit'),
    amountSubunits: requirePositiveSafeInteger(
      metadata.amountSubunits,
      'stored CTF redeem amountSubunits',
    ),
    inputs: canonicalRedeemInputAuthority(entry.inputs),
  }
  const requestAuthority = {
    operationId: request.operationId,
    kind: 'ctf-redeem',
    mintUrl: canonicalProofOperationMintIdentity(request.mintUrl),
    conditionId: request.conditionId.toLowerCase(),
    outcome: request.outcome,
    outcomeKeysetId: request.outcomeKeysetId ?? request.inputs[0]!.id,
    regularKeysetId: request.regularKeysetId ?? storedRegularKeysetId,
    unit: request.unit,
    amountSubunits: request.amountSubunits,
    inputs: canonicalRedeemInputAuthority(request.inputs),
  }
  requireSameOperationAuthority(storedAuthority, requestAuthority, entry.operationId)
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
      proofs: normalizeProofArray(entry.resultProofs?.regular ?? []),
      losing: false,
    }
  }
  if (entry.state === 'Failed') {
    if (entry.failureCode === undefined || entry.failureCode === ORACLE_NOT_ATTESTED_OUTCOME_CODE) {
      return { proofs: [], losing: true }
    }
    throw new Error(
      `CTF redeem ${entry.operationId} failed with non-losing failure code ${entry.failureCode ?? 'unknown'}; refusing to condemn proofs`,
    )
  }
  if (!params.wallet.checkProofsStates) {
    throw new Error('Cashu wallet adapter does not support proof-state recovery checks')
  }

  const states = await params.wallet.checkProofsStates(
    entry.inputs.map(({ id, secret }) => ({ id, secret })),
  )
  if (allStates(states, CheckStateEnum.SPENT)) {
    const restored = await params.restoreOutputGroups(params.mintUrl, entry.outputs)
    const final = normalizeProofArray(restored.regular ?? [])
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

async function executeCtfRedeem(params: {
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
    const final = normalizeProofArray(settled)
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
        ORACLE_NOT_ATTESTED_OUTCOME_CODE,
      )
      return { proofs: [], losing: true }
    }
    throw error
  }
}

function withOracleWitness(proofs: Proof[], witnessJson: string): Proof[] {
  return proofs.map((proof) => ({ ...proof, witness: witnessJson }))
}
