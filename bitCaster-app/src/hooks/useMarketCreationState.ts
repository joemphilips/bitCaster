import { DraftImageRetentionError, marketDraftImages } from "@/stores/marketDraftImage";
import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import type {
  WizardDraft,
  WizardStep,
  WizardStepBasicInfo,
  OutcomeType,
  WizardOutcome,
  MarketBaseAsset,
} from "@/types/market-creation";
import { useSettingsStore } from "@/stores/settings";
import { useMarketDraftStore } from "@/stores/marketDraft";
import { useCreatorMarketsStore } from "@/stores/creatorMarkets";
import { requestBrowserOracleBackup } from "@/lib/browserOracleBackupDelivery";
import {
  MAX_MARKET_CREATION_OUTCOMES,
  assertMarketCreationMetadataSize,
  normalizeMarketCreationInput,
  type MarketCreationRecord,
  type MarketCreationInput,
  prepareMarketCreationRequest,
} from "@bitcaster/client-sdk";
import {
  browserMarketCreationSession,
  completeBrowserMarketCreation,
  prepareBrowserMarketCreation,
  type BrowserMarketCreationPointer,
} from "@/lib/browserMarketCreation";
import { detectMintCapabilities } from "@/lib/mints";
import { useWalletStore } from "@/stores/wallet";
import { refreshMintInfoWithoutActivating } from "@/lib/walletOps";
import {
  MAX_CONDITION_REGISTRATION_FEE_SUBUNITS,
  getAvailableRegularBalanceSubunits,
  registrationFeeForPolicy,
  requiredMarketCreationOutcomeCollections,
} from "@/lib/marketRegistrationFee";
import {
  DEFAULT_MARKET_BASE_ASSET,
  formatMarketSubunits,
  normalizeMarketDivisibility,
  type MarketDivisibility,
} from "@bitcaster/client-sdk/marketUnits";
import { effectiveRelayUrls } from "@/lib/relayDefaults";
import {
  categoricalOutcomeColors,
  nextCategoricalOutcomeColor,
} from "@/components/shared/OutcomeLabel";

/**
 * Default creator fee applied to every market created via the wizard. The
 * matching engine does not track or accrue creator fees yet, so the value
 * is stamped onto the local creator-markets store and rendered as
 * informational metadata only. P7 §`/creator` flagged "0.02% fee" displayed
 * on every market as misleading — the engine accrues nothing. The constant
 * is kept (rather than removed) so a future engine-side fee model is a
 * one-line change here. CreatedMarketRow hides the row when the value is 0.
 */
const DEFAULT_CREATOR_FEE_PERCENT = 0;
export const MAX_MARKET_OUTCOMES = MAX_MARKET_CREATION_OUTCOMES;

const NSEC_ORACLE_REQUIRED_MESSAGE = "You must register a nostr key to become an oracle";
type RegistrationFeePrompt = {
  feeSubunits: number;
  balanceSubunits: number;
  baseAsset: MarketBaseAsset;
};
type RegistrationFeeTopUpStage = "closed" | "modal" | "overlay";

async function activeMintCapabilities() {
  const wallet = useWalletStore.getState();
  let mint = wallet.mints.find((candidate) => candidate.url === wallet.activeMintUrl);
  let capabilities = detectMintCapabilities(mint?.info);
  if (!mint && wallet.activeMintUrl) {
    await refreshMintInfoWithoutActivating(wallet.activeMintUrl);
    const refreshed = useWalletStore.getState();
    mint = refreshed.mints.find((candidate) => candidate.url === refreshed.activeMintUrl);
    capabilities = detectMintCapabilities(mint?.info);
  }
  if (mint && !capabilities.ctfSettings) {
    await refreshMintInfoWithoutActivating(mint.url);
    const refreshed = useWalletStore.getState();
    mint = refreshed.mints.find((candidate) => candidate.url === refreshed.activeMintUrl);
    capabilities = detectMintCapabilities(mint?.info);
  }
  return capabilities;
}

function defaultYesNoOutcomes(): WizardOutcome[] {
  return [
    { id: "yes", label: "Yes", description: "" },
    { id: "no", label: "No", description: "" },
  ];
}

function isCanonicalYesNoOutcomes(outcomes: WizardOutcome[] | null | undefined): boolean {
  return (
    outcomes?.length === 2 &&
    outcomes[0]?.id === "yes" &&
    outcomes[0].label === "Yes" &&
    outcomes[1]?.id === "no" &&
    outcomes[1].label === "No"
  );
}

function normalizeRestoredBinaryDraft(draft: WizardDraft): WizardDraft {
  if (draft.stepGetStarted?.outcomeType !== "yesno" || draft.currentStep < 3) return draft;

  const stepOutcomes =
    draft.stepOutcomes?.outcomeType === "yesno" &&
    isCanonicalYesNoOutcomes(draft.stepOutcomes.outcomes)
      ? draft.stepOutcomes
      : {
          outcomeType: "yesno" as const,
          outcomes: defaultYesNoOutcomes(),
          baseAsset: draft.stepOutcomes?.baseAsset ?? DEFAULT_MARKET_BASE_ASSET,
        };
  const currentStep = 3 as WizardStep;
  const stepReviewAndCreate = draft.stepReviewAndCreate ?? { description: "" };

  if (
    draft.currentStep === currentStep &&
    draft.stepOutcomes === stepOutcomes &&
    draft.stepReviewAndCreate === stepReviewAndCreate
  ) {
    return draft;
  }

  return {
    ...draft,
    currentStep,
    stepOutcomes,
    stepReviewAndCreate,
    lastModified: new Date().toISOString(),
  };
}

function normalizeCategoricalDraftColors(draft: WizardDraft): WizardDraft {
  if (draft.stepOutcomes?.outcomeType !== "categorical" || !draft.stepOutcomes.outcomes) {
    return draft;
  }
  const outcomes = draft.stepOutcomes.outcomes;
  const colors = categoricalOutcomeColors(outcomes);
  if (outcomes.every((outcome, index) => outcome.color === colors[index])) return draft;
  return {
    ...draft,
    stepOutcomes: {
      ...draft.stepOutcomes,
      outcomes: outcomes.map((outcome, index) => ({
        ...outcome,
        color: colors[index],
      })),
    },
    lastModified: new Date().toISOString(),
  };
}

function wizardMarketInput(draft: WizardDraft): MarketCreationInput {
  const outcomes = draft.stepOutcomes?.outcomes;
  if (outcomes == null)
    throw new Error("At least two outcomes are required to create an oracle event.");
  const closingDate = draft.stepBasicInfo?.closingDate;
  if (!closingDate)
    throw new Error("A closing date is required to publish an oracle announcement.");
  return {
    title: draft.stepBasicInfo?.title ?? "",
    description: draft.stepReviewAndCreate?.description ?? "",
    outcomeType: draft.stepOutcomes?.outcomeType ?? draft.stepGetStarted?.outcomeType ?? "yesno",
    outcomeDetails: outcomes.map((outcome) => ({
      name: outcome.label,
      color: outcome.color,
    })),
    maturityEpoch: Math.floor(new Date(closingDate).getTime() / 1000),
    categoryTags: draft.stepBasicInfo?.categoryTags ?? [],
    baseAsset: draft.stepOutcomes?.baseAsset,
  };
}

function rememberCreationFailure(
  record: MarketCreationRecord | null,
  code: "incomplete" | "payment-pending",
) {
  let dismissed = false;
  useMarketDraftStore.getState().setDraft((previous) => {
    if (previous.creation === undefined) return previous;
    const progress =
      record === null
        ? (previous.creation.failure?.progress ?? "prepared")
        : record.engineResult !== null
          ? ("engine-confirmed" as const)
          : record.mintConfirmed
            ? ("mint-confirmed" as const)
            : ("prepared" as const);
    const old = previous.creation.failure;
    dismissed = old?.code === code && old.progress === progress && old.dismissed;
    return {
      ...previous,
      creation: {
        ...previous.creation,
        failure: { code, progress, dismissed },
      },
    };
  });
  return dismissed;
}

function creationFailureMessage(code: "incomplete" | "payment-pending") {
  switch (code) {
    case "incomplete":
      return "marketCreation.creationIncompleteError";
    case "payment-pending":
      return "marketCreation.creationPaymentPending";
  }
}

function isConfirmedCreationProgress(
  progress: NonNullable<BrowserMarketCreationPointer["failure"]>["progress"] | undefined,
) {
  switch (progress) {
    case undefined:
    case "prepared":
      return false;
    case "mint-confirmed":
    case "engine-confirmed":
      return true;
  }
}

function draftImageErrorKey(error: unknown) {
  if (error instanceof DraftImageRetentionError) {
    if (error.code === "missing") return "marketCreation.imageRetentionMissing";
    if (error.code === "invalid") return "marketCreation.imageRetentionInvalid";
  }
  return "marketCreation.imageRetentionFailed";
}

function isCurrentDraftThumbnail(selectionId: string | undefined): boolean {
  const persisted = JSON.parse(localStorage.getItem("bitcaster-market-draft") ?? "null");
  return (
    useMarketDraftStore.getState().draft.thumbnailId === selectionId &&
    persisted?.state?.draft?.thumbnailId === selectionId
  );
}

export function useMarketCreationState() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const nostrSignerMode = useSettingsStore((s) => s.nostrSignerMode);
  const relays = useSettingsStore((s) => s.relays);

  // The draft store lives in localStorage so closing the wizard mid-flow
  // does not lose work. `setDraft` and `clearDraft` are stable zustand
  // actions; the consumer callbacks below rely on that to keep empty deps.
  const draft = useMarketDraftStore((s) => s.draft);
  const setDraft = useMarketDraftStore((s) => s.setDraft);
  const clearDraft = useMarketDraftStore((s) => s.clearDraft);
  const completeCreation = useMarketDraftStore((s) => s.completeCreation);
  // Snapshot once at mount: whether the wizard is being re-entered with a
  // saved draft. We don't subscribe to `hasSavedDraft` because the first
  // keystroke would flip it to true and make the resume banner re-appear.
  const [hasSavedDraft] = useState(() => useMarketDraftStore.getState().hasSavedDraft);

  useEffect(() => {
    if (draft.stepGetStarted?.outcomeType !== "yesno" || draft.currentStep < 3) return;
    setDraft((previous) => normalizeRestoredBinaryDraft(previous));
  }, [
    draft.currentStep,
    draft.stepGetStarted?.outcomeType,
    draft.stepOutcomes,
    draft.stepReviewAndCreate,
    setDraft,
  ]);

  useEffect(() => {
    setDraft(normalizeCategoricalDraftColors);
  }, [draft.stepOutcomes, setDraft]);

  const [thumbnailFile, setThumbnailFile] = useState<File | null>(null);
  const [thumbnailPreview, setThumbnailPreview] = useState<string | null>(null);
  const [thumbnailPending, setThumbnailPending] = useState(false);
  const [thumbnailError, setThumbnailError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [retainedRecord, setRetainedRecord] = useState<MarketCreationRecord | null>(null);
  const [isLoadingCreation, setIsLoadingCreation] = useState(false);
  useEffect(() => {
    if (draft.creation === undefined) {
      setRetainedRecord(null);
      return;
    }
    const failure = draft.creation.failure;
    if (failure !== undefined)
      setSubmitError(failure.dismissed ? null : t(creationFailureMessage(failure.code)));
    let cancelled = false;
    const read = async () => {
      setIsLoadingCreation(true);
      try {
        const record = await browserMarketCreationSession(draft.creation).store.read(
          draft.creation!.creationId,
        );
        if (!cancelled) setRetainedRecord((previous) => (record === null ? previous : record));
      } catch {
        if (!cancelled && !failure?.dismissed)
          setSubmitError(t("marketCreation.creationResumeUnavailable"));
      } finally {
        if (!cancelled) setIsLoadingCreation(false);
      }
    };
    // Wallet hydration must select its database before a boot-time creation read.
    const persistence = useWalletStore.persist;
    const unsubscribe = persistence?.onFinishHydration(() => {
      void read();
    });
    if (persistence === undefined || persistence.hasHydrated()) void read();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [draft.creation, t]);
  const [registrationFeePrompt, setRegistrationFeePrompt] = useState<RegistrationFeePrompt | null>(
    null,
  );
  const [registrationFeeTopUpStage, setRegistrationFeeTopUpStage] =
    useState<RegistrationFeeTopUpStage>("closed");
  const [registrationFeeTopUp, setRegistrationFeeTopUp] = useState<RegistrationFeePrompt | null>(
    null,
  );
  // Set after `createMarket` succeeds — the wizard then renders the
  // post-create funding step where the user can fund the LMSR bot or choose
  // no liquidity.
  // Holding this in component state, not the localStorage draft, because:
  //   - The market is already registered on the engine; restarting the
  //     wizard with a stale draft would attempt re-registration and 409.
  //   - Refresh / close on this step is acceptable: the market exists in
  //     `Unfunded` state and the user can return via the dashboard.
  const [createdMarketConditionId, setCreatedMarketConditionId] = useState<string | null>(null);
  const [createdMarketOutcomeCount, setCreatedMarketOutcomeCount] = useState<number | null>(null);
  const [createdMarketBaseAsset, setCreatedMarketBaseAsset] = useState<MarketBaseAsset | null>(
    null,
  );
  const [createdMarketDivisibility, setCreatedMarketDivisibility] =
    useState<MarketDivisibility | null>(null);
  // Track the last blob URL created for the thumbnail preview so we can revoke
  // it when the user picks a new file or when the component unmounts. Without
  // this, every upload leaks a live Blob reference for the page's lifetime.
  const thumbnailObjectUrlRef = useRef<string | null>(null);
  useEffect(() => {
    return () => {
      if (thumbnailObjectUrlRef.current) {
        URL.revokeObjectURL(thumbnailObjectUrlRef.current);
        thumbnailObjectUrlRef.current = null;
      }
    };
  }, []);

  const updateDraft = useCallback((patch: Partial<WizardDraft>) => {
    setDraft((prev) => ({
      ...prev,
      ...patch,
      lastModified: new Date().toISOString(),
    }));
  }, []);

  const onClose = useCallback(() => {
    // Fall back to /creator when deep-linked with no history to walk back to.
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate("/creator");
    }
  }, [navigate]);

  // --- Navigation ---
  const onNext = useCallback(() => {
    setDraft((prev) => {
      const outcomeType = prev.stepGetStarted?.outcomeType ?? "yesno";
      const next = Math.min(prev.currentStep + 1, 4) as WizardStep;
      const updated: WizardDraft = {
        ...prev,
        currentStep: next,
        lastModified: new Date().toISOString(),
      };

      // Initialize step data on entry
      if (next === 2 && !updated.stepBasicInfo) {
        updated.stepBasicInfo = {
          imageFile: null,
          title: "",
          categoryTags: [],
          closingDate: "",
        };
      }
      if (next === 3 && outcomeType === "yesno" && !updated.stepOutcomes) {
        updated.stepOutcomes = {
          outcomeType,
          outcomes: defaultYesNoOutcomes(),
          baseAsset: DEFAULT_MARKET_BASE_ASSET,
        };
      } else if (next === 3 && !updated.stepOutcomes) {
        if (outcomeType === "numeric") {
          updated.stepOutcomes = {
            outcomeType,
            outcomes: null,
            baseAsset: DEFAULT_MARKET_BASE_ASSET,
          };
        } else {
          updated.stepOutcomes = {
            outcomeType,
            outcomes: outcomeType === "yesno" ? defaultYesNoOutcomes() : [],
            baseAsset: DEFAULT_MARKET_BASE_ASSET,
          };
        }
      }
      if (next >= 3 && !updated.stepReviewAndCreate) {
        updated.stepReviewAndCreate = { description: "" };
      }
      return updated;
    });
  }, []);

  const onBack = useCallback(() => {
    setDraft((prev) => ({
      ...prev,
      currentStep: (prev.stepGetStarted?.outcomeType === "yesno" && prev.currentStep >= 3
        ? 2
        : Math.max(Math.min(prev.currentStep, 4) - 1, 1)) as WizardStep,
      lastModified: new Date().toISOString(),
    }));
  }, []);

  // --- Get Started (Step 2) ---
  const onOutcomeTypeSelect = useCallback((type: OutcomeType) => {
    setDraft((prev) => {
      // Clicking the already-selected type must not reset `stepOutcomes`,
      // or the user loses any outcome work they had.
      if (prev.stepGetStarted?.outcomeType === type) return prev;
      return {
        ...prev,
        stepGetStarted: { outcomeType: type },
        stepOutcomes: null,
        lastModified: new Date().toISOString(),
      };
    });
  }, []);

  // --- Basic Info (Step 3) ---
  // All basic-info field setters share the same guarded-merge shape; this
  // helper lets them be written as one-liners.
  const updateBasicInfo = useCallback((patch: Partial<WizardStepBasicInfo>) => {
    setDraft((prev) => ({
      ...prev,
      stepBasicInfo: prev.stepBasicInfo ? { ...prev.stepBasicInfo, ...patch } : null,
      lastModified: new Date().toISOString(),
    }));
  }, []);

  const onTitleChange = useCallback(
    (title: string) => updateBasicInfo({ title }),
    [updateBasicInfo],
  );

  const onCategoryTagsChange = useCallback(
    (categoryTags: string[]) => updateBasicInfo({ categoryTags }),
    [updateBasicInfo],
  );

  const onClosingDateChange = useCallback(
    (closingDate: string) => updateBasicInfo({ closingDate }),
    [updateBasicInfo],
  );

  const onThumbnailUpload = useCallback(
    async (file: File) => {
      if (useMarketDraftStore.getState().draft.creation) return;
      const selectionId = crypto.randomUUID();
      setThumbnailPending(true);
      setThumbnailError(null);
      setThumbnailFile(null);
      setThumbnailPreview(null);
      try {
        // Retain intent first. Missing bytes after a reload cannot become "no image".
        setDraft((previous) => ({
          ...previous,
          thumbnailId: selectionId,
          lastModified: new Date().toISOString(),
        }));
        await marketDraftImages.retain(selectionId, file, () =>
          isCurrentDraftThumbnail(selectionId),
        );
      } catch (error) {
        if (useMarketDraftStore.getState().draft.thumbnailId === selectionId) {
          setThumbnailError(t(draftImageErrorKey(error)));
          setThumbnailPending(false);
        }
      }
    },
    [setDraft, t],
  );

  const onThumbnailRemove = useCallback(async () => {
    const current = useMarketDraftStore.getState().draft;
    if (current.creation) return;
    const selectionId = current.thumbnailId;
    try {
      setDraft((previous) => {
        const remaining = { ...previous, lastModified: new Date().toISOString() };
        delete remaining.thumbnailId;
        return remaining;
      });
      setThumbnailError(null);
    } catch {
      setThumbnailError(t("marketCreation.imageRetentionFailed"));
      return;
    }
    // The durable draft no longer selects this image. Cleanup is best effort:
    // a late failure must not block a newer selection or restore removed intent.
    if (selectionId) await marketDraftImages.remove(selectionId).catch(() => {});
  }, [setDraft, t]);

  useEffect(() => {
    let cancelled = false;
    const selectionId = draft.thumbnailId;
    setThumbnailFile(null);
    setThumbnailPreview(null);
    setThumbnailError(null);
    if (thumbnailObjectUrlRef.current) {
      URL.revokeObjectURL(thumbnailObjectUrlRef.current);
      thumbnailObjectUrlRef.current = null;
    }
    if (!selectionId || draft.creation) {
      setThumbnailPending(false);
      return;
    }
    setThumbnailPending(true);
    void marketDraftImages
      .read(selectionId)
      .then((thumbnail) => {
        if (cancelled) return;
        const file = new File([thumbnail.data.slice().buffer as ArrayBuffer], thumbnail.filename, {
          type: thumbnail.contentType,
        });
        const url = URL.createObjectURL(file);
        thumbnailObjectUrlRef.current = url;
        setThumbnailFile(file);
        setThumbnailPreview(url);
      })
      .catch((error: unknown) => {
        if (!cancelled) setThumbnailError(t(draftImageErrorKey(error)));
      })
      .finally(() => {
        if (!cancelled) setThumbnailPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [draft.thumbnailId, draft.creation, t]);

  // --- Outcomes (Step 4) ---
  const onAddOutcome = useCallback(() => {
    setDraft((prev) => {
      if (!prev.stepOutcomes?.outcomes) return prev;
      if (prev.stepOutcomes.outcomes.length >= MAX_MARKET_OUTCOMES) return prev;
      const newOutcome: WizardOutcome = {
        id: `outcome-${Date.now()}`,
        label: "",
        description: "",
        color: nextCategoricalOutcomeColor(
          prev.stepOutcomes.outcomes.map((outcome) => outcome.color),
        ),
      };
      return {
        ...prev,
        stepOutcomes: {
          ...prev.stepOutcomes,
          outcomes: [...prev.stepOutcomes.outcomes, newOutcome],
        },
        lastModified: new Date().toISOString(),
      };
    });
  }, []);

  const onRemoveOutcome = useCallback((outcomeId: string) => {
    setDraft((prev) => {
      if (!prev.stepOutcomes?.outcomes) return prev;
      const filtered = prev.stepOutcomes.outcomes.filter((o) => o.id !== outcomeId);
      return {
        ...prev,
        stepOutcomes: {
          ...prev.stepOutcomes,
          outcomes: filtered,
        },
        lastModified: new Date().toISOString(),
      };
    });
  }, []);

  const onOutcomeLabelChange = useCallback((outcomeId: string, label: string) => {
    setDraft((prev) => {
      if (!prev.stepOutcomes?.outcomes) return prev;
      return {
        ...prev,
        stepOutcomes: {
          ...prev.stepOutcomes,
          outcomes: prev.stepOutcomes.outcomes.map((o) =>
            o.id === outcomeId ? { ...o, label } : o,
          ),
        },
        lastModified: new Date().toISOString(),
      };
    });
  }, []);

  const onOutcomeColorChange = useCallback(
    (outcomeId: string, color: string | null) => {
      setDraft((prev) => {
        if (prev.stepOutcomes?.outcomeType !== "categorical" || !prev.stepOutcomes.outcomes) {
          return prev;
        }
        const selectedColor =
          color ??
          nextCategoricalOutcomeColor(prev.stepOutcomes.outcomes.map((outcome) => outcome.color));

        return {
          ...prev,
          stepOutcomes: {
            ...prev.stepOutcomes,
            outcomes: prev.stepOutcomes.outcomes.map((outcome) => {
              if (outcome.id !== outcomeId) return outcome;
              return {
                ...outcome,
                color: selectedColor,
              };
            }),
          },
          lastModified: new Date().toISOString(),
        };
      });
    },
    [setDraft],
  );

  const onLoBoundChange = useCallback((value: number) => {
    setDraft((prev) => ({
      ...prev,
      stepOutcomes: prev.stepOutcomes ? { ...prev.stepOutcomes, loBound: value } : null,
      lastModified: new Date().toISOString(),
    }));
  }, []);

  const onHiBoundChange = useCallback((value: number) => {
    setDraft((prev) => ({
      ...prev,
      stepOutcomes: prev.stepOutcomes ? { ...prev.stepOutcomes, hiBound: value } : null,
      lastModified: new Date().toISOString(),
    }));
  }, []);

  const onPrecisionChange = useCallback((value: number) => {
    setDraft((prev) => ({
      ...prev,
      stepOutcomes: prev.stepOutcomes ? { ...prev.stepOutcomes, precision: value } : null,
      lastModified: new Date().toISOString(),
    }));
  }, []);

  const onUnitChange = useCallback((value: string) => {
    setDraft((prev) => ({
      ...prev,
      stepOutcomes: prev.stepOutcomes ? { ...prev.stepOutcomes, unit: value } : null,
      lastModified: new Date().toISOString(),
    }));
  }, []);

  // --- Review & Create (Step 4) ---
  const onDescriptionChange = useCallback(
    (description: string) => {
      updateDraft({ stepReviewAndCreate: { description } });
    },
    [updateDraft],
  );

  const submitMarket = useCallback(
    async (options: { registrationFeeConfirmed: boolean; resume?: boolean }) => {
      if (isSubmitting) return;
      setIsSubmitting(true);
      setSubmitError(null);
      const draft = useMarketDraftStore.getState().draft;
      let session: ReturnType<typeof browserMarketCreationSession> | undefined;
      try {
        if (!useMarketDraftStore.getState().hasCreationPersistence())
          throw new Error(t("marketCreation.creationStorageUnavailable"));
        session = browserMarketCreationSession(draft.creation);
        let record =
          draft.creation === undefined ? null : await session.store.read(draft.creation.creationId);
        if (record !== null && !options.resume)
          throw new Error(t("marketCreation.creationResumeRequired"));
        if (record === null) {
          const market = wizardMarketInput(draft);
          const normalized = normalizeMarketCreationInput(market);
          assertMarketCreationMetadataSize(normalized.metadata);
          if (nostrSignerMode !== "nsec" || !useSettingsStore.getState().nsecSecret)
            throw new Error(NSEC_ORACLE_REQUIRED_MESSAGE);
          if (thumbnailPending || thumbnailError)
            throw new Error(thumbnailError ?? t("marketCreation.creationStorageUnavailable"));
          const thumbnail = draft.thumbnailId
            ? await marketDraftImages.read(draft.thumbnailId)
            : undefined;
          if (!isCurrentDraftThumbnail(draft.thumbnailId))
            throw new Error(t("marketCreation.creationStorageUnavailable"));
          await prepareMarketCreationRequest(normalized.metadata, thumbnail);
          const capabilities = await activeMintCapabilities();
          if (!capabilities.ctfSettings)
            throw new Error(
              capabilities.ctf
                ? "Active mint CTF settings are missing or invalid. Refresh mint info or choose another mint."
                : "Active mint does not advertise CTF support.",
            );
          session.requireBinding();
          const settings = capabilities.ctfSettings;
          const feeAmount = registrationFeeForPolicy(
            normalized.outcomeLabels,
            settings,
            normalized.collateralUnit,
          );
          if (feeAmount > MAX_CONDITION_REGISTRATION_FEE_SUBUNITS)
            throw new Error(
              t("marketCreation.registrationFeeOverLimit", {
                requiredFee: formatMarketSubunits(feeAmount, normalized.metadata.baseAsset),
                maxFee: formatMarketSubunits(
                  MAX_CONDITION_REGISTRATION_FEE_SUBUNITS,
                  normalized.metadata.baseAsset,
                ),
              }),
            );
          if (feeAmount > 0 && !options.registrationFeeConfirmed) {
            const balance = await getAvailableRegularBalanceSubunits(
              session.binding.mintUrl,
              normalized.metadata.baseAsset,
            );
            const prompt = {
              feeSubunits: feeAmount,
              balanceSubunits: balance,
              baseAsset: normalized.metadata.baseAsset,
            };
            if (balance < feeAmount) {
              setRegistrationFeeTopUp(prompt);
              setRegistrationFeeTopUpStage("modal");
            } else setRegistrationFeePrompt(prompt);
            return;
          }
          if (!isCurrentDraftThumbnail(draft.thumbnailId))
            throw new Error(t("marketCreation.creationStorageUnavailable"));
          const pointer = draft.creation ?? {
            creationId: crypto.randomUUID(),
            binding: session.binding,
          };
          // The pointer write must succeed before preparation can lead to payment.
          setDraft((previous) => ({
            ...previous,
            creation: pointer,
            lastModified: new Date().toISOString(),
          }));
          record = await prepareBrowserMarketCreation(session, {
            creationId: pointer.creationId,
            market,
            relayUrls: effectiveRelayUrls(relays),
            feeAmount,
            outcomeCollections:
              settings.defaultKeysetCreation === "none"
                ? requiredMarketCreationOutcomeCollections(normalized.outcomeLabels)
                : undefined,
            thumbnail,
          });
        }
        setRetainedRecord(record);
        const result = await completeBrowserMarketCreation(session, record);
        switch (result.status) {
          case "payment-pending":
            if (!rememberCreationFailure(record, "payment-pending"))
              setSubmitError(t("marketCreation.creationPaymentPending"));
            return;
          case "created":
            break;
        }
        const createResponse = result.market;
        const baseAsset = record.metadata.baseAsset;
        const snapshotDivisibility = normalizeMarketDivisibility(
          createResponse.divisibility,
          baseAsset,
        );
        try {
          await useCreatorMarketsStore.getState().saveCreatedMarket({
            conditionId: result.conditionId,
            title: record.metadata.title,
            thumbnailUrl: createResponse.thumbnailUrl ?? null,
            createdAt: new Date().toISOString(),
            baseAsset,
            divisibility: snapshotDivisibility,
            creatorFeePercent: DEFAULT_CREATOR_FEE_PERCENT,
            oracle: {
              type: "self",
              eventId: record.eventId,
              announcementEventId: JSON.parse(record.announcement.announcementNostrEventJson).id,
              announcementEventJson: record.announcement.announcementNostrEventJson,
              oraclePubkey: record.creatorId,
              engineBaseUrl: record.engineBaseUrl,
              destinations: {
                mintUrl: record.mintUrl,
                engineUrl: record.engineBaseUrl,
                relayUrls: record.relayUrls,
              },
              announcementHex: record.announcement.announcementTlvHex,
              outcomes: record.metadata.outcomes.map(({ name }) => name),
            },
          });
        } catch {
          // Keep the completed creation pointer. Resume retries only this durable row save.
          throw new Error("Durable creator storage is unavailable.");
        }
        completeCreation(record.creationId);
        // Backup progress has its own durable owner. It must not turn paid creation into failure.
        requestBrowserOracleBackup(result.conditionId);
        setRetainedRecord(null);
        setCreatedMarketOutcomeCount(record.metadata.outcomes.length);
        setCreatedMarketBaseAsset(baseAsset);
        setCreatedMarketDivisibility(snapshotDivisibility);
        setCreatedMarketConditionId(result.conditionId);
      } catch (error) {
        const pointer = useMarketDraftStore.getState().draft.creation;
        if (pointer !== undefined) {
          let retained: MarketCreationRecord | null = null;
          try {
            retained = (await session?.store.read(pointer.creationId)) ?? null;
            if (retained != null) setRetainedRecord(retained);
          } catch {
            /* The original binding can be unavailable. Keep its draft pointer. */
          }
          let dismissed = false;
          if (retained !== null || pointer.failure !== undefined) {
            try {
              dismissed = rememberCreationFailure(retained, "incomplete");
            } catch {
              /* The retained creation still owns progress. */
            }
          }
          if (!dismissed)
            setSubmitError(
              retained === null &&
                error instanceof Error &&
                /^(Market metadata|Market creation exceeds|Market thumbnail)/.test(error.message)
                ? error.message
                : t("marketCreation.creationIncompleteError"),
            );
        } else
          setSubmitError(
            error instanceof DraftImageRetentionError
              ? t(draftImageErrorKey(error))
              : error instanceof Error
                ? error.message
                : "Failed to create market",
          );
      } finally {
        setIsSubmitting(false);
      }
    },
    [
      thumbnailPending,
      thumbnailError,
      isSubmitting,
      nostrSignerMode,
      relays,
      setDraft,
      completeCreation,
      t,
    ],
  );

  const onCreateMarket = useCallback(async () => {
    await submitMarket({ registrationFeeConfirmed: false });
  }, [submitMarket]);

  const onResumeCreation = useCallback(async () => {
    await submitMarket({ registrationFeeConfirmed: false, resume: true });
  }, [submitMarket]);

  const onDismissCreationError = useCallback(() => {
    setDraft((previous) =>
      previous.creation === undefined
        ? previous
        : {
            ...previous,
            creation: {
              ...previous.creation,
              failure: {
                ...(previous.creation.failure ?? {
                  code: "incomplete",
                  progress: "prepared",
                }),
                dismissed: true,
              },
            },
          },
    );
    setSubmitError(null);
  }, [setDraft]);

  const onConfirmRegistrationFee = useCallback(async () => {
    setRegistrationFeePrompt(null);
    await submitMarket({ registrationFeeConfirmed: true });
  }, [submitMarket]);

  const onCancelRegistrationFee = useCallback(() => {
    setRegistrationFeePrompt(null);
  }, []);

  const onStartRegistrationFeeTopUp = useCallback(() => {
    setRegistrationFeeTopUpStage("overlay");
  }, []);

  const onCancelRegistrationFeeTopUp = useCallback(() => {
    setRegistrationFeeTopUpStage("closed");
    setRegistrationFeeTopUp(null);
  }, []);

  const onRegistrationFeeTopUpSuccess = useCallback(async () => {
    setRegistrationFeeTopUpStage("closed");
    setRegistrationFeeTopUp(null);
    await submitMarket({ registrationFeeConfirmed: false });
  }, [submitMarket]);

  // Available category tags (could be fetched from an API in the future)
  const categoryTags = [
    "politics",
    "sports",
    "crypto",
    "tech",
    "entertainment",
    "science",
    "finance",
  ];

  return {
    draft: draft.stepBasicInfo
      ? { ...draft, stepBasicInfo: { ...draft.stepBasicInfo, imageFile: thumbnailPreview } }
      : draft,
    hasSavedDraft,
    categoryTags,
    thumbnailFile,
    thumbnailPending,
    thumbnailError,
    onThumbnailRemove,
    isSubmitting,
    submitError,
    retainedCreation:
      draft.creation === undefined ||
      (retainedRecord === null && draft.creation.failure === undefined)
        ? null
        : {
            title: retainedRecord?.metadata.title ?? draft.stepBasicInfo?.title ?? "",
            mintConfirmed:
              retainedRecord?.mintConfirmed ??
              isConfirmedCreationProgress(draft.creation.failure?.progress),
          },
    isLoadingCreation,
    onResumeCreation,
    onDismissCreationError,
    registrationFeePrompt,
    registrationFeeTopUp,
    registrationFeeTopUpStage,
    createdMarketConditionId,
    createdMarketOutcomeCount,
    createdMarketBaseAsset,
    createdMarketDivisibility,
    onClose,
    clearDraft,
    onNext,
    onBack,
    onOutcomeTypeSelect,
    onTitleChange,
    onCategoryTagsChange,
    onClosingDateChange,
    onThumbnailUpload,
    onAddOutcome,
    onRemoveOutcome,
    onOutcomeLabelChange,
    onOutcomeColorChange,
    onLoBoundChange,
    onHiBoundChange,
    onPrecisionChange,
    onUnitChange,
    onDescriptionChange,
    onCreateMarket,
    onConfirmRegistrationFee,
    onCancelRegistrationFee,
    onStartRegistrationFeeTopUp,
    onCancelRegistrationFeeTopUp,
    onRegistrationFeeTopUpSuccess,
  };
}
