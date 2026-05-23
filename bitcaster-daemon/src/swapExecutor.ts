import { takeProofsForLock } from '../../bitcaster-client-sdk/src/proofSelection.ts'
import { TRADE_MESSAGE_TYPES } from '../../bitcaster-client-sdk/src/tradeSession.ts'
import type { DaemonProfile } from './profile.ts'
import { readProfile } from './profile.ts'
import type { DaemonSecrets } from './secrets.ts'
import { readSecrets } from './secrets.ts'
import type { TradeRuntimeConnection } from './tradeRuntime.ts'
import { splitAvailableSatProofsForCtfCollateral } from './walletOps.ts'
import {
  type CashuProofRecord,
  type DaemonState,
  type LocalOrderPreflightSplit,
  type LocalSwapRecord,
  type StoredProofRecord,
  readState,
  updateState,
} from './state.ts'

type OutcomeAsset = Extract<StoredProofRecord['asset'], { kind: 'outcome' }>

interface ComplementarySellerSplit {
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
}

export interface SellerOpenResult {
  adaptorPointCipher: string
  lockedProofsCipher: string
  adaptorSecretHex: string
  adaptorPointHex: string
  lockedProofs: CashuProofRecord[]
  changeProofs: CashuProofRecord[]
}

export interface SellerComplementaryOpenResult extends SellerOpenResult {
  spentSatProofs: CashuProofRecord[]
  keepProofs: CashuProofRecord[]
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
  sellerOpenComplementary(
    ctx: DaemonSwapContext,
    params: {
      conditionId: string
      keepOutcomeSetId: string
      lockOutcomeSetId: string
      amountSats: number
    },
    collateralProofs: CashuProofRecord[],
  ): Promise<SellerComplementaryOpenResult>
  buyerRespond(
    ctx: DaemonSwapContext,
    messages: { adaptorPoint: string; lockedProofsSeller: string },
    proofs: CashuProofRecord[],
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
}

export interface DaemonSwapExecutorOptions {
  connection: TradeRuntimeConnection
  ops?: DaemonSwapOps
}

export class DaemonSwapExecutor {
  private readonly connection: TradeRuntimeConnection
  private readonly ops: DaemonSwapOps
  private readonly inFlight = new Set<string>()

  constructor(options: DaemonSwapExecutorOptions) {
    this.connection = options.connection
    this.ops = options.ops ?? unsupportedSwapOps()
  }

  async onTradeCreated(swap: LocalSwapRecord | null): Promise<void> {
    if (!swap || swap.step === 'failed') return
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
    if (!swap || swap.step === 'failed') return
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
      const amount = requiredAmount(swap.outcomeFaceAmountSats ?? swap.fillAmountSats)
      const complementary = resolveComplementarySellerSplit(swap)
      if (complementary) {
        await this.sellerOpenComplementary(
          tradeId,
          ctx,
          swap,
          profile.mintUrl,
          complementary,
          amount,
        )
        return
      }
      const asset = outcomeAssetForMarket(swap.marketId)
      if (!asset) {
        throw new Error(`invalid market id for seller inventory: ${swap.marketId ?? '<missing>'}`)
      }
      const selected = selectProofs(
        await readState(),
        profile.mintUrl,
        (proof) =>
          proof.asset.kind === 'outcome' &&
          proof.asset.conditionId === asset.conditionId &&
          proof.asset.outcomeSetId === asset.outcomeSetId,
        amount,
      )
      if (!selected) {
        throw new Error(`insufficient outcome proofs for seller open (${amount} sats)`)
      }
      const locked = await this.ops.sellerLockOutcomeProofs(
        ctx,
        selected.map(proofWithOutcomeMetadata),
        amount,
        `${tradeId}:seller-lock`,
      )
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
        addProofs(
          state,
          profile.mintUrl,
          result.lockedProofs,
          'locked',
          asset,
          now,
          tradeId,
        )
        addProofs(
          state,
          profile.mintUrl,
          locked.changeProofs,
          'available',
          asset,
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
      await this.sendSwapMessageResumable(
        tradeId,
        TRADE_MESSAGE_TYPES.lockedProofsSeller,
        result.lockedProofsCipher,
      )
    } catch (err) {
      await this.handleSwapStepError(tradeId, err)
    }
  }

  private async sellerOpenComplementary(
    tradeId: string,
    ctx: DaemonSwapContext,
    swap: LocalSwapRecord,
    mintUrl: string,
    split: ComplementarySellerSplit,
    amount: number,
  ): Promise<void> {
    const preflight = resolvePreflightSplit(await readState(), swap, split)
    if (preflight) {
      await this.sellerOpenPreflightComplementary(
        tradeId,
        ctx,
        mintUrl,
        split,
        amount,
        preflight,
      )
      return
    }

    const availableOutcome = selectProofs(
      await readState(),
      mintUrl,
      (proof) =>
        proof.asset.kind === 'outcome' &&
        proof.asset.conditionId === split.conditionId &&
        proof.asset.outcomeSetId === split.lockOutcomeSetId,
      amount,
    )
    if (availableOutcome) {
      const locked = await this.ops.sellerLockOutcomeProofs(
        ctx,
        availableOutcome.map(proofWithOutcomeMetadata),
        amount,
        `${tradeId}:seller-inventory-lock`,
      )
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
        addProofs(
          state,
          mintUrl,
          result.lockedProofs,
          'locked',
          {
            kind: 'outcome',
            conditionId: split.conditionId,
            outcomeSetId: split.lockOutcomeSetId,
          },
          now,
          tradeId,
        )
        addProofs(
          state,
          mintUrl,
          locked.changeProofs,
          'available',
          {
            kind: 'outcome',
            conditionId: split.conditionId,
            outcomeSetId: split.lockOutcomeSetId,
          },
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
      await this.sendSwapMessageResumable(
        tradeId,
        TRADE_MESSAGE_TYPES.lockedProofsSeller,
        result.lockedProofsCipher,
      )
      return
    }

    const exactSatRows = selectProofs(
      await readState(),
      mintUrl,
      (proof) => proof.asset.kind === 'sats',
      amount,
    )
    const collateral =
      exactSatRows && sumProofRows(exactSatRows) === amount
        ? {
            inputs: exactSatRows.map((row) => row.proof),
            spent: [] as CashuProofRecord[],
            keep: [] as CashuProofRecord[],
          }
        : await (async () => {
            const secrets = await readSecrets()
            if (!secrets) throw new Error('daemon secrets are not initialized')
            return splitAvailableSatProofsForCtfCollateral(
              amount,
              mintUrl,
              `${tradeId}:seller-regular-ctf-input`,
              secrets,
            )
          })()
    const result = await this.ops.sellerOpenComplementary(
      ctx,
      {
        conditionId: split.conditionId,
        keepOutcomeSetId: split.keepOutcomeSetId,
        lockOutcomeSetId: split.lockOutcomeSetId,
        amountSats: amount,
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
      addProofs(state, mintUrl, collateral.keep, 'available', { kind: 'sats' }, now)
      addProofs(
        state,
        mintUrl,
        result.keepProofs,
        'available',
        {
          kind: 'outcome',
          conditionId: split.conditionId,
          outcomeSetId: result.resolvedKeepOutcomeSetId,
        },
        now,
      )
      addProofs(
        state,
        mintUrl,
        result.changeProofs,
        'available',
        {
          kind: 'outcome',
          conditionId: split.conditionId,
          outcomeSetId: result.resolvedLockOutcomeSetId,
        },
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
    await this.sendSwapMessageResumable(
      tradeId,
      TRADE_MESSAGE_TYPES.lockedProofsSeller,
      result.lockedProofsCipher,
    )
  }

  private async sellerOpenPreflightComplementary(
    tradeId: string,
    ctx: DaemonSwapContext,
    mintUrl: string,
    split: ComplementarySellerSplit,
    amount: number,
    preflight: LocalOrderPreflightSplit,
  ): Promise<void> {
    const state = await readState()
    const selectedLock = selectReservedProofs(
      state,
      mintUrl,
      preflight.reservationId,
      (proof) =>
        proof.asset.kind === 'outcome' &&
        proof.asset.conditionId === split.conditionId &&
        proof.asset.outcomeSetId === preflight.lockOutcomeSetId,
      amount,
    )
    if (!selectedLock) {
      throw new Error(
        `insufficient pre-flight lock proofs for complementary seller open (${amount} sats)`,
      )
    }
    const selectedKeep = selectReservedProofs(
      state,
      mintUrl,
      preflight.reservationId,
      (proof) =>
        proof.asset.kind === 'outcome' &&
        proof.asset.conditionId === split.conditionId &&
        proof.asset.outcomeSetId === preflight.keepOutcomeSetId,
      amount,
    )
    if (!selectedKeep) {
      throw new Error(
        `insufficient pre-flight keep proofs for complementary seller open (${amount} sats)`,
      )
    }

    const locked = await this.ops.sellerLockOutcomeProofs(
      ctx,
      selectedLock.map(proofWithOutcomeMetadata),
      amount,
      `${tradeId}:seller-preflight-lock`,
    )
    const keepProofs = await this.prepareReservedExactProofs(
      mintUrl,
      selectedKeep,
      amount,
      `${tradeId}:seller-preflight-keep-exact-v2`,
    )
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
        selectedLock.map((row) => row.proof),
      )
      addProofs(
        state,
        mintUrl,
        result.lockedProofs,
        'locked',
        {
          kind: 'outcome',
          conditionId: split.conditionId,
          outcomeSetId: preflight.lockOutcomeSetId,
        },
        now,
        tradeId,
      )
      applyReservedKeepProofs(
        state,
        mintUrl,
        selectedKeep,
        keepProofs,
        {
          kind: 'outcome',
          conditionId: split.conditionId,
          outcomeSetId: preflight.keepOutcomeSetId,
        },
        preflight.reservationId,
        now,
      )
      addProofs(
        state,
        mintUrl,
        locked.changeProofs,
        'reserved',
        {
          kind: 'outcome',
          conditionId: split.conditionId,
          outcomeSetId: preflight.lockOutcomeSetId,
        },
        now,
        preflight.reservationId,
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
      preserveSourceKeyset: selected.some((row) => row.asset.kind === 'outcome'),
      operationId,
    })
    return {
      exactProofs: split.sendProofs,
      spentProofs: split.spentProofs,
      changeProofs: split.changeProofs,
      wasSplit: true,
    }
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
      const amount = requiredAmount(swap.quotePaymentSats ?? swap.fillAmountSats)
      const selected = selectProofs(
        await readState(),
        profile.mintUrl,
        (proof) => proof.asset.kind === 'sats',
        amount,
      )
      if (!selected) {
        throw new Error(`insufficient sat proofs for buyer response (${amount} sats)`)
      }
      const result = await this.ops.buyerRespond(
        ctx,
        {
          adaptorPoint: swap.messages.adaptorPoint,
          lockedProofsSeller: swap.messages.lockedProofsSeller,
        },
        selected.map((row) => row.proof),
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
      await updateState((state, now) => {
        const live = state.swaps[tradeId]
        if (!live || isTerminal(live)) return
        addProofs(state, profile.mintUrl, fresh, 'available', asset, now)
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
    const [profile, secrets, state] = await Promise.all([
      readProfile(),
      readSecrets(),
      readState(),
    ])
    const swap = state?.swaps[tradeId]
    if (!profile || !secrets || !swap || !swap.role || !swap.orderId) return null
    const key = secrets.orderEphemeralKeys[swap.orderId]
    if (!key) {
      await this.fail(tradeId, `missing ephemeral key for order ${swap.orderId}`)
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
      swap.step = 'failed'
      swap.error = error
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
  }

  private async handleSwapStepError(
    tradeId: string,
    err: unknown,
  ): Promise<void> {
    const message = errorMessage(err)
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

function selectProofs(
  state: DaemonState | null,
  mintUrl: string,
  predicate: (proof: StoredProofRecord) => boolean,
  amount: number,
): StoredProofRecord[] | null {
  const candidates = (state?.wallet.proofs ?? []).filter(
    (proof) =>
      proof.mintUrl === mintUrl &&
      proof.state === 'available' &&
      predicate(proof),
  )
  const selectedProofs = takeProofsForLock(
    candidates.map((row) => row.proof),
    amount,
  )
  if (!selectedProofs) return null
  const selectedKeys = new Set(selectedProofs.map(proofKey))
  return candidates.filter((row) => selectedKeys.has(proofKey(row.proof)))
}

function selectReservedProofs(
  state: DaemonState | null,
  mintUrl: string,
  reservedBy: string,
  predicate: (proof: StoredProofRecord) => boolean,
  amount: number,
): StoredProofRecord[] | null {
  const candidates = (state?.wallet.proofs ?? []).filter(
    (proof) =>
      proof.mintUrl === mintUrl &&
      proof.state === 'reserved' &&
      proof.reservedBy === reservedBy &&
      predicate(proof),
  )
  const selectedProofs = takeProofsForLock(
    candidates.map((row) => row.proof),
    amount,
  )
  if (!selectedProofs) return null
  const selectedKeys = new Set(selectedProofs.map(proofKey))
  return candidates.filter((row) => selectedKeys.has(proofKey(row.proof)))
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

function addProofs(
  state: DaemonState,
  mintUrl: string,
  proofs: CashuProofRecord[],
  proofState: StoredProofRecord['state'],
  asset: StoredProofRecord['asset'],
  now: string,
  reservedBy?: string,
): void {
  for (const proof of proofs) {
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

function amountToNumber(amount: unknown): number {
  if (typeof amount === 'number') return amount
  if (typeof amount === 'bigint') return Number(amount)
  if (typeof amount === 'string') return Number(amount)
  if (
    amount &&
    typeof amount === 'object' &&
    'toNumber' in amount &&
    typeof amount.toNumber === 'function'
  ) {
    return Number(amount.toNumber())
  }
  if (amount && typeof amount === 'object' && 'value' in amount) {
    return amountToNumber((amount as { value: unknown }).value)
  }
  return Number(amount)
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
    kind: 'outcome',
    conditionId: marketId.slice(0, dash),
    outcomeSetId: marketId.slice(dash + 1),
  }
}

function resolveComplementarySellerSplit(
  swap: LocalSwapRecord,
): ComplementarySellerSplit | null {
  if (swap.role !== 'seller' || swap.settlementKind !== 'ComplementarySplit') {
    return null
  }
  if (!swap.sellerKeepOutcomeSetId || !swap.sellerLockOutcomeSetId) {
    throw new Error('complementary seller trade is missing outcome-set metadata')
  }
  const market = outcomeAssetForMarket(swap.marketId)
  if (!market) {
    throw new Error(`invalid market id for complementary seller trade: ${swap.marketId ?? '<missing>'}`)
  }
  if (
    market.outcomeSetId !== swap.sellerKeepOutcomeSetId &&
    market.outcomeSetId !== swap.sellerLockOutcomeSetId
  ) {
    throw new Error(
      `complementary seller market ${swap.marketId} does not match settlement outcome metadata`,
    )
  }
  if (swap.sellerKeepOutcomeSetId === swap.sellerLockOutcomeSetId) {
    throw new Error('complementary seller keep and lock outcome sets are identical')
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
  split: ComplementarySellerSplit,
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
  return ['confirmed', 'refunded', 'failed'].includes(swap.step)
}

function proofWithOutcomeMetadata(row: StoredProofRecord): CashuProofRecord {
  if (row.asset.kind !== 'outcome') return row.proof
  return {
    ...row.proof,
    conditionId: row.asset.conditionId,
    outcomeCollection: row.asset.outcomeSetId,
  } as CashuProofRecord
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
    sellerOpenComplementary: unsupported,
    buyerRespond: unsupported,
    sellerClaim: unsupported,
    buyerClaim: unsupported,
  }
}
