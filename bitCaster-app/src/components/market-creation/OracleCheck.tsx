import { Radio, Satellite, Settings, Key } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { OracleAnnouncement, OracleCheckChoice } from '@/types/market-creation'
import type { NostrSignerMode } from '@/types/settings'

interface OracleCheckProps {
  choice: OracleCheckChoice | null
  selectedAnnouncementId: string | null
  announcements: OracleAnnouncement[]
  /** Current Nostr signer mode from settings. Controls which choices are enabled. */
  signerMode: NostrSignerMode
  onChoiceSelect?: (choice: OracleCheckChoice) => void
  onAnnouncementSelect?: (announcementId: string) => void
  onContinue?: () => void
  onExit?: () => void
}

/**
 * Step 1 of market creation: pick between an existing oracle announcement or
 * becoming the oracle yourself.
 *
 * - "Use existing" is available whenever any Nostr signer is configured (nip07
 *   or nsec), because the user only needs to subscribe to public events.
 * - "Become an oracle" requires `signerMode === 'nsec'` because kormir needs
 *   the raw secp256k1 secret key to produce DLC Schnorr signatures locally,
 *   and NIP-07 extensions only expose opaque signing.
 */
export function OracleCheck({
  choice,
  selectedAnnouncementId,
  announcements,
  signerMode,
  onChoiceSelect,
  onAnnouncementSelect,
  onContinue,
  onExit,
}: OracleCheckProps) {
  const { t } = useTranslation()
  const canUseExisting = signerMode !== 'none'
  const canBecomeOracle = signerMode === 'nsec'

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center px-6 text-center">
      <div className="w-20 h-20 rounded-full bg-blue-600/10 flex items-center justify-center mb-8">
        <Satellite className="w-10 h-10 text-blue-400" strokeWidth={1.5} />
      </div>

      <h1 className="text-2xl sm:text-3xl font-bold text-white mb-3 tracking-tight">
        {t('marketCreation.oracleAnnouncement')}
      </h1>

      <p className="text-base text-slate-400 max-w-lg mb-10 leading-relaxed">
        {t('marketCreation.oracleAnnouncementDesc')}
      </p>

      <div className="flex flex-col sm:flex-row gap-4 w-full max-w-lg mb-8">
        <button
          onClick={() => canUseExisting && onChoiceSelect?.('existing')}
          disabled={!canUseExisting}
          className={`flex-1 p-5 rounded-xl border-2 transition-all text-left ${
            !canUseExisting
              ? 'border-slate-800 bg-slate-900/50 opacity-50 cursor-not-allowed'
              : choice === 'existing'
                ? 'border-blue-500 bg-blue-500/10'
                : 'border-slate-700 bg-slate-900 hover:border-slate-600'
          }`}
        >
          <Radio className={`w-6 h-6 mb-3 ${choice === 'existing' ? 'text-blue-400' : 'text-slate-500'}`} strokeWidth={1.5} />
          <p className="font-semibold text-white text-sm mb-1">{t('marketCreation.useExisting')}</p>
          <p className="text-xs text-slate-400">
            {canUseExisting
              ? t('marketCreation.useExistingDesc')
              : t('marketCreation.useExistingDisabledDesc')}
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
          <p className="font-semibold text-white text-sm mb-1">{t('marketCreation.becomeOracle')}</p>
          <p className="text-xs text-slate-400">
            {canBecomeOracle
              ? t('marketCreation.becomeOracleDesc')
              : t('marketCreation.becomeOracleDisabledDesc')}
          </p>
        </button>
      </div>

      {choice === 'existing' && (
        <div className="w-full max-w-lg space-y-3 mb-8">
          <h3 className="text-sm font-medium text-slate-300 text-left mb-3">
            {t('marketCreation.availableAnnouncements')}
          </h3>
          {announcements.length === 0 && (
            <p className="text-sm text-slate-500 text-left py-4">{t('marketCreation.noAnnouncements')}</p>
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
                <span>{t('marketCreation.oraclePrefix')}{ann.oraclePubkey.slice(0, 16)}...</span>
                <span>{t('marketCreation.resolvesLabel')}{new Date(ann.resolutionDate).toLocaleDateString()}</span>
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
            {t('marketCreation.continueWithAnnouncement')}
          </button>
        </div>
      )}

      {choice === 'become-oracle' && !canBecomeOracle && (
        <div className="w-full max-w-lg mb-8">
          <div className="p-5 rounded-xl bg-slate-900 border border-slate-700 text-left">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center">
                <Key className="w-5 h-5 text-amber-400" strokeWidth={1.75} />
              </div>
              <h3 className="font-semibold text-white text-sm">
                {t('marketCreation.mustRegisterNostrKey')}
              </h3>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed mb-5">
              {t('marketCreation.nsecRequired')}
              {signerMode === 'nip07' ? t('marketCreation.nip07Warning') : ''}{' '}
              {t('marketCreation.addNsecInSettings')}
            </p>
            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={() => onExit?.()}
                className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-sm font-medium text-white transition-colors shadow-lg shadow-blue-600/25"
              >
                <Settings className="w-4 h-4" strokeWidth={1.5} />
                {t('marketCreation.goToNostrSettings')}
              </button>
            </div>
          </div>
        </div>
      )}

      {choice === 'become-oracle' && canBecomeOracle && (
        <div className="w-full max-w-lg mb-8">
          <button
            onClick={() => onContinue?.()}
            className="w-full py-3 rounded-full font-semibold text-sm bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-600/25 transition-colors"
          >
            {t('marketCreation.continueAsOracle')}
          </button>
        </div>
      )}
    </div>
  )
}
