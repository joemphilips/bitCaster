import { createHash, randomUUID } from 'node:crypto'
import type { Proof } from '@cashu/cashu-ts'
import {
  createManagedConditionRetirementIntent,
  prepareDlcConditionResolutionEvidence,
  verifyDlcConditionResolution,
  type ManagedConditionInventoryBinding,
  type PersistedRegisteredDlcConditionAuthority,
} from '@bitcaster-market/client-sdk/managedConditionInventory'
import {
  canonicalProofOperationMintIdentity,
  redeemOutcomeLegWithOperation,
  UneconomicCtfRedeemError,
  type AuthenticatedCtfRedeemTerminalEvidence,
  type RedeemWallet,
} from '@bitcaster-market/client-sdk/ctfRedeem'
import type {
  CtfProofOperationRecord,
  CtfProofOperationStore,
} from '@bitcaster-market/client-sdk/ctfSplit'
import { deriveDurableCustodyOperationId } from '@bitcaster-market/client-sdk/durableCustody'
import type { ConditionAttestationResponse } from '@bitcaster-market/client-sdk/engineClient'
import {
  amountToNumber,
  computeInputFeeSatsForProofs,
} from '@bitcaster-market/client-sdk/proofSelection'
import type { CustodyScopeFence } from './profileFencing.ts'
import type { DaemonProfile } from './profile.ts'
import type { WalletRetireConditionResult } from './protocol.ts'
import {
  completeManagedConditionRedeemFenced,
  ensureState,
  failManagedConditionRedeemFenced,
  getProofOperation,
  prepareProofOperationWithExactReservation,
  retainUneconomicConditionProofsFenced,
  type ProofOperationRecord,
  type StoredProofRecord,
} from './state.ts'
import {
  completeManagedConditionRetirement,
  listRetiringManagedConditionBindings,
  loadManagedConditionInventory,
  startManagedConditionRetirement,
} from './managedConditionInventorySqlite.ts'
import {
  createWallet,
  resolveCtfConsolidationInputFees,
  restoreOutputGroups,
  type WalletOpsDependencies,
  type WalletOpsSecrets,
} from './walletOps.ts'

const RETIREMENT_PAGE_PROOF_MAX = 64

export interface ManagedConditionRetirementEngine {
  getConditionAttestation(conditionId: string): Promise<ConditionAttestationResponse | null>
}

export async function retireResolvedDaemonConditions(input: {
  readonly profile: DaemonProfile
  readonly secrets: WalletOpsSecrets
  readonly fence: CustodyScopeFence
  readonly engine: ManagedConditionRetirementEngine
  readonly walletDependencies?: WalletOpsDependencies
}): Promise<Array<{ conditionId: string; error: string | null }>> {
  const conditionIds = [
    ...new Set(
      (await ensureState()).wallet.proofs.flatMap((record) =>
        record.asset.kind === 'Outcome' ? [record.asset.conditionId] : [],
      ),
    ),
  ].sort()
  const results: Array<{ conditionId: string; error: string | null }> = []
  for (const conditionId of conditionIds) {
    try {
      const attestation = await input.engine.getConditionAttestation(conditionId)
      if (attestation === null) continue
      await retireDaemonConditionInventory({
        ...input,
        conditionId,
        acknowledge: true,
        intentKind: 'daemon-standing-policy',
        engine: { getConditionAttestation: async () => attestation },
      })
      results.push({ conditionId, error: null })
    } catch (error) {
      results.push({
        conditionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}

export async function resumeDaemonConditionRetirements(input: {
  readonly profile: DaemonProfile
  readonly secrets: WalletOpsSecrets
  readonly fence: CustodyScopeFence
  readonly walletDependencies?: WalletOpsDependencies
}): Promise<Array<{ conditionId: string; error: string | null }>> {
  const bindings = await listRetiringManagedConditionBindings()
  const normalizedMint = canonicalProofOperationMintIdentity(input.profile.mintUrl)
  const results: Array<{ conditionId: string; error: string | null }> = []
  for (const binding of bindings) {
    if (binding.scopeId !== input.fence.scopeId || binding.normalizedMint !== normalizedMint) {
      throw new Error('retiring managed condition belongs to a foreign daemon profile')
    }
    try {
      await retireDaemonConditionInventory({
        ...input,
        conditionId: binding.conditionId,
        acknowledge: true,
        intentKind: 'explicit-user-command',
        engine: { getConditionAttestation: async () => null },
      })
      results.push({ conditionId: binding.conditionId, error: null })
    } catch (error) {
      results.push({
        conditionId: binding.conditionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}

export async function retireDaemonConditionInventory(input: {
  readonly conditionId: string
  readonly acknowledge: boolean
  readonly intentKind: 'daemon-standing-policy' | 'explicit-user-command'
  readonly profile: DaemonProfile
  readonly secrets: WalletOpsSecrets
  readonly fence: CustodyScopeFence
  readonly engine: ManagedConditionRetirementEngine
  readonly walletDependencies?: WalletOpsDependencies
}): Promise<WalletRetireConditionResult> {
  const conditionId = canonicalConditionId(input.conditionId)
  const binding = inventoryBinding(input.fence, input.profile, conditionId)
  const current = await loadManagedConditionInventory(binding)
  let verified: ReturnType<typeof verifyAttestation> | null = null
  if (current === null) {
    const attestation = await input.engine.getConditionAttestation(conditionId)
    if (attestation === null) throw new Error('condition resolution attestation is not available')
    verified = verifyAttestation(binding, attestation)
  }
  const resolvedOutcome =
    current === null
      ? verified!.resolution.resolvedOutcome
      : retirementResolution(current).resolvedOutcome
  const preview = await buildRetirementPreview(
    conditionId,
    input.profile.mintUrl,
    resolvedOutcome,
    input.walletDependencies,
  )
  if (!input.acknowledge) return result(conditionId, 'preview', preview)

  let persisted = current
  if (persisted === null) {
    persisted = await startManagedConditionRetirement({
      fence: input.fence,
      binding,
      resolution: verified!.resolution,
      intent: createManagedConditionRetirementIntent({
        binding,
        kind: input.intentKind,
        intentId: randomUUID(),
        createdAtMs: Date.now(),
      }),
      oracleWitness: verified!.oracleWitness,
      observedAtMs: Date.now(),
    })
  }
  if (persisted.state.state === 'retired') return result(conditionId, 'retired', preview)

  if (persisted.state.state !== 'retiring') {
    throw new Error('managed condition retirement state is invalid')
  }
  await resumePreparedRetirementOperations({ ...input, persisted })
  while (true) {
    const page = await nextRetirementPage(conditionId, input.profile.mintUrl)
    if (page === null) break
    await redeemRetirementPage({ ...input, persisted, page })
  }
  await completeManagedConditionRetirement({
    fence: input.fence,
    binding,
    observedAtMs: Date.now(),
  })
  return result(conditionId, 'retired', preview)
}

async function resumePreparedRetirementOperations(input: {
  readonly conditionId: string
  readonly profile: DaemonProfile
  readonly secrets: WalletOpsSecrets
  readonly fence: CustodyScopeFence
  readonly walletDependencies?: WalletOpsDependencies
  readonly persisted: NonNullable<Awaited<ReturnType<typeof loadManagedConditionInventory>>>
}): Promise<void> {
  const operations = Object.values((await ensureState()).proofOperations)
    .filter((operation) => operation.kind === 'ctf-redeem' && operation.state === 'prepared')
    .sort((left, right) => left.operationId.localeCompare(right.operationId))
  for (const operation of operations) {
    if (
      operation.metadata.purpose !== 'managed-condition-retirement' ||
      operation.metadata.conditionId !== input.conditionId
    ) {
      continue
    }
    const outcomeSetId = requiredText(operation.metadata.outcomeSetId, 'retirement outcome set')
    await redeemRetirementPage({
      ...input,
      page: {
        keysetId: requiredText(operation.metadata.outcomeKeysetId, 'retirement keyset'),
        outcomeSetId,
        proofs: operation.inputs.map((proof) => normalizeProof(proof)),
      },
    })
  }
}

async function redeemRetirementPage(input: {
  readonly conditionId: string
  readonly profile: DaemonProfile
  readonly secrets: WalletOpsSecrets
  readonly fence: CustodyScopeFence
  readonly walletDependencies?: WalletOpsDependencies
  readonly persisted: NonNullable<Awaited<ReturnType<typeof loadManagedConditionInventory>>>
  readonly page: RetirementPage
}): Promise<void> {
  const resolution = retirementResolution(input.persisted)
  const operationId = retirementOperationId({
    scopeId: input.fence.scopeId,
    conditionId: input.conditionId,
    evidenceFingerprint: resolution.evidenceFingerprint,
    keysetId: input.page.keysetId,
    proofs: input.page.proofs,
  })
  const reservationId = operationId
  const asset = {
    kind: 'Outcome' as const,
    conditionId: input.conditionId,
    outcomeSetId: input.page.outcomeSetId,
    baseAsset: 'sat' as const,
    unit: 'msat' as const,
  }
  const wallet = createWallet(
    input.profile.mintUrl,
    input.secrets,
    input.walletDependencies ?? {},
    'sat',
    'msat',
  ) as unknown as RedeemWallet
  const store = retirementOperationStore({
    fence: input.fence,
    reservationId,
    asset,
    persisted: input.persisted,
  })
  try {
    await redeemOutcomeLegWithOperation({
      mintUrl: input.profile.mintUrl,
      operationId,
      wallet,
      proofOperationStore: store,
      conditionId: input.conditionId,
      outcome: resolution.resolvedOutcome,
      outcomeSetId: input.page.outcomeSetId,
      outcomeKeysetId: input.page.keysetId,
      unit: 'msat',
      oracleWitness: input.persisted.oracleWitness,
      proofs: input.page.proofs,
      restoreOutputGroups,
    })
  } catch (error) {
    if (!(error instanceof UneconomicCtfRedeemError)) throw error
    await retainUneconomicConditionProofsFenced({
      proofs: input.page.proofs,
      mintUrl: input.profile.mintUrl,
      asset,
      retentionId: `retained:${operationId}`,
      mutation: { fence: input.fence, observedAtMs: Date.now() },
    })
  }
}

function retirementOperationStore(input: {
  readonly fence: CustodyScopeFence
  readonly reservationId: string
  readonly asset: Extract<StoredProofRecord['asset'], { kind: 'Outcome' }>
  readonly persisted: NonNullable<Awaited<ReturnType<typeof loadManagedConditionInventory>>>
}): CtfProofOperationStore {
  const state = input.persisted.state
  if (state.state !== 'retiring') throw new Error('retirement operation requires retiring state')
  const managedConditionOperationAuthority = {
    operationId: input.reservationId,
    scopeId: input.fence.scopeId,
    inventoryRevisionAtBind: state.revision,
    purpose: 'retirement-redemption' as const,
    resolutionEvidenceFingerprint: state.resolution.evidenceFingerprint,
    retirementIntentId: state.retirementIntent.intentId,
  }
  return {
    getProofOperation: async (operationId) =>
      (await getProofOperation(operationId)) as CtfProofOperationRecord | null,
    prepareProofOperation: async (operation) =>
      (await prepareProofOperationWithExactReservation(
        {
          ...operation,
          reservationId: input.reservationId,
          asset: input.asset,
          metadata: {
            ...operation.metadata,
            purpose: 'managed-condition-retirement',
            reservationId: input.reservationId,
            managedConditionOperationAuthority,
          },
        },
        { fence: input.fence, observedAtMs: Date.now() },
      )) as CtfProofOperationRecord,
    markProofOperationCompleted: async (operationId, completion) =>
      (await completeManagedConditionRedeemFenced(operationId, completion, {
        fence: input.fence,
        observedAtMs: Date.now(),
      })) as CtfProofOperationRecord,
    markProofOperationFailed: async (operationId, message, evidence) =>
      (await failManagedConditionRedeemFenced(
        operationId,
        message,
        evidence as AuthenticatedCtfRedeemTerminalEvidence,
        { fence: input.fence, observedAtMs: Date.now() },
      )) as CtfProofOperationRecord,
  }
}

async function nextRetirementPage(
  conditionId: string,
  mintUrl: string,
): Promise<RetirementPage | null> {
  const candidates = (await ensureState()).wallet.proofs
    .filter(
      (record) =>
        record.state === 'available' &&
        record.mintUrl === mintUrl &&
        record.asset.kind === 'Outcome' &&
        record.asset.conditionId === conditionId,
    )
    .sort(compareProofRecords)
  const first = candidates[0]
  if (first === undefined || first.asset.kind !== 'Outcome') return null
  const firstOutcomeSetId = first.asset.outcomeSetId
  const group = candidates.filter(
    (record) =>
      record.proof.id === first.proof.id &&
      record.asset.kind === 'Outcome' &&
      record.asset.outcomeSetId === firstOutcomeSetId,
  )
  const pageSize =
    group.length > RETIREMENT_PAGE_PROOF_MAX ? RETIREMENT_PAGE_PROOF_MAX - 1 : group.length
  return {
    keysetId: requiredText(first.proof.id, 'retirement keyset'),
    outcomeSetId: firstOutcomeSetId,
    proofs: group.slice(0, pageSize).map((record) => normalizeProof(record.proof)),
  }
}

async function buildRetirementPreview(
  conditionId: string,
  mintUrl: string,
  resolvedOutcome: string,
  dependencies: WalletOpsDependencies | undefined,
): Promise<RetirementPreview> {
  const records = (await ensureState()).wallet.proofs.filter(
    (record) =>
      record.state === 'available' &&
      record.mintUrl === mintUrl &&
      record.asset.kind === 'Outcome' &&
      record.asset.conditionId === conditionId,
  )
  const redeemable = records.filter((record) => proofMatchesOutcome(record, resolvedOutcome))
  const retained = records.filter((record) => !proofMatchesOutcome(record, resolvedOutcome))
  const keysetIds = redeemable.map((record) => requiredText(record.proof.id, 'retirement keyset'))
  const feePpk = await resolveCtfConsolidationInputFees(mintUrl, keysetIds, dependencies)
  const groups = new Map<string, Proof[]>()
  for (const record of redeemable) {
    const key = `${record.proof.id}\0${record.asset.kind === 'Outcome' ? record.asset.outcomeSetId : ''}`
    groups.set(key, [...(groups.get(key) ?? []), normalizeProof(record.proof)])
  }
  let fee = 0
  for (const group of groups.values()) {
    for (let offset = 0; offset < group.length; ) {
      const remaining = group.length - offset
      const count =
        remaining > RETIREMENT_PAGE_PROOF_MAX ? RETIREMENT_PAGE_PROOF_MAX - 1 : remaining
      const page = group.slice(offset, offset + count)
      fee += computeInputFeeSatsForProofs(page, feePpk)
      offset += count
    }
  }
  const gross = redeemable.reduce((sum, record) => sum + amountToNumber(record.proof.amount), 0)
  const retainedAmount = retained.reduce(
    (sum, record) => sum + amountToNumber(record.proof.amount),
    0,
  )
  return {
    proofCount: records.length,
    redeemableProofCount: redeemable.length,
    retainedProofCount: retained.length,
    grossAmountSubunits: gross,
    retainedAmountSubunits: retainedAmount,
    estimatedInputFeeSubunits: fee,
  }
}

function proofMatchesOutcome(record: StoredProofRecord, outcome: string): boolean {
  return record.asset.kind === 'Outcome' && record.asset.outcomeSetId.split('|').includes(outcome)
}

function verifyAttestation(
  binding: ManagedConditionInventoryBinding,
  response: ConditionAttestationResponse,
): { resolution: ReturnType<typeof verifyDlcConditionResolution>; oracleWitness: string } {
  if (canonicalConditionId(response.conditionId) !== binding.conditionId) {
    throw new Error('condition attestation response is foreign')
  }
  const prepared = prepareDlcConditionResolutionEvidence(
    response.attestedOutcome,
    response.oracleWitness,
  )
  const registered = registeredAuthority(binding, response.registeredAuthority)
  return {
    resolution: verifyDlcConditionResolution(binding, registered, prepared.evidence),
    oracleWitness: prepared.canonicalOracleWitness,
  }
}

function registeredAuthority(
  binding: ManagedConditionInventoryBinding,
  value: unknown,
): PersistedRegisteredDlcConditionAuthority {
  if (!record(value)) throw new Error('registered condition authority is invalid')
  return {
    schemaVersion: 1,
    ...binding,
    eventId: value.eventId as string,
    outcomes: value.outcomes as string[],
    threshold: value.threshold as number,
    oracles: value.oracles as PersistedRegisteredDlcConditionAuthority['oracles'],
  }
}

function inventoryBinding(
  fence: CustodyScopeFence,
  profile: DaemonProfile,
  conditionId: string,
): ManagedConditionInventoryBinding {
  return {
    scopeId: fence.scopeId,
    normalizedMint: canonicalProofOperationMintIdentity(profile.mintUrl),
    unit: 'msat',
    conditionId,
    canonicalParentCollectionId: null,
  }
}

function retirementResolution(
  persisted: NonNullable<Awaited<ReturnType<typeof loadManagedConditionInventory>>>,
) {
  if (persisted.state.state === 'active') {
    throw new Error('managed condition inventory is active')
  }
  return persisted.state.resolution
}

function retirementOperationId(input: {
  readonly scopeId: string
  readonly conditionId: string
  readonly evidenceFingerprint: string
  readonly keysetId: string
  readonly proofs: readonly Proof[]
}): string {
  const digest = createHash('sha256')
    .update('bitcaster:daemon-managed-condition-retirement:v1\0')
    .update(input.conditionId)
    .update('\0')
    .update(input.evidenceFingerprint)
    .update('\0')
    .update(input.keysetId)
  for (const proof of input.proofs) digest.update('\0').update(proof.secret)
  const retainedOperationKey = `managed-condition-retirement:${digest.digest('hex')}`
  return deriveDurableCustodyOperationId(input.scopeId, {
    retainedOperationKey,
    binding: {
      kind: 'wallet',
      activityId: `managed-condition-retirement:${input.conditionId}`,
      stage: 'ctf-redeem',
    },
  })
}

function result(
  conditionId: string,
  state: WalletRetireConditionResult['state'],
  preview: RetirementPreview,
): WalletRetireConditionResult {
  return {
    conditionId,
    state,
    action: 'redeem-winning-and-retain-losing',
    ...preview,
    netAmountSubunits: Math.max(0, preview.grossAmountSubunits - preview.estimatedInputFeeSubunits),
  }
}

function compareProofRecords(left: StoredProofRecord, right: StoredProofRecord): number {
  return (
    requiredText(left.proof.id, 'proof keyset').localeCompare(
      requiredText(right.proof.id, 'proof keyset'),
    ) ||
    (left.asset.kind === 'Outcome' ? left.asset.outcomeSetId : '').localeCompare(
      right.asset.kind === 'Outcome' ? right.asset.outcomeSetId : '',
    ) ||
    left.proof.secret.localeCompare(right.proof.secret)
  )
}

function normalizeProof(value: ProofOperationRecord['inputs'][number]): Proof {
  return { ...value, amount: amountToNumber(value.amount) as never } as Proof
}

function canonicalConditionId(value: string): string {
  const result = value.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(result)) throw new Error('condition id is invalid')
  return result
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is invalid`)
  return value
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface RetirementPage {
  readonly keysetId: string
  readonly outcomeSetId: string
  readonly proofs: Proof[]
}

interface RetirementPreview {
  readonly proofCount: number
  readonly redeemableProofCount: number
  readonly retainedProofCount: number
  readonly grossAmountSubunits: number
  readonly retainedAmountSubunits: number
  readonly estimatedInputFeeSubunits: number
}
