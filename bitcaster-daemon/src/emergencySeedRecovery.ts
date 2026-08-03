import { randomUUID } from 'node:crypto'
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
  createEmergencySeedRecoveryCursor,
  type EmergencySeedRecoveryBatchObservation,
  type EmergencySeedRecoveryCursor,
  type EmergencySeedRecoveryLeaseAuthority,
} from '@bitcaster-market/client-sdk/emergencySeedRecovery'
import { SeedRecoverySqliteStore, type SeedRecoveryObservedProof } from './seedRecoverySqlite.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import type { WalletSeedRecoveryParams, WalletSeedRecoveryResult } from './protocol.ts'
import { createCustodyProofSqliteRow } from './custodyProofSqliteRow.ts'
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '@bitcaster-market/client-sdk/durableCustody'

export interface ExplicitSeedRecoveryBatch {
  readonly observation: EmergencySeedRecoveryBatchObservation
  readonly proofs: readonly SeedRecoveryObservedProof[]
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
  let cursor = createEmergencySeedRecoveryCursor({
    recoveryId: input.recoveryId,
    walletScopeId: input.walletScopeId,
    mintUrl: input.mintUrl,
    unit: input.unit,
    keysetId: input.keysetId,
  })
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
      if (batchIndex !== input.batches.length - 1) {
        throw new Error('seed recovery contains batches after completion')
      }
      break
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
  input: WalletSeedRecoveryParams,
  deps: {
    directory: string
    getFence: () => CustodyScopeFence
    createWallet?: (mintUrl: string, unit: string, seed: Uint8Array) => RecoveryWallet
    nowMs?: () => number
    invocationId?: () => string
  },
): Promise<WalletSeedRecoveryResult> {
  if (!/^[0-9a-f]{128}$/.test(input.walletSeedHex)) {
    throw new Error('wallet seed must be a 64-byte lowercase hex value')
  }
  const seed = Uint8Array.from(Buffer.from(input.walletSeedHex, 'hex'))
  const derivedScopeId = deriveDurableCustodyScopeId({
    scopeKind: 'wallet',
    walletId: deriveDurableCustodyWalletId(seed),
  })
  const initialFence = deps.getFence()
  if (derivedScopeId !== initialFence.scopeId) {
    seed.fill(0)
    throw new Error('seed recovery wallet seed does not match the active profile')
  }
  const wallet = (deps.createWallet ?? createRecoveryWallet)(input.mintUrl, input.unit, seed)
  seed.fill(0)
  await wallet.loadMint()
  if (!wallet.keyChain.getKeysets().some(({ id }) => id === input.keysetId)) {
    throw new Error('seed recovery keyset is not available from the mint')
  }

  const fence = deps.getFence()
  let cursor = createEmergencySeedRecoveryCursor({
    recoveryId: input.recoveryId,
    walletScopeId: fence.scopeId,
    mintUrl: input.mintUrl,
    unit: input.unit,
    keysetId: input.keysetId,
  })
  const batches: ExplicitSeedRecoveryBatch[] = []
  while (batches.length < 4 && cursor.state === 'active') {
    const restored = await wallet.restore(cursor.nextCounter, EMERGENCY_SEED_RECOVERY_BATCH_SIZE, {
      keysetId: input.keysetId,
    })
    if (restored.proofs.length > 0 && restored.lastCounterWithSignature === undefined) {
      throw new Error('seed recovery mint omitted its signature cursor')
    }
    verifyProofsForReceive(restored.proofs, (keysetId) => wallet.getKeyset(keysetId))
    const states =
      restored.proofs.length === 0 ? [] : await wallet.checkProofsStates(restored.proofs)
    if (states.length !== restored.proofs.length) {
      throw new Error('seed recovery mint returned mismatched proof states')
    }
    const now = (deps.nowMs ?? Date.now)()
    const proofs = restored.proofs.map((proof, index) =>
      observedProof(fence.scopeId, input.mintUrl, input.unit, proof, states[index]?.state, now),
    )
    const observation = {
      expectedRevision: cursor.revision,
      startCounter: cursor.nextCounter,
      requestedCount: EMERGENCY_SEED_RECOVERY_BATCH_SIZE,
      lastCounterWithSignature: restored.lastCounterWithSignature ?? null,
    }
    batches.push({ observation, proofs })
    cursor = advanceEmergencySeedRecoveryCursor(cursor, observation)
    if (proofs.some(({ mintState }) => mintState === 'PENDING')) break
  }

  const observedAtMs = (deps.nowMs ?? Date.now)()
  const liveFence = deps.getFence()
  const committed = await runExplicitEmergencySeedRecovery({
    ...input,
    walletScopeId: liveFence.scopeId,
    authority: {
      walletScopeId: liveFence.scopeId,
      incarnationId: liveFence.incarnationId,
      fencingEpoch: liveFence.fencingEpoch,
      observedAtMs,
      leaseExpiresAtMs: liveFence.leaseExpiresAtMs,
      effectiveClockHighWaterMarkMs: observedAtMs,
    },
    store: new SeedRecoverySqliteStore({
      directory: deps.directory,
      fence: liveFence,
      invocationId: (deps.invocationId ?? randomUUID)(),
      observedAtMs,
    }),
    batches,
  })
  return {
    recoveryId: committed.recoveryId,
    state: committed.state,
    nextCounter: committed.nextCounter,
    batchesProcessed: batches.length,
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
  unit: WalletSeedRecoveryParams['unit'],
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
