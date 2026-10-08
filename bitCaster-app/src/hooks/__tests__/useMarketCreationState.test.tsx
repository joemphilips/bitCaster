import { installCreatorDocumentLocks } from "@/test/creatorDocumentLocks";
import "fake-indexeddb/auto";
import { BrowserMarketCreationStore } from "@/stores/market-creation-db";
import { currentBrowserMarketCreationBinding } from "@/lib/browserMarketCreation";
import { marketDraftImages } from "@/stores/marketDraftImage";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import Dexie from "dexie";
import { Blob as NativeBlob, File as NativeFile } from "node:buffer";
import { webcrypto } from "node:crypto";
import { FormData as NativeFormData } from "undici";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import {
  deriveDlcConditionId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk";
import { BitcasterDB } from "@/stores/proof-db";
import { browserWalletDatabaseName } from "@/lib/browserWalletProfile";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import i18n from "@/i18n";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { useSettingsStore } from "@/stores/settings";
import { requestBrowserOracleBackup } from "@/lib/browserOracleBackupDelivery";
import { useMarketDraftStore, defaultDraft } from "@/stores/marketDraft";

const {
  mockNavigate,
  mockRegisterConditionWithFee,
  mockGetAvailableRegularBalanceSubunits,
  mockCreateMarket,
  mockFetchMarketRegistrationForRecovery,
  mockPrepareEnumAnnouncement,
  mockWithBrowserOracleMutation,
  mockGetOracleAnnouncementEventId,
  mockRefreshMintInfoWithoutActivating,
  mockWalletState,
  walletHydration,
  runtime,
} = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockRegisterConditionWithFee: vi.fn(),
  mockGetAvailableRegularBalanceSubunits: vi.fn(),
  mockCreateMarket: vi.fn(),
  mockFetchMarketRegistrationForRecovery: vi.fn(),
  mockPrepareEnumAnnouncement: vi.fn(),
  mockWithBrowserOracleMutation: vi.fn(),
  mockGetOracleAnnouncementEventId: vi.fn(),
  mockRefreshMintInfoWithoutActivating: vi.fn(),
  walletHydration: { hydrated: true, listeners: new Set<() => void>() },
  runtime: {
    database: null as any,
    conditionId: "",
    lookupMint: vi.fn(),
    published: [] as string[],
    seed: new Uint8Array(64).fill(0x11),
    scopeId: "",
    feeOperations: [] as string[],
    engineThumbnails: [] as Array<{ name: string; bytes: Uint8Array }>,
    draftStore: null as typeof useMarketDraftStore | null,
  },
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
                {
                  unit: "msat",
                  registration_fee_base: 0,
                  registration_fee_per_keyset: 0,
                },
              ],
            },
          },
        },
      },
    ],
  },
}));

// Keep the production store and installed persist middleware. Switch only the
// module reference when a fixture needs a store initialized without storage.
vi.mock("@/stores/marketDraft", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/marketDraft")>();
  return {
    ...actual,
    useMarketDraftStore: new Proxy(actual.useMarketDraftStore, {
      apply(target, thisArg, args) {
        return Reflect.apply(runtime.draftStore ?? target, thisArg, args);
      },
      get(target, property) {
        return Reflect.get(runtime.draftStore ?? target, property);
      },
    }),
  };
});

vi.mock("react-router", async () => {
  const actual = await vi.importActual("react-router");
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("@/lib/markets", async () => ({
  createMarket: (...args: unknown[]) => mockCreateMarket(...args),
  fetchMarketRegistrationForRecovery: (...args: unknown[]) =>
    mockFetchMarketRegistrationForRecovery(...args),
  CreateMarketError: (await import("@bitcaster/client-sdk")).CreateMarketError,
  createPreparedMarket: async (
    conditionId: string,
    prepared: { bodyBytes: ArrayBuffer; contentType: string },
  ) => {
    const form = await new Request("https://engine.example", {
      method: "POST",
      headers: { "Content-Type": prepared.contentType },
      body: prepared.bodyBytes,
    }).formData();
    const thumbnail = form.get("thumbnail");
    if (thumbnail instanceof Blob)
      runtime.engineThumbnails.push({
        name: (thumbnail as File).name,
        bytes: new Uint8Array(await thumbnail.arrayBuffer()),
      });
    return mockCreateMarket(
      conditionId,
      JSON.parse(String(form.get("metadata"))),
      form.get("thumbnail"),
    );
  },
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

vi.mock("@/lib/marketRegistrationFee", async () => ({
  ...(await vi.importActual<typeof import("@/lib/marketRegistrationFee")>(
    "@/lib/marketRegistrationFee",
  )),
  MAX_CONDITION_REGISTRATION_FEE_SUBUNITS: 1000000,
  getAvailableRegularBalanceSubunits: (...args: unknown[]) =>
    mockGetAvailableRegularBalanceSubunits(...args),
  registerConditionWithFee: (...args: unknown[]) => mockRegisterConditionWithFee(...args),
  prepareConditionRegistrationFee: async (input: { operationRef: string | null }) => {
    if (input.operationRef !== null) runtime.feeOperations.push(input.operationRef);
    return { kind: "fee-free" };
  },
  deliverPreparedConditionRegistrationFee: async (_prepared: unknown, input: any) =>
    mockRegisterConditionWithFee({
      mintUrl: input.mintUrl,
      requiredFeeSubunits: input.requiredFeeSubunits,
      request: input.request,
    }),
  confirmConditionRegistrationFee: async () => {},
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

vi.mock("@/lib/kormir", async () => ({
  withBrowserOracleMutation: (...args: unknown[]) => mockWithBrowserOracleMutation(...args),
  getOracleAnnouncementEventId: (...args: unknown[]) => mockGetOracleAnnouncementEventId(...args),
  prepareEnumAnnouncement: async (_core: unknown, ...args: any[]) => {
    const sdk = await import("@bitcaster/client-sdk");
    const { finalizeEvent, getPublicKey } = await import("nostr-tools/pure");
    const key = new Uint8Array(32).fill(0x11);
    const artifactHex = await mockPrepareEnumAnnouncement(...args);
    runtime.conditionId = sdk.deriveDlcConditionId({
      eventId: args[0],
      outcomeCount: args[1].length,
      oraclePublicKeys: [getPublicKey(key)],
    });
    return {
      artifactHex,
      eventJson: JSON.stringify(
        finalizeEvent({ kind: 88, created_at: 1_700_000_000, tags: [], content: "qrs=" }, key),
      ),
    };
  },
}));

vi.mock("@/lib/identityOps", async () => ({
  resolveNsecIdentity: (secret: string | null) =>
    secret === null
      ? null
      : {
          publicKey: getPublicKey(new Uint8Array(Buffer.from(secret, "hex"))),
        },
}));

vi.mock("@/lib/cashu", () => ({
  captureBrowserMintPersistenceContext: () => ({
    database: runtime.database,
    seed: runtime.seed,
    scopeId: runtime.scopeId,
    activeMintUrl: mockWalletState.activeMintUrl,
    requireCapturedProfile: () => {},
  }),
  getWalletForUnit: vi.fn(),
}));

vi.mock("@/lib/slug", async () => {
  const actual = await vi.importActual<typeof import("@/lib/slug")>("@/lib/slug");
  return {
    ...actual,
    buildEventId: (title: string) => `${actual.slugifyEventTitle(title) || "market"}_abcdefabcdef`,
  };
});
vi.mock("@/lib/nostr", () => ({
  withTemporaryRelayNdk: async (_options: unknown, _signer: unknown, callback: any) => callback({}),
}));

// Real WASM and the portable limit are covered by the browser creation adapter tests.
vi.mock("@/lib/browserOracleBackupDelivery", () => ({
  requestBrowserOracleBackup: vi.fn(),
}));
vi.mock("@/lib/browserOracleBackup", () => ({
  preflightBrowserOracleCreation: vi.fn(async () => {}),
  preflightLockedBrowserOracleCreation: vi.fn(async () => {}),
}));
vi.mock("@nostr-dev-kit/ndk", async () => ({
  ...(await vi.importActual("@nostr-dev-kit/ndk")),
  NDKEvent: class {
    constructor(_ndk: unknown, event: unknown) {
      runtime.published.push(JSON.stringify(event));
    }
    async publish() {
      return new Set(["relay"]);
    }
  },
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
    persist: {
      hasHydrated: () => walletHydration.hydrated,
      onFinishHydration: (listener: () => void) => {
        walletHydration.listeners.add(listener);
        return () => walletHydration.listeners.delete(listener);
      },
    },
  },
}));

// Pull the creator-markets store into the test so the post-success
// "0% fee" assertion can read the persisted entry. Mocked separately from
// the store under test so the assertion sees real reads/writes.
import { useCreatorMarketsStore } from "@/stores/creatorMarkets";
import type { MarketRegistrationResponse } from "@/lib/markets";
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

const walletId = deriveDurableCustodyWalletId(runtime.seed);
const walletScopeId = deriveDurableCustodyScopeId({
  scopeKind: "wallet",
  walletId,
});
const databaseName = browserWalletDatabaseName(walletScopeId);
const conditionId = deriveDlcConditionId({
  eventId: "test_market_abcdefabcdef",
  outcomeCount: 2,
  oraclePublicKeys: [getPublicKey(new Uint8Array(32).fill(0x11))],
});
const announcementEvent = finalizeEvent(
  { kind: 88, created_at: 1_700_000_000, tags: [], content: "qrs=" },
  new Uint8Array(32).fill(0x11),
);

beforeEach(async () => {
  vi.resetAllMocks();
  walletHydration.hydrated = true;
  walletHydration.listeners.clear();
  installCreatorDocumentLocks();
  // Each independent creation fixture owns a fresh public creator record.
  await useCreatorMarketsStore.getState().clear();
  runtime.draftStore = null;
  vi.stubGlobal("Blob", NativeBlob);
  vi.stubGlobal("File", NativeFile);
  vi.stubGlobal("FormData", NativeFormData);
  vi.stubGlobal("crypto", webcrypto);
  URL.createObjectURL = vi.fn(() => "blob:retained-thumbnail");
  URL.revokeObjectURL = vi.fn();
  runtime.database = new BitcasterDB(databaseName);
  runtime.scopeId = walletScopeId;
  runtime.seed = new Uint8Array(64).fill(0x11);
  runtime.engineThumbnails = [];
  runtime.published = [];
  runtime.feeOperations = [];
  runtime.conditionId = conditionId;
  runtime.lookupMint.mockImplementation(async () =>
    Response.json({ code: 13021 }, { status: 400 }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => runtime.lookupMint()),
  );
  mockRegisterConditionWithFee.mockImplementation(async () => ({
    condition_id: runtime.conditionId,
    keysets: { Yes: "ks1", No: "ks2" },
  }));
  mockGetAvailableRegularBalanceSubunits.mockResolvedValue(1000);
  mockCreateMarket.mockImplementation(async (_id, metadata, thumbnail) => ({
    conditionId: runtime.conditionId,
    baseAsset: "sat",
    marketsCreated: metadata.outcomes.map(
      (outcome: { name: string }) => `${runtime.conditionId}-${outcome.name}`,
    ),
    outcomeDetails: metadata.outcomes,
    thumbnailUrl: thumbnail ? "/original-thumbnail" : null,
    divisibility: 1_000,
  }));
  mockFetchMarketRegistrationForRecovery.mockResolvedValue(null);
  mockPrepareEnumAnnouncement.mockResolvedValue("aabb");
  mockWithBrowserOracleMutation.mockImplementation(
    async (_pubkey: string, action: (core: unknown) => Promise<unknown>) => action({}),
  );
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
              {
                unit: "msat",
                registration_fee_base: 0,
                registration_fee_per_keyset: 0,
              },
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

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  const imageId = useMarketDraftStore.getState().draft.thumbnailId;
  if (imageId) await marketDraftImages.remove(imageId);
  runtime.database?.close();
  await Dexie.delete(databaseName);
  vi.unstubAllGlobals();
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

function registrationMarket(
  overrides: Partial<MarketRegistrationResponse> = {},
): MarketRegistrationResponse {
  return {
    conditionId: conditionId,
    creatorPubkey: getPublicKey(new Uint8Array(32).fill(0x11)),
    outcomes: ["Yes", "No"],
    outcomeDetails: [
      { name: "Yes", color: "#112233" },
      { name: "No", color: "#445566" },
    ],
    baseAsset: "sat",
    divisibility: 1_000,
    thumbnailUrl: null,
    ...overrides,
  };
}

async function coldReloadCreation() {
  cleanup();
  runtime.database.close();
  runtime.database = new BitcasterDB(databaseName);
  await useMarketDraftStore.persist.rehydrate();
  const { result } = renderHook(() => useMarketCreationState(), { wrapper });
  await waitFor(() => expect(result.current.isLoadingCreation).toBe(false));
  await waitFor(() => expect(result.current.retainedCreation).not.toBeNull());
  return result;
}

async function beginPaidCreation() {
  mockWalletState.mints[0].info.nuts.CTF.registration_fees[0].registration_fee_base = 7;
  const result = await setupDraftForSubmission();
  await act(async () => {
    await result.current.onCreateMarket();
  });
  expect(result.current.registrationFeePrompt?.feeSubunits).toBe(7);
  return result;
}

describe("retained creation loading", () => {
  function retainPointer(creationId = "pending-creation") {
    const creation = { creationId, binding: currentBrowserMarketCreationBinding() };
    useMarketDraftStore.getState().setDraft((draft) => ({ ...draft, creation }));
    return useMarketDraftStore.getState().draft.creation!;
  }

  it("reports loading on the first render and throughout wallet hydration", async () => {
    retainPointer();
    walletHydration.hydrated = false;
    const read = vi.spyOn(BrowserMarketCreationStore.prototype, "read").mockResolvedValue(null);
    const renders: boolean[] = [];
    const { result } = renderHook(
      () => {
        const state = useMarketCreationState();
        renders.push(state.isLoadingCreation);
        return state;
      },
      { wrapper },
    );
    expect(renders[0]).toBe(true);
    expect(result.current.isLoadingCreation).toBe(true);
    expect(read).not.toHaveBeenCalled();
    await act(async () => {
      walletHydration.hydrated = true;
      walletHydration.listeners.forEach((listener) => listener());
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.isLoadingCreation).toBe(false);
    expect(mockRegisterConditionWithFee).not.toHaveBeenCalled();
  });

  it("stops loading immediately when the pointer is cleared and ignores the cancelled failure", async () => {
    retainPointer();
    let rejectRead!: (error: Error) => void;
    vi.spyOn(BrowserMarketCreationStore.prototype, "read").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectRead = reject;
        }),
    );
    const { result } = renderHook(() => useMarketCreationState(), { wrapper });
    expect(result.current.isLoadingCreation).toBe(true);
    act(() => useMarketDraftStore.setState({ draft: defaultDraft() }));
    expect(result.current.isLoadingCreation).toBe(false);
    await act(async () => rejectRead(new Error("cancelled read")));
    expect(result.current.submitError).toBeNull();
    expect(result.current.retainedCreation).toBeNull();
    expect(mockRegisterConditionWithFee).not.toHaveBeenCalled();
  });

  it("keeps a replacement pointer pending when the old read completes", async () => {
    retainPointer("first");
    const complete = new Map<string, () => void>();
    vi.spyOn(BrowserMarketCreationStore.prototype, "read").mockImplementation(
      (id) => new Promise((resolve) => complete.set(id, () => resolve(null))),
    );
    const { result } = renderHook(() => useMarketCreationState(), { wrapper });
    act(() => {
      retainPointer("second");
    });
    await act(async () => complete.get("first")!());
    expect(result.current.isLoadingCreation).toBe(true);
    await act(async () => complete.get("second")!());
    expect(result.current.isLoadingCreation).toBe(false);
    expect(result.current.retainedCreation).toBeNull();
    expect(mockRegisterConditionWithFee).not.toHaveBeenCalled();
  });

  it("cancels hydration waiting when the pointer is cleared", async () => {
    retainPointer();
    walletHydration.hydrated = false;
    const read = vi.spyOn(BrowserMarketCreationStore.prototype, "read").mockResolvedValue(null);
    const { result } = renderHook(() => useMarketCreationState(), { wrapper });
    act(() => useMarketDraftStore.setState({ draft: defaultDraft() }));
    expect(result.current.isLoadingCreation).toBe(false);
    await act(async () => {
      walletHydration.hydrated = true;
      walletHydration.listeners.forEach((listener) => listener());
    });
    expect(read).not.toHaveBeenCalled();
  });
});

describe("preparation-independent draft image", () => {
  it("survives remount before wallet setup and supplies exact retained bytes after setup", async () => {
    const result = await setupDraftForSubmission();
    const walletDatabase = runtime.database;
    runtime.database = null;
    const bytes = new Uint8Array([255, 216, 255, 217]);
    await act(async () =>
      result.current.onThumbnailUpload(new File([bytes], "draft.jpg", { type: "image/jpeg" })),
    );
    await waitFor(() => expect(result.current.thumbnailPending).toBe(false));
    const selectionId = useMarketDraftStore.getState().draft.thumbnailId!;
    expect(useMarketDraftStore.getState().draft.creation).toBeUndefined();
    cleanup();
    await useMarketDraftStore.persist.rehydrate();
    const reloaded = renderHook(() => useMarketCreationState(), { wrapper }).result;
    await waitFor(() => expect(reloaded.current.thumbnailFile?.name).toBe("draft.jpg"));
    expect(reloaded.current.thumbnailFile?.type).toBe("image/jpeg");
    expect(Array.from(new Uint8Array(await reloaded.current.thumbnailFile!.arrayBuffer()))).toEqual(
      Array.from(bytes),
    );
    expect(reloaded.current.draft.stepBasicInfo?.imageFile).toBe("blob:retained-thumbnail");
    // Wallet setup is later. The draft image was never placed in that database.
    runtime.database = walletDatabase;
    await act(async () => {
      await reloaded.current.onCreateMarket();
    });
    expect(runtime.engineThumbnails[0].name).toBe("draft.jpg");
    expect(Array.from(runtime.engineThumbnails[0].bytes)).toEqual(Array.from(bytes));
    await waitFor(async () => {
      await expect(marketDraftImages.read(selectionId)).rejects.toThrow("not retained");
    });
  });

  it("blocks preparation after retention fails until explicit removal", async () => {
    const result = await setupDraftForSubmission();
    const retain = vi
      .spyOn(marketDraftImages, "retain")
      .mockRejectedValueOnce(new DOMException("Full", "QuotaExceededError"));
    await act(async () =>
      result.current.onThumbnailUpload(
        new File([new Uint8Array([1])], "failed.jpg", { type: "image/jpeg" }),
      ),
    );
    await waitFor(() => expect(result.current.thumbnailPending).toBe(false));
    expect([
      i18n.t("marketCreation.imageRetentionFailed"),
      i18n.t("marketCreation.imageRetentionMissing"),
    ]).toContain(result.current.thumbnailError);
    expect(result.current.thumbnailError).not.toContain("Full");
    await act(async () => {
      await result.current.onCreateMarket();
    });
    expect(mockPrepareEnumAnnouncement).not.toHaveBeenCalled();
    expect(mockRegisterConditionWithFee).not.toHaveBeenCalled();
    expect(mockCreateMarket).not.toHaveBeenCalled();
    cleanup();
    await useMarketDraftStore.persist.rehydrate();
    const reloaded = renderHook(() => useMarketCreationState(), { wrapper }).result;
    await waitFor(() =>
      expect(reloaded.current.thumbnailError).toBe(i18n.t("marketCreation.imageRetentionMissing")),
    );
    await act(async () => {
      await reloaded.current.onCreateMarket();
    });
    expect(mockPrepareEnumAnnouncement).not.toHaveBeenCalled();
    await act(async () => {
      await reloaded.current.onThumbnailRemove();
    });
    await waitFor(() => expect(reloaded.current.thumbnailError).toBeNull());
    expect(useMarketDraftStore.getState().draft.thumbnailId).toBeUndefined();
    retain.mockRestore();
  });

  it("does not let delayed cleanup failure block a newer retained image", async () => {
    const result = await setupDraftForSubmission();
    await act(async () =>
      result.current.onThumbnailUpload(
        new File([new Uint8Array([1])], "first.jpg", { type: "image/jpeg" }),
      ),
    );
    await waitFor(() => expect(result.current.thumbnailFile?.name).toBe("first.jpg"));
    let rejectCleanup!: (error: Error) => void;
    const cleanupFailure = new Promise<void>((_, reject) => {
      rejectCleanup = reject;
    });
    const remove = vi
      .spyOn(marketDraftImages, "remove")
      .mockImplementationOnce(() => cleanupFailure);
    let removal!: Promise<void>;
    act(() => {
      removal = result.current.onThumbnailRemove();
    });
    expect(useMarketDraftStore.getState().draft.thumbnailId).toBeUndefined();
    const bytes = new Uint8Array([255, 216, 255, 217]);
    await act(async () =>
      result.current.onThumbnailUpload(
        new File([bytes], "replacement.jpg", { type: "image/jpeg" }),
      ),
    );
    await waitFor(() => expect(result.current.thumbnailFile?.name).toBe("replacement.jpg"));
    const replacementId = useMarketDraftStore.getState().draft.thumbnailId;
    const preview = result.current.draft.stepBasicInfo?.imageFile;
    await act(async () => {
      rejectCleanup(new Error("Old attachment cleanup failed"));
      await removal;
    });
    expect(result.current.thumbnailError).toBeNull();
    expect(result.current.thumbnailPending).toBe(false);
    expect(result.current.thumbnailFile?.name).toBe("replacement.jpg");
    expect(result.current.draft.stepBasicInfo?.imageFile).toBe(preview);
    expect(useMarketDraftStore.getState().draft.thumbnailId).toBe(replacementId);
    await act(async () => {
      await result.current.onCreateMarket();
    });
    expect(runtime.engineThumbnails[0].name).toBe("replacement.jpg");
    expect(Array.from(runtime.engineThumbnails[0].bytes)).toEqual(Array.from(bytes));
    expect(mockPrepareEnumAnnouncement).toHaveBeenCalledOnce();
    expect(mockCreateMarket).toHaveBeenCalledOnce();
    remove.mockRestore();
  });

  it("start over removes the unprepared attachment but retains an unfinished creation's attachment", async () => {
    const result = await setupDraftForSubmission();
    await act(async () =>
      result.current.onThumbnailUpload(
        new File([new Uint8Array([1])], "draft.jpg", { type: "image/jpeg" }),
      ),
    );
    const id = useMarketDraftStore.getState().draft.thumbnailId!;
    await act(async () => result.current.clearDraft());
    await waitFor(async () => {
      await expect(marketDraftImages.read(id)).rejects.toThrow("not retained");
    });
    cleanup();
    // The existing paid-retry case below still verifies the exact immutable attempt.
    const pending = await beginPaidCreation();
    await act(async () =>
      pending.current.onThumbnailUpload(
        new File([new Uint8Array([2])], "paid.jpg", { type: "image/jpeg" }),
      ),
    );
    mockCreateMarket.mockRejectedValueOnce(new CreateMarketError("unauthorized", 401, false));
    await act(async () => {
      await pending.current.onConfirmRegistrationFee();
    });
    const before = useMarketDraftStore.getState().draft;
    await act(async () => pending.current.clearDraft());
    expect(useMarketDraftStore.getState().draft.creation).toEqual(before.creation);
    expect(useMarketDraftStore.getState().draft.thumbnailId).toBe(before.thumbnailId);
    expect((await marketDraftImages.read(before.thumbnailId!)).filename).toBe("paid.jpg");
  });
});

describe("durable browser market creation", () => {
  it("retains a paid image mismatch and restores specific translated guidance after reload", async () => {
    const result = await beginPaidCreation();
    await act(async () =>
      result.current.onThumbnailUpload(
        new File([new Uint8Array([1, 2, 3])], "original.png", { type: "image/png" }),
      ),
    );
    mockCreateMarket.mockResolvedValueOnce({
      conditionId,
      baseAsset: "sat",
      divisibility: 1000,
      marketsCreated: [`${conditionId}-Yes`, `${conditionId}-No`],
      thumbnailUrl: null,
    });
    await act(async () => {
      await result.current.onConfirmRegistrationFee();
    });
    expect(result.current.createdMarketConditionId).toBeNull();
    expect(result.current.submitError).toBe(i18n.t("marketCreation.creationImageMismatch"));
    expect(useMarketDraftStore.getState().draft.creation?.failure?.code).toBe(
      "thumbnail-presence-mismatch",
    );
    const creationId = useMarketDraftStore.getState().draft.creation!.creationId;
    const retained = await runtime.database.marketCreations.get([walletScopeId, creationId]);
    expect(retained.mintConfirmed).toBe(true);
    expect(retained.thumbnail?.filename).toBe("original.png");
    const reloaded = await coldReloadCreation();
    expect(reloaded.current.submitError).toBe(i18n.t("marketCreation.creationImageMismatch"));
    mockFetchMarketRegistrationForRecovery.mockResolvedValue(registrationMarket());
    await act(async () => {
      await reloaded.current.onResumeCreation();
    });
    expect(reloaded.current.createdMarketConditionId).toBeNull();
    expect(mockCreateMarket).toHaveBeenCalledTimes(1);
    expect(mockRegisterConditionWithFee).toHaveBeenCalledTimes(1);
    expect(runtime.feeOperations).toHaveLength(1);
    expect(
      (await runtime.database.marketCreations.get([walletScopeId, creationId])).thumbnail,
    ).toEqual(retained.thumbnail);
    try {
      await act(async () => {
        await i18n.changeLanguage("ja");
      });
      expect(reloaded.current.submitError).toBe(i18n.t("marketCreation.creationImageMismatch"));
      expect(reloaded.current.submitError).toContain("画像の自動修復はできません");
    } finally {
      await act(async () => {
        await i18n.changeLanguage("en");
      });
    }
  });

  it("resumes a paid engine 401 after a cold read with the original thumbnail and one announcement", async () => {
    const result = await beginPaidCreation();
    const bytes = new Uint8Array(2 * 1024 * 1024).fill(0x7a);
    await act(async () =>
      result.current.onThumbnailUpload(new File([bytes], "original.png", { type: "image/png" })),
    );
    mockCreateMarket.mockRejectedValueOnce(new CreateMarketError("unauthorized", 401, false));
    await act(async () => {
      await result.current.onConfirmRegistrationFee();
    });
    expect(result.current.retainedCreation?.mintConfirmed).toBe(true);
    expect(result.current.submitError).toBe(i18n.t("marketCreation.creationIncompleteError"));
    const id = useMarketDraftStore.getState().draft.creation!.creationId;
    const retained = await runtime.database.marketCreations.get([walletScopeId, id]);
    expect(retained.thumbnail.data.byteLength).toBe(bytes.byteLength);
    expect(new Uint8Array(retained.thumbnail.data).every((byte) => byte === 0x7a)).toBe(true);
    const reloaded = await coldReloadCreation();
    expect(reloaded.current.thumbnailFile).toBeNull();
    expect(reloaded.current.retainedCreation?.mintConfirmed).toBe(true);
    await act(async () => {
      await reloaded.current.onResumeCreation();
    });
    expect(reloaded.current.createdMarketConditionId).toBe(conditionId);
    expect(mockRegisterConditionWithFee).toHaveBeenCalledTimes(1);
    expect(runtime.feeOperations).toHaveLength(1);
    expect(runtime.feeOperations[0]).toBe(retained.registration.feeOperationRef);
    expect(mockPrepareEnumAnnouncement).toHaveBeenCalledTimes(1);
    expect(runtime.published).toEqual([retained.announcement.announcementNostrEventJson]);
    expect(runtime.engineThumbnails).toHaveLength(2);
    expect(
      runtime.engineThumbnails.every(
        (file) =>
          file.name === "original.png" &&
          file.bytes.every((byte) => byte === 0x7a) &&
          file.bytes.length === bytes.length,
      ),
    ).toBe(true);
    expect(useMarketDraftStore.getState().draft.creation).toBeUndefined();
  });

  it("does not treat unavailable mint reconciliation as absence after a lost paid response", async () => {
    const result = await beginPaidCreation();
    mockRegisterConditionWithFee.mockRejectedValueOnce(new Error("lost mint response"));
    runtime.lookupMint
      .mockImplementationOnce(async () => Response.json({ code: 13021 }, { status: 400 }))
      .mockImplementationOnce(async () => new Response("unavailable", { status: 503 }));
    await act(async () => {
      await result.current.onConfirmRegistrationFee();
    });
    expect(mockCreateMarket).not.toHaveBeenCalled();
    const retained = await runtime.database.marketCreations.toArray();
    expect(retained[0].mintConfirmed).toBe(false);
    runtime.lookupMint.mockImplementation(async () =>
      Response.json({
        condition_id: conditionId,
        collateral: "msat",
        announcements: ["aabb"],
        tags: [
          ["title", "Test Market"],
          ["description", "Test description"],
        ],
      }),
    );
    const reloaded = await coldReloadCreation();
    await act(async () => {
      await reloaded.current.onResumeCreation();
    });
    expect(reloaded.current.createdMarketConditionId).toBe(conditionId);
    expect(mockRegisterConditionWithFee).toHaveBeenCalledTimes(1);
    expect(runtime.feeOperations).toHaveLength(1);
    expect(mockPrepareEnumAnnouncement).toHaveBeenCalledTimes(1);
    expect(runtime.published).toHaveLength(1);
  });

  it("reconciles the original engine registration on reload after response and lookup loss", async () => {
    const result = await beginPaidCreation();
    mockCreateMarket.mockRejectedValueOnce(new CreateMarketError("lost response", null, true));
    mockFetchMarketRegistrationForRecovery
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("lookup unavailable"));
    await act(async () => {
      await result.current.onConfirmRegistrationFee();
    });
    const reloaded = await coldReloadCreation();
    mockFetchMarketRegistrationForRecovery.mockResolvedValue(registrationMarket());
    await act(async () => {
      await reloaded.current.onResumeCreation();
    });
    expect(reloaded.current.createdMarketConditionId).toBe(conditionId);
    expect(mockCreateMarket).toHaveBeenCalledTimes(1);
    expect(mockRegisterConditionWithFee).toHaveBeenCalledTimes(1);
    expect(runtime.feeOperations).toHaveLength(1);
    expect(runtime.published).toHaveLength(1);
  });

  it.each(["wallet", "scope", "mint", "creator", "engine"] as const)(
    "refuses a changed %s binding before another effect",
    async (changed) => {
      const result = await beginPaidCreation();
      mockCreateMarket.mockRejectedValueOnce(new CreateMarketError("unauthorized", 401, false));
      await act(async () => {
        await result.current.onConfirmRegistrationFee();
      });
      switch (changed) {
        case "wallet":
          runtime.seed = new Uint8Array(64).fill(0x22);
          break;
        case "scope":
          runtime.scopeId = "other-wallet-scope";
          break;
        case "mint":
          mockWalletState.activeMintUrl = "https://other-mint.example";
          break;
        case "creator":
          useSettingsStore.setState({ nsecSecret: "22".repeat(32) });
          break;
        case "engine":
          useMarketDraftStore.getState().setDraft((draft) => ({
            ...draft,
            creation: {
              ...draft.creation!,
              binding: {
                ...draft.creation!.binding,
                engineBaseUrl: "https://other-engine.example",
              },
            },
          }));
          break;
      }
      const counts = [
        runtime.lookupMint.mock.calls.length,
        mockFetchMarketRegistrationForRecovery.mock.calls.length,
      ];
      await act(async () => {
        await result.current.onResumeCreation();
      });
      expect(result.current.createdMarketConditionId).toBeNull();
      expect(runtime.feeOperations).toHaveLength(1);
      expect(runtime.published).toHaveLength(1);
      expect(mockCreateMarket).toHaveBeenCalledTimes(1);
      expect([
        runtime.lookupMint.mock.calls.length,
        mockFetchMarketRegistrationForRecovery.mock.calls.length,
      ]).toEqual(counts);
    },
  );

  it("refuses changed paid draft creation and resumes only immutable saved metadata", async () => {
    const result = await beginPaidCreation();
    mockCreateMarket.mockRejectedValueOnce(new CreateMarketError("unauthorized", 401, false));
    await act(async () => {
      await result.current.onConfirmRegistrationFee();
    });
    await act(async () => {
      result.current.onTitleChange("Different paid market");
      result.current.onDescriptionChange("Changed");
    });
    await act(async () => {
      await result.current.onCreateMarket();
    });
    expect(mockCreateMarket).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.onResumeCreation();
    });
    expect(mockCreateMarket.mock.calls[1][1]).toMatchObject({
      title: "Test Market",
      description: "Test description",
    });
    expect(runtime.feeOperations).toHaveLength(1);
    expect(mockPrepareEnumAnnouncement).toHaveBeenCalledTimes(1);
  });

  it("keeps the completed pointer when the creator row fails, then cold-resumes only its save", async () => {
    await useCreatorMarketsStore.getState().clear();
    const result = await beginPaidCreation();
    const original = Storage.prototype.setItem;
    const failure = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (key === "bitcaster-creator-markets") throw new Error("creator storage unavailable");
      return original.call(this, key, value);
    });
    await act(async () => {
      await result.current.onConfirmRegistrationFee();
    });
    expect(result.current.createdMarketConditionId).toBeNull();
    expect(useMarketDraftStore.getState().draft.creation).toBeDefined();
    const rows = await runtime.database.marketCreations.toArray();
    expect(rows[0].engineResult).not.toBeNull();
    failure.mockRestore();
    await useCreatorMarketsStore.persist.rehydrate();
    expect(useCreatorMarketsStore.getState().markets).toEqual([]);
    const counts = [
      runtime.lookupMint.mock.calls.length,
      mockFetchMarketRegistrationForRecovery.mock.calls.length,
    ];
    const reloaded = await coldReloadCreation();
    await act(async () => {
      await reloaded.current.onResumeCreation();
    });
    expect(reloaded.current.createdMarketConditionId).toBe(conditionId);
    expect(useMarketDraftStore.getState().draft.creation).toBeUndefined();
    expect(useCreatorMarketsStore.getState().markets[0].oracle?.announcementEventJson).toBe(
      rows[0].announcement.announcementNostrEventJson,
    );
    expect(runtime.feeOperations).toHaveLength(1);
    expect(runtime.published).toHaveLength(1);
    expect(mockPrepareEnumAnnouncement).toHaveBeenCalledTimes(1);
    expect(mockRegisterConditionWithFee).toHaveBeenCalledTimes(1);
    expect(mockCreateMarket).toHaveBeenCalledTimes(1);
    expect([
      runtime.lookupMint.mock.calls.length,
      mockFetchMarketRegistrationForRecovery.mock.calls.length,
    ]).toEqual(counts);
  });

  it("fails a real creation-store writer before fee or publication", async () => {
    const result = await beginPaidCreation();
    vi.spyOn(runtime.database.marketCreations, "add").mockRejectedValueOnce(
      new Error("storage unavailable"),
    );
    await act(async () => {
      await result.current.onConfirmRegistrationFee();
    });
    expect(await runtime.database.marketCreations.count()).toBe(0);
    expect(useMarketDraftStore.getState().draft.creation).toBeDefined();
    expect(runtime.feeOperations).toHaveLength(0);
    expect(runtime.published).toHaveLength(0);
    expect(mockRegisterConditionWithFee).not.toHaveBeenCalled();
    expect(mockCreateMarket).not.toHaveBeenCalled();
  });

  it("fails draft pointer persistence before fee or publication on every retry", async () => {
    const result = await beginPaidCreation();
    const original = Storage.prototype.setItem;
    const failure = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (
        key === "bitcaster-market-draft" &&
        JSON.parse(String(value)).state.draft.creation !== undefined
      )
        throw new Error("draft storage unavailable");
      original.call(this, key, value);
    });
    try {
      await act(async () => {
        await result.current.onConfirmRegistrationFee();
      });
      await act(async () => {
        await result.current.onCreateMarket();
      });
      expect(await runtime.database.marketCreations.count()).toBe(0);
      expect(mockPrepareEnumAnnouncement).not.toHaveBeenCalled();
      expect(runtime.feeOperations).toHaveLength(0);
      expect(runtime.published).toHaveLength(0);
    } finally {
      failure.mockRestore();
    }
  });

  it("fails before preparation when the actual draft store initialized without localStorage", async () => {
    const storage = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          throw new DOMException("fixture storage denied", "SecurityError");
        },
      });
      vi.resetModules();
      const cold =
        await vi.importActual<typeof import("@/stores/marketDraft")>("@/stores/marketDraft");
      runtime.draftStore = cold.useMarketDraftStore;
      Object.defineProperty(window, "localStorage", storage);
      // Zustand's swallowed getter failure is permanent for this instance,
      // even when the browser getter becomes available before submission.
      expect(cold.useMarketDraftStore.persist).toBeUndefined();
      expect(cold.useMarketDraftStore.getState().hasCreationPersistence()).toBe(false);
      mockWalletState.mints[0].info.nuts.CTF.registration_fees[0].registration_fee_base = 7;
      const result = await setupDraftForSubmission();
      await act(async () => {
        await result.current.onCreateMarket();
      });
      expect(result.current.registrationFeePrompt).toBeNull();
      await act(async () => {
        await result.current.onConfirmRegistrationFee();
      });
      expect(runtime.feeOperations).toHaveLength(0);
      expect(mockPrepareEnumAnnouncement).not.toHaveBeenCalled();
      expect(runtime.published).toHaveLength(0);
      expect(mockRegisterConditionWithFee).not.toHaveBeenCalled();
      expect(mockCreateMarket).not.toHaveBeenCalled();
      expect(await runtime.database.marketCreations.count()).toBe(0);
      expect(result.current.submitError).toBe(i18n.t("marketCreation.creationStorageUnavailable"));
      expect(
        JSON.parse(localStorage.getItem("bitcaster-market-draft")!).state.draft.creation,
      ).toBeUndefined();
    } finally {
      Object.defineProperty(window, "localStorage", storage);
      warning.mockRestore();
    }
  });

  it("retains a dismissed failure identity across cold reload and draft reset", async () => {
    const result = await beginPaidCreation();
    mockCreateMarket.mockRejectedValueOnce(new CreateMarketError("unauthorized", 401, false));
    await act(async () => {
      await result.current.onConfirmRegistrationFee();
    });
    const pointer = useMarketDraftStore.getState().draft.creation!;
    await act(async () => {
      result.current.onDismissCreationError();
      result.current.clearDraft();
    });
    expect(useMarketDraftStore.getState().draft.creation?.creationId).toBe(pointer.creationId);
    const reloaded = await coldReloadCreation();
    expect(reloaded.current.submitError).toBeNull();
    expect(reloaded.current.retainedCreation?.mintConfirmed).toBe(true);
    expect(() => useMarketDraftStore.getState().completeCreation("wrong-id")).toThrow();
  });

  it.each(["thumbnail", "metadata", "multipart"] as const)(
    "rejects the %s limit before fee and signing",
    async (limit) => {
      const result = await setupDraftForSubmission();
      switch (limit) {
        case "thumbnail":
          await act(async () =>
            result.current.onThumbnailUpload(
              new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png"),
            ),
          );
          break;
        case "metadata":
          await act(async () => result.current.onDescriptionChange("x".repeat(65537)));
          break;
        case "multipart":
          await act(async () =>
            result.current.onThumbnailUpload(
              new File([new Uint8Array(5 * 1024 * 1024)], "x".repeat(1024 * 1024), {
                type: "image/png",
              }),
            ),
          );
          break;
      }
      await act(async () => {
        await result.current.onCreateMarket();
      });
      if (limit === "thumbnail") {
        expect(result.current.thumbnailError).not.toBeNull();
        expect(result.current.submitError).toBe(result.current.thumbnailError);
      } else expect(result.current.submitError).toMatch(/Market (metadata|creation)/);
      expect(mockPrepareEnumAnnouncement).not.toHaveBeenCalled();
      expect(runtime.feeOperations).toHaveLength(0);
      expect(runtime.published).toHaveLength(0);
      expect(mockRegisterConditionWithFee).not.toHaveBeenCalled();
    },
  );
});

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
    expect(result.current.draft.stepReviewAndCreate).toEqual({
      description: "",
    });

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
      { id: "b", label: "B", description: "", color: "#E15759" },
      {
        id: expect.any(String),
        label: "",
        description: "",
        color: "#F28E2B",
      },
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
    expect(resumed.result.current.draft.stepOutcomes?.outcomes?.[0].color).toBe("#59A14F");
    expect(resumed.result.current.draft.stepOutcomes?.outcomes?.[1].color).toBe("#E15759");
  });

  it("restores visible defaults once and preserves Automatic across draft reload at maximum outcomes", async () => {
    setCategoricalOutcomes(Array.from({ length: 8 }, (_, index) => makeOutcome(String(index))));
    const first = renderHook(() => useMarketCreationState(), { wrapper });
    const original = first.result.current.draft.stepOutcomes!.outcomes!;
    expect(original.map((outcome) => outcome.color)).toEqual([
      "#59A14F",
      "#E15759",
      "#F28E2B",
      "#4E79A7",
      "#76B7B2",
      "#EDC948",
      "#B07AA1",
      "#FF9DA7",
    ]);
    const draftBeforeRerender = useMarketDraftStore.getState().draft;
    first.rerender();
    expect(useMarketDraftStore.getState().draft).toBe(draftBeforeRerender);
    await act(async () => first.result.current.onOutcomeColorChange("0", null));
    const selected = first.result.current.draft.stepOutcomes!.outcomes!;
    expect(selected[0].color).toBe("#2563EB");
    expect(selected.slice(1)).toEqual(original.slice(1));
    expect(new Set(selected.map((outcome) => outcome.color)).size).toBe(8);
    first.unmount();
    await act(async () => useMarketDraftStore.persist.rehydrate());
    const resumed = renderHook(() => useMarketCreationState(), { wrapper });
    expect(resumed.result.current.draft.stepOutcomes!.outcomes![0].color).toBe("#2563EB");
    await act(async () => resumed.result.current.onOutcomeColorChange("0", null));
    expect(resumed.result.current.draft.stepOutcomes!.outcomes![0].color).toBe("#59A14F");
  });
});

describe("useMarketCreationState – onCreateMarket", () => {
  it("uses the mint default keyset policy when registering the condition", async () => {
    const result = await setupDraftForSubmission();
    const callOrder: string[] = [];
    mockRegisterConditionWithFee.mockImplementation(async () => {
      callOrder.push("condition");
      return { condition_id: conditionId, keysets: { Yes: "ks1", No: "ks2" } };
    });
    mockCreateMarket.mockImplementation(async () => {
      callOrder.push("createMarket");
      return {
        conditionId,
        baseAsset: "sat",
        marketsCreated: [`${conditionId}-Yes`, `${conditionId}-No`],
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
        announcementHex: "aabb",
        collateral: "msat",
        outcomeCollections: undefined,
      },
    });
    expect(mockCreateMarket).toHaveBeenCalledOnce();
    expect(mockCreateMarket.mock.calls[0][1]).toMatchObject({
      oracleAnnouncementHex: "aabb",
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
                  {
                    unit: "msat",
                    registration_fee_base: 1,
                    registration_fee_per_keyset: 1,
                  },
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
      {
        unit: "msat",
        registration_fee_base: 10,
        registration_fee_per_keyset: 2,
      },
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
      {
        unit: "msat",
        registration_fee_base: 10,
        registration_fee_per_keyset: 2,
      },
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
      {
        unit: "msat",
        registration_fee_base: 10,
        registration_fee_per_keyset: 2,
      },
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
      {
        unit: "msat",
        registration_fee_base: 1000001,
        registration_fee_per_keyset: 0,
      },
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
    expect(mockWithBrowserOracleMutation).not.toHaveBeenCalled();
    expect(mockPrepareEnumAnnouncement).not.toHaveBeenCalled();
    expect(mockRegisterConditionWithFee).not.toHaveBeenCalled();
    expect(mockCreateMarket).not.toHaveBeenCalled();
  });

  it("rejects engine-invalid outcome labels before oracle publication or mint registration", async () => {
    setCategoricalSubmissionDraft([
      { id: "new-york", label: "New York", description: "" },
      { id: "tokyo", label: "Tokyo", description: "" },
    ]);
    const { result } = renderHook(() => useMarketCreationState(), { wrapper });

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(result.current.submitError).toBe(
      "Outcome labels must be 1 to 191 ASCII letters or digits.",
    );
    expect(mockWithBrowserOracleMutation).not.toHaveBeenCalled();
    expect(mockPrepareEnumAnnouncement).not.toHaveBeenCalled();
    expect(mockRegisterConditionWithFee).not.toHaveBeenCalled();
    expect(mockCreateMarket).not.toHaveBeenCalled();
  });

  it("checks the final serialized metadata limit before paying the mint registration fee", async () => {
    const result = await setupDraftForSubmission();
    mockPrepareEnumAnnouncement.mockResolvedValueOnce("a".repeat(65_537));

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(result.current.submitError).toBe("Market metadata exceeds the 64 KB engine limit.");
    expect(mockPrepareEnumAnnouncement).toHaveBeenCalledOnce();
    expect(mockGetOracleAnnouncementEventId).not.toHaveBeenCalled();
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

    expect(result.current.submitError).toBe(i18n.t("marketCreation.creationIncompleteError"));
    expect(mockCreateMarket).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("stops and sets error if createMarket fails", async () => {
    const result = await setupDraftForSubmission();
    mockCreateMarket.mockRejectedValueOnce(new Error("Market creation failed"));

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(result.current.submitError).toBe(i18n.t("marketCreation.creationIncompleteError"));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("adopts a matching committed market after a lost create response", async () => {
    await useCreatorMarketsStore.getState().clear();
    const result = await setupDraftForSubmission();
    await act(async () =>
      result.current.onThumbnailUpload(
        new File([new Uint8Array([4, 5])], "persisted.png", { type: "image/png" }),
      ),
    );
    const originalError = new CreateMarketError("connection was lost", null, true);
    mockCreateMarket.mockRejectedValueOnce(originalError);
    mockFetchMarketRegistrationForRecovery.mockResolvedValueOnce(null).mockResolvedValueOnce(
      registrationMarket({
        thumbnailUrl: "/persisted-thumbnail",
        outcomeDetails: [{ name: "Yes", color: null }, { name: "No" }],
      }),
    );

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(mockCreateMarket).toHaveBeenCalledOnce();
    expect(mockFetchMarketRegistrationForRecovery).toHaveBeenCalledTimes(2);
    expect(mockFetchMarketRegistrationForRecovery).toHaveBeenCalledWith(conditionId);
    expect(result.current.createdMarketConditionId).toBe(conditionId);
    expect(result.current.submitError).toBeNull();
    expect(
      useCreatorMarketsStore.getState().markets.find((market) => market.conditionId === conditionId)
        ?.thumbnailUrl,
    ).toBe("/persisted-thumbnail");
  });

  it("adopts first-committed colors when details are reordered and retry colors differ", async () => {
    await useCreatorMarketsStore.getState().clear();
    setCategoricalSubmissionDraft([
      { id: "alpha", label: "Alpha", description: "", color: "#111111" },
      { id: "beta", label: "Beta", description: "", color: "#222222" },
    ]);
    const { result } = renderHook(() => useMarketCreationState(), { wrapper });
    mockCreateMarket.mockRejectedValueOnce(new CreateMarketError("already exists", 409, true));
    mockFetchMarketRegistrationForRecovery.mockResolvedValueOnce(null).mockResolvedValueOnce(
      registrationMarket({
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
    expect(mockFetchMarketRegistrationForRecovery).toHaveBeenCalledTimes(2);
    expect(result.current.createdMarketConditionId).toBe(conditionId);
    expect(result.current.submitError).toBeNull();
  });

  it.each([
    {
      label: "unknown condition",
      overrides: { conditionId: "other-condition" },
    },
    { label: "wrong owner", overrides: { creatorPubkey: "b".repeat(64) } },
    { label: "wrong outcomes", overrides: { outcomes: ["Yes", "Gamma"] } },
    { label: "duplicate outcomes", overrides: { outcomes: ["Yes", "Yes"] } },
    {
      label: "wrong product units",
      overrides: { divisibility: 1_000_000 as const },
    },
    {
      label: "invalid persisted colors",
      overrides: {
        outcomeDetails: [
          { name: "Yes", color: "red" },
          { name: "No", color: "#445566" },
        ],
      },
    },
  ])("retains incomplete creation when reconciliation has $label", async ({ overrides }) => {
    const result = await setupDraftForSubmission();
    const originalError = new CreateMarketError("create result is uncertain", 503, true);
    mockCreateMarket.mockRejectedValueOnce(originalError);
    mockFetchMarketRegistrationForRecovery
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(registrationMarket(overrides as Partial<MarketRegistrationResponse>));

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(mockCreateMarket).toHaveBeenCalledOnce();
    expect(mockFetchMarketRegistrationForRecovery).toHaveBeenCalledTimes(2);
    expect(result.current.createdMarketConditionId).toBeNull();
    expect(result.current.submitError).toBe(i18n.t("marketCreation.creationIncompleteError"));
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

    expect(mockFetchMarketRegistrationForRecovery).toHaveBeenCalledOnce();
    expect(result.current.submitError).toBe(i18n.t("marketCreation.creationIncompleteError"));
    expect(useMarketDraftStore.getState().hasSavedDraft).toBe(true);
  });

  it("keeps the original create error when registration recovery is unavailable", async () => {
    const result = await setupDraftForSubmission();
    const originalError = new CreateMarketError("engine response was lost", null, true);
    mockCreateMarket.mockRejectedValueOnce(originalError);
    mockFetchMarketRegistrationForRecovery
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("registration unavailable"));

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(mockFetchMarketRegistrationForRecovery).toHaveBeenCalledTimes(2);
    expect(mockCreateMarket).toHaveBeenCalledOnce();
    expect(result.current.submitError).toBe(i18n.t("marketCreation.creationIncompleteError"));
    expect(useMarketDraftStore.getState().hasSavedDraft).toBe(true);
  });

  it("hands off to the deposit step on full success (does NOT navigate immediately)", async () => {
    const result = await setupDraftForSubmission();

    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(mockCreateMarket).toHaveBeenCalledOnce();
    expect(mockFetchMarketRegistrationForRecovery).toHaveBeenCalledOnce();
    // createMarket success transitions the wizard to the
    // deposit step rather than navigating to the market detail page. The
    // user funds the bot first; navigation happens from DepositStep once
    // the Lightning payment reaches Paid. The hook signals this via
    // `createdMarketConditionId`.
    expect(result.current.createdMarketConditionId).toBe(conditionId);
    expect(result.current.createdMarketDivisibility).toBe(1_000);
    expect(requestBrowserOracleBackup).toHaveBeenCalledWith(conditionId);
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

  it("submits manual and visible Automatic colors by exact outcome name", async () => {
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

    await act(async () => result.current.onOutcomeColorChange("beta", null));
    expect(result.current.draft.stepOutcomes!.outcomes![1].color).toBe("#E15759");
    await act(async () => {
      await result.current.onCreateMarket();
    });

    expect(mockCreateMarket.mock.calls[0][1].outcomes).toEqual([
      { name: "Alpha", color: "#123456" },
      { name: "Beta", color: "#E15759" },
    ]);
  });

  it("stamps creatorFeePercent=0 (P7 §/creator: engine accrues no fees)", async () => {
    // Reset the creator-markets store so the assertion is not polluted by
    // entries from the other tests in this file.
    await useCreatorMarketsStore.getState().clear();
    const result = await setupDraftForSubmission();

    await act(async () => {
      await result.current.onCreateMarket();
    });

    const entry = useCreatorMarketsStore
      .getState()
      .markets.find((m) => m.conditionId === conditionId);
    expect(entry).toBeDefined();
    expect(entry!.creatorFeePercent).toBe(0);
  });

  it("records self-oracle event metadata when creating as the oracle", async () => {
    await useCreatorMarketsStore.getState().clear();
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

    expect(mockWithBrowserOracleMutation).toHaveBeenCalledWith(
      getPublicKey(new Uint8Array(32).fill(0x11)),
      expect.any(Function),
    );
    expect(mockPrepareEnumAnnouncement).toHaveBeenCalledWith(
      expect.stringMatching(/^will_btc_hit_150k_[0-9a-f]{12}$/),
      ["Yes", "No"],
      expect.any(Number),
      "Will BTC hit $150k?",
      "Test description",
    );
    const entry = useCreatorMarketsStore.getState().markets[0];
    expect(entry.oracle?.type).toBe("self");
    expect(entry.oracle?.eventId).toMatch(/^will_btc_hit_150k_[0-9a-f]{12}$/);
    expect(entry.oracle?.announcementEventId).toBe(announcementEvent.id);
    expect(entry.oracle?.outcomes).toEqual(["Yes", "No"]);
  });
});
