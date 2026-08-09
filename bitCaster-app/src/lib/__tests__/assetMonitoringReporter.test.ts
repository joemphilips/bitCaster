import { Amount } from "@cashu/cashu-ts";
import { EngineClientError } from "@bitcaster/client-sdk/engineClient";
import type {
  AssetMonitoringReportedHolding,
  AssetMonitoringReportRequest,
} from "@bitcaster/client-sdk/assetMonitoring";
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

    await expect(fetchAssetMonitoringCatalogue([conditionId], fetchImpl)).resolves.toEqual([
      { conditionId, outcomes: ["NO", "YES"] },
    ]);
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

    await expect(fetchAssetMonitoringCatalogue(conditionIds, fetchImpl)).resolves.toEqual([]);

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
      fetchAssetMonitoringCatalogue([`${conditionId},${"c".repeat(64)}`], fetchImpl),
    ).rejects.toThrow();
    await expect(fetchAssetMonitoringCatalogue(["a".repeat(129)], fetchImpl)).rejects.toThrow();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects oversized and overfull catalogue responses", async () => {
    const oversized = vi
      .fn()
      .mockResolvedValue(
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

    await expect(fetchAssetMonitoringCatalogue([conditionId], oversized)).rejects.toThrow();
    await expect(fetchAssetMonitoringCatalogue([conditionId], overfull)).rejects.toThrow();
  });
});

describe("asset monitoring reporter", () => {
  it("submits at startup and after a later local mutation", async () => {
    const remote = reporterRemote();
    const reporter = new AssetMonitoringReporter({
      walletId,
      buildHoldings: vi.fn().mockResolvedValue(holdings(1)),
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

  it("does not loop a non-409 failure", async () => {
    const remote = reporterRemote();
    remote.submitAssetMonitoringReport.mockRejectedValue(new EngineClientError(500, "unavailable"));
    const reporter = new AssetMonitoringReporter({
      walletId,
      buildHoldings: vi.fn().mockResolvedValue(holdings(1)),
      remote,
      hasPendingSubmittedOrder: vi.fn(),
      isCurrent: () => true,
      createReportId: ids(),
    });

    reporter.request();
    await vi.waitFor(() => expect(remote.submitAssetMonitoringReport).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(remote.submitAssetMonitoringReport).toHaveBeenCalledOnce();
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
    id: "00" + "a".repeat(14),
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
