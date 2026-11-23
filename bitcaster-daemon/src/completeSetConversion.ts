import { type Proof } from '@cashu/cashu-ts'
import {
  CashuMintCtfSplitTransport,
  type CtfSplitTransport,
} from '@bitcaster-market/client-sdk/ctfSplit'
import type { DaemonSecrets } from './secrets.ts'
import {
  readSpendableWalletProofsFenced,
  CustodyRepairRequiredError,
  type SpendableWalletProofs,
  readProofOperationFenced,
  type FencedStateMutation,
  type ProofOperationRecord,
} from './state.ts'
import {
  CtfConversionRefusedError,
  executeCtfConversionPlan,
  resolveCtfConsolidationInputFees,
  resolveCtfConsolidationOutputKeysets,
  resolveMintKeysByKeyset,
  resumeCtfConsolidationOperation,
  type WalletOpsDependencies,
} from './walletOps.ts'
import {
  COLLATERAL_COLLECTION,
  planCtfCompleteSetSplit,
  type CtfCompleteSetSplitRefusal,
} from '@bitcaster-market/client-sdk/ctfConsolidation'
import { createHash } from 'node:crypto'
import { readMintCtfCondition } from './mintCtfCondition.ts'

type CompleteSetDependencies = WalletOpsDependencies & {
  readonly createCtfSplitTransport?: (mintUrl: string) => CtfSplitTransport
  /** The mint condition read. Tests replace the HTTP request. */
  readonly fetchConsolidationCondition?: typeof globalThis.fetch
}

type CompleteSetSplitInput = {
  mintUrl: string
  conditionId: string
  amountMsat: number
  operationId: string
  secrets: DaemonSecrets | null
  deps: CompleteSetDependencies
}

type CompleteSetSplitResult = {
  operationId: string
  conditionId: string
  amountMsat: number
  outcomeProofCounts: Record<string, number>
}

/** Split regular ecash into a complete outcome set with one custody-backed convert. */
export async function splitWalletCompleteSet(
  input: CompleteSetSplitInput,
): Promise<CompleteSetSplitResult> {
  if (!Number.isSafeInteger(input.amountMsat) || input.amountMsat <= 0) {
    throw new Error('amountMsat must be a positive safe integer')
  }
  if (!input.secrets) throw new Error('daemon secrets are not initialized')
  return splitCompleteSetByConvert(
    { ...input, secrets: input.secrets },
    requireCompleteSetCustodyMutation(input.deps),
  )
}

/** The convert operation of a new split. The root id is its idempotency key. */
export function completeSetConvertOperationId(rootOperationId: string): string {
  const digest = createHash('sha256')
    .update('bitcaster:daemon-complete-set-split:v1\0')
    .update(rootOperationId)
    .digest('hex')
    .slice(0, 32)
  return `ctf-consolidation:split:${digest}`
}

/** The RPC code of a split that is refused before any effect. */
export type CompleteSetSplitRefusalCode =
  | 'market-not-found'
  | 'market-not-pending'
  | 'insufficient-funds'
  | 'split-input-fee-zero'
  | 'split-input-limit'
  | 'split-group-limit'
  | 'split-output-limit'

/**
 * A split refused before any effect, with the RPC code of the refusal. Short
 * funds also give the amounts in msat, as an order does.
 */
export class CompleteSetSplitRefusedError extends Error {
  readonly code: CompleteSetSplitRefusalCode | null
  readonly result: { readonly requiredMsat: number; readonly availableMsat: number } | null
  constructor(
    code: CompleteSetSplitRefusalCode | null,
    message: string,
    result: { readonly requiredMsat: number; readonly availableMsat: number } | null = null,
  ) {
    super(message)
    this.code = code
    this.result = result
  }
}

/**
 * One convert spends custody proofs `{'*': S}` into the face amount of each
 * root-partition collection and the regular change. The saved operation is
 * read first, so a retry with the same root id resumes it or returns its
 * result.
 */
async function splitCompleteSetByConvert(
  input: CompleteSetSplitInput & { secrets: DaemonSecrets },
  mutation: () => FencedStateMutation,
): Promise<CompleteSetSplitResult> {
  const operationId = completeSetConvertOperationId(input.operationId)
  const saved = await readProofOperationFenced(operationId, mutation())
  if (saved !== null) {
    assertSavedCompleteSetConvert(saved, input)
    if (saved.state === 'Failed')
      throw new CompleteSetSplitRefusedError(
        null,
        'the mint refused this split; start a new split with a new operation id',
      )
    const resultProofs = await resumeCtfConsolidationOperation(saved, input.deps).catch(
      (error: unknown) => {
        throw completeSetConvertRefusal(error, input.conditionId)
      },
    )
    return completeSetConvertResponse(input, resultProofs)
  }
  await assertCompleteSetConditionPending(input)
  const transport = createCtfSplitTransport(input.deps, input.mintUrl)
  const partitionKeysets = structuredClone(
    await transport.getRootPartitionKeysets(input.conditionId),
  )
  const collateralKeysetId = (
    await resolveCtfConsolidationOutputKeysets(input.mintUrl, input.conditionId, input.deps)
  )[COLLATERAL_COLLECTION]
  if (collateralKeysetId === undefined)
    throw new Error('mint did not return an active msat collateral keyset')
  // The keys give the number of outputs, which the plan bounds before any effect.
  const outputKeysets = await resolveMintKeysByKeyset(
    input.mintUrl,
    [...new Set([...Object.values(partitionKeysets), collateralKeysetId])],
    input.deps,
  )
  const available = await readSpendableWalletProofsFenced({
    mintUrl: input.mintUrl,
    asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
    mutation: mutation(),
  })
  const proofs = available.proofs.map(({ proof }) => proof as Proof)
  const plan = planCtfCompleteSetSplit({
    conditionId: input.conditionId,
    partitionKeysets,
    collateralKeysetId,
    outputKeysetKeys: Object.fromEntries(
      Object.entries(outputKeysets).map(([keysetId, keyset]) => [keysetId, keyset.keys]),
    ),
    proofs,
    inputFeePpkByKeyset: await resolveCtfConsolidationInputFees(
      input.mintUrl,
      proofs.map(({ id }) => id),
      input.deps,
    ),
    amountSubunits: input.amountMsat,
  })
  if (plan.kind === 'refused') throw completeSetSplitRefusal(plan, available, input.amountMsat)
  const result = await executeCtfConversionPlan(
    {
      marketId: input.conditionId,
      conditionId: input.conditionId,
      type: 'split',
      mintUrl: input.mintUrl,
      plan,
      outputKeysets,
      secrets: input.secrets,
    },
    operationId,
    { rootOperationId: input.operationId, amountMsat: input.amountMsat },
    input.deps,
  ).catch((error: unknown) => {
    throw completeSetConvertRefusal(error, input.conditionId)
  })
  return {
    operationId: input.operationId,
    conditionId: input.conditionId,
    amountMsat: input.amountMsat,
    outcomeProofCounts: countOutcomeProofs(result.outputs.map(({ label }) => label)),
  }
}

/** The condition got its result after the pending check. The inputs are released. */
function completeSetConvertRefusal(error: unknown, conditionId: string): unknown {
  return error instanceof CtfConversionRefusedError
    ? new CompleteSetSplitRefusedError(error.code, `market ${conditionId} is not pending`)
    : error
}

function completeSetSplitRefusal(
  refusal: CtfCompleteSetSplitRefusal,
  available: SpendableWalletProofs,
  amount: number,
): Error {
  switch (refusal.reason) {
    case 'insufficient-inputs': {
      const spendable = refusal.availableSubunits
      // Proofs outside custody count in the balance, but the split cannot spend them.
      if (available.custodyRepairAmount > 0 && spendable + available.custodyRepairAmount > amount)
        return new CustodyRepairRequiredError()
      return new CompleteSetSplitRefusedError(
        'insufficient-funds',
        `the wallet holds ${spendable} msat, which cannot pay the split and its input fee`,
        { requiredMsat: refusal.requiredSubunits, availableMsat: refusal.availableSubunits },
      )
    }
    case 'input-fee-floor-zero':
      return new CompleteSetSplitRefusedError(
        'split-input-fee-zero',
        'the mint charges no input fee, so it refuses a convert',
      )
    case 'input-limit':
      return new CompleteSetSplitRefusedError(
        'split-input-limit',
        'the split needs more input proofs than one operation holds; consolidate proofs first',
      )
    case 'output-group-limit':
      return new CompleteSetSplitRefusedError(
        'split-group-limit',
        'the market has too many outcomes for one split',
      )
    case 'output-limit':
      return new CompleteSetSplitRefusedError(
        'split-output-limit',
        'the split needs more outputs than one operation holds; split a smaller amount',
      )
    default:
      return assertNeverSplitRefusal(refusal)
  }
}

function assertNeverSplitRefusal(value: never): never {
  throw new Error(`unhandled complete-set split refusal: ${JSON.stringify(value)}`)
}

/** A new split needs a condition that the mint records without a result. */
async function assertCompleteSetConditionPending(
  input: Pick<CompleteSetSplitInput, 'mintUrl' | 'conditionId' | 'deps'>,
): Promise<void> {
  const condition = await readMintCtfCondition({
    mintUrl: input.mintUrl,
    conditionId: input.conditionId,
    fetch: input.deps.fetchConsolidationCondition,
  })
  if (condition.status === 'not-found')
    throw new CompleteSetSplitRefusedError(
      'market-not-found',
      `market ${input.conditionId} was not found`,
    )
  if (condition.status !== 'pending')
    throw new CompleteSetSplitRefusedError(
      'market-not-pending',
      `market ${input.conditionId} is not pending`,
    )
}

function assertSavedCompleteSetConvert(
  saved: ProofOperationRecord,
  input: Pick<CompleteSetSplitInput, 'operationId' | 'mintUrl' | 'conditionId' | 'amountMsat'>,
): void {
  if (
    saved.kind !== 'ctf-consolidation' ||
    saved.metadata.type !== 'split' ||
    saved.metadata.rootOperationId !== input.operationId ||
    saved.mintUrl !== input.mintUrl ||
    saved.metadata.conditionId !== input.conditionId ||
    saved.metadata.amountMsat !== input.amountMsat
  )
    throw new Error('the operation id belongs to a different split')
}

function completeSetConvertResponse(
  input: Pick<CompleteSetSplitInput, 'operationId' | 'conditionId' | 'amountMsat'>,
  resultProofs: Record<string, Proof[]>,
): CompleteSetSplitResult {
  return {
    operationId: input.operationId,
    conditionId: input.conditionId,
    amountMsat: input.amountMsat,
    outcomeProofCounts: countOutcomeProofs(
      Object.entries(resultProofs).flatMap(([collection, proofs]) => proofs.map(() => collection)),
    ),
  }
}

/** The change returns as regular collateral, so it is not an outcome. */
function countOutcomeProofs(collections: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const collection of collections) {
    if (collection === COLLATERAL_COLLECTION) continue
    counts[collection] = (counts[collection] ?? 0) + 1
  }
  return counts
}

function createCtfSplitTransport(
  deps: CompleteSetDependencies,
  mintUrl: string,
): CtfSplitTransport {
  return deps.createCtfSplitTransport?.(mintUrl) ?? new CashuMintCtfSplitTransport(mintUrl)
}

function requireCompleteSetCustodyMutation(
  deps: Pick<WalletOpsDependencies, 'getCustodyFence'>,
): () => FencedStateMutation {
  if (!deps.getCustodyFence) {
    throw new Error('complete-set conversion requires custody authority')
  }
  return () => ({ fence: deps.getCustodyFence!(), observedAtMs: Date.now() })
}
