import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router'
import type {
  WizardDraft,
  WizardStep,
  OracleCheckChoice,
  OutcomeType,
  OracleAnnouncement,
  WizardOutcome,
} from '@/types/market-creation'
import { useSettingsStore } from '@/stores/settings'
import { fetchOracleAnnouncements } from '@/lib/oracle'
import {
  registerCondition,
  registerPartition,
  createMarket,
} from '@/lib/markets'

const ORACLE_PUBKEY = import.meta.env.VITE_ORACLE_PUBKEY as string | undefined

function defaultDraft(): WizardDraft {
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

/**
 * Normalize outcome probabilities to sum to exactly 100 using largest-remainder rounding.
 * Returns outcomes unchanged when all probabilities are zero.
 */
export function normalizeProbabilities(outcomes: WizardOutcome[]): WizardOutcome[] {
  const total = outcomes.reduce((sum, o) => sum + (o.probability ?? 0), 0)
  if (total === 0) return outcomes
  const raw = outcomes.map((o) => ((o.probability ?? 0) / total) * 100)
  const floors = raw.map(Math.floor)
  let remainder = 100 - floors.reduce((a, b) => a + b, 0)
  const fracs = raw.map((v, i) => ({ i, f: v - floors[i] })).sort((a, b) => b.f - a.f)
  for (let j = 0; j < remainder; j++) floors[fracs[j].i] += 1
  return outcomes.map((o, i) => ({ ...o, probability: floors[i] }))
}

function defaultYesNoOutcomes(): WizardOutcome[] {
  return [
    { id: 'yes', label: 'Yes', description: '', probability: 50 },
    { id: 'no', label: 'No', description: '', probability: 50 },
  ]
}

export function useMarketCreationState() {
  const navigate = useNavigate()
  const nostrSignerMode = useSettingsStore((s) => s.nostrSignerMode)
  const isNostrConfigured = nostrSignerMode !== 'none'

  const [draft, setDraft] = useState<WizardDraft>(defaultDraft)
  const [thumbnailFile, setThumbnailFile] = useState<File | null>(null)
  const [oracleAnnouncements, setOracleAnnouncements] = useState<OracleAnnouncement[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Fetch oracle announcements when Nostr is configured
  useEffect(() => {
    if (!isNostrConfigured || !ORACLE_PUBKEY) return
    let cancelled = false
    fetchOracleAnnouncements(ORACLE_PUBKEY).then((announcements) => {
      if (!cancelled) setOracleAnnouncements(announcements)
    })
    return () => { cancelled = true }
  }, [isNostrConfigured])

  const updateDraft = useCallback((patch: Partial<WizardDraft>) => {
    setDraft((prev) => ({ ...prev, ...patch, lastModified: new Date().toISOString() }))
  }, [])

  // --- Oracle Check (Step 1) ---
  const onOracleChoiceSelect = useCallback((choice: OracleCheckChoice) => {
    updateDraft({
      stepOracleCheck: {
        choice,
        selectedAnnouncementId: null,
      },
    })
  }, [updateDraft])

  const onAnnouncementSelect = useCallback((announcementId: string) => {
    updateDraft({
      stepOracleCheck: {
        choice: 'existing',
        selectedAnnouncementId: announcementId,
      },
    })
  }, [updateDraft])

  const onExit = useCallback(() => {
    navigate('/markets')
  }, [navigate])

  // --- Navigation ---
  const onNext = useCallback(() => {
    setDraft((prev) => {
      const next = Math.min(prev.currentStep + 1, 6) as WizardStep
      const updated: WizardDraft = { ...prev, currentStep: next, lastModified: new Date().toISOString() }

      // Initialize step data on entry
      if (next === 2 && !updated.stepGetStarted) {
        updated.stepGetStarted = { outcomeType: null }
      }
      if (next === 3 && !updated.stepBasicInfo) {
        updated.stepBasicInfo = { imageFile: null, title: '', categoryTags: [], closingDate: '' }
      }
      if (next === 4 && !updated.stepOutcomes) {
        const outcomeType = updated.stepGetStarted?.outcomeType ?? 'yesno'
        if (outcomeType === 'numeric') {
          updated.stepOutcomes = { outcomeType, outcomes: null }
        } else {
          updated.stepOutcomes = {
            outcomeType,
            outcomes: outcomeType === 'yesno' ? defaultYesNoOutcomes() : [],
          }
        }
      }
      if (next === 5 && !updated.stepInitialLiquidity) {
        updated.stepInitialLiquidity = { liquiditySats: 0 }
      }
      if (next === 6 && !updated.stepReviewAndCreate) {
        updated.stepReviewAndCreate = { description: '' }
      }
      return updated
    })
  }, [])

  const onBack = useCallback(() => {
    setDraft((prev) => ({
      ...prev,
      currentStep: Math.max(prev.currentStep - 1, 1) as WizardStep,
      lastModified: new Date().toISOString(),
    }))
  }, [])

  // --- Get Started (Step 2) ---
  const onOutcomeTypeSelect = useCallback((type: OutcomeType) => {
    updateDraft({
      stepGetStarted: { outcomeType: type },
      // Reset outcomes when type changes
      stepOutcomes: null,
    })
  }, [updateDraft])

  // --- Basic Info (Step 3) ---
  const onTitleChange = useCallback((title: string) => {
    setDraft((prev) => ({
      ...prev,
      stepBasicInfo: prev.stepBasicInfo ? { ...prev.stepBasicInfo, title } : null,
      lastModified: new Date().toISOString(),
    }))
  }, [])

  const onCategoryTagsChange = useCallback((tags: string[]) => {
    setDraft((prev) => ({
      ...prev,
      stepBasicInfo: prev.stepBasicInfo ? { ...prev.stepBasicInfo, categoryTags: tags } : null,
      lastModified: new Date().toISOString(),
    }))
  }, [])

  const onClosingDateChange = useCallback((date: string) => {
    setDraft((prev) => ({
      ...prev,
      stepBasicInfo: prev.stepBasicInfo ? { ...prev.stepBasicInfo, closingDate: date } : null,
      lastModified: new Date().toISOString(),
    }))
  }, [])

  const onThumbnailUpload = useCallback((file: File) => {
    setThumbnailFile(file)
    setDraft((prev) => ({
      ...prev,
      stepBasicInfo: prev.stepBasicInfo
        ? { ...prev.stepBasicInfo, imageFile: URL.createObjectURL(file) }
        : null,
      lastModified: new Date().toISOString(),
    }))
  }, [])

  // --- Outcomes (Step 4) ---
  const onAddOutcome = useCallback(() => {
    setDraft((prev) => {
      if (!prev.stepOutcomes?.outcomes) return prev
      const newOutcome: WizardOutcome = {
        id: `outcome-${Date.now()}`,
        label: '',
        description: '',
        probability: 0,
      }
      return {
        ...prev,
        stepOutcomes: {
          ...prev.stepOutcomes,
          outcomes: [...prev.stepOutcomes.outcomes, newOutcome],
        },
        lastModified: new Date().toISOString(),
      }
    })
  }, [])

  const onRemoveOutcome = useCallback((outcomeId: string) => {
    setDraft((prev) => {
      if (!prev.stepOutcomes?.outcomes) return prev
      return {
        ...prev,
        stepOutcomes: {
          ...prev.stepOutcomes,
          outcomes: prev.stepOutcomes.outcomes.filter((o) => o.id !== outcomeId),
        },
        lastModified: new Date().toISOString(),
      }
    })
  }, [])

  const onOutcomeLabelChange = useCallback((outcomeId: string, label: string) => {
    setDraft((prev) => {
      if (!prev.stepOutcomes?.outcomes) return prev
      return {
        ...prev,
        stepOutcomes: {
          ...prev.stepOutcomes,
          outcomes: prev.stepOutcomes.outcomes.map((o) =>
            o.id === outcomeId ? { ...o, label } : o
          ),
        },
        lastModified: new Date().toISOString(),
      }
    })
  }, [])

  const onOutcomeProbabilityChange = useCallback((outcomeId: string, probability: number) => {
    setDraft((prev) => {
      if (!prev.stepOutcomes?.outcomes) return prev
      return {
        ...prev,
        stepOutcomes: {
          ...prev.stepOutcomes,
          outcomes: prev.stepOutcomes.outcomes.map((o) =>
            o.id === outcomeId ? { ...o, probability } : o
          ),
        },
        lastModified: new Date().toISOString(),
      }
    })
  }, [])

  const onNormalizeProbabilities = useCallback(() => {
    setDraft((prev) => {
      if (!prev.stepOutcomes?.outcomes) return prev
      const outcomes = prev.stepOutcomes.outcomes
      const total = outcomes.reduce((sum, o) => sum + (o.probability ?? 0), 0)
      if (total === 0) return prev
      return {
        ...prev,
        stepOutcomes: {
          ...prev.stepOutcomes,
          outcomes: normalizeProbabilities(outcomes),
        },
        lastModified: new Date().toISOString(),
      }
    })
  }, [])

  const onLoBoundChange = useCallback((value: number) => {
    setDraft((prev) => ({
      ...prev,
      stepOutcomes: prev.stepOutcomes ? { ...prev.stepOutcomes, loBound: value } : null,
      lastModified: new Date().toISOString(),
    }))
  }, [])

  const onHiBoundChange = useCallback((value: number) => {
    setDraft((prev) => ({
      ...prev,
      stepOutcomes: prev.stepOutcomes ? { ...prev.stepOutcomes, hiBound: value } : null,
      lastModified: new Date().toISOString(),
    }))
  }, [])

  const onPrecisionChange = useCallback((value: number) => {
    setDraft((prev) => ({
      ...prev,
      stepOutcomes: prev.stepOutcomes ? { ...prev.stepOutcomes, precision: value } : null,
      lastModified: new Date().toISOString(),
    }))
  }, [])

  const onUnitChange = useCallback((value: string) => {
    setDraft((prev) => ({
      ...prev,
      stepOutcomes: prev.stepOutcomes ? { ...prev.stepOutcomes, unit: value } : null,
      lastModified: new Date().toISOString(),
    }))
  }, [])

  // --- Initial Liquidity (Step 5) ---
  const onLiquiditySatsChange = useCallback((sats: number) => {
    updateDraft({ stepInitialLiquidity: { liquiditySats: sats } })
  }, [updateDraft])

  // --- Review & Create (Step 6) ---
  const onDescriptionChange = useCallback((description: string) => {
    updateDraft({ stepReviewAndCreate: { description } })
  }, [updateDraft])

  const onCreateMarket = useCallback(async () => {
    if (isSubmitting) return
    setIsSubmitting(true)
    setSubmitError(null)

    try {
      const announcement = oracleAnnouncements.find(
        (a) => a.id === draft.stepOracleCheck?.selectedAnnouncementId
      )
      if (!announcement) throw new Error('No oracle announcement selected')

      const title = draft.stepBasicInfo?.title ?? ''
      const categoryTags = draft.stepBasicInfo?.categoryTags ?? []
      const tags: string[][] = [
        ['description', title],
        ...categoryTags.map((t) => ['t', t] as string[]),
      ]

      // 1. Register condition on the mint
      const { condition_id } = await registerCondition({
        tags,
        announcementHex: announcement.id,
      })

      // 2. Register partition
      const outcomes = draft.stepOutcomes?.outcomes?.map((o) => o.label) ?? announcement.outcomes
      await registerPartition(condition_id, outcomes)

      // 3. Create market on matching engine (includes thumbnail + CPMM pools)
      await createMarket(
        condition_id,
        {
          title,
          description: draft.stepReviewAndCreate?.description ?? '',
          outcomes: outcomes.map((name) => ({
            name,
            probability: draft.stepOutcomes?.outcomes?.find((o) => o.label === name)?.probability ?? 50,
          })),
          liquiditySats: draft.stepInitialLiquidity?.liquiditySats ?? 0,
          categoryTags,
        },
        thumbnailFile,
      )

      navigate(`/markets/${condition_id}`)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to create market')
    } finally {
      setIsSubmitting(false)
    }
  }, [draft, oracleAnnouncements, thumbnailFile, isSubmitting, navigate])

  // Available category tags (could be fetched from an API in the future)
  const categoryTags = ['politics', 'sports', 'crypto', 'tech', 'entertainment', 'science', 'finance']

  return {
    draft,
    oracleAnnouncements,
    categoryTags,
    isNostrConfigured,
    thumbnailFile,
    isSubmitting,
    submitError,
    onOracleChoiceSelect,
    onAnnouncementSelect,
    onExit,
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
    onOutcomeProbabilityChange,
    onNormalizeProbabilities,
    onLoBoundChange,
    onHiBoundChange,
    onPrecisionChange,
    onUnitChange,
    onLiquiditySatsChange,
    onDescriptionChange,
    onCreateMarket,
  }
}
