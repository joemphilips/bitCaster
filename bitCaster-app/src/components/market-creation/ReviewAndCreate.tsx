import { FileText, Tag, Calendar, BarChart3, Coins, Loader2 } from 'lucide-react'
import type {
  WizardStepBasicInfo,
  WizardStepOutcomes,
  WizardStepInitialLiquidity,
} from '@/types/market-creation'

interface ReviewAndCreateProps {
  description: string
  basicInfo: WizardStepBasicInfo | null
  outcomes: WizardStepOutcomes | null
  liquidity: WizardStepInitialLiquidity | null
  isSubmitting: boolean
  submitError: string | null
  onDescriptionChange?: (description: string) => void
  onCreateMarket?: () => void
}

export function ReviewAndCreate({
  description,
  basicInfo,
  outcomes,
  liquidity,
  isSubmitting,
  submitError,
  onDescriptionChange,
  onCreateMarket,
}: ReviewAndCreateProps) {
  const canCreate = description.trim().length > 0 && !isSubmitting

  return (
    <div className="w-full max-w-xl">
      <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">Review & Create</h2>
      <p className="text-sm text-slate-400 mb-8">
        Add a description and review your market before creating it.
      </p>

      {/* Error banner */}
      {submitError && (
        <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 mb-6">
          <p className="text-sm text-red-400">{submitError}</p>
        </div>
      )}

      {/* Description */}
      <div className="mb-8">
        <label className="block text-sm font-medium text-slate-300 mb-2">Description</label>
        <textarea
          value={description}
          onChange={(e) => onDescriptionChange?.(e.target.value)}
          placeholder="Describe your market in detail. Include resolution criteria, relevant context, and any edge cases..."
          rows={6}
          className="w-full px-4 py-3 rounded-lg bg-slate-900 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors resize-none"
        />
        <p className="text-xs text-slate-500 mt-1.5">Provide clear resolution criteria for traders</p>
      </div>

      {/* Market summary card */}
      <div className="p-5 rounded-xl bg-slate-900 border border-slate-700 mb-8">
        <h3 className="text-sm font-semibold text-white mb-4">Market Summary</h3>

        <div className="space-y-4">
          {basicInfo && (
            <div className="flex items-start gap-3">
              <FileText className="w-4 h-4 text-slate-500 mt-0.5 shrink-0" strokeWidth={1.5} />
              <div>
                <p className="text-xs text-slate-400">Title</p>
                <p className="text-sm text-white">{basicInfo.title || 'Untitled'}</p>
              </div>
            </div>
          )}

          {basicInfo && basicInfo.categoryTags.length > 0 && (
            <div className="flex items-start gap-3">
              <Tag className="w-4 h-4 text-slate-500 mt-0.5 shrink-0" strokeWidth={1.5} />
              <div>
                <p className="text-xs text-slate-400">Categories</p>
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {basicInfo.categoryTags.map((tag) => (
                    <span key={tag} className="px-2 py-0.5 rounded-full bg-slate-800 text-xs text-slate-300">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {basicInfo && basicInfo.closingDate && (
            <div className="flex items-start gap-3">
              <Calendar className="w-4 h-4 text-slate-500 mt-0.5 shrink-0" strokeWidth={1.5} />
              <div>
                <p className="text-xs text-slate-400">Closing Date</p>
                <p className="text-sm text-white">
                  {new Date(basicInfo.closingDate).toLocaleString()}
                </p>
              </div>
            </div>
          )}

          {outcomes && (
            <div className="flex items-start gap-3">
              <BarChart3 className="w-4 h-4 text-slate-500 mt-0.5 shrink-0" strokeWidth={1.5} />
              <div>
                <p className="text-xs text-slate-400">Outcomes</p>
                {outcomes.outcomeType === 'numeric' ? (
                  <p className="text-sm text-white">
                    Numeric: {outcomes.loBound ?? '?'} – {outcomes.hiBound ?? '?'} {outcomes.unit ?? ''}
                    {outcomes.precision !== undefined && ` (${outcomes.precision} decimals)`}
                  </p>
                ) : (
                  <>
                    <p className="text-sm text-white capitalize">
                      {outcomes.outcomeType === 'yesno'
                        ? 'Yes / No'
                        : `${outcomes.outcomes?.length ?? 0} outcomes`}
                    </p>
                    {outcomes.outcomes && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {outcomes.outcomes.map((o) => (
                          <span key={o.id} className="px-2 py-0.5 rounded-full bg-slate-800 text-xs text-slate-300">
                            {o.label || 'Unnamed'}{o.probability !== undefined ? ` (${o.probability}%)` : ''}
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {liquidity && (
            <div className="flex items-start gap-3">
              <Coins className="w-4 h-4 text-slate-500 mt-0.5 shrink-0" strokeWidth={1.5} />
              <div>
                <p className="text-xs text-slate-400">Initial Liquidity</p>
                <p className="text-sm font-semibold text-white">{liquidity.liquiditySats.toLocaleString()} sats</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Create button */}
      <button
        onClick={() => onCreateMarket?.()}
        disabled={!canCreate}
        className={`w-full py-3.5 rounded-full font-semibold text-sm transition-colors flex items-center justify-center gap-2 ${
          canCreate
            ? 'bg-green-600 hover:bg-green-700 text-white shadow-lg shadow-green-600/25'
            : 'bg-slate-800 text-slate-500 cursor-not-allowed'
        }`}
      >
        {isSubmitting ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Creating Market...
          </>
        ) : (
          'Create Market'
        )}
      </button>
    </div>
  )
}
