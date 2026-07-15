import { isBlsKeyset } from '@cashu/cashu-ts'
import {
  createDurableProofOperationFacts,
  deriveDurableCustodyArtifactFingerprint,
  durableCustodySemanticPolicy,
  type DurableCustodyBinding,
  type DurableCustodySemanticKind,
  type DurableProofOperationFacts,
  type DurableProofOperationKeysetFactsInput,
} from './durableCustody.ts'
import {
  validateDurableProofOperationLink,
  validateDurableTradeSession,
  type DurableTradeProofOperationLink,
  type DurableTradeSession,
} from './durableTradeRecovery.ts'

export type DurableCustodyProofOperationKind =
  | DurableCustodySemanticKind
  | 'ctf-consolidation'
  | 'ctf-condition-registration'
  | 'regular-split'
  | 'proof-split'
  | 'wallet-mint'
  | 'wallet-receive'
  | 'wallet-send'
  | 'wallet-melt'

export interface DurableCustodyMintKeys {
  id: string
  unit: string
  keys: Readonly<Record<string, string>>
  final_expiry?: number
}

export interface DurableCustodyProofOperationInput {
  operationId: string
  kind: DurableCustodyProofOperationKind
  mintUrl: string
  inputs: readonly {
    id?: string
    amount: unknown
    secret: string
    C: string
    dleq?: unknown
    p2pk_e?: string
    witness?: unknown
    conditionId?: string
    outcomeCollection?: string
  }[]
  outputs: Readonly<
    Record<
      string,
      readonly {
        blindedMessage: {
          amount: unknown
          id: string
          B_: string
        }
        blindingFactor: string
        secret: string
        ephemeralE?: string
      }[]
    >
  >
  metadata?: Readonly<Record<string, unknown>>
  durableTradeRecovery?: DurableTradeProofOperationLink
}

export type DurableCustodyMintKeyResolver = (
  mintUrl: string,
  keysetIds: readonly string[],
) => Promise<ReadonlyMap<string, DurableCustodyMintKeys>>

export interface ResolveDurableCustodyProofOperationFactsInput {
  operation: DurableCustodyProofOperationInput
  session: DurableTradeSession | null
  resolveMintKeys: DurableCustodyMintKeyResolver
  requireDleq: boolean
}

/** Resolves the shared semantic, trade, horizon, and mint-key authority. */
export async function resolveDurableCustodyProofOperationFacts(
  input: ResolveDurableCustodyProofOperationFactsInput,
): Promise<DurableProofOperationFacts> {
  const unit = requireMetadataText(input.operation, 'unit')
  const semanticKind = durableCustodyProofOperationSemanticKind(
    input.operation.kind,
  )
  const binding = createBinding(input.operation, semanticKind, input.session)
  const usage = keysetUsage(input.operation)
  const hasOutputs = Object.values(input.operation.outputs).some(
    (outputs) => outputs.length > 0,
  )
  const mintKeys = await input.resolveMintKeys(input.operation.mintUrl, [
    ...usage.keys(),
  ])
  return createDurableProofOperationFacts({
    unit,
    binding,
    horizon: operationHorizon(semanticKind, input.session),
    hasOutputs,
    inputKeysetRequirement:
      input.operation.kind === 'wallet-mint' ? 'none' : 'required',
    keysets: createKeysetFacts(unit, usage, mintKeys, input.requireDleq),
  })
}

export function durableCustodyProofOperationSemanticKind(
  kind: DurableCustodyProofOperationKind,
): DurableCustodySemanticKind {
  switch (kind) {
    case 'swap-lock':
    case 'swap-claim':
    case 'swap-refund':
    case 'conditional-keyset-swap':
    case 'ctf-split':
    case 'ctf-merge':
    case 'ctf-redeem':
      return kind
    case 'ctf-consolidation':
      return 'ctf-merge'
    case 'ctf-condition-registration':
    case 'regular-split':
    case 'proof-split':
    case 'wallet-send':
    case 'wallet-melt':
      return 'generic-send'
    case 'wallet-mint':
    case 'wallet-receive':
      return 'generic-receive'
    case 'generic-receive':
    case 'generic-send':
      return kind
  }
}

function createBinding(
  operation: DurableCustodyProofOperationInput,
  semanticKind: DurableCustodySemanticKind,
  session: DurableTradeSession | null,
): DurableCustodyBinding {
  const policy = durableCustodySemanticPolicy(semanticKind)
  if (session === null) {
    if (operation.durableTradeRecovery !== undefined) {
      throw new Error('custody operation has no trade session')
    }
    if (policy.bindingKind === 'trade') {
      throw new Error('custody operation requires a trade binding')
    }
    return {
      kind: 'wallet',
      activityId: operation.operationId,
      stage: policy.stage as Extract<
        DurableCustodyBinding,
        { kind: 'wallet' }
      >['stage'],
    }
  }
  assertSessionBinding(operation, session)
  if (policy.bindingKind === 'wallet') {
    throw new Error('custody operation requires a wallet binding')
  }
  return {
    kind: 'trade',
    tradeId: session.tradeId,
    role: session.role,
    stage: policy.stage as Extract<
      DurableCustodyBinding,
      { kind: 'trade' }
    >['stage'],
    sessionId: session.tradeId,
    immutableTradeFingerprint: immutableTradeFingerprint(session),
    hasDependentOperation: hasDependentOperation(operation, session),
  }
}

function assertSessionBinding(
  operation: DurableCustodyProofOperationInput,
  session: DurableTradeSession,
): void {
  const link = operation.durableTradeRecovery
  const sessionError = validateDurableTradeSession(session)
  const linkError = link
    ? validateDurableProofOperationLink(link)
    : 'durable proof operation link is missing'
  if (sessionError !== null || linkError !== null) {
    throw new Error(
      sessionError ?? linkError ?? 'invalid durable trade binding',
    )
  }
  if (
    link!.tradeId !== session.tradeId ||
    link!.role !== session.role ||
    link!.operationKey !== operation.operationId ||
    session.mintUrl !== operation.mintUrl
  ) {
    throw new Error('durable proof operation has foreign trade facts')
  }
}

function immutableTradeFingerprint(session: DurableTradeSession): string {
  return deriveDurableCustodyArtifactFingerprint({
    schemaVersion: session.schemaVersion,
    tradeId: session.tradeId,
    role: session.role,
    localProtocolPubkey: session.localProtocolPubkey,
    counterpartyProtocolPubkey: session.counterpartyProtocolPubkey,
    mintUrl: session.mintUrl,
    sellerLocktimeSecs: session.sellerLocktimeSecs,
    buyerLocktimeSecs: session.buyerLocktimeSecs,
    ephemeralKeyHandle: session.ephemeralKeyHandle,
  })
}

function hasDependentOperation(
  operation: DurableCustodyProofOperationInput,
  session: DurableTradeSession,
): boolean {
  const operationId = operation.durableTradeRecovery?.operationId
  return (
    session.plannedProofOperations?.some(
      (plan) => plan.dependsOnOperationId === operationId,
    ) ?? false
  )
}

function operationHorizon(
  semanticKind: DurableCustodySemanticKind,
  session: DurableTradeSession | null,
): {
  notBeforeMs: number | null
  notAfterMs: number | null
  safetyMarginMs: number
} {
  if (semanticKind === 'swap-refund') {
    return horizon(ownLocktimeMs(requireTradeSession(session)), null)
  }
  if (
    semanticKind === 'swap-lock' ||
    semanticKind === 'conditional-keyset-swap'
  ) {
    return horizon(null, ownLocktimeMs(requireTradeSession(session)))
  }
  if (semanticKind === 'swap-claim') {
    return horizon(null, counterpartyLocktimeMs(requireTradeSession(session)))
  }
  return horizon(null, null)
}

function horizon(notBeforeMs: number | null, notAfterMs: number | null) {
  return { notBeforeMs, notAfterMs, safetyMarginMs: 0 }
}

function requireTradeSession(
  session: DurableTradeSession | null,
): DurableTradeSession {
  if (session === null) {
    throw new Error('custody horizon requires a trade session')
  }
  return session
}

function ownLocktimeMs(session: DurableTradeSession): number {
  return secondsToMilliseconds(
    session.role === 'seller'
      ? session.sellerLocktimeSecs
      : session.buyerLocktimeSecs,
  )
}

function counterpartyLocktimeMs(session: DurableTradeSession): number {
  return secondsToMilliseconds(
    session.role === 'seller'
      ? session.buyerLocktimeSecs
      : session.sellerLocktimeSecs,
  )
}

function secondsToMilliseconds(seconds: number): number {
  const milliseconds = seconds * 1_000
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error('custody locktime is invalid')
  }
  return milliseconds
}

function keysetUsage(
  operation: DurableCustodyProofOperationInput,
): Map<string, { inputs: boolean; outputs: boolean }> {
  const usage = new Map<string, { inputs: boolean; outputs: boolean }>()
  for (const proof of operation.inputs) {
    if (!proof.id) throw new Error('custody input proof has no keyset id')
    markKeysetUsage(usage, proof.id, 'inputs')
  }
  for (const outputs of Object.values(operation.outputs)) {
    for (const output of outputs) {
      markKeysetUsage(usage, output.blindedMessage.id, 'outputs')
    }
  }
  if (usage.size === 0) throw new Error('custody operation has no keysets')
  return usage
}

function markKeysetUsage(
  usage: Map<string, { inputs: boolean; outputs: boolean }>,
  keysetId: string,
  direction: 'inputs' | 'outputs',
): void {
  const current = usage.get(keysetId) ?? { inputs: false, outputs: false }
  current[direction] = true
  usage.set(keysetId, current)
}

function createKeysetFacts(
  unit: string,
  usage: ReadonlyMap<string, { inputs: boolean; outputs: boolean }>,
  mintKeys: ReadonlyMap<string, DurableCustodyMintKeys>,
  requireDleq: boolean,
): DurableProofOperationKeysetFactsInput[] {
  return [...usage].map(([keysetId, directions]) => {
    const keyset = mintKeys.get(keysetId)
    if (
      keyset === undefined ||
      keyset.id !== keysetId ||
      keyset.unit !== unit
    ) {
      throw new Error('mint keyset does not match the custody operation')
    }
    return {
      keysetId,
      unit,
      curve: isBlsKeyset(keysetId) ? 'bls12-381' : 'secp256k1',
      publicKeys: keyset.keys,
      keysetExpiryMs:
        keyset.final_expiry === undefined
          ? null
          : secondsToMilliseconds(keyset.final_expiry),
      requireDleq,
      usedByInputs: directions.inputs,
      usedByOutputs: directions.outputs,
    }
  })
}

function requireMetadataText(
  operation: DurableCustodyProofOperationInput,
  key: string,
): string {
  const value = operation.metadata?.[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`custody operation metadata ${key} is invalid`)
  }
  return value
}
