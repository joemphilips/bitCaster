import { createSpeculativeRedeemPreparation } from './speculativeRedeemPreparation.ts'
import { boundedErrorText } from './mintErrorText.ts'
import { isDeepStrictEqual } from 'node:util'
import { withDurableCustodyFencedRead } from './durableCustodyUnitOfWork.ts'
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
  getActiveRegularKeyset,
  type AuthenticatedCtfRedeemTerminalEvidence,
  type RedeemWallet,
} from '@bitcaster-market/client-sdk/ctfRedeem'
import type {
  CtfProofOperationRecord,
  CtfProofOperationStore,
} from '@bitcaster-market/client-sdk/ctfSplit'
import { deriveDurableCustodyOperationId } from '@bitcaster-market/client-sdk/durableCustody'
import {
  amountToNumber,
  computeInputFeeSubunitsForProofs,
} from '@bitcaster-market/client-sdk/proofSelection'
import type { CustodyScopeFence } from './profileFencing.ts'
import type { DaemonProfile } from './profile.ts'
import type { WalletRetireConditionResult } from './protocol.ts'
import {
  completeManagedConditionRedeemFenced,
  ensureState,
  failManagedConditionRedeemFenced,
  readDaemonProofOperationFromDatabase,
  assertExactProofReservationFromDatabase,
  prepareProofOperationWithExactReservation,
  retainUneconomicConditionProofsFenced,
  type ProofOperationRecord,
  type StoredProofRecord,
} from './state.ts'
import {
  completeManagedConditionRetirement,
  listRetiringManagedConditionBindings,
  loadManagedConditionInventory,
  assertManagedConditionMutationFromDatabase,
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
  let registeredAuthority: () => Promise<RegisteredConditionAuthority | undefined>
  if (current === null) {
    const read = await readResolutionWithin(
      input.resolution,
      conditionId,
      CONDITION_RESOLUTION_READ_TIMEOUT_MS,
      () => true,
    )
    if (read.state.status !== 'resolved')
      throw new Error('condition resolution attestation is not available')
    verified = verifyResolution(binding, read.registeredAuthority, read.state)
    registeredAuthority = async () => read.registeredAuthority
  } else {
    registeredAuthority = once(() => readRegisteredAuthority(input.resolution, conditionId))
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
  await resumePreparedRetirementOperations({ ...input, persisted, registeredAuthority })
  while (true) {
    const page = await nextRetirementPage(conditionId, input.profile.mintUrl)
    if (page === null) break
    await redeemRetirementPage({ ...input, persisted, page, registeredAuthority })
  }
  await completeManagedConditionRetirement({
    fence: input.fence,
    binding,
    observedAtMs: Date.now(),
  })
  return result(conditionId, 'retired', preview)
}

/**
 * The registered announcements of a started retirement, read from the mint.
 * An unreadable registration only removes the optional witness: the mint
 * then uses its recorded result.
 */
async function readRegisteredAuthority(
  resolution: DaemonConditionResolution,
  conditionId: string,
): Promise<RegisteredConditionAuthority | undefined> {
  try {
    return (
      await readResolutionWithin(
        resolution,
        conditionId,
        CONDITION_RESOLUTION_READ_TIMEOUT_MS,
        () => false,
      )
    ).registeredAuthority
  } catch {
    return undefined
  }
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
  readonly registeredAuthority: () => Promise<RegisteredConditionAuthority | undefined>
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
  readonly registeredAuthority: () => Promise<RegisteredConditionAuthority | undefined>
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
  const originalWallet = createWallet(
    input.profile.mintUrl,
    input.secrets,
    input.walletDependencies ?? {},
    'sat',
    'msat',
  ) as unknown as RedeemWallet
  const preparation = createSpeculativeRedeemPreparation({
    operationId,
    mintUrl: input.profile.mintUrl,
    seed: Buffer.from(input.secrets.walletSeedHex, 'hex'),
    fence: input.fence,
    wallet: originalWallet,
  })
  const wallet = preparation.wallet
  const store = retirementOperationStore({
    fence: input.fence,
    reservationId,
    asset,
    persisted: input.persisted,
    wallet,
    preparation,
    injectFault: input.walletDependencies?.injectCustodyFault,
    observe: input.walletDependencies?.observeRedeemPrepared,
  })
  const existing = await store.getProofOperation(operationId)
  let context = existing?.metadata.oracleResolutionContext as
    | ConditionOracleResolutionContext
    | undefined
  let inputKeysets = existing?.metadata.oracleInputKeysets as
    | readonly DurableCustodyMintKeysetAuthority[]
    | undefined
  if (existing === null) {
    const registered = await input.registeredAuthority()
    const candidate =
      registered === undefined ? undefined : frozenRetirementContext(input, registered)
    if (candidate !== undefined) {
      context = candidate
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
      retentionId: `retained:${operationId}`,
      mutation: { fence: input.fence, observedAtMs: Date.now() },
    })
  }
}

/**
 * The redemption context of a started retirement: its frozen witness, verified
 * again against the current mint registration. A witness that does not verify
 * is omitted, so the mint uses its recorded result. A changed authority stops
 * the retirement.
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

function retirementOperationStore(input: {
  readonly wallet: RedeemWallet
  readonly preparation: ReturnType<typeof createSpeculativeRedeemPreparation>
  readonly injectFault?: WalletOpsDependencies['injectCustodyFault']
  readonly observe?: WalletOpsDependencies['observeRedeemPrepared']
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
      withDurableCustodyFencedRead(
        createDaemonStateSqliteSession(profileDir()),
        input.fence,
        Date.now(),
        (database) => {
          if (operationId !== input.reservationId)
            throw new Error('retirement operation identity is foreign')
          const operation = readDaemonProofOperationFromDatabase(database, operationId)
          if (operation === null) return null
          if (
            operation.mintUrl !== state.normalizedMint ||
            operation.metadata.conditionId !== input.asset.conditionId ||
            operation.metadata.outcomeSetId !== input.asset.outcomeSetId ||
            operation.kind !== 'ctf-redeem' ||
            operation.metadata.purpose !== 'managed-condition-retirement' ||
            operation.metadata.reservationId !== input.reservationId ||
            !isDeepStrictEqual(
              operation.metadata.managedConditionOperationAuthority,
              managedConditionOperationAuthority,
            )
          )
            throw new Error('retirement saved owner authority is foreign')
          assertManagedConditionMutationFromDatabase(
            database,
            {
              scopeId: input.fence.scopeId,
              normalizedMint: operation.mintUrl,
              unit: 'msat',
              conditionId: input.asset.conditionId,
              canonicalParentCollectionId: null,
            },
            { kind: 'retirement-redemption', authority: managedConditionOperationAuthority },
          )
          if (operation.state === 'prepared')
            assertExactProofReservationFromDatabase(database, {
              ...operation,
              reservationId: input.reservationId,
              asset: input.asset,
            })
          return operation as CtfProofOperationRecord
        },
        { snapshot: true },
      ),
    prepareProofOperation: async (operation) => {
      const keyset = await getActiveRegularKeyset(input.wallet, 'msat')
      if (keyset.id !== operation.metadata?.regularKeysetId)
        throw new Error('retirement exact regular keyset is foreign')
      const regularOutputKeysetAuthority: DurableCustodyMintKeysetAuthority = {
        canonicalMintUrl: operation.mintUrl,
        id: keyset.id,
        unit: 'msat',
        keys: keyset.keys,
        inputFeePpk: keyset.input_fee_ppk ?? 0,
        finalExpiry: keyset.final_expiry ?? null,
        identity: { kind: 'regular' },
      }
      await input.observe?.('retirement', structuredClone(operation))
      const prepared = (await prepareProofOperationWithExactReservation(
        {
          ...operation,
          reservationId: input.reservationId,
          asset: input.asset,
          metadata: {
            ...operation.metadata,
            regularOutputKeysetAuthority,
            purpose: 'managed-condition-retirement',
            reservationId: input.reservationId,
            managedConditionOperationAuthority,
          },
        },
        { fence: input.fence, observedAtMs: Date.now() },
        undefined,
        input.preparation.beforePrepare,
        input.injectFault,
      )) as CtfProofOperationRecord
      input.preparation.prepared()
      return prepared
    },
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
