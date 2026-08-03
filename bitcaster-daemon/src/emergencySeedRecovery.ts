import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import {
  CheckStateEnum,
  Mint as CashuMint,
  Wallet as CashuWallet,
  hashToCurve,
  hashToCurveBls,
  isBlsKeyset,
  verifyProofsForReceive,
  type Proof,
  type ProofState,
  type MintKeys,
} from '@cashu/cashu-ts'
import {
  EMERGENCY_SEED_RECOVERY_BATCH_SIZE,
  advanceEmergencySeedRecoveryCursor,
  classifyEmergencySeedRecoveryProof,
  commitEmergencySeedRecoveryBatch,
  createEmergencySeedRecoveryCoCommit,
  type EmergencySeedRecoveryBatchObservation,
  type EmergencySeedRecoveryCursor,
  type EmergencySeedRecoveryLeaseAuthority,
} from '@bitcaster-market/client-sdk/emergencySeedRecovery'
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

export interface WalletSeedRecoveryRequest {
  readonly recoveryId: string
  readonly mintUrl: string
  readonly unit: 'sat' | 'msat'
  readonly keysetId: string
  readonly walletSeedHex: string
  readonly disclosureAcknowledged: true
}

export interface WalletSeedRecoveryResult {
  readonly recoveryId: string
  readonly state: 'active' | 'completed'
  readonly nextCounter: number
  readonly batchesProcessed: number
}

export interface OfflineDaemonSeedRecoveryInput {
  readonly recoveryId: string
  readonly mintUrl: string
  readonly unit: 'sat' | 'msat'
  readonly keysetId: string
  readonly walletSeedHexFile: string
  readonly disclosureAcknowledged: true
  /** Test-only wallet adapter. Production uses cashu-ts. */
  readonly createWallet?: (mintUrl: string, unit: string, seed: Uint8Array) => RecoveryWallet
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
  if (!input.disclosureAcknowledged) {
    throw new Error('seed recovery requires explicit disclosure acknowledgement')
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
  const walletSeedHex = await readOwnerPrivateWalletSeedHexFile(input.walletSeedHexFile)
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
  return recoverDaemonWalletFromSeed(
    {
      recoveryId: input.recoveryId,
      mintUrl: input.mintUrl,
      unit: input.unit,
      keysetId: input.keysetId,
      walletSeedHex,
      disclosureAcknowledged: input.disclosureAcknowledged,
    },
    {
      directory: profileDir(),
      storage,
      getFence: () => renewal.fence(),
      ...(input.createWallet === undefined ? {} : { createWallet: input.createWallet }),
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
}): Promise<EmergencySeedRecoveryCursor> {
  if (!input.disclosureAcknowledged) {
    throw new Error('seed recovery requires explicit disclosure acknowledgement')
  }
  if (input.batches.length === 0 || input.batches.length > 4) {
    throw new Error('seed recovery requires between one and four explicit batches')
  }
  let cursor = (
    await input.store.readRecoveryStart({
      recoveryId: input.recoveryId,
      walletScopeId: input.walletScopeId,
      mintUrl: input.mintUrl,
      unit: input.unit,
      keysetId: input.keysetId,
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

interface RecoveryWallet {
  loadMint(): Promise<void>
  keyChain: { getKeysets(): Array<{ id: string }> }
  getKeyset(keysetId?: string): MintKeys
  restore(
    start: number,
    count: number,
    config: { keysetId: string },
  ): Promise<{ proofs: Proof[]; lastCounterWithSignature?: number }>
  checkProofsStates(proofs: Proof[]): Promise<ProofState[]>
}

export async function recoverDaemonWalletFromSeed(
  input: WalletSeedRecoveryRequest,
  deps: {
    directory: string
    getFence: () => CustodyScopeFence
    createWallet?: (mintUrl: string, unit: string, seed: Uint8Array) => RecoveryWallet
    nowMs?: () => number
    invocationId?: () => string
    storage?: DaemonStateSqliteSession
  },
): Promise<WalletSeedRecoveryResult> {
  assertWalletSeedHex(input.walletSeedHex)
  const seed = Uint8Array.from(Buffer.from(input.walletSeedHex, 'hex'))
  try {
    const startFence = deps.getFence()
    assertRecoverySeedScope(seed, startFence)
    const observedAtMs = (deps.nowMs ?? Date.now)()
    const store = new SeedRecoverySqliteStore({
      directory: deps.directory,
      fence: startFence,
      invocationId: (deps.invocationId ?? randomUUID)(),
      observedAtMs,
      ...(deps.storage === undefined ? {} : { storage: deps.storage }),
    })
    const recoveryStart = await readRecoveryInitialization(input, store, startFence)
    const wallet = (deps.createWallet ?? createRecoveryWallet)(input.mintUrl, input.unit, seed)
    seed.fill(0)
    const batches = await scanRecoveryBatches(input, deps, startFence, recoveryStart, wallet)
    return commitRecoveryBatches(input, deps, startFence, store, recoveryStart, batches)
  } finally {
    seed.fill(0)
  }
}

function assertWalletSeedHex(walletSeedHex: string): void {
  if (!/^[0-9a-f]{128}$/.test(walletSeedHex)) {
    throw new Error('wallet seed must be a 64-byte lowercase hex value')
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

async function readRecoveryInitialization(
  input: WalletSeedRecoveryRequest,
  store: SeedRecoverySqliteStore,
  fence: CustodyScopeFence,
) {
  return store.readRecoveryStart({
    recoveryId: input.recoveryId,
    walletScopeId: fence.scopeId,
    mintUrl: input.mintUrl,
    unit: input.unit,
    keysetId: input.keysetId,
  })
}

async function scanRecoveryBatches(
  input: WalletSeedRecoveryRequest,
  deps: Parameters<typeof recoverDaemonWalletFromSeed>[1],
  fence: CustodyScopeFence,
  recoveryStart: Awaited<ReturnType<typeof readRecoveryInitialization>>,
  wallet: RecoveryWallet,
): Promise<readonly ExplicitSeedRecoveryBatch[]> {
  await wallet.loadMint()
  if (!wallet.keyChain.getKeysets().some(({ id }) => id === input.keysetId)) {
    throw new Error('seed recovery keyset is not available from the mint')
  }
  let cursor = recoveryStart.cursor
  const batches: ExplicitSeedRecoveryBatch[] = []
  while (shouldScanRecoveryBatch(batches, cursor, recoveryStart.counterHighWaterMark)) {
    const batch = await scanRecoveryBatch(input, deps, fence.scopeId, cursor, recoveryStart, wallet)
    if (batch.proofs.some(({ mintState }) => mintState === 'PENDING')) break
    batches.push(batch)
    cursor = advanceEmergencySeedRecoveryCursor(cursor, batch.observation)
  }
  return batches
}

function shouldScanRecoveryBatch(
  batches: readonly ExplicitSeedRecoveryBatch[],
  cursor: EmergencySeedRecoveryCursor,
  counterHighWaterMark: number,
): boolean {
  return (
    batches.length < 4 && (cursor.state === 'active' || cursor.nextCounter < counterHighWaterMark)
  )
}

async function scanRecoveryBatch(
  input: WalletSeedRecoveryRequest,
  deps: Parameters<typeof recoverDaemonWalletFromSeed>[1],
  scopeId: string,
  cursor: EmergencySeedRecoveryCursor,
  recoveryStart: Awaited<ReturnType<typeof readRecoveryInitialization>>,
  wallet: RecoveryWallet,
): Promise<ExplicitSeedRecoveryBatch> {
  const restored = await wallet.restore(cursor.nextCounter, EMERGENCY_SEED_RECOVERY_BATCH_SIZE, {
    keysetId: input.keysetId,
  })
  if (restored.proofs.length > 0 && restored.lastCounterWithSignature === undefined) {
    throw new Error('seed recovery mint omitted its signature cursor')
  }
  verifyProofsForReceive(restored.proofs, (keysetId) => wallet.getKeyset(keysetId))
  const states = restored.proofs.length === 0 ? [] : await wallet.checkProofsStates(restored.proofs)
  if (states.length !== restored.proofs.length) {
    throw new Error('seed recovery mint returned mismatched proof states')
  }
  return {
    observation: {
      expectedRevision: cursor.revision,
      startCounter: cursor.nextCounter,
      requestedCount: EMERGENCY_SEED_RECOVERY_BATCH_SIZE,
      lastCounterWithSignature: restored.lastCounterWithSignature ?? null,
      scanThroughCounter: recoveryStart.counterHighWaterMark,
    },
    proofs: restored.proofs.map((proof, index) =>
      observedProof(
        scopeId,
        input.mintUrl,
        input.unit,
        proof,
        states[index]?.state,
        (deps.nowMs ?? Date.now)(),
      ),
    ),
  }
}

async function commitRecoveryBatches(
  input: WalletSeedRecoveryRequest,
  deps: Parameters<typeof recoverDaemonWalletFromSeed>[1],
  startFence: CustodyScopeFence,
  store: SeedRecoverySqliteStore,
  recoveryStart: Awaited<ReturnType<typeof readRecoveryInitialization>>,
  batches: readonly ExplicitSeedRecoveryBatch[],
): Promise<WalletSeedRecoveryResult> {
  if (batches.length === 0) {
    const cursor = recoveryStart.cursor
    return {
      recoveryId: cursor.recoveryId,
      state: cursor.state,
      nextCounter: cursor.nextCounter,
      batchesProcessed: 0,
    }
  }
  const fence = deps.getFence()
  assertRecoveryOwnerUnchanged(startFence, fence)
  const observedAtMs = (deps.nowMs ?? Date.now)()
  store.setAuthority(fence, observedAtMs)
  const cursor = await runExplicitEmergencySeedRecovery({
    ...input,
    walletScopeId: fence.scopeId,
    authority: recoveryAuthorityFromFence(fence, observedAtMs),
    store,
    batches,
  })
  return {
    recoveryId: cursor.recoveryId,
    state: cursor.state,
    nextCounter: cursor.nextCounter,
    batchesProcessed: batches.length,
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

function createRecoveryWallet(mintUrl: string, unit: string, seed: Uint8Array): RecoveryWallet {
  return new CashuWallet(new CashuMint(mintUrl), {
    unit,
    bip39seed: Uint8Array.from(seed),
  })
}

function observedProof(
  scopeId: string,
  mintUrl: string,
  unit: WalletSeedRecoveryRequest['unit'],
  proof: Proof,
  rawState: CheckStateEnum | undefined,
  nowMs: number,
): SeedRecoveryObservedProof {
  const mintState =
    rawState === CheckStateEnum.UNSPENT
      ? 'UNSPENT'
      : rawState === CheckStateEnum.PENDING
        ? 'PENDING'
        : rawState === CheckStateEnum.SPENT
          ? 'SPENT'
          : 'UNKNOWN'
  const proofY = (
    isBlsKeyset(proof.id)
      ? hashToCurveBls(new TextEncoder().encode(proof.secret))
      : hashToCurve(new TextEncoder().encode(proof.secret))
  ).toHex(true)
  const disposition = classifyEmergencySeedRecoveryProof(mintState)
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
    conditionId: null,
    outcomeSetId: null,
    productBinding: null,
    signatureVerified: true,
    dleqState: proof.dleq === undefined ? 'not-present' : 'verified',
    nut07State: mintState === 'UNSPENT' ? 'UNSPENT' : mintState === 'SPENT' ? 'SPENT' : 'PENDING',
    selectability:
      disposition === 'import-selectable'
        ? 'selectable'
        : disposition === 'ignore-spent'
          ? 'spent'
          : 'retained',
    storageClass: 'pinned-operation-bound-deterministic',
    reservationOperationId: null,
    revision: 0,
    nowMs,
  })
  return { proofY, mintState, proof: row }
}
