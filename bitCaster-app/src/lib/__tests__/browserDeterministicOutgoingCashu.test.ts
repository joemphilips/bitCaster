import {
  Amount,
  Mint,
  OutputData,
  Wallet,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  pointFromHex,
  type OperationCounters,
  type Proof,
  type SwapPreview,
} from "@cashu/cashu-ts";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it, vi } from "vitest";
import {
  hydrateDurableWalletSendPreview,
  verifyDurableWalletSendResult,
} from "@bitcaster/client-sdk/durableWalletOperation";
import { NEW_WALLET_OPERATION_INPUT_LIMIT } from "@bitcaster/client-sdk/walletOperationSize";
import i18n from "@/i18n";
import { selectWalletProofs } from "@bitcaster/client-sdk/walletProofSelection";
import { BOUNDED_CANONICAL_REGULAR_PROOF_LIMIT_MAX } from "@/stores/proof-db";
import {
  mintDenominationKeys,
  mintDenominationPrivateKey,
} from "../../../../bitcaster-client-sdk/test/support/mintDenominationKeys";
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
      tooLargeAdvice: "smaller-amount",
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

  it.each([
    ["en", "smaller-amount", "Use a smaller amount."],
    ["en", "combine-proofs", "First combine them"],
    ["ja", "smaller-amount", "金額を小さくしてください"],
    ["ja", "combine-proofs", "プルーフをまとめてから"],
  ] as const)(
    "localizes a refusal (%s, %s) and reserves nothing",
    async (language, advice, text) => {
      const previous = i18n.language;
      await i18n.changeLanguage(language);
      let reserved = 0;
      draftWalletMock.create = async () => ({
        getKeyset: () => ({ id: KEYSET_ID, verify: () => true }),
        prepareSwapToSend: async () => ({
          ...createPreview(0),
          inputs: Array<Proof>(NEW_WALLET_OPERATION_INPUT_LIMIT + 1).fill(INPUT_PROOF),
        }),
      });
      try {
        const refused = prepareBrowserDeterministicOutgoingCashuSend({
          operationId: "browser-send-refused",
          amount: 2,
          proofs: [INPUT_PROOF],
          mintUrl: "https://mint.example",
          unit: "msat",
          seed: SEED,
          wallet: {
            getKeyset: () => ({ id: KEYSET_ID }),
            prepareSwapToSend: async () => {
              reserved += 1;
              return createPreview(0);
            },
          },
          requireCapturedProfile: () => undefined,
          keepProofDerivationLocators: [],
          diagnosticLabel: "browser send",
          tooLargeAdvice: advice,
        });
        await expect(refused).rejects.toMatchObject({
          code: "wallet-operation-too-large",
          message: expect.stringContaining(text),
        });
        expect(reserved).toBe(0);
      } finally {
        await i18n.changeLanguage(previous);
      }
    },
  );

  it("completes a payment of a wallet that fills its bounded proof window", async () => {
    const root = new Uint8Array(32).fill(1);
    const amounts = Array.from({ length: 14 }, (_, power) => 2 ** power);
    const keys = mintDenominationKeys(root, amounts.map(String));
    const keyset = { unit: "msat", input_fee_ppk: 1_000 };
    const id = deriveKeysetId(keys, { ...keyset, versionByte: 1 });
    const sign = (amount: number, point: string) => {
      const key = mintDenominationPrivateKey(root, String(amount));
      const dleq = createDLEQProof(pointFromHex(point), key);
      return {
        id,
        amount: Amount.from(amount),
        C_: createBlindSignature(pointFromHex(point), key, id).C_.toHex(true),
        dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
      };
    };
    const proofs = Array.from(
      { length: BOUNDED_CANONICAL_REGULAR_PROOF_LIMIT_MAX },
      (_, index): Proof => {
        // One large input gives more outputs than inputs, so the result exceeds the window.
        const amount = 8_192;
        // This fixture does not verify the input signatures. Any curve point serves.
        return { id, amount: Amount.from(amount), secret: `held-${index}`, C: keys[amount]! };
      },
    );
    let wallet: Wallet | undefined;
    draftWalletMock.create = async ({ counterSource }) => {
      const mint = new Mint("https://mint.example");
      mint.getInfo = async () => ({ nuts: {} }) as never;
      mint.getKeySets = async () => ({ keysets: [{ id, active: true, ...keyset }] });
      mint.getKeys = async () => ({ keysets: [{ id, ...keyset, keys }] });
      mint.swap = async ({ outputs }) => ({
        signatures: outputs.map(({ amount, B_ }) => sign(Number(String(amount)), B_)),
      });
      wallet = new Wallet(mint, {
        unit: "msat",
        bip39seed: SEED,
        counterSource,
        selectProofs: selectWalletProofs,
      });
      await wallet.loadMint();
      return wallet;
    };
    const operation = await prepareBrowserDeterministicOutgoingCashuSend({
      operationId: "browser-send-large",
      amount: 5_000,
      proofs,
      mintUrl: "https://mint.example",
      unit: "msat",
      seed: SEED,
      wallet: {
        getKeyset: () => ({ id }),
        prepareSwapToSend: async () => {
          throw new Error("active wallet must not prepare outgoing outputs");
        },
      },
      requireCapturedProfile: () => undefined,
      keepProofDerivationLocators: [],
      diagnosticLabel: "browser send",
      tooLargeAdvice: "smaller-amount",
    });
    const { preview } = operation;
    const result = await wallet!.completeSwap(hydrateDurableWalletSendPreview(operation));

    // Before the fix, the mint signed the outputs and then this check refused them.
    const exact = verifyDurableWalletSendResult(operation, result);
    const total = (values: readonly { amount: unknown }[]) =>
      values.reduce((sum, { amount }) => sum + Number(String(amount)), 0);
    expect(total(exact.send)).toBe(5_000);
    expect(total(exact.keep)).toBe(total(preview.inputs) - 5_000 - preview.inputs.length);
    expect(preview.unselectedProofs).toEqual([]);
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
