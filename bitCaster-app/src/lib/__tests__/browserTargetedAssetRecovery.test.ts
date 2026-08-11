// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import {
  createEncryptedWalletBackupV2KeyHandle,
  deriveDurableCustodyProofId,
  deriveDurableWalletProofSecret,
  deriveEncryptedWalletBackupV2AssetLocator,
  deriveRootCtfOutcomeCollectionId,
} from "@bitcaster/client-sdk";
import type { BitcasterDB } from "../../stores/proof-db";
import { browserWalletScope } from "../browserCtfRangeOrderSource";
import {
  browserTargetedAssetRecoveryFactVersion,
  recoverBrowserTargetedAsset,
} from "../browserTargetedAssetRecovery";

const mocks = vi.hoisted(() => ({
  localAmount: vi.fn(),
  restoreBackup: vi.fn(),
  admit: vi.fn(),
  restoreProofs: vi.fn(),
  verify: vi.fn(),
  localRows: vi.fn(),
  completed: new Map<string, string>(),
}));

vi.mock("../browserEncryptedWalletBackupV2Restore", () => ({
  readBrowserEncryptedWalletBackupV2LocalAvailableAmount: mocks.localAmount,
  restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset: mocks.restoreBackup,
}));
vi.mock("../browserCustodyProofReceive", () => ({
  admitBrowserReceivedProofsWithHeldProfileLock: mocks.admit,
}));
vi.mock("../../stores/proof-db", () => ({ restoreProofsAndAdvanceCounter: mocks.restoreProofs }));
vi.mock("../../stores/browser-encrypted-wallet-backup-v2-asset-source", () => ({
  readBrowserEncryptedWalletBackupV2ExactLocalProofRows: mocks.localRows,
}));
vi.mock("../../stores/browser-targeted-asset-recovery-attempt-store", () => ({
  BrowserTargetedAssetRecoveryAttemptStore: class {
    async readCompletedAttempt(key: unknown) {
      return mocks.completed.get(JSON.stringify(key)) ?? null;
    }
    async recordCompletedAttempt(key: unknown, outcome: string) {
      mocks.completed.set(JSON.stringify(key), outcome);
    }
  },
}));
vi.mock("@cashu/cashu-ts", async () => {
  const actual = await vi.importActual<object>("@cashu/cashu-ts");
  return { ...actual, verifyProofsForReceive: mocks.verify };
});

const SEED = new Uint8Array(64).fill(7);
const KEYSET = `01${"22".repeat(32)}`;
const CONDITION_ID = "11".repeat(32);
const OUTCOME_COLLECTION = "YES";
const OUTCOME_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: OUTCOME_COLLECTION,
});

afterEach(() => {
  vi.clearAllMocks();
  mocks.localAmount.mockReset();
  mocks.localRows.mockReset();
  mocks.localRows.mockResolvedValue([]);
  mocks.completed.clear();
});

it("short-circuits exact local custody without backup or mint I/O", async () => {
  mocks.localAmount.mockResolvedValueOnce(1n);
  const input = await fixture();

  await expect(recoverBrowserTargetedAsset(input)).resolves.toEqual({ kind: "local" });

  expect(input.remote.readCurrentInventory).not.toHaveBeenCalled();
  expect(input.wallet.restore).not.toHaveBeenCalled();
});

it.each([1n, 2n])(
  "restores an equal or higher exact backup amount without mint recovery (%s)",
  async (backupAmount) => {
    mocks.localAmount.mockResolvedValueOnce(null).mockResolvedValueOnce(backupAmount);
    mocks.restoreBackup.mockResolvedValueOnce({
      kind: "restored",
      bundleId: "11".repeat(16),
      headVersion: 3,
    });
    const input = await fixture({ exactInventoryEntry: true, backupAmount });

    await expect(recoverBrowserTargetedAsset(input)).resolves.toEqual({
      kind: "restored-backup",
    });

    expect(mocks.restoreBackup).toHaveBeenCalledOnce();
    expect(input.readExactMonitoringRecovery).not.toHaveBeenCalled();
    expect(input.wallet.restore).not.toHaveBeenCalled();
  },
);

it("uses a higher local amount and merges a sufficient backup with a lower local copy", async () => {
  mocks.localAmount.mockResolvedValueOnce(2n);
  const local = await fixture();

  await expect(recoverBrowserTargetedAsset(local)).resolves.toEqual({ kind: "local" });

  mocks.localAmount.mockResolvedValueOnce(0n).mockResolvedValueOnce(1n);
  const lowerLocal = await fixture({ exactInventoryEntry: true, backupAmount: 1n });
  mocks.restoreBackup.mockResolvedValueOnce({
    kind: "restored",
    bundleId: "22".repeat(16),
    headVersion: 3,
  });

  await expect(recoverBrowserTargetedAsset(lowerLocal)).resolves.toEqual({
    kind: "restored-backup",
  });
  expect(mocks.restoreBackup).toHaveBeenCalledOnce();
  expect(mocks.restoreBackup).toHaveBeenCalledWith(
    expect.objectContaining({ minimumAvailableAmount: 1n }),
  );
  expect(lowerLocal.wallet.restore).not.toHaveBeenCalled();
});

it("falls through a lower backup amount when no local copy exists", async () => {
  mocks.localAmount.mockResolvedValue(null);
  const input = await fixture({ exactInventoryEntry: true, backupAmount: 1n });
  input.requiredAmount = 2n;
  input.monitoringFact.availableSubunits = 2;
  input.wallet.restore.mockResolvedValueOnce({ proofs: [] });

  await expect(recoverBrowserTargetedAsset(input)).resolves.toEqual({ kind: "unavailable" });

  expect(mocks.restoreBackup).not.toHaveBeenCalled();
  expect(input.wallet.restore).toHaveBeenCalledOnce();
});

it("does not fall through after a backup service failure", async () => {
  mocks.localAmount.mockResolvedValue(null);
  const input = await fixture({ inventoryError: new Error("unavailable") });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  await expect(recoverBrowserTargetedAsset(input)).resolves.toEqual({ kind: "persistent-error" });

  expect(input.wallet.restore).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledWith("targeted-recovery-stage=current-inventory");
});

it("reports fixed monitoring and mint stages without arbitrary error text", async () => {
  mocks.localAmount.mockResolvedValue(null);
  const monitoring = await fixture();
  monitoring.readExactMonitoringRecovery.mockRejectedValueOnce(new Error("secret monitoring text"));
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  await expect(recoverBrowserTargetedAsset(monitoring)).resolves.toEqual({
    kind: "persistent-error",
  });
  expect(warning).toHaveBeenCalledWith("targeted-recovery-stage=monitoring");
  expect(warning.mock.calls.flat()).not.toContain("secret monitoring text");

  mocks.localAmount.mockResolvedValue(null);
  const mint = await fixture();
  mint.wallet.restore.mockRejectedValueOnce(new Error("secret mint text"));
  await expect(recoverBrowserTargetedAsset(mint)).resolves.toEqual({ kind: "persistent-error" });
  expect(warning).toHaveBeenLastCalledWith("targeted-recovery-stage=mint");
  expect(warning.mock.calls.flat()).not.toContain("secret mint text");
});

it("uses only the supplied exact mint request and does not admit a PENDING proof", async () => {
  mocks.localAmount.mockResolvedValue(null);
  const input = await fixture();
  const pending = exactProof();
  input.wallet.restore.mockResolvedValueOnce({ proofs: [pending] });
  input.wallet.groupProofsByState.mockResolvedValueOnce({
    unspent: [],
    pending: [pending],
    spent: [],
  });

  await expect(recoverBrowserTargetedAsset(input)).resolves.toEqual({ kind: "unavailable" });

  expect(input.wallet.restore).toHaveBeenCalledWith(4, 1, { keysetId: KEYSET });
  expect(mocks.admit).not.toHaveBeenCalled();
  expect(mocks.restoreProofs).toHaveBeenCalledWith(
    expect.objectContaining({ proofs: [], keysetId: KEYSET, restoredNext: 5 }),
    input.database,
  );
});

it("persists an unavailable exact mint attempt and does not repeat it", async () => {
  mocks.localAmount.mockResolvedValue(null);
  const input = await fixture();
  input.wallet.restore.mockResolvedValue({ proofs: [] });
  input.wallet.groupProofsByState.mockResolvedValue({ unspent: [], pending: [], spent: [] });

  await expect(recoverBrowserTargetedAsset(input)).resolves.toEqual({ kind: "unavailable" });
  await expect(recoverBrowserTargetedAsset(input)).resolves.toEqual({
    kind: "already-attempted",
    completedOutcome: "unavailable",
  });

  expect(input.wallet.restore).toHaveBeenCalledOnce();
});

it("uses one aggregated NUT-07 check for several exact restore ranges", async () => {
  mocks.localAmount.mockResolvedValueOnce(null).mockResolvedValueOnce(2n);
  const input = await fixture();
  input.monitoringFact.availableSubunits = 2;
  input.monitoringFact.recoveryHint = {
    keysetIds: [KEYSET],
    counterIntervals: [
      { start: 4, count: 1 },
      { start: 5, count: 1 },
    ],
  };
  const first = exactProof(4);
  const second = exactProof(5);
  input.wallet.restore
    .mockResolvedValueOnce({ proofs: [first] })
    .mockResolvedValueOnce({ proofs: [second] });
  input.wallet.groupProofsByState.mockResolvedValueOnce({
    unspent: [first, second],
    pending: [],
    spent: [],
  });

  await expect(recoverBrowserTargetedAsset(input)).resolves.toEqual({ kind: "restored-mint" });

  expect(input.wallet.restore).toHaveBeenCalledTimes(2);
  expect(input.wallet.groupProofsByState).toHaveBeenCalledOnce();
  expect(input.wallet.groupProofsByState).toHaveBeenCalledWith([first, second]);
});

it("rejects a foreign restored asset before admission", async () => {
  mocks.localAmount.mockResolvedValue(null);
  const input = await fixture();
  input.wallet.restore.mockResolvedValueOnce({ proofs: [exactProof()] });
  input.wallet.getKeyset.mockReturnValueOnce({
    id: KEYSET,
    unit: "sat",
    verify: () => true,
    conditional: { conditionId: "11".repeat(32), outcomeCollectionId: "22".repeat(32) },
  });

  await expect(recoverBrowserTargetedAsset(input)).resolves.toEqual({ kind: "persistent-error" });

  expect(mocks.admit).not.toHaveBeenCalled();
  expect(mocks.restoreProofs).not.toHaveBeenCalled();
});

it("keeps exact conditional metadata in canonical and legacy proof admission", async () => {
  mocks.localAmount.mockResolvedValueOnce(null).mockResolvedValueOnce(1n);
  const input = await fixture({ conditional: true });
  const proof = exactProof();
  input.wallet.restore.mockResolvedValueOnce({ proofs: [proof] });
  input.wallet.groupProofsByState.mockResolvedValueOnce({
    unspent: [proof],
    pending: [],
    spent: [],
  });

  await expect(recoverBrowserTargetedAsset(input)).resolves.toEqual({ kind: "restored-mint" });

  const expected = expect.objectContaining({
    conditionId: CONDITION_ID,
    outcomeCollection: OUTCOME_COLLECTION,
    marketId: `${CONDITION_ID}-${OUTCOME_COLLECTION}`,
  });
  expect(mocks.admit).toHaveBeenCalledWith(expect.objectContaining({ proofs: [expected] }));
  expect(mocks.restoreProofs).toHaveBeenCalledWith(
    expect.objectContaining({ proofs: [expected] }),
    input.database,
  );
});

it("does not re-admit an exact proof that already exists in canonical custody", async () => {
  mocks.localAmount.mockResolvedValueOnce(null).mockResolvedValueOnce(2n);
  const input = await fixture();
  input.monitoringFact.availableSubunits = 2;
  const existing = exactProof(4);
  const fresh = exactProof(5);
  input.monitoringFact.recoveryHint = {
    keysetIds: [KEYSET],
    counterIntervals: [
      { start: 4, count: 1 },
      { start: 5, count: 1 },
    ],
  };
  mocks.localRows.mockResolvedValueOnce([
    {
      proofId: deriveDurableCustodyProofId({
        scopeId: input.scopeId,
        normalizedMint: input.asset.mintUrl,
        unit: input.asset.unit,
        keysetId: existing.id,
        secret: existing.secret,
      }),
    },
  ]);
  input.wallet.restore
    .mockResolvedValueOnce({ proofs: [existing] })
    .mockResolvedValueOnce({ proofs: [fresh] });
  input.wallet.groupProofsByState.mockResolvedValueOnce({
    unspent: [existing, fresh],
    pending: [],
    spent: [],
  });

  await expect(recoverBrowserTargetedAsset(input)).resolves.toEqual({ kind: "restored-mint" });

  expect(mocks.admit).toHaveBeenCalledOnce();
  expect(mocks.admit).toHaveBeenCalledWith(
    expect.objectContaining({ proofs: [expect.objectContaining(fresh)] }),
  );
});

it("uses a new durable operation identity for a newer fact with an overlapping range", async () => {
  mocks.localAmount
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(1n)
    .mockResolvedValueOnce(1n)
    .mockResolvedValueOnce(2n);
  const input = await fixture();
  const first = exactProof(4);
  const second = exactProof(5);
  const firstProofId = deriveDurableCustodyProofId({
    scopeId: input.scopeId,
    normalizedMint: input.asset.mintUrl,
    unit: input.asset.unit,
    keysetId: first.id,
    secret: first.secret,
  });
  mocks.localRows.mockResolvedValueOnce([]).mockResolvedValueOnce([{ proofId: firstProofId }]);
  input.wallet.restore
    .mockResolvedValueOnce({ proofs: [first] })
    .mockResolvedValueOnce({ proofs: [first, second] });
  input.wallet.groupProofsByState
    .mockResolvedValueOnce({ unspent: [first], pending: [], spent: [] })
    .mockResolvedValueOnce({ unspent: [first, second], pending: [], spent: [] });

  await expect(recoverBrowserTargetedAsset(input)).resolves.toEqual({ kind: "restored-mint" });
  input.requiredAmount = 2n;
  input.monitoringFact.availableSubunits = 2;
  input.monitoringFact.recoveryHint = {
    keysetIds: [KEYSET],
    counterIntervals: [{ start: 4, count: 2 }],
  };
  await expect(recoverBrowserTargetedAsset(input)).resolves.toEqual({ kind: "restored-mint" });

  const operationIds = mocks.admit.mock.calls.map(([call]) => call.sourceOperationId);
  expect(operationIds).toHaveLength(2);
  expect(operationIds[0]).not.toBe(operationIds[1]);
  expect(mocks.admit.mock.calls[1]![0].proofs).toEqual([expect.objectContaining(second)]);
});

it.each([
  ["foreign mint", "https://other-mint.example", KEYSET],
  ["BLS keyset", "https://mint.example", `02${"33".repeat(32)}`],
])("rejects a %s before mint I/O", async (_label, mintUrl, keysetId) => {
  mocks.localAmount.mockResolvedValue(null);
  const input = await fixture();
  input.wallet.mint.mintUrl = mintUrl;
  input.monitoringFact.recoveryHint = {
    keysetIds: [keysetId],
    counterIntervals: [{ start: 4, count: 1 }],
  };

  await expect(recoverBrowserTargetedAsset(input)).resolves.toEqual({ kind: "persistent-error" });

  expect(input.wallet.restore).not.toHaveBeenCalled();
  expect(input.wallet.groupProofsByState).not.toHaveBeenCalled();
});

it("fails closed when the captured wallet profile changes", async () => {
  const input = await fixture();
  input.isCurrentProfile = () => false;

  await expect(recoverBrowserTargetedAsset(input)).resolves.toEqual({ kind: "persistent-error" });

  expect(input.remote.readCurrentInventory).not.toHaveBeenCalled();
  expect(input.wallet.restore).not.toHaveBeenCalled();
});

it("serializes duplicate tabs and records one exact mint attempt", async () => {
  mocks.localAmount.mockResolvedValue(null);
  const input = await fixture();
  input.lockManager = serialLockManager();
  input.wallet.restore.mockResolvedValue({ proofs: [] });
  input.wallet.groupProofsByState.mockResolvedValue({ unspent: [], pending: [], spent: [] });

  const [first, second] = await Promise.all([
    recoverBrowserTargetedAsset(input),
    recoverBrowserTargetedAsset(input),
  ]);

  expect([first, second]).toEqual(
    expect.arrayContaining([
      { kind: "unavailable" },
      { kind: "already-attempted", completedOutcome: "unavailable" },
    ]),
  );
  expect(input.wallet.restore).toHaveBeenCalledOnce();
});

it("keeps fact versions stable across valuation refreshes and changes them for recovery authority", () => {
  const fact = monitoringFact();
  const stable = browserTargetedAssetRecoveryFactVersion(fact);
  expect(
    browserTargetedAssetRecoveryFactVersion({
      ...fact,
      valuationStatus: "valued",
      availableValueMsat: 1,
      estimatedValueMsat: 2,
    } as any),
  ).toBe(stable);
  expect(browserTargetedAssetRecoveryFactVersion({ ...fact, availableSubunits: 2 })).not.toBe(
    stable,
  );
});

async function fixture(
  options: {
    exactInventoryEntry?: boolean;
    backupAmount?: bigint;
    inventoryError?: Error;
    conditional?: boolean;
  } = {},
) {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: SEED,
    realm: "backup.example",
    runtime: { subtle: crypto.subtle },
  });
  const conditional = options.conditional
    ? {
        conditionId: CONDITION_ID,
        outcomeCollection: OUTCOME_COLLECTION,
        outcomeCollectionId: OUTCOME_COLLECTION_ID,
      }
    : undefined;
  const wallet = {
    mint: { mintUrl: "https://mint.example" },
    restore: vi.fn(),
    groupProofsByState: vi.fn(),
    getKeyset: vi.fn(() => ({
      id: KEYSET,
      unit: "sat",
      hasKeys: true,
      verify: () => true,
      conditional,
    })),
  } as any;
  const remote = {
    readCurrentInventory: vi.fn(async () => {
      if (options.inventoryError) throw options.inventoryError;
      return {
        headVersion: 3,
        entries: options.exactInventoryEntry
          ? [
              {
                assetLocator: await deriveEncryptedWalletBackupV2AssetLocator({
                  keyHandle,
                  ...asset,
                }),
                declaredAmount: options.backupAmount ?? 1n,
              },
            ]
          : [],
      };
    }),
  } as any;
  const asset = {
    mintUrl: "https://mint.example",
    unit: "sat",
    assetIdentity: options.conditional
      ? `ctf:${CONDITION_ID}:${OUTCOME_COLLECTION_ID}`
      : "cashu:ordinary",
  } as const;
  const fact = monitoringFact(options.conditional);
  return {
    database: {
      tables: [],
      transaction: vi.fn(async (_mode, _tables, action) => action()),
    } as unknown as BitcasterDB,
    scopeId: browserWalletScope(SEED).scopeId,
    seed: SEED,
    keyHandle,
    enrollmentEpoch: 1,
    asset,
    requiredAmount: 1n,
    loadWallet: vi.fn(async () => wallet),
    readExactMonitoringRecovery: vi.fn(async () => ({ fact })),
    wallet,
    monitoringFact: fact,
    remote,
    requestUrl: (kind: "head" | "object", value: string | null) =>
      `https://backup.example/${kind}/${value ?? ""}`,
    currentInventoryUrl: `https://backup.example/v1/encrypted-wallet-backup/realms/${keyHandle.realm}/wallets/${keyHandle.walletId}/current-inventory`,
    nowUnixSeconds: () => 1,
    completedAtUnixMilliseconds: () => 1,
    runtime: { subtle: crypto.subtle, getRandomValues: crypto.getRandomValues.bind(crypto) },
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    lockManager: immediateLockManager(),
  };
}

function monitoringFact(conditional = false) {
  return {
    asset: conditional
      ? {
          canonicalMintUrl: "https://mint.example",
          kind: "conditional" as const,
          cashuUnit: "sat" as const,
          displayBaseAsset: "sat" as const,
          conditionId: CONDITION_ID,
          parentConditionId: "00".repeat(32),
          outcomeUniverseDigest: "33".repeat(32),
          internalOutcomeSetId: OUTCOME_COLLECTION,
        }
      : {
          canonicalMintUrl: "https://mint.example",
          kind: "collateral" as const,
          cashuUnit: "sat" as const,
          displayBaseAsset: "sat" as const,
        },
    availableSubunits: 1,
    pendingOutgoingSubunits: 0,
    valuationStatus: "unvalued" as const,
    recoveryHint: { keysetIds: [KEYSET], counterIntervals: [{ start: 4, count: 1 }] },
  };
}

function exactProof(counter = 4) {
  return {
    id: KEYSET,
    amount: 1,
    secret: deriveDurableWalletProofSecret({
      seed: SEED,
      locator: { schemaVersion: 1, kind: "nut13", keysetId: KEYSET, counter },
      proofKeysetId: KEYSET,
      proofAmount: 1,
    }),
    C: "02".padEnd(66, "3"),
  };
}

function immediateLockManager(): Pick<LockManager, "request"> {
  return {
    request: async (_name: string, _options: LockOptions, callback: LockGrantedCallback<any>) =>
      callback(null),
  } as Pick<LockManager, "request">;
}

function serialLockManager(): Pick<LockManager, "request"> {
  const tails = new Map<string, Promise<void>>();
  return {
    request: async (name: string, _options: LockOptions, callback: LockGrantedCallback<any>) => {
      const previous = tails.get(name) ?? Promise.resolve();
      let release: () => void = () => undefined;
      const tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(name, tail);
      await previous;
      try {
        return await callback(null);
      } finally {
        release();
        if (tails.get(name) === tail) tails.delete(name);
      }
    },
  } as Pick<LockManager, "request">;
}
