import {
  Mint as CashuMint,
  isBlsKeyset,
  type MintKeys,
} from '@cashu/cashu-ts'
import {
  createDurableProofOperationFacts,
  deriveDurableCustodyArtifactFingerprint,
  durableCustodySemanticPolicy,
  type DurableCustodyBinding,
  type DurableCustodySemanticKind,
  type DurableProofOperationFacts,
  type DurableProofOperationKeysetFactsInput,
} from '@bitcaster-market/client-sdk/durableCustody'
import {
  validateDurableProofOperationLink,
  validateDurableTradeSession,
  type DurableTradeSession,
} from '@bitcaster-market/client-sdk/durableTradeRecovery'
import { readStateScope, type PrepareProofOperationInput } from './state.ts'

const DAEMON_REQUIRES_DLEQ = false
const HORIZON_SAFETY_MARGIN_MS = 0

export type DaemonMintKeyResolver = (
  mintUrl: string,
  keysetIds: readonly string[],
) => Promise<ReadonlyMap<string, MintKeys>>

export async function resolveDaemonProofOperationFacts(
  input: PrepareProofOperationInput,
  resolveMintKeys: DaemonMintKeyResolver = fetchMintKeys,
): Promise<DurableProofOperationFacts> {
  const unit = requireMetadataText(input, 'unit')
  const semanticKind = daemonCustodySemanticKind(input.kind)
  const session = await readBoundTradeSession(input)
  const binding = createBinding(input, semanticKind, session)
  const usage = keysetUsage(input)
  const mintKeys = await resolveMintKeys(input.mintUrl, [...usage.keys()])
  return createDurableProofOperationFacts({
    unit,
    binding,
    horizon: operationHorizon(semanticKind, session),
    keysets: createKeysetFacts(unit, usage, mintKeys),
  })
}

export function daemonCustodySemanticKind(
  kind: PrepareProofOperationInput['kind'],
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
    case 'regular-split':
    case 'wallet-send':
    case 'proof-split':
      return 'generic-send'
  }
}

async function readBoundTradeSession(
  input: PrepareProofOperationInput,
): Promise<DurableTradeSession | null> {
  const link = input.durableTradeRecovery
  if (link === undefined) return null
  const linkError = validateDurableProofOperationLink(link)
  if (linkError !== null) throw new Error(linkError)
  const state = await readStateScope({ tradeIds: [link.tradeId] })
  const session = state?.durableTradeSessions[link.tradeId]
  if (session === undefined) {
    throw new Error('durable proof operation has no trade session')
  }
  const sessionError = validateDurableTradeSession(session)
  if (sessionError !== null) throw new Error(sessionError)
  if (session.role !== link.role || session.mintUrl !== input.mintUrl) {
    throw new Error('durable proof operation has foreign trade facts')
  }
  return session
}

function createBinding(
  input: PrepareProofOperationInput,
  semanticKind: DurableCustodySemanticKind,
  session: DurableTradeSession | null,
): DurableCustodyBinding {
  const policy = durableCustodySemanticPolicy(semanticKind)
  if (session === null) {
    if (policy.bindingKind === 'trade') {
      throw new Error('custody operation requires a trade binding')
    }
    return {
      kind: 'wallet',
      activityId: input.operationId,
      stage: policy.stage as Extract<
        DurableCustodyBinding,
        { kind: 'wallet' }
      >['stage'],
    }
  }
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
    hasDependentOperation: hasDependentOperation(input, session),
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
  input: PrepareProofOperationInput,
  session: DurableTradeSession,
): boolean {
  const operationId = input.durableTradeRecovery?.operationId
  return session.plannedProofOperations?.some(
    (plan) => plan.dependsOnOperationId === operationId,
  ) ?? false
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
  if (semanticKind === 'swap-lock' || semanticKind === 'conditional-keyset-swap') {
    return horizon(null, ownLocktimeMs(requireTradeSession(session)))
  }
  if (semanticKind === 'swap-claim') {
    return horizon(null, counterpartyLocktimeMs(requireTradeSession(session)))
  }
  return horizon(null, null)
}

function horizon(
  notBeforeMs: number | null,
  notAfterMs: number | null,
): {
  notBeforeMs: number | null
  notAfterMs: number | null
  safetyMarginMs: number
} {
  return { notBeforeMs, notAfterMs, safetyMarginMs: HORIZON_SAFETY_MARGIN_MS }
}

function requireTradeSession(
  session: DurableTradeSession | null,
): DurableTradeSession {
  if (session === null) throw new Error('custody horizon requires a trade session')
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
  input: PrepareProofOperationInput,
): Map<string, { inputs: boolean; outputs: boolean }> {
  const usage = new Map<string, { inputs: boolean; outputs: boolean }>()
  for (const proof of input.inputs) {
    if (!proof.id) throw new Error('custody input proof has no keyset id')
    markKeysetUsage(usage, proof.id, 'inputs')
  }
  for (const outputs of Object.values(input.outputs)) {
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
  mintKeys: ReadonlyMap<string, MintKeys>,
): DurableProofOperationKeysetFactsInput[] {
  return [...usage].map(([keysetId, directions]) => {
    const keyset = mintKeys.get(keysetId)
    if (keyset === undefined || keyset.id !== keysetId || keyset.unit !== unit) {
      throw new Error('mint keyset does not match the custody operation')
    }
    return {
      keysetId,
      unit,
      curve: isBlsKeyset(keysetId) ? 'bls12-381' : 'secp256k1',
      publicKeys: keyset.keys,
      keysetExpiryMs: keysetExpiryMs(keyset),
      requireDleq: DAEMON_REQUIRES_DLEQ,
      usedByInputs: directions.inputs,
      usedByOutputs: directions.outputs,
    }
  })
}

function keysetExpiryMs(keyset: MintKeys): number | null {
  if (keyset.final_expiry === undefined) return null
  return secondsToMilliseconds(keyset.final_expiry)
}

async function fetchMintKeys(
  mintUrl: string,
  keysetIds: readonly string[],
): Promise<ReadonlyMap<string, MintKeys>> {
  const mint = new CashuMint(mintUrl)
  const result = new Map<string, MintKeys>()
  for (const keysetId of keysetIds) {
    const response = await mint.getKeys(keysetId)
    const keyset = response.keysets.find((candidate) => candidate.id === keysetId)
    if (keyset === undefined) throw new Error('mint did not return an exact keyset')
    result.set(keysetId, keyset)
  }
  return result
}

function requireMetadataText(
  input: PrepareProofOperationInput,
  key: string,
): string {
  const value = input.metadata?.[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`custody operation metadata ${key} is invalid`)
  }
  return value
}
