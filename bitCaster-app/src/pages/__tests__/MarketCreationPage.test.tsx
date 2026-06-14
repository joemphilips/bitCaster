import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { MarketCreationPage } from '../MarketCreationPage'

const mocks = vi.hoisted(() => ({
  onBaseAssetChange: vi.fn(),
  onDivisibilityChange: vi.fn(),
}))

vi.mock('@/hooks/useMarketCreationState', () => ({
  useMarketCreationState: () => ({
    draft: {
      currentStep: 3,
      lastModified: '2026-06-13T00:00:00.000Z',
      stepGetStarted: { outcomeType: 'categorical' },
      stepBasicInfo: {
        imageFile: null,
        title: 'Market',
        categoryTags: [],
        closingDate: '',
      },
      stepOutcomes: {
        outcomeType: 'categorical',
        outcomes: [
          { id: 'a', label: 'A', description: '', probability: 50 },
          { id: 'b', label: 'B', description: '', probability: 50 },
        ],
        baseAsset: 'sat',
        divisibility: 100,
      },
      stepReviewAndCreate: null,
    },
    hasSavedDraft: false,
    categoryTags: [],
    isSubmitting: false,
    submitError: null,
    registrationFeePrompt: null,
    registrationFeeTopUp: null,
    registrationFeeTopUpStage: 'closed',
    onClose: vi.fn(),
    clearDraft: vi.fn(),
    onNext: vi.fn(),
    onBack: vi.fn(),
    onOutcomeTypeSelect: vi.fn(),
    onTitleChange: vi.fn(),
    onCategoryTagsChange: vi.fn(),
    onClosingDateChange: vi.fn(),
    onThumbnailUpload: vi.fn(),
    onAddOutcome: vi.fn(),
    onRemoveOutcome: vi.fn(),
    onOutcomeLabelChange: vi.fn(),
    onOutcomeProbabilityChange: vi.fn(),
    onNormalizeProbabilities: vi.fn(),
    onLoBoundChange: vi.fn(),
    onHiBoundChange: vi.fn(),
    onPrecisionChange: vi.fn(),
    onUnitChange: vi.fn(),
    onBaseAssetChange: mocks.onBaseAssetChange,
    onDivisibilityChange: mocks.onDivisibilityChange,
    onDescriptionChange: vi.fn(),
    onCreateMarket: vi.fn(),
    onConfirmRegistrationFee: vi.fn(),
    onCancelRegistrationFee: vi.fn(),
    onStartRegistrationFeeTopUp: vi.fn(),
    onCancelRegistrationFeeTopUp: vi.fn(),
    onRegistrationFeeTopUpSuccess: vi.fn(),
    createdMarketConditionId: null,
    createdMarketOutcomeCount: null,
    createdMarketBaseAsset: null,
  }),
}))

vi.mock('@/components/market-creation', () => ({
  MarketCreationWizard: (props: {
    onBaseAssetChange?: (value: 'sat' | 'usd' | 'jpy') => void
    onDivisibilityChange?: (value: number) => void
  }) => (
    <div>
      <button type="button" onClick={() => props.onBaseAssetChange?.('usd')}>
        choose USD
      </button>
      <button type="button" onClick={() => props.onDivisibilityChange?.(1000)}>
        choose D1000
      </button>
    </div>
  ),
}))

describe('MarketCreationPage', () => {
  it('passes market unit callbacks through to the creation wizard', async () => {
    const user = userEvent.setup()

    render(<MarketCreationPage />)

    await user.click(screen.getByRole('button', { name: /choose usd/i }))
    await user.click(screen.getByRole('button', { name: /choose d1000/i }))

    expect(mocks.onBaseAssetChange).toHaveBeenCalledWith('usd')
    expect(mocks.onDivisibilityChange).toHaveBeenCalledWith(1000)
  })
})
