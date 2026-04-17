import { X, Loader2, Check, AlertCircle } from 'lucide-react'
import type { BackgroundDataLoad } from '@/types/wallet-setup'
import { useTranslation } from 'react-i18next'

interface WelcomeLandingProps {
  showTerms: boolean
  backgroundDataLoad?: BackgroundDataLoad
  onWelcomeNext?: () => void
  onShowTerms?: () => void
  onCloseTerms?: () => void
}

export function WelcomeLanding({
  showTerms,
  backgroundDataLoad,
  onWelcomeNext,
  onShowTerms,
  onCloseTerms,
}: WelcomeLandingProps) {
  const { t } = useTranslation()
  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center px-6 text-center relative">
      {/* Logo */}
      <div className="w-24 h-24 rounded-full bg-white/10 flex items-center justify-center mb-8">
        <span className="text-5xl">₿</span>
      </div>

      {/* Title */}
      <h1 className="text-3xl sm:text-4xl font-bold text-white mb-5 tracking-tight">
        {t('welcome.title')}
      </h1>

      {/* Description */}
      <p className="text-base sm:text-lg text-slate-300 max-w-md mb-12 leading-relaxed">
        {t('welcome.description')}
      </p>

      {/* Actions */}
      <div className="w-full max-w-sm">
        <button
          onClick={() => onWelcomeNext?.()}
          className="w-full py-3.5 rounded-full bg-blue-600 hover:bg-blue-700 text-white font-semibold text-base transition-colors shadow-lg shadow-blue-600/25"
        >
          {t('common.next')}
        </button>

        <p className="mt-4 text-sm text-slate-400">
          {t('welcome.termsAgreement')}{' '}
          <button
            onClick={() => onShowTerms?.()}
            className="text-blue-400 hover:text-blue-300 underline underline-offset-2 transition-colors"
          >
            {t('welcome.termsLink')}
          </button>
        </p>
      </div>

      {/* Background data loading indicator */}
      {backgroundDataLoad && backgroundDataLoad.status !== 'idle' && (
        <div className="fixed bottom-6 left-6 z-40">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800/80 backdrop-blur-sm border border-slate-700/50 text-xs">
            {backgroundDataLoad.status === 'loading' && (
              <>
                <Loader2 className="w-3 h-3 animate-spin text-blue-400" />
                <span className="text-slate-400">{t('welcome.loadingMarkets')}</span>
              </>
            )}
            {backgroundDataLoad.status === 'loaded' && (
              <>
                <Check className="w-3 h-3 text-emerald-400" strokeWidth={2.5} />
                <span className="text-slate-400">{t('welcome.marketsLoaded', { count: backgroundDataLoad.conditionsLoaded })}</span>
              </>
            )}
            {backgroundDataLoad.status === 'failed' && (
              <>
                <AlertCircle className="w-3 h-3 text-amber-400" />
                <span className="text-slate-400">{t('welcome.failedToLoadMarkets')}</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Terms of Service bottom sheet */}
      {showTerms && (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/50 backdrop-blur-sm animate-in fade-in"
          onClick={() => onCloseTerms?.()}
        >
          <div
            className="w-full max-h-[85vh] bg-slate-900 rounded-t-2xl border-t border-slate-700 flex flex-col animate-in slide-in-from-bottom"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700 shrink-0">
              <h3 className="text-lg font-semibold text-white">
                {t('terms.title')}
              </h3>
              <button
                onClick={() => onCloseTerms?.()}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className="text-sm text-slate-300 leading-relaxed space-y-4">
                <p className="font-semibold text-white">{t('terms.lastUpdated')}</p>

                <p className="font-semibold text-white uppercase text-xs leading-relaxed">
                  {t('terms.importantNotice')}
                </p>

                <p>{t('terms.intro')}</p>

                <p className="font-semibold text-white">{t('terms.section1Title')}</p>
                <p>{t('terms.s1p1')}</p>
                <p>{t('terms.s1p2')}</p>
                <p>{t('terms.s1p3')}</p>

                <p className="font-semibold text-white">{t('terms.section2Title')}</p>
                <p>{t('terms.s2p1')}</p>
                <p>{t('terms.s2p2')}</p>

                <p className="font-semibold text-white">{t('terms.section3Title')}</p>
                <p>{t('terms.s3p1')}</p>
                <p>{t('terms.s3p2')}</p>

                <p className="font-semibold text-white">{t('terms.section4Title')}</p>
                <p>{t('terms.s4p1')}</p>

                <p className="font-semibold text-white">{t('terms.section5Title')}</p>
                <p>{t('terms.s5p1')}</p>

                <p className="font-semibold text-white">{t('terms.section6Title')}</p>
                <p>{t('terms.s6p1')}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
