import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarketCreationPage } from "../MarketCreationPage";

vi.mock("@/hooks/useMarketCreationState", () => ({
  useMarketCreationState: () => ({
    draft: {
      currentStep: 3,
      lastModified: "2026-06-13T00:00:00.000Z",
      stepGetStarted: { outcomeType: "categorical" },
      stepBasicInfo: {
        imageFile: null,
        title: "Market",
        categoryTags: [],
        closingDate: "",
      },
      stepOutcomes: {
        outcomeType: "categorical",
        outcomes: [
          { id: "a", label: "A", description: "", probability: 50 },
          { id: "b", label: "B", description: "", probability: 50 },
        ],
        baseAsset: "sat",
      },
      stepReviewAndCreate: null,
    },
    hasSavedDraft: false,
    categoryTags: [],
    isSubmitting: false,
    submitError: null,
    registrationFeePrompt: null,
    registrationFeeTopUp: null,
    registrationFeeTopUpStage: "closed",
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
}));

vi.mock("@/components/market-creation", () => ({
  MarketCreationWizard: () => <div>creation wizard</div>,
}));

describe("MarketCreationPage", () => {
  it("renders the sat-only creation wizard", () => {
    render(<MarketCreationPage />);
    expect(screen.getByText("creation wizard")).toBeInTheDocument();
  });
});
