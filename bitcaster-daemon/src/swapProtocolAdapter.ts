import {
  Mint as CashuMint,
  Wallet as CashuWallet,
  getEncodedToken,
} from '@cashu/cashu-ts'
import { createP2PKWitness } from '@bitcaster-market/swap-protocol/p2pk'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  getProofOperation,
  markProofOperationCompleted,
  prepareProofOperation,
  type CashuProofRecord,
  type PrepareProofOperationInput,
  type ProofOperationRecord,
} from './state.ts'
import type {
  DaemonSwapContext,
  DaemonSwapOps,
  SellerMintOpenResult,
} from './swapExecutor.ts'

interface ProofOperationStore {
  getProofOperation(operationId: string): Promise<ProofOperationRecord | null>
  prepareProofOperation(
    input: PrepareProofOperationInput,
  ): Promise<ProofOperationRecord>
  markProofOperationCompleted(
    operationId: string,
    resultProofs: Record<string, CashuProofRecord[]>,
  ): Promise<ProofOperationRecord>
}

interface ProofOperationOptions {
  operationId?: string
  proofOperationStore?: ProofOperationStore
}

interface AtomicSwapModule {
  splitProofsForExactSend(params: {
    mintUrl: string
    sourceProofs: CashuProofRecord[]
    amountSats: number
    preserveSourceKeyset?: boolean
    operationId?: string
    proofOperationStore?: ProofOperationStore
  }): Promise<{
    sendProofs: CashuProofRecord[]
    changeProofs: CashuProofRecord[]
    spentProofs: CashuProofRecord[]
  }>
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
}

interface CtfSplitModule {
  splitRootCompleteSetForSwap(params: {
    mintUrl: string
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
    proofOperationStore: ProofOperationStore
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

  return {
    async splitProofsForExactSend(params) {
      const atomicSwap = await loadAtomicSwapModule()
      return atomicSwap.splitProofsForExactSend({
        mintUrl: params.mintUrl,
        sourceProofs: params.sourceProofs,
        amountSats: params.amountSats,
        preserveSourceKeyset: params.preserveSourceKeyset,
        operationId: params.operationId,
        proofOperationStore: DAEMON_PROOF_OPERATION_STORE,
      })
    },

    async sellerOpen(ctx, proofs) {
      const atomicSwap = await loadAtomicSwapModule()
      const out = await atomicSwap.sellerPrepareSwap(
        toAtomicCtx(ctx),
        proofs,
        proofOperationOptions(ctx.tradeId, 'seller-lock'),
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
          proofOperationStore: DAEMON_PROOF_OPERATION_STORE,
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
        proofOperationStore: DAEMON_PROOF_OPERATION_STORE,
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
        proofOperationOptions(ctx.tradeId, 'buyer-lock'),
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
        proofOperationOptions(ctx.tradeId, 'seller-claim'),
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
            proofOperationOptions(ctx.tradeId, 'buyer-claim'),
          )
        }
        await sleep(nut07PollIntervalMs)
      }
      throw new Error('Timed out waiting for seller to spend at mint')
    },

    async refundLockedProofs(ctx, lockedProofs, operationId) {
      if (lockedProofs.length === 0) return []
      await prepareProofOperation({
        operationId,
        kind: 'swap-refund',
        mintUrl: ctx.mintUrl,
        inputs: lockedProofs,
        outputs: {},
        metadata: {
          tradeId: ctx.tradeId,
          role: ctx.role,
          refundLocktime: ctx.sellerLocktime,
        },
      })
      const witnessed = lockedProofs.map((proof) => ({
        ...proof,
        witness: createP2PKWitness(
          hexToBytes(ctx.ephemeralKey.privateKeyHex),
          sha256(new TextEncoder().encode(proof.secret)),
        ),
      }))
      const mint = new CashuMint(ctx.mintUrl)
      const wallet = new CashuWallet(mint)
      await wallet.loadMint()
      const token = getEncodedToken({
        mint: ctx.mintUrl,
        unit: 'sat',
        proofs: witnessed as never,
      })
      const fresh = await wallet.receive(token)
      await markProofOperationCompleted(operationId, { refund: fresh })
      return fresh
    },
  }
}

function proofOperationOptions(
  tradeId: string,
  step: 'seller-lock' | 'buyer-lock' | 'seller-claim' | 'buyer-claim',
): Required<ProofOperationOptions> {
  return {
    operationId: `${tradeId}/${step}`,
    proofOperationStore: DAEMON_PROOF_OPERATION_STORE,
  }
}

const DAEMON_PROOF_OPERATION_STORE: ProofOperationStore = {
  getProofOperation,
  prepareProofOperation,
  markProofOperationCompleted,
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
