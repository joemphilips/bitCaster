import { X, Copy, Check, Share2 } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GuiBearerSpendCancellationPreview } from '@/stores/gui-bearer-spend-cancellation'
import { GuiBearerSpendTokenPresentationRevoked } from '@/stores/gui-bearer-spend-presentation'

interface TokenDisplayProps {
  token: string | null
  amountSats: number
  onClose?: () => void
  cancellationPreview?: GuiBearerSpendCancellationPreview | null
  cancellationPending?: boolean
  authorizePresentation?: (present: (token: string) => Promise<void>) => Promise<void>
  onPresentationRevoked?: () => void
  onInspectCancellation?: () => void
  onConfirmCancellation?: () => void
  onDismissCancellation?: () => void
}

export const CASHU_TOKEN_QR_BYTES_LIMIT_MAX = 2_048
const CASHU_TOKEN_PREVIEW_CODE_UNITS_MAX = 512
const CASHU_TOKEN_ANIMATED_QR_INTERVAL_MS = 300

export function TokenDisplay({
  token,
  amountSats,
  onClose,
  cancellationPreview,
  cancellationPending = false,
  authorizePresentation,
  onPresentationRevoked,
  onInspectCancellation,
  onConfirmCancellation,
  onDismissCancellation,
}: TokenDisplayProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const canRenderQr =
    token !== null &&
    token.length <= CASHU_TOKEN_QR_BYTES_LIMIT_MAX &&
    new TextEncoder().encode(token).byteLength <= CASHU_TOKEN_QR_BYTES_LIMIT_MAX
  const tokenPreview =
    token === null
      ? null
      : token.length <= CASHU_TOKEN_PREVIEW_CODE_UNITS_MAX
        ? token
        : `${token.slice(0, 384)}…${token.slice(-64)}`

  const handleCopy = async () => {
    if (token === null) return
    try {
      await presentAuthorizedToken(async (exactToken) => {
        await navigator.clipboard.writeText(exactToken)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
    } catch (error) {
      if (error instanceof GuiBearerSpendTokenPresentationRevoked) {
        onPresentationRevoked?.()
      }
    }
  }

  const handleShare = async () => {
    if (token === null) return
    try {
      await presentAuthorizedToken(async (exactToken) => {
        if (navigator.share) {
          await navigator.share({ text: exactToken })
          return
        }
        await navigator.clipboard.writeText(exactToken)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
    } catch (error) {
      if (error instanceof GuiBearerSpendTokenPresentationRevoked) {
        onPresentationRevoked?.()
      }
    }
  }

  const presentAuthorizedToken = (present: (exactToken: string) => Promise<void>) => {
    if (authorizePresentation) return authorizePresentation(present)
    if (token === null) return Promise.resolve()
    return present(token)
  }

  return (
    <div className="fixed inset-0 z-[70] bg-slate-900 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4">
        <button
          onClick={() => onClose?.()}
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-semibold text-white">Send Ecash</h2>
        <div className="w-8" />
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col items-center justify-center max-w-md mx-auto w-full px-5">
        {token ? (
          <>
            <div className="mb-6 flex items-center gap-2 text-emerald-400">
              <Check className="h-5 w-5" />
              <span className="text-sm font-semibold">{t('deposit.ecashTokenReady')}</span>
            </div>

            {/* QR Code */}
            {canRenderQr ? (
              <div className="bg-white p-4 rounded-2xl">
                <QRCodeSVG value={token} size={256} level="L" />
              </div>
            ) : (
              <AnimatedCashuTokenQr token={token} />
            )}
          </>
        ) : null}

        {/* Amount */}
        <div className="mt-6 text-2xl font-bold text-white font-mono">₿{amountSats.toLocaleString()}</div>

        {/* Token text + copy */}
        {token ? (
          <div className="mt-4 w-full">
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-3 flex items-center gap-2">
              <span className="flex-1 text-xs text-slate-400 font-mono truncate">{tokenPreview}</span>
              <button
                onClick={handleCopy}
                aria-label={t('deposit.copyEcashToken')}
                className="flex-shrink-0 p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
              >
                {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              </button>
              <button
                onClick={handleShare}
                aria-label={t('deposit.shareEcashToken')}
                className="flex-shrink-0 p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
              >
                <Share2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ) : null}

        {/* Instruction */}
        <p className="mt-4 text-sm text-slate-400 text-center">
          {token ? t('deposit.ecashTokenReadyHint') : t('deposit.cancelEcashPendingHint')}
        </p>

        {cancellationPreview ? (
          <div className="mt-5 w-full rounded-xl border border-amber-700/70 bg-amber-950/40 p-4 text-sm text-amber-100">
            <p className="font-semibold">{t('deposit.cancelEcashConfirmTitle')}</p>
            <p className="mt-2">
              {t('deposit.cancelEcashFee', {
                fee: cancellationPreview.fee.toLocaleString(),
                amount: cancellationPreview.returnedAmount.toLocaleString(),
              })}
            </p>
            {cancellationPreview.partial ? (
              <p className="mt-2 text-amber-200">{t('deposit.cancelEcashPartial')}</p>
            ) : null}
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={cancellationPending}
                onClick={onConfirmCancellation}
                className="flex-1 rounded-lg bg-amber-600 px-3 py-2 font-semibold text-white disabled:opacity-50"
              >
                {cancellationPending ? t('deposit.cancelEcashWorking') : t('deposit.cancelEcashConfirm')}
              </button>
              <button
                type="button"
                disabled={cancellationPending}
                onClick={onDismissCancellation}
                className="rounded-lg border border-amber-700 px-3 py-2 font-semibold disabled:opacity-50"
              >
                {t('common.back')}
              </button>
            </div>
          </div>
        ) : onInspectCancellation ? (
          <button
            type="button"
            disabled={cancellationPending}
            onClick={onInspectCancellation}
            className="mt-5 rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-800 disabled:opacity-50"
          >
            {cancellationPending ? t('deposit.cancelEcashChecking') : t('deposit.cancelEcash')}
          </button>
        ) : null}
      </div>
    </div>
  )
}

function AnimatedCashuTokenQr({ token }: { token: string }) {
  const { t } = useTranslation()
  const [frame, setFrame] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null
    void import('@bitcaster/client-sdk/cashuNut16')
      .then(({ createCashuNut16Encoder }) => {
        if (cancelled) return
        const encoder = createCashuNut16Encoder(token)
        setFrame(encoder.nextPart())
        timer = setInterval(() => setFrame(encoder.nextPart()), CASHU_TOKEN_ANIMATED_QR_INTERVAL_MS)
      })
      .catch(() => {
        if (!cancelled) setUnsupported(true)
      })
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [token])

  if (unsupported) {
    return (
      <div className="rounded-2xl border border-slate-700 bg-slate-800 p-6 text-center text-sm text-slate-300">
        {t('deposit.ecashTokenTooLargeForQr')}
      </div>
    )
  }
  if (!frame) {
    return (
      <div className="rounded-2xl border border-slate-700 bg-slate-800 p-6 text-center text-sm text-slate-300">
        {t('deposit.ecashTokenPreparingAnimatedQr')}
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="bg-white p-4 rounded-2xl" aria-label={t('deposit.ecashTokenAnimatedQr')}>
        <QRCodeSVG value={frame} size={256} level="L" />
      </div>
      <span className="text-xs text-slate-400">{t('deposit.ecashTokenAnimatedQr')}</span>
    </div>
  )
}
