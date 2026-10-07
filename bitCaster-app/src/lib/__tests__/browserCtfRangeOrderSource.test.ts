// @vitest-environment node
import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/curves/utils.js";
import {
  Amount,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveKeysetId,
  pointFromHex,
  type CtfConvertRequest,
  type CtfConvertResponse,
  type Proof,
  type SerializedBlindedMessage,
  type SerializedBlindedSignature,
} from "@cashu/cashu-ts";
import {
  completeCtfRangeMixedSourceOperation,
  prepareCtfRangeMixedSourceOperation,
} from "@bitcaster/client-sdk/ctfRangeCollateralSourceOperation";
import { planCtfRangeCapabilitySource } from "@bitcaster/client-sdk/ctfRangeCapabilitySourcePlan";
import { deriveDurableCustodyProofId } from "@bitcaster/client-sdk/durableCustody";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import {
  planPersistedCtfRangeOrderAuthorization,
  buildPersistedCtfRangeOrderPreparation,
  type CtfRangeOrderRequest,
  type PersistedCtfRangeOrderPreparation,
} from "@bitcaster/client-sdk/ctfRangeOrderProtocol";
import {
  prepareCtfRangeSourceOperation,
  type CtfRangeSourceWallet,
} from "@bitcaster/client-sdk/ctfRangeSourceOperation";
import {
  browserMixedSourcePredecessorProofRows,
  browserMixedSourceSuccessorProofRows,
  browserPersistedMixedSourceResult,
  browserWalletScope,
  createBrowserRangeSourceBinding,
  decodeBrowserPersistedMixedSourceResult,
} from "../browserCtfRangeOrderSource";

const MINT_URL = "https://mint.example";
const CONDITION_ID = "ab".repeat(32);
const OUTCOME = "YES";
const COMPLEMENT = "NO";
const COORDINATOR_PUBLIC_KEY = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 1]);
const PUBLIC_KEY = bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true));
const INPUT_FEE_PPK = 100;
const FINAL_EXPIRY = 1_000;
const KEYS = Object.fromEntries(
  Array.from({ length: 21 }, (_, index) => [(1 << index).toString(), PUBLIC_KEY]),
);
const OUTCOME_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: OUTCOME,
});
const COMPLEMENT_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: COMPLEMENT,
});
const REGULAR_KEYSET_ID = deriveKeysetId(KEYS, {
  unit: "msat",
  input_fee_ppk: INPUT_FEE_PPK,
  expiry: FINAL_EXPIRY,
  versionByte: 1,
});

describe("browser CTF range source custody adapter", () => {
  it("binds and stages mixed CTF source groups with exact asset and keyset lineage", async () => {
    const preparation = persistedPreparation("mixed-source");
    const seed = new Uint8Array(64).fill(7);
    const offeredInput: Proof = {
      id: preparation.offerKeyset.id,
      amount: Amount.from(1_024),
      secret: "held-conditional-input",
      C: PUBLIC_KEY,
    };
    const collateralInput: Proof = {
      id: preparation.receiveKeyset.id,
      amount: Amount.from(16),
      secret: "regular-collateral-input",
      C: PUBLIC_KEY,
    };
    const plan = planCtfRangeCapabilitySource({
      side: "Sell",
      authorizationAmounts:
        planPersistedCtfRangeOrderAuthorization(preparation).authorizationAmounts,
      offeredKeyset: preparation.offerKeyset,
      collateralKeyset: preparation.receiveKeyset,
      complementKeyset: preparation.complementKeyset,
      offeredCandidates: [offeredInput],
      collateralCandidates: [collateralInput],
      maxInputs: preparation.maxInputs,
      maxOutputs: 256,
    });
    expect(plan.kind).toBe("mixed-source-ctf-convert");
    if (plan.kind !== "mixed-source-ctf-convert") throw new Error("mixed source plan required");

    const operation = await prepareCtfRangeMixedSourceOperation({
      preparation,
      seed,
      counterSource: testCounterSource(),
      plan,
    });
    const scope = browserWalletScope(seed);
    const binding = await createBrowserRangeSourceBinding(scope, preparation, seed, operation);
    expect(binding.record.operation.exactRequest.path).toBe("/v1/ctf/convert");
    expect(
      binding.record.operation.reservation.inputs.map(({ keysetId, proofId }) => [
        keysetId,
        proofId,
      ]),
    ).toEqual([
      [
        preparation.offerKeyset.id,
        deriveDurableCustodyProofId({
          scopeId: scope.scopeId,
          normalizedMint: MINT_URL,
          unit: "msat",
          keysetId: preparation.offerKeyset.id,
          secret: offeredInput.secret,
        }),
      ],
      [
        preparation.receiveKeyset.id,
        deriveDurableCustodyProofId({
          scopeId: scope.scopeId,
          normalizedMint: MINT_URL,
          unit: "msat",
          keysetId: preparation.receiveKeyset.id,
          secret: collateralInput.secret,
        }),
      ],
    ]);

    const predecessors = browserMixedSourcePredecessorProofRows(scope, preparation, operation, 100);
    expect(
      predecessors.offeredInputs.map(({ proof, conditionalKeyset }) => [
        proof.keysetId,
        proof.assetKind,
        proof.conditionId,
        proof.outcomeCollection,
        conditionalKeyset?.keysetId,
      ]),
    ).toEqual([
      [
        preparation.offerKeyset.id,
        "conditional",
        CONDITION_ID,
        OUTCOME,
        preparation.offerKeyset.id,
      ],
    ]);
    expect(
      predecessors.collateralInputs.map(({ proof, conditionalKeyset }) => [
        proof.keysetId,
        proof.assetKind,
        proof.conditionId,
        proof.outcomeCollection,
        conditionalKeyset,
      ]),
    ).toEqual([[preparation.receiveKeyset.id, "regular", null, null, undefined]]);

    const requests: CtfConvertRequest[] = [];
    const result = await completeCtfRangeMixedSourceOperation({
      operation,
      preparation,
      seed,
      transport: {
        postConvert: async (request): Promise<CtfConvertResponse> => {
          requests.push(request);
          return {
            signatures: Object.fromEntries(
              Object.entries(request.outputs).map(([collection, messages]) => [
                collection,
                messages.map(signBlindedMessage),
              ]),
            ),
          };
        },
      },
    });
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!.inputs).sort()).toEqual(["*", OUTCOME]);
    expect(requests[0]!.inputs[OUTCOME]!.map(({ id }) => id)).toEqual([preparation.offerKeyset.id]);
    expect(requests[0]!.inputs["*"]!.map(({ id }) => id)).toEqual([preparation.receiveKeyset.id]);
    expect(
      requests[0]!.outputs[OUTCOME]!.every(({ id }) => id === preparation.offerKeyset.id),
    ).toBe(true);
    expect(requests[0]!.outputs["*"]!.every(({ id }) => id === preparation.receiveKeyset.id)).toBe(
      true,
    );

    const successors = browserMixedSourceSuccessorProofRows(
      scope,
      preparation,
      operation,
      result,
      101,
    );
    expect(
      successors.authorization.map(({ proof, conditionalKeyset }) => [
        proof.keysetId,
        proof.assetKind,
        proof.conditionId,
        proof.outcomeCollection,
        conditionalKeyset?.keysetId,
      ]),
    ).toEqual(
      result.authorization.map(() => [
        preparation.offerKeyset.id,
        "conditional",
        CONDITION_ID,
        OUTCOME,
        preparation.offerKeyset.id,
      ]),
    );
    expect(
      successors.offeredChange.map(({ proof, derivationLocator, conditionalKeyset }) => [
        proof.keysetId,
        proof.assetKind,
        conditionalKeyset?.keysetId,
        derivationLocator?.kind,
        derivationLocator?.kind === "nut13" ? derivationLocator.keysetId : null,
      ]),
    ).toEqual(
      result.offeredChange.map(() => [
        preparation.offerKeyset.id,
        "conditional",
        preparation.offerKeyset.id,
        "nut13",
        preparation.offerKeyset.id,
      ]),
    );
    expect(
      successors.collateralChange.map(({ proof, derivationLocator, conditionalKeyset }) => [
        proof.keysetId,
        proof.assetKind,
        conditionalKeyset,
        derivationLocator?.kind,
        derivationLocator?.kind === "nut13" ? derivationLocator.keysetId : null,
      ]),
    ).toEqual(
      result.collateralChange.map(() => [
        preparation.receiveKeyset.id,
        "regular",
        undefined,
        "nut13",
        preparation.receiveKeyset.id,
      ]),
    );

    const persisted = browserPersistedMixedSourceResult(result);
    const restored = decodeBrowserPersistedMixedSourceResult(persisted);
    expect(proofIdentities(restored)).toEqual(proofIdentities(result));
    expect(() =>
      browserMixedSourceSuccessorProofRows(
        scope,
        preparation,
        operation,
        {
          ...result,
          offeredChange: result.offeredChange.map((proof, index) =>
            index === 0 ? { ...proof, secret: "foreign-change" } : proof,
          ),
        },
        102,
      ),
    ).toThrow(/does not match its exact output plan/);
    await expect(
      createBrowserRangeSourceBinding(scope, preparation, seed, {
        ...operation,
        metadata: { ...operation.metadata, endpoint: "POST /v1/swap" },
      }),
    ).rejects.toThrow(/source mode is invalid/);
  });

  it("keeps the existing same-keyset source boundary on POST /v1/swap", async () => {
    const preparation = persistedPreparation("same-keyset-source");
    const seed = new Uint8Array(64).fill(8);
    const operation = await prepareCtfRangeSourceOperation({
      preparation,
      seed,
      counterSource: testCounterSource(),
      candidates: [
        {
          id: preparation.offerKeyset.id,
          amount: Amount.from(1_024),
          secret: "same-keyset-held-input",
          C: PUBLIC_KEY,
        },
      ],
      wallet: conditionalSourceWallet(),
    });
    if (operation === null) throw new Error("same-keyset source operation required");

    const binding = await createBrowserRangeSourceBinding(
      browserWalletScope(seed),
      preparation,
      seed,
      operation,
    );
    expect(binding.record.operation.exactRequest.path).toBe("/v1/swap");
  });
});

function persistedPreparation(operationId: string): PersistedCtfRangeOrderPreparation {
  const outcomeKeysetId = deriveConditionalKeysetId({
    keys: KEYS,
    unit: "msat",
    input_fee_ppk: INPUT_FEE_PPK,
    final_expiry: FINAL_EXPIRY,
    conditionId: CONDITION_ID,
    outcomeCollectionId: OUTCOME_COLLECTION_ID,
  });
  const complementKeysetId = deriveConditionalKeysetId({
    keys: KEYS,
    unit: "msat",
    input_fee_ppk: INPUT_FEE_PPK,
    final_expiry: FINAL_EXPIRY,
    conditionId: CONDITION_ID,
    outcomeCollectionId: COMPLEMENT_COLLECTION_ID,
  });
  const conditionalKeysets = [
    {
      keysetId: outcomeKeysetId,
      conditionId: CONDITION_ID,
      unit: "msat" as const,
      inputFeePpk: INPUT_FEE_PPK,
      finalExpiry: FINAL_EXPIRY,
      outcomeCollection: OUTCOME,
      outcomeCollectionId: OUTCOME_COLLECTION_ID,
      registeredAt: 10,
      keys: KEYS,
    },
    {
      keysetId: complementKeysetId,
      conditionId: CONDITION_ID,
      unit: "msat" as const,
      inputFeePpk: INPUT_FEE_PPK,
      finalExpiry: FINAL_EXPIRY,
      outcomeCollection: COMPLEMENT,
      outcomeCollectionId: COMPLEMENT_COLLECTION_ID,
      registeredAt: 10,
      keys: KEYS,
    },
  ];
  const mintFacts = {
    regular: [
      {
        canonicalMintUrl: MINT_URL,
        id: REGULAR_KEYSET_ID,
        unit: "msat" as const,
        active: true as const,
        keys: KEYS,
        inputFeePpk: INPUT_FEE_PPK,
        finalExpiry: FINAL_EXPIRY,
      },
    ],
    conditional: conditionalKeysets.map(({ keysetId, ...keyset }) => ({
      ...keyset,
      canonicalMintUrl: MINT_URL,
      id: keysetId,
      active: true as const,
    })),
    maxInputs: 64,
    maxPoolEntries: 128,
    observation: {
      canonicalMintUrl: MINT_URL,
      freshness: "fresh" as const,
      observedAt: 20,
      maxExpirySeconds: FINAL_EXPIRY,
      conditionKeysetIds: [outcomeKeysetId, complementKeysetId],
      conditionalKeysets,
    },
  };
  const request: CtfRangeOrderRequest = {
    clientOrderId: `client-${operationId}`,
    marketId: `${CONDITION_ID}-${OUTCOME}`,
    conditionId: CONDITION_ID,
    outcomeId: "yes-id",
    tokenSide: "Outcome",
    side: "Sell",
    price: 2,
    maxQuotePaymentSubunits: null,
    minQuotePaymentSubunits: 2,
    amountSubunits: 1_000,
    minimumFillAmountSubunits: 1_000,
    baseAsset: "sat",
    collateralUnit: "msat",
    divisibility: 1_000,
    timeInForce: "FOK",
    expiresAt: null,
    mintUrl: MINT_URL,
  };
  let id = 0;
  return buildPersistedCtfRangeOrderPreparation({
    request,
    coordinatorPublicKey: COORDINATOR_PUBLIC_KEY,
    mintFacts,
    market: {
      outcomes: [
        { id: "yes-id", label: OUTCOME },
        { id: "no-id", label: COMPLEMENT },
      ],
    },
    nowUnixSeconds: 20,
    randomId: () => (id++ === 0 ? operationId : `${operationId}:authorization`),
  });
}

function testCounterSource() {
  const nextByKeyset = new Map<string, number>();
  return {
    reserve: async (keysetId: string, count: number) => {
      const start = nextByKeyset.get(keysetId) ?? 10;
      nextByKeyset.set(keysetId, start + count);
      return { start, count };
    },
    advanceToAtLeast: async (keysetId: string, minNext: number) => {
      nextByKeyset.set(keysetId, Math.max(nextByKeyset.get(keysetId) ?? 10, minNext));
    },
  };
}

function conditionalSourceWallet(): CtfRangeSourceWallet {
  return {
    prepareSwapToSend: async () => {
      throw new Error("unexpected regular source");
    },
    completeSwap: async () => ({ keep: [], send: [] }),
    prepareConditionalSwap: async ({ keysetId, inputs, outputs }) => ({
      keysetId,
      inputs,
      outputDataByLabel: Object.fromEntries(
        outputs.map((output) => [output.label, output.kind === "custom" ? output.data : []]),
      ),
    }),
    completeConditionalSwap: async () => ({}),
  };
}

function signBlindedMessage(output: SerializedBlindedMessage): SerializedBlindedSignature {
  const signature = createBlindSignature(pointFromHex(output.B_), PRIVATE_KEY, output.id);
  const dleq = createDLEQProof(pointFromHex(output.B_), PRIVATE_KEY);
  return {
    id: signature.id,
    amount: Amount.from(output.amount),
    C_: signature.C_.toHex(true),
    dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
  };
}

function proofIdentities(result: {
  readonly authorization: readonly Proof[];
  readonly offeredChange: readonly Proof[];
  readonly collateralChange: readonly Proof[];
}) {
  return Object.fromEntries(
    Object.entries(result).map(([group, proofs]) => [
      group,
      proofs.map(({ id, amount, secret, C }) => [id, Number(amount), secret, C]),
    ]),
  );
}
