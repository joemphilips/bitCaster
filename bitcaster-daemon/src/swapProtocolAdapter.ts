import {
  Amount,
  Mint as CashuMint,
  Wallet as CashuWallet,
  getEncodedToken,
  type SwapPreview,
} from '@cashu/cashu-ts'
import { createP2PKWitness } from '@bitcaster-market/swap-protocol/p2pk'
import { sha256 } from '@noble/hashes/sha2.js'
import { createDurableTradeProofOperationLink } from '@bitcaster-market/client-sdk/durableTradeRecovery'
import {
  normalizeMarketBaseAsset,
  parseCashuProofUnit,
} from '@bitcaster-market/client-sdk/marketUnits'
import {
  CashuMintCtfSplitTransport,
  restoreOutputGroups as restoreCtfOutputGroups,
  resumeCtfSplitOperation,
  splitRegularProofsWithOperation,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
} from '@bitcaster-market/client-sdk/ctfSplit'
import { durableBindingForDaemonProofOperation } from './durableTradeBinding.ts'
import {
  getProofOperation,
  markProofOperationMintSubmitted,
  markProofOperationCompleted,
  prepareProofOperation,
  readStateScope,
  isTradeWalletReservationKind,
  type CashuProofRecord,
  type PrepareProofOperationInput,
  type ProofOperationRecord,
} from './state.ts'
import type {
  DaemonSwapContext,
  DaemonSwapOps,
  SellerMintOpenResult,
} from './swapExecutor.ts'
import { requireDaemonOrderCollateralCoordinator } from './durableOrderCollateralCoordinator.ts'
import { deriveDaemonWalletProofIdFromProof } from './stateSqlite.ts'

export interface DaemonTradeProofOperationStore {
  getProofOperation(operationId: string): Promise<ProofOperationRecord | null>
  prepareProofOperation(
    input: PrepareProofOperationInput,
  ): Promise<ProofOperationRecord>
  markProofOperationMintSubmitted(
    operationId: string,
  ): Promise<ProofOperationRecord>
  markProofOperationCompleted(
    operationId: string,
    resultProofs: Record<string, CashuProofRecord[]>,
  ): Promise<ProofOperationRecord>
}

interface ProofOperationOptions {
  operationId?: string
  proofOperationStore?: DaemonTradeProofOperationStore
}

interface AtomicSwapModule {
  sellerPrepareSwap(
    ctx: AtomicSwapContext,
    proofs: CashuProofRecord[],
    options?: ProofOperationOptions,
  ): Promise<{
    adaptorPointCipher: string
    lockedProofsCipher: string
    adaptorPoint: { secret: Uint8Array; point: Uint8Array }
    lockedProofs: CashuProofRecord[]
    changeProofs: CashuProofRecord[]
  }>
  sellerPreparePrelockedSwap(
    ctx: AtomicSwapContext,
    lockedProofs: CashuProofRecord[],
    changeProofs?: CashuProofRecord[],
  ): Promise<{
    adaptorPointCipher: string
    lockedProofsCipher: string
    adaptorPoint: { secret: Uint8Array; point: Uint8Array }
    lockedProofs: CashuProofRecord[]
    changeProofs: CashuProofRecord[]
  }>
  sellerLockOutcomeProofs(
    ctx: AtomicSwapContext,
    outcomeProofs: CashuProofRecord[],
    amountSats: number,
    options?: ProofOperationOptions,
  ): Promise<{
    lockedProofs: CashuProofRecord[]
    changeProofs: CashuProofRecord[]
  }>
  buyerPrepareSwap(
    ctx: AtomicSwapContext,
    adaptorPointCipher: string,
    lockedProofsSellerCipher: string,
    proofs: CashuProofRecord[],
    amountSats: number,
    options?: ProofOperationOptions,
  ): Promise<{
    lockedProofsCipher: string
    lockedProofs: CashuProofRecord[]
    changeProofs: CashuProofRecord[]
    preSigsHex: string[]
    sellerPreSigsHex: string[]
  }>
  sellerClaimSwap(
    ctx: AtomicSwapContext,
    adaptorPoint: { secret: Uint8Array; point: Uint8Array },
    lockedProofsBuyerCipher: string,
    options?: ProofOperationOptions,
  ): Promise<CashuProofRecord[]>
  buyerExtractSecret(
    mintUrl: string,
    spentProofs: CashuProofRecord[],
    preSigsHex: string[],
  ): Promise<Uint8Array | null>
  buyerClaimSwap(
    ctx: AtomicSwapContext,
    adaptorSecret: Uint8Array,
    lockedProofsSellerCipher: string,
    sellerPreSigsHex: string[],
    options?: ProofOperationOptions,
  ): Promise<CashuProofRecord[]>
  /** Completes only the original persisted mint request; never selects proofs. */
  resumeExactPreparedProofOperation(
    wallet: CashuWallet,
    entry: ProofOperationRecord,
  ): Promise<Record<string, CashuProofRecord[]>>
  inspectExactPreparedProofOperation?(
    wallet: CashuWallet,
    entry: ProofOperationRecord,
  ): Promise<'all-unspent' | 'all-spent' | 'pending-or-mixed'>
  /** Reconstructs only the original persisted blinded outputs. */
  restoreExactPreparedProofOperation(
    entry: ProofOperationRecord,
  ): Promise<Record<string, CashuProofRecord[]>>
}

interface CtfSplitModule {
  splitRootCompleteSetForSwap(params: {
    mintUrl: string
    baseAsset?: string | null
    conditionId: string
    collateralProofs: CashuProofRecord[]
    amountSats: number
    lockOutcomeSetId: string
    keepOutcomeSetId: string
    p2pk: {
      pubkey: string[]
      requiredSignatures: number
      locktime: number
      refundKeys: string[]
      sigFlag: string
    }
    operationId: string
    proofOperationStore: DaemonTradeProofOperationStore
  }): Promise<{
    resolvedLockOutcomeSetId: string
    resolvedKeepOutcomeSetId: string
    lockCollections: string[]
    keepCollections: string[]
    lockedProofs: CashuProofRecord[]
    keepProofs: CashuProofRecord[]
    proofsByCollection: Record<string, CashuProofRecord[]>
    spentSatProofs: CashuProofRecord[]
  }>
}

interface AtomicSwapContext {
  tradeId: string
  role: 'seller' | 'buyer'
  ephemeralKey: { privateKey: Uint8Array; publicKey: string }
  counterpartyPubkey: string
  sellerLocktime: number
  buyerLocktime: number
  mintUrl: string
}

export interface RealDaemonSwapOpsOptions {
  nut07PollDeadlineMs?: number
  nut07PollIntervalMs?: number
  loadAtomicSwapModule?: () => Promise<AtomicSwapModule>
  loadCtfSplitModule?: () => Promise<CtfSplitModule>
  createRefundWallet?: (mintUrl: string) => RefundWallet
}

type RefundWallet = Pick<
  CashuWallet,
  'loadMint' | 'prepareSwapToReceive' | 'completeSwap' | 'checkProofsStates'
>

export type ExactDaemonProofOperationAction = 'resume' | 'restore'

/**
 * The durable coordinator reaches this adapter only after it has bound the
 * session link to this exact record. It deliberately has no swap context or
 * proof-selection inputs: recovery may complete/restore the retained request,
 * never choose a replacement proof pool or open another trade operation.
 */
export async function recoverExactDaemonProofOperation(
  record: ProofOperationRecord,
  action: ExactDaemonProofOperationAction,
  options: Pick<RealDaemonSwapOpsOptions, 'loadAtomicSwapModule'> = {},
): Promise<void> {
  const retained = await getProofOperation(record.operationId)
  if (!retained || retained.operationId !== record.operationId) {
    throw new Error(`Missing retained daemon proof operation ${record.operationId}`)
  }
  switch (retained.kind) {
    case 'swap-lock':
    case 'swap-claim':
    case 'conditional-keyset-swap':
    case 'proof-split': {
      const atomicSwap = await (options.loadAtomicSwapModule ?? defaultAtomicSwapModuleLoader)()
      const unit = exactOperationUnit(retained)
      const wallet = new CashuWallet(new CashuMint(retained.mintUrl), {
        unit,
        ...(retained.kind === 'conditional-keyset-swap' ? { enableCtf: true } : {}),
      })
      await wallet.loadMint()
      const result = action === 'resume'
        ? await atomicSwap.resumeExactPreparedProofOperation(wallet, retained)
        : await atomicSwap.restoreExactPreparedProofOperation(retained)
      await markProofOperationCompleted(retained.operationId, result)
      return
    }
    case 'ctf-split': {
      if (action === 'restore') {
        const restored = await restoreCtfOutputGroups(retained.mintUrl, retained.outputs)
        await markProofOperationCompleted(retained.operationId, restored)
        return
      }
      await resumeCtfSplitOperation({
        mintUrl: retained.mintUrl,
        entry: retained as never,
        transport: new CashuMintCtfSplitTransport(retained.mintUrl),
        proofOperationStore: DAEMON_PROOF_OPERATION_STORE as never,
      })
      return
    }
    case 'regular-split': {
      const unit = exactOperationUnit(retained)
      const amount = exactOperationAmount(retained)
      const wallet = new CashuWallet(new CashuMint(retained.mintUrl), { unit })
      await wallet.loadMint()
      await splitRegularProofsWithOperation({
        mintUrl: retained.mintUrl,
        baseAsset: normalizeMarketBaseAsset(
          typeof retained.metadata.baseAsset === 'string'
            ? retained.metadata.baseAsset
            : null,
        ),
        operationId: retained.operationId,
        wallet,
        proofs: [],
        amountSubunits: amount,
        proofOperationStore: DAEMON_PROOF_OPERATION_STORE as never,
      })
      return
    }
    case 'swap-refund': {
      const atomicSwap = await (
        options.loadAtomicSwapModule ?? defaultAtomicSwapModuleLoader
      )()
      const result = action === 'resume'
        ? await resumeExactRefund(atomicSwap, retained)
        : await atomicSwap.restoreExactPreparedProofOperation(retained)
      const refund = result.refund ?? result.keep ?? []
      await markProofOperationCompleted(retained.operationId, { refund })
      return
    }
    case 'ctf-merge':
    case 'ctf-consolidation':
    case 'ctf-redeem':
    case 'wallet-send':
      throw new Error(`Unsupported exact durable recovery operation ${retained.kind}`)
  }
}

async function resumeExactRefund(
  atomicSwap: AtomicSwapModule,
  retained: ProofOperationRecord,
): Promise<Record<string, CashuProofRecord[]>> {
  const wallet = new CashuWallet(new CashuMint(retained.mintUrl), {
    unit: exactOperationUnit(retained),
  })
  await wallet.loadMint()
  return atomicSwap.resumeExactPreparedProofOperation(wallet, retained)
}

const DEFAULT_NUT07_POLL_DEADLINE_MS = 60_000
const DEFAULT_NUT07_POLL_INTERVAL_MS = 1_000

export function createRealDaemonSwapOps(
  options: RealDaemonSwapOpsOptions = {},
): DaemonSwapOps {
  const loadAtomicSwapModule =
    options.loadAtomicSwapModule ?? defaultAtomicSwapModuleLoader
  const loadCtfSplitModule =
    options.loadCtfSplitModule ?? defaultCtfSplitModuleLoader
  const nut07PollDeadlineMs =
    options.nut07PollDeadlineMs ?? DEFAULT_NUT07_POLL_DEADLINE_MS
  const nut07PollIntervalMs =
    options.nut07PollIntervalMs ?? DEFAULT_NUT07_POLL_INTERVAL_MS
  const createRefundWallet = options.createRefundWallet ?? ((mintUrl: string) =>
    new CashuWallet(new CashuMint(mintUrl), { unit: 'sat' }))

  return {
    async sellerOpen(ctx, proofs) {
      const atomicSwap = await loadAtomicSwapModule()
      const out = await atomicSwap.sellerPrepareSwap(
        toAtomicCtx(ctx),
        proofs,
        proofOperationOptions(ctx, 'seller-lock'),
      )
      return {
        adaptorPointCipher: out.adaptorPointCipher,
        lockedProofsCipher: out.lockedProofsCipher,
        adaptorSecretHex: bytesToHex(out.adaptorPoint.secret),
        adaptorPointHex: bytesToHex(out.adaptorPoint.point),
        lockedProofs: out.lockedProofs,
        changeProofs: out.changeProofs,
      }
    },

    async sellerOpenPrelocked(ctx, lockedProofs) {
      const atomicSwap = await loadAtomicSwapModule()
      const out = await atomicSwap.sellerPreparePrelockedSwap(
        toAtomicCtx(ctx),
        lockedProofs,
      )
      return {
        adaptorPointCipher: out.adaptorPointCipher,
        lockedProofsCipher: out.lockedProofsCipher,
        adaptorSecretHex: bytesToHex(out.adaptorPoint.secret),
        adaptorPointHex: bytesToHex(out.adaptorPoint.point),
        lockedProofs: out.lockedProofs,
        changeProofs: out.changeProofs,
      }
    },

    async sellerLockOutcomeProofs(ctx, outcomeProofs, amountSats, operationId) {
      const atomicSwap = await loadAtomicSwapModule()
      return atomicSwap.sellerLockOutcomeProofs(
        toAtomicCtx(ctx),
        outcomeProofs,
        amountSats,
        {
          operationId,
          proofOperationStore: createDaemonTradeProofOperationStore(ctx),
        },
      )
    },

    async sellerOpenMint(ctx, params, collateralProofs) {
      const [atomicSwap, ctfSplit] = await Promise.all([
        loadAtomicSwapModule(),
        loadCtfSplitModule(),
      ])
      const split = await ctfSplit.splitRootCompleteSetForSwap({
        mintUrl: ctx.mintUrl,
        baseAsset: ctx.baseAsset,
        conditionId: params.conditionId,
        collateralProofs,
        amountSats: params.amountSats,
        lockOutcomeSetId: params.lockOutcomeSetId,
        keepOutcomeSetId: params.keepOutcomeSetId,
        p2pk: {
          pubkey: [ctx.ephemeralKey.publicKey, ctx.counterpartyPubkey],
          requiredSignatures: 2,
          locktime: ctx.sellerLocktime,
          refundKeys: [ctx.ephemeralKey.publicKey],
          sigFlag: 'SIG_INPUTS',
        },
        operationId: `${ctx.tradeId}/seller-mint-ctf-split`,
        proofOperationStore: createDaemonTradeProofOperationStore(ctx),
      })
      const prepared = await atomicSwap.sellerPreparePrelockedSwap(
        toAtomicCtx(ctx),
        split.lockedProofs,
      )
      return {
        adaptorPointCipher: prepared.adaptorPointCipher,
        lockedProofsCipher: prepared.lockedProofsCipher,
        adaptorSecretHex: bytesToHex(prepared.adaptorPoint.secret),
        adaptorPointHex: bytesToHex(prepared.adaptorPoint.point),
        lockedProofs: prepared.lockedProofs,
        changeProofs: prepared.changeProofs,
        spentSatProofs: split.spentSatProofs,
        keepProofs: split.keepProofs,
        proofsByCollection: split.proofsByCollection,
        lockCollections: split.lockCollections,
        keepCollections: split.keepCollections,
        resolvedKeepOutcomeSetId: split.resolvedKeepOutcomeSetId,
        resolvedLockOutcomeSetId: split.resolvedLockOutcomeSetId,
      } satisfies SellerMintOpenResult
    },

    async buyerRespond(ctx, messages, proofs, amountSats) {
      const atomicSwap = await loadAtomicSwapModule()
      const out = await atomicSwap.buyerPrepareSwap(
        toAtomicCtx(ctx),
        messages.adaptorPoint,
        messages.lockedProofsSeller,
        proofs,
        amountSats,
        proofOperationOptions(ctx, 'buyer-lock'),
      )
      return {
        lockedProofsCipher: out.lockedProofsCipher,
        lockedProofs: out.lockedProofs,
        changeProofs: out.changeProofs,
        preSigsHex: out.preSigsHex,
        sellerPreSigsHex: out.sellerPreSigsHex,
      }
    },

    async sellerClaim(ctx, adaptorSecretHex, adaptorPointHex, lockedProofsBuyerCipher) {
      const atomicSwap = await loadAtomicSwapModule()
      return atomicSwap.sellerClaimSwap(
        toAtomicCtx(ctx),
        {
          secret: hexToBytes(adaptorSecretHex),
          point: hexToBytes(adaptorPointHex),
        },
        lockedProofsBuyerCipher,
        proofOperationOptions(ctx, 'seller-claim'),
      )
    },

    async buyerClaim(ctx, state) {
      const atomicSwap = await loadAtomicSwapModule()
      const deadline = Date.now() + nut07PollDeadlineMs
      while (Date.now() < deadline) {
        const adaptorSecret = await atomicSwap.buyerExtractSecret(
          ctx.mintUrl,
          state.lockedProofs,
          state.preSigsHex,
        )
        if (adaptorSecret) {
          return atomicSwap.buyerClaimSwap(
            toAtomicCtx(ctx),
            adaptorSecret,
            state.lockedProofsSellerCipher,
            state.sellerPreSigsHex,
            proofOperationOptions(ctx, 'buyer-claim'),
          )
        }
        await sleep(nut07PollIntervalMs)
      }
      throw new Error('Timed out waiting for seller to spend at mint')
    },

    async refundLockedProofs(ctx, lockedProofs, operationId) {
      if (lockedProofs.length === 0) return []
      const store = createDaemonTradeProofOperationStore(ctx)
      const atomicSwap = await loadAtomicSwapModule()
      const wallet = createRefundWallet(ctx.mintUrl)
      await wallet.loadMint()
      const existing = await store.getProofOperation(operationId)
      if (existing) {
        return recoverExactRefund(
          atomicSwap,
          wallet,
          existing,
          store,
        )
      }
      const witnessed = lockedProofs.map((proof) => ({
        ...proof,
        witness: createP2PKWitness(
          hexToBytes(ctx.ephemeralKey.privateKeyHex),
          sha256(new TextEncoder().encode(proof.secret)),
        ),
      }))
      const token = getEncodedToken({
        mint: ctx.mintUrl,
        unit: 'sat',
        proofs: witnessed as never,
      })
      const preview = await wallet.prepareSwapToReceive(
        token,
        { proofsWeHave: [] },
        { type: 'random' },
      )
      await store.prepareProofOperation({
        operationId,
        kind: 'swap-refund',
        mintUrl: ctx.mintUrl,
        inputs: preview.inputs as CashuProofRecord[],
        outputs: { refund: serializeRefundOutputs(preview) },
        metadata: {
          tradeId: ctx.tradeId,
          role: ctx.role,
          refundLocktime:
            ctx.role === 'seller' ? ctx.sellerLocktime : ctx.buyerLocktime,
          amount: Amount.from(preview.amount).toNumber(),
          fees: Amount.from(preview.fees).toNumber(),
          keysetId: preview.keysetId,
          unit: 'sat',
          unselectedProofs: preview.unselectedProofs ?? [],
        },
      })
      await store.markProofOperationMintSubmitted(operationId)
      const result = await wallet.completeSwap(preview)
      const fresh = result.keep as CashuProofRecord[]
      await store.markProofOperationCompleted(operationId, { refund: fresh })
      return fresh
    },
  }
}

async function recoverExactRefund(
  atomicSwap: AtomicSwapModule,
  wallet: RefundWallet,
  existing: ProofOperationRecord,
  store: DaemonTradeProofOperationStore,
): Promise<CashuProofRecord[]> {
  if (existing.kind !== 'swap-refund') {
    throw new Error('retained refund operation has a foreign kind')
  }
  if (existing.state === 'completed') {
    return existing.resultProofs?.refund ?? existing.resultProofs?.keep ?? []
  }
  const inspect = atomicSwap.inspectExactPreparedProofOperation
  if (!inspect) throw new Error('exact refund state classifier is unavailable')
  const state = await inspect(wallet as CashuWallet, existing)
  if (state === 'pending-or-mixed') {
    throw new Error(`Proof operation ${existing.operationId} is still pending at the mint`)
  }
  const result = state === 'all-unspent'
    ? await atomicSwap.resumeExactPreparedProofOperation(
        wallet as CashuWallet,
        existing,
      )
    : await atomicSwap.restoreExactPreparedProofOperation(existing)
  const refund = result.refund ?? result.keep ?? []
  await store.markProofOperationCompleted(existing.operationId, { refund })
  return refund
}

function serializeRefundOutputs(
  preview: SwapPreview,
): PrepareProofOperationInput['outputs']['refund'] {
  return (preview.keepOutputs ?? []).map((output) => ({
    blindedMessage: {
      amount: Amount.from(output.blindedMessage.amount).toNumber(),
      id: output.blindedMessage.id,
      B_: output.blindedMessage.B_,
    },
    blindingFactor: output.blindingFactor.toString(16),
    secret: bytesToHex(output.secret),
  }))
}

function proofOperationOptions(
  ctx: Pick<DaemonSwapContext, 'tradeId' | 'role' | 'orderCollateralPinId'>,
  step: 'seller-lock' | 'buyer-lock' | 'seller-claim' | 'buyer-claim',
): Required<ProofOperationOptions> {
  return {
    operationId: `${ctx.tradeId}/${step}`,
    proofOperationStore: createDaemonTradeProofOperationStore(ctx),
  }
}

const DAEMON_PROOF_OPERATION_STORE: DaemonTradeProofOperationStore = {
  getProofOperation,
  prepareProofOperation,
  markProofOperationMintSubmitted,
  markProofOperationCompleted,
}

export function createDaemonTradeProofOperationStore(
  ctx: Pick<DaemonSwapContext, 'tradeId' | 'role' | 'orderCollateralPinId'>,
): DaemonTradeProofOperationStore {
  return {
    getProofOperation,
    prepareProofOperation: async (input) => prepareProofOperation({
        ...input,
        ...(await walletReservationForOperation(ctx, input)),
        durableTradeRecovery: createDurableTradeProofOperationLink({
          tradeId: ctx.tradeId,
          role: ctx.role,
          ...durableBindingForDaemonProofOperation(input.kind),
          state: 'prepared',
          operationKey: input.operationId,
        }),
      }),
    markProofOperationMintSubmitted,
    markProofOperationCompleted,
  }
}

export function createDaemonTradeCtfProofOperationStore(
  ctx: Pick<DaemonSwapContext, 'tradeId' | 'role' | 'orderCollateralPinId'>,
): CtfProofOperationStore {
  const store = createDaemonTradeProofOperationStore(ctx)
  return {
    async getProofOperation(operationId) {
      return await store.getProofOperation(operationId) as CtfProofOperationRecord | null
    },
    async prepareProofOperation(input) {
      return await store.prepareProofOperation(input) as CtfProofOperationRecord
    },
    async markProofOperationMintSubmitted(operationId, redeemBinding) {
      return await markProofOperationMintSubmitted(
        operationId,
        redeemBinding,
      ) as CtfProofOperationRecord
    },
    async markProofOperationCompleted(operationId, resultProofs) {
      return await store.markProofOperationCompleted(
        operationId,
        resultProofs,
      ) as CtfProofOperationRecord
    },
  }
}

async function walletReservationForOperation(
  ctx: Pick<DaemonSwapContext, 'orderCollateralPinId'>,
  input: PrepareProofOperationInput,
): Promise<Pick<PrepareProofOperationInput, 'metadata' | 'walletProofReservation'>> {
  if (!isTradeWalletReservationKind(input.kind)) return {}
  const unit = requireOperationUnit(input)
  const pinId = ctx.orderCollateralPinId
  if (pinId !== undefined) {
    const ownership = await requireDaemonOrderCollateralCoordinator()
      .classifyProofs(pinId, {
        mintUrl: input.mintUrl,
        unit,
        proofs: input.inputs,
      })
    if (ownership === 'all') {
      return operationReservation(input, unit, pinId)
    }
  }
  const ownership = await classifyWalletProofInputs(input, unit)
  return ownership === 'all' ? operationReservation(input, unit) : {}
}

function requireOperationUnit(input: PrepareProofOperationInput) {
  const rawUnit = input.metadata?.unit
  const unit = parseCashuProofUnit(typeof rawUnit === 'string' ? rawUnit : null)
  if (unit === null) throw new Error('trade proof operation has no mint unit')
  return unit
}

function operationReservation(
  input: PrepareProofOperationInput,
  unit: NonNullable<ReturnType<typeof parseCashuProofUnit>>,
  parentOrderCollateralPinId?: string,
): Pick<PrepareProofOperationInput, 'metadata' | 'walletProofReservation'> {
  if (input.metadata?.reservationId !== undefined
    && input.metadata.reservationId !== input.operationId) {
    throw new Error('trade proof operation has a foreign reservation')
  }
  return {
    metadata: {
      ...input.metadata,
      reservationId: input.operationId,
      unit,
    },
    walletProofReservation: {
      reservationId: input.operationId,
      unit,
      ...(parentOrderCollateralPinId === undefined
        ? {}
        : { parentOrderCollateralPinId }),
    },
  }
}

async function classifyWalletProofInputs(
  input: PrepareProofOperationInput,
  unit: NonNullable<ReturnType<typeof parseCashuProofUnit>>,
): Promise<'all' | 'none'> {
  const proofIds = input.inputs.map((proof) =>
    deriveDaemonWalletProofIdFromProof(input.mintUrl, unit, proof),
  )
  const state = await readStateScope({ walletProofs: [{ proofIds }] })
  const storedIds = new Set((state?.wallet.proofs ?? []).map((proof) =>
    deriveDaemonWalletProofIdFromProof(proof.mintUrl, proof.unit, proof.proof),
  ))
  const matches = proofIds.map((proofId) => storedIds.has(proofId))
  if (matches.every(Boolean)) return 'all'
  if (matches.every((match) => !match)) return 'none'
  throw new Error('trade proof operation mixes wallet and transient inputs')
}

function exactOperationUnit(record: ProofOperationRecord): string {
  const unit = record.metadata.unit
  if (typeof unit !== 'string' || unit.length === 0) {
    throw new Error(`Retained proof operation ${record.operationId} has no mint unit`)
  }
  return unit
}

function exactOperationAmount(record: ProofOperationRecord): number {
  const amount = record.metadata.amount
  if (!Number.isSafeInteger(amount) || (amount as number) <= 0) {
    throw new Error(`Retained proof operation ${record.operationId} has no amount`)
  }
  return amount as number
}

async function defaultAtomicSwapModuleLoader(): Promise<AtomicSwapModule> {
  const specifier = '@bitcaster-market/swap-protocol/atomicSwap'
  return (await import(specifier)) as AtomicSwapModule
}

async function defaultCtfSplitModuleLoader(): Promise<CtfSplitModule> {
  const specifier = '@bitcaster-market/client-sdk/ctfSplit'
  return (await import(specifier)) as CtfSplitModule
}

function toAtomicCtx(ctx: DaemonSwapContext): AtomicSwapContext {
  return {
    tradeId: ctx.tradeId,
    role: ctx.role,
    ephemeralKey: {
      privateKey: hexToBytes(ctx.ephemeralKey.privateKeyHex),
      publicKey: ctx.ephemeralKey.publicKey,
    },
    counterpartyPubkey: ctx.counterpartyPubkey,
    sellerLocktime: ctx.sellerLocktime,
    buyerLocktime: ctx.buyerLocktime,
    mintUrl: ctx.mintUrl,
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('invalid hex string')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
