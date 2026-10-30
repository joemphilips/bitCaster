import {
  createSeedRecoveryScanPolicy,
  validateSeedRecoveryScanPolicy,
  type SeedRecoveryScanPolicy,
} from '@bitcaster-market/client-sdk/seedRecoveryScanPolicy'
import { requireValidCashuProofs } from '@bitcaster-market/client-sdk/cashuProofAdmission'
import { deserializeOutputGroups } from '@bitcaster-market/client-sdk/ctfSplit'
import {
  assertDurableCustodyMintOperationAuthority,
  prepareDurableCustodyVerifiedMintResult,
} from '@bitcaster-market/client-sdk/durableCustodyMintResult'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { seedRecoveryMnemonicBytes } from '@bitcaster-market/client-sdk/seedRecoveryMnemonic'
import { readOwnerPrivateRecoveryPhraseFile } from '@bitcaster-market/client-sdk/seedRecoveryPhraseFile'
import {
  CheckStateEnum,
  Mint as CashuMint,
  Wallet as CashuWallet,
  hashToCurve,
  type Proof,
  type ProofState,
  type MintKeys,
} from '@cashu/cashu-ts'
import {
  planEmergencySeedRecoveryBatchCount,
  classifyEmergencySeedRecoveryProof,
  commitEmergencySeedRecoveryBatch,
  createEmergencySeedRecoveryCoCommit,
  type EmergencySeedRecoveryBatchObservation,
  type EmergencySeedRecoveryCursor,
  type EmergencySeedRecoveryLeaseAuthority,
} from '@bitcaster-market/client-sdk/emergencySeedRecovery'
import {
  discoverConditionSeedRecoveryKeysets,
  bindExactSeedRecoveryResponse,
  bindRetainedOutputRecoveryResponse,
  planExactSeedRecoveryBatch,
  validateConditionalKeysetSeedRecoveryAuthority,
  validateConditionalKeysetSeedRecoveryDescriptor,
  type ConditionalKeysetSeedRecoveryAuthority,
  type ConditionalKeysetSeedRecoveryDescriptor,
} from '@bitcaster-market/client-sdk/conditionalKeysetSeedRecovery'
import { SeedRecoverySqliteStore, type SeedRecoveryObservedProof } from './seedRecoverySqlite.ts'
import {
  claimCustodyScopeLease,
  releaseCustodyScopeLease,
  renewCustodyScopeLease,
  type CustodyScopeFence,
} from './profileFencing.ts'
import { profileDir, readProfile } from './profile.ts'
import { acquireDaemonRunLock } from './runLock.ts'
import { createDaemonStateSqliteSession, type DaemonStateSqliteSession } from './stateSqlite.ts'
import { createCustodyProofSqliteRow } from './custodyProofSqliteRow.ts'
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '@bitcaster-market/client-sdk/durableCustody'

export interface ExplicitSeedRecoveryBatch {
  readonly observation: EmergencySeedRecoveryBatchObservation
  readonly proofs: readonly SeedRecoveryObservedProof[]
}

export interface WalletSeedRecoveryResult {
  readonly recoveryId: string
  readonly state: 'active' | 'completed'
  readonly selectedKeysetCount: number
  readonly completedChildCount: number
  readonly batchesProcessed: number
  readonly retainedOutputProofsImported?: number
  readonly gapLimit: number
  readonly scanPolicy: SeedRecoveryScanPolicy
  readonly scannedRanges: readonly {
    keysetId: string
    startCounter: 0
    nextCounter: number
    stopReason: EmergencySeedRecoveryCursor['stopReason']
  }[]
  readonly uncoveredLocalCounterBindings: {
    count: number
    capped: boolean
    diagnostic: 'uncovered-local-counter-bindings' | null
  }
}

export interface OfflineDaemonSeedRecoveryInput {
  readonly recoveryId: string
  readonly mintUrl: string
  readonly unit: 'sat' | 'msat'
  readonly walletSeedHexFile?: string
  readonly recoveryPhraseFile?: string
  readonly disclosureAcknowledged: true
  readonly scanPolicy?: SeedRecoveryScanPolicy
  /** Test-only mint transport. Production uses cashu-ts. */
  readonly transport?: AllKeysetSeedRecoveryTransport
}

export interface AllKeysetSeedRecoveryRequest {
  readonly recoveryId: string
  readonly mintUrl: string
  readonly unit: 'sat' | 'msat'
  readonly walletSeedHex: string
  readonly disclosureAcknowledged: true
  readonly scanPolicy?: SeedRecoveryScanPolicy
}

interface RecoveryWallet {
  loadMint(): Promise<void>
  keyChain: {
    getKeyset(keysetId?: string): MintKeys
    ensureKeysetKeys(keysetId: string): Promise<unknown>
    registerConditionalKeyset?: (
      metadata: {
        readonly id: string
        readonly unit: string
        readonly active: boolean
        readonly input_fee_ppk?: number
        readonly final_expiry?: number
        readonly conditional: {
          readonly conditionId: string
          readonly outcomeCollection: string
          readonly outcomeCollectionId: string
          readonly registeredAt: number
        }
      },
      keys: MintKeys,
    ) => unknown
  }
  checkProofsStates(proofs: Proof[]): Promise<ProofState[]>
}

export interface AllKeysetSeedRecoveryTransport {
  readonly wallet: RecoveryWallet
  listRegularKeysets(): Promise<unknown>
  listConditionalKeysets(conditionId: string): Promise<unknown>
  getConditionalKeyset(id: string): Promise<unknown>
  restoreCandidates(outputs: readonly unknown[]): Promise<unknown>
}

const MAX_WALLET_SEED_FILE_BYTES = 256
const CUSTODY_LEASE_RENEW_INTERVAL_MS = 20_000

/**
 * Run one emergency recovery while the daemon runtime is excluded. This
 * command owns the run lock and the custody lease for all mint I/O.
 */
export async function runOfflineDaemonSeedRecovery(
  input: OfflineDaemonSeedRecoveryInput,
): Promise<WalletSeedRecoveryResult> {
  recoveryPolicy(input)
  assertProductRecoveryUnit(input.unit)
  if (!input.disclosureAcknowledged) {
    throw new Error('seed recovery requires explicit disclosure acknowledgement')
  }
  if ((input.walletSeedHexFile === undefined) === (input.recoveryPhraseFile === undefined)) {
    throw new Error(
      'seed recovery requires exactly one of --wallet-seed-hex-file or --recovery-phrase-file',
    )
  }
  const runLock = await acquireDaemonRunLock()
  try {
    return await runOfflineRecoveryWithLease(input)
  } finally {
    await runLock.release()
  }
}

async function runOfflineRecoveryWithLease(
  input: OfflineDaemonSeedRecoveryInput,
): Promise<WalletSeedRecoveryResult> {
  const profile = await readProfile()
  if (profile === null) throw new Error('daemon profile is not initialized')
  if (input.mintUrl !== profile.mintUrl)
    throw new Error('seed recovery mint does not match the profile')
  const walletSeedHex = await readRecoverySeedInput(input)
  const storage = createDaemonStateSqliteSession(profileDir())
  const fence = await claimOfflineRecoveryFence(storage, walletSeedHex)
  const renewal = createOfflineLeaseRenewal(storage, fence)
  try {
    return await recoverOfflineSeed(input, walletSeedHex, renewal, storage)
  } finally {
    try {
      await renewal.stop()
    } finally {
      await releaseCustodyScopeLease(storage, renewal.releaseFence(), Date.now())
    }
  }
}

async function claimOfflineRecoveryFence(
  storage: DaemonStateSqliteSession,
  walletSeedHex: string,
): Promise<CustodyScopeFence> {
  const seed = Uint8Array.from(Buffer.from(walletSeedHex, 'hex'))
  try {
    return claimCustodyScopeLease(storage, {
      scopeId: deriveDurableCustodyScopeId({
        scopeKind: 'wallet',
        walletId: deriveDurableCustodyWalletId(seed),
      }),
      incarnationId: randomUUID(),
      observedAtMs: Date.now(),
    })
  } finally {
    seed.fill(0)
  }
}

function recoverOfflineSeed(
  input: OfflineDaemonSeedRecoveryInput,
  walletSeedHex: string,
  renewal: OfflineLeaseRenewal,
  storage: DaemonStateSqliteSession,
): Promise<WalletSeedRecoveryResult> {
  return recoverAllDaemonWalletFromSeed(
    {
      recoveryId: input.recoveryId,
      mintUrl: input.mintUrl,
      unit: input.unit,
      walletSeedHex,
      scanPolicy: recoveryPolicy(input),
      disclosureAcknowledged: input.disclosureAcknowledged,
    },
    {
      directory: profileDir(),
      storage,
      getFence: () => renewal.fence(),
      transport:
        input.transport ??
        createAllKeysetRecoveryTransport(input.mintUrl, input.unit, walletSeedHex),
    },
  )
}

export async function runExplicitEmergencySeedRecovery(input: {
  recoveryId: string
  walletScopeId: string
  mintUrl: string
  unit: 'sat' | 'msat'
  keysetId: string
  disclosureAcknowledged: boolean
  authority: EmergencySeedRecoveryLeaseAuthority
  store: SeedRecoverySqliteStore
  batches: readonly ExplicitSeedRecoveryBatch[]
  scanPolicy?: SeedRecoveryScanPolicy
}): Promise<EmergencySeedRecoveryCursor> {
  assertProductRecoveryUnit(input.unit)
  if (!input.disclosureAcknowledged) {
    throw new Error('seed recovery requires explicit disclosure acknowledgement')
  }
  if (input.batches.length === 0 || input.batches.length > 4) {
    throw new Error('seed recovery requires between one and four explicit batches')
  }
  const scanPolicy = recoveryPolicy(input)
  const binding = {
    recoveryId: input.recoveryId,
    walletScopeId: input.walletScopeId,
    mintUrl: input.mintUrl,
    unit: input.unit,
    scanPolicy,
  }
  const roster = await input.store.readRecoveryRoster(binding)
  if (roster.state === 'absent' || roster.state === 'pending') {
    await input.store.initializeRecoveryRoster({
      ...binding,
      disclosureAcknowledged: true,
      keysetIds: [input.keysetId],
      authority: input.authority,
    })
  } else if (!roster.keysetIds.includes(input.keysetId)) {
    throw new Error('seed recovery keyset is outside the pinned roster')
  }
  let cursor = (
    await input.store.readRecoveryStart({
      recoveryId: input.recoveryId,
      walletScopeId: input.walletScopeId,
      mintUrl: input.mintUrl,
      unit: input.unit,
      keysetId: input.keysetId,
      scanPolicy,
    })
  ).cursor
  for (const [batchIndex, batch] of input.batches.entries()) {
    if (
      batch.observation.requestedCount > 300 ||
      batch.observation.startCounter !== cursor.nextCounter ||
      batch.observation.expectedRevision !== cursor.revision
    ) {
      throw new Error('seed recovery batch counter authority is invalid')
    }
    const selectableProofIds = batch.proofs
      .filter(
        ({ mintState }) => classifyEmergencySeedRecoveryProof(mintState) === 'import-selectable',
      )
      .map(({ proof }) => proof.proofId)
    const commit = createEmergencySeedRecoveryCoCommit({
      cursor,
      observation: batch.observation,
      recoveredProofIds: selectableProofIds,
      recoveryJobId: input.recoveryId,
      authority: input.authority,
    })
    input.store.stageBatch(input.recoveryId, input.keysetId, batch.proofs)
    await commitEmergencySeedRecoveryBatch(input.store, commit)
    cursor = commit.nextCursor
    if (cursor.state === 'completed') {
      const next = input.batches[batchIndex + 1]
      if (next !== undefined && next.observation.scanThroughCounter <= cursor.nextCounter) {
        throw new Error('seed recovery contains batches after completion')
      }
    }
  }
  return cursor
}

type RegularKeysetDescriptor = { readonly id: string; readonly unit: 'sat' | 'msat' }
type SelectedRecoveryKeyset =
  | { readonly kind: 'regular'; readonly id: string; readonly unit: 'sat' | 'msat' }
  | { readonly kind: 'conditional'; readonly authority: ConditionalKeysetSeedRecoveryAuthority }

export async function recoverAllDaemonWalletFromSeed(
  input: AllKeysetSeedRecoveryRequest,
  deps: {
    readonly directory: string
    readonly getFence: () => CustodyScopeFence
    readonly transport: AllKeysetSeedRecoveryTransport
    readonly nowMs?: () => number
    readonly invocationId?: () => string
    readonly storage?: DaemonStateSqliteSession
  },
): Promise<WalletSeedRecoveryResult> {
  const policy = recoveryPolicy(input)
  assertProductRecoveryUnit(input.unit)
  assertWalletSeedHex(input.walletSeedHex)
  const seed = Uint8Array.from(Buffer.from(input.walletSeedHex, 'hex'))
  try {
    const fence = deps.getFence()
    assertRecoverySeedScope(seed, fence)
    const observedAtMs = (deps.nowMs ?? Date.now)()
    const store = createRecoveryStore(deps, fence, observedAtMs)
    await store.initializeRecoveryJob({
      recoveryId: input.recoveryId,
      walletScopeId: fence.scopeId,
      mintUrl: input.mintUrl,
      unit: input.unit,
      scanPolicy: policy,
      disclosureAcknowledged: true,
      authority: recoveryAuthorityFromFence(fence, observedAtMs),
    })
    const retainedRoster = await store.readRecoveryRoster({
      recoveryId: input.recoveryId,
      walletScopeId: fence.scopeId,
      mintUrl: input.mintUrl,
      unit: input.unit,
      scanPolicy: policy,
    })
    if (retainedRoster.state === 'completed')
      return finalizeRecoveryResult(
        input,
        deps,
        store,
        fence,
        retainedRoster.keysetIds.map((id) => ({ kind: 'regular' as const, id, unit: input.unit })),
        0,
      )
    const selected = await selectRecoveryKeysets(
      input,
      deps.transport,
      store,
      fence,
      Math.floor(observedAtMs / 1000),
    )
    await initializeRecoveryRoster(input, deps, store, fence, selected)
    await initializeRecoveryWallet(deps.transport.wallet, selected, policy)
    const retainedOutputProofsImported =
      policy.scope === 'condition'
        ? 0
        : await recoverRetainedClaimOutputs(input, deps, store, fence)
    const batchesProcessed = await scanSelectedKeysets(input, deps, store, fence, seed, selected)
    return {
      ...(await finalizeRecoveryResult(input, deps, store, fence, selected, batchesProcessed)),
      retainedOutputProofsImported,
    }
  } finally {
    seed.fill(0)
  }
}

async function recoverRetainedClaimOutputs(
  input: AllKeysetSeedRecoveryRequest,
  deps: Parameters<typeof recoverAllDaemonWalletFromSeed>[1],
  store: SeedRecoverySqliteStore,
  fence: CustodyScopeFence,
): Promise<number> {
  if (input.unit !== 'msat') return 0
  let after = ''
  let imported = 0
  for (let pageNumber = 0; pageNumber < 64; pageNumber += 1) {
    const page = await store.readRetainedClaimPage(input.mintUrl, after, {
      recoveryId: input.recoveryId,
      scanPolicy: recoveryPolicy(input),
    })
    if (page.length === 0) return imported
    for (const retained of page) {
      const outputs = deserializeOutputGroups(retained.target.outputs).regular ?? []
      if (outputs.length === 0 || outputs.length > 256)
        throw new Error('retained payout output bound is invalid')
      const authority = assertDurableCustodyMintOperationAuthority(
        retained.record,
        retained.exactAuthority,
      )
      const response = await deps.transport.restoreCandidates(
        outputs.map(({ blindedMessage }) => ({
          ...blindedMessage,
          amount: blindedMessage.amount.toString(),
        })),
      )
      const matches = bindRetainedOutputRecoveryResponse({ outputs, response })
      if (matches.length === 0) continue
      if (matches.length !== outputs.length)
        throw new Error('retained payout restore is incomplete')
      const proofs = matches.map(({ outputData, signature }) => {
        const keyset = authority.keysets.find(({ id }) => id === outputData.blindedMessage.id)
        if (keyset === undefined) throw new Error('retained payout keyset is absent')
        return outputData.toProof(
          { ...signature, amount: outputData.blindedMessage.amount },
          keyset,
        )
      })
      prepareDurableCustodyVerifiedMintResult({
        record: retained.record,
        exactAuthority: retained.exactAuthority,
        result: { regular: proofs },
      })
      const states = await classifyRestoredProofStates(proofs, deps.transport.wallet)
      if (states === null) throw new Error('retained payout mint state is pending')
      const live = deps.getFence()
      assertRecoveryOwnerUnchanged(fence, live)
      store.setAuthority(live, (deps.nowMs ?? Date.now)())
      imported += await store.commitRetainedClaimPayout({
        recoveryId: input.recoveryId,
        scanPolicy: recoveryPolicy(input),
        operationId: retained.target.operationId,
        authorityFingerprint: retained.exactAuthority.fingerprint,
        proofs,
        unspentProofSecrets: proofs
          .filter((_, index) => states[index] === 'UNSPENT')
          .map(({ secret }) => secret),
      })
    }
    after = page[page.length - 1]!.target.operationId
    if (page.length < 16) return imported
  }
  if (
    (
      await store.readRetainedClaimPage(input.mintUrl, after, {
        recoveryId: input.recoveryId,
        scanPolicy: recoveryPolicy(input),
      })
    ).length === 0
  )
    return imported
  throw new Error('retained payout recovery record bound exceeded')
}

function createRecoveryStore(
  deps: Parameters<typeof recoverAllDaemonWalletFromSeed>[1],
  fence: CustodyScopeFence,
  observedAtMs: number,
): SeedRecoverySqliteStore {
  return new SeedRecoverySqliteStore({
    directory: deps.directory,
    fence,
    invocationId: (deps.invocationId ?? randomUUID)(),
    observedAtMs,
    ...(deps.storage === undefined ? {} : { storage: deps.storage }),
  })
}

async function selectRecoveryKeysets(
  input: AllKeysetSeedRecoveryRequest,
  transport: AllKeysetSeedRecoveryTransport,
  store: SeedRecoverySqliteStore,
  fence: CustodyScopeFence,
  observedUnixSeconds: number,
): Promise<readonly SelectedRecoveryKeyset[]> {
  const policy = recoveryPolicy(input)
  const roster = await store.readRecoveryRoster({
    recoveryId: input.recoveryId,
    walletScopeId: fence.scopeId,
    mintUrl: input.mintUrl,
    unit: input.unit,
    scanPolicy: policy,
  })
  const regular =
    policy.scope === 'regular-msat'
      ? decodeRegularKeysets(await transport.listRegularKeysets(), input.unit)
      : []
  const conditional =
    policy.scope === 'condition'
      ? decodeConditionalKeysets(
          await transport.listConditionalKeysets(policy.conditionId),
          input.unit,
        )
      : []
  if (
    policy.scope === 'condition' &&
    conditional.some((row) => row.conditionId !== policy.conditionId)
  )
    throw new Error('seed recovery condition listing is foreign')
  const listed = new Set([...regular, ...conditional].map((row) => row.id))
  if (roster.keysetIds.some((id) => !listed.has(id)))
    throw new Error('seed recovery pinned scoped authority is absent')
  const rosterIds = new Set(roster.keysetIds)
  const pin = roster.state === 'active' || roster.state === 'completed'
  const selectedRegular = pin ? regular.filter((row) => rosterIds.has(row.id)) : regular
  const eligible = conditional.filter((row) =>
    pin ? rosterIds.has(row.id) : row.finalExpiry === null || row.finalExpiry > observedUnixSeconds,
  )
  const ids = [...selectedRegular, ...eligible].map((row) => row.id)
  if (ids.length > 2048) throw new Error('seed recovery selected roster exceeds bound')
  await store.assertRecoveryKeysetMintBindings({
    walletScopeId: fence.scopeId,
    mintUrl: input.mintUrl,
    keysetIds: ids,
  })
  // Scope high-water checks to listed selected IDs. Unclassified counters stay uncovered.
  const highWaters = await store.readRecoveryCounterHighWaterMarks({
    walletScopeId: fence.scopeId,
    mintUrl: input.mintUrl,
    unit: input.unit,
    keysetIds: ids,
  })
  return selectAndLoadConditionalKeysets(
    selectedRegular,
    eligible,
    highWaters,
    new Set(eligible.map((row) => row.id)),
    rosterIds,
    transport,
  )
}

function decodeRegularKeysets(
  value: unknown,
  unit: 'sat' | 'msat',
): readonly RegularKeysetDescriptor[] {
  const rows = decodeKeysetList(value, 'regular')
  const selected = rows
    .filter((row) => row.unit === unit)
    .map((row) => ({ id: row.id, unit: row.unit }))
  assertV2UniqueIds(selected, 'regular')
  return selected as RegularKeysetDescriptor[]
}

function decodeConditionalKeysets(
  value: unknown,
  unit: string,
): readonly ConditionalKeysetSeedRecoveryDescriptor[] {
  const rows = decodeKeysetList(value, 'conditional').map(
    validateConditionalKeysetSeedRecoveryDescriptor,
  )
  if (rows.some((row) => row.unit !== unit))
    throw new Error('seed recovery condition listing has a foreign unit')
  assertV2UniqueIds(rows, 'conditional')
  return rows
}

function decodeKeysetList(value: unknown, label: string): readonly Record<string, unknown>[] {
  const rows =
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as { keysets?: unknown }).keysets)
      ? (value as { keysets: unknown[] }).keysets
      : undefined
  if (rows === undefined || rows.length > 1_024)
    throw new Error(`${label} keyset listing is invalid`)
  if (rows.some((row) => typeof row !== 'object' || row === null || Array.isArray(row))) {
    throw new Error(`${label} keyset listing is invalid`)
  }
  return rows as readonly Record<string, unknown>[]
}

function assertV2UniqueIds(rows: readonly { readonly id: unknown }[], label: string): void {
  const ids = new Set<string>()
  for (const row of rows) {
    if (typeof row.id !== 'string' || !/^01[0-9a-f]{64}$/.test(row.id) || ids.has(row.id)) {
      throw new Error(`${label} keyset is not a unique NUT-02 V2 secp256k1 keyset`)
    }
    ids.add(row.id)
  }
}

function asKeysetKeys(value: unknown): { readonly keys: unknown } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('conditional keyset keys are invalid')
  }
  const keys = (value as { keys?: unknown }).keys
  if (keys === undefined) throw new Error('conditional keyset keys are invalid')
  return { keys }
}

async function selectAndLoadConditionalKeysets(
  regular: readonly RegularKeysetDescriptor[],
  conditional: readonly ConditionalKeysetSeedRecoveryDescriptor[],
  highWaters: ReadonlyMap<string, number>,
  discovered: ReadonlySet<string>,
  rosterKeysetIds: ReadonlySet<string>,
  transport: AllKeysetSeedRecoveryTransport,
): Promise<readonly SelectedRecoveryKeyset[]> {
  const selectedConditional = conditional.filter(
    ({ id }) => discovered.has(id) || rosterKeysetIds.has(id) || (highWaters.get(id) ?? 0) > 0,
  )
  const authorities: ConditionalKeysetSeedRecoveryAuthority[] = []
  for (const descriptor of selectedConditional) {
    const raw = await transport.getConditionalKeyset(descriptor.id)
    const authority = validateConditionalKeysetSeedRecoveryAuthority({
      id: descriptor.id,
      unit: descriptor.unit,
      active: descriptor.active,
      ...(descriptor.inputFeePpk === 0 ? {} : { input_fee_ppk: descriptor.inputFeePpk }),
      ...(descriptor.finalExpiry === null ? {} : { final_expiry: descriptor.finalExpiry }),
      condition_id: descriptor.conditionId,
      outcome_collection: descriptor.outcomeCollection,
      outcome_collection_id: descriptor.outcomeCollectionId,
      registered_at: descriptor.registeredAt,
      ...asKeysetKeys(raw),
    })
    if (authority.id !== descriptor.id) throw new Error('conditional keyset authority is foreign')
    authorities.push(authority)
  }
  const selected: SelectedRecoveryKeyset[] = [
    ...regular.map((keyset) => ({ kind: 'regular' as const, ...keyset })),
    ...authorities.map((authority) => ({ kind: 'conditional' as const, authority })),
  ]
  assertV2UniqueIds(
    selected.map((keyset) => ({ id: recoveryKeysetId(keyset) })),
    'selected',
  )
  return selected.sort((left, right) =>
    recoveryKeysetId(left).localeCompare(recoveryKeysetId(right)),
  )
}

async function initializeRecoveryRoster(
  input: AllKeysetSeedRecoveryRequest,
  deps: Parameters<typeof recoverAllDaemonWalletFromSeed>[1],
  store: SeedRecoverySqliteStore,
  startFence: CustodyScopeFence,
  selected: readonly SelectedRecoveryKeyset[],
): Promise<void> {
  const { fence, observedAtMs } = refreshRecoveryStoreAuthority(deps, store, startFence)
  await store.initializeRecoveryRoster(
    recoveryRosterInput(input, fence, observedAtMs, selected.map(recoveryKeysetId)),
  )
}

async function initializeRecoveryWallet(
  wallet: RecoveryWallet,
  selected: readonly SelectedRecoveryKeyset[],
  policy: SeedRecoveryScanPolicy,
): Promise<void> {
  if (policy.scope === 'regular-msat') await wallet.loadMint()
  for (const keyset of selected) {
    if (keyset.kind === 'regular') {
      await wallet.keyChain.ensureKeysetKeys(keyset.id)
    } else {
      registerConditionalKeyset(wallet, keyset.authority)
    }
  }
}

function registerConditionalKeyset(
  wallet: RecoveryWallet,
  authority: ConditionalKeysetSeedRecoveryAuthority,
): void {
  if (wallet.keyChain.registerConditionalKeyset === undefined) {
    throw new Error('seed recovery wallet cannot register a conditional keyset')
  }
  wallet.keyChain.registerConditionalKeyset(
    {
      id: authority.id,
      unit: authority.unit,
      active: authority.active,
      ...(authority.inputFeePpk === 0 ? {} : { input_fee_ppk: authority.inputFeePpk }),
      ...(authority.finalExpiry === null ? {} : { final_expiry: authority.finalExpiry }),
      conditional: {
        conditionId: authority.conditionId,
        outcomeCollection: authority.outcomeCollection,
        outcomeCollectionId: authority.outcomeCollectionId,
        registeredAt: authority.registeredAt,
      },
    },
    { id: authority.id, unit: authority.unit, keys: authority.keys },
  )
}

async function scanSelectedKeysets(
  input: AllKeysetSeedRecoveryRequest,
  deps: Parameters<typeof recoverAllDaemonWalletFromSeed>[1],
  store: SeedRecoverySqliteStore,
  fence: CustodyScopeFence,
  seed: Uint8Array,
  selected: readonly SelectedRecoveryKeyset[],
): Promise<number> {
  let processed = 0
  const selectedIds = selected.map(recoveryKeysetId)
  const pending = new Set(selectedIds)
  const blocked = new Set<string>()
  const ordered = await orderSelectedForFairScan(input, deps, store, fence, selected)
  while (processed < 4 && pending.size > 0) {
    let attempted = false
    for (const keyset of ordered) {
      const keysetId = recoveryKeysetId(keyset)
      if (processed === 4 || !pending.has(keysetId) || blocked.has(keysetId)) continue
      const start = await store.readRecoveryStart(recoveryStartInput(input, fence, keyset))
      if (start.cursor.state === 'completed') {
        pending.delete(keysetId)
        continue
      }
      const batch = await scanSelectedKeysetBatch(input, deps, fence, seed, keyset, start)
      processed += 1
      attempted = true
      switch (batch.state) {
        case 'completed':
          pending.delete(keysetId)
          break
        case 'blocked':
          blocked.add(keysetId)
          break
        case 'ready':
          await commitSelectedBatch(input, deps, store, fence, keyset, batch.batch)
          break
      }
    }
    if (!attempted) break
  }
  return processed
}

async function orderSelectedForFairScan(
  input: AllKeysetSeedRecoveryRequest,
  deps: Parameters<typeof recoverAllDaemonWalletFromSeed>[1],
  store: SeedRecoverySqliteStore,
  startFence: CustodyScopeFence,
  selected: readonly SelectedRecoveryKeyset[],
): Promise<readonly SelectedRecoveryKeyset[]> {
  if (selected.length === 0) return selected
  const { fence, observedAtMs } = refreshRecoveryStoreAuthority(deps, store, startFence)
  const start = await store.claimRecoveryScanStart(
    recoveryRosterInput(input, fence, observedAtMs, selected.map(recoveryKeysetId)),
  )
  return [...selected.slice(start), ...selected.slice(0, start)]
}

function refreshRecoveryStoreAuthority(
  deps: Parameters<typeof recoverAllDaemonWalletFromSeed>[1],
  store: SeedRecoverySqliteStore,
  startFence: CustodyScopeFence,
): { readonly fence: CustodyScopeFence; readonly observedAtMs: number } {
  const fence = deps.getFence()
  assertRecoveryOwnerUnchanged(startFence, fence)
  const observedAtMs = (deps.nowMs ?? Date.now)()
  store.setAuthority(fence, observedAtMs)
  return { fence, observedAtMs }
}

function recoveryRosterInput(
  input: AllKeysetSeedRecoveryRequest,
  fence: CustodyScopeFence,
  observedAtMs: number,
  keysetIds: readonly string[],
) {
  return {
    recoveryId: input.recoveryId,
    walletScopeId: fence.scopeId,
    mintUrl: input.mintUrl,
    unit: input.unit,
    disclosureAcknowledged: true as const,
    scanPolicy: recoveryPolicy(input),
    keysetIds,
    authority: recoveryAuthorityFromFence(fence, observedAtMs),
  }
}

function recoveryStartInput(
  input: AllKeysetSeedRecoveryRequest,
  fence: CustodyScopeFence,
  keyset: SelectedRecoveryKeyset,
) {
  return {
    recoveryId: input.recoveryId,
    walletScopeId: fence.scopeId,
    mintUrl: input.mintUrl,
    unit: input.unit,
    keysetId: recoveryKeysetId(keyset),
    scanPolicy: recoveryPolicy(input),
  }
}

async function scanSelectedKeysetBatch(
  input: AllKeysetSeedRecoveryRequest,
  deps: Parameters<typeof recoverAllDaemonWalletFromSeed>[1],
  fence: CustodyScopeFence,
  seed: Uint8Array,
  keyset: SelectedRecoveryKeyset,
  start: Awaited<ReturnType<SeedRecoverySqliteStore['readRecoveryStart']>>,
): Promise<
  | { readonly state: 'completed' }
  | { readonly state: 'blocked' }
  | { readonly state: 'ready'; readonly batch: ExplicitSeedRecoveryBatch }
> {
  if (start.cursor.state !== 'active' && start.cursor.nextCounter >= start.counterHighWaterMark) {
    return { state: 'completed' }
  }
  const count = planEmergencySeedRecoveryBatchCount(start.cursor, start.counterHighWaterMark)
  if (count === 0) return { state: 'completed' }
  const candidates = planExactSeedRecoveryBatch({
    seed,
    keysetId: recoveryKeysetId(keyset),
    startCounter: start.cursor.nextCounter,
    count,
  })
  const restored = bindExactSeedRecoveryResponse({
    candidates,
    response: await deps.transport.restoreCandidates(
      candidates.map(({ blindedOutput }) => blindedOutput),
    ),
  })
  const keysetAuthority = deps.transport.wallet.keyChain.getKeyset(recoveryKeysetId(keyset))
  const proofs = restored.matches.map(({ candidate, signature }) =>
    candidate.outputData.toProof(signature, keysetAuthority),
  )
  verifyRestoredProofs(proofs, deps.transport.wallet)
  const states = await classifyRestoredProofStates(proofs, deps.transport.wallet)
  if (states === null) return { state: 'blocked' }
  return {
    state: 'ready',
    batch: {
      observation: {
        expectedRevision: start.cursor.revision,
        startCounter: start.cursor.nextCounter,
        requestedCount: count,
        lastCounterWithSignature: restored.lastCounterWithSignature,
        scanThroughCounter: start.counterHighWaterMark,
      },
      proofs: proofs.map((proof, index) =>
        observedSelectedProof(
          fence.scopeId,
          input.mintUrl,
          input.unit,
          proof,
          states[index]!,
          keyset,
          (deps.nowMs ?? Date.now)(),
        ),
      ),
    },
  }
}

function verifyRestoredProofs(proofs: readonly Proof[], wallet: RecoveryWallet): void {
  requireValidCashuProofs([...proofs], (keysetId) => wallet.keyChain.getKeyset(keysetId))
}

async function classifyRestoredProofStates(
  proofs: readonly Proof[],
  wallet: RecoveryWallet,
): Promise<readonly ('UNSPENT' | 'SPENT')[] | null> {
  if (proofs.length === 0) return []
  const states = await wallet.checkProofsStates([...proofs])
  if (states.length !== proofs.length)
    throw new Error('seed recovery mint returned mismatched proof states')
  const expected = new Set(
    proofs.map((proof) => hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true)),
  )
  const observed = new Map<string, 'UNSPENT' | 'SPENT'>()
  for (const state of states) {
    if (!expected.delete(state.Y))
      throw new Error('seed recovery mint returned foreign proof state')
    switch (state.state) {
      case CheckStateEnum.UNSPENT:
        observed.set(state.Y, 'UNSPENT')
        break
      case CheckStateEnum.SPENT:
        observed.set(state.Y, 'SPENT')
        break
      case CheckStateEnum.PENDING:
        return null
      default:
        return null
    }
  }
  if (expected.size !== 0) throw new Error('seed recovery mint omitted proof state')
  return proofs.map(
    (proof) => observed.get(hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true))!,
  )
}

async function commitSelectedBatch(
  input: AllKeysetSeedRecoveryRequest,
  deps: Parameters<typeof recoverAllDaemonWalletFromSeed>[1],
  store: SeedRecoverySqliteStore,
  fence: CustodyScopeFence,
  keyset: SelectedRecoveryKeyset,
  batch: ExplicitSeedRecoveryBatch,
): Promise<void> {
  const live = deps.getFence()
  assertRecoveryOwnerUnchanged(fence, live)
  const observedAtMs = (deps.nowMs ?? Date.now)()
  store.setAuthority(live, observedAtMs)
  await runExplicitEmergencySeedRecovery({
    recoveryId: input.recoveryId,
    walletScopeId: live.scopeId,
    mintUrl: input.mintUrl,
    unit: input.unit,
    keysetId: recoveryKeysetId(keyset),
    disclosureAcknowledged: true,
    authority: recoveryAuthorityFromFence(live, observedAtMs),
    store,
    batches: [batch],
    scanPolicy: recoveryPolicy(input),
  })
}

async function finalizeRecoveryResult(
  input: AllKeysetSeedRecoveryRequest,
  deps: Parameters<typeof recoverAllDaemonWalletFromSeed>[1],
  store: SeedRecoverySqliteStore,
  fence: CustodyScopeFence,
  selected: readonly SelectedRecoveryKeyset[],
  batchesProcessed: number,
): Promise<WalletSeedRecoveryResult> {
  const children = await Promise.all(
    selected.map((keyset) => store.readRecoveryStart(recoveryStartInput(input, fence, keyset))),
  )
  const completedChildCount = children.filter(({ cursor }) => cursor.state === 'completed').length
  const state = completedChildCount === selected.length ? 'completed' : 'active'
  if (state === 'completed') {
    const live = deps.getFence()
    assertRecoveryOwnerUnchanged(fence, live)
    const observedAtMs = (deps.nowMs ?? Date.now)()
    store.setAuthority(live, observedAtMs)
    await store.finalizeRecoveryJob({
      recoveryId: input.recoveryId,
      walletScopeId: live.scopeId,
      mintUrl: input.mintUrl,
      unit: input.unit,
      disclosureAcknowledged: true,
      discoveryCompleted: true,
      scanPolicy: recoveryPolicy(input),
      authority: recoveryAuthorityFromFence(live, observedAtMs),
    })
  }
  return {
    recoveryId: input.recoveryId,
    state,
    selectedKeysetCount: selected.length,
    completedChildCount,
    batchesProcessed,
    gapLimit: recoveryPolicy(input).gapLimit,
    scanPolicy: recoveryPolicy(input),
    scannedRanges: children.map(({ cursor }) => ({
      keysetId: cursor.keysetId,
      startCounter: 0 as const,
      nextCounter: cursor.nextCounter,
      stopReason: cursor.stopReason,
    })),
    uncoveredLocalCounterBindings: await store.readUncoveredCounterBindings({
      mintUrl: input.mintUrl,
      unit: input.unit,
      keysetIds: selected.map(recoveryKeysetId),
    }),
  }
}

function recoveryKeysetId(keyset: SelectedRecoveryKeyset): string {
  return keyset.kind === 'regular' ? keyset.id : keyset.authority.id
}

function observedSelectedProof(
  scopeId: string,
  mintUrl: string,
  unit: 'sat' | 'msat',
  proof: Proof,
  mintState: 'UNSPENT' | 'SPENT',
  keyset: SelectedRecoveryKeyset,
  nowMs: number,
): SeedRecoveryObservedProof {
  const conditional = keyset.kind === 'conditional' ? keyset.authority : null
  const row = createCustodyProofSqliteRow({
    scopeId,
    normalizedMint: mintUrl,
    unit,
    proof: {
      id: proof.id,
      amount: proof.amount,
      secret: proof.secret,
      C: proof.C,
      dleq: proof.dleq ?? null,
      p2pkE: proof.p2pk_e ?? null,
      witness: proof.witness ?? null,
    },
    baseAsset: 'sat',
    conditionId: conditional?.conditionId ?? null,
    outcomeSetId: conditional?.outcomeCollection ?? null,
    productBinding: null,
    signatureVerified: true,
    dleqState: 'verified',
    nut07State: mintState,
    selectability: mintState === 'UNSPENT' ? 'selectable' : 'spent',
    storageClass: 'pinned-operation-bound-deterministic',
    reservationOperationId: null,
    revision: 0,
    nowMs,
  })
  return {
    proofY: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
    mintState,
    proof: row,
  }
}

export function createAllKeysetRecoveryTransport(
  mintUrl: string,
  unit: string,
  seedHex: string,
): AllKeysetSeedRecoveryTransport {
  const mint = new CashuMint(mintUrl)
  const wallet = new CashuWallet(mint, {
    unit,
    bip39seed: Uint8Array.from(Buffer.from(seedHex, 'hex')),
  })
  return {
    wallet,
    listRegularKeysets: () => mint.getKeySets(),
    listConditionalKeysets: (conditionId) =>
      discoverConditionSeedRecoveryKeysets({ conditionId, unit, mint }),
    async getConditionalKeyset(id) {
      const keys = await mint.getKeys(id)
      const keyset = keys.keysets.find((candidate) => candidate.id === id)
      if (keyset === undefined) throw new Error('mint omitted conditional keyset keys')
      return keyset
    },
    restoreCandidates: (outputs) => mint.restore({ outputs: outputs as never }),
  }
}

function assertWalletSeedHex(walletSeedHex: string): void {
  if (!/^[0-9a-f]{128}$/.test(walletSeedHex)) {
    throw new Error('wallet seed must be a 64-byte lowercase hex value')
  }
}

function assertProductRecoveryUnit(unit: string): asserts unit is 'msat' {
  if (unit !== 'msat') {
    throw new Error('seed recovery supports only the msat product unit')
  }
}

function assertRecoverySeedScope(seed: Uint8Array, fence: CustodyScopeFence): void {
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: 'wallet',
    walletId: deriveDurableCustodyWalletId(seed),
  })
  if (scopeId !== fence.scopeId) {
    throw new Error('seed recovery wallet seed does not match the active profile')
  }
}

function recoveryAuthorityFromFence(fence: CustodyScopeFence, observedAtMs: number) {
  return {
    walletScopeId: fence.scopeId,
    incarnationId: fence.incarnationId,
    fencingEpoch: fence.fencingEpoch,
    observedAtMs,
    leaseExpiresAtMs: fence.leaseExpiresAtMs,
    effectiveClockHighWaterMarkMs: observedAtMs,
  }
}

interface OfflineLeaseRenewal {
  fence(): CustodyScopeFence
  releaseFence(): CustodyScopeFence
  stop(): Promise<void>
}

function createOfflineLeaseRenewal(
  storage: DaemonStateSqliteSession,
  initialFence: CustodyScopeFence,
): OfflineLeaseRenewal {
  let fence = initialFence
  let failure: Error | undefined
  let inFlight: Promise<void> | undefined
  let stopped = false
  const renew = () => {
    if (stopped || inFlight !== undefined) return
    inFlight = renewCustodyScopeLease(storage, fence, Date.now())
      .then((renewed) => {
        fence = renewed
      })
      .catch((error: unknown) => {
        failure = error instanceof Error ? error : new Error(String(error))
      })
      .finally(() => {
        inFlight = undefined
      })
  }
  const timer = setInterval(renew, CUSTODY_LEASE_RENEW_INTERVAL_MS)
  timer.unref()
  return {
    fence() {
      if (failure !== undefined) throw failure
      return fence
    },
    releaseFence() {
      return fence
    },
    async stop() {
      stopped = true
      clearInterval(timer)
      await inFlight
      if (failure !== undefined) throw failure
    },
  }
}

export async function readRecoverySeedInput(input: {
  readonly walletSeedHexFile?: string
  readonly recoveryPhraseFile?: string
}): Promise<string> {
  if ((input.walletSeedHexFile === undefined) === (input.recoveryPhraseFile === undefined)) {
    throw new Error(
      'seed recovery requires exactly one of --wallet-seed-hex-file or --recovery-phrase-file',
    )
  }
  if (input.walletSeedHexFile !== undefined) {
    return readOwnerPrivateWalletSeedHexFile(input.walletSeedHexFile)
  }
  return Buffer.from(
    seedRecoveryMnemonicBytes(await readOwnerPrivateRecoveryPhraseFile(input.recoveryPhraseFile!)),
  ).toString('hex')
}

async function readOwnerPrivateWalletSeedHexFile(path: string): Promise<string> {
  if (process.platform === 'win32') {
    throw new Error(
      '--wallet-seed-hex-file is not supported on Windows until ACL validation exists',
    )
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) throw new Error('--wallet-seed-hex-file must name a regular file')
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error('--wallet-seed-hex-file must not be accessible by group or other users')
    }
    if (metadata.size > MAX_WALLET_SEED_FILE_BYTES) {
      throw new Error(`--wallet-seed-hex-file exceeds ${MAX_WALLET_SEED_FILE_BYTES} bytes`)
    }
    const walletSeedHex = (await readBoundedSeedFile(file)).toString('utf8').trim()
    assertWalletSeedHex(walletSeedHex)
    return walletSeedHex
  } finally {
    await file.close()
  }
}

async function readBoundedSeedFile(file: Awaited<ReturnType<typeof open>>): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  while (total <= MAX_WALLET_SEED_FILE_BYTES) {
    const remaining = MAX_WALLET_SEED_FILE_BYTES + 1 - total
    const buffer = Buffer.allocUnsafe(Math.min(64, remaining))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, total)
    if (bytesRead === 0) break
    chunks.push(buffer.subarray(0, bytesRead))
    total += bytesRead
  }
  if (total > MAX_WALLET_SEED_FILE_BYTES) {
    throw new Error(`--wallet-seed-hex-file exceeds ${MAX_WALLET_SEED_FILE_BYTES} bytes`)
  }
  return Buffer.concat(chunks, total)
}

function assertRecoveryOwnerUnchanged(start: CustodyScopeFence, live: CustodyScopeFence): void {
  if (
    start.scopeId !== live.scopeId ||
    start.incarnationId !== live.incarnationId ||
    start.fencingEpoch !== live.fencingEpoch
  ) {
    throw new Error('seed recovery fence owner or epoch changed during mint I/O')
  }
}

function recoveryPolicy(input: {
  readonly scanPolicy?: SeedRecoveryScanPolicy
}): SeedRecoveryScanPolicy {
  return input.scanPolicy === undefined
    ? createSeedRecoveryScanPolicy()
    : validateSeedRecoveryScanPolicy(input.scanPolicy)
}
