import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { MarketCreationWizard } from "../MarketCreationWizard";
import i18n from "@/i18n";
import { useSettingsStore } from "@/stores/settings";
import { useWalletStore } from "@/stores/wallet";
import type { MarketCreationWizardProps, WizardDraft } from "@/types/market-creation";

const executeBrowserMarketFundingDelivery = vi.hoisted(() => vi.fn());
vi.mock("@/lib/browserMarketFundingDelivery", () => ({
  BrowserMarketFundingInsufficientBalanceError: class extends Error {},
  readBrowserMarketFundingHeadId: vi.fn().mockResolvedValue(null),
  executeBrowserMarketFundingDelivery,
}));
vi.mock("@/lib/identityOps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/identityOps")>()),
  resolveCreatorPubkey: () => "subject-1",
}));
vi.mock("@/stores/wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/wallet")>()),
  useBalance: () => 200_000_000,
}));

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
    onOutcomeColorChange: vi.fn(),
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
  let previousWalletState: ReturnType<typeof useWalletStore.getState>;

  afterEach(() => {
    cleanup();
    useWalletStore.setState(previousWalletState);
    vi.useRealTimers();
  });

  beforeEach(async () => {
    previousWalletState = useWalletStore.getState();
    await i18n.changeLanguage("en");
    executeBrowserMarketFundingDelivery.mockReset();
    useSettingsStore.setState({
      nostrSignerMode: "nsec",
      nsecSecret: "nsec-test",
    });
  });

  it("keeps paid creation resume visible before the key gate and does not expose editable draft fields", () => {
    useSettingsStore.setState({ nostrSignerMode: "nip07", nsecSecret: null });
    const onResumeCreation = vi.fn();
    const onDismissCreationError = vi.fn();
    render(
      <MarketCreationWizard
        {...makeProps("yesno")}
        retainedCreation={{
          title: "Saved original title",
          mintConfirmed: true,
        }}
        submitError="The paid creation is incomplete."
        onResumeCreation={onResumeCreation}
        onDismissCreationError={onDismissCreationError}
      />,
    );
    expect(screen.getByTestId("market-creation-resume")).toBeInTheDocument();
    expect(screen.getByText("Saved original title")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      i18n.t("marketCreation.creationMintConfirmed"),
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create Market" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("resume-market-creation"));
    expect(onResumeCreation).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", {
        name: i18n.t("marketCreation.dismissCreationError"),
      }),
    );
    expect(onDismissCreationError).toHaveBeenCalledTimes(1);
  });

  it("disables resume while the saved creation is loading", () => {
    render(
      <MarketCreationWizard
        {...makeProps("yesno")}
        retainedCreation={{ title: "Saved market", mintConfirmed: false }}
        isLoadingCreation
      />,
    );
    expect(screen.getByTestId("resume-market-creation")).toBeDisabled();
  });

  it("renders binary drafts directly in review without an outcomes editor", () => {
    render(<MarketCreationWizard {...makeProps("yesno")} />);

    expect(screen.getByRole("heading", { name: "Review & Create" })).toBeInTheDocument();
    expect(screen.getByText("Yes / No")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("No")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Define Outcomes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Outcome" })).not.toBeInTheDocument();
    expect(screen.queryByText("Automatic")).not.toBeInTheDocument();
  });

  it("keeps the categorical outcomes editor on the outcomes step", () => {
    render(<MarketCreationWizard {...makeProps("categorical")} />);

    expect(screen.getByRole("heading", { name: "Define Outcomes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Outcome" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Alpha")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Beta")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Review & Create" })).not.toBeInTheDocument();
  });

  it("wires categorical color changes to the outcome callback", () => {
    const props = makeProps("categorical");
    const onOutcomeColorChange = vi.fn();
    render(<MarketCreationWizard {...props} onOutcomeColorChange={onOutcomeColorChange} />);

    fireEvent.change(screen.getByLabelText("Color for Alpha"), {
      target: { value: "#124578" },
    });
    expect(onOutcomeColorChange).toHaveBeenCalledWith("alpha", "#124578");
  });

  it("previews manual and visible palette colors in categorical review", () => {
    const props = makeProps("categorical");
    props.draft.currentStep = 4;
    props.draft.stepOutcomes!.outcomes![0] = {
      ...props.draft.stepOutcomes!.outcomes![0],
      color: "#123456",
    };
    render(<MarketCreationWizard {...props} />);

    expect(screen.getByText("#123456")).toBeInTheDocument();
    expect(screen.getByText("#59A14F")).toBeInTheDocument();
    expect(screen.queryByText("Automatic")).not.toBeInTheDocument();
  });

  it("keeps the created market handoff after draft reset and opens it only after the credit countdown", async () => {
    useWalletStore.setState({
      mnemonic: "test mnemonic",
      activeMintUrl: "https://mint.example",
    });
    executeBrowserMarketFundingDelivery.mockResolvedValue({
      progress: "credited",
      transfer: { transferId: "payment-1", requestedAmount: "100000" },
    });
    const props = makeProps("yesno");
    props.draft.currentStep = 1;
    props.createdMarketConditionId = "a".repeat(64);
    props.createdMarketOutcomeCount = 2;
    props.createdMarketBaseAsset = "sat";
    props.createdMarketDivisibility = 1_000;
    vi.useFakeTimers();
    render(
      <MemoryRouter initialEntries={["/creator/new"]}>
        <Routes>
          <Route path="/creator/new" element={<MarketCreationWizard {...props} />} />
          <Route path="/markets/:id" element={<div data-testid="market-detail-page" />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Market created!" })).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Attract Traders" })));
    fireEvent.change(screen.getByTestId("amm-funding-custom-budget"), {
      target: { value: "100" },
    });
    await act(async () => fireEvent.click(screen.getByTestId("confirm-amm-funding")));
    expect(screen.getByTestId("amm-funding-success")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(4_999));
    expect(screen.queryByTestId("market-detail-page")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId("market-detail-page")).toBeInTheDocument();
    expect(executeBrowserMarketFundingDelivery).toHaveBeenCalledOnce();
  });
});
