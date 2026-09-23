import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarketCreationPage } from "../MarketCreationPage";
import type { MarketCreationWizardProps } from "@/types/market-creation";

const mockCreateMarket = vi.hoisted(() => vi.fn());
const walletState = vi.hoisted(() => ({
  mnemonic: "",
  ensureImplicitWallet: vi.fn(async () => undefined),
  recoverFromMnemonic: vi.fn(async (_words: string[] = []) => ({ valid: true })),
}));
const validSeedPhrase =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

vi.mock("@/stores/wallet", () => ({
  useWalletStore: Object.assign(
    (selector: (state: typeof walletState) => unknown) => selector(walletState),
    { getState: () => walletState },
  ),
}));

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
          { id: "a", label: "A", description: "" },
          { id: "b", label: "B", description: "" },
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
    onLoBoundChange: vi.fn(),
    onHiBoundChange: vi.fn(),
    onPrecisionChange: vi.fn(),
    onUnitChange: vi.fn(),
    onDescriptionChange: vi.fn(),
    onCreateMarket: mockCreateMarket,
    onConfirmRegistrationFee: vi.fn(),
    onCancelRegistrationFee: vi.fn(),
    onStartRegistrationFeeTopUp: vi.fn(),
    onCancelRegistrationFeeTopUp: vi.fn(),
    onRegistrationFeeTopUpSuccess: vi.fn(),
    createdMarketConditionId: null,
    createdMarketOutcomeCount: null,
    createdMarketBaseAsset: null,
    createdMarketDivisibility: null,
  }),
}));

vi.mock("@/components/market-creation", () => ({
  MarketCreationWizard: (props: MarketCreationWizardProps) => (
    <div>
      <div>creation wizard</div>
      <div data-testid="draft-title">{props.draft.stepBasicInfo?.title}</div>
      <button type="button" onClick={props.onCreateMarket}>
        Create Market
      </button>
    </div>
  ),
}));

describe("MarketCreationPage", () => {
  beforeEach(() => {
    walletState.mnemonic = "";
    walletState.ensureImplicitWallet.mockReset().mockImplementation(async () => {
      if (!walletState.mnemonic) walletState.mnemonic = "generated wallet seed";
    });
    walletState.recoverFromMnemonic.mockReset().mockImplementation(async (words: string[] = []) => {
      walletState.mnemonic = words.join(" ");
      return { valid: true };
    });
    mockCreateMarket.mockReset();
  });

  it("renders the sat-only creation wizard", () => {
    render(<MarketCreationPage />);
    expect(screen.getByText("creation wizard")).toBeInTheDocument();
  });

  it("opens wallet setup before creation and preserves the draft when canceled", async () => {
    const user = userEvent.setup();
    render(<MarketCreationPage />);

    expect(screen.getByTestId("draft-title")).toHaveTextContent("Market");
    await user.click(screen.getByRole("button", { name: "Create Market" }));

    expect(screen.getByRole("heading", { name: /wallet setup/i })).toBeInTheDocument();
    expect(mockCreateMarket).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("heading", { name: /wallet setup/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("draft-title")).toHaveTextContent("Market");
    expect(mockCreateMarket).not.toHaveBeenCalled();
  });

  it("completes explicit wallet setup without automatically creating the market", async () => {
    const user = userEvent.setup();
    const view = render(<MarketCreationPage />);

    await user.click(screen.getByRole("button", { name: "Create Market" }));
    await user.click(screen.getByRole("button", { name: /create new wallet/i }));

    expect(walletState.ensureImplicitWallet).toHaveBeenCalledOnce();
    expect(mockCreateMarket).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: /wallet setup/i })).not.toBeInTheDocument();

    view.rerender(<MarketCreationPage />);
    await user.click(screen.getByRole("button", { name: "Create Market" }));
    expect(mockCreateMarket).toHaveBeenCalledOnce();
  });

  it("bypasses setup for an existing wallet without replacing its seed", async () => {
    const user = userEvent.setup();
    walletState.mnemonic = "existing wallet seed";
    render(<MarketCreationPage />);

    await user.click(screen.getByRole("button", { name: "Create Market" }));

    expect(mockCreateMarket).toHaveBeenCalledOnce();
    expect(walletState.ensureImplicitWallet).not.toHaveBeenCalled();
    expect(walletState.mnemonic).toBe("existing wallet seed");
    expect(screen.queryByRole("heading", { name: /wallet setup/i })).not.toBeInTheDocument();
  });

  it("restores a selected seed explicitly and still waits for a new create action", async () => {
    const user = userEvent.setup();
    render(<MarketCreationPage />);

    await user.click(screen.getByRole("button", { name: "Create Market" }));
    await user.click(screen.getByRole("button", { name: /import existing wallet/i }));
    await user.type(screen.getByLabelText(/enter your seedphrase/i), validSeedPhrase);
    await user.click(screen.getByRole("button", { name: /restore wallet/i }));

    expect(walletState.recoverFromMnemonic).toHaveBeenCalledWith(validSeedPhrase.split(" "));
    expect(walletState.ensureImplicitWallet).toHaveBeenCalledOnce();
    expect(walletState.mnemonic).toBe(validSeedPhrase);
    expect(mockCreateMarket).not.toHaveBeenCalled();
  });
});
