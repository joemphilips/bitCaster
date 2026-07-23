import {
  amountToNumber,
  keysetToOutcomeCollection as keysetToOutcomeCollectionShared,
  takeProofsForLock,
} from '@bitcaster-market/client-sdk/proofSelection'
import { parseOutcomeSetId } from '@bitcaster-market/client-sdk/outcomeSets'
import type {
  OutcomeMetadata,
  PartialLockHeldRecord,
  SwapFailure,
} from '@bitcaster-market/client-sdk/swapFailure'
import { redactSwapFailureForTelemetry } from '@bitcaster-market/client-sdk/swapFailure'
import { TRADE_MESSAGE_TYPES } from '@bitcaster-market/client-sdk/tradeSession'
import { normalizeMarketBaseAsset } from '@bitcaster-market/client-sdk/marketUnits'
import type { DaemonProfile } from './profile.ts'
import { readProfile } from './profile.ts'
import type { DaemonSecrets } from './secrets.ts'
import { readSecrets } from './secrets.ts'
import type { TradeRuntimeConnection } from './tradeRuntime.ts'
import {
  resolveCtfConsolidationInputFees,
  splitAvailableSatProofsForCtfCollateral,
  type WalletOpsDependencies,
} from './walletOps.ts'
import {
  resolveRootDirectLockOutputAmountSats,
} from '@bitcaster-market/client-sdk/ctfSplit'
import {
  type CashuProofRecord,
  type DaemonState,
  type LocalOrderPreflightSplit,
  type LocalSwapRecord,
  type StoredProofRecord,
  readState,
  updateState,
} from './state.ts'

type OutcomeAsset = Extract<StoredProofRecord['asset'], { kind: 'Outcome' }>
const PARTIAL_LOCK_REFUND_MARGIN_SECS = 60
const RETRYABLE_SWAP_STEP_RETRY_DELAY_MS = 1_000
const RETRYABLE_SWAP_STEP_MAX_ATTEMPTS = 90

interface MintSellerSplit {
  conditionId: string
  keepOutcomeSetId: string
  lockOutcomeSetId: string
}

export interface DaemonSwapContext {
  tradeId: string
  role: 'seller' | 'buyer'
  ephemeralKey: { privateKeyHex: string; publicKey: string }
  counterpartyPubkey: string
  sellerLocktime: number
  buyerLocktime: number
  mintUrl: string
  baseAsset?: string | null
}

export interface SellerOpenResult {
  adaptorPointCipher: string
  lockedProofsCipher: string
  adaptorSecretHex: string
  adaptorPointHex: string
  lockedProofs: CashuProofRecord[]
  changeProofs: CashuProofRecord[]
}

export interface SellerMintOpenResult extends SellerOpenResult {
  spentSatProofs: CashuProofRecord[]
  keepProofs: CashuProofRecord[]
  proofsByCollection: Record<string, CashuProofRecord[]>
  lockCollections: string[]
  keepCollections: string[]
  resolvedKeepOutcomeSetId: string
  resolvedLockOutcomeSetId: string
}

export interface BuyerRespondResult {
  lockedProofsCipher: string
  lockedProofs: CashuProofRecord[]
  changeProofs: CashuProofRecord[]
  preSigsHex: string[]
  sellerPreSigsHex: string[]
}

export interface ExactProofSplitResult {
  sendProofs: CashuProofRecord[]
  changeProofs: CashuProofRecord[]
  spentProofs: CashuProofRecord[]
}

interface ReservedExactProofs {
  exactProofs: CashuProofRecord[]
  spentProofs: CashuProofRecord[]
  changeProofs: CashuProofRecord[]
  wasSplit: boolean
}

interface ReservedExactProofGroup {
  selectedRows: StoredProofRecord[]
  split: ReservedExactProofs
  asset: OutcomeAsset
}

interface OutcomeProofRowGroup {
  outcomeSetId: string
  rows: StoredProofRecord[]
}

interface LockedOutcomeProofGroups {
  lockedProofs: CashuProofRecord[]
  changeProofs: CashuProofRecord[]
  collectionByKeyset: Map<string, string>
}

export interface LockedOutcomeProofResult {
  lockedProofs: CashuProofRecord[]
  changeProofs: CashuProofRecord[]
}

export interface DaemonSwapOps {
  splitProofsForExactSend(params: {
    mintUrl: string
    sourceProofs: CashuProofRecord[]
    amountSats: number
    preserveSourceKeyset?: boolean
    operationId: string
  }): Promise<ExactProofSplitResult>
  sellerOpen(
    ctx: DaemonSwapContext,
    proofs: CashuProofRecord[],
  ): Promise<SellerOpenResult>
  sellerOpenPrelocked(
    ctx: DaemonSwapContext,
    lockedProofs: CashuProofRecord[],
  ): Promise<SellerOpenResult>
  sellerLockOutcomeProofs(
    ctx: DaemonSwapContext,
    outcomeProofs: CashuProofRecord[],
    amountSats: number,
    operationId: string,
  ): Promise<LockedOutcomeProofResult>
  sellerOpenMint(
    ctx: DaemonSwapContext,
    params: {
      conditionId: string
      keepOutcomeSetId: string
      lockOutcomeSetId: string
      amountSats: number
    },
    collateralProofs: CashuProofRecord[],
  ): Promise<SellerMintOpenResult>
  buyerRespond(
    ctx: DaemonSwapContext,
    messages: { adaptorPoint: string; lockedProofsSeller: string },
    proofs: CashuProofRecord[],
    amountSats: number,
  ): Promise<BuyerRespondResult>
  sellerClaim(
    ctx: DaemonSwapContext,
    adaptorSecretHex: string,
    adaptorPointHex: string,
    lockedProofsBuyerCipher: string,
  ): Promise<CashuProofRecord[]>
  buyerClaim(
    ctx: DaemonSwapContext,
    state: {
      lockedProofs: CashuProofRecord[]
      preSigsHex: string[]
      lockedProofsSellerCipher: string
      sellerPreSigsHex: string[]
    },
  ): Promise<CashuProofRecord[]>
  refundLockedProofs(
    ctx: DaemonSwapContext,
    lockedProofs: CashuProofRecord[],
    operationId: string,
  ): Promise<CashuProofRecord[]>
}

export interface DaemonSwapExecutorOptions {
  connection: TradeRuntimeConnection
  ops?: DaemonSwapOps
  walletOpsDeps?: WalletOpsDependencies
  retryDelayMs?: number
  maxRetryAttempts?: number
}

export class DaemonSwapExecutor {
  private readonly connection: TradeRuntimeConnection
  private readonly ops: DaemonSwapOps
  private readonly walletOpsDeps: WalletOpsDependencies
  private readonly inFlight = new Set<string>()
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly retryAttempts = new Map<string, number>()
  private readonly retryDelayMs: number
  private readonly maxRetryAttempts: number

  constructor(options: DaemonSwapExecutorOptions) {
    this.connection = options.connection
    this.ops = options.ops ?? unsupportedSwapOps()
    this.walletOpsDeps = options.walletOpsDeps ?? {}
    this.retryDelayMs = options.retryDelayMs ?? RETRYABLE_SWAP_STEP_RETRY_DELAY_MS
    this.maxRetryAttempts = options.maxRetryAttempts ?? RETRYABLE_SWAP_STEP_MAX_ATTEMPTS
  }

  async onTradeCreated(swap: LocalSwapRecord | null): Promise<void> {
    if (!swap || swap.step === 'Failed') return
    if (swap.role === 'seller' && swap.step === 'opened') {
      await this.runOnce(swap.tradeId, 'seller-open', () =>
        this.sellerOpen(swap.tradeId),
      )
      return
    }
    if (swap.role === 'buyer' && swap.step === 'opened') {
      await this.maybeBuyerRespond(swap.tradeId)
      return
    }
    await this.maybeResendOutboundMessages(swap.tradeId)
  }

  async onSwapMessage(swap: LocalSwapRecord | null): Promise<void> {
    if (!swap || swap.step === 'Failed') return
    if (swap.role === 'buyer') await this.maybeBuyerRespond(swap.tradeId)
    if (swap.role === 'seller') await this.maybeClaim(swap.tradeId)
  }

  async onTradeStateChanged(swap: LocalSwapRecord | null): Promise<void> {
    if (!swap || swap.step !== 'settling') return
    await this.maybeClaim(swap.tradeId)
  }

  async resumeActiveSwaps(state: DaemonState): Promise<{
    activeSwaps: number
  }> {
    await this.sweepPartialLockFailures(state)
    const swaps = Object.values(state.swaps)
      .filter((swap) => !isTerminal(swap))
      .sort((a, b) => a.tradeId.localeCompare(b.tradeId))
    for (const swap of swaps) {
      if (swap.step === 'settling') {
        await this.maybeClaim(swap.tradeId)
      } else {
        await this.onTradeCreated(swap)
      }
    }
    return { activeSwaps: swaps.length }
  }

  private async sweepPartialLockFailures(state: DaemonState): Promise<void> {
    const nowSecs = Math.floor(Date.now() / 1000)
    const swaps = Object.values(state.swaps)
      .filter((swap) =>
        swap.failure?.kind === 'PartialLockHeld' &&
        typeof swap.failure.refundLocktime === 'number' &&
        swap.failure.refundLocktime + PARTIAL_LOCK_REFUND_MARGIN_SECS <= nowSecs)
      .sort((a, b) => a.tradeId.localeCompare(b.tradeId))

    for (const swap of swaps) {
      await this.runOnce(swap.tradeId, 'partial-lock-refund', () =>
        this.refundPartialLock(swap.tradeId),
      )
    }
  }

  private async refundPartialLock(tradeId: string): Promise<void> {
    const loaded = await this.loadContext(tradeId)
    if (!loaded) return
    const { ctx, swap, profile } = loaded
    if (swap.failure?.kind !== 'PartialLockHeld') return
    const failure = swap.failure
    const lockedRows = (await readState())?.wallet.proofs.filter(
      (row) => row.state === 'locked' && row.reservedBy === tradeId,
    ) ?? []
    if (lockedRows.length === 0) {
      await this.markRefunded(tradeId)
      return
    }

    try {
      const fresh = await this.ops.refundLockedProofs(
        ctx,
        lockedRows.map((row) => row.proof),
        `${tradeId}:partial-lock-refund`,
      )
      await updateState((state, now) => {
        const live = state.swaps[tradeId]
        if (!live) return
        removeProofsBySecret(state, profile.mintUrl, lockedRows.map((row) => row.proof))
        addRefundedProofsByKeyset(
          state,
          profile.mintUrl,
          fresh,
          outcomeByKeysetForPartialLock(failure, lockedRows),
          now,
        )
        live.step = 'refunded'
        live.updatedAt = now
      })
    } catch (err) {
      if (isAlreadySpentError(errorMessage(err))) {
        await this.markPartialLockAlreadySpent(
          tradeId,
          profile.mintUrl,
          lockedRows.map((row) => row.proof),
        )
        return
      }
      throw err
    }
  }

  private async maybeBuyerRespond(tradeId: string): Promise<void> {
    const swap = await this.readSwap(tradeId)
    if (
      !swap ||
      swap.role !== 'buyer' ||
      swap.step !== 'opened' ||
      !swap.messages.adaptorPoint ||
      !swap.messages.lockedProofsSeller
    ) {
      return
    }
    await this.runOnce(tradeId, 'buyer-respond', () =>
      this.buyerRespond(tradeId),
    )
  }

  private async maybeClaim(tradeId: string): Promise<void> {
    const swap = await this.readSwap(tradeId)
    if (!swap || swap.step === 'awaiting-confirmation') return
    if (
      swap.role === 'seller' &&
      swap.sellerAdaptorSecretHex &&
      swap.sellerAdaptorPointHex &&
      swap.messages.lockedProofsBuyer
    ) {
      await this.runOnce(tradeId, 'seller-claim', () =>
        this.sellerClaim(tradeId),
      )
    }
    if (
      swap.role === 'buyer' &&
      swap.buyerLockedProofs &&
      swap.buyerPreSigsHex &&
      swap.messages.lockedProofsSeller &&
      swap.sellerPreSigsHex
    ) {
      await this.runOnce(tradeId, 'buyer-claim', () =>
        this.buyerClaim(tradeId),
      )
    }
  }

  private async maybeResendOutboundMessages(tradeId: string): Promise<void> {
    const swap = await this.readSwap(tradeId)
    if (!swap || isTerminal(swap)) return

    if (
      swap.role === 'seller' &&
      (swap.step === 'seller-opened' ||
        swap.step === 'settling' ||
        swap.step === 'awaiting-confirmation') &&
      swap.messages.adaptorPoint &&
      swap.messages.lockedProofsSeller
    ) {
      const adaptorPoint = swap.messages.adaptorPoint
      const lockedProofsSeller = swap.messages.lockedProofsSeller
      await this.runOnce(tradeId, 'resend-seller-open', async () => {
        await this.sendSwapMessageResumable(
          tradeId,
          TRADE_MESSAGE_TYPES.adaptorPoint,
          adaptorPoint,
        )
        await this.sendSwapMessageResumable(
          tradeId,
          TRADE_MESSAGE_TYPES.lockedProofsSeller,
          lockedProofsSeller,
        )
      })
    }

    if (
      swap.role === 'buyer' &&
      (swap.step === 'buyer-responded' ||
        swap.step === 'settling' ||
        swap.step === 'awaiting-confirmation') &&
      swap.messages.lockedProofsBuyer
    ) {
      const lockedProofsBuyer = swap.messages.lockedProofsBuyer
      await this.runOnce(tradeId, 'resend-buyer-response', () =>
        this.sendSwapMessageResumable(
          tradeId,
          TRADE_MESSAGE_TYPES.lockedProofsBuyer,
          lockedProofsBuyer,
        ),
      )
    }

    if (swap.step === 'awaiting-confirmation') {
      await this.runOnce(tradeId, 'resend-settlement-complete', () =>
        this.sendSwapMessageResumable(
          tradeId,
          TRADE_MESSAGE_TYPES.settlementComplete,
          '',
        ),
      )
    }
  }

  private async sellerOpen(tradeId: string): Promise<void> {
    const loaded = await this.loadContext(tradeId)
    if (!loaded) return
    const { ctx, swap, profile } = loaded
    if (ctx.role !== 'seller') return

    try {
      const amount = requiredAmount(
        swap.outcomeFaceAmountSubunits ??
        swap.outcomeFaceAmountSats ??
        swap.fillAmountSubunits ??
        swap.fillAmountSats,
      )
      const mint = resolveMintSellerSplit(swap)
      if (mint) {
        await this.sellerOpenMint(
          tradeId,
          ctx,
          swap,
          profile.mintUrl,
          mint,
          amount,
        )
        return
      }
      const asset = outcomeAssetForMarket(swap.marketId)
      if (!asset) {
        throw new Error(`invalid market id for seller inventory: ${swap.marketId ?? '<missing>'}`)
      }
      const selected = await selectOutcomeProofsForOutcomeSet(
        await readState(),
        profile.mintUrl,
        asset.conditionId,
        asset.outcomeSetId,
        amount,
        this.walletOpsDeps,
        swap.baseAsset,
      )
      if (!selected) {
        throw new Error(`insufficient outcome proofs for seller open (${amount} sats)`)
      }
      const locked = await this.lockOutcomeProofRowGroups({
        tradeId,
        ctx,
        mintUrl: profile.mintUrl,
        conditionId: asset.conditionId,
        selected,
        amount,
        operationStep: 'seller-lock',
      })
      const result = await this.ops.sellerOpenPrelocked(
        ctx,
        locked.lockedProofs,
      )
      await updateState((state, now) => {
        const live = state.swaps[tradeId]
        if (!live || isTerminal(live)) return
        removeProofsBySecret(
          state,
          profile.mintUrl,
          selected.map((row) => row.proof),
        )
        addOutcomeProofsByKeyset(
          state,
          profile.mintUrl,
          result.lockedProofs,
          'locked',
          asset.conditionId,
          locked.collectionByKeyset,
          now,
          tradeId,
        )
        addOutcomeProofsByKeyset(
          state,
          profile.mintUrl,
          locked.changeProofs,
          'available',
          asset.conditionId,
          locked.collectionByKeyset,
          now,
        )
        addProofs(state, profile.mintUrl, result.changeProofs, 'available', asset, now)
        live.messages = {
          ...live.messages,
          adaptorPoint: result.adaptorPointCipher,
          lockedProofsSeller: result.lockedProofsCipher,
        }
        live.sellerAdaptorSecretHex = result.adaptorSecretHex
        live.sellerAdaptorPointHex = result.adaptorPointHex
        live.step = 'seller-opened'
        live.updatedAt = now
      })
      await this.sendSwapMessageResumable(
        tradeId,
        TRADE_MESSAGE_TYPES.adaptorPoint,
        result.adaptorPointCipher,
      )
      // INVARIANT (P03): lockedProofsSeller is only published after
      //   every keyset leg has successfully locked. A partial-leg
      //   failure must not emit this cipher. The runtime guard is at
      //   the orchestration layer (this function); tested by
      //   bitCaster/bitcaster-daemon/test/swapExecutor.test.ts ::
      //   Block2_SellerLock_Leg2Failure_DoesNotPublishLockedProofsSeller.
      //   Do not skip the test; do not refactor without re-pinning to
      //   the new call site.
      await this.sendSwapMessageResumable(
        tradeId,
        TRADE_MESSAGE_TYPES.lockedProofsSeller,
        result.lockedProofsCipher,
      )
    } catch (err) {
      await this.handleSwapStepError(tradeId, err)
    }
  }

  private async lockOutcomeProofRowGroups(input: {
    tradeId: string
    ctx: DaemonSwapContext
    mintUrl: string
    conditionId: string
    selected: StoredProofRecord[]
    amount: number
    operationStep: string
  }): Promise<LockedOutcomeProofGroups> {
    const groups = groupOutcomeProofRowsByCollection(input.selected)
    const collectionByKeyset = keysetToOutcomeCollection(input.selected)
    const lockedProofs: CashuProofRecord[] = []
    const changeProofs: CashuProofRecord[] = []
    const spentProofs: CashuProofRecord[] = []

    for (const group of groups) {
      try {
        const locked = await this.ops.sellerLockOutcomeProofs(
          input.ctx,
          group.rows.map(proofWithOutcomeMetadata),
          input.amount,
          groups.length === 1
            ? `${input.tradeId}:${input.operationStep}`
            : `${input.tradeId}:${input.operationStep}:${encodeURIComponent(group.outcomeSetId)}`,
        )
        lockedProofs.push(...locked.lockedProofs)
        changeProofs.push(...locked.changeProofs)
        spentProofs.push(...group.rows.map((row) => row.proof))
      } catch (err) {
        const partial = partialLockFromError(err)
        const combinedPartial = {
          spentProofs: [...spentProofs, ...(partial?.spentProofs ?? [])],
          lockedProofs: [...lockedProofs, ...(partial?.lockedProofs ?? [])],
          changeProofs: [...changeProofs, ...(partial?.changeProofs ?? [])],
        }
        if (combinedPartial.lockedProofs.length > 0) {
          await this.persistPartialLockParts(
            input.tradeId,
            input.mintUrl,
            input.conditionId,
            collectionByKeyset,
            err,
            combinedPartial,
          )
        }
        throw err
      }
    }

    return {
      lockedProofs,
      changeProofs,
      collectionByKeyset,
    }
  }

  private async persistPartialLockParts(
    tradeId: string,
    mintUrl: string,
    conditionId: string,
    collectionByKeyset: Map<string, string>,
    err: unknown,
    partial: NonNullable<ReturnType<typeof partialLockFromError>>,
  ): Promise<void> {
    await updateState((state, now) => {
      removeProofsBySecret(state, mintUrl, partial.spentProofs)
      addOutcomeProofsByKeyset(
        state,
        mintUrl,
        partial.lockedProofs,
        'locked',
        conditionId,
        collectionByKeyset,
        now,
        tradeId,
      )
      addOutcomeProofsByKeyset(
        state,
        mintUrl,
        partial.changeProofs,
        'available',
        conditionId,
        collectionByKeyset,
        now,
      )
      const live = state.swaps[tradeId]
      if (live) {
        live.failure = partialLockRecordFromParts(
          tradeId,
          conditionId,
          collectionByKeyset,
          err,
          partial,
        )
      }
    })
    if (err && typeof err === 'object') {
      ;(err as { failure?: PartialLockHeldRecord }).failure =
        partialLockRecordFromParts(
          tradeId,
          conditionId,
          collectionByKeyset,
          err,
          partial,
        )
    }
  }

  private async sellerOpenMint(
    tradeId: string,
    ctx: DaemonSwapContext,
    swap: LocalSwapRecord,
    mintUrl: string,
    split: MintSellerSplit,
    amount: number,
  ): Promise<void> {
    const availableOutcome = await selectOutcomeProofsForOutcomeSet(
      await readState(),
      mintUrl,
      split.conditionId,
      split.lockOutcomeSetId,
      amount,
      this.walletOpsDeps,
      swap.baseAsset,
    )
    if (availableOutcome) {
      const locked = await this.lockOutcomeProofRowGroups({
        tradeId,
        ctx,
        mintUrl,
        conditionId: split.conditionId,
        selected: availableOutcome,
        amount,
        operationStep: 'seller-inventory-lock',
      })
      const result = await this.ops.sellerOpenPrelocked(
        ctx,
        locked.lockedProofs,
      )
      await updateState((state, now) => {
        const live = state.swaps[tradeId]
        if (!live || isTerminal(live)) return
        removeProofsBySecret(
          state,
          mintUrl,
          availableOutcome.map((row) => row.proof),
        )
        addOutcomeProofsByKeyset(
          state,
          mintUrl,
          result.lockedProofs,
          'locked',
          split.conditionId,
          locked.collectionByKeyset,
          now,
          tradeId,
        )
        addOutcomeProofsByKeyset(
          state,
          mintUrl,
          locked.changeProofs,
          'available',
          split.conditionId,
          locked.collectionByKeyset,
          now,
        )
        live.messages = {
          ...live.messages,
          adaptorPoint: result.adaptorPointCipher,
          lockedProofsSeller: result.lockedProofsCipher,
        }
        live.sellerAdaptorSecretHex = result.adaptorSecretHex
        live.sellerAdaptorPointHex = result.adaptorPointHex
        live.sellerKeepOutcomeSetId = split.keepOutcomeSetId
        live.sellerLockOutcomeSetId = split.lockOutcomeSetId
        live.step = 'seller-opened'
        live.updatedAt = now
      })
      await this.sendSwapMessageResumable(
        tradeId,
        TRADE_MESSAGE_TYPES.adaptorPoint,
        result.adaptorPointCipher,
      )
      // INVARIANT (P03): lockedProofsSeller is only published after
      //   every keyset leg has successfully locked. A partial-leg
      //   failure must not emit this cipher. The runtime guard is at
      //   the orchestration layer (this function); tested by
      //   bitCaster/bitcaster-daemon/test/swapExecutor.test.ts ::
      //   Block2_SellerLock_Leg2Failure_DoesNotPublishLockedProofsSeller.
      //   Do not skip the test; do not refactor without re-pinning to
      //   the new call site.
      await this.sendSwapMessageResumable(
        tradeId,
        TRADE_MESSAGE_TYPES.lockedProofsSeller,
        result.lockedProofsCipher,
      )
      return
    }

    const preflight = resolvePreflightSplit(await readState(), swap, split)
    if (preflight) {
      await this.sellerOpenPreflightMint(
        tradeId,
        ctx,
        mintUrl,
        split,
        amount,
        preflight,
      )
      return
    }

    const secrets = await readSecrets()
    if (!secrets) throw new Error('daemon secrets are not initialized')
    const resolveSplitAmount =
      this.walletOpsDeps.resolveRootDirectLockOutputAmountSats ??
      resolveRootDirectLockOutputAmountSats
    const baseAsset = normalizeMarketBaseAsset(swap.baseAsset)
    const splitAmount = await resolveSplitAmount({
      mintUrl,
      baseAsset,
      conditionId: split.conditionId,
      amountSats: amount,
      keepOutcomeSetId: split.keepOutcomeSetId,
      lockOutcomeSetId: split.lockOutcomeSetId,
    })
    const collateral = await splitAvailableSatProofsForCtfCollateral(
      splitAmount,
      mintUrl,
      `${tradeId}:seller-regular-ctf-input`,
      secrets,
      this.walletOpsDeps,
      baseAsset,
    )
    const result = await this.ops.sellerOpenMint(
      ctx,
      {
        conditionId: split.conditionId,
        keepOutcomeSetId: split.keepOutcomeSetId,
        lockOutcomeSetId: split.lockOutcomeSetId,
        amountSats: splitAmount,
      },
      collateral.inputs,
    )
    await updateState((state, now) => {
      const live = state.swaps[tradeId]
      if (!live || isTerminal(live)) return
      removeProofsBySecret(state, mintUrl, [
        ...collateral.spent,
        ...result.spentSatProofs,
      ])
      addProofs(state, mintUrl, collateral.keep, 'available', { kind: 'sats', baseAsset }, now)
      addOutcomeProofsByCollection(
        state,
        mintUrl,
        result.proofsByCollection,
        result.keepCollections,
        'available',
        split.conditionId,
        now,
      )
      live.messages = {
        ...live.messages,
        adaptorPoint: result.adaptorPointCipher,
        lockedProofsSeller: result.lockedProofsCipher,
      }
      live.sellerAdaptorSecretHex = result.adaptorSecretHex
      live.sellerAdaptorPointHex = result.adaptorPointHex
      live.sellerKeepOutcomeSetId = result.resolvedKeepOutcomeSetId
      live.sellerLockOutcomeSetId = result.resolvedLockOutcomeSetId
      live.step = 'seller-opened'
      live.updatedAt = now
    })
    await this.sendSwapMessageResumable(
      tradeId,
      TRADE_MESSAGE_TYPES.adaptorPoint,
      result.adaptorPointCipher,
    )
    // INVARIANT (P03): lockedProofsSeller is only published after
    //   every keyset leg has successfully locked. A partial-leg
    //   failure must not emit this cipher. The runtime guard is at
    //   the orchestration layer (this function); tested by
    //   bitCaster/bitcaster-daemon/test/swapExecutor.test.ts ::
    //   Block2_SellerLock_Leg2Failure_DoesNotPublishLockedProofsSeller.
    //   Do not skip the test; do not refactor without re-pinning to
    //   the new call site.
    await this.sendSwapMessageResumable(
      tradeId,
      TRADE_MESSAGE_TYPES.lockedProofsSeller,
      result.lockedProofsCipher,
    )
  }

  private async sellerOpenPreflightMint(
    tradeId: string,
    ctx: DaemonSwapContext,
    mintUrl: string,
    split: MintSellerSplit,
    amount: number,
    preflight: LocalOrderPreflightSplit,
  ): Promise<void> {
    const state = await readState()
    const selectedLock = selectReservedProofRowsForOutcomeSet(
      state,
      mintUrl,
      preflight.reservationId,
      split.conditionId,
      preflight.lockOutcomeSetId,
    )
    if (!selectedLock || sumProofRows(selectedLock) < amount) {
      throw new Error(
        `insufficient pre-flight lock proofs for mint seller open (${amount} sats)`,
      )
    }
    const selectedKeep = await selectReservedProofsForOutcomeSet(
      state,
      mintUrl,
      preflight.reservationId,
      split.conditionId,
      preflight.keepOutcomeSetId,
      amount,
      this.walletOpsDeps,
    )
    if (!selectedKeep) {
      throw new Error(
        `insufficient pre-flight keep proofs for mint seller open (${amount} sats)`,
      )
    }

    const lockProofs = await this.prepareReservedExactProofsByOutcomeSet(
      mintUrl,
      selectedLock,
      amount,
      `${tradeId}:seller-preflight-lock-exact-v2`,
      (rows) => Math.max(amount, sumProofRows(rows)),
    )
    const keepProofs = await this.prepareReservedExactProofsByOutcomeSet(
      mintUrl,
      selectedKeep,
      amount,
      `${tradeId}:seller-preflight-keep-exact-v2`,
    )
    await updateState((state, now) => {
      applyReservedLockProofGroups(
        state,
        mintUrl,
        lockProofs,
        preflight.reservationId,
        now,
      )
    })

    const lockCollectionByKeyset = keysetToOutcomeCollection(selectedLock)
    const lockedProofs: CashuProofRecord[] = []
    const changeProofs: CashuProofRecord[] = []
    const spentProofs: CashuProofRecord[] = []
    try {
      for (const group of lockProofs) {
        const locked = await this.ops.sellerLockOutcomeProofs(
          ctx,
          group.split.exactProofs.map((proof) =>
            proofWithAssetMetadata(proof, group.asset),
          ),
          amount,
          lockProofs.length === 1
            ? `${tradeId}:seller-preflight-lock`
            : `${tradeId}:seller-preflight-lock:${encodeURIComponent(group.asset.outcomeSetId)}`,
        )
        lockedProofs.push(...locked.lockedProofs)
        changeProofs.push(...locked.changeProofs)
        spentProofs.push(...group.split.exactProofs)
      }
    } catch (err) {
      const partial = partialLockFromError(err)
      const combinedPartial = {
        spentProofs: [...spentProofs, ...(partial?.spentProofs ?? [])],
        lockedProofs: [...lockedProofs, ...(partial?.lockedProofs ?? [])],
        changeProofs: [...changeProofs, ...(partial?.changeProofs ?? [])],
      }
      if (combinedPartial.lockedProofs.length > 0) {
        await this.persistPartialLockParts(
          tradeId,
          mintUrl,
          split.conditionId,
          lockCollectionByKeyset,
          err,
          combinedPartial,
        )
      }
      throw err
    }
    const result = await this.ops.sellerOpenPrelocked(ctx, lockedProofs)
    await updateState((state, now) => {
      const live = state.swaps[tradeId]
      if (!live || isTerminal(live)) return
      removeProofsBySecret(
        state,
        mintUrl,
        lockProofs.flatMap((group) => group.split.exactProofs),
      )
      addProofs(
        state,
        mintUrl,
        result.lockedProofs,
        'locked',
        {
          kind: 'Outcome',
          conditionId: split.conditionId,
          outcomeSetId: preflight.lockOutcomeSetId,
        },
        now,
        tradeId,
      )
      addOutcomeProofsByKeyset(
        state,
        mintUrl,
        changeProofs,
        'reserved',
        split.conditionId,
        lockCollectionByKeyset,
        now,
        preflight.reservationId,
      )
      applyReservedKeepProofGroups(
        state,
        mintUrl,
        keepProofs,
        preflight.reservationId,
        now,
      )
      live.messages = {
        ...live.messages,
        adaptorPoint: result.adaptorPointCipher,
        lockedProofsSeller: result.lockedProofsCipher,
      }
      live.sellerAdaptorSecretHex = result.adaptorSecretHex
      live.sellerAdaptorPointHex = result.adaptorPointHex
      live.sellerKeepOutcomeSetId = preflight.keepOutcomeSetId
      live.sellerLockOutcomeSetId = preflight.lockOutcomeSetId
      live.step = 'seller-opened'
      live.updatedAt = now
    })
    await this.sendSwapMessageResumable(
      tradeId,
      TRADE_MESSAGE_TYPES.adaptorPoint,
      result.adaptorPointCipher,
    )
    // INVARIANT (P03): lockedProofsSeller is only published after
    //   every keyset leg has successfully locked. A partial-leg
    //   failure must not emit this cipher. The runtime guard is at
    //   the orchestration layer (this function); tested by
    //   bitCaster/bitcaster-daemon/test/swapExecutor.test.ts ::
    //   Block2_SellerLock_Leg2Failure_DoesNotPublishLockedProofsSeller.
    //   Do not skip the test; do not refactor without re-pinning to
    //   the new call site.
    await this.sendSwapMessageResumable(
      tradeId,
      TRADE_MESSAGE_TYPES.lockedProofsSeller,
      result.lockedProofsCipher,
    )
  }

  private async prepareReservedExactProofs(
    mintUrl: string,
    selected: StoredProofRecord[],
    amount: number,
    operationId: string,
  ): Promise<ReservedExactProofs> {
    if (sumProofRows(selected) === amount) {
      return {
        exactProofs: selected.map((row) => row.proof),
        spentProofs: selected.map((row) => row.proof),
        changeProofs: [],
        wasSplit: false,
      }
    }
    const split = await this.ops.splitProofsForExactSend({
      mintUrl,
      sourceProofs: selected.map((row) => row.proof),
      amountSats: amount,
      preserveSourceKeyset: selected.some((row) => row.asset.kind === 'Outcome'),
      operationId,
    })
    return {
      exactProofs: split.sendProofs,
      spentProofs: split.spentProofs,
      changeProofs: split.changeProofs,
      wasSplit: true,
    }
  }

  private async prepareReservedExactProofsByOutcomeSet(
    mintUrl: string,
    selected: StoredProofRecord[],
    amount: number,
    operationId: string,
    amountForRows?: (rows: StoredProofRecord[]) => number,
  ): Promise<ReservedExactProofGroup[]> {
    const byOutcome = new Map<string, StoredProofRecord[]>()
    for (const row of selected) {
      if (row.asset.kind !== 'Outcome') {
        throw new Error('pre-flight keep proofs must be outcome proofs')
      }
      byOutcome.set(row.asset.outcomeSetId, [
        ...(byOutcome.get(row.asset.outcomeSetId) ?? []),
        row,
      ])
    }

    const groups: ReservedExactProofGroup[] = []
    for (const [outcomeSetId, rows] of byOutcome) {
      const first = rows[0]
      if (!first || first.asset.kind !== 'Outcome') {
        throw new Error(`pre-flight keep proof group ${outcomeSetId} is empty`)
      }
      groups.push({
        selectedRows: rows,
        split: await this.prepareReservedExactProofs(
          mintUrl,
          rows,
          amountForRows?.(rows) ?? amount,
          `${operationId}/${encodeURIComponent(outcomeSetId)}`,
        ),
        asset: {
          kind: 'Outcome',
          conditionId: first.asset.conditionId,
          outcomeSetId,
        },
      })
    }
    return groups
  }

  private async buyerRespond(tradeId: string): Promise<void> {
    const loaded = await this.loadContext(tradeId)
    if (!loaded) return
    const { ctx, swap, profile } = loaded
    if (
      ctx.role !== 'buyer' ||
      !swap.messages.adaptorPoint ||
      !swap.messages.lockedProofsSeller
    ) {
      return
    }

    try {
      const amount = requiredAmount(swap.quotePaymentSubunits ?? swap.quotePaymentSats ?? swap.fillAmountSubunits ?? swap.fillAmountSats)
      const baseAsset = normalizeMarketBaseAsset(swap.baseAsset)
      const selected = await selectProofs(
        await readState(),
        profile.mintUrl,
        (proof) =>
          proof.asset.kind === 'sats' &&
          normalizeMarketBaseAsset(proof.asset.baseAsset) === baseAsset,
        amount,
        this.walletOpsDeps,
      )
      if (!selected) {
        throw new Error(`insufficient ${baseAsset} proofs for buyer response (${amount} sub-units)`)
      }
      const result = await this.ops.buyerRespond(
        ctx,
        {
          adaptorPoint: swap.messages.adaptorPoint,
          lockedProofsSeller: swap.messages.lockedProofsSeller,
        },
        selected.map((row) => row.proof),
        amount,
      )
      await updateState((state, now) => {
        const live = state.swaps[tradeId]
        if (!live || isTerminal(live)) return
        markProofs(state, selected, 'locked', tradeId, now)
        addProofs(state, profile.mintUrl, result.changeProofs, 'available', { kind: 'sats' }, now)
        live.messages = {
          ...live.messages,
          lockedProofsBuyer: result.lockedProofsCipher,
        }
        live.buyerLockedProofs = result.lockedProofs
        live.buyerPreSigsHex = result.preSigsHex
        live.sellerPreSigsHex = result.sellerPreSigsHex
        live.step = 'buyer-responded'
        live.updatedAt = now
      })
      await this.sendSwapMessageResumable(
        tradeId,
        TRADE_MESSAGE_TYPES.lockedProofsBuyer,
        result.lockedProofsCipher,
      )
    } catch (err) {
      await this.handleSwapStepError(tradeId, err)
    }
  }

  private async sellerClaim(tradeId: string): Promise<void> {
    const loaded = await this.loadContext(tradeId)
    if (!loaded) return
    const { ctx, swap, profile } = loaded
    if (
      ctx.role !== 'seller' ||
      !swap.sellerAdaptorSecretHex ||
      !swap.sellerAdaptorPointHex ||
      !swap.messages.lockedProofsBuyer
    ) {
      return
    }
    try {
      const fresh = await this.ops.sellerClaim(
        ctx,
        swap.sellerAdaptorSecretHex,
        swap.sellerAdaptorPointHex,
        swap.messages.lockedProofsBuyer,
      )
      await updateState((state, now) => {
        const live = state.swaps[tradeId]
        if (!live || isTerminal(live)) return
        addProofs(state, profile.mintUrl, fresh, 'available', { kind: 'sats' }, now)
        live.step = 'awaiting-confirmation'
        live.updatedAt = now
      })
      await this.sendSwapMessageResumable(
        tradeId,
        TRADE_MESSAGE_TYPES.settlementComplete,
        '',
      )
    } catch (err) {
      await this.handleSwapStepError(tradeId, err)
    }
  }

  private async buyerClaim(tradeId: string): Promise<void> {
    const loaded = await this.loadContext(tradeId)
    if (!loaded) return
    const { ctx, swap, profile } = loaded
    const asset = outcomeAssetForMarket(swap.marketId)
    if (
      ctx.role !== 'buyer' ||
      !asset ||
      !swap.buyerLockedProofs ||
      !swap.buyerPreSigsHex ||
      !swap.messages.lockedProofsSeller ||
      !swap.sellerPreSigsHex
    ) {
      return
    }
    try {
      const fresh = await this.ops.buyerClaim(ctx, {
        lockedProofs: swap.buyerLockedProofs,
        preSigsHex: swap.buyerPreSigsHex,
        lockedProofsSellerCipher: swap.messages.lockedProofsSeller,
        sellerPreSigsHex: swap.sellerPreSigsHex,
      })
      const receivedAsset =
        swap.settlementKind === 'Mint' && swap.sellerLockOutcomeSetId
          ? {
              kind: 'Outcome' as const,
              conditionId: asset.conditionId,
              outcomeSetId: swap.sellerLockOutcomeSetId,
            }
          : asset
      const compoundOutcomeSet = parseOutcomeSetId(receivedAsset.outcomeSetId).length > 1
      const collectionByKeyset = compoundOutcomeSet
        ? await loadRootCollectionByKeyset(profile.mintUrl, receivedAsset.conditionId)
        : null
      await updateState((state, now) => {
        const live = state.swaps[tradeId]
        if (!live || isTerminal(live)) return
        if (collectionByKeyset) {
          addOutcomeProofsByKeyset(
            state,
            profile.mintUrl,
            fresh,
            'available',
            receivedAsset.conditionId,
            collectionByKeyset,
            now,
          )
        } else {
          addProofs(state, profile.mintUrl, fresh, 'available', receivedAsset, now)
        }
        live.step = 'awaiting-confirmation'
        live.updatedAt = now
      })
      await this.sendSwapMessageResumable(
        tradeId,
        TRADE_MESSAGE_TYPES.settlementComplete,
        '',
      )
    } catch (err) {
      await this.handleSwapStepError(tradeId, err)
    }
  }

  private async loadContext(tradeId: string): Promise<{
    ctx: DaemonSwapContext
    swap: LocalSwapRecord
    profile: DaemonProfile
    secrets: DaemonSecrets
  } | null> {
    // Each reader performs an identity-bound schema preflight before opening
    // SQLite. Keep those preflight/open windows ordered so the connections do
    // not create or touch WAL sidecars underneath one another's inventory.
    const profile = await readProfile()
    const secrets = await readSecrets()
    const state = await readState()
    const swap = state?.swaps[tradeId]
    if (!profile || !secrets || !swap || !swap.role || !swap.orderId) return null
    const key = secrets.orderEphemeralKeys[tradeId] ?? secrets.orderEphemeralKeys[swap.orderId]
    if (!key) {
      await this.fail(tradeId, `missing ephemeral key for trade ${tradeId}`)
      return null
    }
    if (
      !swap.counterpartyPubkey ||
      swap.sellerLocktime === undefined ||
      swap.buyerLocktime === undefined
    ) {
      return null
    }
    return {
      swap,
      profile,
      secrets,
      ctx: {
        tradeId,
        role: swap.role,
        ephemeralKey: {
          privateKeyHex: key.privateKeyHex,
          publicKey: key.publicKeyHex,
        },
        counterpartyPubkey: swap.counterpartyPubkey,
        sellerLocktime: swap.sellerLocktime,
        buyerLocktime: swap.buyerLocktime,
        mintUrl: profile.mintUrl,
        baseAsset: normalizeMarketBaseAsset(swap.baseAsset),
      },
    }
  }

  private async readSwap(tradeId: string): Promise<LocalSwapRecord | null> {
    return (await readState())?.swaps[tradeId] ?? null
  }

  private async fail(tradeId: string, error: string): Promise<void> {
    await updateState((state, now) => {
      const swap = state.swaps[tradeId]
      if (!swap || isTerminal(swap)) return
      swap.step = 'Failed'
      swap.error = error
      swap.updatedAt = now
    })
  }

  private async failWithSwapFailure(
    tradeId: string,
    failure: SwapFailure,
  ): Promise<void> {
    await updateState((state, now) => {
      const swap = state.swaps[tradeId]
      if (!swap || isTerminal(swap)) return
      swap.step = 'Failed'
      swap.error = failure.detail
      swap.failure = failure
      swap.updatedAt = now
    })
    console.warn('[swap.failure]', redactSwapFailureForTelemetry(failure))
  }

  private async markRefunded(tradeId: string): Promise<void> {
    await updateState((state, now) => {
      const swap = state.swaps[tradeId]
      if (!swap) return
      swap.step = 'refunded'
      swap.updatedAt = now
    })
  }

  private async markPartialLockAlreadySpent(
    tradeId: string,
    mintUrl: string,
    lockedProofs: CashuProofRecord[],
  ): Promise<void> {
    await updateState((state, now) => {
      const swap = state.swaps[tradeId]
      if (!swap) return
      removeProofsBySecret(state, mintUrl, lockedProofs)
      swap.step = 'refunded'
      swap.updatedAt = now
    })
  }

  private async retryLater(tradeId: string, error: string): Promise<void> {
    await updateState((state, now) => {
      const swap = state.swaps[tradeId]
      if (!swap || isTerminal(swap)) return
      swap.error = error
      swap.updatedAt = now
    })
    this.scheduleRetry(tradeId)
  }

  private scheduleRetry(tradeId: string): void {
    if (this.retryTimers.has(tradeId)) return
    if ((this.retryAttempts.get(tradeId) ?? 0) >= this.maxRetryAttempts) return
    const retry = () => {
      this.retryTimers.delete(tradeId)
      if ([...this.inFlight].some((key) => key.startsWith(`${tradeId}:`))) {
        const deferred = setTimeout(retry, this.retryDelayMs)
        deferred.unref?.()
        this.retryTimers.set(tradeId, deferred)
        return
      }
      const attempts = this.retryAttempts.get(tradeId) ?? 0
      if (attempts >= this.maxRetryAttempts) return
      this.retryAttempts.set(tradeId, attempts + 1)
      void this.retryActiveSwap(tradeId).catch(() => undefined)
    }
    const timer = setTimeout(retry, this.retryDelayMs)
    timer.unref?.()
    this.retryTimers.set(tradeId, timer)
  }

  private async retryActiveSwap(tradeId: string): Promise<void> {
    const state = await readState()
    const swap = state?.swaps[tradeId]
    if (!swap || isTerminal(swap)) {
      this.clearRetryState(tradeId)
      return
    }
    await this.resumeActiveSwaps(state)
  }

  private clearRetryState(tradeId: string): void {
    const timer = this.retryTimers.get(tradeId)
    if (timer) clearTimeout(timer)
    this.retryTimers.delete(tradeId)
    this.retryAttempts.delete(tradeId)
  }

  private async handleSwapStepError(
    tradeId: string,
    err: unknown,
  ): Promise<void> {
    const message = errorMessage(err)
    const failure = swapFailureFromError(err)
    if (failure) {
      await this.failWithSwapFailure(tradeId, failure)
      return
    }
    if (isRetryableSwapStepError(message)) {
      await this.retryLater(tradeId, message)
      return
    }
    await this.fail(tradeId, message)
  }

  private async runOnce(
    tradeId: string,
    step: string,
    run: () => Promise<void>,
  ): Promise<void> {
    const key = `${tradeId}:${step}`
    if (this.inFlight.has(key)) return
    this.inFlight.add(key)
    try {
      await run()
    } finally {
      this.inFlight.delete(key)
    }
  }

  private async sendSwapMessageResumable(
    tradeId: string,
    messageType: string,
    ciphertext: string,
  ): Promise<void> {
    try {
      await this.connection.sendSwapMessage(tradeId, messageType, ciphertext)
    } catch {
      // Protocol ciphertexts are persisted before send; restart/rejoin replay will retry.
    }
  }
}

async function selectProofs(
  state: DaemonState | null,
  mintUrl: string,
  predicate: (proof: StoredProofRecord) => boolean,
  amount: number,
  deps: WalletOpsDependencies = {},
): Promise<StoredProofRecord[] | null> {
  const candidates = (state?.wallet.proofs ?? []).filter(
    (proof) =>
      proof.mintUrl === mintUrl &&
      proof.state === 'available' &&
      predicate(proof),
  )
  const inputFeePpkByKeyset = await inputFeePpkByKeysetForRows(
    mintUrl,
    candidates,
    deps,
  )
  const selectedProofs = takeProofsForLock(
    candidates.map((row) => row.proof),
    amount,
    inputFeePpkByKeyset,
  )
  if (!selectedProofs) return null
  const selectedKeys = new Set(selectedProofs.map(proofKey))
  return candidates.filter((row) => selectedKeys.has(proofKey(row.proof)))
}

async function selectOutcomeProofsForOutcomeSet(
  state: DaemonState | null,
  mintUrl: string,
  conditionId: string,
  outcomeSetId: string,
  amount: number,
  deps: WalletOpsDependencies = {},
  baseAssetInput?: string | null,
): Promise<StoredProofRecord[] | null> {
  const baseAsset = normalizeMarketBaseAsset(baseAssetInput)
  const exact = await selectProofs(
    state,
    mintUrl,
    (proof) =>
      proof.asset.kind === 'Outcome' &&
      proof.asset.conditionId === conditionId &&
      proof.asset.outcomeSetId === outcomeSetId &&
      normalizeMarketBaseAsset(proof.asset.baseAsset) === baseAsset,
    amount,
    deps,
  )
  if (exact) return exact

  const selected: StoredProofRecord[] = []
  for (const outcomeCollection of parseOutcomeSetId(outcomeSetId)) {
    const leg = await selectProofs(
      state,
      mintUrl,
      (proof) =>
        proof.asset.kind === 'Outcome' &&
        proof.asset.conditionId === conditionId &&
        proof.asset.outcomeSetId === outcomeCollection &&
        normalizeMarketBaseAsset(proof.asset.baseAsset) === baseAsset,
      amount,
      deps,
    )
    if (!leg) return null
    selected.push(...leg)
  }
  return selected
}

async function selectReservedProofs(
  state: DaemonState | null,
  mintUrl: string,
  reservedBy: string,
  predicate: (proof: StoredProofRecord) => boolean,
  amount: number,
  deps: WalletOpsDependencies = {},
): Promise<StoredProofRecord[] | null> {
  const candidates = (state?.wallet.proofs ?? []).filter(
    (proof) =>
      proof.mintUrl === mintUrl &&
      proof.state === 'reserved' &&
      proof.reservedBy === reservedBy &&
      predicate(proof),
  )
  const inputFeePpkByKeyset = await inputFeePpkByKeysetForRows(
    mintUrl,
    candidates,
    deps,
  )
  const selectedProofs = takeProofsForLock(
    candidates.map((row) => row.proof),
    amount,
    inputFeePpkByKeyset,
  )
  if (!selectedProofs) return null
  const selectedKeys = new Set(selectedProofs.map(proofKey))
  return candidates.filter((row) => selectedKeys.has(proofKey(row.proof)))
}

async function selectReservedProofsForOutcomeSet(
  state: DaemonState | null,
  mintUrl: string,
  reservedBy: string,
  conditionId: string,
  outcomeSetId: string,
  amount: number,
  deps: WalletOpsDependencies = {},
): Promise<StoredProofRecord[] | null> {
  const exact = await selectReservedProofs(
    state,
    mintUrl,
    reservedBy,
    (proof) =>
      proof.asset.kind === 'Outcome' &&
      proof.asset.conditionId === conditionId &&
      proof.asset.outcomeSetId === outcomeSetId,
    amount,
    deps,
  )
  if (exact) return exact

  const selected: StoredProofRecord[] = []
  for (const outcomeCollection of parseOutcomeSetId(outcomeSetId)) {
    const leg = await selectReservedProofs(
      state,
      mintUrl,
      reservedBy,
      (proof) =>
        proof.asset.kind === 'Outcome' &&
        proof.asset.conditionId === conditionId &&
        proof.asset.outcomeSetId === outcomeCollection,
      amount,
      deps,
    )
    if (!leg) return null
    selected.push(...leg)
  }
  return selected
}

async function inputFeePpkByKeysetForRows(
  mintUrl: string,
  rows: StoredProofRecord[],
  deps: WalletOpsDependencies,
): Promise<Record<string, number>> {
  const keysetIds = rows
    .map((row) => row.proof.id)
    .filter((keysetId): keysetId is string => Boolean(keysetId))
  if (keysetIds.length === 0) return {}
  return resolveCtfConsolidationInputFees(mintUrl, keysetIds, deps)
}

function selectReservedProofRowsForOutcomeSet(
  state: DaemonState | null,
  mintUrl: string,
  reservedBy: string,
  conditionId: string,
  outcomeSetId: string,
): StoredProofRecord[] | null {
  const rows = state?.wallet.proofs ?? []
  const exact = rows.filter(
    (proof) =>
      proof.mintUrl === mintUrl &&
      proof.state === 'reserved' &&
      proof.reservedBy === reservedBy &&
      proof.asset.kind === 'Outcome' &&
      proof.asset.conditionId === conditionId &&
      proof.asset.outcomeSetId === outcomeSetId,
  )
  if (exact.length > 0) return exact

  const selected: StoredProofRecord[] = []
  for (const outcomeCollection of parseOutcomeSetId(outcomeSetId)) {
    const leg = rows.filter(
      (proof) =>
        proof.mintUrl === mintUrl &&
        proof.state === 'reserved' &&
        proof.reservedBy === reservedBy &&
        proof.asset.kind === 'Outcome' &&
        proof.asset.conditionId === conditionId &&
        proof.asset.outcomeSetId === outcomeCollection,
    )
    if (leg.length === 0) return null
    selected.push(...leg)
  }
  return selected
}

function markProofs(
  state: DaemonState,
  proofs: StoredProofRecord[],
  nextState: StoredProofRecord['state'],
  reservedBy: string,
  now: string,
): void {
  const keys = new Set(proofs.map((proof) => proofKey(proof.proof)))
  for (const row of state.wallet.proofs) {
    if (!keys.has(proofKey(row.proof))) continue
    row.state = nextState
    row.reservedBy = reservedBy
    row.updatedAt = now
  }
}

function applyReservedKeepProofs(
  state: DaemonState,
  mintUrl: string,
  selectedRows: StoredProofRecord[],
  split: ReservedExactProofs,
  asset: OutcomeAsset,
  reservationId: string,
  now: string,
): void {
  if (!split.wasSplit) {
    releaseReservedProofs(state, selectedRows, now)
    return
  }

  removeProofsBySecret(state, mintUrl, split.spentProofs)
  addProofs(state, mintUrl, split.exactProofs, 'available', asset, now)
  addProofs(state, mintUrl, split.changeProofs, 'reserved', asset, now, reservationId)
}

function applyReservedKeepProofGroups(
  state: DaemonState,
  mintUrl: string,
  groups: ReservedExactProofGroup[],
  reservationId: string,
  now: string,
): void {
  for (const group of groups) {
    applyReservedKeepProofs(
      state,
      mintUrl,
      group.selectedRows,
      group.split,
      group.asset,
      reservationId,
      now,
    )
  }
}

function applyReservedLockProofs(
  state: DaemonState,
  mintUrl: string,
  split: ReservedExactProofs,
  asset: OutcomeAsset,
  reservationId: string,
  now: string,
): void {
  if (!split.wasSplit) return

  removeProofsBySecret(state, mintUrl, split.spentProofs)
  addProofs(
    state,
    mintUrl,
    split.exactProofs,
    'reserved',
    asset,
    now,
    reservationId,
  )
  addProofs(
    state,
    mintUrl,
    split.changeProofs,
    'reserved',
    asset,
    now,
    reservationId,
  )
}

function applyReservedLockProofGroups(
  state: DaemonState,
  mintUrl: string,
  groups: ReservedExactProofGroup[],
  reservationId: string,
  now: string,
): void {
  for (const group of groups) {
    applyReservedLockProofs(
      state,
      mintUrl,
      group.split,
      group.asset,
      reservationId,
      now,
    )
  }
}

function addProofs(
  state: DaemonState,
  mintUrl: string,
  proofs: CashuProofRecord[],
  proofState: StoredProofRecord['state'],
  asset: StoredProofRecord['asset'],
  now: string,
  reservedBy?: string,
): void {
  const existingSecrets = new Set(
    state.wallet.proofs
      .filter((record) => record.mintUrl === mintUrl)
      .map((record) => record.proof.secret),
  )
  for (const proof of proofs) {
    if (existingSecrets.has(proof.secret)) continue
    existingSecrets.add(proof.secret)
    state.wallet.proofs.push({
      proof,
      mintUrl,
      asset,
      state: proofState,
      reservedBy,
      createdAt: now,
      updatedAt: now,
    })
  }
}

function addOutcomeProofsByCollection(
  state: DaemonState,
  mintUrl: string,
  proofsByCollection: Record<string, CashuProofRecord[]>,
  collections: string[],
  proofState: StoredProofRecord['state'],
  conditionId: string,
  now: string,
  reservedBy?: string,
): void {
  for (const collection of collections) {
    addProofs(
      state,
      mintUrl,
      proofsByCollection[collection] ?? [],
      proofState,
      { kind: 'Outcome', conditionId, outcomeSetId: collection },
      now,
      reservedBy,
    )
  }
}

function addOutcomeProofsByKeyset(
  state: DaemonState,
  mintUrl: string,
  proofs: CashuProofRecord[],
  proofState: StoredProofRecord['state'],
  conditionId: string,
  collectionByKeyset: Map<string, string>,
  now: string,
  reservedBy?: string,
): void {
  const byCollection = new Map<string, CashuProofRecord[]>()
  for (const proof of proofs) {
    if (!proof.id) throw new Error('Outcome proof is missing keyset id')
    const collection = collectionByKeyset.get(proof.id)
    if (!collection) {
      throw new Error(`No outcome collection metadata for keyset ${proof.id}`)
    }
    byCollection.set(collection, [...(byCollection.get(collection) ?? []), proof])
  }
  for (const [collection, collectionProofs] of byCollection) {
    addProofs(
      state,
      mintUrl,
      collectionProofs,
      proofState,
      { kind: 'Outcome', conditionId, outcomeSetId: collection },
      now,
      reservedBy,
    )
  }
}

function addRefundedProofsByKeyset(
  state: DaemonState,
  mintUrl: string,
  proofs: CashuProofRecord[],
  outcomeByKeyset: PartialLockHeldRecord['outcomeByKeyset'],
  now: string,
): void {
  const byAsset = new Map<string, {
    asset: StoredProofRecord['asset']
    proofs: CashuProofRecord[]
  }>()
  for (const proof of proofs) {
    const metadata = proof.id ? outcomeByKeyset[proof.id] : undefined
    if (!metadata) {
      throw new Error(`No locked-proof asset metadata for keyset ${proof.id ?? '<missing>'}`)
    }
    const asset: StoredProofRecord['asset'] = {
      kind: 'Outcome',
      conditionId: metadata.conditionId,
      outcomeSetId: metadata.outcomeCollection,
    }
    const key = JSON.stringify(asset)
    const group = byAsset.get(key) ?? { asset, proofs: [] }
    group.proofs.push(proof)
    byAsset.set(key, group)
  }
  for (const group of byAsset.values()) {
    addProofs(state, mintUrl, group.proofs, 'available', group.asset, now)
  }
}

function removeProofsBySecret(
  state: DaemonState,
  mintUrl: string,
  proofs: CashuProofRecord[],
): void {
  const secrets = new Set(proofs.map((proof) => proof.secret))
  if (secrets.size === 0) return
  state.wallet.proofs = state.wallet.proofs.filter(
    (row) => row.mintUrl !== mintUrl || !secrets.has(row.proof.secret),
  )
}

function sumProofRows(rows: StoredProofRecord[]): number {
  return rows.reduce((sum, row) => sum + amountToNumber(row.proof.amount), 0)
}

function releaseReservedProofs(
  state: DaemonState,
  proofs: StoredProofRecord[],
  now: string,
): void {
  const keys = new Set(proofs.map((proof) => proofKey(proof.proof)))
  for (const row of state.wallet.proofs) {
    if (!keys.has(proofKey(row.proof))) continue
    row.state = 'available'
    delete row.reservedBy
    row.updatedAt = now
  }
}

function outcomeAssetForMarket(
  marketId: string | undefined,
): OutcomeAsset | null {
  if (!marketId) return null
  const dash = marketId.indexOf('-')
  if (dash <= 0 || dash >= marketId.length - 1) return null
  return {
    kind: 'Outcome',
    conditionId: marketId.slice(0, dash),
    outcomeSetId: marketId.slice(dash + 1),
  }
}

function resolveMintSellerSplit(
  swap: LocalSwapRecord,
): MintSellerSplit | null {
  if (swap.role !== 'seller' || swap.settlementKind !== 'Mint') {
    return null
  }
  if (!swap.sellerKeepOutcomeSetId || !swap.sellerLockOutcomeSetId) {
    throw new Error('mint seller trade is missing outcome-set metadata')
  }
  const market = outcomeAssetForMarket(swap.marketId)
  if (!market) {
    throw new Error(`invalid market id for mint seller trade: ${swap.marketId ?? '<missing>'}`)
  }
  if (
    market.outcomeSetId !== swap.sellerKeepOutcomeSetId &&
    market.outcomeSetId !== swap.sellerLockOutcomeSetId
  ) {
    throw new Error(
      `mint seller market ${swap.marketId} does not match settlement outcome metadata`,
    )
  }
  if (swap.sellerKeepOutcomeSetId === swap.sellerLockOutcomeSetId) {
    throw new Error('mint seller keep and lock outcome sets are identical')
  }
  return {
    conditionId: market.conditionId,
    keepOutcomeSetId: swap.sellerKeepOutcomeSetId,
    lockOutcomeSetId: swap.sellerLockOutcomeSetId,
  }
}

function resolvePreflightSplit(
  state: DaemonState | null,
  swap: LocalSwapRecord,
  split: MintSellerSplit,
): LocalOrderPreflightSplit | null {
  if (!swap.orderId) return null
  const preflight = state?.orders[swap.orderId]?.preflightSplit
  if (!preflight) return null
  if (
    preflight.conditionId !== split.conditionId ||
    preflight.keepOutcomeSetId !== split.keepOutcomeSetId ||
    preflight.lockOutcomeSetId !== split.lockOutcomeSetId
  ) {
    return null
  }
  return preflight
}

function requiredAmount(amount: number | undefined): number {
  if (
    typeof amount !== 'number' ||
    !Number.isSafeInteger(amount) ||
    amount <= 0
  ) {
    throw new Error('swap is missing a positive fill amount')
  }
  return amount
}

function isTerminal(swap: LocalSwapRecord): boolean {
  return ['confirmed', 'refunded', 'Failed'].includes(swap.step)
}

function proofWithOutcomeMetadata(row: StoredProofRecord): CashuProofRecord {
  if (row.asset.kind !== 'Outcome') return row.proof
  return {
    ...row.proof,
    conditionId: row.asset.conditionId,
    outcomeCollection: row.asset.outcomeSetId,
  } as CashuProofRecord
}

function proofWithAssetMetadata(
  proof: CashuProofRecord,
  asset: OutcomeAsset,
): CashuProofRecord {
  return {
    ...proof,
    conditionId: asset.conditionId,
    outcomeCollection: asset.outcomeSetId,
  } as CashuProofRecord
}

function keysetToOutcomeCollection(rows: StoredProofRecord[]): Map<string, string> {
  return keysetToOutcomeCollectionShared(rows, (row) => ({
    keysetId: row.proof.id,
    outcomeCollection: row.asset.kind === 'Outcome' ? row.asset.outcomeSetId : null,
  }))
}

function groupOutcomeProofRowsByCollection(
  rows: StoredProofRecord[],
): OutcomeProofRowGroup[] {
  const byCollection = new Map<string, StoredProofRecord[]>()
  for (const row of rows) {
    if (row.asset.kind !== 'Outcome') {
      throw new Error('Cannot lock non-outcome proofs as outcome inventory')
    }
    byCollection.set(row.asset.outcomeSetId, [
      ...(byCollection.get(row.asset.outcomeSetId) ?? []),
      row,
    ])
  }
  return [...byCollection.entries()].map(([outcomeSetId, groupRows]) => ({
    outcomeSetId,
    rows: groupRows,
  }))
}

async function loadRootCollectionByKeyset(
  mintUrl: string,
  conditionId: string,
): Promise<Map<string, string>> {
  const response = await fetch(`${mintUrl.replace(/\/+$/, '')}/v1/conditions/${conditionId}`)
  if (!response.ok) {
    throw new Error(`Failed to load condition ${conditionId} keysets: ${response.status}`)
  }
  const body = (await response.json()) as {
    condition?: {
      keysets?: Record<string, string>
      partitions?: Array<{ keysets?: Record<string, string> }>
    }
    keysets?: Record<string, string>
    partitions?: Array<{ keysets?: Record<string, string> }>
  }
  const result = new Map<string, string>()
  const condition = body.condition ?? body
  const keysets = {
    ...(condition.partitions ?? []).reduce<Record<string, string>>(
      (acc, partition) => ({ ...acc, ...(partition.keysets ?? {}) }),
      {},
    ),
    ...(condition.keysets ?? {}),
  }
  for (const [collection, keysetId] of Object.entries(keysets)) {
    if (!keysetId) continue
    const existing = result.get(keysetId)
    if (existing && existing !== collection) {
      throw new Error(`Keyset ${keysetId} maps to both ${existing} and ${collection}`)
    }
    result.set(keysetId, collection)
  }
  if (result.size === 0) {
    throw new Error(`Condition ${conditionId} did not include root outcome keysets`)
  }
  return result
}

function isRetryableSwapStepError(message: string): boolean {
  return (
    /Proof operation .+ is still pending at the mint/i.test(message) ||
    /Timed out waiting for seller to spend at mint/i.test(message)
  )
}

function proofKey(proof: CashuProofRecord): string {
  return `${proof.id ?? ''}:${proof.secret}:${proof.C}`
}

function swapFailureFromError(
  err: unknown,
): SwapFailure | PartialLockHeldRecord | null {
  if (!err || typeof err !== 'object') return null
  const maybe = err as { failure?: unknown }
  if (!maybe.failure || typeof maybe.failure !== 'object') return null
  const failure = maybe.failure as {
    kind?: unknown
    refundLocktime?: unknown
    affectedKeysets?: unknown
    detail?: unknown
    tradeId?: unknown
    outcomeByKeyset?: PartialLockHeldRecord['outcomeByKeyset']
    lockedProofs?: unknown
  }
  if (
    failure.kind === 'PartialLockHeld' &&
    typeof failure.refundLocktime === 'number'
  ) {
    return {
      kind: 'PartialLockHeld',
      tradeId: typeof failure.tradeId === 'string' ? failure.tradeId : '',
      refundLocktime: failure.refundLocktime,
      affectedKeysets: Array.isArray(failure.affectedKeysets)
        ? failure.affectedKeysets.filter((value): value is string => typeof value === 'string')
        : [],
      detail: typeof failure.detail === 'string'
        ? failure.detail
        : errorMessage(err),
      outcomeByKeyset: failure.outcomeByKeyset ?? {},
      lockedProofs: Array.isArray(failure.lockedProofs)
        ? failure.lockedProofs.filter(isProofWithKeyset)
        : [],
    }
  }
  if (
    failure.kind === 'InsufficientInventory' ||
    failure.kind === 'MintError' ||
    failure.kind === 'EngineRejected'
  ) {
    return {
      kind: failure.kind,
      detail: typeof failure.detail === 'string'
        ? failure.detail
        : errorMessage(err),
    }
  }
  return null
}

function outcomeByKeysetForPartialLock(
  failure: SwapFailure | PartialLockHeldRecord,
  lockedRows: StoredProofRecord[],
): PartialLockHeldRecord['outcomeByKeyset'] {
  const canonical = failure as Partial<PartialLockHeldRecord>
  if (Object.keys(canonical.outcomeByKeyset ?? {}).length > 0) {
    return canonical.outcomeByKeyset ?? {}
  }
  const outcomeByKeyset: PartialLockHeldRecord['outcomeByKeyset'] = {}
  for (const row of lockedRows) {
    if (!row.proof.id || row.asset.kind !== 'Outcome') continue
    outcomeByKeyset[row.proof.id] = {
      conditionId: row.asset.conditionId,
      outcomeCollection: row.asset.outcomeSetId,
      marketId: `${row.asset.conditionId}-${row.asset.outcomeSetId}`,
    }
  }
  return outcomeByKeyset
}

function partialLockRecordFromParts(
  tradeId: string,
  conditionId: string,
  collectionByKeyset: Map<string, string>,
  err: unknown,
  partial: NonNullable<ReturnType<typeof partialLockFromError>>,
): PartialLockHeldRecord {
  const baseFailure = (err as { failure?: Partial<PartialLockHeldRecord> } | null)
    ?.failure
  const failureAffectedKeysets = Array.isArray(baseFailure?.affectedKeysets)
    ? baseFailure.affectedKeysets.filter((value): value is string => typeof value === 'string')
    : []
  const lockedKeysets = partial.lockedProofs
    .map((proof) => proof.id)
    .filter((value): value is string => typeof value === 'string')
  const affectedKeysets =
    failureAffectedKeysets.length > 0 &&
    failureAffectedKeysets.every((keysetId) => collectionByKeyset.has(keysetId))
      ? failureAffectedKeysets
      : lockedKeysets.length > 0
        ? [...new Set(lockedKeysets)]
        : [...collectionByKeyset.keys()]
  const outcomeByKeyset: Record<string, OutcomeMetadata> = {}
  for (const keysetId of affectedKeysets) {
    const collection = collectionByKeyset.get(keysetId)
    if (!collection) {
      throw new Error(`No outcome collection metadata for keyset ${keysetId}`)
    }
    outcomeByKeyset[keysetId] = {
      conditionId,
      outcomeCollection: collection,
      marketId: `${conditionId}-${collection}`,
    }
  }
  return {
    kind: 'PartialLockHeld',
    tradeId,
    refundLocktime:
      typeof baseFailure?.refundLocktime === 'number'
        ? baseFailure.refundLocktime
        : 0,
    affectedKeysets,
    detail:
      typeof baseFailure?.detail === 'string'
        ? baseFailure.detail
        : errorMessage(err),
    outcomeByKeyset,
    lockedProofs: partial.lockedProofs.filter(isProofWithKeyset),
  }
}

function partialLockFromError(err: unknown): {
  spentProofs: CashuProofRecord[]
  lockedProofs: CashuProofRecord[]
  changeProofs: CashuProofRecord[]
} | null {
  if (!err || typeof err !== 'object') return null
  const maybe = err as { partialLock?: unknown }
  if (!maybe.partialLock || typeof maybe.partialLock !== 'object') return null
  const partial = maybe.partialLock as {
    spentProofs?: unknown
    lockedProofs?: unknown
    changeProofs?: unknown
  }
  if (!Array.isArray(partial.spentProofs) || !Array.isArray(partial.lockedProofs)) {
    return null
  }
  return {
    spentProofs: partial.spentProofs.filter(isCashuProofRecord),
    lockedProofs: partial.lockedProofs.filter(isCashuProofRecord),
    changeProofs: Array.isArray(partial.changeProofs)
      ? partial.changeProofs.filter(isCashuProofRecord)
      : [],
  }
}

function isCashuProofRecord(value: unknown): value is CashuProofRecord {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { secret?: unknown }).secret === 'string' &&
    typeof (value as { C?: unknown }).C === 'string'
  )
}

function isProofWithKeyset(value: unknown): value is CashuProofRecord & { id: string } {
  return isCashuProofRecord(value) && typeof value.id === 'string'
}

function isAlreadySpentError(message: string): boolean {
  return /already\s+spent|proofs?\s+spent|state.*spent/i.test(message)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function unsupportedSwapOps(): DaemonSwapOps {
  const unsupported = async (): Promise<never> => {
    throw new Error('daemon swap protocol adapter is not configured')
  }
  return {
    splitProofsForExactSend: unsupported,
    sellerOpen: unsupported,
    sellerOpenPrelocked: unsupported,
    sellerLockOutcomeProofs: unsupported,
    sellerOpenMint: unsupported,
    buyerRespond: unsupported,
    sellerClaim: unsupported,
    buyerClaim: unsupported,
    refundLockedProofs: unsupported,
  }
}
