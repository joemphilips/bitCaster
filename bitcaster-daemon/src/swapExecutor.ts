import {
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
import {
  validateDurableTradeSession,
  validateDurableProofOperationLink,
  type DurableProofOperationState,
  type DurableTradeProofOperationLink,
} from '@bitcaster-market/client-sdk/durableTradeRecovery'
import {
  defaultCollateralUnit,
  normalizeMarketBaseAsset,
} from '@bitcaster-market/client-sdk/marketUnits'
import type { DaemonProfile } from './profile.ts'
import { readProfile } from './profile.ts'
import {
  readIdentitySecrets as readSecrets,
  readOrderEphemeralSecret,
} from './secrets.ts'
import type { TradeRuntimeConnection } from './tradeRuntime.ts'
import {
  resolveCtfConsolidationInputFees,
  splitAvailableSatProofsForCtfCollateral,
  type WalletOpsDependencies,
} from './walletOps.ts'
import { resolveRootDirectLockOutputAmountSats } from '@bitcaster-market/client-sdk/ctfSplit'
import {
  type CashuProofRecord,
  type DaemonState,
  type LocalSwapRecord,
  type StoredProofRecord,
  getProofOperation,
  normalizeCashuProofRecord,
  readReconciledTradeLockedOutputs,
  readStateScope,
  readReconciledTradeWalletInputs,
  journalOutboundSwapCipher,
  updateState,
} from './state.ts'
import {
  DAEMON_WALLET_PROOF_CANDIDATE_LIMIT_MAX,
  deriveDaemonWalletProofIdFromProof,
  type DaemonWalletProofSelector,
} from './stateSqlite.ts'
import { validateDaemonTradeAuthorityBinding } from './durableTradeBinding.ts'
import {
  durableOrderCollateralPinId,
  requireDaemonOrderCollateralCoordinator,
} from './durableOrderCollateralCoordinator.ts'
import { createDaemonTradeCtfProofOperationStore } from './swapProtocolAdapter.ts'

type OutcomeAsset = Extract<StoredProofRecord['asset'], { kind: 'Outcome' }>
type CollateralProofRecord = Pick<
  StoredProofRecord,
  'proof' | 'mintUrl' | 'unit' | 'asset'
>
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
  orderCollateralPinId?: string
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

interface OutcomeProofRowGroup {
  outcomeSetId: string
  rows: StoredProofRecord[]
}

interface LockedOutcomeProofGroups {
  lockedProofs: CashuProofRecord[]
  changeProofs: CashuProofRecord[]
  collectionByKeyset: Map<string, string>
  operationKeys: string[]
}

export interface LockedOutcomeProofResult {
  lockedProofs: CashuProofRecord[]
  changeProofs: CashuProofRecord[]
}

export interface DaemonSwapOps {
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
  /** Routes retry work back through the daemon recovery owner when configured. */
  scheduleRecovery?: (tradeId: string) => void
}

export class DaemonSwapExecutor {
  private readonly connection: TradeRuntimeConnection
  private readonly ops: DaemonSwapOps
  private readonly walletOpsDeps: WalletOpsDependencies
  private readonly inFlight = new Set<string>()
  private readonly retryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >()
  private readonly retryAttempts = new Map<string, number>()
  private readonly retryDelayMs: number
  private readonly maxRetryAttempts: number
  private readonly scheduleRecovery?: (tradeId: string) => void

  constructor(options: DaemonSwapExecutorOptions) {
    this.connection = options.connection
    this.ops = options.ops ?? unsupportedSwapOps()
    this.walletOpsDeps = options.walletOpsDeps ?? {}
    this.retryDelayMs =
      options.retryDelayMs ?? RETRYABLE_SWAP_STEP_RETRY_DELAY_MS
    this.maxRetryAttempts =
      options.maxRetryAttempts ?? RETRYABLE_SWAP_STEP_MAX_ATTEMPTS
    this.scheduleRecovery = options.scheduleRecovery
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
    const durableOperationsByTrade = groupDurableOperationsByTrade(state)
    const swaps = Object.values(state.swaps)
      .filter(
        (swap) =>
          !isTerminal(swap) &&
          canResumeAfterDurableRecovery(
            state,
            swap,
            durableOperationsByTrade.get(swap.tradeId) ?? [],
          ) &&
          hasValidDurableSession(state, swap.tradeId),
      )
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
      .filter(
        (swap) =>
        hasValidDurableSession(state, swap.tradeId) &&
        swap.failure?.kind === 'PartialLockHeld' &&
        typeof swap.failure.refundLocktime === 'number' &&
          swap.failure.refundLocktime + PARTIAL_LOCK_REFUND_MARGIN_SECS <=
            nowSecs,
      )
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
    if (!swap.failure || swap.failure.kind !== 'PartialLockHeld') return
    if (!('lockedProofs' in swap.failure)) {
      throw new Error('partial lock refund has no reconciled output authority')
    }
    const failure = swap.failure
    const lockedRows = await readReconciledTradeLockedOutputs(
      tradeId,
      failure.lockedProofs.map((proof) =>
        normalizeCashuProofRecord(proof as CashuProofRecord),
      ),
    )

    try {
      const fresh = await this.ops.refundLockedProofs(
        ctx,
        lockedRows.map((row) => row.proof),
        `${tradeId}:partial-lock-refund`,
      )
      await updateState(
        {
          walletProofs: exactWalletProofSelectors(
            profile.mintUrl,
            [...lockedRows.map((row) => row.proof), ...fresh],
            swap.baseAsset,
          ),
          swapIds: [tradeId],
        },
        (state, now) => {
        const live = state.swaps[tradeId]
        if (!live) return
          removeProofsBySecret(
            state,
            profile.mintUrl,
            lockedRows.map((row) => row.proof),
          )
        addRefundedProofsByKeyset(
          state,
          profile.mintUrl,
          fresh,
          outcomeByKeysetForPartialLock(failure, lockedRows),
            swap.baseAsset,
          now,
        )
        live.step = 'refunded'
        live.updatedAt = now
        },
      )
    } catch (err) {
      if (isAlreadySpentError(errorMessage(err))) {
        await this.markPartialLockAlreadySpent(
          tradeId,
          profile.mintUrl,
          lockedRows.map((row) => row.proof),
          swap.baseAsset,
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
      await this.runOnce(tradeId, 'buyer-claim', () => this.buyerClaim(tradeId))
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
      const asset = outcomeAssetForMarket(swap.marketId, swap.baseAsset)
      if (!asset) {
        throw new Error(
          `invalid market id for seller inventory: ${swap.marketId ?? '<missing>'}`,
        )
      }
      const retained = await readReconciledTradeWalletInputs(
        tradeId,
        `${tradeId}/seller-lock`,
      )
      const selected = retained?.rows ?? await this.selectSellerOutcomeProofs({
        ctx,
        mintUrl: profile.mintUrl,
        asset,
        amount,
      })
      if (!selected) {
        throw new Error(
          `insufficient outcome proofs for seller open (${amount} sats)`,
        )
      }
      if (retained !== null) {
        await assertExactOutcomeInputs(
          retained.rows,
          profile.mintUrl,
          asset,
          amount,
          this.walletOpsDeps,
        )
      }
      await assertOrderCollateralProofs(ctx, selected)
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
      await this.commitOrderCollateralFill({
        ctx,
        swap,
        fillOrderAmount: amount,
        operationKeys: locked.operationKeys,
        replacementProofs: [
          ...outcomeCollateralRecordsByKeyset(
            profile.mintUrl,
            locked.changeProofs,
            asset.conditionId,
            locked.collectionByKeyset,
            swap.baseAsset,
          ),
          ...collateralProofRecords(
            profile.mintUrl,
            result.changeProofs,
            asset,
          ),
        ],
        stateScope: {
          walletProofs: exactWalletProofSelectors(
            profile.mintUrl,
            [
              ...selected.map((row) => row.proof),
              ...result.lockedProofs,
              ...result.changeProofs,
              ...locked.changeProofs,
            ],
            swap.baseAsset,
          ),
          swapIds: [tradeId],
        },
        applyState: (state, now) => {
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
            swap.baseAsset,
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
            swap.baseAsset,
            now,
          )
          addProofs(
            state,
            profile.mintUrl,
            result.changeProofs,
            'available',
            asset,
          now,
        )
        live.messages = {
          ...live.messages,
          adaptorPoint: result.adaptorPointCipher,
          lockedProofsSeller: result.lockedProofsCipher,
        }
        live.sellerAdaptorSecretHex = result.adaptorSecretHex
        live.sellerAdaptorPointHex = result.adaptorPointHex
        live.step = 'seller-opened'
        live.updatedAt = now
        },
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

  private async selectSellerOutcomeProofs(input: {
    ctx: DaemonSwapContext
    mintUrl: string
    asset: OutcomeAsset
    amount: number
  }): Promise<StoredProofRecord[] | null> {
    const state = await readCollateralState(
      input.ctx.orderCollateralPinId,
      availableOutcomeProofSelectors(
        input.mintUrl,
        input.asset.conditionId,
        input.asset.outcomeSetId,
        input.ctx.baseAsset,
      ),
    )
    const args = [
      state,
      input.mintUrl,
      input.asset.conditionId,
      input.asset.outcomeSetId,
      input.amount,
      this.walletOpsDeps,
      input.ctx.baseAsset,
    ] as const
    return input.ctx.orderCollateralPinId
      ? selectPinnedProofsForOutcomeSet(...args)
      : selectOutcomeProofsForOutcomeSet(...args)
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
    const operationKeys: string[] = []

    for (const group of groups) {
      try {
        const operationKey = daemonTradeOperationKey(
          input.tradeId,
          input.operationStep,
          groups.length === 1 ? undefined : group.outcomeSetId,
        )
        const locked = await this.ops.sellerLockOutcomeProofs(
          input.ctx,
          group.rows.map(proofWithOutcomeMetadata),
          input.amount,
          operationKey,
        )
        operationKeys.push(operationKey)
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
            input.ctx.baseAsset,
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
      operationKeys,
    }
  }

  private async persistPartialLockParts(
    tradeId: string,
    mintUrl: string,
    conditionId: string,
    baseAsset: string | null | undefined,
    collectionByKeyset: Map<string, string>,
    err: unknown,
    partial: NonNullable<ReturnType<typeof partialLockFromError>>,
  ): Promise<void> {
    await updateState(
      {
        walletProofs: exactWalletProofSelectors(
          mintUrl,
          [
            ...partial.spentProofs,
            ...partial.lockedProofs,
            ...partial.changeProofs,
          ],
          baseAsset,
        ),
        swapIds: [tradeId],
      },
      (state, now) => {
      removeProofsBySecret(state, mintUrl, partial.spentProofs)
      addOutcomeProofsByKeyset(
        state,
        mintUrl,
        partial.lockedProofs,
        'locked',
        conditionId,
        collectionByKeyset,
          baseAsset,
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
          baseAsset,
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
      },
    )
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
    const collateralState = await readCollateralState(
      ctx.orderCollateralPinId,
      availableOutcomeProofSelectors(
        mintUrl,
        split.conditionId,
        split.lockOutcomeSetId,
        swap.baseAsset,
      ),
    )
    const availableOutcome = ctx.orderCollateralPinId
      ? await selectPinnedProofsForOutcomeSet(
          collateralState,
          mintUrl,
          split.conditionId,
          split.lockOutcomeSetId,
          amount,
          this.walletOpsDeps,
          swap.baseAsset,
        )
      : await selectOutcomeProofsForOutcomeSet(
          collateralState,
          mintUrl,
          split.conditionId,
          split.lockOutcomeSetId,
          amount,
          this.walletOpsDeps,
          swap.baseAsset,
        )
    if (availableOutcome) {
      await assertOrderCollateralProofs(ctx, availableOutcome)
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
      await this.commitOrderCollateralFill({
        ctx,
        swap,
        fillOrderAmount: amount,
        operationKeys: locked.operationKeys,
        replacementProofs: outcomeCollateralRecordsByKeyset(
          mintUrl,
          locked.changeProofs,
          split.conditionId,
          locked.collectionByKeyset,
          swap.baseAsset,
        ),
        stateScope: {
          walletProofs: exactWalletProofSelectors(
            mintUrl,
            [
              ...availableOutcome.map((row) => row.proof),
              ...result.lockedProofs,
              ...locked.changeProofs,
            ],
            swap.baseAsset,
          ),
          swapIds: [tradeId],
        },
        applyState: (state, now) => {
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
            swap.baseAsset,
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
            swap.baseAsset,
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
        },
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

    if (ctx.orderCollateralPinId !== undefined) {
      throw new Error('pinned seller collateral cannot select fresh proofs')
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
    const regularSplitOperationId = `${tradeId}/seller-regular-ctf-input`
    const ctfSplitOperationId = `${tradeId}/seller-mint-ctf-split`
    const [regularSplit, ctfSplit] = await Promise.all([
      getProofOperation(regularSplitOperationId),
      getProofOperation(ctfSplitOperationId),
    ])
    const operationStore = createDaemonTradeCtfProofOperationStore(ctx)
    const collateral = regularSplit !== null || ctfSplit === null
      ? await splitAvailableSatProofsForCtfCollateral({
          amountSats: splitAmount,
          mintUrl,
          operationId: regularSplitOperationId,
          secrets,
          deps: this.walletOpsDeps,
          baseAsset,
          proofOperationStore: operationStore,
        })
      : await exactCtfSplitCollateral(
          tradeId,
          ctfSplitOperationId,
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
    await updateState(
      {
        walletProofs: exactWalletProofSelectors(
          mintUrl,
          [
            ...collateral.spent,
            ...result.spentSatProofs,
            ...collateral.keep,
            ...Object.values(result.proofsByCollection).flat(),
          ],
          baseAsset,
        ),
        swapIds: [tradeId],
      },
      (state, now) => {
      const live = state.swaps[tradeId]
      if (!live || isTerminal(live)) return
      removeProofsBySecret(state, mintUrl, [
        ...collateral.spent,
        ...result.spentSatProofs,
      ])
        addProofs(
          state,
          mintUrl,
          collateral.keep,
          'available',
          { kind: 'sats', baseAsset },
          now,
        )
      addOutcomeProofsByCollection(
        state,
        mintUrl,
        result.proofsByCollection,
        result.keepCollections,
        'available',
        split.conditionId,
          baseAsset,
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
      },
    )
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
      const amount = requiredAmount(
        swap.quotePaymentSubunits ??
          swap.quotePaymentSats ??
          swap.fillAmountSubunits ??
          swap.fillAmountSats,
      )
      const baseAsset = normalizeMarketBaseAsset(swap.baseAsset)
      const unit = defaultCollateralUnit(baseAsset)
      const retained = await readReconciledTradeWalletInputs(
        tradeId,
        `${tradeId}/buyer-lock`,
      )
      const selected = retained?.rows ?? await this.selectBuyerProofs({
        ctx,
        mintUrl: profile.mintUrl,
        unit,
        baseAsset,
        amount,
      })
      if (!selected) {
        throw new Error(
          `insufficient ${baseAsset} proofs for buyer response (${amount} sub-units)`,
        )
      }
      if (retained !== null) {
        await assertExactBaseInputs(
          retained.rows,
          profile.mintUrl,
          unit,
          baseAsset,
          amount,
          this.walletOpsDeps,
        )
      }
      await assertOrderCollateralProofs(ctx, selected)
      const result = await this.ops.buyerRespond(
        ctx,
        {
          adaptorPoint: swap.messages.adaptorPoint,
          lockedProofsSeller: swap.messages.lockedProofsSeller,
        },
        selected.map((row) => row.proof),
        amount,
      )
      await this.commitOrderCollateralFill({
        ctx,
        swap,
        fillOrderAmount: requiredAmount(
          swap.outcomeFaceAmountSubunits
            ?? swap.outcomeFaceAmountSats
            ?? swap.fillAmountSubunits
            ?? swap.fillAmountSats,
        ),
        operationKeys: [`${tradeId}/buyer-lock`],
        replacementProofs: collateralProofRecords(
          profile.mintUrl,
          result.changeProofs,
          { kind: 'sats', baseAsset },
        ),
        stateScope: {
          walletProofs: exactWalletProofSelectors(
            profile.mintUrl,
            [
              ...selected.map((row) => row.proof),
              ...result.lockedProofs,
              ...result.changeProofs,
            ],
            swap.baseAsset,
          ),
          swapIds: [tradeId],
        },
        applyState: (state, now) => {
        const live = state.swaps[tradeId]
        if (!live || isTerminal(live)) return
        removeProofsBySecret(
          state,
          profile.mintUrl,
          selected.map((row) => row.proof),
        )
        addProofs(
          state,
          profile.mintUrl,
          result.lockedProofs,
          'locked',
          { kind: 'sats', baseAsset },
          now,
          tradeId,
        )
          addProofs(
            state,
            profile.mintUrl,
            result.changeProofs,
            'available',
            {
              kind: 'sats',
              baseAsset: normalizeMarketBaseAsset(swap.baseAsset),
            },
            now,
          )
        live.messages = {
          ...live.messages,
          lockedProofsBuyer: result.lockedProofsCipher,
        }
        live.buyerLockedProofs = result.lockedProofs
        live.buyerPreSigsHex = result.preSigsHex
        live.sellerPreSigsHex = result.sellerPreSigsHex
        live.step = 'buyer-responded'
        live.updatedAt = now
        },
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

  private async selectBuyerProofs(input: {
    ctx: DaemonSwapContext
    mintUrl: string
    unit: string
    baseAsset: string
    amount: number
  }): Promise<StoredProofRecord[] | null> {
    const state = await readCollateralState(input.ctx.orderCollateralPinId, [{
      mintUrl: input.mintUrl,
      unit: input.unit,
      state: 'available',
      assetKind: 'sats',
      baseAsset: input.baseAsset,
      candidateLimit: true,
    }])
    const predicate = (proof: StoredProofRecord) =>
      proof.asset.kind === 'sats'
      && proof.unit === input.unit
      && normalizeMarketBaseAsset(proof.asset.baseAsset) === input.baseAsset
    return input.ctx.orderCollateralPinId
      ? selectPinnedProofs(
          state,
          input.mintUrl,
          predicate,
          input.amount,
          this.walletOpsDeps,
        )
      : selectProofs(
          state,
          input.mintUrl,
          predicate,
          input.amount,
          this.walletOpsDeps,
        )
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
      await updateState(
        {
          walletProofs: exactWalletProofSelectors(
            profile.mintUrl,
            fresh,
            swap.baseAsset,
          ),
          swapIds: [tradeId],
        },
        (state, now) => {
        const live = state.swaps[tradeId]
        if (!live || isTerminal(live)) return
          addProofs(
            state,
            profile.mintUrl,
            fresh,
            'available',
            {
              kind: 'sats',
              baseAsset: normalizeMarketBaseAsset(swap.baseAsset),
            },
            now,
          )
        live.step = 'awaiting-confirmation'
        live.updatedAt = now
        },
      )
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
    const asset = outcomeAssetForMarket(swap.marketId, swap.baseAsset)
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
      const compoundOutcomeSet =
        parseOutcomeSetId(receivedAsset.outcomeSetId).length > 1
      const collectionByKeyset = compoundOutcomeSet
        ? await loadRootCollectionByKeyset(
            profile.mintUrl,
            receivedAsset.conditionId,
          )
        : null
      await updateState(
        {
          walletProofs: exactWalletProofSelectors(
            profile.mintUrl,
            fresh,
            swap.baseAsset,
          ),
          swapIds: [tradeId],
        },
        (state, now) => {
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
              swap.baseAsset,
            now,
          )
        } else {
            addProofs(
              state,
              profile.mintUrl,
              fresh,
              'available',
              {
                ...receivedAsset,
                baseAsset: normalizeMarketBaseAsset(swap.baseAsset),
              },
              now,
            )
        }
        live.step = 'awaiting-confirmation'
        live.updatedAt = now
        },
      )
      await this.sendSwapMessageResumable(
        tradeId,
        TRADE_MESSAGE_TYPES.settlementComplete,
        '',
      )
    } catch (err) {
      await this.handleSwapStepError(tradeId, err)
    }
  }

  private async commitOrderCollateralFill(input: {
    ctx: DaemonSwapContext
    swap: LocalSwapRecord
    fillOrderAmount: number
    operationKeys: readonly string[]
    releaseProofs?: readonly StoredProofRecord[]
    replacementProofs: readonly CollateralProofRecord[]
    stateScope: Parameters<typeof updateState>[0]
    applyState: (state: DaemonState, now: string) => void
  }): Promise<void> {
    const pinId = input.ctx.orderCollateralPinId
    if (pinId === undefined) {
      await updateState(input.stateScope, input.applyState)
      return
    }
    if (!input.swap.orderId) {
      throw new Error('order collateral trade has no engine order')
    }
    await requireDaemonOrderCollateralCoordinator().commitFill({
      pinId,
      orderId: input.swap.orderId,
      tradeId: input.swap.tradeId,
      fillOrderAmount: input.fillOrderAmount,
      operationKeys: input.operationKeys,
      releaseProofs: input.releaseProofs ?? [],
      replacementProofs: input.replacementProofs,
      stateScope: input.stateScope,
      applyState: input.applyState,
    })
  }

  private async loadContext(tradeId: string): Promise<{
    ctx: DaemonSwapContext
    swap: LocalSwapRecord
    profile: DaemonProfile
  } | null> {
    const [profile, state] = await Promise.all([
      readProfile(),
      readStateScope({
        swapIds: [tradeId],
        tradeIds: [tradeId],
        orderIdsFromSwapIds: [tradeId],
      }),
    ])
    const swap = state?.swaps[tradeId]
    const session = state?.durableTradeSessions[tradeId]
    if (
      !profile ||
      !swap ||
      !session ||
      !swap.role ||
      !swap.orderId ||
      validateDurableTradeSession(session) !== null
    )
      return null
    if (
      !swap.counterpartyPubkey ||
      swap.sellerLocktime === undefined ||
      swap.buyerLocktime === undefined
    ) {
      return null
    }
    const keyId = session.ephemeralKeyHandle.keyId
    const key = await readOrderEphemeralSecret(keyId)
    if (!key) return null
    const bindingError = validateDaemonTradeAuthorityBinding({
      tradeId,
      session,
      swap,
      retainedKeyId: keyId,
      retainedKey: key,
      profileMintUrl: profile.mintUrl,
    })
    if (bindingError) {
      // Binding failures retain the durable session for operator-visible repair.
      // Never terminalize or perform a custody effect with guessed key material.
      return null
    }
    const order = state.orders[swap.orderId]
    const orderCollateralPinId = order?.timeInForce === 'GTC'
      && order.clientOrderId
      ? durableOrderCollateralPinId(order.clientOrderId)
      : undefined
    return {
      swap,
      profile,
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
        ...(orderCollateralPinId === undefined
          ? {}
          : { orderCollateralPinId }),
      },
    }
  }

  private async readSwap(tradeId: string): Promise<LocalSwapRecord | null> {
    return (
      (await readStateScope({ swapIds: [tradeId] }))?.swaps[tradeId] ?? null
    )
  }

  private async fail(tradeId: string, error: string): Promise<void> {
    await updateState({ swapIds: [tradeId] }, (state, now) => {
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
    await updateState({ swapIds: [tradeId] }, (state, now) => {
      const swap = state.swaps[tradeId]
      if (!swap || isTerminal(swap)) return
      swap.step = 'Failed'
      swap.error = failure.detail
      swap.failure = failure
      swap.updatedAt = now
    })
    console.warn('[swap.failure]', redactSwapFailureForTelemetry(failure))
  }

  private async markPartialLockAlreadySpent(
    tradeId: string,
    mintUrl: string,
    lockedProofs: CashuProofRecord[],
    baseAsset?: string | null,
  ): Promise<void> {
    await updateState(
      {
        walletProofs: exactWalletProofSelectors(
          mintUrl,
          lockedProofs,
          baseAsset,
        ),
        swapIds: [tradeId],
      },
      (state, now) => {
      const swap = state.swaps[tradeId]
      if (!swap) return
      removeProofsBySecret(state, mintUrl, lockedProofs)
      swap.step = 'refunded'
      swap.updatedAt = now
      },
    )
  }

  private async retryLater(tradeId: string, error: string): Promise<void> {
    await updateState({ swapIds: [tradeId] }, (state, now) => {
      const swap = state.swaps[tradeId]
      if (!swap || isTerminal(swap)) return
      swap.error = error
      swap.updatedAt = now
    })
    this.scheduleRetry(tradeId)
  }

  private scheduleRetry(tradeId: string): void {
    if (this.retryTimers.has(tradeId)) return
    const attempts = this.retryAttempts.get(tradeId) ?? 0
    if (attempts >= this.maxRetryAttempts) return
    this.retryAttempts.set(tradeId, attempts + 1)
    const timer = setTimeout(() => {
      this.retryTimers.delete(tradeId)
      if (this.scheduleRecovery) {
        this.scheduleRecovery(tradeId)
        return
      }
      void this.retryActiveSwap(tradeId).catch(() => undefined)
    }, this.retryDelayMs)
    timer.unref?.()
    this.retryTimers.set(tradeId, timer)
  }

  private async retryActiveSwap(tradeId: string): Promise<void> {
    const state = await readStateScope({ swapIds: [tradeId] })
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
    // A swap payload alone is never resend authority. Revalidate the complete
    // persisted custody binding before mutating the outbox or transport.
    if (!(await this.loadContext(tradeId))) return
    await journalOutboundSwapCipher(tradeId, messageType, ciphertext)
    try {
      await this.connection.sendSwapMessage(tradeId, messageType, ciphertext)
    } catch {
      // Protocol ciphertexts are persisted before send; restart/rejoin replay will retry.
    }
  }
}

function isDurableTradeRecoveryLinkInProgress(
  link: DurableTradeProofOperationLink,
): boolean {
  const validationError = validateDurableProofOperationLink(link)
  if (validationError) {
    throw new Error(`invalid durable trade recovery link: ${validationError}`)
  }
  return classifyDurableTradeRecoveryLinkState(link.state) === 'active'
}

function groupDurableOperationsByTrade(
  state: DaemonState,
): Map<string, DurableTradeProofOperationLink[]> {
  const grouped = new Map<string, DurableTradeProofOperationLink[]>()
  for (const operation of Object.values(state.proofOperations)) {
    const link = operation.durableTradeRecovery
    if (link === undefined) continue
    grouped.set(link.tradeId, [...(grouped.get(link.tradeId) ?? []), link])
  }
  return grouped
}

function canResumeAfterDurableRecovery(
  _state: DaemonState,
  _swap: LocalSwapRecord,
  links: readonly DurableTradeProofOperationLink[],
): boolean {
  if (links.some(isDurableTradeRecoveryLinkInProgress)) return false
  return true
}

function hasValidDurableSession(state: DaemonState, tradeId: string): boolean {
  const session = state.durableTradeSessions[tradeId]
  return session !== undefined && validateDurableTradeSession(session) === null
}

/** Every protected operation key stays inside the immutable trade namespace. */
function daemonTradeOperationKey(
  tradeId: string,
  step: string,
  outcomeSetId?: string,
): string {
  return outcomeSetId === undefined
    ? `${tradeId}/${step}`
    : `${tradeId}/${step}/${encodeURIComponent(outcomeSetId)}`
}

function classifyDurableTradeRecoveryLinkState(
  state: DurableProofOperationState,
): 'active' | 'inactive' {
  switch (state) {
    case 'prepared':
    case 'mint-submitted':
      return 'active'
    case 'reconciled':
      return 'inactive'
    default:
      return assertNever(state)
  }
}

function assertNever(value: never): never {
  throw new Error(
    `unhandled durable trade recovery link state: ${String(value)}`,
  )
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
  const boundedCandidates = candidates.slice(
    0,
    DAEMON_WALLET_PROOF_CANDIDATE_LIMIT_MAX,
  )
  const inputFeePpkByKeyset = await inputFeePpkByKeysetForRows(
    mintUrl,
    boundedCandidates,
    deps,
  )
  const selectedProofs = takeProofsForLock(
    boundedCandidates.map((row) => row.proof),
    amount,
    inputFeePpkByKeyset,
  )
  if (!selectedProofs) {
    if (candidates.length > DAEMON_WALLET_PROOF_CANDIDATE_LIMIT_MAX) {
      throw new Error(
        'available proof selection exceeds the durable input limit',
      )
    }
    return null
  }
  const selectedKeys = new Set(selectedProofs.map(proofKey))
  return boundedCandidates.filter((row) =>
    selectedKeys.has(proofKey(row.proof)),
  )
}

async function assertExactBaseInputs(
  rows: readonly StoredProofRecord[],
  mintUrl: string,
  unit: string,
  baseAsset: string,
  amount: number,
  deps: WalletOpsDependencies,
): Promise<void> {
  if (rows.some((row) =>
    row.mintUrl !== mintUrl
    || row.unit !== unit
    || row.asset.kind !== 'sats'
    || normalizeMarketBaseAsset(row.asset.baseAsset) !== baseAsset)) {
    throw new Error('reconciled buyer lock has foreign wallet inputs')
  }
  await assertExactRowsCover(rows, mintUrl, amount, deps)
}

async function assertExactOutcomeInputs(
  rows: readonly StoredProofRecord[],
  mintUrl: string,
  asset: OutcomeAsset,
  amount: number,
  deps: WalletOpsDependencies,
): Promise<void> {
  const validAsset = (row: StoredProofRecord) =>
    row.mintUrl === mintUrl
    && row.asset.kind === 'Outcome'
    && row.asset.conditionId === asset.conditionId
    && normalizeMarketBaseAsset(row.asset.baseAsset) === asset.baseAsset
  if (rows.some((row) => !validAsset(row))) {
    throw new Error('reconciled seller lock has foreign wallet inputs')
  }
  const exact = rows.filter((row) =>
    row.asset.kind === 'Outcome'
    && row.asset.outcomeSetId === asset.outcomeSetId)
  if (exact.length === rows.length) {
    await assertExactRowsCover(exact, mintUrl, amount, deps)
    return
  }
  const collections = parseOutcomeSetId(asset.outcomeSetId)
  if (collections.length === 0 || rows.some((row) =>
    row.asset.kind !== 'Outcome'
    || !collections.includes(row.asset.outcomeSetId))) {
    throw new Error('reconciled seller lock outcome coverage is foreign')
  }
  for (const collection of collections) {
    const collectionRows = rows.filter((row) =>
      row.asset.kind === 'Outcome' && row.asset.outcomeSetId === collection)
    await assertExactRowsCover(collectionRows, mintUrl, amount, deps)
  }
}

async function assertExactRowsCover(
  rows: readonly StoredProofRecord[],
  mintUrl: string,
  amount: number,
  deps: WalletOpsDependencies,
): Promise<void> {
  if (rows.length === 0) throw new Error('reconciled trade wallet inputs are empty')
  const fees = await inputFeePpkByKeysetForRows(mintUrl, [...rows], deps)
  if (takeProofsForLock(rows.map((row) => row.proof), amount, fees) === null) {
    throw new Error('reconciled trade wallet inputs are insufficient')
  }
}

async function exactCtfSplitCollateral(
  tradeId: string,
  operationId: string,
) {
  const retained = await readReconciledTradeWalletInputs(tradeId, operationId)
  if (retained === null
    || retained.operationKeys.length !== 1
    || retained.operationKeys[0] !== operationId) {
    throw new Error('reconciled CTF split has no exact wallet input authority')
  }
  return {
    inputs: retained.rows.map((row) => structuredClone(row.proof)),
    spent: [],
    keep: [],
  }
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

async function selectPinnedProofs(
  state: DaemonState | null,
  mintUrl: string,
  predicate: (proof: StoredProofRecord) => boolean,
  amount: number,
  deps: WalletOpsDependencies = {},
): Promise<StoredProofRecord[] | null> {
  const candidates = (state?.wallet.proofs ?? []).filter(
    (proof) =>
      proof.mintUrl === mintUrl &&
      proof.state === 'reserved' &&
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

async function selectPinnedProofsForOutcomeSet(
  state: DaemonState | null,
  mintUrl: string,
  conditionId: string,
  outcomeSetId: string,
  amount: number,
  deps: WalletOpsDependencies = {},
  baseAssetInput?: string | null,
): Promise<StoredProofRecord[] | null> {
  const baseAsset = normalizeMarketBaseAsset(baseAssetInput)
  const select = (selectedOutcomeSetId: string) => selectPinnedProofs(
    state,
    mintUrl,
    (proof) =>
      proof.asset.kind === 'Outcome' &&
      proof.asset.conditionId === conditionId &&
      proof.asset.outcomeSetId === selectedOutcomeSetId &&
      normalizeMarketBaseAsset(proof.asset.baseAsset) === baseAsset,
    amount,
    deps,
  )
  const exact = await select(outcomeSetId)
  if (exact) return exact

  const selected: StoredProofRecord[] = []
  for (const outcomeCollection of parseOutcomeSetId(outcomeSetId)) {
    const leg = await select(outcomeCollection)
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

function addProofs(
  state: DaemonState,
  mintUrl: string,
  proofs: CashuProofRecord[],
  proofState: StoredProofRecord['state'],
  asset: StoredProofRecord['asset'],
  now: string,
  reservedBy?: string,
): void {
  const unit = defaultCollateralUnit(asset.baseAsset)
  for (const proof of proofs) {
    state.wallet.proofs.push({
      proof,
      mintUrl,
      unit,
      asset,
      state: proofState,
      reservedBy,
      createdAt: now,
      updatedAt: now,
    })
  }
}

function collateralProofRecords(
  mintUrl: string,
  proofs: readonly CashuProofRecord[],
  asset: StoredProofRecord['asset'],
): CollateralProofRecord[] {
  return proofs.map((proof) => ({
    proof,
    mintUrl,
    unit: defaultCollateralUnit(asset.baseAsset),
    asset,
  }))
}

function outcomeCollateralRecordsByKeyset(
  mintUrl: string,
  proofs: readonly CashuProofRecord[],
  conditionId: string,
  collectionByKeyset: ReadonlyMap<string, string>,
  baseAssetInput: string | null | undefined,
): CollateralProofRecord[] {
  const baseAsset = normalizeMarketBaseAsset(baseAssetInput)
  return proofs.map((proof) => {
    const outcomeSetId = proof.id
      ? collectionByKeyset.get(proof.id)
      : undefined
    if (outcomeSetId === undefined) {
      throw new Error('order collateral change has no outcome collection')
    }
    return {
      proof,
      mintUrl,
      unit: defaultCollateralUnit(baseAsset),
      asset: {
        kind: 'Outcome' as const,
        conditionId,
        outcomeSetId,
        baseAsset,
      },
    }
  })
}

function addOutcomeProofsByCollection(
  state: DaemonState,
  mintUrl: string,
  proofsByCollection: Record<string, CashuProofRecord[]>,
  collections: string[],
  proofState: StoredProofRecord['state'],
  conditionId: string,
  baseAsset: string | null | undefined,
  now: string,
  reservedBy?: string,
): void {
  const normalizedBaseAsset = normalizeMarketBaseAsset(baseAsset)
  for (const collection of collections) {
    addProofs(
      state,
      mintUrl,
      proofsByCollection[collection] ?? [],
      proofState,
      {
        kind: 'Outcome',
        conditionId,
        outcomeSetId: collection,
        baseAsset: normalizedBaseAsset,
      },
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
  baseAsset: string | null | undefined,
  now: string,
  reservedBy?: string,
): void {
  const normalizedBaseAsset = normalizeMarketBaseAsset(baseAsset)
  const byCollection = new Map<string, CashuProofRecord[]>()
  for (const proof of proofs) {
    if (!proof.id) throw new Error('Outcome proof is missing keyset id')
    const collection = collectionByKeyset.get(proof.id)
    if (!collection) {
      throw new Error(`No outcome collection metadata for keyset ${proof.id}`)
    }
    byCollection.set(collection, [
      ...(byCollection.get(collection) ?? []),
      proof,
    ])
  }
  for (const [collection, collectionProofs] of byCollection) {
    addProofs(
      state,
      mintUrl,
      collectionProofs,
      proofState,
      {
        kind: 'Outcome',
        conditionId,
        outcomeSetId: collection,
        baseAsset: normalizedBaseAsset,
      },
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
  baseAsset: string | null | undefined,
  now: string,
): void {
  const normalizedBaseAsset = normalizeMarketBaseAsset(baseAsset)
  const byAsset = new Map<
    string,
    {
    asset: StoredProofRecord['asset']
    proofs: CashuProofRecord[]
    }
  >()
  for (const proof of proofs) {
    const metadata = proof.id ? outcomeByKeyset[proof.id] : undefined
    if (!metadata) {
      throw new Error(
        `No locked-proof asset metadata for keyset ${proof.id ?? '<missing>'}`,
      )
    }
    const asset: StoredProofRecord['asset'] = {
      kind: 'Outcome',
      conditionId: metadata.conditionId,
      outcomeSetId: metadata.outcomeCollection,
      baseAsset: normalizedBaseAsset,
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

function exactWalletProofSelectors(
  mintUrl: string,
  proofs: readonly CashuProofRecord[],
  baseAssetInput: string | null | undefined,
): DaemonWalletProofSelector[] {
  const unit = defaultCollateralUnit(baseAssetInput)
  const proofIds = [
    ...new Set(
      proofs.map((proof) =>
        deriveDaemonWalletProofIdFromProof(mintUrl, unit, proof),
      ),
    ),
  ]
  return proofIds.length === 0 ? [] : [{ proofIds }]
}

function availableOutcomeProofSelectors(
  mintUrl: string,
  conditionId: string,
  outcomeSetId: string,
  baseAssetInput?: string | null,
): DaemonWalletProofSelector[] {
  const outcomeSetIds = new Set([
    outcomeSetId,
    ...parseOutcomeSetId(outcomeSetId),
  ])
  const baseAsset = normalizeMarketBaseAsset(baseAssetInput)
  const unit = defaultCollateralUnit(baseAsset)
  return [...outcomeSetIds].map((selectedOutcomeSetId) => ({
    mintUrl,
    unit,
    state: 'available' as const,
    assetKind: 'Outcome' as const,
    conditionId,
    outcomeSetId: selectedOutcomeSetId,
    baseAsset,
    candidateLimit: true,
  }))
}

async function readCollateralState(
  pinId: string | undefined,
  selectors: readonly DaemonWalletProofSelector[],
): Promise<DaemonState | null> {
  if (pinId === undefined) {
    return readStateScope({ walletProofs: selectors })
  }
  const proofIds = await requireDaemonOrderCollateralCoordinator()
    .readProofIds(pinId)
  if (proofIds.length === 0) {
    throw new Error('active order collateral pin has no proofs')
  }
  const pinnedSelectors = selectors.map((selector) => {
    const pinnedSelector: DaemonWalletProofSelector = {
      ...selector,
      proofIds,
      state: 'reserved',
    }
    delete pinnedSelector.reservedBy
    delete pinnedSelector.candidateLimit
    return pinnedSelector
  })
  return readStateScope({ walletProofs: pinnedSelectors })
}

async function assertOrderCollateralProofs(
  ctx: DaemonSwapContext,
  proofs: readonly StoredProofRecord[],
): Promise<void> {
  if (ctx.orderCollateralPinId === undefined) return
  await requireDaemonOrderCollateralCoordinator().assertOwnsProofs(
    ctx.orderCollateralPinId,
    proofs,
  )
}

function outcomeAssetForMarket(
  marketId: string | undefined,
  baseAssetInput?: string | null,
): OutcomeAsset | null {
  if (!marketId) return null
  const dash = marketId.indexOf('-')
  if (dash <= 0 || dash >= marketId.length - 1) return null
  return {
    kind: 'Outcome',
    conditionId: marketId.slice(0, dash),
    outcomeSetId: marketId.slice(dash + 1),
    baseAsset: normalizeMarketBaseAsset(baseAssetInput),
  }
}

function resolveMintSellerSplit(swap: LocalSwapRecord): MintSellerSplit | null {
  if (swap.role !== 'seller' || swap.settlementKind !== 'Mint') {
    return null
  }
  if (!swap.sellerKeepOutcomeSetId || !swap.sellerLockOutcomeSetId) {
    throw new Error('mint seller trade is missing outcome-set metadata')
  }
  const market = outcomeAssetForMarket(swap.marketId, swap.baseAsset)
  if (!market) {
    throw new Error(
      `invalid market id for mint seller trade: ${swap.marketId ?? '<missing>'}`,
    )
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

function keysetToOutcomeCollection(
  rows: StoredProofRecord[],
): Map<string, string> {
  return keysetToOutcomeCollectionShared(rows, (row) => ({
    keysetId: row.proof.id,
    outcomeCollection:
      row.asset.kind === 'Outcome' ? row.asset.outcomeSetId : null,
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
  const response = await fetch(
    `${mintUrl.replace(/\/+$/, '')}/v1/conditions/${conditionId}`,
  )
  if (!response.ok) {
    throw new Error(
      `Failed to load condition ${conditionId} keysets: ${response.status}`,
    )
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
      throw new Error(
        `Keyset ${keysetId} maps to both ${existing} and ${collection}`,
      )
    }
    result.set(keysetId, collection)
  }
  if (result.size === 0) {
    throw new Error(
      `Condition ${conditionId} did not include root outcome keysets`,
    )
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
        ? failure.affectedKeysets.filter(
            (value): value is string => typeof value === 'string',
          )
        : [],
      detail:
        typeof failure.detail === 'string' ? failure.detail : errorMessage(err),
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
      detail:
        typeof failure.detail === 'string' ? failure.detail : errorMessage(err),
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
  const baseFailure = (
    err as { failure?: Partial<PartialLockHeldRecord> } | null
  )?.failure
  const failureAffectedKeysets = Array.isArray(baseFailure?.affectedKeysets)
    ? baseFailure.affectedKeysets.filter(
        (value): value is string => typeof value === 'string',
      )
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
  if (
    !Array.isArray(partial.spentProofs) ||
    !Array.isArray(partial.lockedProofs)
  ) {
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

function isProofWithKeyset(
  value: unknown,
): value is CashuProofRecord & { id: string } {
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
