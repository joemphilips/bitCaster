import {
  Amount,
  OutputData,
  type OperationCounters,
  type Proof,
  type SwapPreview,
} from "@cashu/cashu-ts";
import { describe, expect, it, vi } from "vitest";
import { prepareBrowserDeterministicOutgoingCashuSend } from "../browserDeterministicOutgoingCashu";
import { browserOutgoingCounterPreparationFor } from "../browserOutgoingCounterPreparation";

const draftWalletMock = vi.hoisted(() => ({
  create: null as
    | ((input: { counterSource: import("@cashu/cashu-ts").CounterSource }) => unknown)
    | null,
}));

vi.mock("../../stores/browser-wallet-counter-db", () => ({
  BrowserWalletCounterDexieStore: class {
    async readSnapshotInContext(_context: unknown, keysetId: string) {
      return { keysetId, nextCounter: 17 };
    }
  },
}));

vi.mock("../../stores/wallet", () => ({
  createUncachedWalletForSeedUnit: (input: {
    counterSource: import("@cashu/cashu-ts").CounterSource;
  }) => {
    if (draftWalletMock.create === null) throw new Error("draft wallet mock is not configured");
    return draftWalletMock.create(input);
  },
}));

const KEYSET_ID = `01${"a".repeat(64)}`;
const SEED = new Uint8Array(64).fill(7);
const INPUT_PROOF = {
  id: KEYSET_ID,
  amount: Amount.from(3),
  secret: "input-proof-secret",
  C: "input-proof-signature",
} as Proof;

describe("browser deterministic outgoing Cashu preparation", () => {
  it("keeps the serialized operation contract and exact change locators", async () => {
    let prepareCalls = 0;
    draftWalletMock.create = async ({ counterSource }) => ({
      getKeyset: () => ({ id: KEYSET_ID, verify: () => true }),
      prepareSwapToSend: async (
        _amount: number,
        _proofs: Proof[],
        config: { onCountersReserved: (counters: OperationCounters) => void },
      ): Promise<SwapPreview> => {
        prepareCalls += 1;
        const range = await counterSource.reserve(KEYSET_ID, 2);
        const counters: OperationCounters = {
          keysetId: KEYSET_ID,
          start: range.start,
          count: range.count,
          next: range.start + range.count,
        };
        config.onCountersReserved(counters);
        return createPreview(range.start);
      },
    });
    const keepProofDerivationLocators: Array<{
      schemaVersion: 1;
      kind: "nut13";
      keysetId: string;
      counter: number;
    } | null> = [null];
    const operation = await prepareBrowserDeterministicOutgoingCashuSend({
      operationId: "browser-send-1",
      amount: 2,
      proofs: [INPUT_PROOF],
      mintUrl: "https://mint.example",
      unit: "msat",
      seed: SEED,
      wallet: {
        getKeyset: () => ({ id: KEYSET_ID }),
        prepareSwapToSend: async () => {
          throw new Error("active wallet must not prepare outgoing outputs");
        },
      },
      requireCapturedProfile: () => undefined,
      keepProofDerivationLocators,
      diagnosticLabel: "browser send",
    });

    expect(prepareCalls).toBe(1);
    expect(operation.operationId).toBe("browser-send-1");
    expect(operation.mintUrl).toBe("https://mint.example");
    expect(operation.unit).toBe("msat");
    expect(operation.preview.sendOutputs).toHaveLength(1);
    expect(operation.preview.keepOutputs).toHaveLength(1);
    expect(keepProofDerivationLocators).toEqual([
      { schemaVersion: 1, kind: "nut13", keysetId: KEYSET_ID, counter: 18 },
    ]);
    expect(browserOutgoingCounterPreparationFor(operation).transcript.changes()).toEqual([
      { keysetId: KEYSET_ID, expectedNextCounter: 17, nextCounter: 19 },
    ]);
  });
});

function createPreview(counterStart: number): SwapPreview {
  return {
    amount: Amount.from(2),
    fees: Amount.from(0),
    keysetId: KEYSET_ID,
    inputs: [INPUT_PROOF],
    sendOutputs: [OutputData.createSingleDeterministicData(2, SEED, counterStart, KEYSET_ID)],
    keepOutputs: [OutputData.createSingleDeterministicData(1, SEED, counterStart + 1, KEYSET_ID)],
    unselectedProofs: [],
  };
}
