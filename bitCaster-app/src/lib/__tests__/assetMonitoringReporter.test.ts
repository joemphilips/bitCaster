// @vitest-environment node
import { Amount } from "@cashu/cashu-ts";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { EngineClientError } from "@bitcaster/client-sdk/engineClient";
import type {
  AssetMonitoringReportedHolding,
  AssetMonitoringReportRequest,
} from "@bitcaster/client-sdk/assetMonitoring";
import {
  bindBrowserProofBackupAuthorityTerminalOperation,
  createBrowserProofBackupAuthorityRow,
} from "@/stores/browser-proof-backup-authority";
import { createBrowserCustodyProofRow } from "@/stores/durable-custody-db";
import type { StoredProof } from "@/stores/proof-db";
import { describe, expect, it, vi, type Mock } from "vitest";
import {
  AssetMonitoringReporter,
  buildAssetMonitoringHoldings,
  fetchAssetMonitoringCatalogue,
} from "../assetMonitoringReporter";

const conditionId = "a".repeat(64);
const walletId = "b".repeat(64);

describe("asset monitoring snapshot", () => {
  it("reports only a valid bound NUT-13 recovery counter", () => {
    const stored = proof({ id: keysetId(), secret: "recoverable", C: "03" });
    const custody = custodyProof(stored);
    const authority = createBrowserProofBackupAuthorityRow(
      custody,
      2,
      { schemaVersion: 1, kind: "nut13", keysetId: stored.id, counter: 7 },
      "admission-1",
    );

    expect(
      buildAssetMonitoringHoldings({
        proofs: [stored],
        catalogue: [],
        custody: {
          scopeId: custody.scopeId,
          proofs: [custody],
          proofBackupAuthorities: [authority],
        },
      }),
    ).toEqual([
      expect.objectContaining({
        recoveryHint: { keysetIds: [stored.id], counterIntervals: [{ start: 7, count: 1 }] },
      }),
    ]);
  });

  it.each([
    ["null", null],
    ["malformed", { schemaVersion: 1, kind: "nut13", keysetId: keysetId(), counter: -1 }],
    [
      "foreign keyset",
      { schemaVersion: 1, kind: "nut13", keysetId: alternateKeysetId(), counter: 7 },
    ],
    [
      "manifest",
      {
        schemaVersion: 1,
        kind: "ctf-range-manifest",
        rangeOperationId: "range-1",
        manifestIndex: 1,
      },
    ],
    [
      "refund",
      {
        schemaVersion: 1,
        kind: "ctf-range-refund",
        rangeOperationId: "range-1",
        authorizationId: "authorization-1",
        refundOperationId: "refund-1",
        counter: 1,
      },
    ],
  ])("keeps the holding without a recovery counter for a %s locator", (_label, locator) => {
    const stored = proof({ id: keysetId(), secret: "without-counter", C: "04" });
    const custody = custodyProof(stored);
    const valid = createBrowserProofBackupAuthorityRow(custody, 2, null, "admission-1");
    const authority = locator === null ? valid : { ...valid, derivationLocator: locator };

    expect(
      buildAssetMonitoringHoldings({
        proofs: [stored],
        catalogue: [],
        custody: {
          scopeId: custody.scopeId,
          proofs: [custody],
          proofBackupAuthorities: [authority],
        },
      }),
    ).toEqual([
      expect.objectContaining({
        recoveryHint: { keysetIds: [stored.id], counterIntervals: [] },
      }),
    ]);
  });

  it("keeps the holding without a recovery counter for a foreign or stale authority", () => {
    const stored = proof({ id: keysetId(), secret: "unbound", C: "05" });
    const custody = custodyProof(stored);
    const authority = createBrowserProofBackupAuthorityRow(
      custody,
      2,
      { schemaVersion: 1, kind: "nut13", keysetId: stored.id, counter: 7 },
      "admission-1",
    );

    for (const invalid of [
      { ...authority, proofFingerprint: "f".repeat(64) },
      { ...authority, proofRevision: custody.revision + 1 },
      { ...authority, proofState: "locked" },
    ]) {
      expect(
        buildAssetMonitoringHoldings({
          proofs: [stored],
          catalogue: [],
          custody: {
            scopeId: custody.scopeId,
            proofs: [custody],
            proofBackupAuthorities: [invalid],
          },
        }),
      ).toEqual([
        expect.objectContaining({
          recoveryHint: { keysetIds: [stored.id], counterIntervals: [] },
        }),
      ]);
    }
  });

  it("keeps the holding without a recovery counter for a spent canonical proof", () => {
    const stored = proof({ id: keysetId(), secret: "spent", C: "06" });
    const custody = {
      ...custodyProof(stored),
      revision: 1,
      selectability: "spent" as const,
    };
    const authority = createBrowserProofBackupAuthorityRow(
      custody,
      2,
      nut13(stored.id, 7),
      "admission-1",
    );

    expect(recoveryIntervals(stored, custody, authority)).toEqual([]);
  });

  it("keeps the holding without a recovery counter for a terminal authority", () => {
    const stored = proof({ id: keysetId(), secret: "terminal", C: "07" });
    const custody = custodyProof(stored);
    const authority = bindBrowserProofBackupAuthorityTerminalOperation(
      createBrowserProofBackupAuthorityRow(custody, 2, nut13(stored.id, 7), "admission-1"),
      "terminal-1",
      3,
    );

    expect(recoveryIntervals(stored, custody, authority)).toEqual([]);
  });

  it("reports a recovery counter for an exactly matching locked reservation", () => {
    const stored = proof({ id: keysetId(), secret: "locked", C: "08", reservedBy: "order-1" });
    const custody = {
      ...custodyProof(stored),
      revision: 1,
      selectability: "locked" as const,
      reservationOperationId: "order-1",
    };
    const authority = createBrowserProofBackupAuthorityRow(
      custody,
      2,
      nut13(stored.id, 7),
      "admission-1",
    );

    expect(recoveryIntervals(stored, custody, authority)).toEqual([{ start: 7, count: 1 }]);
  });

  it("keeps the holding without a recovery counter for a locked reservation mismatch", () => {
    const stored = proof({ id: keysetId(), secret: "mismatch", C: "09", reservedBy: "order-1" });
    const custody = {
      ...custodyProof(stored),
      revision: 1,
      selectability: "locked" as const,
      reservationOperationId: "order-2",
    };
    const authority = createBrowserProofBackupAuthorityRow(
      custody,
      2,
      nut13(stored.id, 7),
      "admission-1",
    );

    expect(recoveryIntervals(stored, custody, authority)).toEqual([]);
  });

  it("keeps the holding without a recovery counter for duplicate or foreign-scope custody", () => {
    const stored = proof({ id: keysetId(), secret: "duplicate", C: "0a" });
    const custody = custodyProof(stored);
    const authority = createBrowserProofBackupAuthorityRow(
      custody,
      2,
      nut13(stored.id, 7),
      "admission-1",
    );
    const foreignScopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: deriveDurableCustodyWalletId(new Uint8Array(32).fill(8)),
    });
    const foreignCustody = createBrowserCustodyProofRow({
      scopeId: foreignScopeId,
      normalizedMint: stored.mintUrl,
      unit: "msat",
      proof: stored,
      asset: { kind: "regular" },
      receivedAtMs: 1,
    });
    const foreignAuthority = createBrowserProofBackupAuthorityRow(
      foreignCustody,
      2,
      nut13(stored.id, 7),
      "admission-1",
    );

    expect(recoveryIntervals(stored, custody, authority, [custody, custody])).toEqual([]);
    expect(recoveryIntervals(stored, custody, foreignAuthority, [foreignCustody])).toEqual([]);
  });

  it("includes reserved proofs as pending and excludes terminal proofs", () => {
    const holdings = buildAssetMonitoringHoldings({
      proofs: [
        proof({ amount: 2 }),
        proof({ secret: "reserved", C: "03", amount: 3, reservedBy: "order-1" }),
        proof({ secret: "terminal", C: "04", amount: 5, terminalOperationId: "redeem-1" }),
      ],
      catalogue: [],
    });

    expect(holdings).toEqual([
      expect.objectContaining({ availableSubunits: 2, pendingOutgoingSubunits: 3 }),
    ]);
  });

  it("merges a fully evicted ordinary backup descriptor with unrelated local proof rows", () => {
    const holdings = buildAssetMonitoringHoldings({
      proofs: [proof({ amount: 4_096 })],
      catalogue: [],
      evictedAssets: [
        {
          kind: "ordinary",
          mintUrl: "https://mint.example",
          unit: "msat",
          declaredAmount: 20_000_000,
        },
      ],
    });

    expect(holdings).toEqual([
      expect.objectContaining({ availableSubunits: 20_004_096, pendingOutgoingSubunits: 0 }),
    ]);
  });

  it("maps an evicted conditional asset without creating a recovery hint", () => {
    const holdings = buildAssetMonitoringHoldings({
      proofs: [],
      catalogue: [{ conditionId, outcomes: ["NO", "YES"] }],
      evictedAssets: [
        {
          kind: "conditional",
          mintUrl: "https://mint.example",
          unit: "msat",
          conditionId,
          outcomeCollection: "YES",
          declaredAmount: 20_000_000,
        },
      ],
    });

    expect(holdings).toEqual([
      expect.objectContaining({ availableSubunits: 20_000_000, pendingOutgoingSubunits: 0 }),
    ]);
    expect(holdings?.[0]?.asset).toEqual(
      expect.objectContaining({ kind: "conditional", conditionId, internalOutcomeSetId: "YES" }),
    );
    expect(holdings?.[0]).not.toHaveProperty("recoveryHint");
  });

  it("keeps evicted conditional assets within the monitoring condition bound", () => {
    const evictedAssets = Array.from({ length: 201 }, (_, index) => ({
      kind: "conditional" as const,
      mintUrl: "https://mint.example",
      unit: "msat" as const,
      conditionId: index.toString(16).padStart(64, "0"),
      outcomeCollection: "YES",
      declaredAmount: 1,
    }));

    expect(buildAssetMonitoringHoldings({ proofs: [], catalogue: [], evictedAssets })).toBeNull();
  });

  it("resolves conditional metadata from the exact catalogue outcomes", () => {
    const holdings = buildAssetMonitoringHoldings({
      proofs: [proof({ conditionId, outcomeCollection: "NO|YES", unit: "msat" })],
      catalogue: [{ conditionId, outcomes: ["MAYBE", "NO", "YES"] }],
    });

    expect(holdings?.[0]?.asset).toEqual(
      expect.objectContaining({
        kind: "conditional",
        conditionId,
        internalOutcomeSetId: "NO|YES",
        outcomeUniverseDigest: "070759808adcb7c1031d41014173ef55a094fc5614e18b2cb66306b77199f918",
      }),
    );
  });

  it("aborts the complete report for unresolved or conflicting conditional metadata", () => {
    const input = [proof({ conditionId, outcomeCollection: "YES" })];

    expect(buildAssetMonitoringHoldings({ proofs: input, catalogue: [] })).toBeNull();
    expect(
      buildAssetMonitoringHoldings({
        proofs: input,
        catalogue: [
          { conditionId, outcomes: ["NO", "YES"] },
          { conditionId, outcomes: ["NO", "YES"] },
        ],
      }),
    ).toBeNull();
  });

  it("aborts the complete report when canonical and legacy conditional metadata conflict", () => {
    const catalogue = [{ conditionId, outcomes: ["NO", "YES"] }];

    expect(
      buildAssetMonitoringHoldings({
        proofs: [proof({ conditionId, condition_id: "c".repeat(64), outcomeCollection: "YES" })],
        catalogue,
      }),
    ).toBeNull();
    expect(
      buildAssetMonitoringHoldings({
        proofs: [proof({ conditionId, outcomeCollection: "YES", outcome_collection: "NO" })],
        catalogue,
      }),
    ).toBeNull();
  });

  it("uses a bounded raw catalogue request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ markets: [{ conditionId, outcomes: ["NO", "YES"] }] }), {
        status: 200,
      }),
    );

    await expect(
      fetchAssetMonitoringCatalogue([conditionId], {
        engineBaseUrl: "https://engine.example",
        fetchImpl,
      }),
    ).resolves.toEqual([{ conditionId, outcomes: ["NO", "YES"] }]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("page_size=1");
  });

  it("splits more than 50 selected conditions into bounded catalogue requests", async () => {
    const conditionIds = Array.from({ length: 101 }, (_, index) =>
      index.toString(16).padStart(64, "0"),
    );
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL) => new Response(JSON.stringify({ markets: [] })),
    );

    await expect(
      fetchAssetMonitoringCatalogue(conditionIds, {
        engineBaseUrl: "https://engine.example",
        fetchImpl,
      }),
    ).resolves.toEqual([]);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const [url] of fetchImpl.mock.calls) {
      const query = new URL(String(url), "https://app.example").searchParams;
      expect(query.get("ids")?.split(",").length).toBeLessThanOrEqual(50);
      expect(Number(query.get("page_size"))).toBeLessThanOrEqual(50);
    }
  });

  it("rejects malformed condition IDs before catalogue I/O", async () => {
    const fetchImpl = vi.fn();

    await expect(
      fetchAssetMonitoringCatalogue([`${conditionId},${"c".repeat(64)}`], {
        engineBaseUrl: "https://engine.example",
        fetchImpl,
      }),
    ).rejects.toThrow();
    await expect(
      fetchAssetMonitoringCatalogue(["a".repeat(129)], {
        engineBaseUrl: "https://engine.example",
        fetchImpl,
      }),
    ).rejects.toThrow();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects oversized and overfull catalogue responses", async () => {
    const oversized = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ markets: [] }), {
        headers: { "content-length": String(513 * 1024) },
      }),
    );
    const overfull = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          markets: [
            { conditionId, outcomes: ["NO", "YES"] },
            { conditionId: "c".repeat(64), outcomes: ["NO", "YES"] },
          ],
        }),
      ),
    );

    await expect(
      fetchAssetMonitoringCatalogue([conditionId], {
        engineBaseUrl: "https://engine.example",
        fetchImpl: oversized,
      }),
    ).rejects.toThrow();
    await expect(
      fetchAssetMonitoringCatalogue([conditionId], {
        engineBaseUrl: "https://engine.example",
        fetchImpl: overfull,
      }),
    ).rejects.toThrow();
  });
});

describe("asset monitoring reporter", () => {
  it("submits at startup and after a later local mutation", async () => {
    const remote = reporterRemote();
    const reporter = new AssetMonitoringReporter({
      walletId,
      buildHoldings: vi.fn().mockResolvedValueOnce(holdings(1)).mockResolvedValueOnce(holdings(2)),
      remote,
      hasPendingSubmittedOrder: vi.fn(),
      isCurrent: () => true,
      createReportId: ids(),
    });

    reporter.request();
    await vi.waitFor(() => expect(remote.submitAssetMonitoringReport).toHaveBeenCalledTimes(1));
    reporter.request();
    await vi.waitFor(() => expect(remote.submitAssetMonitoringReport).toHaveBeenCalledTimes(2));

    expect(requestAt(remote, 0).startsNewInterval).toBe(false);
    expect(requestAt(remote, 1).startsNewInterval).toBe(false);
  });

  it("serializes and coalesces changes that arrive before a snapshot completes", async () => {
    const first = deferred<readonly AssetMonitoringReportedHolding[] | null>();
    const buildHoldings = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(holdings(2));
    const remote = reporterRemote();
    const reporter = new AssetMonitoringReporter({
      walletId,
      buildHoldings,
      remote,
      hasPendingSubmittedOrder: vi.fn(),
      isCurrent: () => true,
      createReportId: ids(),
    });

    reporter.request();
    reporter.request();
    first.resolve(holdings(1));

    await vi.waitFor(() => expect(remote.submitAssetMonitoringReport).toHaveBeenCalledOnce());
    expect(buildHoldings).toHaveBeenCalledTimes(2);
    expect(requestAt(remote, 0).holdings[0]?.availableSubunits).toBe(2);
  });

  it("suppresses an old 409 retry when a newer request was queued", async () => {
    const first = deferred<void>();
    const remote = reporterRemote();
    remote.submitAssetMonitoringReport
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const reporter = new AssetMonitoringReporter({
      walletId,
      buildHoldings: vi.fn().mockResolvedValue(holdings(1)),
      remote,
      hasPendingSubmittedOrder: vi.fn().mockResolvedValue(false),
      isCurrent: () => true,
      createReportId: ids(),
    });

    reporter.request();
    await vi.waitFor(() => expect(remote.submitAssetMonitoringReport).toHaveBeenCalledOnce());
    reporter.request();
    first.reject(new EngineClientError(409, "conflict"));

    await vi.waitFor(() => expect(remote.submitAssetMonitoringReport).toHaveBeenCalledTimes(2));
    expect(requestAt(remote, 1).startsNewInterval).toBe(false);
  });

  it("defers a 409 when a submitted order remains nonterminal", async () => {
    const remote = reporterRemote();
    remote.submitAssetMonitoringReport.mockRejectedValue(new EngineClientError(409, "conflict"));
    const hasPendingSubmittedOrder = vi.fn().mockResolvedValue(true);
    const reporter = new AssetMonitoringReporter({
      walletId,
      buildHoldings: vi.fn().mockResolvedValue(holdings(1)),
      remote,
      hasPendingSubmittedOrder,
      isCurrent: () => true,
      createReportId: ids(),
    });

    reporter.request();
    await vi.waitFor(() => expect(hasPendingSubmittedOrder).toHaveBeenCalledOnce());

    expect(remote.submitAssetMonitoringReport).toHaveBeenCalledOnce();
  });

  it("retries only a 409 without a pending order using the same holdings and a new ID", async () => {
    const remote = reporterRemote();
    remote.submitAssetMonitoringReport
      .mockRejectedValueOnce(new EngineClientError(409, "conflict"))
      .mockResolvedValueOnce(undefined);
    const reporter = new AssetMonitoringReporter({
      walletId,
      buildHoldings: vi.fn().mockResolvedValue(holdings(7)),
      remote,
      hasPendingSubmittedOrder: vi.fn().mockResolvedValue(false),
      isCurrent: () => true,
      createReportId: ids(),
    });

    reporter.request();
    await vi.waitFor(() => expect(remote.submitAssetMonitoringReport).toHaveBeenCalledTimes(2));

    expect(requestAt(remote, 0)).toMatchObject({ reportId: "report-1", startsNewInterval: false });
    expect(requestAt(remote, 1)).toMatchObject({ reportId: "report-2", startsNewInterval: true });
    expect(requestAt(remote, 1).holdings).toEqual(requestAt(remote, 0).holdings);
  });

  it("retries a transient non-409 failure without another wallet change", async () => {
    const remote = reporterRemote();
    remote.submitAssetMonitoringReport
      .mockRejectedValueOnce(new EngineClientError(500, "unavailable"))
      .mockResolvedValueOnce(undefined);
    const reporter = new AssetMonitoringReporter({
      walletId,
      buildHoldings: vi.fn().mockResolvedValue(holdings(1)),
      remote,
      hasPendingSubmittedOrder: vi.fn(),
      isCurrent: () => true,
      createReportId: ids(),
      retryDelayMs: () => 1,
    });

    reporter.request();
    await vi.waitFor(() => expect(remote.submitAssetMonitoringReport).toHaveBeenCalledTimes(2));

    reporter.stop();
  });

  it("does not submit stale work after a wallet or signer switch", async () => {
    const pending = deferred<readonly AssetMonitoringReportedHolding[] | null>();
    const remote = reporterRemote();
    let current = true;
    const reporter = new AssetMonitoringReporter({
      walletId,
      buildHoldings: vi.fn().mockReturnValue(pending.promise),
      remote,
      hasPendingSubmittedOrder: vi.fn(),
      isCurrent: () => current,
      createReportId: ids(),
    });

    reporter.request();
    current = false;
    reporter.stop();
    pending.resolve(holdings(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(remote.submitAssetMonitoringReport).not.toHaveBeenCalled();
  });
});

function proof(overrides: ProofOverrides = {}): StoredProof {
  const { amount = 1, ...rest } = overrides;
  return {
    id: keysetId(),
    amount: Amount.from(amount),
    secret: "secret",
    C: "02",
    mintUrl: "https://mint.example",
    baseAsset: "sat",
    unit: "msat",
    ...rest,
  };
}

type ProofOverrides = Omit<Partial<StoredProof>, "amount"> & {
  amount?: number;
  condition_id?: string;
  outcome_collection?: string;
};

function custodyProof(stored: StoredProof) {
  const walletId = deriveDurableCustodyWalletId(new Uint8Array(32).fill(7));
  const scopeId = deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId });
  return createBrowserCustodyProofRow({
    scopeId,
    normalizedMint: stored.mintUrl,
    unit: "msat",
    proof: stored,
    asset: { kind: "regular" },
    receivedAtMs: 1,
  });
}

function keysetId(): string {
  return `01${"a".repeat(64)}`;
}

function alternateKeysetId(): string {
  return `01${"b".repeat(64)}`;
}

function nut13(keysetId: string, counter: number) {
  return { schemaVersion: 1 as const, kind: "nut13" as const, keysetId, counter };
}

function recoveryIntervals(
  stored: StoredProof,
  custody: ReturnType<typeof custodyProof>,
  authority: unknown,
  custodyRows: readonly unknown[] = [custody],
) {
  return buildAssetMonitoringHoldings({
    proofs: [stored],
    catalogue: [],
    custody: {
      scopeId: custody.scopeId,
      proofs: custodyRows,
      proofBackupAuthorities: [authority],
    },
  })?.[0]?.recoveryHint?.counterIntervals;
}

function holdings(amount: number): AssetMonitoringReportedHolding[] {
  return [
    {
      asset: {
        canonicalMintUrl: "https://mint.example",
        kind: "collateral",
        cashuUnit: "msat",
        displayBaseAsset: "sat",
      },
      availableSubunits: amount,
      pendingOutgoingSubunits: 0,
    },
  ];
}

type SubmitAssetMonitoringReport = (request: AssetMonitoringReportRequest) => Promise<void>;
type ReporterRemoteMock = { submitAssetMonitoringReport: Mock<SubmitAssetMonitoringReport> };

function reporterRemote(): ReporterRemoteMock {
  return { submitAssetMonitoringReport: vi.fn<SubmitAssetMonitoringReport>() };
}

function requestAt(remote: ReporterRemoteMock, index: number): AssetMonitoringReportRequest {
  return remote.submitAssetMonitoringReport.mock.calls[index]?.[0] as AssetMonitoringReportRequest;
}

function ids(): () => string {
  let index = 0;
  return () => `report-${++index}`;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  return {
    promise: new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    }),
    resolve,
    reject,
  };
}
