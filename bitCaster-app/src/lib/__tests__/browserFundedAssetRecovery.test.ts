// @vitest-environment node
import { Amount } from "@cashu/cashu-ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEncryptedWalletBackupV2AssetIdentity } from "@bitcaster/client-sdk";
import { createBrowserCustodyProofRow } from "@/stores/durable-custody-db";
import {
  recoverBrowserFundedAsset,
  repairSelectableCanonicalRows,
} from "../browserFundedAssetRecovery";

const mocks = vi.hoisted(() => ({
  engineAssets: vi.fn(),
  driver: { recoverTargetedAsset: vi.fn() },
  activeDriver: vi.fn(),
  wallet: vi.fn(),
  rows: vi.fn(),
  addProofs: vi.fn(),
}));

vi.mock("@/stores/proof-db", () => ({ addProofs: mocks.addProofs }));
vi.mock("@/stores/browser-encrypted-wallet-backup-v2-asset-source", () => ({
  readBrowserEncryptedWalletBackupV2ExactLocalProofRows: mocks.rows,
}));
vi.mock("@/stores/wallet", () => ({ getWalletForMnemonicUnit: mocks.wallet }));
vi.mock("../encryptedWalletBackupDriver", () => ({
  activeBrowserEncryptedWalletBackupV2RuntimeDriver: mocks.activeDriver,
}));
vi.mock("../markets", () => ({
  createAuthenticatedBrowserEngineClient: () => ({ getAssetMonitoringAssets: mocks.engineAssets }),
}));
vi.mock("../walletProfileLock", () => ({
  withWalletProfileLock: (_scope: string, work: () => unknown) => work(),
}));

const asset = createEncryptedWalletBackupV2AssetIdentity({
  mintUrl: "https://mint.example",
  unit: "msat",
  asset: { kind: "ordinary" },
});
const SCOPE_ID = `custody:wallet:${"11".repeat(32)}`;

describe("recoverBrowserFundedAsset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a ready local action plan without recovery I/O", async () => {
    const loadPlan = vi.fn().mockResolvedValue({ kind: "ready" as const });

    await expect(recoverBrowserFundedAsset(input(loadPlan))).resolves.toEqual({
      kind: "ready",
      plan: { kind: "ready" },
    });

    expect(mocks.engineAssets).not.toHaveBeenCalled();
    expect(mocks.wallet).not.toHaveBeenCalled();
    expect(mocks.driver.recoverTargetedAsset).not.toHaveBeenCalled();
  });

  it("uses one exact monitoring page only after an insufficient action plan", async () => {
    const loadPlan = vi.fn().mockResolvedValue({ kind: "insufficient" as const });
    mocks.rows.mockResolvedValue([]);
    mocks.activeDriver.mockReturnValue(mocks.driver);
    mocks.wallet.mockResolvedValue({ mint: { mintUrl: "https://mint.example" } });
    mocks.engineAssets.mockResolvedValue({
      assets: [
        {
          asset: {
            canonicalMintUrl: "https://mint.example",
            kind: "collateral",
            cashuUnit: "msat",
            displayBaseAsset: "msat",
          },
          availableSubunits: 10,
        },
      ],
    });
    mocks.driver.recoverTargetedAsset.mockResolvedValue({ kind: "restored-mint" });

    await expect(recoverBrowserFundedAsset(input(loadPlan))).resolves.toEqual({
      kind: "recovered",
    });

    expect(mocks.engineAssets).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 200 }));
    expect(mocks.engineAssets).toHaveBeenCalledOnce();
    expect(mocks.driver.recoverTargetedAsset).toHaveBeenCalledWith(
      expect.objectContaining({ asset }),
    );
  });

  it("does not load the mint when the exact monitoring fact is absent", async () => {
    const loadPlan = vi.fn().mockResolvedValue({ kind: "insufficient" as const });
    mocks.rows.mockResolvedValue([]);
    mocks.activeDriver.mockReturnValue(mocks.driver);
    mocks.engineAssets.mockResolvedValue({ assets: [] });

    await expect(recoverBrowserFundedAsset(input(loadPlan))).resolves.toEqual({
      kind: "unavailable",
    });

    expect(mocks.wallet).not.toHaveBeenCalled();
    expect(mocks.driver.recoverTargetedAsset).not.toHaveBeenCalled();
  });

  it("returns ordinary insufficiency when the exact monitoring fact is below the action amount", async () => {
    const loadPlan = vi.fn().mockResolvedValue({ kind: "insufficient" as const });
    mocks.rows.mockResolvedValue([]);
    mocks.activeDriver.mockReturnValue(mocks.driver);
    mocks.engineAssets.mockResolvedValue({ assets: [monitoringFact(9)] });

    await expect(recoverBrowserFundedAsset(input(loadPlan))).resolves.toEqual({
      kind: "unavailable",
    });

    expect(mocks.wallet).not.toHaveBeenCalled();
    expect(mocks.driver.recoverTargetedAsset).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "unavailable" }],
    [{ kind: "already-attempted", completedOutcome: "unavailable" }],
  ] as const)(
    "preserves a sufficient monitored recovery %o as a durable error",
    async (outcome) => {
      const loadPlan = vi.fn().mockResolvedValue({ kind: "insufficient" as const });
      mocks.rows.mockResolvedValue([]);
      mocks.activeDriver.mockReturnValue(mocks.driver);
      mocks.wallet.mockResolvedValue({ mint: { mintUrl: "https://mint.example" } });
      mocks.engineAssets.mockResolvedValue({ assets: [monitoringFact(10)] });
      mocks.driver.recoverTargetedAsset.mockResolvedValue(outcome);

      await expect(recoverBrowserFundedAsset(input(loadPlan))).resolves.toEqual({
        kind: "persistent-error",
      });
    },
  );

  it("fails closed when the profile changes after monitoring I/O", async () => {
    let current = true;
    const loadPlan = vi.fn().mockResolvedValue({ kind: "insufficient" as const });
    mocks.rows.mockResolvedValue([]);
    mocks.activeDriver.mockReturnValue(mocks.driver);
    mocks.engineAssets.mockImplementation(async () => {
      current = false;
      return { assets: [monitoringFact(10)] };
    });

    await expect(
      recoverBrowserFundedAsset(input(loadPlan, { isCurrentProfile: () => current })),
    ).resolves.toEqual({ kind: "persistent-error" });

    expect(mocks.wallet).not.toHaveBeenCalled();
    expect(mocks.driver.recoverTargetedAsset).not.toHaveBeenCalled();
  });

  it("repairs only selectable canonical rows", async () => {
    const selectable = custodyProof("selectable", null, "selectable-secret", 8);
    const locked = custodyProof("locked", "operation-1", "locked-secret", 8);
    mocks.rows.mockResolvedValue([selectable, locked]);

    await expect(
      repairSelectableCanonicalRows({
        database: {} as never,
        scopeId: SCOPE_ID,
        asset,
        requiredAmount: 8n,
        isCurrentProfile: () => true,
      }),
    ).resolves.toBe(true);

    expect(mocks.addProofs).toHaveBeenCalledOnce();
    expect(mocks.addProofs.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ secret: "selectable-secret" }),
    ]);
  });
});

function custodyProof(
  selectability: "selectable" | "locked",
  reservationOperationId: string | null,
  secret: string,
  amount: number,
) {
  return {
    ...createBrowserCustodyProofRow({
      scopeId: SCOPE_ID,
      normalizedMint: "https://mint.example",
      unit: "msat",
      proof: {
        id: `00${"22".repeat(32)}`,
        amount: Amount.from(amount),
        secret,
        C: `02${"33".repeat(32)}`,
      },
      asset: { kind: "regular" },
      receivedAtMs: 1,
    }),
    selectability,
    reservationOperationId,
  };
}

function monitoringFact(availableSubunits: number) {
  return {
    asset: {
      canonicalMintUrl: "https://mint.example",
      kind: "collateral" as const,
      cashuUnit: "msat" as const,
      displayBaseAsset: "msat" as const,
    },
    availableSubunits,
  };
}

function input(
  loadPlan: () => Promise<{ readonly kind: "ready" | "insufficient" }>,
  overrides: { readonly isCurrentProfile?: () => boolean } = {},
) {
  return {
    database: {} as never,
    scopeId: SCOPE_ID,
    seed: new Uint8Array(64).fill(7),
    mnemonic:
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    asset,
    requiredAmount: 10n,
    loadPlan,
    isCurrentProfile: overrides.isCurrentProfile ?? (() => true),
  };
}
