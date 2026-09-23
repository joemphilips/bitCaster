// @vitest-environment node
import "fake-indexeddb/auto";
import {
  Amount,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveKeysetId,
  hashToCurve,
  Keyset,
  HttpResponseError,
  NetworkError,
  OutputData,
  pointFromHex,
  RateLimitError,
  type Proof,
  type ProofState,
  type Wallet as CashuWallet,
} from "@cashu/cashu-ts";
import { bytesToHex } from "@noble/curves/utils.js";
import type { WhereClause } from "dexie";
import {
  bindDurableBolt11MintQuoteOperation,
  createDurableBolt11MintQuote,
  observeDurableBolt11MintQuoteState,
} from "@bitcaster/client-sdk/durableBolt11MintQuote";
import { encodeCtfRangeOrderPreparationArtifact } from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import {
  serializeDurableWalletMintOperation,
  toDurableCustodyProofOperationInput,
} from "@bitcaster/client-sdk/durableWalletOperation";
import {
  collectEncryptedWalletBackupV2DescriptorPages,
  createEncryptedWalletBackupV2AssetIdentity,
  createEncryptedWalletBackupV2CurrentHead,
  createEncryptedWalletBackupV2KeyHandle,
  enumerateEncryptedWalletBackupV2DescriptorPages,
  issueEncryptedWalletBackupV2TerminalSeal,
  prepareEncryptedWalletBackupV2ProofSetBundle,
  type EncryptedWalletBackupV2ProofSetAsset,
  type EncryptedWalletBackupV2DescriptorPage,
  type EncryptedWalletBackupV2RemotePort,
} from "@bitcaster/client-sdk";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { deriveDurableWalletProofSecret } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserProofBackupAuthorityRow } from "../../stores/browser-proof-backup-authority";
import {
  createEncryptedWalletBackupV2DesiredAssetRow,
  createEncryptedWalletBackupV2RemovalIntent,
} from "../../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
} from "../../stores/durable-custody-db";
import type { BrowserCustodyProofRow } from "../../stores/durable-custody-types";
import { EncryptedWalletBackupV2DexieAuthorityStore } from "../../stores/encrypted-wallet-backup-v2-db";
import {
  BitcasterDB,
  DURABLE_BOLT11_MINT_QUOTE_OPERATION_METADATA_KEY,
} from "../../stores/proof-db";
import { recoverBrowserEncryptedWalletBackupV2Conflict } from "../browserEncryptedWalletBackupV2ConflictRecovery";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import { commitBrowserCtfTerminalOperation } from "../../test/browserEncryptedWalletBackupV2CommittedTerminalFixture";

const REALM = "backup.example";
const MINT = "https://mint.example";
const MINT_PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? 1 : 0));
const MINT_PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const KEYSET = deriveKeysetId({ 1: MINT_PUBLIC_KEY }, { unit: "msat", versionByte: 1 });
const CONDITION_ID = "aa".repeat(32);
const OUTCOME_LABEL = "YES";
const OUTCOME_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: OUTCOME_LABEL,
});
const openDatabases: BitcasterDB[] = [];
let sequence = 0;
const admissionRace = vi.hoisted(() => ({
  enabled: false,
  message: "browser V2 accepted-remote local state changed before commit",
  beforeAdmission: null as null | (() => Promise<void>),
}));

vi.mock("../browserEncryptedWalletBackupV2Admission", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../browserEncryptedWalletBackupV2Admission")>();
  return {
    ...original,
    admitBrowserEncryptedWalletBackupV2AcceptedRemoteAsset: async (
      ...args: Parameters<typeof original.admitBrowserEncryptedWalletBackupV2AcceptedRemoteAsset>
    ) => {
      if (admissionRace.beforeAdmission !== null) await admissionRace.beforeAdmission();
      if (admissionRace.enabled) throw new Error(admissionRace.message);
      return original.admitBrowserEncryptedWalletBackupV2AcceptedRemoteAsset(...args);
    },
  };
});

afterEach(async () => {
  admissionRace.enabled = false;
  admissionRace.message = "browser V2 accepted-remote local state changed before commit";
  admissionRace.beforeAdmission = null;
  vi.restoreAllMocks();
  for (const database of openDatabases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("browser encrypted wallet backup V2 conflict recovery", () => {
  it("recovers a remote-only terminal-sealed CTF bundle without loading the mint", async () => {
    const fixture = await conflictFixture({ conditionalAsset: true });
    await installRemoteBundles(
      fixture,
      [{ proofAsset: fixtureProofAsset(fixture), counter: 400, custodyRevision: 2n }],
      { terminalSealed: true },
    );
    const loadWallet = vi.fn(async () => {
      throw new Error("terminal-sealed restore must not load the mint");
    });

    await expect(
      recoverBrowserEncryptedWalletBackupV2Conflict({ ...fixture.input, loadWallet }),
    ).resolves.toEqual({ kind: "completed", headVersion: 1, recoveryVersion: 2 });

    expect(loadWallet).not.toHaveBeenCalled();
    await expect(fixture.database.custodyProofs.toArray()).resolves.toMatchObject([
      { selectability: "verified-losing" },
    ]);
    await expect(fixture.database.custodyProofBackupAuthorities.toArray()).resolves.toMatchObject([
      { terminalAuthority: { kind: "remote-seal" } },
    ]);
    await expect(fixture.store.readNewWritePermission()).resolves.toMatchObject({ canWrite: true });
  });

  it("accepts the same authenticated empty head twice and clears refusal atomically", async () => {
    const fixture = await conflictFixture();

    await expect(recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input)).resolves.toEqual({
      kind: "completed",
      headVersion: 1,
      recoveryVersion: 2,
    });

    await expect(fixture.store.readNewWritePermission()).resolves.toMatchObject({
      canWrite: true,
      localRecoveryStatus: "ready",
      localRecoveryVersion: 2,
    });
    expect(fixture.remote.readDescriptorPage).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["ordinary", false],
    ["CTF", true],
  ] as const)(
    "recovers a remote-only %s asset before enabling writes",
    async (_label, conditional) => {
      const fixture = await conflictFixture({ conditionalAsset: conditional });
      await installRemoteBundles(fixture, [
        { proofAsset: fixtureProofAsset(fixture), counter: 400, custodyRevision: 2n },
      ]);

      await expect(
        recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input),
      ).resolves.toMatchObject({
        kind: "completed",
        headVersion: 1,
      });

      const desired = await fixture.database.encryptedWalletBackupV2DesiredAssets.toArray();
      const active = (await fixture.database.custodyProofs.toArray()).filter(
        ({ selectability }) => selectability === "selectable",
      );
      expect(desired).toHaveLength(1);
      expect(desired[0]).toMatchObject({ activeProofCount: 1, syncState: "acknowledged" });
      expect(active).toHaveLength(1);
      expect(active.reduce((total, proof) => total + proof.amount, 0)).toBe(1);
      await expect(fixture.store.readNewWritePermission()).resolves.toMatchObject({
        canWrite: true,
      });
      if (conditional) {
        const keysets = await fixture.database.custodyConditionalKeysets.toArray();
        expect(keysets.some(({ conditionId }) => conditionId === CONDITION_ID)).toBe(true);
      }
    },
  );

  it("recovers remote assets together with the existing local asset", async () => {
    const fixture = await conflictFixture();
    const local = await addLocalProofs(fixture, 1);
    const ctf = {
      kind: "ctf" as const,
      conditionId: "cc".repeat(32),
      outcomeLabel: "NO",
      outcomeCollectionId: deriveRootCtfOutcomeCollectionId({
        conditionId: "cc".repeat(32),
        outcomeCollection: "NO",
      }),
      registeredAt: 2,
      finalExpiry: null,
    };
    await installRemoteBundles(fixture, [
      { proofAsset: { kind: "ordinary" }, counter: 400, custodyRevision: 2n },
      { proofAsset: ctf, counter: 500, custodyRevision: 3n },
    ]);

    await expect(
      recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input),
    ).resolves.toMatchObject({
      kind: "completed",
    });

    await expect(
      fixture.database.custodyProofs.get([fixture.scopeId, local[0]!.proof.proofId]),
    ).resolves.toMatchObject({ selectability: "spent" });
    expect(await fixture.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(2);
    const active = (await fixture.database.custodyProofs.toArray()).filter(
      ({ selectability }) => selectability === "selectable",
    );
    expect(active).toHaveLength(2);
    expect(active.reduce((total, proof) => total + proof.amount, 0)).toBe(2);
    await expect(fixture.store.readNewWritePermission()).resolves.toMatchObject({ canWrite: true });
  });

  it("retires an exact mint-SPENT local predecessor, keeps its body, and removes the empty asset", async () => {
    const fixture = await conflictFixture();
    const local = await addLocalProofs(fixture, 1);
    fixture.wallet.checkProofsStates = vi.fn(async (proofs) => states(proofs, "SPENT"));
    const beforeBody = local[0]!.proof.proofBody.slice();

    await expect(
      recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input),
    ).resolves.toMatchObject({ kind: "completed" });

    const retired = await fixture.database.custodyProofs.get([
      fixture.scopeId,
      local[0]!.proof.proofId,
    ]);
    expect(retired).toMatchObject({ selectability: "spent", revision: 1 });
    expect(
      retired !== undefined &&
        retired.proofBody.length === beforeBody.length &&
        retired.proofBody.every((byte, index) => byte === beforeBody[index]),
    ).toBe(true);
    expect(await fixture.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
  });

  it("retires a spent predecessor and strictly admits its authenticated remote successor", async () => {
    const fixture = await conflictFixture();
    const predecessor = await addLocalProofs(fixture, 1);
    await installRemoteSuccessor(fixture);

    await expect(
      recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input),
    ).resolves.toMatchObject({ kind: "completed", headVersion: 1 });

    await expect(
      fixture.database.custodyProofs.get([fixture.scopeId, predecessor[0]!.proof.proofId]),
    ).resolves.toMatchObject({ selectability: "spent" });
    await expect(
      fixture.database.encryptedWalletBackupV2DesiredAssets.toArray(),
    ).resolves.toMatchObject([
      { activeProofCount: 1, syncState: "acknowledged", custodyRevision: "2" },
    ]);
    expect(
      (await fixture.database.custodyProofs.toArray()).filter(
        ({ selectability }) => selectability === "selectable",
      ),
    ).toHaveLength(1);
  });

  it.each([
    ["UNSPENT", "local-predecessor-unspent"],
    ["PENDING", "local-predecessor-unknown"],
  ] as const)("keeps a %s predecessor and leaves writes refused", async (state, reason) => {
    const fixture = await conflictFixture();
    const local = await addLocalProofs(fixture, 1);
    fixture.wallet.checkProofsStates = vi.fn(async (proofs) => states(proofs, state));

    await expect(recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input)).resolves.toEqual({
      kind: "incomplete",
      reason,
    });

    await expect(
      fixture.database.custodyProofs.get([fixture.scopeId, local[0]!.proof.proofId]),
    ).resolves.toMatchObject({ selectability: "selectable", revision: 0 });
    await expect(fixture.store.readNewWritePermission()).resolves.toMatchObject({
      canWrite: false,
    });
  });

  it("treats malformed and unavailable NUT-07 evidence as incomplete", async () => {
    const malformed = await conflictFixture();
    await addLocalProofs(malformed, 1);
    malformed.wallet.checkProofsStates = vi.fn(async () => []);
    await expect(recoverBrowserEncryptedWalletBackupV2Conflict(malformed.input)).resolves.toEqual({
      kind: "incomplete",
      reason: "local-predecessor-unknown",
    });

    const unavailable = await conflictFixture();
    await addLocalProofs(unavailable, 1);
    unavailable.wallet.checkProofsStates = vi.fn(async () => {
      throw new NetworkError("mint unavailable");
    });
    await expect(recoverBrowserEncryptedWalletBackupV2Conflict(unavailable.input)).resolves.toEqual(
      { kind: "incomplete", reason: "local-predecessor-unknown" },
    );
  });

  it("checks NUT-07 in bounded batches", async () => {
    const fixture = await conflictFixture();
    await addLocalProofs(fixture, 257);
    fixture.wallet.checkProofsStates = vi.fn(async (proofs) => states(proofs, "SPENT"));

    await expect(
      recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input),
    ).resolves.toMatchObject({ kind: "completed" });

    expect(fixture.wallet.checkProofsStates).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(fixture.wallet.checkProofsStates).mock.calls.map(([proofs]) => proofs.length),
    ).toEqual([256, 1]);
  }, 30_000);

  it("keeps refusal when a proof changes after exact NUT-07 classification", async () => {
    const fixture = await conflictFixture();
    const [local] = await addLocalProofs(fixture, 1);
    fixture.wallet.checkProofsStates = vi.fn(async (proofs) => {
      await fixture.database.custodyProofs.update([fixture.scopeId, local!.proof.proofId], {
        revision: 1,
      });
      return states(proofs, "SPENT");
    });

    await expect(recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input)).resolves.toEqual({
      kind: "incomplete",
      reason: "local-state-changed",
    });
    await expect(fixture.store.readNewWritePermission()).resolves.toMatchObject({
      canWrite: false,
    });
  });

  it("keeps refusal when local desired state changes during remote admission", async () => {
    const fixture = await conflictFixture();
    await addLocalProofs(fixture, 1);
    await installRemoteSuccessor(fixture);
    admissionRace.enabled = true;

    await expect(recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input)).resolves.toEqual({
      kind: "incomplete",
      reason: "local-state-changed",
    });
  });

  it("keeps refusal when a new local proof appears before remote admission", async () => {
    const fixture = await conflictFixture();
    const [predecessor] = await addLocalProofs(fixture, 1);
    await installRemoteSuccessor(fixture);
    admissionRace.beforeAdmission = async () => {
      await addLocalProofs(fixture, 1, 100);
    };

    await expect(recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input)).resolves.toEqual({
      kind: "incomplete",
      reason: "local-state-changed",
    });
    await expect(
      fixture.database.custodyProofs.get([fixture.scopeId, predecessor!.proof.proofId]),
    ).resolves.toMatchObject({ selectability: "spent" });
    await expect(fixture.store.readNewWritePermission()).resolves.toMatchObject({
      canWrite: false,
    });
  });

  it("keeps refusal when a removal intent appears before remote admission", async () => {
    const fixture = await conflictFixture({ conditionalAsset: true });
    const [predecessor] = await addLocalProofs(fixture, 1);
    await installRemoteSuccessor(fixture);
    admissionRace.beforeAdmission = async () => {
      const [desired] = await fixture.database.encryptedWalletBackupV2DesiredAssets.toArray();
      if (desired === undefined) throw new Error("test desired asset is absent");
      const intent = createEncryptedWalletBackupV2RemovalIntent({
        intentId: "conflict-recovery-race-removal",
        createdAtMs: 10,
        realm: REALM,
        walletId: fixture.input.keyHandle.walletId,
        enrollmentEpoch: 1,
        expectedHeadVersion: 1,
        expectedActiveSetDigest: "00".repeat(32),
        targetCustodyRevision: desired.custodyRevision,
        proofs: [
          {
            proofId: predecessor!.proof.proofId,
            proofFingerprint: predecessor!.proof.proofFingerprint,
            proofRevision: predecessor!.proof.revision,
            proofCommitment: "cc".repeat(32),
          },
        ],
      });
      await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
        ...desired,
        removalIntent: intent,
      });
    };

    await expect(recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input)).resolves.toEqual({
      kind: "incomplete",
      reason: "local-state-changed",
    });
    await expect(fixture.store.readNewWritePermission()).resolves.toMatchObject({
      canWrite: false,
    });
  });

  it("keeps refusal when present-asset admission sees unfinished custody work", async () => {
    const fixture = await conflictFixture();
    await addLocalProofs(fixture, 1);
    await installRemoteSuccessor(fixture);
    admissionRace.enabled = true;
    admissionRace.message = "browser V2 accepted-remote custody work is unfinished";

    await expect(recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input)).resolves.toEqual({
      kind: "incomplete",
      reason: "local-state-changed",
    });
  });

  it("keeps refusal when predecessor retirement sees a reservation race", async () => {
    const fixture = await conflictFixture();
    const [local] = await addLocalProofs(fixture, 1);
    await installRemoteSuccessor(fixture);
    let checks = 0;
    fixture.wallet.checkProofsStates = vi.fn(async (proofs) => {
      checks += 1;
      await fixture.database.custodyReservations.put({
        scopeId: fixture.scopeId,
        proofId: local!.proof.proofId,
        operationId: "retirement-race-operation",
        reservationId: "retirement-race-reservation",
        inputPosition: 0,
      });
      return states(proofs, checks === 1 ? "UNSPENT" : "SPENT");
    });

    await expect(recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input)).resolves.toEqual({
      kind: "incomplete",
      reason: "local-state-changed",
    });
  });

  it("keeps refusal when the authenticated head changes after bundle hydration", async () => {
    const fixture = await conflictFixture({ secondHeadVersion: 2 });
    await installRemoteBundles(fixture, [
      { proofAsset: fixtureProofAsset(fixture), counter: 400, custodyRevision: 2n },
    ]);

    await expect(recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input)).resolves.toEqual({
      kind: "incomplete",
      reason: "remote-head-changed",
    });
    await expect(fixture.store.readNewWritePermission()).resolves.toMatchObject({
      canWrite: false,
    });
    expect(await fixture.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(1);
  });

  it("keeps refusal when mint verification is unavailable for a remote-only asset", async () => {
    const fixture = await conflictFixture();
    await installRemoteBundles(fixture, [
      { proofAsset: { kind: "ordinary" }, counter: 400, custodyRevision: 2n },
    ]);
    const input = {
      ...fixture.input,
      loadWallet: async () => {
        throw new NetworkError("mint unavailable");
      },
    };

    await expect(recoverBrowserEncryptedWalletBackupV2Conflict(input)).resolves.toEqual({
      kind: "incomplete",
      reason: "remote-unavailable",
    });
    expect(await fixture.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
    await expect(fixture.store.readNewWritePermission()).resolves.toMatchObject({
      canWrite: false,
    });
  });

  it("does not accept a remote-only asset whose mint keyset is unknown", async () => {
    const fixture = await conflictFixture();
    await installRemoteBundles(fixture, [
      { proofAsset: { kind: "ordinary" }, counter: 400, custodyRevision: 2n },
    ]);
    Object.assign(fixture.wallet, {
      getKeyset: () => {
        throw new Error("browser V2 restore keyset is missing");
      },
    });

    await expect(recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input)).rejects.toThrow(
      "browser V2 restore keyset is missing",
    );
    expect(await fixture.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
    await expect(fixture.store.readNewWritePermission()).resolves.toMatchObject({
      canWrite: false,
    });
  });

  it("keeps partial hydration refused and completes idempotently on retry", async () => {
    const fixture = await conflictFixture();
    const ctf = {
      kind: "ctf" as const,
      conditionId: "cc".repeat(32),
      outcomeLabel: "NO",
      outcomeCollectionId: deriveRootCtfOutcomeCollectionId({
        conditionId: "cc".repeat(32),
        outcomeCollection: "NO",
      }),
      registeredAt: 2,
      finalExpiry: null,
    };
    const bundles = [
      { proofAsset: { kind: "ordinary" } as const, counter: 400, custodyRevision: 2n },
      { proofAsset: ctf, counter: 500, custodyRevision: 3n },
    ];
    await installRemoteBundles(fixture, bundles, { failOnObjectRead: 2 });

    await expect(recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input)).resolves.toEqual({
      kind: "incomplete",
      reason: "remote-unavailable",
    });
    expect(await fixture.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(1);
    const partialProofIds = (await fixture.database.custodyProofs.toArray())
      .filter(({ selectability }) => selectability === "selectable")
      .map(({ proofId }) => proofId);
    expect(partialProofIds).toHaveLength(1);
    await expect(fixture.store.readNewWritePermission()).resolves.toMatchObject({
      canWrite: false,
    });

    await expect(
      recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input),
    ).resolves.toMatchObject({
      kind: "completed",
    });
    expect(await fixture.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(2);
    const recoveredProofIds = (await fixture.database.custodyProofs.toArray())
      .filter(({ selectability }) => selectability === "selectable")
      .map(({ proofId }) => proofId);
    expect(recoveredProofIds).toHaveLength(2);
    expect(new Set(recoveredProofIds).size).toBe(recoveredProofIds.length);
    expect(partialProofIds.every((proofId) => recoveredProofIds.includes(proofId))).toBe(true);
    await expect(fixture.store.readNewWritePermission()).resolves.toMatchObject({ canWrite: true });
  });

  it("reports an unavailable backup service without clearing refusal", async () => {
    const fixture = await conflictFixture();
    fixture.remote.readDescriptorPage.mockRejectedValueOnce(new TypeError("network unavailable"));

    await expect(recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input)).resolves.toEqual({
      kind: "incomplete",
      reason: "remote-unavailable",
    });
    await expect(fixture.store.readNewWritePermission()).resolves.toMatchObject({
      canWrite: false,
    });
  });

  it.each([
    ["cashu network failure", new NetworkError("mint unavailable")],
    ["cashu server failure", new HttpResponseError("mint unavailable", 503)],
    ["cashu rate limit", new RateLimitError("mint busy")],
  ] as const)(
    "classifies %s during forced remote verification as unavailable",
    async (_label, error) => {
      const fixture = await conflictFixture();
      await addLocalProofs(fixture, 1);
      await installRemoteSuccessor(fixture);
      fixture.wallet.checkProofsStates = vi.fn(async () => {
        throw error;
      });

      await expect(recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input)).resolves.toEqual({
        kind: "incomplete",
        reason: "remote-unavailable",
      });
    },
  );

  it("does not disguise corrupt remote proof evidence as unavailable", async () => {
    const fixture = await conflictFixture();
    await addLocalProofs(fixture, 1);
    await installRemoteSuccessor(fixture);
    fixture.wallet.checkProofsStates = vi.fn(async () => {
      throw new Error("corrupt proof evidence");
    });

    await expect(recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input)).rejects.toThrow(
      "corrupt proof evidence",
    );
  });

  it("keeps refusal while submitted mint work is unresolved", async () => {
    const fixture = await conflictFixture();
    await fixture.database.proofOperations.put({
      operationId: "prepared-mint",
      kind: "wallet-mint",
      state: "prepared",
      mintUrl: MINT,
      inputs: [],
      outputs: {},
      metadata: { unit: "msat" },
      createdAt: 1,
      updatedAt: 1,
    });

    await expect(recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input)).resolves.toEqual({
      kind: "incomplete",
      reason: "submitted-work-unresolved",
    });
    expect(fixture.remote.readDescriptorPage).toHaveBeenCalledOnce();
  });

  it.each(["ctf-range", "outgoing-mint-recovery"] as const)(
    "keeps refusal while %s work is active",
    async (kind) => {
      const fixture = await conflictFixture();
      if (kind === "ctf-range") {
        await fixture.database.ctfRangePreparations.put(activeRangePreparation(fixture.scopeId));
      } else {
        await fixture.database.outgoingCashuTransfers.put({
          scopeId: fixture.scopeId,
          mintUrl: MINT,
          mintRecoveryState: "pending",
          localAuthorityState: "terminal",
          bearerMintUrl: null,
          dueAtMs: 1,
          transferId: "pending-mint-recovery",
          recipientBinding: null,
          admissionState: "consumed",
          transfer: {} as never,
        });
      }

      await expect(recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input)).resolves.toEqual({
        kind: "incomplete",
        reason: "submitted-work-unresolved",
      });
    },
  );

  it.each(["UNPAID", "PAID"] as const)(
    "retains and refuses a prepared mint with a %s quote",
    async (observedState) => {
      const fixture = await conflictFixture();
      await addQuoteOwnedPreparedMint(fixture, observedState);
      const operations = await fixture.database.proofOperations.toArray();
      const quotes = await fixture.database.mintQuotes.toArray();

      await expect(recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input)).resolves.toEqual({
        kind: "incomplete",
        reason: "submitted-work-unresolved",
      });

      expect(await fixture.database.proofOperations.toArray()).toEqual(operations);
      expect(await fixture.database.mintQuotes.toArray()).toEqual(quotes);
    },
  );

  it("refuses unresolved work attached to a present asset", async () => {
    const fixture = await conflictFixture();
    const [local] = await addLocalProofs(fixture, 1);
    await installRemoteSuccessor(fixture);
    await fixture.database.custodyReservations.put({
      scopeId: fixture.scopeId,
      proofId: local!.proof.proofId,
      operationId: "present-asset-operation",
      reservationId: "present-asset-reservation",
      inputPosition: 0,
    });

    await expect(recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input)).resolves.toEqual({
      kind: "incomplete",
      reason: "submitted-work-unresolved",
    });
  });

  it("bounds orphan scans and keeps refusal when active proofs exceed recovered coverage", async () => {
    const fixture = await conflictFixture();
    await addOrphanProof(fixture, 2);
    const limits: number[] = [];
    const where = fixture.database.custodyProofs.where.bind(fixture.database.custodyProofs);
    vi.spyOn(fixture.database.custodyProofs, "where").mockImplementation((index) => {
      const clause = where(index) as unknown as WhereClause<
        BrowserCustodyProofRow,
        [string, string]
      >;
      if (String(index) === "[scopeId+selectability+proofId]") {
        const between = clause.between.bind(clause);
        vi.spyOn(clause, "between").mockImplementation(
          (lower, upper, includeLower, includeUpper) => {
            const collection = between(lower, upper, includeLower, includeUpper);
            const limit = collection.limit.bind(collection);
            vi.spyOn(collection, "limit").mockImplementation((value) => {
              limits.push(value);
              return limit(value);
            });
            return collection;
          },
        );
      }
      return clause as never;
    });

    await expect(recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input)).resolves.toEqual({
      kind: "incomplete",
      reason: "local-state-changed",
    });
    expect(limits.length).toBeGreaterThan(0);
    expect(limits.every((limit) => limit <= 64)).toBe(true);
  });

  it("rejects malformed local custody evidence instead of treating it as a race", async () => {
    const fixture = await conflictFixture();
    await addOrphanProof(fixture);
    const [proof] = await fixture.database.custodyProofs.toArray();
    await fixture.database.custodyProofs.update([fixture.scopeId, proof!.proofId], { amount: 0 });

    await expect(recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input)).rejects.toThrow(
      "browser custody proof row is invalid",
    );
  });

  it("rolls back write enable when valid local state changes after the second head read", async () => {
    const fixture = await conflictFixture({
      beforeSecondHead: async (current) => {
        await addOrphanProof(current);
      },
    });

    await expect(recoverBrowserEncryptedWalletBackupV2Conflict(fixture.input)).resolves.toEqual({
      kind: "incomplete",
      reason: "local-state-changed",
    });
    await expect(fixture.store.readNewWritePermission()).resolves.toMatchObject({
      canWrite: false,
    });
  });
});

interface Fixture {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly asset: ReturnType<typeof createEncryptedWalletBackupV2AssetIdentity>;
  readonly conditionalAsset: boolean;
  readonly store: EncryptedWalletBackupV2DexieAuthorityStore;
  readonly wallet: CashuWallet & { checkProofsStates: ReturnType<typeof vi.fn> };
  readonly remote: EncryptedWalletBackupV2RemotePort & {
    readDescriptorPage: ReturnType<typeof vi.fn>;
  };
  readonly secondHeadVersion: number;
  readonly beforeSecondHead: ((fixture: Fixture) => Promise<void>) | undefined;
  readonly input: Parameters<typeof recoverBrowserEncryptedWalletBackupV2Conflict>[0];
}

async function conflictFixture(options?: {
  readonly secondHeadVersion?: number;
  readonly beforeSecondHead?: (fixture: Fixture) => Promise<void>;
  readonly conditionalAsset?: boolean;
}): Promise<Fixture> {
  sequence += 1;
  const seed = new Uint8Array(64).fill(sequence);
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed,
    realm: REALM,
    runtime: { subtle: crypto.subtle },
  });
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: keyHandle.walletId,
  });
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  openDatabases.push(database);
  const store = new EncryptedWalletBackupV2DexieAuthorityStore({
    database,
    scopeId,
    realm: REALM,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
  });
  const initialHead = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: 0,
    bundles: [],
  });
  const conflictHead = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: 1,
    bundles: [],
  });
  const secondHead = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: options?.secondHeadVersion ?? 1,
    bundles: [],
  });
  await store.acceptCompetingHead({
    collectedHeadEvidence: collected(initialHead),
    stalePreparedMutation: { mutationId: "00".repeat(16), requestDigest: "00".repeat(32) },
  });
  await store.markCompetingHeadRecoveryRequired({ collectedHeadEvidence: collected(conflictHead) });

  let headReads = 0;
  let fixture!: Fixture;
  const remote = {
    readDescriptorPage: vi.fn(async () => {
      headReads += 1;
      if (headReads === 2) await options?.beforeSecondHead?.(fixture);
      return emptyPage(headReads === 1 ? conflictHead : secondHead);
    }),
    readObject: vi.fn(),
    writeMutation: vi.fn(),
    readMutationReceipt: vi.fn(),
  } as unknown as Fixture["remote"];
  const wallet = {
    mint: { mintUrl: MINT },
    checkProofsStates: vi.fn(),
  } as unknown as Fixture["wallet"];
  const conditionalAsset = options?.conditionalAsset ?? false;
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: MINT,
    unit: "msat",
    asset: conditionalAsset
      ? {
          kind: "ctf",
          conditionId: CONDITION_ID,
          outcomeLabel: OUTCOME_LABEL,
          outcomeCollectionId: OUTCOME_COLLECTION_ID,
          registeredAt: 1,
          finalExpiry: null,
        }
      : { kind: "ordinary" },
  });
  fixture = {
    database,
    scopeId,
    asset,
    conditionalAsset,
    store,
    wallet,
    remote,
    secondHeadVersion: options?.secondHeadVersion ?? 1,
    beforeSecondHead: options?.beforeSecondHead,
    input: {
      database,
      scopeId,
      seed,
      keyHandle,
      enrollmentEpoch: 1,
      remote,
      requestUrl: (kind, value) => `https://backup.example/v2/${kind}/${value ?? "first"}`,
      nowUnixSeconds: () => 10,
      runtime: {
        subtle: crypto.subtle,
        getRandomValues: crypto.getRandomValues.bind(crypto),
      },
      signal: new AbortController().signal,
      isCurrentProfile: () => true,
      loadWallet: async () => wallet,
      lockManager: immediateLockManager(),
    },
  };
  return fixture;
}

async function addLocalProofs(fixture: Fixture, count: number, counterStart = 0) {
  const keysetId = fixtureKeysetId(fixtureProofAsset(fixture));
  const entries = Array.from({ length: count }, (_, counter) => {
    const locator = {
      schemaVersion: 1 as const,
      kind: "nut13" as const,
      keysetId,
      counter: counterStart + counter,
    };
    const proof = createBrowserCustodyProofRow({
      scopeId: fixture.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: {
        id: keysetId,
        amount: Amount.from(1),
        secret: deriveDurableWalletProofSecret({
          seed: fixture.input.seed,
          locator,
          proofKeysetId: keysetId,
          proofAmount: 1,
        }),
        C: `02${(counterStart + counter + 1).toString(16).padStart(64, "0")}`,
      },
      asset: fixture.conditionalAsset
        ? {
            kind: "conditional",
            conditionId: CONDITION_ID,
            outcomeCollection: OUTCOME_LABEL,
          }
        : { kind: "regular" },
      receivedAtMs: 1,
    });
    return {
      proof,
      authority: createBrowserProofBackupAuthorityRow(
        proof,
        1,
        locator,
        `conflict-admission-${counter}`,
      ),
    };
  });
  await Promise.all([
    fixture.database.custodyProofs.bulkPut(entries.map(({ proof }) => proof)),
    fixture.database.custodyProofBackupAuthorities.bulkPut(
      entries.map(({ authority }) => authority),
    ),
    fixture.database.encryptedWalletBackupV2DesiredAssets.put(
      createEncryptedWalletBackupV2DesiredAssetRow({
        scopeId: fixture.scopeId,
        asset: fixture.asset,
        custodyRevision: 1n,
        activeProofCount: count,
        terminalCtfContext: fixture.conditionalAsset
          ? {
              conditionId: CONDITION_ID,
              outcomeLabel: OUTCOME_LABEL,
              outcomeCollectionId: OUTCOME_COLLECTION_ID,
              registeredAt: 1,
              finalExpiry: null,
            }
          : null,
      }),
    ),
  ]);
  if (fixture.conditionalAsset) {
    await fixture.database.custodyConditionalKeysets.put({
      scopeId: fixture.scopeId,
      schemaVersion: 1,
      normalizedMint: MINT,
      unit: "msat",
      keysetId,
      denominationPublicKeys: { "1": MINT_PUBLIC_KEY },
      inputFeePpk: 0,
      conditionId: CONDITION_ID,
      outcomeCollection: OUTCOME_LABEL,
      outcomeCollectionId: OUTCOME_COLLECTION_ID,
      registeredAtUnixSeconds: 1,
      finalExpiryUnixSeconds: null,
      curve: "secp256k1",
    });
  }
  return entries;
}

async function addOrphanProof(fixture: Fixture, count = 1): Promise<void> {
  await addLocalProofs(fixture, count);
  await fixture.database.encryptedWalletBackupV2DesiredAssets.clear();
}

async function addQuoteOwnedPreparedMint(
  fixture: Fixture,
  observedState: "UNPAID" | "PAID",
): Promise<void> {
  const initial = createDurableBolt11MintQuote({
    mintUrl: MINT,
    unit: "msat",
    requestedAmount: "1",
    quoteId: `quote-${sequence}-${observedState}`,
    invoiceRequest: `lnbc1-${sequence}-${observedState}`,
  });
  const output = OutputData.createSingleData("1", KEYSET, `mint-${sequence}`, 3n);
  const operation = serializeDurableWalletMintOperation({
    operationId: initial.walletMintOperationId,
    mintUrl: MINT,
    unit: "msat",
    preview: {
      method: "bolt11",
      payload: { quote: initial.quoteId, outputs: [output.blindedMessage] },
      outputData: [output],
      keysetId: KEYSET,
      quote: { quote: initial.quoteId },
    },
  });
  const quote = observeDurableBolt11MintQuoteState(
    bindDurableBolt11MintQuoteOperation(initial, operation),
    observedState,
  );
  const custody = toDurableCustodyProofOperationInput(operation);
  await Promise.all([
    fixture.database.proofOperations.put({
      operationId: operation.operationId,
      kind: "wallet-mint",
      state: "prepared",
      mintUrl: operation.mintUrl,
      inputs: [],
      outputs: custody.outputs as never,
      metadata: {
        ...custody.metadata,
        [DURABLE_BOLT11_MINT_QUOTE_OPERATION_METADATA_KEY]: quote.quoteRecordId,
      },
      createdAt: 1,
      updatedAt: 1,
    }),
    fixture.database.mintQuotes.put({
      scopeId: fixture.scopeId,
      paymentMethod: "bolt11",
      quoteRecordId: quote.quoteRecordId,
      observedState: quote.observedState,
      recoveryState: "pending",
      lastRecoveryAttemptAtMs: 0,
      quote,
    }),
  ]);
}

function activeRangePreparation(scopeId: string) {
  return {
    scopeId,
    rangeOperationId: "range-active",
    sourceOperationId: "range-active-source",
    authorizationId: "range-active-authorization",
    clientOrderId: "range-active-client",
    orderRouteId: "condition-a-YES",
    normalizedMint: MINT,
    conditionId: "condition-a",
    unit: "msat" as const,
    tokenSide: "Outcome" as const,
    side: "Buy" as const,
    priceSubunits: 500,
    amountSubunits: 1_000,
    minimumFillAmountSubunits: 1_000,
    divisibility: 1_000 as const,
    authorizationExpiresAtUnixSeconds: 1_000,
    preparationBytes: encodeCtfRangeOrderPreparationArtifact({ version: 1 }),
    createdAtMs: 1,
    lifecycleState: "prepared" as const,
    revision: 0,
    capability: null,
    updatedAtMs: 1,
  };
}

async function installRemoteSuccessor(fixture: Fixture) {
  return installRemoteBundles(fixture, [
    { proofAsset: fixtureProofAsset(fixture), counter: 400, custodyRevision: 2n },
  ]);
}

async function installRemoteBundles(
  fixture: Fixture,
  bundles: readonly {
    readonly proofAsset: EncryptedWalletBackupV2ProofSetAsset;
    readonly counter: number;
    readonly custodyRevision: bigint;
  }[],
  options?: { readonly failOnObjectRead?: number; readonly terminalSealed?: boolean },
): Promise<void> {
  const prepared = await Promise.all(
    bundles.map(async ({ proofAsset, counter, custodyRevision }) => {
      const { keysetId, keyset } = fixtureKeyset(proofAsset);
      const asset = createEncryptedWalletBackupV2AssetIdentity({
        mintUrl: MINT,
        unit: "msat",
        asset: proofAsset,
      });
      const locator = {
        schemaVersion: 1 as const,
        kind: "nut13" as const,
        keysetId,
        counter,
      };
      const output = OutputData.createSingleDeterministicData(
        1,
        fixture.input.seed,
        counter,
        keysetId,
      );
      const signature = createBlindSignature(
        pointFromHex(output.blindedMessage.B_),
        MINT_PRIVATE_KEY,
        keysetId,
      );
      const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), MINT_PRIVATE_KEY);
      const signedProof = output.toProof(
        {
          id: keysetId,
          amount: Amount.from(1),
          C_: signature.C_.toHex(true),
          dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
        },
        { id: keysetId, keys: { 1: MINT_PUBLIC_KEY } },
      );
      const proof = { ...signedProof, amount: 1 as never };
      const terminalSeal = options?.terminalSealed
        ? await issueRemoteTerminalSeal(fixture, proofAsset, proof, locator)
        : undefined;
      const bundle = await prepareEncryptedWalletBackupV2ProofSetBundle({
        keyHandle: fixture.input.keyHandle,
        seed: fixture.input.seed,
        asset,
        custodyRevision,
        counterHighWaterMarks: [
          { mintUrl: MINT, unit: "msat", keysetId, nextCounter: counter + 1 },
        ],
        proofs: [
          {
            mintUrl: MINT,
            unit: "msat",
            asset: proofAsset,
            locator,
            proof,
            ...(terminalSeal === undefined ? {} : { terminalSeal }),
          },
        ],
        runtime: fixture.input.runtime,
      });
      return { bundle, keyset, proof };
    }),
  );
  const descriptors = prepared
    .map(({ bundle }) => bundle.descriptor)
    .sort((left, right) => left.bundleId.localeCompare(right.bundleId));
  const firstHead = createEncryptedWalletBackupV2CurrentHead({
    realm: fixture.input.keyHandle.realm,
    walletId: fixture.input.keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: 1,
    bundles: descriptors,
  });
  const secondHead = createEncryptedWalletBackupV2CurrentHead({
    realm: fixture.input.keyHandle.realm,
    walletId: fixture.input.keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: fixture.secondHeadVersion,
    bundles: descriptors,
  });
  const firstPages = enumerateEncryptedWalletBackupV2DescriptorPages({
    head: firstHead,
    bundles: descriptors,
  });
  const secondPages = enumerateEncryptedWalletBackupV2DescriptorPages({
    head: secondHead,
    bundles: descriptors,
  });
  const objects = new Map(
    prepared.flatMap(({ bundle }) =>
      bundle.objects.map((object) => [object.objectId, object] as const),
    ),
  );
  let headRead = 0;
  fixture.remote.readDescriptorPage.mockImplementation(async ({ afterBundleId }) => {
    if (afterBundleId === null) {
      headRead += 1;
      if (headRead === 2) await fixture.beforeSecondHead?.(fixture);
    }
    const pages = headRead <= 1 ? firstPages : secondPages;
    const page = pages.find((candidate) => candidate.afterBundleId === afterBundleId);
    if (page === undefined) throw new Error("test descriptor page is absent");
    return page;
  });
  const remoteSecrets = new Set(prepared.map(({ proof }) => proof.secret));
  const keysets = new Map(prepared.map(({ keyset }) => [keyset.id, keyset]));
  Object.assign(fixture.wallet, {
    getKeyset: (keysetId: string) => {
      const keyset = keysets.get(keysetId);
      if (keyset === undefined) throw new Error("browser V2 restore keyset is missing");
      return keyset;
    },
    checkProofsStates: vi.fn(async (proofs: readonly { readonly secret: string }[]) =>
      proofs.map(({ secret }) => ({
        Y: hashToCurve(new TextEncoder().encode(secret)).toHex(true),
        state: remoteSecrets.has(secret) ? ("UNSPENT" as const) : ("SPENT" as const),
        witness: null,
      })),
    ),
  });
  let objectRead = 0;
  vi.mocked(fixture.remote.readObject).mockImplementation(async ({ objectId }) => {
    objectRead += 1;
    if (options?.failOnObjectRead === objectRead) {
      throw new TypeError("network unavailable during descriptor hydration");
    }
    const object = objects.get(objectId);
    if (object === undefined) throw new Error("test remote object is absent");
    return object;
  });
}

async function issueRemoteTerminalSeal(
  fixture: Fixture,
  proofAsset: EncryptedWalletBackupV2ProofSetAsset,
  proof: Proof,
  locator: {
    readonly schemaVersion: 1;
    readonly kind: "nut13";
    readonly keysetId: string;
    readonly counter: number;
  },
) {
  if (proofAsset.kind !== "ctf") throw new Error("test terminal seal requires a CTF proof");
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: MINT,
    unit: "msat",
    asset: proofAsset,
  });
  const scope = {
    scopeKind: "wallet" as const,
    walletId: fixture.input.keyHandle.walletId,
    scopeId: fixture.scopeId,
  };
  const custody = new BrowserDurableCustodyAdapter(fixture.database);
  const owner = await custody.claimScope(scope, {
    incarnationId: "conflict-terminal-seal",
    observedAtMs: 10,
    leaseExpiresAtMs: 10_000,
  });
  const predecessor = createBrowserCustodyProofRow({
    scopeId: fixture.scopeId,
    normalizedMint: MINT,
    unit: "msat",
    proof,
    asset: {
      kind: "conditional",
      conditionId: proofAsset.conditionId,
      outcomeCollection: proofAsset.outcomeLabel,
    },
    receivedAtMs: 1,
  });
  await fixture.database.custodyProofs.put(predecessor);
  await fixture.database.custodyProofBackupAuthorities.put(
    createBrowserProofBackupAuthorityRow(predecessor, 10, locator, "admission:conflict-terminal"),
  );
  await fixture.database.custodyConditionalKeysets.put({
    schemaVersion: 1,
    scopeId: fixture.scopeId,
    normalizedMint: MINT,
    unit: "msat",
    keysetId: locator.keysetId,
    denominationPublicKeys: { "1": MINT_PUBLIC_KEY },
    inputFeePpk: 0,
    conditionId: proofAsset.conditionId,
    outcomeCollection: proofAsset.outcomeLabel,
    outcomeCollectionId: proofAsset.outcomeCollectionId,
    registeredAtUnixSeconds: proofAsset.registeredAt,
    finalExpiryUnixSeconds: proofAsset.finalExpiry,
    curve: "secp256k1",
  });
  await fixture.database.encryptedWalletBackupV2DesiredAssets.put(
    createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset,
      custodyRevision: 1n,
      activeProofCount: 1,
      terminalCtfContext: {
        conditionId: proofAsset.conditionId,
        outcomeLabel: proofAsset.outcomeLabel,
        outcomeCollectionId: proofAsset.outcomeCollectionId,
        registeredAt: proofAsset.registeredAt,
        finalExpiry: proofAsset.finalExpiry,
      },
    }),
  );
  const committed = await commitBrowserCtfTerminalOperation({
    adapter: custody,
    scope,
    owner,
    operationId: "ctf-redeem-conflict-terminal",
    mintUrl: MINT,
    proofs: [proof],
    predecessorProofs: [predecessor],
    publicKey: MINT_PUBLIC_KEY,
  });
  const record = await custody.readOperation(scope, committed.operationId);
  if (record === null) throw new Error("test terminal operation is absent");
  const terminalSeal = await issueEncryptedWalletBackupV2TerminalSeal({
    seed: fixture.input.seed,
    proof: { mintUrl: MINT, unit: "msat", asset: proofAsset, locator, proof },
    operationId: committed.operationId,
    store: {
      withCommittedTerminalRejection: async (_operationId, read) =>
        read({ record, exactRejection: committed.rejection, classifiedAtMs: 20 }),
    },
  });
  await Promise.all([
    fixture.database.custodyProofs.clear(),
    fixture.database.custodyProofBackupAuthorities.clear(),
    fixture.database.encryptedWalletBackupV2DesiredAssets.clear(),
    fixture.database.custodyConditionalKeysets.clear(),
    fixture.database.custodyOperations.clear(),
    fixture.database.custodyArtifacts.clear(),
    fixture.database.custodyReservations.clear(),
    fixture.database.custodyActiveWork.clear(),
    fixture.database.custodyScopes.clear(),
    fixture.database.walletCounterCursors.clear(),
    fixture.database.walletCounterAssociations.clear(),
    fixture.database.proofs.clear(),
  ]);
  return terminalSeal;
}

function fixtureProofAsset(fixture: Fixture): EncryptedWalletBackupV2ProofSetAsset {
  return fixture.conditionalAsset
    ? {
        kind: "ctf",
        conditionId: CONDITION_ID,
        outcomeLabel: OUTCOME_LABEL,
        outcomeCollectionId: OUTCOME_COLLECTION_ID,
        registeredAt: 1,
        finalExpiry: null,
      }
    : { kind: "ordinary" };
}

function fixtureKeysetId(asset: EncryptedWalletBackupV2ProofSetAsset): string {
  return fixtureKeyset(asset).keysetId;
}

function fixtureKeyset(asset: EncryptedWalletBackupV2ProofSetAsset): {
  readonly keysetId: string;
  readonly keyset: Keyset;
} {
  if (asset.kind === "ordinary") {
    const keyset = new Keyset(KEYSET, "msat", true, 0);
    keyset.keys = { 1: MINT_PUBLIC_KEY };
    return { keysetId: KEYSET, keyset };
  }
  const keysetId = deriveConditionalKeysetId({
    keys: { 1: MINT_PUBLIC_KEY },
    unit: "msat",
    input_fee_ppk: 0,
    ...(asset.finalExpiry === null ? {} : { final_expiry: asset.finalExpiry }),
    conditionId: asset.conditionId,
    outcomeCollectionId: asset.outcomeCollectionId,
  });
  const keyset = new Keyset(keysetId, "msat", true, 0, asset.finalExpiry ?? undefined, {
    conditionId: asset.conditionId,
    outcomeCollection: asset.outcomeLabel,
    outcomeCollectionId: asset.outcomeCollectionId,
    registeredAt: asset.registeredAt,
  });
  keyset.keys = { 1: MINT_PUBLIC_KEY };
  return { keysetId, keyset };
}

function states(
  proofs: readonly { readonly secret: string }[],
  state: ProofState["state"],
): ProofState[] {
  return proofs.map(({ secret }) => ({
    Y: hashToCurve(new TextEncoder().encode(secret)).toHex(true),
    state,
    witness: null,
  }));
}

function collected(head: ReturnType<typeof createEncryptedWalletBackupV2CurrentHead>) {
  return collectEncryptedWalletBackupV2DescriptorPages(
    enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles: [] }),
  );
}

function emptyPage(
  head: ReturnType<typeof createEncryptedWalletBackupV2CurrentHead>,
): EncryptedWalletBackupV2DescriptorPage {
  return enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles: [] })[0]!;
}

function immediateLockManager(): Pick<LockManager, "request"> {
  return {
    request: async <T>(_name: string, _options: LockOptions, callback: LockGrantedCallback<T>) =>
      callback(null),
  } as Pick<LockManager, "request">;
}
