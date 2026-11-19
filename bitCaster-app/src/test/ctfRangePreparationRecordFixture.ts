import { mintDenominationKeys } from "../../../bitcaster-client-sdk/test/support/mintDenominationKeys.ts";
import { deriveConditionalKeysetId, deriveKeysetId } from "@cashu/cashu-ts";
import type { DurableCustodyScope } from "@bitcaster/client-sdk/durableCustody";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import {
  buildPersistedCtfRangeOrderPreparation,
  type CtfRangeOrderRequest,
} from "@bitcaster/client-sdk/ctfRangeOrderProtocol";
import type {
  CtfRangeOrderPreparationCapability,
  CtfRangeOrderPreparationLifecycle,
  CtfRangeOrderPreparationRecord,
} from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import { browserRangeJournalIdentity } from "@/lib/browserCtfRangeOrderSource";

export const RANGE_FIXTURE_MINT_URL = "https://mint.example";
export const RANGE_FIXTURE_CONDITION_ID = "ab".repeat(32);
export const RANGE_FIXTURE_OUTCOME = "YES";
/** The mint charges 100 ppk for each input, so one to ten inputs cost 1 msat. */
export const RANGE_FIXTURE_INPUT_FEE_PPK = 100;

const COMPLEMENT = "NO";
const COORDINATOR_PUBLIC_KEY = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
const FINAL_EXPIRY = 1_000;
const KEYS = mintDenominationKeys(
  Uint8Array.from([...new Uint8Array(31), 1]),
  Array.from({ length: 21 }, (_, index) => (1 << index).toString()),
);

/**
 * A journal record whose preparation bytes decode, for a binary YES/NO market
 * with divisibility 1,000. Display code can plan its authorization inputs.
 */
export function ctfRangePreparationRecordFixture(input: {
  readonly scopeId: string;
  readonly operationId: string;
  readonly side: "Buy" | "Sell";
  readonly tokenSide?: "Outcome" | "Complement";
  readonly price: number;
  readonly amountSubunits: number;
  readonly lifecycleState?: CtfRangeOrderPreparationLifecycle;
  readonly capability?: CtfRangeOrderPreparationCapability | null;
  readonly createdAtMs?: number;
}): CtfRangeOrderPreparationRecord {
  const tokenSide = input.tokenSide ?? "Outcome";
  const quote = (input.amountSubunits / 1_000) * input.price;
  const request: CtfRangeOrderRequest = {
    clientOrderId: `client-${input.operationId}`,
    marketId: `${RANGE_FIXTURE_CONDITION_ID}-${RANGE_FIXTURE_OUTCOME}`,
    conditionId: RANGE_FIXTURE_CONDITION_ID,
    outcomeId: "yes-id",
    tokenSide,
    side: input.side,
    price: input.price,
    maxQuotePaymentSubunits: input.side === "Buy" ? quote : null,
    minQuotePaymentSubunits: input.side === "Sell" ? quote : null,
    amountSubunits: input.amountSubunits,
    minimumFillAmountSubunits: input.amountSubunits,
    baseAsset: "sat",
    collateralUnit: "msat",
    divisibility: 1_000,
    timeInForce: "FOK",
    expiresAt: null,
    mintUrl: RANGE_FIXTURE_MINT_URL,
  };
  let id = 0;
  const preparation = buildPersistedCtfRangeOrderPreparation({
    request,
    coordinatorPublicKey: COORDINATOR_PUBLIC_KEY,
    mintFacts: mintFacts(),
    market: {
      outcomes: [
        { id: "yes-id", label: RANGE_FIXTURE_OUTCOME },
        { id: "no-id", label: COMPLEMENT },
      ],
    },
    nowUnixSeconds: 20,
    randomId: () => (id++ === 0 ? input.operationId : `${input.operationId}:authorization`),
  });
  const lifecycleState = input.lifecycleState ?? "order-submitted";
  const createdAtMs = input.createdAtMs ?? 1;
  return {
    ...browserRangeJournalIdentity(
      { scopeId: input.scopeId } as DurableCustodyScope,
      preparation,
      createdAtMs,
    ),
    lifecycleState,
    revision: 3,
    capability:
      input.capability !== undefined
        ? input.capability
        : bindsCapability(lifecycleState)
          ? FIXTURE_CAPABILITY
          : null,
    updatedAtMs: createdAtMs + 1,
  };
}

const FIXTURE_CAPABILITY: CtfRangeOrderPreparationCapability = {
  artifactId: "11111111-1111-4111-8111-111111111111",
  orderId: "11111111-1111-4111-8111-111111111111",
  bindingDigest: "22".repeat(32),
  artifactDigest: "33".repeat(32),
};

/** The journal states that the SDK accepts only with a bound capability. */
function bindsCapability(lifecycleState: CtfRangeOrderPreparationLifecycle): boolean {
  switch (lifecycleState) {
    case "capability-bound":
    case "order-submitted":
    case "submission-rejected":
      return true;
    case "prepared":
    case "order-requested":
    case "order-request-rejected":
    case "capability-requested":
    case "terminal":
      return false;
    default:
      throw new Error(`unknown journal state: ${String(lifecycleState)}`);
  }
}

function mintFacts() {
  const collectionId = (outcomeCollection: string) =>
    deriveRootCtfOutcomeCollectionId({
      conditionId: RANGE_FIXTURE_CONDITION_ID,
      outcomeCollection,
    });
  const conditionalKeysets = [RANGE_FIXTURE_OUTCOME, COMPLEMENT].map((outcomeCollection) => ({
    keysetId: deriveConditionalKeysetId({
      keys: KEYS,
      unit: "msat",
      input_fee_ppk: RANGE_FIXTURE_INPUT_FEE_PPK,
      final_expiry: FINAL_EXPIRY,
      conditionId: RANGE_FIXTURE_CONDITION_ID,
      outcomeCollectionId: collectionId(outcomeCollection),
    }),
    conditionId: RANGE_FIXTURE_CONDITION_ID,
    unit: "msat" as const,
    inputFeePpk: RANGE_FIXTURE_INPUT_FEE_PPK,
    finalExpiry: FINAL_EXPIRY,
    outcomeCollection,
    outcomeCollectionId: collectionId(outcomeCollection),
    registeredAt: 10,
    keys: KEYS,
  }));
  return {
    // Already-reviewed metadata. The SDK registration tests cover its verification.
    registration: {
      normalizedMint: RANGE_FIXTURE_MINT_URL,
      conditionId: RANGE_FIXTURE_CONDITION_ID,
      canonicalParentCollectionId: null,
      unit: "msat" as const,
      eventId: "browser-fixture-event",
      outcomes: [RANGE_FIXTURE_OUTCOME, COMPLEMENT],
      threshold: 1,
      oracles: [
        {
          oraclePublicKey: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
          noncePoint: "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
          announcementIdentity: "aa".repeat(32),
        },
      ],
    },
    regular: [
      {
        canonicalMintUrl: RANGE_FIXTURE_MINT_URL,
        id: deriveKeysetId(KEYS, {
          unit: "msat",
          input_fee_ppk: RANGE_FIXTURE_INPUT_FEE_PPK,
          expiry: FINAL_EXPIRY,
          versionByte: 1,
        }),
        unit: "msat" as const,
        active: true as const,
        keys: KEYS,
        inputFeePpk: RANGE_FIXTURE_INPUT_FEE_PPK,
        finalExpiry: FINAL_EXPIRY,
      },
    ],
    conditional: conditionalKeysets.map(({ keysetId, ...keyset }) => ({
      ...keyset,
      canonicalMintUrl: RANGE_FIXTURE_MINT_URL,
      id: keysetId,
      active: true as const,
    })),
    maxInputs: 64,
    maxPoolEntries: 128,
    observation: {
      canonicalMintUrl: RANGE_FIXTURE_MINT_URL,
      freshness: "fresh" as const,
      observedAt: 20,
      maxExpirySeconds: FINAL_EXPIRY,
      conditionKeysetIds: conditionalKeysets.map(({ keysetId }) => keysetId),
      conditionalKeysets,
    },
  };
}
