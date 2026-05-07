/**
 * Drives the bitCaster atomic-swap protocol from MATCHED to CONFIRMED.
 *
 * Mounted once at the application root alongside `usePendingTradesPoller`. The
 * poller surfaces fills with a `tradeId` to `activeSwaps`; this hook reacts
 * to each entry, connects the TradeHub, joins the channel, and runs the
 * seller or buyer branch of `atomicSwap.ts` as the engine relays the
 * counterparty's encrypted messages.
 *
 * Lifecycle per swap:
 *   1. `activeSwaps.promote()` — populated by the order poller when a fill
 *      with a tradeId is observed. We pick it up via store subscription.
 *   2. `joinTrade(tradeId)` — register interest with the engine.
 *   3. `TradeCreated` — decide the local role from sellerPubkey vs our
 *      ephemeralPubkey, and remember locktimes.
 *   4. Drive the role-specific message exchange.
 *      - Seller: `sellerPrepareSwap`, send `adaptor-point` and
 *        `locked-proofs-seller`.
 *      - Buyer: wait for both seller messages, run `buyerPrepareSwap`,
 *        send `locked-proofs-buyer`.
 *   5. `TradeStateChanged → Settling` — both halves are in flight. Each
 *      side claims at the mint and emits `settlement-complete`.
 *      - Seller: `sellerClaimSwap` adapts buyer's pre-sigs and swaps.
 *      - Buyer: poll NUT-07 with `buyerExtractSecret` until the adaptor
 *        secret is recoverable, then `buyerClaimSwap`.
 *   6. `TradeStateChanged → Confirmed` — toast, drop ephemeral state.
 *
 * SECURITY: every received pre-sig is verified inside `atomicSwap.ts` before
 * `adapt()` is invoked. `cashu-ts.receive()` performs DLEQ verification
 * during the swap-and-mint step. We never write the locked-half proofs into
 * the wallet — only the fresh proofs returned by the mint.
 */

import { useEffect } from 'react'
import type { Proof } from '@cashu/cashu-ts'
import {
  useTradeHub,
  type TradeCreatedPayload,
  type SwapMessage,
} from '@/hooks/useTradeHub'
import {
  useActiveSwapsStore,
  type ActiveSwap,
  type SwapRole,
} from '@/stores/activeSwaps'
import { useWalletStore } from '@/stores/wallet'
import { addProofs, getProofs, type StoredProof } from '@/stores/proof-db'
import { hexToBytes } from '@/lib/ecdh'
import {
  buyerClaimSwap,
  buyerExtractSecret,
  buyerPrepareSwap,
  sellerClaimSwap,
  sellerPrepareSwap,
  validateLocktimeOrdering,
  type AdaptorPoint,
} from '@/lib/atomicSwap'
import { useToastStore } from '@/stores/toast'

// ---------------------------------------------------------------------------
// Module-scope per-swap secret state
// ---------------------------------------------------------------------------

/** Material the seller (Alice) generates and must hold across messages. */
interface SellerState {
  adaptorPoint: AdaptorPoint
}

/** Material the buyer (Bob) generates after `buyerPrepareSwap`. */
interface BuyerState {
  /** Bob's pre-sigs over Bob's locked sat proofs — extract `t` from these. */
  ownPreSigsHex: string[]
  /** The proofs Bob locked to Alice; needed for the NUT-07 poll. */
  lockedSatProofs: Proof[]
  /** Alice's pre-sigs from her locked-proofs message — adapted on claim. */
  sellerPreSigsHex: string[]
}

const sellerStateByTradeId = new Map<string, SellerState>()
const buyerStateByTradeId = new Map<string, BuyerState>()
const settlementCompleteSenders = new Map<string, () => Promise<void>>()
const inFlightSteps = new Set<string>()

// ---------------------------------------------------------------------------
// Public hook
// ---------------------------------------------------------------------------

/**
 * Mount once near the app root. The hook owns no DOM and renders nothing.
 *
 * @param ephemeralPrivkey - Driver-level identity used to authenticate to the
 *   TradeHub. Pass `null` until the user has a wallet/identity available;
 *   without it we cannot sign the NIP-98 access token.
 */
export function useTradeSettlement(ephemeralPrivkey: Uint8Array | null): void {
  const swapsByTradeId = useActiveSwapsStore((s) => s.byTradeId)
  const activeMintUrl = useWalletStore((s) => s.activeMintUrl)
  const hasActiveSwapWork = Object.values(swapsByTradeId).some(
    (swap) => swap.step !== 'completed' && swap.step !== 'failed',
  )
  const tradeHubPrivkey = hasActiveSwapWork ? ephemeralPrivkey : null

  const { joinTrade, sendSwapMessage } = useTradeHub(tradeHubPrivkey, {
    onTradeCreated: (payload) =>
      handleTradeCreated(payload, sendSwapMessage, activeMintUrl),
    onSwapMessageReceived: (msg) =>
      handleSwapMessage(msg, sendSwapMessage, activeMintUrl),
    onTradeStateChanged: (tradeId, newState) =>
      handleTradeStateChanged(tradeId, newState),
  })

  useEffect(() => {
    if (!tradeHubPrivkey) return
    for (const swap of Object.values(swapsByTradeId)) {
      if (swap.step !== 'awaiting-trade-created') continue
      // Bind a sender for `settlement-complete` keyed by tradeId so the
      // claim path doesn't need to thread `sendSwapMessage` through every
      // helper. The closure captures the mounted hub instance.
      settlementCompleteSenders.set(swap.tradeId, () =>
        sendSwapMessage(swap.tradeId, 'settlement-complete', ''),
      )
      joinTrade(swap.tradeId).catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        useActiveSwapsStore.getState().setStep(swap.tradeId, 'failed', message)
      })
    }
  }, [swapsByTradeId, tradeHubPrivkey, joinTrade, sendSwapMessage])
}

// ---------------------------------------------------------------------------
// TradeCreated → assign role + drive seller's first messages
// ---------------------------------------------------------------------------

function handleTradeCreated(
  payload: TradeCreatedPayload,
  sendSwapMessage: SendSwapMessageFn,
  mintUrl: string,
): void {
  const swap = useActiveSwapsStore.getState().byTradeId[payload.tradeId]
  if (!swap) return

  // Defense-in-depth: refuse to lock proofs if the engine's TradeCreated
  // payload violates `T_YES > T_sat + Δ`. Mirrors the wallet-service guard.
  const sellerLocktime = parseLocktime(payload.sellerLocktime)
  const buyerLocktime = parseLocktime(payload.buyerLocktime)
  const lockErr = validateLocktimeOrdering(sellerLocktime, buyerLocktime)
  if (lockErr) {
    failSwap(payload.tradeId, new Error(lockErr))
    return
  }

  const role = decideRole(swap, payload)
  if (!role) {
    useActiveSwapsStore
      .getState()
      .setStep(
        payload.tradeId,
        'failed',
        'TradeCreated did not list our ephemeral pubkey on either side',
      )
    return
  }
  const counterparty =
    role === 'seller' ? payload.buyerPubkey : payload.sellerPubkey
  useActiveSwapsStore
    .getState()
    .setRoleAndCounterparty(payload.tradeId, role, counterparty, {
      sellerLocktime,
      buyerLocktime,
    })

  if (role === 'seller') {
    void runSellerSendOpening(payload.tradeId, sendSwapMessage, mintUrl)
  }
}

function decideRole(
  swap: ActiveSwap,
  payload: TradeCreatedPayload,
): SwapRole | null {
  const ourKey = swap.ephemeralPubkeyHex.toLowerCase()
  if (payload.sellerPubkey.toLowerCase() === ourKey) return 'seller'
  if (payload.buyerPubkey.toLowerCase() === ourKey) return 'buyer'
  return null
}

function parseLocktime(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000)
}

// ---------------------------------------------------------------------------
// Seller — Step 4 + 5
// ---------------------------------------------------------------------------

async function runSellerSendOpening(
  tradeId: string,
  sendSwapMessage: SendSwapMessageFn,
  mintUrl: string,
): Promise<void> {
  if (!claimStep(tradeId, 'seller-open')) return
  try {
    const swap = useActiveSwapsStore.getState().byTradeId[tradeId]
    if (!swap || swap.role !== 'seller') return
    useActiveSwapsStore.getState().setStep(tradeId, 'driving')
    const ctx = buildSwapContext(swap, mintUrl)
    if (!ctx) return
    const proofs = await loadProofsForLock(mintUrl)
    const out = await sellerPrepareSwap(ctx, proofs)
    sellerStateByTradeId.set(tradeId, { adaptorPoint: out.adaptorPoint })
    await sendSwapMessage(tradeId, 'adaptor-point', out.adaptorPointCipher)
    await sendSwapMessage(
      tradeId,
      'locked-proofs-seller',
      out.lockedProofsCipher,
    )
  } catch (err) {
    failSwap(tradeId, err)
  } finally {
    releaseStep(tradeId, 'seller-open')
  }
}

// ---------------------------------------------------------------------------
// SwapMessageReceived dispatch
// ---------------------------------------------------------------------------

function handleSwapMessage(
  msg: SwapMessage,
  sendSwapMessage: SendSwapMessageFn,
  mintUrl: string,
): void {
  const messageKey = msg.messageType as
    | 'adaptor-point'
    | 'locked-proofs-seller'
    | 'locked-proofs-buyer'
    | 'settlement-complete'
  if (messageKey === 'settlement-complete') return // engine emits TradeStateChanged for the terminal hop
  recordCipher(msg.tradeId, messageKey, msg.ciphertext)
  const swap = useActiveSwapsStore.getState().byTradeId[msg.tradeId]
  if (!swap) return

  if (swap.role === 'buyer' && hasAllSellerMessages(swap)) {
    void runBuyerRespond(msg.tradeId, sendSwapMessage, mintUrl)
  }
}

function hasAllSellerMessages(swap: ActiveSwap): boolean {
  return !!swap.messages.adaptorPoint && !!swap.messages.lockedProofsSeller
}

function recordCipher(
  tradeId: string,
  messageType: 'adaptor-point' | 'locked-proofs-seller' | 'locked-proofs-buyer',
  ciphertext: string,
): void {
  const key = messageStoreKey(messageType)
  useActiveSwapsStore.getState().recordMessage(tradeId, key, ciphertext)
}

function messageStoreKey(
  messageType: 'adaptor-point' | 'locked-proofs-seller' | 'locked-proofs-buyer',
): keyof ActiveSwap['messages'] {
  switch (messageType) {
    case 'adaptor-point':
      return 'adaptorPoint'
    case 'locked-proofs-seller':
      return 'lockedProofsSeller'
    case 'locked-proofs-buyer':
      return 'lockedProofsBuyer'
  }
}

// ---------------------------------------------------------------------------
// Buyer — Step 6
// ---------------------------------------------------------------------------

async function runBuyerRespond(
  tradeId: string,
  sendSwapMessage: SendSwapMessageFn,
  mintUrl: string,
): Promise<void> {
  if (!claimStep(tradeId, 'buyer-respond')) return
  try {
    const swap = useActiveSwapsStore.getState().byTradeId[tradeId]
    if (!swap || swap.role !== 'buyer') return
    if (!swap.messages.adaptorPoint || !swap.messages.lockedProofsSeller) return
    useActiveSwapsStore.getState().setStep(tradeId, 'driving')
    const ctx = buildSwapContext(swap, mintUrl)
    if (!ctx) return
    const proofs = await loadProofsForLock(mintUrl)
    const out = await buyerPrepareSwap(
      ctx,
      swap.messages.adaptorPoint,
      swap.messages.lockedProofsSeller,
      proofs,
    )
    buyerStateByTradeId.set(tradeId, {
      ownPreSigsHex: out.preSigsHex,
      lockedSatProofs: out.lockedProofs,
      sellerPreSigsHex: out.sellerPreSigsHex,
    })
    await sendSwapMessage(
      tradeId,
      'locked-proofs-buyer',
      out.lockedProofsCipher,
    )
  } catch (err) {
    failSwap(tradeId, err)
  } finally {
    releaseStep(tradeId, 'buyer-respond')
  }
}

// ---------------------------------------------------------------------------
// TradeStateChanged → claim + settlement-complete
// ---------------------------------------------------------------------------

function handleTradeStateChanged(tradeId: string, newState: string): void {
  const lower = newState.toLowerCase()
  if (lower === 'confirmed') return finishSwap(tradeId, 'success')
  if (lower === 'failed') return finishSwap(tradeId, 'failed')
  if (lower !== 'settling') return
  void runSettlementClaim(tradeId)
}

async function runSettlementClaim(tradeId: string): Promise<void> {
  if (!claimStep(tradeId, 'settle')) return
  try {
    const swap = useActiveSwapsStore.getState().byTradeId[tradeId]
    if (!swap || !swap.role) return
    const mintUrl = useWalletStore.getState().activeMintUrl
    const ctx = buildSwapContext(swap, mintUrl)
    if (!ctx) return
    const fresh =
      swap.role === 'seller'
        ? await runSellerClaim(swap, ctx)
        : await runBuyerClaim(swap, ctx)
    await persistFreshProofs(fresh, mintUrl)
    useActiveSwapsStore.getState().setStep(tradeId, 'awaiting-confirmation')
    await sendSettlementComplete(tradeId)
  } catch (err) {
    failSwap(tradeId, err)
  } finally {
    releaseStep(tradeId, 'settle')
  }
}

async function runSellerClaim(
  swap: ActiveSwap,
  ctx: SwapCtx,
): Promise<Proof[]> {
  const seller = sellerStateByTradeId.get(swap.tradeId)
  if (!seller) throw new Error('Missing seller adaptor state')
  if (!swap.messages.lockedProofsBuyer)
    throw new Error('Missing locked-proofs-buyer cipher')
  return sellerClaimSwap(
    ctx,
    seller.adaptorPoint,
    swap.messages.lockedProofsBuyer,
  )
}

async function runBuyerClaim(swap: ActiveSwap, ctx: SwapCtx): Promise<Proof[]> {
  const buyer = buyerStateByTradeId.get(swap.tradeId)
  if (!buyer) throw new Error('Missing buyer pre-sig state')
  if (!swap.messages.lockedProofsSeller)
    throw new Error('Missing locked-proofs-seller cipher')
  const adaptorSecret = await pollForAdaptorSecret(
    ctx.mintUrl,
    buyer.lockedSatProofs,
    buyer.ownPreSigsHex,
  )
  return buyerClaimSwap(
    ctx,
    adaptorSecret,
    swap.messages.lockedProofsSeller,
    buyer.sellerPreSigsHex,
  )
}

async function pollForAdaptorSecret(
  mintUrl: string,
  spentProofs: Proof[],
  preSigsHex: string[],
): Promise<Uint8Array> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const t = await buyerExtractSecret(mintUrl, spentProofs, preSigsHex)
    if (t) return t
    await new Promise((r) => setTimeout(r, 1_000))
  }
  throw new Error('Timed out waiting for seller to spend at mint')
}

async function loadProofsForLock(mintUrl: string): Promise<Proof[]> {
  const proofs = await getProofs(mintUrl)
  if (proofs.length === 0) {
    throw new Error('No proofs available for atomic swap — wallet is empty')
  }
  return proofs
}

async function persistFreshProofs(
  proofs: Proof[],
  mintUrl: string,
): Promise<void> {
  if (proofs.length === 0) return
  const fresh: StoredProof[] = proofs.map((p) => ({ ...p, mintUrl }))
  await addProofs(fresh)
}

async function sendSettlementComplete(tradeId: string): Promise<void> {
  const fn = settlementCompleteSenders.get(tradeId)
  if (!fn) return
  await fn()
}

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

function finishSwap(tradeId: string, outcome: 'success' | 'failed'): void {
  const swap = useActiveSwapsStore.getState().byTradeId[tradeId]
  if (!swap) return
  useActiveSwapsStore
    .getState()
    .setStep(tradeId, outcome === 'success' ? 'completed' : 'failed')
  sellerStateByTradeId.delete(tradeId)
  buyerStateByTradeId.delete(tradeId)
  settlementCompleteSenders.delete(tradeId)
  const toast = useToastStore.getState().addToast
  toast({
    type: outcome === 'success' ? 'success' : 'error',
    message:
      outcome === 'success'
        ? `Trade complete: ${swap.marketId}`
        : `Trade failed: ${swap.error ?? 'unknown error'}`,
  })
  // Keep the entry around briefly so any UI subscriber gets a final
  // snapshot before the row vanishes.
  setTimeout(() => useActiveSwapsStore.getState().remove(tradeId), 5_000)
}

function failSwap(tradeId: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  useActiveSwapsStore.getState().setStep(tradeId, 'failed', message)
  finishSwap(tradeId, 'failed')
}

function claimStep(tradeId: string, key: string): boolean {
  const id = `${tradeId}:${key}`
  if (inFlightSteps.has(id)) return false
  inFlightSteps.add(id)
  return true
}

function releaseStep(tradeId: string, key: string): void {
  inFlightSteps.delete(`${tradeId}:${key}`)
}

// ---------------------------------------------------------------------------
// Swap-context construction
// ---------------------------------------------------------------------------

interface SwapCtx {
  tradeId: string
  role: SwapRole
  ephemeralKey: { privateKey: Uint8Array; publicKey: string }
  counterpartyPubkey: string
  sellerLocktime: number
  buyerLocktime: number
  mintUrl: string
}

function buildSwapContext(swap: ActiveSwap, mintUrl: string): SwapCtx | null {
  if (
    !swap.role ||
    !swap.counterpartyPubkey ||
    swap.sellerLocktime === null ||
    swap.buyerLocktime === null
  ) {
    return null
  }
  return {
    tradeId: swap.tradeId,
    role: swap.role,
    ephemeralKey: {
      privateKey: hexToBytes(swap.ephemeralPrivkeyHex),
      publicKey: swap.ephemeralPubkeyHex,
    },
    counterpartyPubkey: swap.counterpartyPubkey,
    sellerLocktime: swap.sellerLocktime,
    buyerLocktime: swap.buyerLocktime,
    mintUrl,
  }
}

type SendSwapMessageFn = (
  tradeId: string,
  type: string,
  ciphertext: string,
) => Promise<void>
