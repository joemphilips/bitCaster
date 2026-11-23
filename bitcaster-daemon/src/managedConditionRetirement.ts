import { createSpeculativeRedeemPreparation } from './speculativeRedeemPreparation.ts'
import { creditedProofAmountMsat, writeNativeCompletedActivity } from './nativeCompletedActivity.ts'
import { boundedErrorText } from './mintErrorText.ts'
import { isDeepStrictEqual } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import { profileDir } from './profile.ts'
import { createDaemonStateSqliteSession } from './stateSqlite.ts'
import {
  bindRegisteredDlcConditionAuthority,
  type ConditionOracleResolutionContext,
} from '@bitcaster-market/client-sdk/conditionOracleEvidence'
import type {
  ConditionResolution,
  RegisteredConditionAuthority,
} from '@bitcaster-market/client-sdk/conditionResolution'
import type { DurableCustodyMintKeysetAuthority } from '@bitcaster-market/client-sdk/durableCustodyMintResult'
import {
  CONDITION_RESOLUTION_READ_TIMEOUT_MS,
  verifiedConditionEvidence,
  type DaemonConditionResolution,
} from './nativeConditionResolution.ts'
import { readNativePositionClaimInputKeyset } from './nativePositionClaim.ts'
import {
  createCustodyRedeemOperationStore,
  fencedRedeemWallet,
  readCustodyRedeemOperation,
  type CustodyRedeemPurpose,
} from './custodyRedeemOperation.ts'
import { createHash, randomUUID } from 'node:crypto'
import type { Proof } from '@cashu/cashu-ts'
import {
  createManagedConditionRetirementIntent,
  prepareDlcConditionResolutionEvidence,
  verifyDlcConditionResolution,
  type ManagedConditionInventoryBinding,
} from '@bitcaster-market/client-sdk/managedConditionInventory'
import {
  canonicalProofOperationMintIdentity,
  UneconomicCtfRedeemError,
} from '@bitcaster-market/client-sdk/ctfRedeem'
import { deriveDurableCustodyOperationId } from '@bitcaster-market/client-sdk/durableCustody'
import {
  amountToNumber,
  computeInputFeeSubunitsForProofs,
} from '@bitcaster-market/client-sdk/proofSelection'
import type { CustodyScopeFence } from './profileFencing.ts'
import type { DaemonProfile } from './profile.ts'
import type { WalletRetireConditionResult } from './protocol.ts'
import {
  MANAGED_CONDITION_RETIREMENT_PURPOSE,
  completeManagedConditionRedeemFromDatabase,
  custodyHoldsAvailableConditionProofsFromDatabase,
  ensureState,
  failManagedConditionRedeemFromDatabase,
  retainUneconomicConditionProofsFenced,
  type ProofOperationRecord,
  type StoredProofAsset,
  type StoredProofRecord,
} from './state.ts'
import {
  completeManagedConditionRetirement,
  isManagedConditionRetiredFromDatabase,
  listRetiringManagedConditionBindings,
  loadManagedConditionInventory,
  assertManagedConditionMutationFromDatabase,
  startManagedConditionRetirement,
} from './managedConditionInventorySqlite.ts'
import {
  resolveCtfConsolidationInputFees,
  restoreOutputGroups,
  type WalletOpsDependencies,
  type WalletOpsSecrets,
} from './walletOps.ts'

const RETIREMENT_PAGE_PROOF_MAX = 64

/** The owner of the locked wallet rows of an uneconomic page. No operation has this id. */
const UNECONOMIC_RETENTION_PREFIX = 'retained:'

/** The RPC code of a condition retirement without a verified result. Nothing is saved. */
export const CONDITION_RETIREMENT_RESULT_UNAVAILABLE_CODE =
  'condition-retirement-result-unavailable'

/**
 * The daemon cannot read a verified result of this condition. A retirement
 * saves its verified result before the first redeem, so it cannot start
 * without one. The refusal saves nothing. A later command reads the result again.
 */
export class ConditionRetirementResultUnavailableError extends Error {
  readonly code = CONDITION_RETIREMENT_RESULT_UNAVAILABLE_CODE
}

/** The RPC code of a condition retirement that custody cannot redeem. Nothing is saved. */
export const CONDITION_RETIREMENT_CUSTODY_INCOMPLETE_CODE =
  'condition-retirement-custody-incomplete'

/**
 * Custody does not hold some available position of this condition. A
 * retirement redeems only through custody, so it does not start. The
 * refusal saves nothing.
 */
export class ConditionRetirementCustodyIncompleteError extends Error {
  readonly code = CONDITION_RETIREMENT_CUSTODY_INCOMPLETE_CODE
  constructor() {
    super(
      'custody does not hold every position of this condition, so the retirement does not start',
    )
  }
}

export interface ConditionRetirementResult {
  readonly conditionId: string
  readonly error: string | null
}

export interface ResolvedConditionDiscovery {
  /** The conditions that the scan retired, or whose started retirement failed. */
  readonly results: ConditionRetirementResult[]
  /**
   * The held conditions whose oracle result is due but not verified yet. The
   * announced maturity has passed, the engine reported a close, or the mint
   * reports a result without verifiable evidence. A later scan reads them again.
   */
  readonly awaitingAttestation: string[]
  /**
   * The conditions that failed before a retirement started, for example
   * because the mint did not answer. Nothing is unfinished, so they do not
   * hold the funds commands. A later scan reads them again.
   */
  readonly discoveryFailures: ConditionRetirementResult[]
  /** The earliest announced maturity of a held condition that is not due yet. */
  readonly nextMaturityMs: number | null
}

/**
 * Retire each held condition whose result the daemon can verify without the
 * engine. The mint record comes first. Then, for a condition that is due,
 * the oracle attestation on the relays. The engine close event is only a hint
 * that a condition can be due before its announced maturity.
 */
export async function retireResolvedDaemonConditions(input: {
  readonly profile: DaemonProfile
  readonly secrets: WalletOpsSecrets
  readonly fence: CustodyScopeFence
  readonly resolution: DaemonConditionResolution
  readonly walletDependencies?: WalletOpsDependencies
  readonly resolutionReadTimeoutMs?: number
  /** The conditions that the engine reported closed. */
  readonly closedConditionIds?: ReadonlySet<string>
  readonly nowMs?: number
}): Promise<ResolvedConditionDiscovery> {
  const nowMs = input.nowMs ?? Date.now()
  const results: ConditionRetirementResult[] = []
  const awaitingAttestation: string[] = []
  const discoveryFailures: ConditionRetirementResult[] = []
  let nextMaturityMs: number | null = null
  for (const conditionId of await heldConditionIds(input.profile.mintUrl)) {
    const due = (maturityEpoch: number) =>
      input.closedConditionIds?.has(conditionId) === true || maturityEpoch * 1000 <= nowMs
    try {
      const read = await readResolutionWithin(
        input.resolution,
        conditionId,
        input.resolutionReadTimeoutMs ?? CONDITION_RESOLUTION_READ_TIMEOUT_MS,
        due,
      )
      const state = read.state
      switch (state.status) {
        case 'resolved':
          await retireDaemonConditionInventory({
            ...input,
            conditionId,
            acknowledge: true,
            intentKind: 'daemon-standing-policy',
            resolution: { read: async () => read },
          })
          results.push({ conditionId, error: null })
          break
        case 'pending':
          if (due(read.maturityEpoch)) awaitingAttestation.push(conditionId)
          else nextMaturityMs = Math.min(nextMaturityMs ?? Infinity, read.maturityEpoch * 1000)
          break
        case 'unverified':
          // The mint reports a result. Its evidence can become readable later.
          awaitingAttestation.push(conditionId)
          break
        case 'refused':
          // The mint does not redeem this condition by an oracle result. Nothing to retry.
          break
        default:
          assertNever(state)
      }
    } catch (error) {
      const failure = { conditionId, error: boundedErrorText(error) }
      if (await retirementStarted(input.fence, input.profile, conditionId)) results.push(failure)
      else discoveryFailures.push(failure)
    }
  }
  return { results, awaitingAttestation, discoveryFailures, nextMaturityMs }
}

/** A retirement started when its inventory is `retiring`. Then its work is unfinished. */
async function retirementStarted(
  fence: CustodyScopeFence,
  profile: DaemonProfile,
  conditionId: string,
): Promise<boolean> {
  const inventory = await loadManagedConditionInventory(
    inventoryBinding(fence, profile, canonicalConditionId(conditionId)),
  )
  return inventory?.state.state === 'retiring'
}

async function readResolutionWithin(
  resolution: DaemonConditionResolution,
  conditionId: string,
  timeoutMs: number,
  readRelays: (maturityEpoch: number) => boolean,
): Promise<ConditionResolution> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('condition resolution read timed out')),
    timeoutMs,
  )
  try {
    const read = resolution.read(conditionId, { signal: controller.signal, readRelays })
    // A reader that ignores the signal still cannot hold the scan.
    return await Promise.race([
      read,
      new Promise<never>((_resolve, reject) => {
        if (controller.signal.aborted) reject(controller.signal.reason)
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
          once: true,
        })
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The conditions of which the wallet holds an available outcome proof. A
 * retirement redeems only these proofs. Retired, retained and locked rows are
 * history, so the scan does not grow with them.
 */
async function heldConditionIds(mintUrl: string): Promise<string[]> {
  const conditionIds = new Set<string>()
  for (const record of (await ensureState()).wallet.proofs) {
    if (
      record.asset.kind === 'Outcome' &&
      record.state === 'available' &&
      record.mintUrl === mintUrl
    ) {
      conditionIds.add(record.asset.conditionId)
    }
  }
  return [...conditionIds].sort()
}

/**
 * Finish the started retirements. Only the mint is read: the frozen
 * inventory already holds the verified result and its witness.
 */
export async function resumeDaemonConditionRetirements(input: {
  readonly profile: DaemonProfile
  readonly secrets: WalletOpsSecrets
  readonly fence: CustodyScopeFence
  readonly resolution: DaemonConditionResolution
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
      })
      results.push({ conditionId: binding.conditionId, error: null })
    } catch (error) {
      results.push({ conditionId: binding.conditionId, error: boundedErrorText(error) })
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
  readonly resolution: DaemonConditionResolution
  readonly walletDependencies?: WalletOpsDependencies
}): Promise<WalletRetireConditionResult> {
  const conditionId = canonicalConditionId(input.conditionId)
  const binding = inventoryBinding(input.fence, input.profile, conditionId)
  const current = await loadManagedConditionInventory(binding)
  let verified: ReturnType<typeof verifyResolution> | null = null
  let currentResolution: () => Promise<ConditionResolution>
  if (current === null) {
    let read: ConditionResolution
    try {
      read = await readResolutionWithin(
        input.resolution,
        conditionId,
        CONDITION_RESOLUTION_READ_TIMEOUT_MS,
        () => true,
      )
    } catch {
      throw new ConditionRetirementResultUnavailableError(
        'the condition result could not be read from the mint; try again later',
      )
    }
    if (read.state.status !== 'resolved')
      throw new ConditionRetirementResultUnavailableError(unavailableResultReason(read.state))
    verified = verifyResolution(binding, read.registeredAuthority, read.state)
    currentResolution = async () => read
  } else {
    // A started retirement reads only the mint. An unreadable record throws before a new page.
    currentResolution = once(() =>
      readResolutionWithin(
        input.resolution,
        conditionId,
        CONDITION_RESOLUTION_READ_TIMEOUT_MS,
        () => false,
      ),
    )
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
  const assertStartable = (database: DatabaseSync) => {
    if (!custodyHoldsAvailableConditionProofsFromDatabase(database, binding))
      throw new ConditionRetirementCustodyIncompleteError()
  }
  if (!input.acknowledge) {
    if (current === null) await createDaemonStateSqliteSession(profileDir()).read(assertStartable)
    return result(conditionId, 'preview', preview)
  }

  let persisted = current
  if (persisted === null) {
    persisted = await startManagedConditionRetirement({
      fence: input.fence,
      binding,
      assertStartable,
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
  await resumePreparedRetirementOperations({ ...input, persisted, currentResolution })
  while (true) {
    const page = await nextRetirementPage(conditionId, input.profile.mintUrl)
    if (page === null) break
    await redeemRetirementPage({ ...input, persisted, page, currentResolution })
  }
  await completeManagedConditionRetirement({
    fence: input.fence,
    binding,
    observedAtMs: Date.now(),
  })
  return result(conditionId, 'retired', preview)
}

function once<T>(read: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined
  return () => (value ??= read())
}

async function resumePreparedRetirementOperations(input: {
  readonly conditionId: string
  readonly profile: DaemonProfile
  readonly secrets: WalletOpsSecrets
  readonly fence: CustodyScopeFence
  readonly walletDependencies?: WalletOpsDependencies
  readonly persisted: NonNullable<Awaited<ReturnType<typeof loadManagedConditionInventory>>>
  /** The current mint record. A page is prepared only when the mint can redeem it. */
  readonly currentResolution: () => Promise<ConditionResolution>
}): Promise<void> {
  const operations = Object.values((await ensureState()).proofOperations)
    .filter((operation) => operation.kind === 'ctf-redeem' && operation.state === 'prepared')
    .sort((left, right) => left.operationId.localeCompare(right.operationId))
  for (const operation of operations) {
    if (
      operation.metadata.purpose !== MANAGED_CONDITION_RETIREMENT_PURPOSE ||
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
  /** The current mint record. A page is prepared only when the mint can redeem it. */
  readonly currentResolution: () => Promise<ConditionResolution>
}): Promise<void> {
  const resolution = retirementResolution(input.persisted)
  const operationId = retirementOperationId({
    scopeId: input.fence.scopeId,
    conditionId: input.conditionId,
    evidenceFingerprint: resolution.evidenceFingerprint,
    keysetId: input.page.keysetId,
    proofs: input.page.proofs,
  })
  const asset = {
    kind: 'Outcome' as const,
    conditionId: input.conditionId,
    outcomeSetId: input.page.outcomeSetId,
    baseAsset: 'sat' as const,
    unit: 'msat' as const,
  }
  const purpose = retirementPurpose({
    operationId,
    asset,
    fence: input.fence,
    persisted: input.persisted,
  })
  const preparation = createSpeculativeRedeemPreparation({
    operationId,
    mintUrl: input.profile.mintUrl,
    seed: Buffer.from(input.secrets.walletSeedHex, 'hex'),
    fence: input.fence,
    wallet: fencedRedeemWallet(input, input.profile.mintUrl, operationId, purpose.authority),
  })
  const wallet = preparation.wallet
  const store = createCustodyRedeemOperationStore(
    input,
    operationId,
    asset,
    wallet,
    preparation,
    purpose,
  )
  const existing = await store.getProofOperation(operationId)
  let context = existing?.metadata.oracleResolutionContext as
    | ConditionOracleResolutionContext
    | undefined
  let inputKeysets = existing?.metadata.oracleInputKeysets as
    | readonly DurableCustodyMintKeysetAuthority[]
    | undefined
  if (existing === null) {
    // Prepare a new page only when the mint can redeem it. An unreadable mint record throws here.
    const current = await input.currentResolution()
    context = frozenRetirementContext(input, current.registeredAuthority)
    if (context === undefined) {
      assertMintRecordsOutcome(current.state, resolution.resolvedOutcome)
    } else {
      inputKeysets = [
        await readNativePositionClaimInputKeyset(
          input.profile.mintUrl,
          asset,
          input.page.keysetId,
          wallet,
        ),
      ]
    }
  }
  try {
    const result = await preparation.run({
      mintUrl: input.profile.mintUrl,
      operationId,
      wallet,
      proofOperationStore: store,
      conditionId: input.conditionId,
      outcome: resolution.resolvedOutcome,
      outcomeSetId: input.page.outcomeSetId,
      outcomeKeysetId: input.page.keysetId,
      unit: 'msat',
      oracleWitness:
        existing === null
          ? context === undefined
            ? ''
            : input.persisted.oracleWitness
          : (existing.metadata.oracleWitness as string),
      oracleResolutionContext: context,
      oracleInputKeysets: inputKeysets,
      proofs: input.page.proofs,
      restoreOutputGroups,
    })
    if (result.refused) throw new Error('condition retirement mint refusal remains pending')
  } catch (error) {
    if (!(error instanceof UneconomicCtfRedeemError)) throw error
    await retainUneconomicConditionProofsFenced({
      proofs: input.page.proofs,
      mintUrl: input.profile.mintUrl,
      asset,
      retentionId: `${UNECONOMIC_RETENTION_PREFIX}${operationId}`,
      mutation: { fence: input.fence, observedAtMs: Date.now() },
    })
  }
}

/**
 * True when a locked wallet row is history of a retired condition: an input of
 * a losing page or of an uneconomic page. A retired condition has no unfinished
 * work, so no operation can use the row. Valid only in the caller's
 * synchronous database snapshot.
 */
export function isRetiredConditionProofFromDatabase(
  database: DatabaseSync,
  scopeId: string,
  proof: StoredProofRecord,
): boolean {
  const owner = proof.reservedBy
  if (
    proof.state !== 'locked' ||
    owner === undefined ||
    proof.retirement !== undefined ||
    proof.asset.kind !== 'Outcome' ||
    proof.asset.unit !== 'msat'
  )
    return false
  // A losing page locks its exact reserved inputs, so its owner is a failed page.
  if (
    !owner.startsWith(UNECONOMIC_RETENTION_PREFIX) &&
    database
      .prepare(
        `SELECT 1 FROM target_proof_operations
         WHERE scope_id = ? AND operation_id = ? AND normalized_mint = ? AND kind = 'ctf-redeem'
           AND purpose = ? AND state = 'failed' AND failure_code = 13015`,
      )
      .get(scopeId, owner, proof.mintUrl, MANAGED_CONDITION_RETIREMENT_PURPOSE) === undefined
  )
    return false
  return isManagedConditionRetiredFromDatabase(database, {
    scopeId,
    normalizedMint: proof.mintUrl,
    unit: 'msat',
    conditionId: proof.asset.conditionId,
    canonicalParentCollectionId: null,
  })
}

/**
 * The redemption context of a started retirement: its frozen witness, verified
 * again against the current mint registration. A witness that does not verify
 * is omitted, so the mint must use its recorded result. A changed authority
 * stops the retirement.
 */
function frozenRetirementContext(
  input: {
    readonly conditionId: string
    readonly profile: DaemonProfile
    readonly fence: CustodyScopeFence
    readonly persisted: NonNullable<Awaited<ReturnType<typeof loadManagedConditionInventory>>>
  },
  registered: RegisteredConditionAuthority,
): ConditionOracleResolutionContext | undefined {
  const resolution = retirementResolution(input.persisted)
  const binding = inventoryBinding(input.fence, input.profile, input.conditionId)
  let verified: ReturnType<typeof verifiedConditionEvidence>
  try {
    verified = verifiedConditionEvidence(
      binding,
      registered,
      resolution.resolvedOutcome,
      JSON.parse(input.persisted.oracleWitness),
    )
  } catch {
    return undefined
  }
  const current = verifyDlcConditionResolution(
    binding,
    verified.context.registered,
    verified.context.evidence,
  )
  if (
    current.evidenceFingerprint !== resolution.evidenceFingerprint ||
    current.authorityId !== resolution.authorityId
  )
    throw new Error('retirement current evidence differs from frozen inventory resolution')
  return verified.context
}

/**
 * Without a witness the mint redeems only by its recorded result (NUT-CTF
 * redemption rule 4). Prepare such a page only when the mint records the frozen
 * outcome. Otherwise the operation could never finish, and the unfinished
 * retirement would hold the funds commands.
 */
function assertMintRecordsOutcome(state: ConditionResolution['state'], outcome: string): void {
  switch (state.status) {
    case 'resolved':
      if (state.source === 'mint' && state.attestedOutcome === outcome) return
      break
    case 'unverified':
      if (state.reportedOutcome === outcome) return
      break
    case 'pending':
    case 'refused':
      break
    default:
      assertNever(state)
  }
  throw new Error('condition retirement has no verified witness and no mint result to redeem')
}

/**
 * A retirement page redeems through the custody redeem path of a claim. It
 * keeps its own target writers and the authority of its retiring inventory.
 * The custody operation id comes from the target id, so no link row is saved.
 */
function retirementPurpose(input: {
  readonly operationId: string
  readonly asset: Extract<StoredProofAsset, { kind: 'Outcome' }>
  readonly fence: CustodyScopeFence
  readonly persisted: NonNullable<Awaited<ReturnType<typeof loadManagedConditionInventory>>>
}): CustodyRedeemPurpose {
  const state = input.persisted.state
  if (state.state !== 'retiring') throw new Error('retirement operation requires retiring state')
  const managedConditionOperationAuthority = {
    operationId: input.operationId,
    scopeId: input.fence.scopeId,
    inventoryRevisionAtBind: state.revision,
    purpose: 'retirement-redemption' as const,
    resolutionEvidenceFingerprint: state.resolution.evidenceFingerprint,
    retirementIntentId: state.retirementIntent.intentId,
  }
  const label = 'condition retirement'
  return {
    label,
    observeStage: 'retirement',
    admissionPrefix: 'condition-retirement',
    authority: {
      purpose: MANAGED_CONDITION_RETIREMENT_PURPOSE,
      reservationId: input.operationId,
      inputAsset: input.asset,
      successorAssets: { regular: { kind: 'sats', baseAsset: 'sat', unit: 'msat' } },
    },
    targetMetadata: { managedConditionOperationAuthority },
    assertTarget: (operation) => {
      if (
        operation.operationId !== input.operationId ||
        operation.kind !== 'ctf-redeem' ||
        operation.mintUrl !== state.normalizedMint ||
        operation.metadata.purpose !== MANAGED_CONDITION_RETIREMENT_PURPOSE ||
        operation.metadata.conditionId !== input.asset.conditionId ||
        operation.metadata.outcomeSetId !== input.asset.outcomeSetId ||
        operation.metadata.reservationId !== input.operationId ||
        !isDeepStrictEqual(
          operation.metadata.managedConditionOperationAuthority,
          managedConditionOperationAuthority,
        )
      )
        throw new Error('retirement saved owner authority is foreign')
    },
    readCustody: (database, fence, target) => {
      assertManagedConditionMutationFromDatabase(
        database,
        {
          scopeId: fence.scopeId,
          normalizedMint: state.normalizedMint,
          unit: 'msat',
          conditionId: input.asset.conditionId,
          canonicalParentCollectionId: null,
        },
        { kind: 'retirement-redemption', authority: managedConditionOperationAuthority },
      )
      return readCustodyRedeemOperation(database, {
        scopeId: fence.scopeId,
        custodyOperationId: retirementCustodyOperationId(fence.scopeId, target.operationId),
        target,
        asset: input.asset,
        label,
      })
    },
    linkCustody: (_database, scopeId, targetOperationId, custodyOperationId) => {
      if (custodyOperationId !== retirementCustodyOperationId(scopeId, targetOperationId))
        throw new Error('condition retirement custody operation id is foreign')
    },
    completeTarget: completeManagedConditionRedeemFromDatabase,
    afterComplete: (database, { operationId, regular, context }) => {
      writeNativeCompletedActivity(database, {
        scopeId: context.fence.scopeId,
        sourceKind: 'condition-retirement',
        sourceId: operationId,
        type: 'payout_claimed',
        amountMsat: creditedProofAmountMsat(regular, 'msat'),
        completedAtMs: context.observedAtMs,
        txId: operationId,
      })
    },
    failTarget: failManagedConditionRedeemFromDatabase,
  }
}

/**
 * The custody operation of a retirement page. The custody record binds the
 * target id as its retained key and as its activity, as a convert does.
 */
function retirementCustodyOperationId(scopeId: string, targetOperationId: string): string {
  return deriveDurableCustodyOperationId(scopeId, {
    retainedOperationKey: targetOperationId,
    binding: { kind: 'wallet', activityId: targetOperationId, stage: 'ctf-redeem' },
  })
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
      fee += computeInputFeeSubunitsForProofs(page, feePpk)
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

/** Why a condition has no verified result with which a retirement can start. */
function unavailableResultReason(
  state: Exclude<ConditionResolution['state'], { status: 'resolved' }>,
): string {
  switch (state.status) {
    case 'pending':
      return 'the condition has no verified result yet; try again later'
    case 'unverified':
      return 'the mint reports a result without verified oracle evidence; try again later'
    case 'refused':
      return `the mint does not redeem this condition by an oracle result (${state.mintStatus})`
    default:
      return assertNever(state)
  }
}

function verifyResolution(
  binding: ManagedConditionInventoryBinding,
  registeredAuthority: RegisteredConditionAuthority,
  state: Extract<ConditionResolution['state'], { status: 'resolved' }>,
): { resolution: ReturnType<typeof verifyDlcConditionResolution>; oracleWitness: string } {
  const prepared = prepareDlcConditionResolutionEvidence(state.attestedOutcome, state.oracleWitness)
  const registered = bindRegisteredDlcConditionAuthority(binding, registeredAuthority)
  return {
    resolution: verifyDlcConditionResolution(binding, registered, prepared.evidence),
    oracleWitness: prepared.canonicalOracleWitness,
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

function assertNever(value: never): never {
  throw new Error(`unhandled condition resolution state: ${JSON.stringify(value)}`)
}
