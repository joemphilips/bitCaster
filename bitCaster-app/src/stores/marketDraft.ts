import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { marketDraftImages } from "./marketDraftImage";
import type { WizardDraft } from "@/types/market-creation";

export function defaultDraft(): WizardDraft {
  return {
    currentStep: 1,
    lastModified: new Date().toISOString(),
    stepGetStarted: null,
    stepBasicInfo: null,
    stepOutcomes: null,
    stepReviewAndCreate: null,
  };
}

interface MarketDraftState {
  draft: WizardDraft;
  /** True iff the user has made at least one change since the last clear. */
  hasSavedDraft: boolean;
  setDraft: (updater: (prev: WizardDraft) => WizardDraft) => void;
  clearDraft: () => void;
  completeCreation: (creationId: string) => void;
  hasCreationPersistence: () => boolean;
}

// Persist's unavailable-storage fallback still accepts memory-only writes.
// Creation must know whether this instance retained a real storage adapter.
const draftStorage = createJSONStorage<MarketDraftState>(() => window.localStorage);

export const useMarketDraftStore = create<MarketDraftState>()(
  persist(
    (set, get) => ({
      draft: defaultDraft(),
      hasSavedDraft: false,
      hasCreationPersistence: () => draftStorage !== undefined,
      setDraft: (updater) => {
        const prev = get().draft;
        const next = updater(prev);
        // Honor same-reference returns as no-ops so handlers can early-return
        // `prev` to skip a write (e.g. clicking an already-selected option).
        if (next === prev) return;
        set({ draft: next, hasSavedDraft: true });
      },
      // Starting over must not lose the reference to unfinished paid work.
      clearDraft: () => {
        const { creation, thumbnailId } = get().draft;
        set({
          draft: {
            ...defaultDraft(),
            ...(creation === undefined
              ? {}
              : { creation, ...(thumbnailId ? { thumbnailId } : {}) }),
          },
          hasSavedDraft: creation !== undefined,
        });
        if (!creation && thumbnailId) void marketDraftImages.remove(thumbnailId).catch(() => {});
      },
      completeCreation: (creationId) => {
        if (get().draft.creation?.creationId !== creationId)
          throw new Error("Creation draft reference changed during completion.");
        const thumbnailId = get().draft.thumbnailId;
        set({ draft: defaultDraft(), hasSavedDraft: false });
        if (thumbnailId) void marketDraftImages.remove(thumbnailId).catch(() => {});
      },
    }),
    {
      name: "bitcaster-market-draft",
      storage: draftStorage,
      // Thumbnail previews are stored as `blob:` object URLs that die with
      // the page that created them. Drop any stale reference on rehydrate so
      // the resumed wizard doesn't render a broken image.
      onRehydrateStorage: () => (state) => {
        const currentStep = Number(state?.draft.currentStep);
        if (state && currentStep > 4) {
          state.draft.currentStep = 4;
        }
        const img = state?.draft.stepBasicInfo?.imageFile;
        if (img && img.startsWith("blob:") && state?.draft.stepBasicInfo) {
          state.draft.stepBasicInfo.imageFile = null;
        }
      },
    },
  ),
);
