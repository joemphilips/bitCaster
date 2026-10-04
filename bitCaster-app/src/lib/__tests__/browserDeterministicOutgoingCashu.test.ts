import {
  Amount,
  OutputData,
  type OperationCounters,
  type Proof,
  type SwapPreview,
} from "@cashu/cashu-ts";
import { describe, expect, it } from "vitest";
import { prepareBrowserDeterministicOutgoingCashuSend } from "../browserDeterministicOutgoingCashu";

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
    const counters: OperationCounters = {
      keysetId: KEYSET_ID,
      start: 17,
      count: 2,
      next: 19,
    };
    const preview = createPreview(counters.start);
    const keepProofDerivationLocators: Array<{
      schemaVersion: 1;
      kind: "nut13";
      keysetId: string;
      counter: number;
    } | null> = [null];
    let prepareCalls = 0;

    const operation = await prepareBrowserDeterministicOutgoingCashuSend({
      operationId: "browser-send-1",
      amount: 2,
      proofs: [INPUT_PROOF],
      mintUrl: "https://mint.example",
      unit: "msat",
      seed: SEED,
      wallet: {
        getKeyset: () => ({ id: KEYSET_ID }),
        prepareSwapToSend: async (_amount, _proofs, config) => {
          prepareCalls += 1;
          config.onCountersReserved(counters);
          return preview;
        },
      },
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
