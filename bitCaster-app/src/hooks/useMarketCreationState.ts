import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router'
import type {
  WizardDraft,
  WizardStep,
  WizardStepBasicInfo,
  OracleCheckChoice,
  OutcomeType,
  OracleAnnouncement,
  WizardOutcome,
} from '@/types/market-creation'
import { useSettingsStore } from '@/stores/settings'
import { useMarketDraftStore } from '@/stores/marketDraft'
import { useCreatorMarketsStore } from '@/stores/creatorMarkets'
import { fetchOracleAnnouncements } from '@/lib/oracle'
import {
  createMarket,
  requiredMarketCreationOutcomeCollections,
} from '@/lib/markets'
import { createEnumAnnouncement } from '@/lib/kormir'
import { buildEventId } from '@/lib/slug'
import { detectMintCapabilities } from '@/lib/mints'
import { useWalletStore } from '@/stores/wallet'
import { refreshMintInfoWithoutActivating } from '@/lib/walletOps'
import {
  MAX_CONDITION_REGISTRATION_FEE_SATS,
  getAvailableRegularBalanceSats,
  registerConditionWithFee,
  registrationFeeForPolicy,
} from '@/lib/marketRegistrationFee'

/**
 * Default creator fee applied to every market created via the wizard. The
 * matching engine does not track or accrue creator fees yet, so the value
 * is stamped onto the local creator-markets store and rendered as
 * informational metadata only. P7 §`/creator` flagged "0.02% fee" displayed
 * on every market as misleading — the engine accrues nothing. The constant
 * is kept (rather than removed) so a future engine-side fee model is a
 * one-line change here. CreatedMarketRow hides the row when the value is 0.
 */
const DEFAULT_CREATOR_FEE_PERCENT = 0
export const MAX_MARKET_OUTCOMES = 8

const ORACLE_PUBKEY = import.meta.env.VITE_ORACLE_PUBKEY as string | undefined
type RegistrationFeePrompt = { feeSats: number; balanceSats: number }
type RegistrationFeeTopUpStage = 'closed' | 'modal' | 'overlay'

async function activeMintCapabilities() {
  const wallet = useWalletStore.getState()
  let mint = wallet.mints.find((candidate) => candidate.url === wallet.activeMintUrl)
  let capabilities = detectMintCapabilities(mint?.info)
  if (mint && !capabilities.ctfSettings) {
    await refreshMintInfoWithoutActivating(mint.url)
    const refreshed = useWalletStore.getState()
    mint = refreshed.mints.find((candidate) => candidate.url === refreshed.activeMintUrl)
    capabilities = detectMintCapabilities(mint?.info)
  }
  return capabilities
}

/** Check whether outcome probabilities sum to exactly 100. */
export function probabilitySumValid(outcomes: WizardOutcome[]): boolean {
  return outcomes.reduce((sum, o) => sum + (o.probability ?? 0), 0) === 100
}

/** Check whether every outcome probability is in the backend-enforced [1, 99] range. */
export function allProbabilitiesInRange(outcomes: WizardOutcome[]): boolean {
  return outcomes.every((o) => {
    const p = o.probability ?? 0
    return p >= 1 && p <= 99
  })
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
  const relays = useSettingsStore((s) => s.relays)

  // The draft store lives in localStorage so closing the wizard mid-flow
  // does not lose work. `setDraft` and `clearDraft` are stable zustand
  // actions; the consumer callbacks below rely on that to keep empty deps.
  const draft = useMarketDraftStore((s) => s.draft)
  const setDraft = useMarketDraftStore((s) => s.setDraft)
  const clearDraft = useMarketDraftStore((s) => s.clearDraft)
  // Snapshot once at mount: whether the wizard is being re-entered with a
  // saved draft. We don't subscribe to `hasSavedDraft` because the first
  // keystroke would flip it to true and make the resume banner re-appear.
  const [hasSavedDraft] = useState(() => useMarketDraftStore.getState().hasSavedDraft)

  const [thumbnailFile, setThumbnailFile] = useState<File | null>(null)
  const [oracleAnnouncements, setOracleAnnouncements] = useState<OracleAnnouncement[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [registrationFeePrompt, setRegistrationFeePrompt] =
    useState<RegistrationFeePrompt | null>(null)
  const [registrationFeeTopUpStage, setRegistrationFeeTopUpStage] =
    useState<RegistrationFeeTopUpStage>('closed')
  const [registrationFeeTopUp, setRegistrationFeeTopUp] =
    useState<RegistrationFeePrompt | null>(null)
  // Set after `createMarket` succeeds — the wizard then renders the deposit
  // step (the user must fund the market's CPMM bot before it goes live).
  // Holding this in component state, not the localStorage draft, because:
  //   - The market is already registered on the engine; restarting the
  //     wizard with a stale draft would attempt re-registration and 409.
  //   - Refresh / close on this step is acceptable: the market exists in
  //     `Unfunded` state and the user can return via the dashboard.
  const [createdMarketConditionId, setCreatedMarketConditionId] = useState<string | null>(null)
  // Snapshot of `draft.stepInitialLiquidity.liquiditySats` taken at success
  // time so the deposit step's `defaultAmountSats` reads the value the user
  // actually picked in step 5. Read separately from the draft because
  // `clearDraft()` (called on the same tick as `setCreatedMarketConditionId`)
  // wipes `stepInitialLiquidity` before DepositStep mounts.
  const [createdMarketLiquiditySats, setCreatedMarketLiquiditySats] = useState<number | null>(null)
  // Track the last blob URL created for the thumbnail preview so we can revoke
  // it when the user picks a new file or when the component unmounts. Without
  // this, every upload leaks a live Blob reference for the page's lifetime.
  const thumbnailObjectUrlRef = useRef<string | null>(null)
  useEffect(() => {
    return () => {
      if (thumbnailObjectUrlRef.current) {
        URL.revokeObjectURL(thumbnailObjectUrlRef.current)
        thumbnailObjectUrlRef.current = null
      }
    }
  }, [])

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
    // Route to Settings with the Nostr category pre-expanded so the user can
    // configure their nsec. Without the ?category query param they would
    // land on the default General section and have to click to find Nostr.
    navigate('/settings?category=nostr')
  }, [navigate])

  const onClose = useCallback(() => {
    // Fall back to /creator when deep-linked with no history to walk back to.
    if (window.history.length > 1) {
      navigate(-1)
    } else {
      navigate('/creator')
    }
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
    setDraft((prev) => {
      // Clicking the already-selected type must not reset `stepOutcomes`,
      // or the user loses any outcome work they had.
      if (prev.stepGetStarted?.outcomeType === type) return prev
      return {
        ...prev,
        stepGetStarted: { outcomeType: type },
        stepOutcomes: null,
        lastModified: new Date().toISOString(),
      }
    })
  }, [])

  // --- Basic Info (Step 3) ---
  // All basic-info field setters share the same guarded-merge shape; this
  // helper lets them be written as one-liners.
  const updateBasicInfo = useCallback((patch: Partial<WizardStepBasicInfo>) => {
    setDraft((prev) => ({
      ...prev,
      stepBasicInfo: prev.stepBasicInfo ? { ...prev.stepBasicInfo, ...patch } : null,
      lastModified: new Date().toISOString(),
    }))
  }, [])

  const onTitleChange = useCallback(
    (title: string) => updateBasicInfo({ title }),
    [updateBasicInfo],
  )

  const onCategoryTagsChange = useCallback(
    (categoryTags: string[]) => updateBasicInfo({ categoryTags }),
    [updateBasicInfo],
  )

  const onClosingDateChange = useCallback(
    (closingDate: string) => updateBasicInfo({ closingDate }),
    [updateBasicInfo],
  )

  const onThumbnailUpload = useCallback((file: File) => {
    setThumbnailFile(file)
    if (thumbnailObjectUrlRef.current) {
      URL.revokeObjectURL(thumbnailObjectUrlRef.current)
    }
    const url = URL.createObjectURL(file)
    thumbnailObjectUrlRef.current = url
    updateBasicInfo({ imageFile: url })
  }, [updateBasicInfo])

  // --- Outcomes (Step 4) ---
  const onAddOutcome = useCallback(() => {
    setDraft((prev) => {
      if (!prev.stepOutcomes?.outcomes) return prev
      if (prev.stepOutcomes.outcomes.length >= MAX_MARKET_OUTCOMES) return prev
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

  const submitMarket = useCallback(async (options: { registrationFeeConfirmed: boolean }) => {
    if (isSubmitting) return
    setIsSubmitting(true)
    setSubmitError(null)

    // Read the draft fresh from the store rather than closing over it, so
    // this callback's identity doesn't change on every keystroke.
    const draft = useMarketDraftStore.getState().draft

    try {
      const choice = draft.stepOracleCheck?.choice
      const title = draft.stepBasicInfo?.title ?? ''
      const description = draft.stepReviewAndCreate?.description ?? ''
      const categoryTags = draft.stepBasicInfo?.categoryTags ?? []
      const tags: string[][] = [
        ['title', title],
        ['description', description],
        ...categoryTags.map((t) => ['t', t] as string[]),
      ]

      // Resolve outcome labels before any mint mutation or self-oracle publish
      // so registration-fee checks can stop safely.
      let outcomes: string[]
      if (choice === 'become-oracle') {
        const draftOutcomes = draft.stepOutcomes?.outcomes
        if (!draftOutcomes || draftOutcomes.length < 2) {
          throw new Error('At least two outcomes are required to create an oracle event.')
        }
        const outcomeType = draft.stepOutcomes?.outcomeType
        if (outcomeType === 'numeric') {
          throw new Error(
            'Numeric oracle events are not yet supported in the become-oracle flow. ' +
              'Please select an existing announcement.',
          )
        }
        const closingDate = draft.stepBasicInfo?.closingDate
        if (!closingDate) {
          throw new Error('A closing date is required to publish an oracle announcement.')
        }
        const maturityEpoch = Math.floor(new Date(closingDate).getTime() / 1000)
        if (!Number.isFinite(maturityEpoch) || maturityEpoch <= 0) {
          throw new Error('Invalid closing date.')
        }
        outcomes = draftOutcomes.map((o) => o.label)
      } else {
        const announcement = oracleAnnouncements.find(
          (a) => a.id === draft.stepOracleCheck?.selectedAnnouncementId,
        )
        if (!announcement) throw new Error('No oracle announcement selected')
        outcomes = draft.stepOutcomes?.outcomes?.map((o) => o.label) ?? announcement.outcomes
      }
      if (outcomes.length > MAX_MARKET_OUTCOMES) {
        throw new Error(`At most ${MAX_MARKET_OUTCOMES} outcomes are supported.`)
      }

      const ctfCapabilities = await activeMintCapabilities()
      if (!ctfCapabilities.ctfSettings) {
        throw new Error(
          ctfCapabilities.ctf
            ? 'Active mint CTF settings are missing or invalid. Refresh mint info or choose another mint.'
            : 'Active mint does not advertise CTF support.',
        )
      }
      const ctfSettings = ctfCapabilities.ctfSettings
      const requiredRegistrationFee = registrationFeeForPolicy(outcomes, ctfSettings)
      if (requiredRegistrationFee > MAX_CONDITION_REGISTRATION_FEE_SATS) {
        throw new Error(
          `This mint requires a ${requiredRegistrationFee} sat condition registration fee, ` +
            `which exceeds the ${MAX_CONDITION_REGISTRATION_FEE_SATS} sat app limit.`,
        )
      }

      const wallet = useWalletStore.getState()
      const activeMintUrl = wallet.activeMintUrl
      if (!activeMintUrl) {
        throw new Error('No active mint is configured.')
      }
      if (requiredRegistrationFee > 0 && !options.registrationFeeConfirmed) {
        const balance = await getAvailableRegularBalanceSats(activeMintUrl)
        if (balance < requiredRegistrationFee) {
          setRegistrationFeeTopUp({
            feeSats: requiredRegistrationFee,
            balanceSats: balance,
          })
          setRegistrationFeeTopUpStage('modal')
          return
        }
        setRegistrationFeePrompt({
          feeSats: requiredRegistrationFee,
          balanceSats: balance,
        })
        return
      }

      // Resolve the oracle announcement hex after fee gates. For self-oracle
      // creation this avoids publishing an announcement when the user cannot
      // or does not want to pay the mint registration fee.
      let announcementHex: string
      let creatorOracle:
        | { type: 'self'; eventId: string; outcomes: string[]; announcementHex?: string }
        | undefined

      if (choice === 'become-oracle') {
        if (nostrSignerMode !== 'nsec') {
          throw new Error(
            'You must register a nostr private key (nsec) in Settings to become an oracle.',
          )
        }
        const closingDate = draft.stepBasicInfo?.closingDate
        const maturityEpoch = Math.floor(new Date(closingDate ?? '').getTime() / 1000)
        const eventId = buildEventId(title || 'market')
        const relayUrls = relays.map((r) => r.url)
        if (relayUrls.length === 0) {
          throw new Error(
            'Add at least one Nostr relay in Settings before publishing an oracle announcement.',
          )
        }
        // kormir.create_enum_event both constructs the DLC announcement and
        // publishes the kind-88 event to the configured relays.
        announcementHex = await createEnumAnnouncement(
          relayUrls,
          eventId,
          outcomes,
          maturityEpoch,
          title,
          description,
        )
        // Persist the announcement hex so a fresh browser profile can recover
        // the committed-nonce material needed to resolve this market (P22 B1b).
        creatorOracle = { type: 'self', eventId, outcomes, announcementHex }
      } else {
        const announcement = oracleAnnouncements.find(
          (a) => a.id === draft.stepOracleCheck?.selectedAnnouncementId,
        )
        if (!announcement) throw new Error('No oracle announcement selected')
        announcementHex = announcement.id
      }
      const outcomeCollections =
        ctfSettings.defaultKeysetCreation === 'none'
          ? requiredMarketCreationOutcomeCollections(outcomes)
          : undefined

      // 1. Register condition on the mint
      const { condition_id } = await registerConditionWithFee({
        mintUrl: activeMintUrl,
        requiredFeeSats: requiredRegistrationFee,
        request: {
          tags,
          announcementHex,
          collateral: 'sat',
          outcomeCollections,
        },
      })

      // 2. Create market on matching engine (includes thumbnail + CPMM pools)
      const createResponse = await createMarket(
        condition_id,
        {
          title,
          description,
          outcomes: outcomes.map((name) => ({
            name,
            probability: draft.stepOutcomes?.outcomes?.find((o) => o.label === name)?.probability ?? 50,
          })),
          outcomeType: draft.stepOutcomes?.outcomeType ?? draft.stepGetStarted?.outcomeType ?? 'yesno',
          liquiditySats: draft.stepInitialLiquidity?.liquiditySats ?? 0,
          categoryTags,
          oracleAnnouncementHex: announcementHex,
        },
        thumbnailFile,
      )

      // Record the newly created market in the client-side creator store so
      // the dashboard can render it immediately. NIP-78 sync takes over from
      // here (see `useCreatorSync`). This write is best-effort: the market
      // has already been registered on the mint and the matching engine, so
      // a localStorage quota error must not surface as "Failed to create
      // market" and strand the user on the wizard.
      try {
        useCreatorMarketsStore.getState().addCreatedMarket({
          conditionId: condition_id,
          title,
          thumbnailUrl: createResponse.thumbnailUrl ?? null,
          createdAt: new Date().toISOString(),
          creatorFeePercent: DEFAULT_CREATOR_FEE_PERCENT,
          oracle: creatorOracle,
        })
      } catch (storeErr) {
        console.warn(
          'Failed to persist created market to local creator store; dashboard will not show it until NIP-78 sync recovers.',
          storeErr,
        )
      }

      // Snapshot liquiditySats BEFORE clearDraft so DepositStep can use it
      // as the default deposit amount — clearDraft wipes stepInitialLiquidity
      // and DepositStep's useState would otherwise initialize amountSats=0
      // (and disable the request button).
      const snapshotLiquiditySats = draft.stepInitialLiquidity?.liquiditySats ?? 0

      clearDraft()
      // Hand off to the deposit step. The wizard renders DepositStep when
      // `createdMarketConditionId` is set; the user navigates to
      // /markets/{conditionId} from there once the deposit reaches
      // `Credited`.
      setCreatedMarketLiquiditySats(snapshotLiquiditySats)
      setCreatedMarketConditionId(condition_id)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to create market')
    } finally {
      setIsSubmitting(false)
    }
  }, [oracleAnnouncements, thumbnailFile, isSubmitting, navigate, nostrSignerMode, relays, clearDraft])

  const onCreateMarket = useCallback(async () => {
    await submitMarket({ registrationFeeConfirmed: false })
  }, [submitMarket])

  const onConfirmRegistrationFee = useCallback(async () => {
    setRegistrationFeePrompt(null)
    await submitMarket({ registrationFeeConfirmed: true })
  }, [submitMarket])

  const onCancelRegistrationFee = useCallback(() => {
    setRegistrationFeePrompt(null)
  }, [])

  const onStartRegistrationFeeTopUp = useCallback(() => {
    setRegistrationFeeTopUpStage('overlay')
  }, [])

  const onCancelRegistrationFeeTopUp = useCallback(() => {
    setRegistrationFeeTopUpStage('closed')
    setRegistrationFeeTopUp(null)
  }, [])

  const onRegistrationFeeTopUpSuccess = useCallback(async () => {
    setRegistrationFeeTopUpStage('closed')
    setRegistrationFeeTopUp(null)
    await submitMarket({ registrationFeeConfirmed: false })
  }, [submitMarket])

  // Available category tags (could be fetched from an API in the future)
  const categoryTags = ['politics', 'sports', 'crypto', 'tech', 'entertainment', 'science', 'finance']

  return {
    draft,
    hasSavedDraft,
    oracleAnnouncements,
    categoryTags,
    signerMode: nostrSignerMode,
    thumbnailFile,
    isSubmitting,
    submitError,
    registrationFeePrompt,
    registrationFeeTopUp,
    registrationFeeTopUpStage,
    createdMarketConditionId,
    createdMarketLiquiditySats,
    onOracleChoiceSelect,
    onAnnouncementSelect,
    onExit,
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
    onOutcomeProbabilityChange,
    onNormalizeProbabilities,
    onLoBoundChange,
    onHiBoundChange,
    onPrecisionChange,
    onUnitChange,
    onLiquiditySatsChange,
    onDescriptionChange,
    onCreateMarket,
    onConfirmRegistrationFee,
    onCancelRegistrationFee,
    onStartRegistrationFeeTopUp,
    onCancelRegistrationFeeTopUp,
    onRegistrationFeeTopUpSuccess,
  }
}
