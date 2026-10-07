// @vitest-environment node
import { Amount } from "@cashu/cashu-ts";
import { getPublicKey, verifyEvent, type Event } from "nostr-tools";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { BitcasterEngineClient } from "@bitcaster/client-sdk/engineClient";
import { BitcasterEngineClient as NativeEngineClient } from "@bitcaster-market/client-sdk/engineClient";
import type { AssetMonitoringReportRequest } from "@bitcaster/client-sdk/assetMonitoring";
import type { StoredProof } from "@/stores/proof-db";
import { AssetMonitoringReporter, buildAssetMonitoringHoldings } from "../assetMonitoringReporter";
import { createDaemonAssetMonitoring } from "../../../../bitcaster-daemon/src/assetMonitoring";
import { signNip98, sha256Hex } from "../../../../bitcaster-daemon/src/nostrAuth";

type Adapter = "GUI" | "CLI";
type Amounts = { available: number; pending: number };
type Observation = {
  subject: string;
  request: AssetMonitoringReportRequest;
  accepted: boolean;
  intervalRevision: number;
};

const mint = "https://mint.example";
const keysetId = `01${"a".repeat(64)}`;
const fixtureSigningKey = new Uint8Array(32).fill(3);
const signer = {
  publicKey: getPublicKey(fixtureSigningKey),
  privateKeyHex: Buffer.from(fixtureSigningKey).toString("hex"),
};
const wallets = [1, 2].map((value) => deriveDurableCustodyWalletId(new Uint8Array(32).fill(value)));
const asset = {
  canonicalMintUrl: mint,
  kind: "collateral",
  cashuUnit: "msat",
  displayBaseAsset: "sat",
};

afterEach(() => vi.useRealTimers());

describe("independent monitoring adapter composition", () => {
  it.each<[Adapter, Adapter]>([
    ["GUI", "GUI"],
    ["CLI", "CLI"],
    ["GUI", "CLI"],
  ])(
    "%s/%s keeps exact wallet reports and B's interval when A establishes a fresh baseline",
    async (kindA, kindB) => {
      vi.useFakeTimers();
      expect(wallets[0]).not.toBe(wallets[1]);
      const remote = reportingBoundary();
      const a = localWallet(0, { available: 7_001, pending: 2_003 });
      const b = localWallet(1, { available: 11_009, pending: 3_005 });
      const running = new Set<ReturnType<typeof mount>>();
      const start = (kind: Adapter, local: ReturnType<typeof localWallet>) => {
        const adapter = mount(kind, local, remote);
        running.add(adapter);
        adapter.start();
        return adapter;
      };
      try {
        let adapterA = start(kindA, a);
        start(kindB, b);
        await accepted(remote, wallets[0], 1);
        await accepted(remote, wallets[1], 1);
        expectReport(remote, wallets[0], 7_001, 2_003, true, 1);
        expectReport(remote, wallets[1], 11_009, 3_005, true, 1);
        for (const walletId of wallets) {
          expect(
            remote.observations
              .filter((row) => row.request.walletId === walletId)
              .map((row) => [row.request.startsNewInterval, row.accepted, row.intervalRevision]),
          ).toEqual([
            [false, false, 0],
            [true, true, 1],
          ]);
        }

        a.commit({ available: 9_007, pending: 4_011 });
        await accepted(remote, wallets[0], 2);
        expectReport(remote, wallets[0], 9_007, 4_011, false, 1);
        expectReport(remote, wallets[1], 11_009, 3_005, true, 1);
        b.commit({ available: 13_013, pending: 5_017 });
        await accepted(remote, wallets[1], 2);
        expectReport(remote, wallets[1], 13_013, 5_017, false, 1);

        adapterA.stop();
        expect(a.listeners.size).toBe(0);
        const stoppedCount = remote.observations.length;
        a.commit({ available: 10_021, pending: 6_019 });
        await vi.advanceTimersByTimeAsync(10);
        expect(remote.observations).toHaveLength(stoppedCount);
        const bBefore = remote.observations.filter((row) => row.request.walletId === wallets[1]);
        // Restart alone continues an interval. This remote prerequisite requires only A's fresh baseline.
        remote.requireBaseline.add(wallets[0]);
        adapterA = start(kindA, a);
        await accepted(remote, wallets[0], 3);
        expectReport(remote, wallets[0], 10_021, 6_019, true, 2);
        const restarted = remote.observations.slice(stoppedCount);
        expect(
          restarted.map((row) => [
            row.request.walletId,
            row.request.startsNewInterval,
            row.accepted,
          ]),
        ).toEqual([
          [wallets[0], false, false],
          [wallets[0], true, true],
        ]);
        expect(restarted[0].request.holdings).toEqual(restarted[1].request.holdings);
        expect(remote.observations.filter((row) => row.request.walletId === wallets[1])).toEqual(
          bBefore,
        );

        b.commit({ available: 17_023, pending: 7_029 });
        await accepted(remote, wallets[1], 3);
        expectReport(remote, wallets[1], 17_023, 7_029, false, 1);
        expectReport(remote, wallets[0], 10_021, 6_019, true, 2);
        expect(remote.observations.every((row) => row.subject === signer.publicKey)).toBe(true);
        const ids = remote.observations.map((row) => row.request.reportId);
        expect(new Set(ids).size).toBe(ids.length);
      } finally {
        running.forEach((adapter) => adapter.stop());
        expect(a.listeners.size + b.listeners.size).toBe(0);
        const stoppedCount = remote.observations.length;
        a.commit({ available: 1, pending: 1 });
        b.commit({ available: 2, pending: 2 });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(remote.observations).toHaveLength(stoppedCount);
        expect(vi.getTimerCount()).toBe(0);
      }
    },
  );
});

function localWallet(index: number, initial: Amounts) {
  let amounts = initial;
  const listeners = new Set<() => void>();
  return {
    walletId: wallets[index],
    scopeId: deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId: wallets[index] }),
    listeners,
    amounts: () => amounts,
    commit(next: Amounts) {
      amounts = next;
      listeners.forEach((notify) => notify());
    },
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
  };
}

function reportingBoundary() {
  const observations: Observation[] = [];
  const requireBaseline = new Set(wallets);
  const revisions = new Map(wallets.map((walletId) => [walletId, 0]));
  return {
    observations,
    requireBaseline,
    forWallet(kind: Adapter, walletId: ReturnType<typeof deriveDurableCustodyWalletId>) {
      const Client = clientConstructor(kind);
      // The remote I/O is mocked. The shared signer and signed body binding are real.
      return new Client({
        baseUrl: "https://engine.example",
        authorization: ({ url, method, bodyText }) => signNip98(signer, url, method, bodyText),
        fetchImpl: async (input, init) => {
          const url = String(input);
          const bodyText = String(init?.body);
          const authorization = new Headers(init?.headers).get("authorization")!;
          expect(authorization.startsWith("Nostr ")).toBe(true);
          const event: Event = JSON.parse(
            Buffer.from(authorization.slice(6), "base64").toString("utf8"),
          );
          expect(verifyEvent(event)).toBe(true);
          expect(event.pubkey).toBe(signer.publicKey);
          expect(event.kind).toBe(27235);
          expect(event.tags).toEqual([
            ["u", url],
            ["method", "POST"],
            ["payload", sha256Hex(bodyText)],
          ]);
          expect(url).toBe("https://engine.example/api/v1/asset-monitoring/reports");
          expect(init?.method).toBe("POST");
          const request: AssetMonitoringReportRequest = JSON.parse(bodyText);
          expect(request.walletId).toBe(walletId);
          const needsBaseline = requireBaseline.has(walletId) && !request.startsNewInterval;
          let revision = revisions.get(walletId)!;
          if (!needsBaseline && request.startsNewInterval) revisions.set(walletId, ++revision);
          observations.push({
            subject: event.pubkey,
            request,
            accepted: !needsBaseline,
            intervalRevision: revision,
          });
          if (needsBaseline) {
            return Response.json({ code: "asset-monitoring-baseline-required" }, { status: 409 });
          }
          requireBaseline.delete(walletId);
          return new Response(null, { status: 204 });
        },
      });
    },
  };
}

function mount(
  kind: Adapter,
  local: ReturnType<typeof localWallet>,
  remote: ReturnType<typeof reportingBoundary>,
) {
  const boundary = remote.forWallet(kind, local.walletId);
  switch (kind) {
    case "CLI": {
      const storage = {
        read: async <T>(action: (database: DatabaseSync) => T) =>
          action({
            prepare: () => ({
              all: (scopeA: string, scopeB: string) => {
                expect([scopeA, scopeB]).toEqual([local.scopeId, local.scopeId]);
                return nativeRows(local.amounts());
              },
            }),
          } as unknown as DatabaseSync),
        transaction: async () => {
          throw new Error("Monitoring must not mutate storage");
        },
      };
      return createDaemonAssetMonitoring({
        directory: `/fixture/${local.walletId}`,
        scopeId: local.scopeId,
        walletId: local.walletId,
        engineBaseUrl: "https://engine.example",
        remote: boundary,
        storage,
        subscribeToCommits: (notify) => local.subscribe(notify),
        hasPendingSubmittedOrder: async () => false,
        fetchImpl: vi.fn(async () => {
          throw new Error("Collateral needs no catalogue I/O");
        }),
      });
    }
    case "GUI": {
      let stopped = false;
      let unsubscribe: (() => void) | undefined;
      // Compose the hook's real reporter and real holdings builder. Hook lifecycle wiring has its existing owner.
      const reporter = new AssetMonitoringReporter({
        walletId: local.walletId,
        remote: boundary,
        buildHoldings: async () =>
          buildAssetMonitoringHoldings({ proofs: browserProofs(local.amounts()), catalogue: [] }),
        hasPendingSubmittedOrder: async () => false,
        isCurrent: () => !stopped,
      });
      return {
        start() {
          unsubscribe = local.subscribe(() => reporter.request());
          reporter.request();
        },
        stop() {
          stopped = true;
          reporter.stop();
          unsubscribe?.();
        },
      };
    }
    default:
      return assertNever(kind);
  }
}

function clientConstructor(kind: Adapter) {
  switch (kind) {
    case "GUI":
      return BitcasterEngineClient;
    case "CLI":
      return NativeEngineClient;
    default:
      return assertNever(kind);
  }
}

function assertNever(_kind: never): never {
  throw new Error("Unknown monitoring adapter");
}

function browserProofs(amounts: Amounts): StoredProof[] {
  return [
    {
      id: keysetId,
      amount: Amount.from(amounts.available),
      secret: "fixture-available",
      C: "02",
      mintUrl: mint,
      unit: "msat",
      baseAsset: "sat",
    },
    {
      id: keysetId,
      amount: Amount.from(amounts.pending),
      secret: "fixture-pending",
      C: "03",
      mintUrl: mint,
      unit: "msat",
      baseAsset: "sat",
      reservedBy: "fixture-reservation",
    },
  ];
}

function nativeRows(amounts: Amounts) {
  const common = {
    normalizedMint: mint,
    unit: "msat",
    keysetId,
    baseAsset: "sat",
    conditionId: null,
    outcomeSetId: null,
    source: "target",
    selectability: null,
    nut07State: null,
  };
  return [
    { ...common, proofId: "a".repeat(64), amount: amounts.available, state: "available" },
    { ...common, proofId: "b".repeat(64), amount: amounts.pending, state: "reserved" },
  ];
}

async function accepted(
  remote: ReturnType<typeof reportingBoundary>,
  walletId: string,
  count: number,
) {
  await vi.waitFor(
    () =>
      expect(
        remote.observations.filter((row) => row.accepted && row.request.walletId === walletId),
      ).toHaveLength(count),
    { timeout: 1_000, interval: 10 },
  );
}

function expectReport(
  remote: ReturnType<typeof reportingBoundary>,
  walletId: string,
  available: number,
  pending: number,
  startsNewInterval: boolean,
  revision: number,
) {
  const latest = remote.observations
    .filter((row) => row.accepted && row.request.walletId === walletId)
    .at(-1)!;
  expect(latest.request).toEqual({
    walletId,
    reportId: expect.any(String),
    startsNewInterval,
    holdings: [
      {
        asset,
        availableSubunits: available,
        pendingOutgoingSubunits: pending,
        recoveryHint: { keysetIds: [keysetId], counterIntervals: [] },
      },
    ],
  });
  expect(latest.intervalRevision).toBe(revision);
}
