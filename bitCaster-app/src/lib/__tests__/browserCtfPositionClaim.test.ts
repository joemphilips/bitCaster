// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CheckStateEnum,
  MintOperationError,
  deriveKeysetId,
  hashToCurve,
  type CounterSource,
  type MintKeys,
  type OutputData,
} from "@cashu/cashu-ts";
import type { RedeemWallet } from "@bitcaster/client-sdk/ctfRedeem";
import { createBrowserProofBackupAuthorityRow } from "../../stores/browser-proof-backup-authority";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
} from "../../stores/durable-custody-db";
import { BitcasterDB } from "../../stores/proof-db";
import { readCanonicalPortfolioCustody } from "../../stores/portfolio-custody";
import {
  claimBrowserCanonicalCtfPosition,
  type BrowserCanonicalCtfPositionClaimContext,
} from "../browserCtfPositionClaim";
import { markBrowserCanonicalCtfRedeemTransportAttempted } from "../browserCtfRedeemCoordinator";
import {
  CONDITION,
  MINT,
  MINT_PUBLIC_KEY,
  OUTCOME,
  REGULAR_KEYSET,
  SEED,
  fixture,
  immediateLockManager,
  disposeFixtures,
  signedPayout,
  signOutputs,
} from "./fixtures/browserCtfRedeemFixture";

const mocks = vi.hoisted(() => ({ requireNewWritePermission: vi.fn() }));

vi.mock("../browserWalletNewWritePermission", () => ({
  requireBrowserWalletNewWritePermission: mocks.requireNewWritePermission,
}));

beforeEach(() => {
  mocks.requireNewWritePermission.mockReset();
  mocks.requireNewWritePermission.mockResolvedValue(undefined);
});

afterEach(async () => {
  await disposeFixtures();
});

function winningWallet(): RedeemWallet {
  return {
    loadMint: async () => undefined,
    checkProofsStates: async (inputs) =>
      inputs.map((input) => ({
        Y: hashToCurve(new TextEncoder().encode(input.secret)).toHex(true),
        state: CheckStateEnum.UNSPENT,
        witness: null,
      })),
    redeemOutcomeProofs: async ({ outputs }) => signOutputs(outputs as OutputData[]),
  };
}

type ClaimFixtureState = Pick<
  Awaited<ReturnType<typeof fixture>>,
  "database" | "adapter" | "owner" | "counters"
>;

type NewLegAuthority = {
  readonly regularKeyset: MintKeys;
  readonly oracleWitness: string;
};

function context(
  entry: ClaimFixtureState,
  wallet: RedeemWallet = winningWallet(),
  options: {
    readonly prepareNewLegAuthority?: () => Promise<NewLegAuthority>;
    readonly restoreOutputs?: BrowserCanonicalCtfPositionClaimContext["restoreOutputs"];
  } = {},
): BrowserCanonicalCtfPositionClaimContext {
  return {
    seed: SEED,
    mintUrl: MINT,
    prepareNewLegAuthority:
      options.prepareNewLegAuthority ??
      (async () => ({ regularKeyset: REGULAR_KEYSET, oracleWitness: '{"oracle_sig":"test"}' })),
    counterSource: entry.counters,
    database: entry.database,
    adapter: entry.adapter,
    owner: entry.owner,
    wallet,
    restoreOutputs:
      options.restoreOutputs ??
      (async (_mintUrl, outputs) => ({
        regular: signOutputs(outputs.regular as unknown as OutputData[]),
      })),
    observedAtMs: 5,
    lockManager: immediateLockManager,
  };
}

describe("browser canonical CTF position claim", () => {
  it("recovers a persisted request while fresh attestation preparation is unavailable", async () => {
    const entry = await fixture();
    const record = await entry.bind();
    const prepareNewLegAuthority = vi.fn(async () => {
      throw new Error("fresh engine attestation is unavailable");
    });

    const result = await claimBrowserCanonicalCtfPosition({
      position: { conditionId: CONDITION, outcomeCollection: OUTCOME },
      context: context(entry, winningWallet(), { prepareNewLegAuthority }),
    });

    expect(result).toMatchObject({ kind: "completed", committedPayoutAmount: 1 });
    expect(prepareNewLegAuthority).not.toHaveBeenCalled();
    expect(
      (await entry.adapter.readOperation(entry.scope, record.operation.operationId))?.operation
        .result.state,
    ).toBe("applied");
  });

  it("restores with the operation's persisted keyset after the current keyset rotates", async () => {
    const entry = await fixture();
    const record = await entry.bind();
    const payout = await signedPayout(entry.adapter, entry.scope, record.operation.operationId);
    await markBrowserCanonicalCtfRedeemTransportAttempted({
      seed: SEED,
      operationId: record.operation.operationId,
      adapter: entry.adapter,
      owner: { ...entry.owner, observedAtMs: 4 },
    });
    const rotatedKeyset: MintKeys = {
      ...REGULAR_KEYSET,
      id: deriveKeysetId(REGULAR_KEYSET.keys, {
        unit: "msat",
        input_fee_ppk: 1,
        versionByte: 1,
      }),
      input_fee_ppk: 1,
    };
    const prepareNewLegAuthority = vi.fn(async () => ({
      regularKeyset: rotatedKeyset,
      oracleWitness: '{"oracle_sig":"rotated"}',
    }));
    let restoreKeysetId: string | undefined;
    const wallet: RedeemWallet = {
      ...winningWallet(),
      checkProofsStates: async (inputs) =>
        inputs.map((input) => ({
          Y: hashToCurve(new TextEncoder().encode(input.secret)).toHex(true),
          state: CheckStateEnum.SPENT,
          witness: null,
        })),
    };

    const result = await claimBrowserCanonicalCtfPosition({
      position: { conditionId: CONDITION, outcomeCollection: OUTCOME },
      context: context(entry, wallet, {
        prepareNewLegAuthority,
        restoreOutputs: async (_mintUrl, outputs, keyset) => {
          expect(outputs.regular).toHaveLength(1);
          restoreKeysetId = keyset.id;
          return { regular: payout };
        },
      }),
    });

    expect(result).toMatchObject({ kind: "completed", committedPayoutAmount: 1 });
    expect(restoreKeysetId).toBe(REGULAR_KEYSET.id);
    expect(restoreKeysetId).not.toBe(rotatedKeyset.id);
    expect(prepareNewLegAuthority).not.toHaveBeenCalled();
  });

  it("prepares once when several new legs need binding", async () => {
    const entry = await fixture({ amounts: [1, 2] });
    const prepareNewLegAuthority = vi.fn(async () => ({
      regularKeyset: REGULAR_KEYSET,
      oracleWitness: '{"oracle_sig":"prepared"}',
    }));
    let redeemCalls = 0;
    const wallet: RedeemWallet = {
      ...winningWallet(),
      redeemOutcomeProofs: async ({ inputs, outputs }) => {
        redeemCalls += 1;
        expect(inputs[0]?.witness).toBe('{"oracle_sig":"prepared"}');
        return signOutputs(outputs as OutputData[]);
      },
    };

    const result = await claimBrowserCanonicalCtfPosition({
      position: { conditionId: CONDITION, outcomeCollection: OUTCOME },
      context: context(entry, wallet, { prepareNewLegAuthority }),
    });

    // The legs pay 1 msat at 0 ppk, then 2 msat less the second keyset's 1 msat minimum fee.
    expect(result).toMatchObject({ kind: "completed", committedPayoutAmount: 2, committedLegs: 2 });
    expect(prepareNewLegAuthority).toHaveBeenCalledOnce();
    expect(redeemCalls).toBe(2);
  });

  it("refuses a persisted operation with missing exact authority before new-leg preparation", async () => {
    const entry = await fixture();
    const record = await entry.bind();
    const snapshot = await entry.adapter.readOperationSnapshot(
      entry.scope,
      record.operation.operationId,
    );
    if (snapshot === null) throw new Error("CTF claim test operation is missing");
    const artifactId = snapshot.record.operation.privateMaterial.exactPrivateMaterial.artifactId;
    await entry.database.custodyArtifacts.delete([
      entry.scope.scopeId,
      record.operation.operationId,
      artifactId,
    ]);
    const prepareNewLegAuthority = vi.fn(async () => ({
      regularKeyset: REGULAR_KEYSET,
      oracleWitness: '{"oracle_sig":"unused"}',
    }));

    const result = await claimBrowserCanonicalCtfPosition({
      position: { conditionId: CONDITION, outcomeCollection: OUTCOME },
      context: context(entry, winningWallet(), { prepareNewLegAuthority }),
    });

    expect(result).toMatchObject({
      kind: "error",
      error: {
        code: "claim-failed",
        message: expect.stringContaining("referenced artifact is missing"),
      },
    });
    expect(prepareNewLegAuthority).not.toHaveBeenCalled();
    expect(
      (await entry.adapter.readProof(entry.scope.scopeId, entry.proof.proofId))?.selectability,
    ).toBe("locked");
  });

  it("keeps a recovered payout when preparation for the next leg fails", async () => {
    const entry = await fixture({ amounts: [1, 2] });
    const recovered = await entry.bindLeg(entry.legs[0]!);
    const prepareNewLegAuthority = vi.fn(async () => {
      throw new Error("fresh engine attestation is unavailable");
    });

    const result = await claimBrowserCanonicalCtfPosition({
      position: { conditionId: CONDITION, outcomeCollection: OUTCOME },
      context: context(entry, winningWallet(), { prepareNewLegAuthority }),
    });

    expect(result).toMatchObject({
      kind: "error",
      committedPayoutAmount: 1,
      committedLegs: 1,
      error: { code: "claim-failed", message: "fresh engine attestation is unavailable" },
    });
    expect(prepareNewLegAuthority).toHaveBeenCalledOnce();
    expect(
      (await entry.adapter.readOperation(entry.scope, recovered.operation.operationId))?.operation
        .result.state,
    ).toBe("applied");
    expect(await entry.database.proofs.count()).toBe(1);
    expect(
      (await entry.adapter.readProof(entry.scope.scopeId, entry.proofs[1]!.proofId))?.selectability,
    ).toBe("selectable");
  });

  it("uses canonical custody rows even when the legacy cache is stale", async () => {
    const entry = await fixture();
    await entry.database.proofs.put({ secret: "stale-cache" } as never);

    const result = await claimBrowserCanonicalCtfPosition({
      position: { conditionId: CONDITION, outcomeCollection: OUTCOME },
      context: context(entry),
    });

    expect(result).toMatchObject({ kind: "completed", committedPayoutAmount: 1 });
    expect(await entry.database.proofs.toArray()).toContainEqual(
      expect.objectContaining({ secret: "stale-cache" }),
    );
    expect(await entry.database.proofs.count()).toBe(2);
  });

  it("claims only captured exact targets and ignores a newly arriving canonical proof", async () => {
    const entry = await fixture();
    const target = {
      proofId: entry.proof.proofId,
      revision: entry.proof.revision,
      proofFingerprint: entry.proof.proofFingerprint,
    } as const;
    const arriving = createBrowserCustodyProofRow({
      scopeId: entry.scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: {
        id: entry.proof.keysetId,
        amount: 2 as never,
        secret: "arriving-after-confirmation",
        C: MINT_PUBLIC_KEY,
      },
      asset: { kind: "conditional", conditionId: CONDITION, outcomeCollection: OUTCOME },
      receivedAtMs: 2,
    });
    await entry.database.custodyProofs.put(arriving);
    await entry.database.custodyProofBackupAuthorities.put(
      createBrowserProofBackupAuthorityRow(arriving, 2, null, "ctf-receive"),
    );

    const result = await claimBrowserCanonicalCtfPosition({
      position: { conditionId: CONDITION, outcomeCollection: OUTCOME },
      targets: [target],
      context: context(entry),
    });

    expect(result).toMatchObject({ kind: "completed", committedPayoutAmount: 1 });
    expect(
      (await entry.adapter.readProof(entry.scope.scopeId, arriving.proofId))?.selectability,
    ).toBe("selectable");
  });

  it("commits one leg, returns pending, and resumes the persisted other leg after reload", async () => {
    const entry = await fixture({ amounts: [1, 2] });
    let redeemCalls = 0;
    const wallet: RedeemWallet = {
      ...winningWallet(),
      redeemOutcomeProofs: async ({ outputs }) => {
        redeemCalls += 1;
        if (redeemCalls === 2) throw new Error("request timed out");
        return signOutputs(outputs as OutputData[]);
      },
    };

    const first = await claimBrowserCanonicalCtfPosition({
      position: { conditionId: CONDITION, outcomeCollection: OUTCOME },
      context: context(entry, wallet),
    });
    expect(first).toMatchObject({ kind: "pending", committedLegs: 1, pendingLegs: 1 });
    const pendingProjection = await readCanonicalPortfolioCustody(
      entry.scope.scopeId,
      entry.database,
    );
    expect(pendingProjection).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          proofId: entry.proofs[1]!.proofId,
          claimRecoveryPending: true,
        }),
      ]),
    );

    const databaseName = entry.database.name;
    await entry.adapter.releaseScope(entry.scope, { ...entry.owner, observedAtMs: 6 });
    entry.database.close();
    const reloadedDatabase = new BitcasterDB(databaseName);
    const reloadedAdapter = new BrowserDurableCustodyAdapter(reloadedDatabase);
    const reloadedProjection = await readCanonicalPortfolioCustody(
      entry.scope.scopeId,
      reloadedDatabase,
    );
    expect(reloadedProjection).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          proofId: entry.proofs[1]!.proofId,
          claimRecoveryPending: true,
        }),
      ]),
    );
    const reloadedOwner = await reloadedAdapter.claimScope(entry.scope, {
      incarnationId: "ctf-redeem-reload",
      observedAtMs: 7,
      leaseExpiresAtMs: 100_000,
    });
    let nextCounter = 0;
    const reloadedCounters: CounterSource = {
      reserve: async (_keysetId, count) => {
        const start = nextCounter;
        nextCounter += count;
        return { start, count };
      },
      advanceToAtLeast: async (_keysetId, minimum) => {
        nextCounter = Math.max(nextCounter, minimum);
      },
    };
    const resumed = await claimBrowserCanonicalCtfPosition({
      position: { conditionId: CONDITION, outcomeCollection: OUTCOME },
      context: context({
        database: reloadedDatabase,
        adapter: reloadedAdapter,
        owner: reloadedOwner,
        counters: reloadedCounters,
      }),
    });
    expect(resumed).toMatchObject({ kind: "completed", committedLegs: 1, pendingLegs: 0 });
    expect(await reloadedDatabase.proofs.count()).toBe(2);
    expect(
      (await readCanonicalPortfolioCustody(entry.scope.scopeId, reloadedDatabase))?.every(
        ({ claimRecoveryPending }) => !claimRecoveryPending,
      ),
    ).toBe(true);
  });

  it("does not credit an already-completed payout a second time", async () => {
    const entry = await fixture();
    const input = {
      position: { conditionId: CONDITION, outcomeCollection: OUTCOME },
      context: context(entry),
    } as const;

    const first = await claimBrowserCanonicalCtfPosition(input);
    const second = await claimBrowserCanonicalCtfPosition(input);

    expect(first).toMatchObject({ kind: "completed", committedPayoutAmount: 1 });
    expect(second).toMatchObject({ kind: "completed", committedPayoutAmount: 0, committedLegs: 0 });
    expect(await entry.database.proofs.count()).toBe(1);
  });

  it("stops explicitly after the first committed winning payout", async () => {
    const entry = await fixture({ amounts: [1, 2] });
    const result = await claimBrowserCanonicalCtfPosition({
      position: { conditionId: CONDITION, outcomeCollection: OUTCOME },
      stopOnCommittedPayout: true,
      context: context(entry),
    });

    expect(result).toMatchObject({ kind: "stopped", reason: "winning-payout", committedLegs: 1 });
    expect(
      (await entry.adapter.readProof(entry.scope.scopeId, entry.proofs[1]!.proofId))?.selectability,
    ).toBe("selectable");
  });

  it("retains proof bodies after authenticated terminal losing response", async () => {
    const entry = await fixture();
    const losingWallet: RedeemWallet = {
      ...winningWallet(),
      redeemOutcomeProofs: async () => {
        throw new MintOperationError(13015, "Oracle has not attested to this outcome collection");
      },
    };

    const result = await claimBrowserCanonicalCtfPosition({
      position: { conditionId: CONDITION, outcomeCollection: OUTCOME },
      context: context(entry, losingWallet),
    });

    expect(result).toMatchObject({ kind: "completed", losingLegs: 1, committedPayoutAmount: 0 });
    const retained = await entry.adapter.readProof(entry.scope.scopeId, entry.proof.proofId);
    expect(retained?.selectability).toBe("verified-losing");
    expect(retained?.proofBody).toBeInstanceOf(Uint8Array);
  });
});
