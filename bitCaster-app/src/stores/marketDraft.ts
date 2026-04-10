import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { WizardDraft } from '@/types/market-creation'

export function defaultDraft(): WizardDraft {
  return {
    currentStep: 1,
    lastModified: new Date().toISOString(),
    stepOracleCheck: null,
    stepGetStarted: null,
    stepBasicInfo: null,
    stepOutcomes: null,
    stepInitialLiquidity: null,
    stepReviewAndCreate: null,
  }
}

interface MarketDraftState {
  draft: WizardDraft
  /** True iff the user has made at least one change since the last clear. */
  hasSavedDraft: boolean
  setDraft: (updater: (prev: WizardDraft) => WizardDraft) => void
  clearDraft: () => void
}

export const useMarketDraftStore = create<MarketDraftState>()(
  persist(
    (set, get) => ({
      draft: defaultDraft(),
      hasSavedDraft: false,
      setDraft: (updater) => {
        const prev = get().draft
        const next = updater(prev)
        // Honor same-reference returns as no-ops so handlers can early-return
        // `prev` to skip a write (e.g. clicking an already-selected option).
        if (next === prev) return
        set({ draft: next, hasSavedDraft: true })
      },
      clearDraft: () => set({ draft: defaultDraft(), hasSavedDraft: false }),
    }),
    {
      name: 'bitcaster-market-draft',
      // Thumbnail previews are stored as `blob:` object URLs that die with
      // the page that created them. Drop any stale reference on rehydrate so
      // the resumed wizard doesn't render a broken image.
      onRehydrateStorage: () => (state) => {
        const img = state?.draft.stepBasicInfo?.imageFile
        if (img && img.startsWith('blob:') && state?.draft.stepBasicInfo) {
          state.draft.stepBasicInfo.imageFile = null
        }
      },
    },
  ),
)
