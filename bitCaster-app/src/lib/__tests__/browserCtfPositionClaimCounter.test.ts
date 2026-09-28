// @vitest-environment node
import "fake-indexeddb/auto";
import Dexie from "dexie";
import {
  CheckStateEnum,
  Keyset,
  deriveKeysetId,
  hashToCurve,
  type MintKeys,
  type OutputData,
  type Proof,
} from "@cashu/cashu-ts";
import type { RedeemWallet } from "@bitcaster/client-sdk/ctfRedeem";
import { buildKeysetRedeemOperationId } from "@bitcaster/client-sdk/ctfRedeem";
import { deserializeOutputGroups } from "@bitcaster/client-sdk/ctfSplit";
import { deriveDurableCustodyOperationId } from "@bitcaster/client-sdk/durableCustody";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserWalletCounterDexieStore } from "../../stores/browser-wallet-counter-db";
import { activateBrowserWalletDatabase, db } from "../../stores/proof-db";
import {
  activeBrowserWalletScopeId,
  browserWalletScopeIdFromSeed,
  setActiveBrowserWalletProfile,
} from "../browserWalletProfile";
import { claimBrowserCanonicalCtfPosition } from "../browserCtfPositionClaim";
import { ensureWalletKeysetCounterReady } from "../cashu";
import { claimPortfolioPosition } from "../browserPortfolioClaim";
import {
  CONDITION,
  MINT,
  OUTCOME,
  REGULAR_KEYSET,
  fixture,
  immediateLockManager,
  signOutputs,
} from "./fixtures/browserCtfRedeemFixture";

const PROFILE = "disposable real-counter claim test profile";
const SAFE_COUNTER_MESSAGE = "Wallet counter recovery is incomplete for the selected keyset.";

const mocks = vi.hoisted(() => ({
  seed: new Uint8Array(64),
  getWalletForUnit: vi.fn(),
  getWalletForMnemonicUnit: vi.fn(),
  requireNewWritePermission: vi.fn(),
  restoreOutputs: vi.fn(),
}));

vi.mock("../bip39", () => ({ toSeed: () => mocks.seed }));
vi.mock("@/stores/wallet", () => ({
  useWalletStore: {
    getState: () => ({
      mnemonic: PROFILE,
      mints: [],
      getWalletForUnit: mocks.getWalletForUnit,
    }),
  },
  getWalletForMnemonicUnit: mocks.getWalletForMnemonicUnit,
}));
vi.mock("../browserWalletNewWritePermission", () => ({
  requireBrowserWalletNewWritePermission: mocks.requireNewWritePermission,
}));
vi.mock("../walletProfileLock", () => ({
  withWalletProfileLock: async (_scopeId: string, action: () => Promise<unknown>) => action(),
}));
vi.mock("@bitcaster/client-sdk/ctfSplit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bitcaster/client-sdk/ctfSplit")>();
  return { ...actual, restoreOutputGroups: mocks.restoreOutputs };
});

let currentMintKeyset: MintKeys = REGULAR_KEYSET;
let walletKeysets = new Map<string, Keyset>();
let testWallet: TestWallet;
let activeFixture: Awaited<ReturnType<typeof fixture>> | null = null;
let activeDatabaseName: string | null = null;

type TestWallet = {
  readonly batchRestore: ReturnType<typeof vi.fn>;
  readonly groupProofsByState: ReturnType<typeof vi.fn>;
  readonly getKeyset: ReturnType<typeof vi.fn>;
  readonly loadMint: ReturnType<typeof vi.fn>;
  readonly checkProofsStates: ReturnType<typeof vi.fn>;
  readonly redeemOutcomeProofs: ReturnType<typeof vi.fn>;
  readonly mint: {
    readonly mintUrl: string;
    readonly getKeys: ReturnType<typeof vi.fn>;
    readonly getKeySets: ReturnType<typeof vi.fn>;
  };
};

type SerializedOutputGroups = Parameters<typeof deserializeOutputGroups>[0];

function makeWallet(): TestWallet {
  walletKeysets = new Map([[REGULAR_KEYSET.id, walletKeyset(REGULAR_KEYSET)]]);
  const activeMintKeyset = () => mintKeyset(currentMintKeyset);
  const wallet = {
    mint: {
      mintUrl: MINT,
      getKeySets: vi.fn(async () => ({ keysets: [activeMintKeyset()] })),
      getKeys: vi.fn(async () => ({ keysets: [activeMintKeyset()] })),
    },
    loadMint: vi.fn(async () => undefined),
    getKeyset: vi.fn((id = REGULAR_KEYSET.id) => {
      const keyset = walletKeysets.get(id);
      if (keyset === undefined) throw new Error("test wallet keyset is missing");
      return keyset;
    }),
    batchRestore: vi.fn(async () => ({ proofs: [] as Proof[], lastCounterWithSignature: 4 })),
    groupProofsByState: vi.fn(async (proofs: Proof[]) => ({
      unspent: proofs,
      pending: [],
      spent: [],
    })),
    checkProofsStates: vi.fn(async (inputs: readonly Proof[]) =>
      inputs.map((input) => ({
        Y: hashToCurve(new TextEncoder().encode(input.secret)).toHex(true),
        state: CheckStateEnum.UNSPENT,
        witness: null,
      })),
    ),
    redeemOutcomeProofs: vi.fn(async ({ outputs }: { outputs: readonly unknown[] }) =>
      signOutputs(outputs as OutputData[]),
    ),
  } as unknown as TestWallet;
  return wallet;
}

function walletKeyset(keyset: MintKeys): Keyset {
  const instance = new Keyset(
    keyset.id,
    keyset.unit,
    keyset.active ?? false,
    keyset.input_fee_ppk ?? 0,
    keyset.final_expiry,
  );
  instance.keys = keyset.keys;
  return instance;
}

function mintKeyset(keyset: MintKeys) {
  return {
    id: keyset.id,
    unit: keyset.unit,
    active: keyset.active,
    input_fee_ppk: keyset.input_fee_ppk ?? 0,
    ...(keyset.final_expiry === undefined ? {} : { final_expiry: keyset.final_expiry }),
    keys: keyset.keys,
  };
}

function restoreTestOutputGroups(outputs: SerializedOutputGroups) {
  const restored = deserializeOutputGroups(outputs);
  return {
    regular: signOutputs((restored.regular ?? []) as unknown as OutputData[]),
  };
}

async function createRealCounterFixture() {
  const seed = globalThis.crypto.getRandomValues(new Uint8Array(64));
  mocks.seed = seed;
  setActiveBrowserWalletProfile(PROFILE);
  const scopeId = browserWalletScopeIdFromSeed(seed);
  if (activeBrowserWalletScopeId() !== scopeId) {
    throw new Error("test browser profile did not match its disposable seed");
  }
  activateBrowserWalletDatabase(scopeId);
  const entry = await fixture({ counterSource: "browser", seed });
  activeFixture = entry;
  activeDatabaseName = entry.database.name;
  return entry;
}

function readinessKeyset(keyset: MintKeys = REGULAR_KEYSET) {
  return {
    id: keyset.id,
    canonicalMintUrl: MINT,
    unit: "msat" as const,
    active: true as const,
    keys: keyset.keys,
    inputFeePpk: keyset.input_fee_ppk ?? 0,
    finalExpiry: keyset.final_expiry ?? null,
  };
}

function counterStore(entry: Awaited<ReturnType<typeof fixture>>) {
  return new BrowserWalletCounterDexieStore({
    database: entry.database,
    scopeId: entry.scope.scopeId,
    isCurrentProfile: () => activeBrowserWalletScopeId() === entry.scope.scopeId,
  });
}

function directClaimContext(
  entry: Awaited<ReturnType<typeof fixture>>,
  wallet: TestWallet,
  prepareNewLegAuthority = vi.fn(async () => ({
    regularKeyset: REGULAR_KEYSET,
    oracleWitness: '{"oracle_sig":"test"}',
  })),
) {
  return {
    seed: entry.seed,
    mintUrl: MINT,
    prepareNewLegAuthority,
    counterSource: entry.counters,
    database: entry.database,
    adapter: entry.adapter,
    owner: entry.owner,
    wallet: wallet as unknown as RedeemWallet,
    restoreOutputs: async (_mintUrl: string, outputs: SerializedOutputGroups) =>
      restoreTestOutputGroups(outputs),
    observedAtMs: 8,
    lockManager: immediateLockManager,
  };
}

beforeEach(() => {
  currentMintKeyset = REGULAR_KEYSET;
  mocks.seed = new Uint8Array(64);
  mocks.getWalletForUnit.mockReset();
  mocks.getWalletForMnemonicUnit.mockReset();
  mocks.requireNewWritePermission.mockReset();
  mocks.requireNewWritePermission.mockResolvedValue(undefined);
  mocks.restoreOutputs.mockReset();
  mocks.restoreOutputs.mockImplementation(
    async (_mintUrl: string, outputs: SerializedOutputGroups) => restoreTestOutputGroups(outputs),
  );
  testWallet = makeWallet();
  mocks.getWalletForUnit.mockResolvedValue(testWallet);
  mocks.getWalletForMnemonicUnit.mockResolvedValue(testWallet);
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    json: async () => ({
      conditionId: CONDITION,
      attestedOutcome: OUTCOME,
      oracleWitness: { signature: "disposable-test-witness" },
    }),
  }));
});

afterEach(async () => {
  const entry = activeFixture;
  activeFixture = null;
  vi.unstubAllGlobals();
  db.close();
  if (entry !== null) entry.database.close();
  setActiveBrowserWalletProfile("");
  if (activeDatabaseName !== null) {
    await Dexie.delete(activeDatabaseName);
    activeDatabaseName = null;
  }
});

describe("Claim with the browser's durable NUT-13 counter", () => {
  it("refuses a new leg until targeted recovery commits, then pays without resetting the cursor", async () => {
    const entry = await createRealCounterFixture();
    await entry.adapter.releaseScope(entry.scope, { ...entry.owner, observedAtMs: 4 });
    const counters = counterStore(entry);
    await counters.reserveInContext({ mintUrl: MINT, unit: "msat" }, REGULAR_KEYSET.id, 0, false);
    const before = await entry.adapter.readProof(entry.scope.scopeId, entry.proof.proofId);
    if (before === null) throw new Error("test input proof is missing");
    testWallet.batchRestore.mockRejectedValueOnce(
      new Error("secret-like mint failure: disposable recovery detail"),
    );

    const refused = await claimPortfolioPosition({
      mintUrl: MINT,
      conditionId: CONDITION,
      outcomeCollection: OUTCOME,
    });

    expect(refused).toMatchObject({
      kind: "error",
      committedPayoutAmount: 0,
      committedLegs: 0,
      error: {
        code: "claim-failed",
        category: "counter-readiness",
        message: SAFE_COUNTER_MESSAGE,
        attemptRef: expect.any(String),
      },
    });
    if (refused.kind !== "error") throw new Error("test claim refusal was not an error");
    expect(refused.error.operationRef).toBeUndefined();
    expect(JSON.stringify(refused)).not.toContain("secret-like mint failure");
    expect(testWallet.batchRestore).toHaveBeenCalledOnce();
    expect(testWallet.checkProofsStates).not.toHaveBeenCalled();
    expect(testWallet.redeemOutcomeProofs).not.toHaveBeenCalled();
    expect(await entry.database.custodyOperations.count()).toBe(0);
    expect(await entry.database.custodyReservations.count()).toBe(0);
    expect(await entry.database.walletCounterCursors.count()).toBe(0);
    expect(await counters.snapshot()).toEqual({});
    expect(
      await entry.database.walletCounterAssociations.get([
        entry.scope.scopeId,
        MINT,
        "msat",
        REGULAR_KEYSET.id,
      ]),
    ).toMatchObject({ recoveryComplete: false });
    expect(await entry.adapter.readProof(entry.scope.scopeId, entry.proof.proofId)).toMatchObject({
      revision: before.revision,
      proofFingerprint: before.proofFingerprint,
      selectability: "selectable",
    });

    testWallet.batchRestore.mockResolvedValueOnce({
      proofs: [],
      lastCounterWithSignature: 4,
    });
    const recovered = await claimPortfolioPosition({
      mintUrl: MINT,
      conditionId: CONDITION,
      outcomeCollection: OUTCOME,
    });

    expect(recovered, JSON.stringify(recovered)).toMatchObject({
      kind: "completed",
      committedPayoutAmount: 1,
      committedLegs: 1,
    });
    expect(testWallet.batchRestore).toHaveBeenCalledTimes(2);
    expect(testWallet.redeemOutcomeProofs).toHaveBeenCalledOnce();
    expect(
      await counters.isRecoveryComplete({ mintUrl: MINT, unit: "msat" }, REGULAR_KEYSET.id),
    ).toBe(true);
    expect(await counters.snapshot()).toEqual({ [REGULAR_KEYSET.id]: 6 });
  });

  it("replays a retained payout after keyset rotation without reserving a new cursor", async () => {
    const entry = await createRealCounterFixture();
    const counters = counterStore(entry);
    await ensureWalletKeysetCounterReady({
      scopeId: entry.scope.scopeId,
      mintUrl: MINT,
      unit: "msat",
      keyset: readinessKeyset(),
    });
    expect(
      await counters.isRecoveryComplete({ mintUrl: MINT, unit: "msat" }, REGULAR_KEYSET.id),
    ).toBe(true);
    const record = await entry.bind();
    const retainedOperationKey = buildKeysetRedeemOperationId({
      mintUrl: MINT,
      unit: "msat",
      conditionId: CONDITION,
      keysetId: entry.legs[0]!.keyset.keysetId,
      proofs: entry.legs[0]!.proofs,
    });
    const expectedOperationId = deriveDurableCustodyOperationId(entry.scope.scopeId, {
      retainedOperationKey,
      binding: { kind: "wallet", activityId: retainedOperationKey, stage: "ctf-redeem" },
    });
    expect(record.operation.operationId).toBe(expectedOperationId);
    const initialSnapshot = await counters.snapshot();
    expect(initialSnapshot).toEqual({ [REGULAR_KEYSET.id]: 6 });
    expect(
      await entry.adapter.readOperation(entry.scope, record.operation.operationId),
    ).toMatchObject({ operation: { state: "dispatch-intent" } });

    const rotatedKeyset: MintKeys = {
      ...REGULAR_KEYSET,
      id: deriveKeysetId(REGULAR_KEYSET.keys, {
        unit: "msat",
        input_fee_ppk: 1,
        versionByte: 1,
      }),
      input_fee_ppk: 1,
    };
    currentMintKeyset = rotatedKeyset;
    walletKeysets.set(rotatedKeyset.id, walletKeyset(rotatedKeyset));
    testWallet.mint.getKeySets.mockClear();
    testWallet.mint.getKeys.mockClear();
    const prepareNewLegAuthority = vi.fn(async () => ({
      regularKeyset: rotatedKeyset,
      oracleWitness: '{"oracle_sig":"rotated"}',
    }));
    const beforeRetry = await counters.snapshot();

    const result = await claimBrowserCanonicalCtfPosition({
      position: { conditionId: CONDITION, outcomeCollection: OUTCOME },
      context: directClaimContext(entry, testWallet, prepareNewLegAuthority),
    });

    expect(result, JSON.stringify(result)).toMatchObject({
      kind: "completed",
      committedPayoutAmount: 1,
      committedLegs: 1,
    });
    expect(prepareNewLegAuthority).not.toHaveBeenCalled();
    expect(testWallet.redeemOutcomeProofs).toHaveBeenCalledOnce();
    expect(testWallet.mint.getKeySets).not.toHaveBeenCalled();
    expect(testWallet.mint.getKeys).not.toHaveBeenCalled();
    expect(await counters.snapshot()).toEqual(beforeRetry);
    expect(await counters.snapshot()).toEqual(initialSnapshot);
    expect(
      await entry.database.walletCounterCursors.get([entry.scope.scopeId, rotatedKeyset.id]),
    ).toBeUndefined();
    expect(
      await entry.database.walletCounterAssociations.get([
        entry.scope.scopeId,
        MINT,
        "msat",
        rotatedKeyset.id,
      ]),
    ).toBeUndefined();
  });
});
