// @vitest-environment node
import "fake-indexeddb/auto";
import { browserD4OracleEvidence } from "../../test/browserD4OracleFixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CheckStateEnum,
  hashToCurve,
  Keyset,
  MintOperationError,
  OutputData,
  type Proof,
  type ConditionalSwapOptions,
  type ConditionalSwapPreview,
} from "@cashu/cashu-ts";
import type { RedeemWallet } from "@bitcaster/client-sdk/ctfRedeem";
import {
  createBrowserRemoteProofBackupAuthorityRow,
  createBrowserProofBackupAuthorityRow,
} from "../../stores/browser-proof-backup-authority";
import { createBrowserCustodyProofRow } from "../../stores/durable-custody-db";
import { addProofsIfMissing } from "../../stores/proof-db";
import type { BitcasterDB, StoredProof } from "../../stores/proof-db";
import {
  conditionalKeysetIdFor,
  CONDITIONAL_KEYSET_ID,
  CONDITION,
  MINT,
  MINT_PUBLIC_KEY,
  OUTCOME,
  OUTCOME_ID,
  REGULAR_KEYSET,
  SEED,
  fixture,
  immediateLockManager,
  signOutputs,
} from "./fixtures/browserCtfRedeemFixture";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import { browserWalletScope } from "../browserCtfRangeOrderSource";
import type { BrowserEncryptedWalletBackupV2RuntimeDriver } from "../encryptedWalletBackupDriver";
import {
  receiveBrowserDurableWalletToken,
  type BrowserDurableWalletReceiveWallet,
} from "../browserDurableWalletReceive";

const mocks = vi.hoisted(() => ({
  database: null as BitcasterDB | null,
  scopeId: "scope",
  activeScopeId: "scope",
  claim: vi.fn(),
  remove: vi.fn(),
  driver: null as {
    removeManagedProofs: BrowserEncryptedWalletBackupV2RuntimeDriver["removeManagedProofs"];
  } | null,
  realCoordinatorEnabled: false,
  failNextRealCoordinatorCommit: false,
  beforeRealCoordinator: null as ((callIndex: number) => Promise<void>) | null,
  realCoordinatorCalls: [] as Array<{
    faultInjected: boolean;
    targetProofIds: readonly string[];
  }>,
  mintRejectCalls: 0,
  lock: vi.fn(),
  requireNewWritePermission: vi.fn(),
}));

vi.mock("../../stores/proof-db", async () => {
  const actual =
    await vi.importActual<typeof import("../../stores/proof-db")>("../../stores/proof-db");
  return {
    ...actual,
    get db() {
      if (mocks.database === null) throw new Error("portfolio remove test database is missing");
      return mocks.database;
    },
  };
});
vi.mock("../browserWalletProfile", async () => {
  const actual =
    await vi.importActual<typeof import("../browserWalletProfile")>("../browserWalletProfile");
  return { ...actual, activeBrowserWalletScopeId: () => mocks.activeScopeId };
});
vi.mock("../walletProfileLock", () => ({
  withWalletProfileLock: mocks.lock,
}));
vi.mock("../bip39", () => ({ toSeed: () => SEED }));
vi.mock("../../stores/wallet", () => ({
  useWalletStore: { getState: () => ({ mnemonic: "test wallet" }) },
}));
vi.mock("../browserPortfolioClaim", () => ({
  claimPortfolioPosition: mocks.claim,
}));
vi.mock("../browserWalletNewWritePermission", async () => {
  const actual = await vi.importActual<typeof import("../browserWalletNewWritePermission")>(
    "../browserWalletNewWritePermission",
  );
  return {
    ...actual,
    requireBrowserWalletNewWritePermission: (
      input: Parameters<typeof actual.requireBrowserWalletNewWritePermission>[0],
    ) =>
      mocks.realCoordinatorEnabled
        ? actual.requireBrowserWalletNewWritePermission(input)
        : mocks.requireNewWritePermission(input),
  };
});
vi.mock("../browserCtfRemoveCoordinator", async () => {
  const actual = await vi.importActual<typeof import("../browserCtfRemoveCoordinator")>(
    "../browserCtfRemoveCoordinator",
  );
  return {
    ...actual,
    startBrowserCtfRemove: async (input: Parameters<typeof actual.startBrowserCtfRemove>[0]) => {
      if (!mocks.realCoordinatorEnabled) return mocks.remove(input);

      const callIndex = mocks.realCoordinatorCalls.length;
      const faultInjected = mocks.failNextRealCoordinatorCommit;
      mocks.failNextRealCoordinatorCommit = false;
      mocks.realCoordinatorCalls.push({
        faultInjected,
        targetProofIds: input.targets.map(({ proofId }) => proofId),
      });
      await mocks.beforeRealCoordinator?.(callIndex);
      return actual.startBrowserCtfRemove(
        faultInjected ? { ...input, fault: "before-commit" } : input,
      );
    },
  };
});
vi.mock("../encryptedWalletBackupDriver", async () => {
  const actual = await vi.importActual<typeof import("../encryptedWalletBackupDriver")>(
    "../encryptedWalletBackupDriver",
  );
  return {
    ...actual,
    activeBrowserEncryptedWalletBackupV2RuntimeDriver: () => mocks.driver,
  };
});

import { removePortfolioPosition } from "../browserPortfolioRemove";
import { claimBrowserCanonicalCtfPosition } from "../browserCtfPositionClaim";

const position = {
  mintUrl: MINT,
  conditionId: CONDITION,
  outcomeCollection: OUTCOME,
};

const unverifiedOracleEvidence = {
  status: "unverified" as const,
  reason: "unavailable" as const,
  warning:
    "The mint reports this outcome, but we have not verified evidence from the intended oracle.",
};
const verifiedOracleEvidence = { status: "verified" as const };

const databases: BitcasterDB[] = [];
const databasesToDelete = new Set<BitcasterDB>();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.database = null;
  mocks.activeScopeId = mocks.scopeId;
  mocks.driver = null;
  mocks.realCoordinatorEnabled = false;
  mocks.failNextRealCoordinatorCommit = false;
  mocks.beforeRealCoordinator = null;
  mocks.realCoordinatorCalls = [];
  mocks.mintRejectCalls = 0;
  mocks.requireNewWritePermission.mockResolvedValue(undefined);
  mocks.lock.mockImplementation(async (_scopeId: string, action: () => Promise<unknown>) =>
    action(),
  );
  mocks.claim.mockResolvedValue({
    kind: "completed",
    committedPayoutAmount: 0,
    committedLegs: 0,
    losingLegs: 1,
    pendingLegs: 0,
    error: null,
  });
  mocks.remove.mockResolvedValue({ kind: "completed", intentId: "completed-local-removal" });
});

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const database of databasesToDelete) await database.delete();
  databasesToDelete.clear();
});

async function useFixture(
  amounts: readonly number[] = [13015],
  options: { counterSource?: "memory" | "browser"; databaseName?: string } = {},
) {
  const entry = await fixture({ amounts, ...options });
  databases.push(entry.database);
  mocks.database = entry.database;
  mocks.scopeId = entry.scope.scopeId;
  mocks.activeScopeId = entry.scope.scopeId;
  return entry;
}

async function makeManaged(entry: Awaited<ReturnType<typeof fixture>>, index = 0) {
  const proof = entry.proofs[index]!;
  await entry.database.custodyProofBackupAuthorities.put(
    createBrowserRemoteProofBackupAuthorityRow({
      proof,
      observedAtMs: 2,
      derivationLocator: null,
      restoreProofId: proof.proofId,
      restoreProofCommitment: "22".repeat(32),
    }),
  );
}

function expectSafeRemoveFailure(
  failure: unknown,
  stage: "capture" | "claim" | "managed-backup-removal" | "local-commit",
) {
  expect(failure).toMatchObject({
    code: "remove-failed",
    stage,
    attemptRef: expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    ),
  });
  expect(failure).not.toHaveProperty("message");
}

function losingWallet(): RedeemWallet {
  return {
    loadMint: async () => undefined,
    checkProofsStates: async (inputs) =>
      inputs.map((input) => ({
        Y: hashToCurve(new TextEncoder().encode(input.secret)).toHex(true),
        state: CheckStateEnum.UNSPENT,
        witness: null,
      })),
    redeemOutcomeProofs: async () => {
      mocks.mintRejectCalls += 1;
      throw new MintOperationError(13015, "Oracle has not attested to this outcome collection");
    },
  };
}

function runLosingClaim(
  entry: Awaited<ReturnType<typeof fixture>>,
  targets: readonly unknown[],
  owner = entry.owner,
  observedAtMs = 5,
) {
  const oracle = browserD4OracleEvidence(entry.scope.scopeId, MINT);
  return claimBrowserCanonicalCtfPosition({
    position: { conditionId: CONDITION, outcomeCollection: OUTCOME },
    targets: targets as never,
    stopOnCommittedPayout: true,
    walletProfileLockHeld: true,
    context: {
      seed: SEED,
      mintUrl: MINT,
      prepareNewLegAuthority: async () => ({
        regularKeyset: REGULAR_KEYSET,
        oracleWitness: oracle.canonicalOracleWitness,
        oracleResolutionContext: oracle.context,
        oracleEvidence: verifiedOracleEvidence,
      }),
      counterSource: entry.counters,
      database: entry.database,
      adapter: entry.adapter,
      owner,
      wallet: losingWallet(),
      restoreOutputs: async (_mintUrl, outputs) => ({
        regular: signOutputs(outputs.regular as never),
      }),
      observedAtMs,
      lockManager: immediateLockManager,
    },
  });
}

function conditionalReceiveWallet(): BrowserDurableWalletReceiveWallet {
  const conditionalMetadata = {
    conditionId: CONDITION,
    outcomeCollection: OUTCOME,
    outcomeCollectionId: OUTCOME_ID,
    registeredAt: 0,
  };
  const conditionalKeyset = Keyset.fromMintApi(
    {
      id: CONDITIONAL_KEYSET_ID,
      unit: "msat",
      active: true,
      input_fee_ppk: 0,
      conditional: conditionalMetadata,
    },
    {
      id: CONDITIONAL_KEYSET_ID,
      unit: "msat",
      active: true,
      input_fee_ppk: 0,
      keys: { "1": MINT_PUBLIC_KEY },
      conditional: conditionalMetadata,
    },
  );

  return {
    prepareSwapToReceive: async () => {
      throw new Error("unexpected regular receive in conditional claim regression");
    },
    completeSwap: async () => {
      throw new Error("unexpected regular receive in conditional claim regression");
    },
    prepareConditionalSwap: async ({ keysetId, inputs, outputs }: ConditionalSwapOptions) => ({
      keysetId: keysetId ?? inputs[0]!.id,
      inputs: inputs as Proof[],
      outputDataByLabel: Object.fromEntries(
        outputs.map((group) => [group.label, group.kind === "custom" ? [...group.data] : []]),
      ),
    }),
    completeConditionalSwap: async (preview: ConditionalSwapPreview) => ({
      receive: signOutputs(preview.outputDataByLabel.receive ?? []),
    }),
    checkProofsStates: async (proofs) =>
      proofs.map(({ secret }) => ({
        Y: hashToCurve(new TextEncoder().encode(secret)).toHex(true),
        state: CheckStateEnum.UNSPENT,
        witness: null,
      })),
    keyChain: {
      loadConditionalKeyset: async () => conditionalKeyset,
      registerConditionalKeyset: () => conditionalKeyset,
    },
    getKeyset: () => conditionalKeyset,
    mint: { restore: async () => ({ outputs: [], signatures: [] }) },
  };
}

describe("Portfolio remove entry point", () => {
  it("reports capture failures with a redacted stage and attempt reference", async () => {
    await useFixture();
    const sentinel = "raw-proof-seed-backup-sentinel";
    mocks.lock.mockRejectedValue(new Error(sentinel));

    const result = await removePortfolioPosition(position);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected a removal error");
    expectSafeRemoveFailure(result.error, "capture");
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it("captures canonical selectable proof identities before removing a 13015 proof", async () => {
    const entry = await useFixture([1]);
    const onCommittedLeg = vi.fn();
    const otherMint = await createBrowserCustodyProofRow({
      scopeId: entry.scope.scopeId,
      normalizedMint: "https://other.example",
      unit: "msat",
      proof: {
        id: conditionalKeysetIdFor(9),
        amount: 3 as never,
        secret: "other-mint-proof",
        C: MINT_PUBLIC_KEY,
      },
      asset: { kind: "conditional", conditionId: CONDITION, outcomeCollection: OUTCOME },
      receivedAtMs: 2,
    });
    await entry.database.custodyProofs.put(otherMint);
    await entry.database.custodyProofBackupAuthorities.put(
      createBrowserProofBackupAuthorityRow(otherMint, 2, null, "other-mint-receive"),
    );
    mocks.claim.mockImplementation(async ({ targets }: { targets: readonly unknown[] }) =>
      runLosingClaim(entry, targets),
    );

    await expect(removePortfolioPosition({ ...position, onCommittedLeg })).resolves.toMatchObject({
      kind: "completed",
    });

    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [
          expect.objectContaining({
            proofId: entry.proof.proofId,
            revision: entry.proof.revision,
            proofFingerprint: entry.proof.proofFingerprint,
          }),
        ],
        stopOnCommittedPayout: true,
        onCommittedLeg,
      }),
    );
    expect(mocks.remove).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [
          {
            proofId: entry.proof.proofId,
            proofFingerprint: entry.proof.proofFingerprint,
            proofRevision: entry.proof.revision + 2,
          },
        ],
      }),
    );
  });

  it("accepts the real selectable-to-13015 terminal revision before local removal", async () => {
    const entry = await useFixture([1]);
    mocks.claim.mockImplementation(async ({ targets }: { targets: readonly unknown[] }) =>
      runLosingClaim(entry, targets),
    );

    const result = await removePortfolioPosition(position);
    expect(result).toEqual({
      kind: "completed",
      committedPayoutAmount: 0,
      oracleEvidence: verifiedOracleEvidence,
    });
    const retained = await entry.adapter.readProof(entry.scope.scopeId, entry.proof.proofId);
    expect(retained?.selectability).toBe("verified-losing");
    expect(retained?.revision).toBe(entry.proof.revision + 2);
    expect(mocks.remove).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [
          {
            proofId: entry.proof.proofId,
            proofFingerprint: entry.proof.proofFingerprint,
            proofRevision: entry.proof.revision + 2,
          },
        ],
      }),
    );
  });

  it.each([1, 8])(
    "terminalizes a losing claim after a real conditional receive with acknowledged backup intent (%i outputs)",
    async (proofCount) => {
      const databaseName = browserWalletDatabaseName(browserWalletScope(SEED).scopeId);
      const entry = await useFixture([1], {
        databaseName,
      });
      databasesToDelete.add(entry.database);
      await entry.adapter.releaseScope(entry.scope, { ...entry.owner, observedAtMs: 4 });
      await entry.database.custodyProofs.clear();
      await entry.database.custodyProofBackupAuthorities.clear();
      await entry.database.proofs.clear();
      await entry.database.walletCounterAssociations.put({
        scopeId: entry.scope.scopeId,
        normalizedMint: MINT,
        unit: "msat",
        keysetId: CONDITIONAL_KEYSET_ID,
        recoveryComplete: true,
      });

      const inputProofs = Array.from(
        { length: proofCount },
        (_, index) =>
          signOutputs([
            OutputData.createSingleData(
              1,
              CONDITIONAL_KEYSET_ID,
              `claim-regression-input-${index}`,
              BigInt(27 + index),
            ),
          ])[0]!,
      );
      const wallet = conditionalReceiveWallet();
      let time = 1_000;
      let nextId = 0;
      const received = await receiveBrowserDurableWalletToken({
        token: "cashuB-conditional-token",
        mintUrl: MINT,
        unit: "msat",
        asset: "conditional",
        conditionalInputProofs: inputProofs,
        ensureConditionalCounterReady: async () => undefined,
        wallet,
        context: {
          seed: entry.seed,
          database: entry.database,
          now: () => ++time,
          randomId: () => `claim-regression-${++nextId}`,
          lockManager: immediateLockManager,
          requireCapturedProfile: () => undefined,
        },
      });

      await addProofsIfMissing(
        received.map(
          (proof): StoredProof => ({
            ...proof,
            mintUrl: MINT,
            baseAsset: "sat",
            unit: "msat",
            conditionId: CONDITION,
            outcomeCollection: OUTCOME,
            marketId: `${CONDITION}-${OUTCOME}`,
          }),
        ),
        entry.database,
      );

      expect(received).toHaveLength(proofCount);
      const legacyProofs = await entry.database.proofs.toArray();
      expect(legacyProofs).toHaveLength(received.length);
      expect(
        legacyProofs.every(
          ({ conditionId, outcomeCollection, marketId }) =>
            conditionId === CONDITION &&
            outcomeCollection === OUTCOME &&
            marketId === `${CONDITION}-${OUTCOME}`,
        ),
      ).toBe(true);
      // Model legacy counter-recovered rows that predate conditional metadata.
      // The durable custody rows remain the canonical source for reconciliation.
      for (const legacyProof of legacyProofs) {
        const legacyProofWithoutConditionalMetadata = { ...legacyProof };
        delete legacyProofWithoutConditionalMetadata.conditionId;
        delete legacyProofWithoutConditionalMetadata.outcomeCollection;
        await entry.database.proofs.put(legacyProofWithoutConditionalMetadata);
      }
      const receivedRows = await entry.database.custodyProofs.toArray();
      expect(receivedRows).toHaveLength(received.length);
      const receiveOperations = await entry.database.custodyOperations.toArray();
      const receiveOperation = receiveOperations.find(
        ({ record }) => record.operation.semanticKind === "generic-receive",
      );
      if (!receiveOperation) throw new Error("conditional receive operation was not persisted");
      const authorities = await entry.database.custodyProofBackupAuthorities.toArray();
      expect(authorities).toHaveLength(receivedRows.length);
      for (const authority of authorities) {
        expect(authority).toMatchObject({
          backupState: "local-only",
          admissionOperationId: receiveOperation.operationId,
          derivationLocator: {
            kind: "nut13",
            keysetId: CONDITIONAL_KEYSET_ID,
          },
        });
      }

      const desiredRows = await entry.database.encryptedWalletBackupV2DesiredAssets.toArray();
      expect(desiredRows).toHaveLength(1);
      expect(desiredRows[0]).toMatchObject({
        activeProofCount: receivedRows.length,
        desiredAction: "replace",
        syncState: "pending",
      });
      await entry.database.encryptedWalletBackupV2DesiredAssets.put({
        ...desiredRows[0]!,
        syncState: "acknowledged",
      });

      const owner = await entry.adapter.claimScope(entry.scope, {
        incarnationId: "claim-after-conditional-receive",
        observedAtMs: 3_000,
        leaseExpiresAtMs: 100_000,
      });
      const result = await runLosingClaim(
        entry,
        receivedRows.map(({ proofId, revision, proofFingerprint }) => ({
          proofId,
          revision,
          proofFingerprint,
        })),
        owner,
        3_001,
      );

      const operations = await entry.database.custodyOperations.toArray();
      const claimOperations = operations.filter(
        ({ record }) => record.operation.semanticKind === "ctf-redeem",
      );
      const claimOperation = claimOperations[0]?.record.operation;
      const proofsAfterClaim = await entry.database.custodyProofs.toArray();
      const desiredAfterClaim = await entry.database.encryptedWalletBackupV2DesiredAssets.toArray();
      const legacyProofsAfterClaim = await entry.database.proofs.toArray();
      expect({
        resultKind: result.kind,
        resultErrorCategory: result.kind === "error" ? result.error.category : null,
        claimOperationCount: claimOperations.length,
        claimOperationState: claimOperation?.state ?? "missing",
        claimResultState: claimOperation?.result.state ?? "missing",
        hasTerminalMintRejection:
          claimOperation?.terminalMintRejection !== null &&
          claimOperation?.terminalMintRejection !== undefined,
        proofStates: proofsAfterClaim.map(({ selectability }) => selectability),
        terminalLegacyProofs: legacyProofsAfterClaim.map(
          ({ conditionId, outcomeCollection, terminalOperationId, marketId }) => ({
            conditionId,
            outcomeCollection,
            terminalOperationId,
            marketId,
          }),
        ),
        desiredSyncState: desiredAfterClaim[0]?.syncState ?? "missing",
      }).toEqual({
        resultKind: "completed",
        resultErrorCategory: null,
        claimOperationCount: 1,
        claimOperationState: "aborted",
        claimResultState: "none",
        hasTerminalMintRejection: true,
        proofStates: receivedRows.map(() => "verified-losing"),
        terminalLegacyProofs: legacyProofs.map(() => ({
          conditionId: CONDITION,
          outcomeCollection: OUTCOME,
          terminalOperationId: claimOperation?.operationId,
          marketId: `${CONDITION}-${OUTCOME}`,
        })),
        desiredSyncState: "pending",
      });
    },
  );

  it("retains a 13015 proof after local commit refusal and retries without removing a new arrival", async () => {
    const entry = await useFixture([1], {
      databaseName: browserWalletDatabaseName(browserWalletScope(SEED).scopeId),
    });
    mocks.claim.mockImplementation(async ({ targets }: { targets: readonly unknown[] }) => ({
      ...(await runLosingClaim(entry, targets)),
      oracleEvidence: verifiedOracleEvidence,
    }));
    mocks.realCoordinatorEnabled = true;
    mocks.failNextRealCoordinatorCommit = true;

    const first = await removePortfolioPosition({ ...position, observedAtMs: 6 });

    expect(first).toMatchObject({
      oracleEvidence: verifiedOracleEvidence,
      kind: "partial",
      reason: "local-removal-error",
      committedPayoutAmount: 0,
      error: { code: "remove-failed" },
    });
    if (first.kind !== "partial" || first.error === null) {
      throw new Error("expected a local commit diagnostic");
    }
    expectSafeRemoveFailure(first.error, "local-commit");
    expect(JSON.stringify(first)).not.toContain(entry.proof.proofId);
    expect(JSON.stringify(first)).not.toContain(entry.proof.proofFingerprint);
    const retained = await entry.adapter.readProof(entry.scope.scopeId, entry.proof.proofId);
    expect(retained).toMatchObject({
      proofId: entry.proof.proofId,
      proofFingerprint: entry.proof.proofFingerprint,
      revision: entry.proof.revision + 2,
      selectability: "verified-losing",
    });
    expect(mocks.mintRejectCalls).toBe(1);

    const arrivingProof: {
      value: Awaited<ReturnType<typeof createBrowserCustodyProofRow>> | null;
    } = { value: null };
    mocks.beforeRealCoordinator = async (callIndex) => {
      if (callIndex !== 1) return;
      const arriving = await createBrowserCustodyProofRow({
        scopeId: entry.scope.scopeId,
        normalizedMint: MINT,
        unit: "msat",
        proof: {
          id: conditionalKeysetIdFor(3),
          amount: 99 as never,
          secret: "arriving-proof-during-retry",
          C: MINT_PUBLIC_KEY,
        },
        asset: { kind: "conditional", conditionId: CONDITION, outcomeCollection: OUTCOME },
        receivedAtMs: 7,
      });
      arrivingProof.value = arriving;
      await entry.database.custodyProofs.put(arriving);
      await entry.database.custodyProofBackupAuthorities.put(
        createBrowserProofBackupAuthorityRow(arriving, 8, null, "ctf-arrival"),
      );
    };

    await expect(removePortfolioPosition({ ...position, observedAtMs: 9 })).resolves.toEqual({
      kind: "completed",
      committedPayoutAmount: 0,
    });

    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(mocks.mintRejectCalls).toBe(1);
    expect(mocks.realCoordinatorCalls).toEqual([
      { faultInjected: true, targetProofIds: [entry.proof.proofId] },
      { faultInjected: false, targetProofIds: [entry.proof.proofId] },
    ]);
    expect(await entry.adapter.readProof(entry.scope.scopeId, entry.proof.proofId)).toBeNull();
    expect(
      await entry.database.custodyProofBackupAuthorities.get([
        entry.scope.scopeId,
        entry.proof.proofId,
      ]),
    ).toMatchObject({ recordKind: "completed-local-removal" });
    const arriving = await entry.database.custodyProofs
      .where("[scopeId+conditionId+outcomeCollection+selectability]")
      .equals([entry.scope.scopeId, CONDITION, OUTCOME, "selectable"])
      .first();
    const expectedArrival = arrivingProof.value;
    if (expectedArrival === null) throw new Error("test arrival was not created");
    expect(arriving).toMatchObject({
      proofId: expectedArrival.proofId,
      proofFingerprint: expectedArrival.proofFingerprint,
      revision: expectedArrival.revision,
      selectability: "selectable",
    });
  });

  it("retains exact proofs when canonical claim recovery is pending", async () => {
    await useFixture();
    mocks.claim.mockResolvedValue({
      oracleEvidence: unverifiedOracleEvidence,
      kind: "pending",
      committedPayoutAmount: 0,
      committedLegs: 0,
      losingLegs: 0,
      pendingLegs: 1,
      reason: "mint-response-pending",
      error: null,
    });

    await expect(removePortfolioPosition(position)).resolves.toEqual({
      oracleEvidence: unverifiedOracleEvidence,
      kind: "pending",
      reason: "claim-pending",
      committedPayoutAmount: 0,
    });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("preserves safe Claim failure metadata and committed payouts through removal composition", async () => {
    const entry = await useFixture();
    const claimFailure = {
      code: "claim-failed" as const,
      category: "counter-readiness" as const,
      message: "Wallet counter recovery is incomplete for the selected keyset.",
      attemptRef: "claim-attempt-789",
    };
    mocks.claim.mockResolvedValue({
      oracleEvidence: unverifiedOracleEvidence,
      kind: "error",
      committedPayoutAmount: 9,
      committedLegs: 1,
      losingLegs: 0,
      pendingLegs: 0,
      error: claimFailure,
    });

    const result = await removePortfolioPosition(position);

    expect(result).toMatchObject({
      kind: "error",
      committedPayoutAmount: 9,
      oracleEvidence: unverifiedOracleEvidence,
    });
    if (result.kind !== "error") throw new Error("expected a composed claim diagnostic");
    expectSafeRemoveFailure(result.error, "claim");
    expect(result.error.claimFailure).toEqual({
      code: "claim-failed",
      category: "counter-readiness",
      attemptRef: claimFailure.attemptRef,
    });
    expect(JSON.stringify(result)).not.toContain(claimFailure.message);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(
      (await entry.adapter.readProof(entry.scope.scopeId, entry.proof.proofId))?.selectability,
    ).toBe("selectable");
  });

  it("stops removal after a stale display discovers a committed winning payout", async () => {
    await useFixture();
    mocks.claim.mockResolvedValue({
      oracleEvidence: unverifiedOracleEvidence,
      kind: "stopped",
      committedPayoutAmount: 13015,
      committedLegs: 1,
      losingLegs: 0,
      pendingLegs: 0,
      reason: "winning-payout",
      error: null,
    });

    await expect(removePortfolioPosition(position)).resolves.toEqual({
      oracleEvidence: unverifiedOracleEvidence,
      kind: "stopped",
      reason: "winning-payout",
      committedPayoutAmount: 13015,
    });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("keeps local-only proofs when managed removal is pending", async () => {
    const entry = await useFixture([1, 2]);
    await makeManaged(entry, 0);
    mocks.driver = {
      removeManagedProofs: vi.fn().mockResolvedValue({ kind: "started", intentId: "intent" }),
    };
    mocks.claim.mockImplementation(async ({ targets }: { targets: readonly unknown[] }) => ({
      ...(await runLosingClaim(entry, targets)),
      oracleEvidence: verifiedOracleEvidence,
    }));

    await expect(removePortfolioPosition(position)).resolves.toEqual({
      oracleEvidence: verifiedOracleEvidence,
      kind: "pending",
      reason: "managed-removal-pending",
      committedPayoutAmount: 0,
    });
    expect(mocks.driver.removeManagedProofs).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [
          {
            proofId: entry.proofs[0]!.proofId,
            proofFingerprint: entry.proofs[0]!.proofFingerprint,
            proofRevision: entry.proofs[0]!.revision + 2,
          },
        ],
      }),
    );
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("reports managed-backup refusal without exposing the driver error", async () => {
    const entry = await useFixture([1]);
    await makeManaged(entry);
    mocks.claim.mockImplementation(async ({ targets }: { targets: readonly unknown[] }) => ({
      ...(await runLosingClaim(entry, targets)),
      oracleEvidence: verifiedOracleEvidence,
    }));
    const sentinel = "raw-managed-backup-body-proof-secret";
    mocks.driver = {
      removeManagedProofs: vi.fn().mockRejectedValue(new Error(sentinel)),
    };

    const result = await removePortfolioPosition(position);

    expect(result.kind).toBe("error");
    expect(result.oracleEvidence).toEqual(verifiedOracleEvidence);
    if (result.kind !== "error") throw new Error("expected a managed removal diagnostic");
    expectSafeRemoveFailure(result.error, "managed-backup-removal");
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(JSON.stringify(result)).not.toContain(entry.proof.proofId);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("passes the exact local subset once with managed removal and excludes a new arrival", async () => {
    const entry = await useFixture([1, 2]);
    await makeManaged(entry, 0);
    const removeManagedProofs = vi
      .fn<BrowserEncryptedWalletBackupV2RuntimeDriver["removeManagedProofs"]>()
      .mockResolvedValue({ kind: "started", intentId: "pending" });
    mocks.driver = {
      removeManagedProofs,
    };
    mocks.claim.mockImplementation(async ({ targets }: { targets: readonly unknown[] }) => {
      const result = await runLosingClaim(entry, targets);
      const arriving = await createBrowserCustodyProofRow({
        scopeId: entry.scope.scopeId,
        normalizedMint: MINT,
        unit: "msat",
        proof: {
          id: conditionalKeysetIdFor(3),
          amount: 99 as never,
          secret: "arriving-proof",
          C: MINT_PUBLIC_KEY,
        },
        asset: { kind: "conditional", conditionId: CONDITION, outcomeCollection: OUTCOME },
        receivedAtMs: 4,
      });
      await entry.database.custodyProofs.put(arriving);
      await entry.database.custodyProofBackupAuthorities.put(
        createBrowserProofBackupAuthorityRow(arriving, 5, null, "ctf-arrival"),
      );
      return result;
    });

    await expect(removePortfolioPosition(position)).resolves.toMatchObject({
      kind: "pending",
      reason: "managed-removal-pending",
    });
    expect(mocks.driver.removeManagedProofs).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [
          {
            proofId: entry.proofs[0]!.proofId,
            proofFingerprint: entry.proofs[0]!.proofFingerprint,
            proofRevision: entry.proofs[0]!.revision + 2,
          },
        ],
        localTargets: [
          {
            proofId: entry.proofs[1]!.proofId,
            proofFingerprint: entry.proofs[1]!.proofFingerprint,
            proofRevision: entry.proofs[1]!.revision + 2,
          },
        ],
      }),
    );
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(
      await entry.database.custodyProofs.get([entry.scope.scopeId, entry.proofs[1]!.proofId]),
    ).toMatchObject({ selectability: "verified-losing" });
    expect(removeManagedProofs.mock.calls[0]![0].targets).not.toContainEqual(
      expect.objectContaining({ proofId: "arriving-proof" }),
    );
  });

  it("chunks a large exact local removal into bounded coordinator operations", async () => {
    await useFixture(Array.from({ length: 513 }, () => 1));

    await expect(removePortfolioPosition(position)).resolves.toEqual({
      kind: "completed",
      committedPayoutAmount: 0,
    });
    expect(mocks.remove).toHaveBeenCalledTimes(2);
    expect(mocks.remove.mock.calls[0]![0].targets).toHaveLength(512);
    expect(mocks.remove.mock.calls[1]![0].targets).toHaveLength(1);
  }, 15_000);

  it("refuses a proof revision or body race after claim terminalization", async () => {
    const entry = await useFixture();
    mocks.claim.mockImplementation(async () => {
      const current = await entry.database.custodyProofs.get([
        entry.scope.scopeId,
        entry.proof.proofId,
      ]);
      if (!current) throw new Error("test proof disappeared");
      await entry.database.custodyProofs.put({
        ...current,
        revision: current.revision + 1,
        proofFingerprint: "ff".repeat(32),
      });
      return {
        kind: "completed",
        oracleEvidence: verifiedOracleEvidence,
        committedPayoutAmount: 0,
        committedLegs: 0,
        losingLegs: 1,
        pendingLegs: 0,
        error: null,
      };
    });

    await expect(removePortfolioPosition(position)).resolves.toMatchObject({
      kind: "error",
      oracleEvidence: verifiedOracleEvidence,
    });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
