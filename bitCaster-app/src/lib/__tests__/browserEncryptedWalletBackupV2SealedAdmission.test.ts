// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { EncryptedWalletBackupV2VerifiedProofSet } from "@bitcaster/client-sdk";
import { admitBrowserEncryptedWalletBackupV2Asset } from "../browserEncryptedWalletBackupV2Admission";

vi.mock("@bitcaster/client-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bitcaster/client-sdk")>()),
  requireEncryptedWalletBackupV2VerifiedProofSet: (value: unknown) => value,
}));

describe("browser V2 sealed proof admission guard", () => {
  it("refuses a sealed non-selectable proof before any custody or cache write", async () => {
    const verified = {
      verified: true,
      proofs: [{ selectionAuthority: "terminal-sealed-non-selectable", unit: "msat" }],
      counterHighWaterMarks: [],
    } as unknown as EncryptedWalletBackupV2VerifiedProofSet;
    const database = { transaction: vi.fn(), proofs: { put: vi.fn() } };
    await expect(
      admitBrowserEncryptedWalletBackupV2Asset({
        seed: new Uint8Array(32),
        verified,
        asset: { mintUrl: "https://mint.example", unit: "msat", assetIdentity: "cashu:ordinary" },
        custodyRevision: 1n,
        sourceOperationId: "restore",
        wallet: {} as never,
        database: database as never,
        scopeId: "scope",
        isCurrentProfile: () => true,
      }),
    ).rejects.toThrow("sealed losing proof needs non-selectable admission");
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.proofs.put).not.toHaveBeenCalled();
  });
});
