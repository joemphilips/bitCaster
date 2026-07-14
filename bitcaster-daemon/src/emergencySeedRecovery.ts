import { randomUUID } from 'node:crypto'
import {
  CheckStateEnum,
  Mint as CashuMint,
  Wallet as CashuWallet,
  type Proof,
  type ProofState,
} from '@cashu/cashu-ts'
import {
  EMERGENCY_SEED_RECOVERY_BATCH_SIZE,
  advanceEmergencySeedRecoveryCursor,
  classifyEmergencySeedRecoveryProof,
} from '@bitcaster-market/client-sdk/emergencySeedRecovery'
import {
  normalizeMarketBaseAsset,
  parseCashuProofUnit,
} from '@bitcaster-market/client-sdk/marketUnits'
import {
  applyDaemonStateWorkInDatabase,
  readDaemonStateDatabase,
  transactDaemonState,
  type CashuProofRecord,
  type StoredProofRecord,
} from './state.ts'
import { deriveDaemonWalletProofIdFromProof } from './stateSqlite.ts'
import {
  advanceDaemonSeedRecoveryCursor,
  ensureDaemonSeedRecoveryJob,
  readDaemonSeedRecoveryProgress,
  readNextDaemonSeedRecoveryCursor,
} from './seedRecoverySqlite.ts'
import type { DaemonEmergencySeedRecoveryResult } from './protocol.ts'

const DAEMON_SEED_RECOVERY_BATCHES_PER_INVOCATION_MAX = 4

export interface EmergencySeedRecoveryWallet {
  loadMint(): Promise<void>
  keyChain: { getKeysets(): Array<{ id: string }> }
  restore(
    start: number,
    count: number,
    config: { keysetId: string },
  ): Promise<{ proofs: Proof[]; lastCounterWithSignature?: number }>
  checkProofsStates(proofs: Proof[]): Promise<ProofState[]>
}

interface SeedRecoveryContext {
  wallet: EmergencySeedRecoveryWallet
  recoveryId: string
  initialJobState: 'active' | 'completed'
  mintUrl: string
  unit: NonNullable<ReturnType<typeof parseCashuProofUnit>>
  nowMs: () => number
}

export async function recoverDaemonWalletFromSeed(
  input: {
    mintUrl: string
    unit?: string
    walletSeedHex: string
    disclosureAcknowledged: boolean
  },
  deps: {
    createWallet?: (
      mintUrl: string,
      unit: string,
      walletSeed: Uint8Array,
    ) => EmergencySeedRecoveryWallet
    nowMs?: () => number
    createRecoveryId?: () => string
  } = {},
): Promise<DaemonEmergencySeedRecoveryResult> {
  const context = await openSeedRecovery(input, deps)
  return runSeedRecoveryBatches(context)
}

async function openSeedRecovery(
  input: Parameters<typeof recoverDaemonWalletFromSeed>[0],
  deps: NonNullable<Parameters<typeof recoverDaemonWalletFromSeed>[1]>,
): Promise<SeedRecoveryContext> {
  if (!input.disclosureAcknowledged) {
    throw new Error('seed recovery requires history-disclosure acknowledgement')
  }
  const unit = parseCashuProofUnit(input.unit ?? 'sat')
  if (unit === null) throw new Error('seed recovery mint unit is invalid')
  const walletSeed = decodeWalletSeed(input.walletSeedHex)
  const wallet = (deps.createWallet ?? createEmergencySeedRecoveryWallet)(
    input.mintUrl,
    unit,
    Uint8Array.from(walletSeed),
  )
  walletSeed.fill(0)
  await wallet.loadMint()
  const keysetIds = wallet.keyChain.getKeysets().map(({ id }) => id)
  const nowMs = deps.nowMs ?? Date.now
  const job = await transactDaemonState((database) =>
    ensureDaemonSeedRecoveryJob(database, {
      proposedRecoveryId: (deps.createRecoveryId ?? randomUUID)(),
      mintUrl: input.mintUrl,
      unit,
      keysetIds,
      disclosureAcknowledged: true,
      nowMs: nowMs(),
    }))
  return {
    wallet,
    recoveryId: job.recoveryId,
    initialJobState: job.state,
    mintUrl: input.mintUrl,
    unit,
    nowMs,
  }
}

async function runSeedRecoveryBatches(
  context: SeedRecoveryContext,
): Promise<DaemonEmergencySeedRecoveryResult> {
  let batchesProcessed = 0
  while (batchesProcessed < DAEMON_SEED_RECOVERY_BATCHES_PER_INVOCATION_MAX) {
    const cursor = await readDaemonStateDatabase((database) =>
      readNextDaemonSeedRecoveryCursor(database, context.recoveryId))
    if (cursor === null) break
    const pendingProofs = await recoverSeedBatch(context, cursor)
    if (pendingProofs !== 0) {
      return recoveryResult(context.recoveryId, {
        state: 'pending-mint-state',
        batchesProcessed,
        pendingProofs,
      })
    }
    batchesProcessed += 1
  }
  return recoveryResult(context.recoveryId, {
    state: context.initialJobState,
    batchesProcessed,
    pendingProofs: 0,
  })
}

async function recoverSeedBatch(
  context: SeedRecoveryContext,
  cursor: NonNullable<ReturnType<typeof readNextDaemonSeedRecoveryCursor>>,
): Promise<number> {
  const restored = await context.wallet.restore(
    cursor.nextCounter,
    EMERGENCY_SEED_RECOVERY_BATCH_SIZE,
    { keysetId: cursor.keysetId },
  )
  if (
    restored.proofs.length > 0
    && restored.lastCounterWithSignature === undefined
  ) {
    throw new Error('seed recovery mint omitted its signature cursor')
  }
  const classified = await classifyRestoredProofs(
    context.wallet,
    restored.proofs,
  )
  if (classified.failedClosed) {
    throw new Error('seed recovery mint proof state is invalid')
  }
  if (classified.pending.length > 0) return classified.pending.length
  const next = advanceEmergencySeedRecoveryCursor(cursor, {
    startCounter: cursor.nextCounter,
    requestedCount: EMERGENCY_SEED_RECOVERY_BATCH_SIZE,
    lastCounterWithSignature: restored.lastCounterWithSignature ?? null,
  })
  await transactDaemonState((database) => {
    const importedProofs = insertRecoveredProofs(database, {
      mintUrl: context.mintUrl,
      unit: context.unit,
      keysetId: cursor.keysetId,
      nextCounter: next.nextCounter,
      proofs: classified.unspent,
    })
    advanceDaemonSeedRecoveryCursor(database, {
      expected: cursor,
      next,
      importedProofs,
      ignoredSpentProofs: classified.spent.length,
      nowMs: context.nowMs(),
    })
  })
  return 0
}

function createEmergencySeedRecoveryWallet(
  mintUrl: string,
  unit: string,
  walletSeed: Uint8Array,
): EmergencySeedRecoveryWallet {
  return new CashuWallet(new CashuMint(mintUrl), {
    unit,
    bip39seed: walletSeed,
  })
}

async function classifyRestoredProofs(
  wallet: EmergencySeedRecoveryWallet,
  proofs: Proof[],
): Promise<{
  unspent: Proof[]
  spent: Proof[]
  pending: Proof[]
  failedClosed: boolean
}> {
  if (proofs.length === 0) {
    return { unspent: [], spent: [], pending: [], failedClosed: false }
  }
  const states = await wallet.checkProofsStates(proofs)
  if (states.length !== proofs.length) {
    return { unspent: [], spent: [], pending: [], failedClosed: true }
  }
  const classified = {
    unspent: [] as Proof[],
    spent: [] as Proof[],
    pending: [] as Proof[],
    failedClosed: false,
  }
  for (const [index, proof] of proofs.entries()) {
    const mintState = states[index]?.state
    const disposition = classifyEmergencySeedRecoveryProof(
      mintState === CheckStateEnum.UNSPENT
        ? 'UNSPENT'
        : mintState === CheckStateEnum.SPENT
          ? 'SPENT'
          : mintState === CheckStateEnum.PENDING
            ? 'PENDING'
            : 'UNKNOWN',
    )
    if (disposition === 'import-selectable') classified.unspent.push(proof)
    else if (disposition === 'ignore-spent') classified.spent.push(proof)
    else if (disposition === 'retain-nonselectable') classified.pending.push(proof)
    else classified.failedClosed = true
  }
  return classified
}

function insertRecoveredProofs(
  database: Parameters<typeof applyDaemonStateWorkInDatabase>[0],
  input: {
    mintUrl: string
    unit: NonNullable<ReturnType<typeof parseCashuProofUnit>>
    keysetId: string
    nextCounter: number
    proofs: Proof[]
  },
): number {
  const proofIds = input.proofs.map((proof) =>
    deriveDaemonWalletProofIdFromProof(input.mintUrl, input.unit, proof))
  return applyDaemonStateWorkInDatabase(
    database,
    {
      walletProofs: [{
        mintUrl: input.mintUrl,
        unit: input.unit,
        proofIds,
      }],
      keysetCounterKeys: [input.keysetId],
    },
    (state, now) => {
      const existing = new Set(state.wallet.proofs.map((record) =>
        deriveDaemonWalletProofIdFromProof(
          record.mintUrl,
          record.unit,
          record.proof,
        )))
      let inserted = 0
      for (const proof of input.proofs) {
        const proofId = deriveDaemonWalletProofIdFromProof(
          input.mintUrl,
          input.unit,
          proof,
        )
        if (existing.has(proofId)) continue
        existing.add(proofId)
        state.wallet.proofs.push(recoveredStoredProof(input, proof, now))
        inserted += 1
      }
      state.wallet.keysetCounters[input.keysetId] = Math.max(
        state.wallet.keysetCounters[input.keysetId] ?? 0,
        input.nextCounter,
      )
      return inserted
    },
  )
}

function recoveredStoredProof(
  input: {
    mintUrl: string
    unit: NonNullable<ReturnType<typeof parseCashuProofUnit>>
  },
  proof: Proof,
  now: string,
): StoredProofRecord {
  return {
    mintUrl: input.mintUrl,
    unit: input.unit,
    proof: proof as CashuProofRecord,
    state: 'available',
    asset: {
      kind: 'sats',
      baseAsset: normalizeMarketBaseAsset(input.unit),
    },
    createdAt: now,
    updatedAt: now,
  }
}

async function recoveryResult(
  recoveryId: string,
  current: Pick<
    DaemonEmergencySeedRecoveryResult,
    'state' | 'batchesProcessed' | 'pendingProofs'
  >,
): Promise<DaemonEmergencySeedRecoveryResult> {
  const progress = await readDaemonStateDatabase((database) =>
    readDaemonSeedRecoveryProgress(database, recoveryId))
  return {
    ...progress,
    ...current,
    state: current.state === 'pending-mint-state'
      ? current.state
      : progress.state,
  }
}

function decodeWalletSeed(value: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('wallet seed must be a 32-byte hex value')
  }
  return Uint8Array.from(Buffer.from(value, 'hex'))
}
