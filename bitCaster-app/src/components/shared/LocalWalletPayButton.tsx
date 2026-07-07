import { useCallback, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { encodeToken, getWalletForUnit } from '@/lib/cashu'
import { InsufficientBalanceModal } from '@/components/shared/InsufficientBalanceModal'
import { TopUpOverlay } from '@/components/market-detail/TopUpOverlay'
import {
  releaseProofReservation,
  replaceProofs,
  selectAndReserveUnitProofs,
  type StoredProof,
} from '@/stores/proof-db'
import { useBalance, useWalletStore } from '@/stores/wallet'
import { amountToNumber } from '@bitcaster/client-sdk/proofSelection'
import type { Proof } from '@cashu/cashu-ts'
import {
  completePendingLocalWalletPayment,
  markPendingLocalWalletPaymentAccepted,
  markPendingLocalWalletPaymentAcceptedButNotCompleted,
  upsertPendingLocalWalletPayment,
} from '@/lib/pendingLocalWalletPayments'
import {
  formatMarketSubunits,
  marketUnitLabel,
  type CashuProofUnit,
} from '@bitcaster/client-sdk/marketUnits'

const ACCEPTED_LOCAL_STATE_WARNING =
  'Payment was sent but local wallet state may be inconsistent. Please restart the app to reconcile.'

interface LocalWalletPayButtonProps {
  amountSubunits: number
  baseAsset: string
  unit: CashuProofUnit
  disabled?: boolean
  pending?: boolean
  failed?: boolean
  testId?: string
  reservationPurpose?: string
  loadingLabel?: string
  retryLabel?: string
  payLabel?: string
  topUpTitle?: string
  topUpRequiredDescription?: string
  topUpMinimumDescription?: string
  topUpMinimumErrorDescription?: string
  onTokenPayment: (token: string) => Promise<LocalWalletPaymentResult>
}

export type LocalWalletPaymentResult =
  | { accepted: true }
  | { accepted: false; error?: string }

/**
 * Spend regular local-wallet proofs into a bearer ecash token and submit that
 * token to a caller-owned payment endpoint. The synchronous `inflightRef`
 * mirrors `TopUpOverlay`: button disabled state is one render late, so the ref
 * is the double-click guard that protects proof selection/reservation.
 */
export function LocalWalletPayButton({
  amountSubunits,
  baseAsset,
  unit,
  disabled = false,
  pending = false,
  failed = false,
  testId,
  reservationPurpose = 'local-wallet-payment',
  loadingLabel,
  retryLabel,
  payLabel,
  topUpTitle,
  topUpRequiredDescription,
  topUpMinimumDescription,
  topUpMinimumErrorDescription,
  onTokenPayment,
}: LocalWalletPayButtonProps) {
  const { t } = useTranslation()
  const activeMintUrl = useWalletStore((s) => s.activeMintUrl)
  const balance = useBalance(activeMintUrl, { baseAsset })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [topUpStage, setTopUpStage] = useState<'closed' | 'modal' | 'overlay'>('closed')
  const inflightRef = useRef(false)
  const unitLabel = marketUnitLabel(baseAsset)
  const labelAmount = formatMarketSubunits(amountSubunits, baseAsset)
  const deficit = Math.max(amountSubunits - balance, 0)

  const handlePay = useCallback(async () => {
    if (inflightRef.current || disabled || pending || amountSubunits < 1) return
    if (balance < amountSubunits) {
      setTopUpStage('modal')
      return
    }

    const reservationId = `${reservationPurpose}:${crypto.randomUUID()}`
    let reservedProofs: StoredProof[] = []
    let splitResult: { keep: Proof[]; send: Proof[] } | null = null
    let remoteAccepted = false
    let pendingPaymentId: string | null = null
    inflightRef.current = true
    setLoading(true)
    setError(null)
    try {
      await useWalletStore.getState().ensureImplicitWallet()
      const proofs = await selectAndReserveUnitProofs(
        activeMintUrl,
        { unit, minimumAmount: amountSubunits },
        reservationId,
      )
      const proofBalance = proofs.reduce((sum, proof) => sum + amountToNumber(proof.amount), 0)
      if (proofBalance < amountSubunits) {
        await releaseProofReservation(reservationId).catch(() => undefined)
        setTopUpStage('modal')
        return
      }

      reservedProofs = proofs
      const wallet = await getWalletForUnit(activeMintUrl, unit)
      const { keep, send } = await wallet.send(amountSubunits, proofs)
      splitResult = { keep, send }
      pendingPaymentId = `local-wallet-payment:${crypto.randomUUID()}`
      await upsertPendingLocalWalletPayment({
        id: pendingPaymentId,
        status: 'pending',
        sendProofs: send,
        keepProofs: keep,
        spentSecrets: proofs.map((proof) => proof.secret),
        target: {
          mintUrl: activeMintUrl,
          amountSubunits,
          baseAsset,
          unit,
          reservationPurpose,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      const token = encodeToken(send, activeMintUrl, unit)
      const paymentResult = await onTokenPayment(token)
      if (!paymentResult.accepted) {
        await replaceProofs(
          proofs.map((proof) => proof.secret),
          [...keep, ...send].map((proof) => ({
            ...proof,
            mintUrl: activeMintUrl,
            baseAsset,
            unit,
          })),
        )
        await completePendingLocalWalletPayment(pendingPaymentId)
        if (paymentResult.error) setError(paymentResult.error)
        return
      }
      remoteAccepted = true
      await markPendingLocalWalletPaymentAccepted(pendingPaymentId)
      try {
        await replaceProofs(
          proofs.map((proof) => proof.secret),
          keep.map((proof) => ({
            ...proof,
            mintUrl: activeMintUrl,
            baseAsset,
            unit,
          })),
        )
        await completePendingLocalWalletPayment(pendingPaymentId)
      } catch (err) {
        await markPendingLocalWalletPaymentAcceptedButNotCompleted(pendingPaymentId, err).catch(() => undefined)
        setError(ACCEPTED_LOCAL_STATE_WARNING)
      }
    } catch (err) {
      if (splitResult && !remoteAccepted) {
        // If the local split succeeded but the HTTP submit failed before the
        // engine accepted the token, keep both change and send proofs in the
        // local wallet so the user can retry rather than silently losing value.
        await replaceProofs(
          reservedProofs.map((proof) => proof.secret),
          [...splitResult.keep, ...splitResult.send].map((proof) => ({
            ...proof,
            mintUrl: activeMintUrl,
            baseAsset,
            unit,
          })),
        ).catch(() => undefined)
      }
      if (reservedProofs.length > 0 && !remoteAccepted) {
        await releaseProofReservation(reservationId).catch(() => undefined)
      }
      if (pendingPaymentId && !remoteAccepted) {
        await completePendingLocalWalletPayment(pendingPaymentId).catch(() => undefined)
      }
      setError(err instanceof Error ? err.message : t('marketCreation.ecashSubmitError'))
    } finally {
      inflightRef.current = false
      setLoading(false)
    }
  }, [activeMintUrl, amountSubunits, balance, baseAsset, disabled, onTokenPayment, pending, reservationPurpose, t, unit])

  const handleTopUpSuccess = useCallback(() => {
    setTopUpStage('closed')
  }, [])

  return (
    <>
      <button
        data-testid={testId}
        type="button"
        onClick={handlePay}
        disabled={disabled || loading || pending || amountSubunits < 1}
        className="w-full rounded-lg bg-blue-600 px-4 py-3 font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
      >
        {loading ? (
          <span className="inline-flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            {loadingLabel ?? t('marketCreation.payingFromWallet')}
          </span>
        ) : failed ? (
          retryLabel ?? t('marketCreation.retryWalletPayment')
        ) : (
          payLabel ?? t('marketCreation.payWalletFunding', { amount: labelAmount })
        )}
      </button>

      {error && (
        <p className="mt-3 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">
          {error}
        </p>
      )}

      {topUpStage === 'modal' && (
        <InsufficientBalanceModal
          balance={balance}
          required={amountSubunits}
          title={topUpTitle ?? t('marketCreation.depositWalletTopUpTitle', { unit: unitLabel })}
          requiredDescription={topUpRequiredDescription ?? t('marketCreation.depositWalletTopUpRequiredDescription')}
          formatAmount={(amount) => formatMarketSubunits(amount, baseAsset)}
          onCancel={() => setTopUpStage('closed')}
          onTopUp={() => setTopUpStage('overlay')}
        />
      )}

      {topUpStage === 'overlay' && (
        <TopUpOverlay
          deficit={deficit}
          baseAsset={baseAsset}
          proofUnit={unit}
          minimumDescription={topUpMinimumDescription ?? t('marketCreation.depositWalletTopUpMinimumDescription', {
            amount: formatMarketSubunits(deficit, baseAsset),
          })}
          minimumErrorDescription={topUpMinimumErrorDescription ?? t('marketCreation.depositWalletTopUpMinimumError', {
            amount: formatMarketSubunits(deficit, baseAsset),
          })}
          onSuccess={handleTopUpSuccess}
          onCancel={() => setTopUpStage('closed')}
        />
      )}
    </>
  )
}
