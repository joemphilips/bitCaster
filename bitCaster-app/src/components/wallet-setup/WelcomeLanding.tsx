import { X, Loader2, Check, AlertCircle } from 'lucide-react'
import type { BackgroundDataLoad } from '@/types/wallet-setup'

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
  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center px-6 text-center relative">
      {/* Logo */}
      <div className="w-24 h-24 rounded-full bg-white/10 flex items-center justify-center mb-8">
        <span className="text-5xl">₿</span>
      </div>

      {/* Title */}
      <h1 className="text-3xl sm:text-4xl font-bold text-white mb-5 tracking-tight">
        Welcome to bitCaster
      </h1>

      {/* Description */}
      <p className="text-base sm:text-lg text-slate-300 max-w-md mb-12 leading-relaxed">
        You must set up your Cashu wallet before you can start trading on prediction markets.
      </p>

      {/* Actions */}
      <div className="w-full max-w-sm">
        <button
          onClick={() => onWelcomeNext?.()}
          className="w-full py-3.5 rounded-full bg-blue-600 hover:bg-blue-700 text-white font-semibold text-base transition-colors shadow-lg shadow-blue-600/25"
        >
          Next
        </button>

        <p className="mt-4 text-sm text-slate-400">
          By continuing you agree to the{' '}
          <button
            onClick={() => onShowTerms?.()}
            className="text-blue-400 hover:text-blue-300 underline underline-offset-2 transition-colors"
          >
            Terms of Service
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
                <span className="text-slate-400">Loading markets...</span>
              </>
            )}
            {backgroundDataLoad.status === 'loaded' && (
              <>
                <Check className="w-3 h-3 text-emerald-400" strokeWidth={2.5} />
                <span className="text-slate-400">{backgroundDataLoad.conditionsLoaded} markets loaded</span>
              </>
            )}
            {backgroundDataLoad.status === 'failed' && (
              <>
                <AlertCircle className="w-3 h-3 text-amber-400" />
                <span className="text-slate-400">Failed to load markets</span>
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
                Terms of Service
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
                <p className="font-semibold text-white">Last Updated: 2025-01-01</p>

                <p className="font-semibold text-white uppercase text-xs leading-relaxed">
                  IMPORTANT NOTICE: THESE TERMS OF SERVICE INCLUDE A MEDIATION-FIRST
                  CLAUSE REQUIRING MEDIATION BEFORE ARBITRATION OR LITIGATION. PLEASE
                  READ THESE TERMS CAREFULLY. IF YOU DO NOT AGREE, DO NOT USE BITCASTER.
                </p>

                <p>
                  These Terms of Service (these &ldquo;Terms&rdquo;) constitute the entire
                  agreement and understanding between you (&ldquo;you&rdquo; or &ldquo;your&rdquo;) and
                  bitCaster (&ldquo;bitCaster,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) regarding
                  your use of the bitCaster application and any related services
                  (collectively, the &ldquo;Services&rdquo;). By accessing or using the Services,
                  you acknowledge that you have read, understand, and agree to be bound
                  by these Terms.
                </p>

                <p className="font-semibold text-white">1. Nature of the Services</p>
                <p>
                  1.1 <strong>Non-Custodial Application:</strong> bitCaster provides a
                  non-custodial web application that is executed entirely on your device.
                  We do not run a server that holds your ecash or executes transactions
                  on your behalf.
                </p>
                <p>
                  1.2 <strong>No Control Over Mints:</strong> bitCaster does not issue
                  ecash and does not operate or control any Mint. The choice of any Mint
                  and any transaction or relationship you establish with that Mint is
                  solely between you and that Mint.
                </p>
                <p>
                  1.3 <strong>No Funds Access:</strong> At no time does bitCaster have
                  custody, possession, or control of your ecash. Transactions occur
                  solely by your actions and through your chosen Mint.
                </p>

                <p className="font-semibold text-white">2. User Responsibilities</p>
                <p>
                  2.1 <strong>Sole Responsibility:</strong> You understand and agree that
                  you use the Services at your own risk. You alone are fully responsible
                  for selecting Mints, conducting transactions, and safeguarding your
                  ecash and seed phrase.
                </p>
                <p>
                  2.2 <strong>Risk of Ecash:</strong> Ecash is an experimental,
                  bearer-like digital asset. Anyone with the secret value has control
                  over the ecash. You agree to review and understand all risks before
                  using ecash.
                </p>

                <p className="font-semibold text-white">3. Prediction Markets</p>
                <p>
                  3.1 <strong>No Guarantee of Outcomes:</strong> bitCaster facilitates
                  prediction markets using Conditional Timed Fungible (CTF) tokens.
                  Market outcomes are determined by oracle attestations. bitCaster makes
                  no guarantees about oracle accuracy or market resolution.
                </p>
                <p>
                  3.2 <strong>Legal Compliance:</strong> You are solely responsible for
                  determining whether your use of prediction markets is lawful in your
                  jurisdiction.
                </p>

                <p className="font-semibold text-white">4. Limitation of Liability</p>
                <p>
                  THE SERVICES ARE PROVIDED &ldquo;AS IS&rdquo; WITHOUT ANY WARRANTIES. TO THE
                  FULLEST EXTENT PERMITTED BY LAW, BITCASTER IS NOT LIABLE FOR INDIRECT,
                  INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES.
                </p>

                <p className="font-semibold text-white">5. Privacy</p>
                <p>
                  bitCaster does not collect or store any personal data. All data is
                  stored locally on your device. The application code is open source
                  and can be self-hosted.
                </p>

                <p className="font-semibold text-white">6. Governing Law</p>
                <p>
                  These Terms shall be governed by the applicable laws of your
                  jurisdiction. Nothing in these Terms shall exclude or limit any rights
                  you may have under applicable mandatory consumer protection laws.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
