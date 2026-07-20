import { randomUUID } from 'node:crypto'
import {
  Amount,
  CheckStateEnum,
  Mint as CashuMint,
  Wallet as CashuWallet,
  decodeKeysetCurve,
  hashToCurve,
  hashToCurveBls,
  type Proof,
  type ProofState,
} from '@cashu/cashu-ts'
import {
  EMERGENCY_SEED_RECOVERY_BATCH_SIZE,
  advanceEmergencySeedRecoveryCursor,
  classifyEmergencySeedRecoveryProof,
} from '@bitcaster-market/client-sdk/emergencySeedRecovery'
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '@bitcaster-market/client-sdk/durableCustody'
import {
  normalizeDurableWalletMintUrl,
} from '@bitcaster-market/client-sdk/durableWalletMintUrl'
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
  reconcileDaemonSeedRecoveryRetainedProofs,
  retainPendingDaemonSeedRecoveryProofs,
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
  const walletScopeId = deriveDurableCustodyScopeId({
    scopeKind: 'wallet',
    walletId: deriveDurableCustodyWalletId(walletSeed),
  })
  const mintUrl = normalizeDurableWalletMintUrl(input.mintUrl)
  const wallet = (deps.createWallet ?? createEmergencySeedRecoveryWallet)(
    mintUrl,
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
      walletScopeId,
      mintUrl,
      unit,
      keysetIds,
      disclosureAcknowledged: true,
      nowMs: nowMs(),
    }))
  return {
    wallet,
    recoveryId: job.recoveryId,
    initialJobState: job.state,
    mintUrl,
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
  if (classified.pending.length > 0) {
    await transactDaemonState((database) => {
      retainPendingRecoveredProofs(database, {
        recoveryId: context.recoveryId,
        mintUrl: context.mintUrl,
        unit: context.unit,
        proofs: classified.pending,
        nowMs: context.nowMs(),
      })
    })
    return classified.pending.length
  }
  const next = advanceEmergencySeedRecoveryCursor(cursor, {
    startCounter: cursor.nextCounter,
    requestedCount: EMERGENCY_SEED_RECOVERY_BATCH_SIZE,
    lastCounterWithSignature: restored.lastCounterWithSignature ?? null,
  })
  await transactDaemonState((database) => {
    const importedProofs = reconcileRecoveredProofs(database, {
      recoveryId: context.recoveryId,
      mintUrl: context.mintUrl,
      unit: context.unit,
      keysetId: cursor.keysetId,
      nextCounter: next.nextCounter,
      unspentProofs: classified.unspent,
      spentProofs: classified.spent,
      nowMs: context.nowMs(),
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

function retainPendingRecoveredProofs(
  database: Parameters<typeof applyDaemonStateWorkInDatabase>[0],
  input: {
    recoveryId: string
    mintUrl: string
    unit: NonNullable<ReturnType<typeof parseCashuProofUnit>>
    proofs: Proof[]
    nowMs: number
  },
): void {
  const proofIds = input.proofs.map((proof) =>
    deriveDaemonWalletProofIdFromProof(input.mintUrl, input.unit, proof))
  applyDaemonStateWorkInDatabase(
    database,
    {
      walletProofs: [{ mintUrl: input.mintUrl, unit: input.unit, proofIds }],
    },
    (state, now) => {
      const existing = new Map(
        state.wallet.proofs.map((record) => [
          deriveDaemonWalletProofIdFromProof(
            record.mintUrl,
            record.unit,
            record.proof,
          ),
          record,
        ]),
      )
      for (const proof of input.proofs) {
        const proofId = deriveDaemonWalletProofIdFromProof(
          input.mintUrl,
          input.unit,
          proof,
        )
        const retained = existing.get(proofId)
        if (retained !== undefined) {
          if (
            retained.state !== 'locked' ||
            retained.reservedBy !== `seed-recovery:${input.recoveryId}`
          ) {
            throw new Error('seed recovery proof is owned by another operation')
          }
          continue
        }
        state.wallet.proofs.push(
          recoveredStoredProof(input, proof, now, {
            state: 'locked',
            reservedBy: `seed-recovery:${input.recoveryId}`,
          }),
        )
      }
    },
  )
  const encoder = new TextEncoder()
  retainPendingDaemonSeedRecoveryProofs(
    database,
    input.recoveryId,
    input.proofs.map((proof, index) => {
      const walletProofId = proofIds[index]
      if (walletProofId === undefined) {
        throw new Error('seed recovery retained proof identity is missing')
      }
      const secret = encoder.encode(proof.secret)
      return {
        keysetId: proof.id,
        walletProofId,
        proofDigest: walletProofId,
        proofY: hashRecoveredProofToCurve(proof.id, secret),
      }
    }),
    input.nowMs,
  )
}

function hashRecoveredProofToCurve(
  keysetId: string,
  secret: Uint8Array,
): string {
  switch (decodeKeysetCurve(keysetId)) {
    case 'secp256k1':
      return hashToCurve(secret).toHex(true)
    case 'bls12-381':
      return hashToCurveBls(secret).toHex(true)
  }
}

function reconcileRecoveredProofs(
  database: Parameters<typeof applyDaemonStateWorkInDatabase>[0],
  input: {
    recoveryId: string
    mintUrl: string
    unit: NonNullable<ReturnType<typeof parseCashuProofUnit>>
    keysetId: string
    nextCounter: number
    unspentProofs: Proof[]
    spentProofs: Proof[]
    nowMs: number
  },
): number {
  const unspentProofIds = input.unspentProofs.map((proof) =>
    deriveDaemonWalletProofIdFromProof(input.mintUrl, input.unit, proof))
  const spentProofIds = input.spentProofs.map((proof) =>
    deriveDaemonWalletProofIdFromProof(input.mintUrl, input.unit, proof))
  reconcileDaemonSeedRecoveryRetainedProofs(database, input.recoveryId, {
    unspentProofIds,
    spentProofIds,
    observedAt: input.nowMs,
  })
  return applyDaemonStateWorkInDatabase(
    database,
    {
      walletProofs: [{
        mintUrl: input.mintUrl,
        unit: input.unit,
        proofIds: [...unspentProofIds, ...spentProofIds],
      }],
      keysetCounterKeys: [input.keysetId],
    },
    (state, now) => {
      const existing = new Map(state.wallet.proofs.map((record) => [
        deriveDaemonWalletProofIdFromProof(
          record.mintUrl,
          record.unit,
          record.proof,
        ),
        record,
      ]))
      const spent = new Set(spentProofIds)
      state.wallet.proofs = state.wallet.proofs.filter((record) => {
        const proofId = deriveDaemonWalletProofIdFromProof(
          record.mintUrl,
          record.unit,
          record.proof,
        )
        if (!spent.has(proofId)) return true
        return !(
          record.state === 'locked' &&
          record.reservedBy === `seed-recovery:${input.recoveryId}`
        )
      })
      let inserted = 0
      for (const proof of input.unspentProofs) {
        const proofId = deriveDaemonWalletProofIdFromProof(
          input.mintUrl,
          input.unit,
          proof,
        )
        const retained = existing.get(proofId)
        if (retained !== undefined) {
          if (
            retained.state === 'locked' &&
            retained.reservedBy === `seed-recovery:${input.recoveryId}`
          ) {
            retained.state = 'available'
            delete retained.reservedBy
            retained.updatedAt = now
            inserted += 1
          }
          continue
        }
        state.wallet.proofs.push(
          recoveredStoredProof(input, proof, now, { state: 'available' }),
        )
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
  authority: Pick<StoredProofRecord, 'state' | 'reservedBy'>,
): StoredProofRecord {
  return {
    mintUrl: input.mintUrl,
    unit: input.unit,
    proof: {
      ...proof,
      amount: Amount.from(proof.amount).toBigInt(),
    } as CashuProofRecord,
    ...authority,
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
