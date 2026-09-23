import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarketCreationWizard } from "../MarketCreationWizard";
import i18n from "@/i18n";
import { useSettingsStore } from "@/stores/settings";
import type { MarketCreationWizardProps, WizardDraft } from "@/types/market-creation";

function makeDraft(outcomeType: "yesno" | "categorical"): WizardDraft {
  return {
    currentStep: 3,
    lastModified: "2026-09-16T00:00:00.000Z",
    stepGetStarted: { outcomeType },
    stepBasicInfo: {
      imageFile: null,
      title: "Will the event happen?",
      categoryTags: [],
      closingDate: "2027-01-01T00:00:00.000Z",
    },
    stepOutcomes: {
      outcomeType,
      outcomes:
        outcomeType === "yesno"
          ? [
              { id: "yes", label: "Yes", description: "" },
              { id: "no", label: "No", description: "" },
            ]
          : [
              { id: "alpha", label: "Alpha", description: "" },
              { id: "beta", label: "Beta", description: "" },
            ],
      baseAsset: "sat",
    },
    stepReviewAndCreate: { description: "Resolution criteria" },
  };
}

function makeProps(outcomeType: "yesno" | "categorical"): MarketCreationWizardProps {
  return {
    draft: makeDraft(outcomeType),
    hasSavedDraft: false,
    categoryTags: [],
    isSubmitting: false,
    submitError: null,
    registrationFeePrompt: null,
    registrationFeeTopUp: null,
    registrationFeeTopUpStage: "closed",
    createdMarketConditionId: null,
    createdMarketOutcomeCount: null,
    createdMarketBaseAsset: null,
    createdMarketDivisibility: null,
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
  };
}

describe("MarketCreationWizard outcome-step rendering", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    useSettingsStore.setState({ nostrSignerMode: "nsec", nsecSecret: "nsec-test" });
  });

  it("renders binary drafts directly in review without an outcomes editor", () => {
    render(<MarketCreationWizard {...makeProps("yesno")} />);

    expect(screen.getByRole("heading", { name: "Review & Create" })).toBeInTheDocument();
    expect(screen.getByText("Yes / No")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("No")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Define Outcomes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Outcome" })).not.toBeInTheDocument();
  });

  it("keeps the categorical outcomes editor on the outcomes step", () => {
    render(<MarketCreationWizard {...makeProps("categorical")} />);

    expect(screen.getByRole("heading", { name: "Define Outcomes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Outcome" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Alpha")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Beta")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Review & Create" })).not.toBeInTheDocument();
  });
});
