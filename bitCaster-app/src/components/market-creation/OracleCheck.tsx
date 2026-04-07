import { Radio, Satellite, Settings, ArrowRight } from 'lucide-react'
import type { OracleAnnouncement, OracleCheckChoice } from '@/types/market-creation'

interface OracleCheckProps {
  choice: OracleCheckChoice | null
  selectedAnnouncementId: string | null
  announcements: OracleAnnouncement[]
  isNostrConfigured: boolean
  onChoiceSelect?: (choice: OracleCheckChoice) => void
  onAnnouncementSelect?: (announcementId: string) => void
  onContinue?: () => void
  onExit?: () => void
}

export function OracleCheck({
  choice,
  selectedAnnouncementId,
  announcements,
  isNostrConfigured,
  onChoiceSelect,
  onAnnouncementSelect,
  onContinue,
  onExit,
}: OracleCheckProps) {
  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center px-6 text-center">
      <div className="w-20 h-20 rounded-full bg-blue-600/10 flex items-center justify-center mb-8">
        <Satellite className="w-10 h-10 text-blue-400" strokeWidth={1.5} />
      </div>

      <h1 className="text-2xl sm:text-3xl font-bold text-white mb-3 tracking-tight">
        Oracle Announcement
      </h1>

      <p className="text-base text-slate-400 max-w-lg mb-10 leading-relaxed">
        Is the market condition you want to create already announced by a DLC oracle on Nostr?
      </p>

      <div className="flex flex-col sm:flex-row gap-4 w-full max-w-lg mb-8">
        <button
          onClick={() => isNostrConfigured && onChoiceSelect?.('existing')}
          disabled={!isNostrConfigured}
          className={`flex-1 p-5 rounded-xl border-2 transition-all text-left ${
            !isNostrConfigured
              ? 'border-slate-800 bg-slate-900/50 opacity-50 cursor-not-allowed'
              : choice === 'existing'
                ? 'border-blue-500 bg-blue-500/10'
                : 'border-slate-700 bg-slate-900 hover:border-slate-600'
          }`}
        >
          <Radio className={`w-6 h-6 mb-3 ${choice === 'existing' ? 'text-blue-400' : 'text-slate-500'}`} strokeWidth={1.5} />
          <p className="font-semibold text-white text-sm mb-1">Yes, use an existing announcement</p>
          <p className="text-xs text-slate-400">
            {isNostrConfigured
              ? 'Select from available oracle announcements on Nostr'
              : 'Requires Nostr configuration in Settings'}
          </p>
        </button>

        <button
          onClick={() => onChoiceSelect?.('become-oracle')}
          className={`flex-1 p-5 rounded-xl border-2 transition-all text-left ${
            choice === 'become-oracle'
              ? 'border-blue-500 bg-blue-500/10'
              : 'border-slate-700 bg-slate-900 hover:border-slate-600'
          }`}
        >
          <Satellite className={`w-6 h-6 mb-3 ${choice === 'become-oracle' ? 'text-blue-400' : 'text-slate-500'}`} strokeWidth={1.5} />
          <p className="font-semibold text-white text-sm mb-1">No / I want to be an oracle</p>
          <p className="text-xs text-slate-400">Configure your own oracle and create the announcement</p>
        </button>
      </div>

      {choice === 'existing' && (
        <div className="w-full max-w-lg space-y-3 mb-8">
          <h3 className="text-sm font-medium text-slate-300 text-left mb-3">
            Available Announcements
          </h3>
          {announcements.length === 0 && (
            <p className="text-sm text-slate-500 text-left py-4">No announcements found from the oracle.</p>
          )}
          {announcements.map((ann) => (
            <button
              key={ann.id}
              onClick={() => onAnnouncementSelect?.(ann.id)}
              className={`w-full p-4 rounded-lg border transition-all text-left ${
                selectedAnnouncementId === ann.id
                  ? 'border-blue-500 bg-blue-500/10'
                  : 'border-slate-700 bg-slate-900 hover:border-slate-600'
              }`}
            >
              <p className="font-medium text-white text-sm mb-1.5">{ann.description}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                <span>Oracle: {ann.oraclePubkey.slice(0, 16)}...</span>
                <span>Resolves: {new Date(ann.resolutionDate).toLocaleDateString()}</span>
              </div>
              <div className="flex gap-1.5 mt-2">
                {ann.outcomes.map((outcome) => (
                  <span
                    key={outcome}
                    className="px-2 py-0.5 rounded-full bg-slate-800 text-xs text-slate-300"
                  >
                    {outcome}
                  </span>
                ))}
              </div>
            </button>
          ))}

          <button
            onClick={() => selectedAnnouncementId && onContinue?.()}
            disabled={!selectedAnnouncementId}
            className={`w-full py-3 rounded-full font-semibold text-sm transition-colors mt-4 ${
              selectedAnnouncementId
                ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-600/25'
                : 'bg-slate-800 text-slate-500 cursor-not-allowed'
            }`}
          >
            Continue with Selected Announcement
          </button>
        </div>
      )}

      {choice === 'become-oracle' && (
        <div className="w-full max-w-lg mb-8">
          <div className="p-5 rounded-xl bg-slate-900 border border-slate-700 text-left">
            <h3 className="font-semibold text-white text-sm mb-2">Oracle Configuration Required</h3>
            <p className="text-xs text-slate-400 leading-relaxed mb-5">
              To create a market as your own oracle, you need to configure your oracle settings first.
              This includes setting up your signing keys and publishing your oracle announcement to Nostr.
              If you've already done this, you can continue to market creation.
            </p>
            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={() => onExit?.()}
                className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg border border-slate-600 text-sm font-medium text-slate-300 hover:bg-slate-800 transition-colors"
              >
                <Settings className="w-4 h-4" strokeWidth={1.5} />
                Go to Settings
              </button>
              <button
                onClick={() => onContinue?.()}
                className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-sm font-medium text-white transition-colors shadow-lg shadow-blue-600/25"
              >
                I've already configured
                <ArrowRight className="w-4 h-4" strokeWidth={1.5} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
