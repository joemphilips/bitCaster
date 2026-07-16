import {
  Amount,
  getEncodedTokenV4,
  OutputData,
  type Proof,
  type SwapPreview,
} from "@cashu/cashu-ts";
import {
  createDurableCustodyProofOperation,
} from "../src/durableCustodyProofOperationRecord.ts";
import {
  createDurableProofOperationFacts,
  deriveDurableCustodyScopeId,
  stageDurableCustodyWalletSendExactPayload,
  reduceDurableCustodyState,
  type DurableCustodyState,
} from "../src/durableCustody.ts";
import {
  createDurableWalletSendOperation,
  toDurableCustodyProofOperationInput,
} from "../src/durableWalletOperation.ts";
import {
  planDurableWalletSendDeliveryAdmission,
} from "../src/durableWalletSendDelivery.ts";
import {
  prepareDurableWalletSendDelivery,
  type DurableWalletSendDeliveryPolicy,
} from "../src/durableWalletSendDeliveryPreparation.ts";
import {
  planDurableWalletSendExactPayload,
} from "../src/durableWalletSendExactPayload.ts";

const KEYSET_ID = "0011223344556677";
const SECP_PUBLIC_KEY = `02${"11".repeat(32)}`;

export const recipientOwnerAuthorization = {
  incarnationId: "worker-001",
  fencingEpoch: 7,
  observedAtMs: 1_500,
};

export function createRecipientDeliveryFixture(input?: {
  policy?: DurableWalletSendDeliveryPolicy;
  amount?: number;
}) {
  const amount = input?.amount ?? 1;
  const walletOperation = createDurableWalletSendOperation({
    operationId: "wallet-send-001",
    mintUrl: "https://mint.example",
    unit: "sat",
    preview: walletSendPreview(amount),
  });
  const policy =
    input?.policy ??
    ({
      kind: "durable-recipient-ack",
      recipient: {
        deliveryId: "payment-1",
        accountSubject: "account:alice",
        recipientKind: "matching-engine",
        purpose: "participation-score",
        destinationId: "participation-score",
        mintUrl: "https://mint.example",
        unit: "sat",
        requestedAmount: String(amount),
        creditPolicy: { kind: "exact-amount" },
      },
    } satisfies DurableWalletSendDeliveryPolicy);
  const admission = planDurableWalletSendDeliveryAdmission({
    outputPlan: {
      mintUrl: walletOperation.mintUrl,
      unit: walletOperation.unit,
      sendOutputs: walletOperation.preview.sendOutputs,
      keepOutputs: walletOperation.preview.keepOutputs,
      passthroughProofs: walletOperation.preview.unselectedProofs,
      inputProofs: walletOperation.preview.inputs,
    },
    limits: {
      encodedTokenBytes: 1_024 * 1_024,
      proofCount: 256,
      durableStorageBytes: 10 * 1_024 * 1_024,
      nativeOperationRowBytes: 1 * 1_024 * 1_024,
    },
  });
  const preparation = prepareDurableWalletSendDelivery({
    walletOperation,
    policy,
    admission,
  });
  const sendOutput = walletOperation.preview.sendOutputs[0]!;
  const sendProof: Proof = {
    id: sendOutput.blindedMessage.id,
    amount: Amount.from(sendOutput.blindedMessage.amount),
    secret: new TextDecoder().decode(hexToBytes(sendOutput.secret)),
    C: `02${"22".repeat(32)}`,
  };
  const resultGroups = { keep: [], send: [sendProof] };
  const encodedToken = getEncodedTokenV4({
    mint: walletOperation.mintUrl,
    unit: walletOperation.unit,
    proofs: [sendProof],
  });
  const exactPayload = planDurableWalletSendExactPayload({
    preparation,
    walletOperation,
    resultGroups,
    payloadHandle: "wallet-send-token-001",
    encodedToken,
  });
  return {
    walletOperation,
    preparation,
    resultGroups,
    encodedToken,
    exactPayload,
  };
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(
    value.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
}

export function createRecipientCustodyState(
  fixture: ReturnType<typeof createRecipientDeliveryFixture>,
): DurableCustodyState {
  const scopeInput = {
    scopeKind: "wallet" as const,
    walletId: "a".repeat(64),
  };
  const scope = {
    ...scopeInput,
    scopeId: deriveDurableCustodyScopeId(scopeInput),
  };
  const operation = toDurableCustodyProofOperationInput(
    fixture.walletOperation,
  );
  const facts = createDurableProofOperationFacts({
    unit: "sat",
    binding: {
      kind: "wallet",
      activityId: fixture.preparation.activityId,
      stage: "send",
    },
    horizon: {
      notBeforeMs: null,
      notAfterMs: null,
      safetyMarginMs: 0,
    },
    hasOutputs: true,
    inputKeysetRequirement: "required",
    keysets: [
      {
        keysetId: KEYSET_ID,
        unit: "sat",
        curve: "secp256k1",
        publicKeys: { "1": SECP_PUBLIC_KEY },
        keysetExpiryMs: null,
        requireDleq: false,
        usedByInputs: true,
        usedByOutputs: true,
      },
    ],
  });
  const custody = createDurableCustodyProofOperation({
    scope,
    operation,
    facts,
    inventoryAccountId: null,
    walletSendDeliveryPreparation: fixture.preparation,
  });
  let state: DurableCustodyState = {
    operation: custody,
    scopeState: {
      schemaVersion: 1,
      scope,
      fencingEpoch: 7,
      owner: {
        incarnationId: "worker-001",
        leaseExpiresAtMs: 10_000,
      },
      effectiveClock: { highWaterMarkMs: 1_000 },
    },
  };
  state = reduceDurableCustodyState(state, {
    kind: "transport-attempted",
    ...recipientOwnerAuthorization,
  });
  state = reduceDurableCustodyState(state, {
    kind: "verified-result-staged",
    resultHandle: "wallet-send-result-001",
    resultFingerprint: fixture.exactPayload.resultFingerprint,
    outputPlanFingerprint: state.operation.operation.outputPlan
      .outputPlanFingerprint,
    ...recipientOwnerAuthorization,
  });
  state = reduceDurableCustodyState(state, {
    kind: "reconciled",
    recoverySource: "transport-attempted",
    ...recipientOwnerAuthorization,
  });
  return stageDurableCustodyWalletSendExactPayload(state, {
    exactPayload: fixture.exactPayload,
    ...recipientOwnerAuthorization,
  });
}

function walletSendPreview(amount: number): SwapPreview {
  const output = new OutputData(
    {
      amount: Amount.from(amount),
      id: KEYSET_ID,
      B_: `02${"33".repeat(32)}`,
    },
    2n,
    new Uint8Array(32).fill(0x44),
  );
  return {
    amount: Amount.from(amount),
    fees: Amount.from(0),
    keysetId: KEYSET_ID,
    inputs: [
      {
        id: KEYSET_ID,
        amount: Amount.from(amount),
        secret: "55".repeat(32),
        C: `02${"66".repeat(32)}`,
      },
    ],
    sendOutputs: [output],
    keepOutputs: [],
    unselectedProofs: [],
  };
}
