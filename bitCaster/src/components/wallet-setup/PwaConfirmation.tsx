import { Smartphone, Monitor, ArrowDown, Loader2, Check, AlertCircle } from 'lucide-react'
import type { BackgroundDataLoad } from '@/types/wallet-setup'

interface PwaConfirmationProps {
  isPwa: boolean
  backgroundDataLoad?: BackgroundDataLoad
  onPwaNext?: () => void
  onBack?: () => void
}

export function PwaConfirmation({ isPwa, backgroundDataLoad, onPwaNext, onBack }: PwaConfirmationProps) {
  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center px-6 pt-12 pb-8 text-center">
      {/* Illustration — phone + desktop mockup */}
      <div className="relative mb-8 flex items-end justify-center gap-4">
        <div className="w-20 h-36 rounded-xl border-2 border-slate-600 bg-slate-800 flex flex-col items-center justify-center p-2">
          <div className="w-8 h-8 rounded-lg bg-blue-600/20 flex items-center justify-center mb-2">
            <span className="text-lg">₿</span>
          </div>
          <div className="w-full space-y-1">
            <div className="h-1.5 bg-slate-700 rounded-full" />
            <div className="h-1.5 bg-slate-700 rounded-full w-3/4" />
          </div>
          <Smartphone className="w-4 h-4 text-slate-500 mt-2" />
        </div>

        <div className="w-40 h-28 rounded-xl border-2 border-slate-600 bg-slate-800 flex flex-col items-center justify-center p-3">
          <div className="w-8 h-8 rounded-lg bg-blue-600/20 flex items-center justify-center mb-2">
            <span className="text-lg">₿</span>
          </div>
          <div className="w-full space-y-1">
            <div className="h-1.5 bg-slate-700 rounded-full" />
            <div className="h-1.5 bg-slate-700 rounded-full w-2/3" />
          </div>
          <Monitor className="w-4 h-4 text-slate-500 mt-2" />
        </div>
      </div>

      {/* Title */}
      <h1 className="text-2xl sm:text-3xl font-bold text-white mb-4">
        Install PWA
      </h1>

      {/* Description */}
      <p className="text-base text-slate-300 max-w-md mb-8 leading-relaxed">
        For the best experience, install bitCaster as a Progressive Web App on your device.
      </p>

      {/* Instructions */}
      <div className="w-full max-w-sm space-y-4 mb-10 text-left">
        {/* Android */}
        <div className="p-4 rounded-xl bg-slate-800/60 border border-slate-700">
          <h3 className="text-sm font-semibold text-white mb-2">Android / Chrome</h3>
          <div className="space-y-2">
            <div className="flex items-start gap-2.5 text-sm text-slate-300">
              <span className="text-slate-500 font-mono text-xs mt-0.5">1.</span>
              <span>Tap the <strong className="text-white">&#8942;</strong> menu in Chrome</span>
            </div>
            <div className="flex items-start gap-2.5 text-sm text-slate-300">
              <span className="text-slate-500 font-mono text-xs mt-0.5">2.</span>
              <span>Select <strong className="text-white">&ldquo;Add to Home Screen&rdquo;</strong></span>
            </div>
          </div>
        </div>

        {/* iOS */}
        <div className="p-4 rounded-xl bg-slate-800/60 border border-slate-700">
          <h3 className="text-sm font-semibold text-white mb-2">iOS / Safari</h3>
          <div className="space-y-2">
            <div className="flex items-start gap-2.5 text-sm text-slate-300">
              <span className="text-slate-500 font-mono text-xs mt-0.5">1.</span>
              <span>Tap the <ArrowDown className="inline w-3.5 h-3.5 rotate-180 -mb-0.5" /> Share button in Safari</span>
            </div>
            <div className="flex items-start gap-2.5 text-sm text-slate-300">
              <span className="text-slate-500 font-mono text-xs mt-0.5">2.</span>
              <span>Select <strong className="text-white">&ldquo;Add to Home Screen&rdquo;</strong></span>
            </div>
          </div>
        </div>
      </div>

      {!isPwa && (
        <p className="text-xs text-amber-400 max-w-sm mb-4">
          Install as app to continue. The button below will be enabled once you open bitCaster as a PWA.
        </p>
      )}

      <p className="text-xs text-slate-500 max-w-sm mb-8">
        You can also skip this step and install later from your browser&rsquo;s menu.
      </p>

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

      {/* Navigation */}
      <div className="w-full max-w-sm flex items-center justify-between">
        <button
          onClick={() => onBack?.()}
          className="px-5 py-2.5 rounded-full text-sm font-medium text-slate-400 hover:text-white transition-colors"
        >
          &larr; Previous
        </button>
        <button
          onClick={() => onPwaNext?.()}
          disabled={!isPwa}
          className="px-8 py-2.5 rounded-full bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold text-sm transition-colors"
        >
          Next &rarr;
        </button>
      </div>
    </div>
  )
}
