// @vitest-environment node
import "fake-indexeddb/auto";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { describe, expect, it } from "vitest";
import {
  advanceBrowserProofBackupAuthorityRow,
  advanceBrowserRemoteProofBackupAuthorityRow,
  bindBrowserProofBackupAuthorityTerminalOperation,
  classifyBrowserProofBackupAuthorityVerifiedLosing,
  createBrowserProofBackupAuthorityRow,
  createBrowserRemoteProofBackupAuthorityRow,
  requireBrowserProofBackupAuthorityRow,
} from "../browser-proof-backup-authority";
import { createBrowserCustodyProofRow } from "../durable-custody-db";

const MINT = "https://mint.example";
const DERIVATION_KEYSET = `01${"11".repeat(32)}`;
const FOREIGN_KEYSET = `02${"22".repeat(32)}`;
const nut13 = (keysetId: string, counter: number) => ({
  schemaVersion: 1 as const,
  kind: "nut13" as const,
  keysetId,
  counter,
});

describe("browser proof backup authority", () => {
  it("requires a committed terminal operation for a verified-losing authority", () => {
    const base = createBrowserCustodyProofRow({
      scopeId: walletScope().scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: {
        id: DERIVATION_KEYSET,
        amount: 1 as never,
        secret: "losing-proof",
        C: `02${"33".repeat(32)}`,
      },
      asset: { kind: "conditional", conditionId: "aa".repeat(32), outcomeCollection: "YES" },
      receivedAtMs: 1,
    });
    const locked = {
      ...base,
      selectability: "locked" as const,
      reservationOperationId: "redeem-a",
      revision: 1,
    };
    const authority = createBrowserProofBackupAuthorityRow(
      locked,
      2,
      nut13(DERIVATION_KEYSET, 1),
      "admission-a",
    );
    const losing = {
      ...locked,
      selectability: "verified-losing" as const,
      reservationOperationId: null,
      revision: 2,
    };
    expect(() =>
      requireBrowserProofBackupAuthorityRow({
        ...authority,
        proofState: "verified-losing",
        proofRevision: 2,
      }),
    ).toThrow("losing classification is unbound");
    expect(
      classifyBrowserProofBackupAuthorityVerifiedLosing(authority, losing, "redeem-a", 3),
    ).toMatchObject({
      proofState: "verified-losing",
      proofRevision: 2,
      terminalOperationId: "redeem-a",
      terminalAuthority: { kind: "local-operation", operationId: "redeem-a" },
      updatedAtMs: 3,
    });
  });
  it("preserves an exact locator replay and rejects a conflicting replay", () => {
    const proof = custodyProof();
    const locator = nut13(DERIVATION_KEYSET, 7);
    const authority = createBrowserProofBackupAuthorityRow(proof, 2, locator, "admission-a");

    expect(
      advanceBrowserProofBackupAuthorityRow(authority, proof, 3, locator, "admission-a"),
    ).toMatchObject({
      derivationLocator: locator,
    });
    expect(() =>
      advanceBrowserProofBackupAuthorityRow(
        authority,
        proof,
        3,
        {
          ...nut13(DERIVATION_KEYSET, 8),
        },
        "admission-a",
      ),
    ).toThrow("derivation locator conflicts");
    expect(authority).toMatchObject({
      derivationLocator: locator,
      proofRevision: 0,
    });
  });

  it("accepts any strict SDK locator without applying a local keyset policy", () => {
    const proof = custodyProof();
    expect(
      createBrowserProofBackupAuthorityRow(proof, 2, nut13(FOREIGN_KEYSET, 7), "admission-a"),
    ).toMatchObject({ derivationLocator: nut13(FOREIGN_KEYSET, 7) });
  });

  it("creates a remote-backed authority without a local admission operation", () => {
    const proof = custodyProof();
    expect(
      createBrowserRemoteProofBackupAuthorityRow({
        proof,
        observedAtMs: 2,
        derivationLocator: nut13(DERIVATION_KEYSET, 7),
        restoreProofId: proof.proofId,
        restoreProofCommitment: "66".repeat(32),
      }),
    ).toMatchObject({
      backupState: "remote-backed",
      admissionOperationId: null,
      backupRecordId: proof.proofId,
      backupRecordCommitment: "66".repeat(32),
    });
  });

  it("records a restored verified-losing proof as a remote-seal authority", () => {
    const proof = {
      ...custodyProof(),
      revision: 1,
      selectability: "verified-losing" as const,
    };
    expect(
      createBrowserRemoteProofBackupAuthorityRow({
        proof,
        observedAtMs: 2,
        derivationLocator: nut13(DERIVATION_KEYSET, 7),
        restoreProofId: proof.proofId,
        restoreProofCommitment: "66".repeat(32),
      }),
    ).toMatchObject({
      proofState: "verified-losing",
      terminalOperationId: null,
      terminalAuthority: { kind: "remote-seal" },
    });
  });

  it("advances remote-backed proof state without changing its restore authority", () => {
    const proof = custodyProof();
    const locator = nut13(DERIVATION_KEYSET, 7);
    const authority = createBrowserRemoteProofBackupAuthorityRow({
      proof,
      observedAtMs: 2,
      derivationLocator: locator,
      restoreProofId: proof.proofId,
      restoreProofCommitment: "66".repeat(32),
    });
    const locked = {
      ...proof,
      revision: 1,
      selectability: "locked" as const,
      reservationOperationId: "operation-a",
    };
    expect(
      advanceBrowserRemoteProofBackupAuthorityRow(authority, locked, 3, locator),
    ).toMatchObject({
      backupState: "remote-backed",
      admissionOperationId: null,
      backupRecordId: proof.proofId,
      backupRecordCommitment: "66".repeat(32),
      proofRevision: 1,
      proofState: "locked",
    });
    expect(() =>
      advanceBrowserRemoteProofBackupAuthorityRow(
        authority,
        locked,
        3,
        nut13(DERIVATION_KEYSET, 8),
      ),
    ).toThrow("derivation locator conflicts");
  });

  it("binds one terminal operation and preserves an exact replay", () => {
    const proof = custodyProof();
    const authority = createBrowserProofBackupAuthorityRow(proof, 2_001, null, "admission-a");

    const bound = bindBrowserProofBackupAuthorityTerminalOperation(authority, "terminal-a", 5_999);

    expect(bound).toMatchObject({
      terminalOperationId: "terminal-a",
      recordCreatedAtUnixSeconds: 2,
      recordUpdatedAtUnixSeconds: 5,
      updatedAtMs: 5_999,
      derivationLocator: null,
      admissionOperationId: "admission-a",
      proofFingerprint: authority.proofFingerprint,
    });
    expect(
      bindBrowserProofBackupAuthorityTerminalOperation(bound, "terminal-a", 6_000),
    ).toStrictEqual(bound);
    expect(() =>
      bindBrowserProofBackupAuthorityTerminalOperation(bound, "terminal-b", 6_000),
    ).toThrow("terminal operation conflicts");
  });

  it("rejects a terminal classification time before the current authority", () => {
    const proof = custodyProof();
    const authority = createBrowserProofBackupAuthorityRow(proof, 2_000, null, "admission-a");

    expect(() =>
      bindBrowserProofBackupAuthorityTerminalOperation(authority, "terminal-a", 1_999),
    ).toThrow("terminal classification time is stale");
  });

  it.each([
    { derivationLocator: { ...nut13(DERIVATION_KEYSET, 0), keysetId: `01${"AA".repeat(32)}` } },
    { derivationLocator: { ...nut13(DERIVATION_KEYSET, -1) } },
    { derivationLocator: { ...nut13(DERIVATION_KEYSET, 2_147_483_648) } },
    { derivationLocator: { ...nut13(DERIVATION_KEYSET, 0), extra: true } },
  ])("fails closed for an invalid derivation locator row", (locator) => {
    expect(() => requireBrowserProofBackupAuthorityRow(authorityRow(locator))).toThrow(
      "derivation locator is invalid",
    );
  });

  it.each([
    {
      name: "losing row without terminal authority",
      patch: { proofState: "verified-losing", proofRevision: 1, terminalAuthority: null },
      message: "losing classification is unbound",
    },
    {
      name: "remote authority with a copied operation id",
      patch: {
        proofState: "verified-losing",
        terminalOperationId: "copied-operation",
        terminalAuthority: { kind: "remote-seal" },
        backupState: "remote-backed",
        admissionOperationId: null,
        backupRecordId: "44".repeat(32),
        backupRecordCommitment: "55".repeat(32),
      },
      message: "terminal authority is invalid",
    },
    {
      name: "local authority with mismatched operation id",
      patch: {
        terminalOperationId: "terminal-a",
        terminalAuthority: { kind: "local-operation", operationId: "terminal-b" },
      },
      message: "terminal authority is invalid",
    },
    {
      name: "unknown authority fields",
      patch: {
        proofState: "verified-losing",
        backupState: "remote-backed",
        admissionOperationId: null,
        backupRecordId: "44".repeat(32),
        backupRecordCommitment: "55".repeat(32),
        terminalAuthority: { kind: "remote-seal", extra: true },
      },
      message: "terminal authority is invalid",
    },
    {
      name: "unknown authority variant",
      patch: {
        proofState: "verified-losing",
        backupState: "remote-backed",
        admissionOperationId: null,
        backupRecordId: "44".repeat(32),
        backupRecordCommitment: "55".repeat(32),
        terminalAuthority: { kind: "copied-seal" },
      },
      message: "terminal authority is invalid",
    },
  ])("rejects $name", ({ patch, message }) => {
    expect(() =>
      requireBrowserProofBackupAuthorityRow({
        ...authorityRow({ derivationLocator: nut13(DERIVATION_KEYSET, 0) }),
        ...patch,
      }),
    ).toThrow(message);
  });

  it("rejects the pre-terminal-authority schema", () => {
    const { terminalAuthority: _terminalAuthority, ...schema3 } = authorityRow({
      derivationLocator: nut13(DERIVATION_KEYSET, 0),
    });
    expect(() => requireBrowserProofBackupAuthorityRow(schema3)).toThrow(
      "browser proof backup authority is invalid",
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

function authorityRow(locator: { derivationLocator: unknown }) {
  return {
    schemaVersion: 4,
    scopeId: walletScope().scopeId,
    proofId: "44".repeat(32),
    proofFingerprint: "55".repeat(32),
    proofRevision: 0,
    proofState: "selectable",
    admissionOperationId: "admission-a",
    terminalOperationId: null,
    terminalAuthority: null,
    recordCreatedAtUnixSeconds: 0,
    recordUpdatedAtUnixSeconds: 0,
    backupState: "local-only",
    derivationLocator: locator.derivationLocator,
    backupRecordId: null,
    backupRecordCommitment: null,
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
