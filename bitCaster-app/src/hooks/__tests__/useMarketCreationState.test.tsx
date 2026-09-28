import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import i18n from "@/i18n";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { useSettingsStore } from "@/stores/settings";
import { useMarketDraftStore, defaultDraft } from "@/stores/marketDraft";

const {
  mockNavigate,
  mockRegisterConditionWithFee,
  mockGetAvailableRegularBalanceSubunits,
  mockCreateMarket,
  mockFetchEngineCatalogueEntry,
  mockCreateEnumAnnouncement,
  mockEnsureKormirNsec,
  mockGetOracleAnnouncementEventId,
  mockRefreshMintInfoWithoutActivating,
  mockWalletState,
} = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockRegisterConditionWithFee: vi.fn(),
  mockGetAvailableRegularBalanceSubunits: vi.fn(),
  mockCreateMarket: vi.fn(),
  mockFetchEngineCatalogueEntry: vi.fn(),
  mockCreateEnumAnnouncement: vi.fn(),
  mockEnsureKormirNsec: vi.fn(),
  mockGetOracleAnnouncementEventId: vi.fn(),
  mockRefreshMintInfoWithoutActivating: vi.fn(),
  mockWalletState: {
    activeMintUrl: "https://mint.example.test",
    mints: [
      {
        url: "https://mint.example.test",
        info: {
          nuts: {
            CTF: {
              default_keyset_creation: "one-vs-rest",
              registration_fees: [
                { unit: "msat", registration_fee_base: 0, registration_fee_per_keyset: 0 },
              ],
            },
          },
        },
      },
    ],
  },
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual("react-router");
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("@/lib/markets", async () => ({
  createMarket: (...args: unknown[]) => mockCreateMarket(...args),
  fetchEngineCatalogueEntry: (...args: unknown[]) => mockFetchEngineCatalogueEntry(...args),
  CreateMarketError: (await import("@bitcaster/client-sdk")).CreateMarketError,
  requiredMarketCreationOutcomeCollections: (outcomes: readonly string[]) => outcomes,
  MintError: class MintError extends Error {
    constructor(
      public readonly code: number,
      public readonly detail: string,
    ) {
      super(detail);
      this.name = "MintError";
    }
  },
}));

vi.mock("@/lib/marketRegistrationFee", () => ({
  MAX_CONDITION_REGISTRATION_FEE_SUBUNITS: 1000000,
  getAvailableRegularBalanceSubunits: (...args: unknown[]) =>
    mockGetAvailableRegularBalanceSubunits(...args),
  registerConditionWithFee: (...args: unknown[]) => mockRegisterConditionWithFee(...args),
  registrationFeeForPolicy: (
    outcomes: readonly string[],
    settings: {
      defaultKeysetCreation: "none" | "one-vs-rest" | "all";
      registrationFees: {
        unit: string;
        registrationFeeBase: number;
        registrationFeePerKeyset: number;
      }[];
    },
    collateralUnit: string,
  ) => {
    const fee = settings.registrationFees.find((entry) => entry.unit === collateralUnit);
    if (!fee)
      throw new Error(`Active mint does not support CTF collateral unit '${collateralUnit}'.`);
    const numKeysets =
      settings.defaultKeysetCreation === "all"
        ? Math.max(0, 2 ** outcomes.length - 2)
        : new Set(outcomes.map((outcome) => outcome.trim()).filter(Boolean)).size;
    return fee.registrationFeeBase + fee.registrationFeePerKeyset * numKeysets;
  },
}));

vi.mock("@/lib/kormir", () => ({
  createEnumAnnouncement: (...args: unknown[]) => mockCreateEnumAnnouncement(...args),
  ensureKormirNsec: (...args: unknown[]) => mockEnsureKormirNsec(...args),
  getOracleAnnouncementEventId: (...args: unknown[]) => mockGetOracleAnnouncementEventId(...args),
}));

vi.mock("@/lib/identityOps", () => ({
  resolveNsecIdentity: () => ({ publicKey: "a".repeat(64) }),
}));

vi.mock("@/lib/walletOps", () => ({
  refreshMintInfoWithoutActivating: (...args: unknown[]) =>
    mockRefreshMintInfoWithoutActivating(...args),
}));

// Stub the wallet store — the real module transitively imports `@cashu/cashu-ts`
// which fails to load cleanly under Vitest's ESM resolver, and this test does
// not exercise the wallet at all.
vi.mock("@/stores/wallet", () => ({
  useWalletStore: {
    getState: () => mockWalletState,
  },
}));

// Pull the creator-markets store into the test so the post-success
// "0% fee" assertion can read the persisted entry. Mocked separately from
// the store under test so the assertion sees real reads/writes.
import { useCreatorMarketsStore } from "@/stores/creatorMarkets";
import type { MarketCatalogueEntry } from "@/lib/markets";
import type { WizardOutcome } from "@/types/market-creation";

// Stub nip17 so the test does not pull in nostr-tools at module load time.
// The real derivation is covered in `bitCaster-app/src/lib/__tests__`.
vi.mock("@/lib/nip17", () => ({
  deriveNostrKeyPair: () => ({
    privateKeyHex: "00".repeat(32),
    publicKey: "11".repeat(32),
  }),
}));

// Must import after mocks and env stub
const { useMarketCreationState } = await import("../useMarketCreationState");
const { CreateMarketError } = await import("@/lib/markets");

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRegisterConditionWithFee.mockResolvedValue({
    condition_id: "test-cond-id",
    keysets: { Yes: "ks1", No: "ks2" },
  });
  mockGetAvailableRegularBalanceSubunits.mockResolvedValue(1000);
  mockCreateMarket.mockResolvedValue({
    conditionId: "test-cond-id",
    marketsCreated: ["test-cond-id-Yes", "test-cond-id-No"],
    outcomeDetails: [{ name: "Yes" }, { name: "No" }],
    thumbnailUrl: null,
    divisibility: 1_000,
  });
  mockFetchEngineCatalogueEntry.mockResolvedValue(null);
  mockCreateEnumAnnouncement.mockResolvedValue("announcement-hex");
  mockEnsureKormirNsec.mockResolvedValue(undefined);
  mockGetOracleAnnouncementEventId.mockResolvedValue("c".repeat(64));
  mockRefreshMintInfoWithoutActivating.mockResolvedValue(undefined);
  mockWalletState.activeMintUrl = "https://mint.example.test";
  mockWalletState.mints = [
    {
      url: "https://mint.example.test",
      info: {
        nuts: {
          CTF: {
            default_keyset_creation: "one-vs-rest",
            registration_fees: [
              { unit: "msat", registration_fee_base: 0, registration_fee_per_keyset: 0 },
            ],
          },
        },
      },
    },
  ];

  useSettingsStore.setState({
    nostrSignerMode: "nsec",
    nsecSecret: "11".repeat(32),
    relays: [{ url: "ws://localhost:7777", connectionStatus: "connected" }],
  });
  // Reset the persisted wizard draft so each test starts from a clean
  // "no work in progress" state.
  useMarketDraftStore.setState({ draft: defaultDraft(), hasSavedDraft: false });
});

async function setupDraftForSubmission() {
  const { result } = renderHook(() => useMarketCreationState(), { wrapper });

  // Step 1: select outcome type
  await act(async () => {
    result.current.onOutcomeTypeSelect("yesno");
  });
  await act(async () => {
    result.current.onNext();
  });
  // Step 2: basic info
  await act(async () => {
    result.current.onTitleChange("Test Market");
  });
  await act(async () => {
    const future = new Date(Date.now() + 86400000).toISOString().slice(0, 16);
    result.current.onClosingDateChange(future);
  });
  await act(async () => {
    result.current.onNext();
  });
  // Binary markets enter review directly with canonical Yes/No outcomes.
  await act(async () => {
    result.current.onDescriptionChange("Test description");
  });

  return result;
}

function setCategoricalOutcomes(outcomes: WizardOutcome[]) {
  useMarketDraftStore.setState({
    draft: {
      ...defaultDraft(),
      currentStep: 3,
      stepGetStarted: { outcomeType: "categorical" },
      stepOutcomes: {
        outcomeType: "categorical",
        outcomes,
        baseAsset: "sat",
      },
    },
    hasSavedDraft: true,
  });
}

function makeOutcome(id: string): WizardOutcome {
  return { id, label: id.toUpperCase(), description: "" };
}

function setCategoricalSubmissionDraft(outcomes: WizardOutcome[]) {
  const future = new Date(Date.now() + 86400000).toISOString().slice(0, 16);
  useMarketDraftStore.setState({
    draft: {
      ...defaultDraft(),
      currentStep: 4,
      stepGetStarted: { outcomeType: "categorical" },
      stepBasicInfo: {
        imageFile: null,
        title: "Test Market",
        categoryTags: [],
        closingDate: future,
      },
      stepOutcomes: { outcomeType: "categorical", outcomes, baseAsset: "sat" },
      stepReviewAndCreate: { description: "Test description" },
    },
    hasSavedDraft: true,
  });
}

function catalogueMarket(overrides: Partial<MarketCatalogueEntry> = {}): MarketCatalogueEntry {
  return {
    conditionId: "test-cond-id",
    creatorPubkey: "a".repeat(64),
    outcomes: ["Yes", "No"],
    outcomeDetails: [
      { name: "Yes", color: "#112233" },
      { name: "No", color: "#445566" },
    ],
    baseAsset: "sat",
    divisibility: 1_000,
    thumbnailUrl: "/api/v1/test-cond-id/thumbnail",
    ...overrides,
  } as unknown as MarketCatalogueEntry;
}

describe("useMarketCreationState – wizard navigation", () => {
  it("skips binary outcomes, initializes Yes/No, and returns to basic info", async () => {
    const { result } = renderHook(() => useMarketCreationState(), { wrapper });

    await act(async () => {
      result.current.onOutcomeTypeSelect("yesno");
      result.current.onNext();
    });
    expect(result.current.draft.currentStep).toBe(2);

    await act(async () => {
      result.current.onTitleChange("Binary market");
      result.current.onNext();
    });

    expect(result.current.draft.currentStep).toBe(3);
    expect(result.current.draft.stepOutcomes).toEqual({
      outcomeType: "yesno",
      outcomes: [
        { id: "yes", label: "Yes", description: "" },
        { id: "no", label: "No", description: "" },
      ],
      baseAsset: "sat",
    });
    expect(result.current.draft.stepReviewAndCreate).toEqual({ description: "" });

    await act(async () => {
      result.current.onBack();
    });
    expect(result.current.draft.currentStep).toBe(2);
    expect(result.current.draft.stepBasicInfo?.title).toBe("Binary market");
  });

  it("restores a binary draft at outcomes as review without losing fields", async () => {
    useMarketDraftStore.setState({
      draft: {
        ...defaultDraft(),
        currentStep: 3,
        stepGetStarted: { outcomeType: "yesno" },
        stepBasicInfo: {
          imageFile: null,
          title: "Restored binary market",
          categoryTags: ["finance"],
          closingDate: "2030-01-01T00:00",
        },
        stepOutcomes: null,
        stepReviewAndCreate: { description: "Keep this description" },
      },
      hasSavedDraft: true,
    });

    const { result } = renderHook(() => useMarketCreationState(), { wrapper });

    await waitFor(() => {
      expect(result.current.draft.currentStep).toBe(3);
      expect(result.current.draft.stepOutcomes).toEqual({
        outcomeType: "yesno",
        outcomes: [
          { id: "yes", label: "Yes", description: "" },
          { id: "no", label: "No", description: "" },
        ],
        baseAsset: "sat",
      });
    });
    expect(result.current.draft.stepBasicInfo?.title).toBe("Restored binary market");
    expect(result.current.draft.stepBasicInfo?.categoryTags).toEqual(["finance"]);
    expect(result.current.draft.stepReviewAndCreate?.description).toBe("Keep this description");
  });

  it("keeps categorical and numeric markets on the outcomes step", async () => {
    const { result } = renderHook(() => useMarketCreationState(), { wrapper });

    await act(async () => {
      result.current.onOutcomeTypeSelect("categorical");
      result.current.onNext();
      result.current.onNext();
    });
    expect(result.current.draft.currentStep).toBe(3);
    expect(result.current.draft.stepOutcomes?.outcomeType).toBe("categorical");

    await act(async () => {
      result.current.onBack();
      result.current.onOutcomeTypeSelect("numeric");
      result.current.onNext();
    });
    expect(result.current.draft.currentStep).toBe(3);
    expect(result.current.draft.stepOutcomes?.outcomeType).toBe("numeric");
  });
});

describe("useMarketCreationState – categorical outcomes", () => {
  it("adds and removes outcomes without creator probability state", async () => {
    setCategoricalOutcomes([makeOutcome("a"), makeOutcome("b")]);
    const { result } = renderHook(() => useMarketCreationState(), { wrapper });

    await act(async () => {
      result.current.onAddOutcome();
    });
    await act(async () => {
      result.current.onRemoveOutcome("a");
    });

    expect(useMarketDraftStore.getState().draft.stepOutcomes?.outcomes).toEqual([
      { id: "b", label: "B", description: "" },
      { id: expect.any(String), label: "", description: "" },
    ]);
  });

  it("preserves a selected color across label edits, Back, and draft resume", async () => {
    setCategoricalOutcomes([makeOutcome("a"), makeOutcome("b")]);
    const first = renderHook(() => useMarketCreationState(), { wrapper });

    await act(async () => {
      first.result.current.onOutcomeColorChange("a", "#123456");
      first.result.current.onOutcomeLabelChange("a", "Alpha");
      first.result.current.onBack();
    });
    expect(useMarketDraftStore.getState().draft.stepOutcomes?.outcomes?.[0]).toMatchObject({
      id: "a",
      label: "Alpha",
      color: "#123456",
    });

    first.unmount();
    const resumed = renderHook(() => useMarketCreationState(), { wrapper });
    expect(resumed.result.current.draft.stepOutcomes?.outcomes?.[0].color).toBe("#123456");
    await act(async () => {
      resumed.result.current.onNext();
    });
    expect(resumed.result.current.draft.stepOutcomes?.outcomes?.[0].color).toBe("#123456");

    await act(async () => {
      resumed.result.current.onOutcomeColorChange("a", null);
    });
    expect(
      Object.hasOwn(
        useMarketDraftStore.getState().draft.stepOutcomes?.outcomes?.[0] ?? {},
        "color",
      ),
    ).toBe(false);
  });
});

describe("useMarketCreationState – onCreateMarket", () => {
  it("uses the mint default keyset policy when registering the condition", async () => {
    const result = await setupDraftForSubmission();
    const callOrder: string[] = [];
    mockRegisterConditionWithFee.mockImplementation(async () => {
      callOrder.push("condition");
      return { condition_id: "test-cond-id", keysets: { Yes: "ks1", No: "ks2" } };
    });
    mockCreateMarket.mockImplementation(async () => {
      callOrder.push("createMarket");
      return {
        conditionId: "test-cond-id",
        marketsCreated: [],
        thumbnailUrl: null,
        divisibility: 1_000,
      };
    });

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(callOrder).toEqual(["condition", "createMarket"]);
    expect(mockRegisterConditionWithFee).toHaveBeenCalledOnce();
    expect(mockRegisterConditionWithFee).toHaveBeenCalledWith({
      mintUrl: "https://mint.example.test",
      requiredFeeSubunits: 0,
      request: {
        tags: [
          ["title", "Test Market"],
          ["description", "Test description"],
        ],
        announcementHex: "announcement-hex",
        collateral: "msat",
        outcomeCollections: undefined,
      },
    });
    expect(mockCreateMarket).toHaveBeenCalledOnce();
    expect(mockCreateMarket.mock.calls[0][1]).toMatchObject({
      oracleAnnouncementHex: "announcement-hex",
    });
  });

  it("requests outcome collections explicitly when the mint default policy is none", async () => {
    mockWalletState.mints[0].info.nuts.CTF.default_keyset_creation = "none";
    const result = await setupDraftForSubmission();

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(mockRegisterConditionWithFee).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          collateral: "msat",
          outcomeCollections: ["Yes", "No"],
        }),
      }),
    );
  });

  it("refreshes the active mint before rejecting missing CTF metadata", async () => {
    mockWalletState.activeMintUrl = "http://localhost:8086";
    mockWalletState.mints = [];
    mockRefreshMintInfoWithoutActivating.mockImplementation(async () => {
      mockWalletState.mints = [
        {
          url: "http://localhost:8086",
          info: {
            nuts: {
              CTF: {
                default_keyset_creation: "one-vs-rest",
                registration_fees: [
                  { unit: "msat", registration_fee_base: 1, registration_fee_per_keyset: 1 },
                ],
              },
            },
          },
        },
      ];
    });
    const result = await setupDraftForSubmission();

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(mockRefreshMintInfoWithoutActivating).toHaveBeenCalledWith("http://localhost:8086");
    expect(result.current.registrationFeePrompt).toEqual({
      feeSubunits: 3,
      balanceSubunits: 1000,
      baseAsset: "sat",
    });
    expect(result.current.submitError).toBeNull();
    expect(mockRegisterConditionWithFee).not.toHaveBeenCalled();
  });

  it("omits client-defined collections when the mint default policy is all", async () => {
    mockWalletState.mints[0].info.nuts.CTF.default_keyset_creation = "all";
    const result = await setupDraftForSubmission();

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(mockRegisterConditionWithFee).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          collateral: "msat",
          outcomeCollections: undefined,
        }),
      }),
    );
  });

  it("prompts before paying a non-zero registration fee", async () => {
    mockWalletState.mints[0].info.nuts.CTF.registration_fees = [
      { unit: "msat", registration_fee_base: 10, registration_fee_per_keyset: 2 },
      { unit: "usd", registration_fee_base: 0, registration_fee_per_keyset: 0 },
    ];
    const result = await setupDraftForSubmission();

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(result.current.registrationFeePrompt).toEqual({
      feeSubunits: 14,
      balanceSubunits: 1000,
      baseAsset: "sat",
    });
    expect(mockRegisterConditionWithFee).not.toHaveBeenCalled();
    expect(mockCreateMarket).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.onConfirmRegistrationFee();
    });

    expect(mockRegisterConditionWithFee).toHaveBeenCalledWith(
      expect.objectContaining({ requiredFeeSubunits: 14 }),
    );
    expect(mockCreateMarket).toHaveBeenCalledOnce();
  });

  it("shows the top-up gate when the registration fee exceeds available regular balance", async () => {
    mockWalletState.mints[0].info.nuts.CTF.registration_fees = [
      { unit: "msat", registration_fee_base: 10, registration_fee_per_keyset: 2 },
      { unit: "usd", registration_fee_base: 0, registration_fee_per_keyset: 0 },
    ];
    mockGetAvailableRegularBalanceSubunits.mockResolvedValueOnce(3);
    const result = await setupDraftForSubmission();

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(result.current.registrationFeeTopUpStage).toBe("modal");
    expect(result.current.registrationFeeTopUp).toEqual({
      feeSubunits: 14,
      balanceSubunits: 3,
      baseAsset: "sat",
    });
    expect(mockRegisterConditionWithFee).not.toHaveBeenCalled();
  });

  it("rechecks the registration fee after top-up success", async () => {
    mockWalletState.mints[0].info.nuts.CTF.registration_fees = [
      { unit: "msat", registration_fee_base: 10, registration_fee_per_keyset: 2 },
      { unit: "usd", registration_fee_base: 0, registration_fee_per_keyset: 0 },
    ];
    mockGetAvailableRegularBalanceSubunits.mockResolvedValueOnce(3).mockResolvedValueOnce(1000);
    const result = await setupDraftForSubmission();

    await act(async () => {
      await result.current.onCreateMarket();
    });
    await act(async () => {
      await result.current.onRegistrationFeeTopUpSuccess();
    });

    expect(result.current.registrationFeeTopUpStage).toBe("closed");
    expect(result.current.registrationFeePrompt).toEqual({
      feeSubunits: 14,
      balanceSubunits: 1000,
      baseAsset: "sat",
    });
    expect(mockRegisterConditionWithFee).not.toHaveBeenCalled();
  });

  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it.each([
    [
      "en",
      "This mint requires a 1,000.001 sats condition registration fee, which exceeds the 1,000 sats app limit.",
    ],
    [
      "ja",
      "このミントのマーケット作成手数料 1,000.001 sats は、アプリの上限 1,000 sats を超えています。",
    ],
  ])("shows the registration fee cap in sats (%s)", async (language, expected) => {
    await i18n.changeLanguage(language);
    mockWalletState.mints[0].info.nuts.CTF.registration_fees = [
      { unit: "msat", registration_fee_base: 1000001, registration_fee_per_keyset: 0 },
    ];
    const result = await setupDraftForSubmission();

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(result.current.submitError).toBe(expected);
    expect(mockRegisterConditionWithFee).not.toHaveBeenCalled();
    expect(mockCreateMarket).not.toHaveBeenCalled();
  });

  it("requires an nsec-backed Nostr identity before mint or engine market creation", async () => {
    const result = await setupDraftForSubmission();
    useSettingsStore.setState({
      nostrSignerMode: "none",
      nsecSecret: null,
    });

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(result.current.submitError).toBe("You must register a nostr key to become an oracle");
    expect(mockGetAvailableRegularBalanceSubunits).not.toHaveBeenCalled();
    expect(mockEnsureKormirNsec).not.toHaveBeenCalled();
    expect(mockCreateEnumAnnouncement).not.toHaveBeenCalled();
    expect(mockRegisterConditionWithFee).not.toHaveBeenCalled();
    expect(mockCreateMarket).not.toHaveBeenCalled();
  });

  it("blocks market creation when CTF settings are missing or invalid", async () => {
    (mockWalletState.mints[0].info.nuts as any).CTF = { supported: true };
    const result = await setupDraftForSubmission();

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(result.current.submitError).toBe(
      "Active mint CTF settings are missing or invalid. Refresh mint info or choose another mint.",
    );
    expect(mockRegisterConditionWithFee).not.toHaveBeenCalled();
    expect(mockCreateMarket).not.toHaveBeenCalled();
  });

  it("stops and sets error if registerCondition fails", async () => {
    const result = await setupDraftForSubmission();
    mockRegisterConditionWithFee.mockRejectedValueOnce(new Error("Mint rejected"));

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(result.current.submitError).toBe("Mint rejected");
    expect(mockCreateMarket).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("stops and sets error if createMarket fails", async () => {
    const result = await setupDraftForSubmission();
    mockCreateMarket.mockRejectedValueOnce(new Error("Market creation failed"));

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(result.current.submitError).toBe("Market creation failed");
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("adopts a matching committed market after a lost create response", async () => {
    useCreatorMarketsStore.setState({ markets: [] });
    const result = await setupDraftForSubmission();
    const originalError = new CreateMarketError("connection was lost", null, true);
    mockCreateMarket.mockRejectedValueOnce(originalError);
    mockFetchEngineCatalogueEntry.mockResolvedValueOnce(
      catalogueMarket({ thumbnailUrl: "/persisted-thumbnail", outcomeDetails: undefined }),
    );

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(mockCreateMarket).toHaveBeenCalledOnce();
    expect(mockFetchEngineCatalogueEntry).toHaveBeenCalledOnce();
    expect(mockFetchEngineCatalogueEntry).toHaveBeenCalledWith("test-cond-id");
    expect(result.current.createdMarketConditionId).toBe("test-cond-id");
    expect(result.current.submitError).toBeNull();
    expect(
      useCreatorMarketsStore
        .getState()
        .markets.find((market) => market.conditionId === "test-cond-id")?.thumbnailUrl,
    ).toBe("/persisted-thumbnail");
  });

  it("adopts first-committed colors when details are reordered and retry colors differ", async () => {
    useCreatorMarketsStore.setState({ markets: [] });
    setCategoricalSubmissionDraft([
      { id: "alpha", label: "Alpha", description: "", color: "#111111" },
      { id: "beta", label: "Beta", description: "", color: "#222222" },
    ]);
    const { result } = renderHook(() => useMarketCreationState(), { wrapper });
    mockCreateMarket.mockRejectedValueOnce(new CreateMarketError("already exists", 409, true));
    mockFetchEngineCatalogueEntry.mockResolvedValueOnce(
      catalogueMarket({
        outcomes: ["Alpha", "Beta"],
        outcomeDetails: [
          { name: "Beta", color: "#ABCDEF" },
          { name: "Alpha", color: "#FEDCBA" },
        ],
      }),
    );

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(mockCreateMarket).toHaveBeenCalledOnce();
    expect(mockCreateMarket.mock.calls[0]?.[1].outcomes).toEqual([
      { name: "Alpha", color: "#111111" },
      { name: "Beta", color: "#222222" },
    ]);
    expect(mockFetchEngineCatalogueEntry).toHaveBeenCalledOnce();
    expect(result.current.createdMarketConditionId).toBe("test-cond-id");
    expect(result.current.submitError).toBeNull();
  });

  it.each([
    { label: "unknown condition", overrides: { conditionId: "other-condition" } },
    { label: "wrong owner", overrides: { creatorPubkey: "b".repeat(64) } },
    { label: "wrong outcomes", overrides: { outcomes: ["Yes", "Gamma"] } },
    { label: "duplicate outcomes", overrides: { outcomes: ["Yes", "Yes"] } },
    { label: "wrong product units", overrides: { divisibility: 1_000_000 as const } },
    {
      label: "invalid persisted colors",
      overrides: {
        outcomeDetails: [
          { name: "Yes", color: "red" },
          { name: "No", color: "#445566" },
        ],
      },
    },
  ])("keeps the original error for a catalogue row with $label", async ({ overrides }) => {
    const result = await setupDraftForSubmission();
    const originalError = new CreateMarketError("create result is uncertain", 503, true);
    mockCreateMarket.mockRejectedValueOnce(originalError);
    mockFetchEngineCatalogueEntry.mockResolvedValueOnce(catalogueMarket(overrides));

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(mockCreateMarket).toHaveBeenCalledOnce();
    expect(mockFetchEngineCatalogueEntry).toHaveBeenCalledOnce();
    expect(result.current.createdMarketConditionId).toBeNull();
    expect(result.current.submitError).toBe(originalError.message);
    expect(useMarketDraftStore.getState().hasSavedDraft).toBe(true);
  });

  it.each([400, 401, 403])("does not reconcile deterministic HTTP refusal %i", async (status) => {
    const result = await setupDraftForSubmission();
    mockCreateMarket.mockRejectedValueOnce(
      new CreateMarketError("request rejected", status, false),
    );

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(mockFetchEngineCatalogueEntry).not.toHaveBeenCalled();
    expect(result.current.submitError).toBe("request rejected");
    expect(useMarketDraftStore.getState().hasSavedDraft).toBe(true);
  });

  it("keeps the original create error when catalogue reconciliation is unavailable", async () => {
    const result = await setupDraftForSubmission();
    const originalError = new CreateMarketError("engine response was lost", null, true);
    mockCreateMarket.mockRejectedValueOnce(originalError);
    mockFetchEngineCatalogueEntry.mockRejectedValueOnce(new Error("catalogue unavailable"));

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(mockFetchEngineCatalogueEntry).toHaveBeenCalledOnce();
    expect(mockCreateMarket).toHaveBeenCalledOnce();
    expect(result.current.submitError).toBe(originalError.message);
    expect(useMarketDraftStore.getState().hasSavedDraft).toBe(true);
  });

  it("hands off to the deposit step on full success (does NOT navigate immediately)", async () => {
    const result = await setupDraftForSubmission();

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(mockCreateMarket).toHaveBeenCalledOnce();
    expect(mockFetchEngineCatalogueEntry).not.toHaveBeenCalled();
    // createMarket success transitions the wizard to the
    // deposit step rather than navigating to the market detail page. The
    // user funds the bot first; navigation happens from DepositStep once
    // the Lightning payment reaches Paid. The hook signals this via
    // `createdMarketConditionId`.
    expect(result.current.createdMarketConditionId).toBe("test-cond-id");
    expect(result.current.createdMarketDivisibility).toBe(1_000);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("clears the persisted draft on success so the wizard does not resurface stale work", async () => {
    const result = await setupDraftForSubmission();
    expect(useMarketDraftStore.getState().hasSavedDraft).toBe(true);

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(useMarketDraftStore.getState().hasSavedDraft).toBe(false);
  });

  it("keeps the persisted draft when createMarket fails so the user can retry", async () => {
    const result = await setupDraftForSubmission();
    mockCreateMarket.mockRejectedValueOnce(new Error("Market creation failed"));

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(useMarketDraftStore.getState().hasSavedDraft).toBe(true);
  });

  it("submits chosen categorical colors by exact outcome name and omits automatic colors", async () => {
    const future = new Date(Date.now() + 86400000).toISOString().slice(0, 16);
    useMarketDraftStore.setState({
      draft: {
        ...defaultDraft(),
        currentStep: 4,
        stepGetStarted: { outcomeType: "categorical" },
        stepBasicInfo: {
          imageFile: null,
          title: "Test Market",
          categoryTags: [],
          closingDate: future,
        },
        stepOutcomes: {
          outcomeType: "categorical",
          outcomes: [
            { id: "alpha", label: "Alpha", description: "", color: "#123456" },
            { id: "beta", label: "Beta", description: "" },
          ],
          baseAsset: "sat",
        },
        stepReviewAndCreate: { description: "Test description" },
      },
      hasSavedDraft: true,
    });
    const { result } = renderHook(() => useMarketCreationState(), { wrapper });

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(mockCreateMarket.mock.calls[0][1].outcomes).toEqual([
      { name: "Alpha", color: "#123456" },
      { name: "Beta" },
    ]);
  });

  it("stamps creatorFeePercent=0 (P7 §/creator: engine accrues no fees)", async () => {
    // Reset the creator-markets store so the assertion is not polluted by
    // entries from the other tests in this file.
    useCreatorMarketsStore.setState({ markets: [] });
    const result = await setupDraftForSubmission();

    await act(async () => {
      await result.current.onCreateMarket();
    });

    const entry = useCreatorMarketsStore
      .getState()
      .markets.find((m) => m.conditionId === "test-cond-id");
    expect(entry).toBeDefined();
    expect(entry!.creatorFeePercent).toBe(0);
  });

  it("records self-oracle event metadata when creating as the oracle", async () => {
    useCreatorMarketsStore.setState({ markets: [] });
    useSettingsStore.setState({
      nostrSignerMode: "nsec",
      nsecSecret: "11".repeat(32),
      relays: [{ url: "ws://localhost:7777", connectionStatus: "connected" }],
    });
    const { result } = renderHook(() => useMarketCreationState(), { wrapper });

    await act(async () => {
      result.current.onOutcomeTypeSelect("yesno");
    });
    await act(async () => {
      result.current.onNext();
    });
    await act(async () => {
      result.current.onTitleChange("Will BTC hit $150k?");
    });
    await act(async () => {
      const future = new Date(Date.now() + 86400000).toISOString().slice(0, 16);
      result.current.onClosingDateChange(future);
    });
    await act(async () => {
      result.current.onNext();
    });
    await act(async () => {
      result.current.onDescriptionChange("Test description");
    });

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(mockEnsureKormirNsec).toHaveBeenCalledWith(["ws://localhost:7777"], "11".repeat(32));
    expect(mockCreateEnumAnnouncement).toHaveBeenCalledWith(
      ["ws://localhost:7777"],
      expect.stringMatching(/^will_btc_hit_150k_[0-9a-f]{12}$/),
      ["Yes", "No"],
      expect.any(Number),
      "Will BTC hit $150k?",
      "Test description",
    );
    const entry = useCreatorMarketsStore.getState().markets[0];
    expect(entry.oracle?.type).toBe("self");
    expect(entry.oracle?.eventId).toMatch(/^will_btc_hit_150k_[0-9a-f]{12}$/);
    expect(entry.oracle?.announcementEventId).toBe("c".repeat(64));
    expect(entry.oracle?.outcomes).toEqual(["Yes", "No"]);
  });
});
