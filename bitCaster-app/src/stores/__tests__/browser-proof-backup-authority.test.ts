// @vitest-environment node
import "fake-indexeddb/auto";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { describe, expect, it } from "vitest";
import {
  advanceBrowserProofBackupAuthorityRow,
  createBrowserProofBackupAuthorityRow,
  requireBrowserProofBackupAuthorityRow,
  requireBrowserProofBackupAuthorityForProof,
} from "../browser-proof-backup-authority";
import { createBrowserCustodyProofRow } from "../durable-custody-db";

const MINT = "https://mint.example";
const DERIVATION_KEYSET = `01${"11".repeat(32)}`;
const FOREIGN_KEYSET = `02${"22".repeat(32)}`;

describe("browser proof backup authority", () => {
  it("preserves an exact locator replay and rejects a conflicting replay", () => {
    const proof = custodyProof();
    const locator = { keysetId: DERIVATION_KEYSET, counter: 7 };
    const authority = createBrowserProofBackupAuthorityRow(proof, 2, locator);

    expect(advanceBrowserProofBackupAuthorityRow(authority, proof, 3, locator)).toMatchObject({
      derivationKeysetId: DERIVATION_KEYSET,
      derivationCounter: 7,
    });
    expect(() =>
      advanceBrowserProofBackupAuthorityRow(authority, proof, 3, {
        keysetId: DERIVATION_KEYSET,
        counter: 8,
      }),
    ).toThrow("derivation locator conflicts");
    expect(authority).toMatchObject({
      derivationKeysetId: DERIVATION_KEYSET,
      derivationCounter: 7,
      proofRevision: 0,
    });
  });

  it("rejects a locator that does not match the proof keyset", () => {
    const proof = custodyProof();
    const locator = { keysetId: DERIVATION_KEYSET, counter: 7 };
    const authority = createBrowserProofBackupAuthorityRow(proof, 2, locator);

    expect(() =>
      createBrowserProofBackupAuthorityRow(proof, 2, { keysetId: FOREIGN_KEYSET, counter: 7 }),
    ).toThrow("derivation locator keyset is foreign");
    expect(() =>
      advanceBrowserProofBackupAuthorityRow(
        { ...authority, derivationKeysetId: FOREIGN_KEYSET },
        proof,
        3,
        locator,
      ),
    ).toThrow("derivation locator keyset is foreign");
    expect(() =>
      requireBrowserProofBackupAuthorityForProof(
        { ...authority, derivationKeysetId: FOREIGN_KEYSET },
        proof,
      ),
    ).toThrow("derivation locator keyset is foreign");
  });

  it.each([
    { derivationKeysetId: DERIVATION_KEYSET, derivationCounter: null },
    { derivationKeysetId: null, derivationCounter: 0 },
    { derivationKeysetId: `00${"11".repeat(7)}`, derivationCounter: 0 },
    { derivationKeysetId: `01${"AA".repeat(32)}`, derivationCounter: 0 },
    { derivationKeysetId: DERIVATION_KEYSET, derivationCounter: -1 },
    { derivationKeysetId: DERIVATION_KEYSET, derivationCounter: 2_147_483_648 },
  ])("fails closed for an invalid derivation locator row", (locator) => {
    expect(() => requireBrowserProofBackupAuthorityRow(authorityRow(locator))).toThrow(
      "derivation locator is invalid",
    );
  });
});

function custodyProof() {
  const scope = walletScope();
  return createBrowserCustodyProofRow({
    scopeId: scope.scopeId,
    normalizedMint: MINT,
    unit: "sat",
    proof: {
      id: DERIVATION_KEYSET,
      amount: 1 as never,
      secret: "proof-secret",
      C: `02${"33".repeat(32)}`,
    },
    asset: { kind: "regular" },
    receivedAtMs: 1,
  });
}

function authorityRow(locator: {
  derivationKeysetId: string | null;
  derivationCounter: number | null;
}) {
  return {
    schemaVersion: 1,
    scopeId: walletScope().scopeId,
    proofId: "44".repeat(32),
    proofFingerprint: "55".repeat(32),
    proofRevision: 0,
    proofState: "selectable",
    backupState: "local-only",
    ...locator,
    backupRecordId: null,
    updatedAtMs: 1,
  };
}

function walletScope() {
  const walletId = deriveDurableCustodyWalletId(new Uint8Array(32).fill(7));
  return {
    scopeKind: "wallet" as const,
    walletId,
    scopeId: deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId }),
  };
}
