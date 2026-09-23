import "fake-indexeddb/auto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/curves/utils.js";
import {
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveKeysetId,
  hashToCurve,
  pointFromHex,
  type CounterSource,
  type MintKeys,
  type OutputData,
  type Proof,
} from "@cashu/cashu-ts";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import { readPreparedDurableCtfRedeemRequest } from "@bitcaster/client-sdk/ctfRedeem";
import { assertDurableCustodyMintOperationAuthority } from "@bitcaster/client-sdk/durableCustodyMintResult";
import { createBrowserProofBackupAuthorityRow } from "../../../stores/browser-proof-backup-authority";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
} from "../../../stores/durable-custody-db";
import { BitcasterDB } from "../../../stores/proof-db";
import { browserWalletScope } from "../../browserCtfRangeOrderSource";
import {
  bindBrowserCanonicalCtfRedeemLeg,
  type BrowserCanonicalCtfRedeemBindingInput,
} from "../../browserCtfRedeemCoordinator";
import {
  readBrowserCanonicalCtfRedeemLegs,
  type BrowserCtfRedeemLeg,
} from "../../browserCtfRedeemSelection";

export const MINT = "https://mint.example";
export const CONDITION = "aa".repeat(32);
export const OUTCOME = "Alpha";
export const OUTCOME_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION,
  outcomeCollection: OUTCOME,
});
export const SEED = new Uint8Array(64).fill(7);
export const INPUT_Y = hashToCurve(new TextEncoder().encode("ctf-input")).toHex(true);
export const MINT_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 1]);
export const MINT_PUBLIC_KEY = bytesToHex(secp256k1.getPublicKey(MINT_PRIVATE_KEY, true));
export const KEYS = { "1": MINT_PUBLIC_KEY };
export const CONDITIONAL_KEYSET_ID = deriveConditionalKeysetId({
  keys: KEYS,
  unit: "msat",
  input_fee_ppk: 0,
  conditionId: CONDITION,
  outcomeCollectionId: OUTCOME_ID,
});
export function conditionalKeysetIdFor(index: number): string {
  return deriveConditionalKeysetId({
    keys: KEYS,
    unit: "msat",
    input_fee_ppk: index,
    conditionId: CONDITION,
    outcomeCollectionId: OUTCOME_ID,
  });
}
export const REGULAR_KEYSET: MintKeys = {
  id: deriveKeysetId(KEYS, { unit: "msat", input_fee_ppk: 0, versionByte: 1 }),
  unit: "msat",
  active: true,
  keys: KEYS,
  input_fee_ppk: 0,
};

export const immediateLockManager = {
  request: (async (_name: string, _options: LockOptions, action: LockGrantedCallback<unknown>) =>
    action(null)) as LockManager["request"],
};

export interface BrowserCtfRedeemFixture {
  readonly database: BitcasterDB;
  readonly adapter: BrowserDurableCustodyAdapter;
  readonly scope: ReturnType<typeof browserWalletScope>;
  readonly proof: Awaited<ReturnType<typeof createBrowserCustodyProofRow>>;
  readonly proofs: readonly Awaited<ReturnType<typeof createBrowserCustodyProofRow>>[];
  readonly legs: readonly BrowserCtfRedeemLeg[];
  readonly counters: CounterSource;
  readonly owner: Awaited<ReturnType<BrowserDurableCustodyAdapter["claimScope"]>>;
  readonly bind: () => ReturnType<typeof bindBrowserCanonicalCtfRedeemLeg>;
  readonly bindLeg: (
    leg: BrowserCtfRedeemLeg,
  ) => ReturnType<typeof bindBrowserCanonicalCtfRedeemLeg>;
}

export async function fixture(
  input: { readonly amounts?: readonly number[] } = {},
): Promise<BrowserCtfRedeemFixture> {
  const amounts = input.amounts ?? [1];
  const database = new BitcasterDB(`ctf-redeem-bind-${crypto.randomUUID()}`);
  const scope = browserWalletScope(SEED);
  const proofs = amounts.map((amount, index) =>
    createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: {
        id: conditionalKeysetIdFor(index),
        amount: amount as never,
        secret: index === 0 ? "ctf-input" : `ctf-input-${index}`,
        C: MINT_PUBLIC_KEY,
      },
      asset: { kind: "conditional", conditionId: CONDITION, outcomeCollection: OUTCOME },
      receivedAtMs: 1,
    }),
  );
  for (const proof of proofs) {
    await database.custodyProofs.put(proof);
    await database.custodyProofBackupAuthorities.put(
      createBrowserProofBackupAuthorityRow(proof, 2, null, "ctf-receive"),
    );
  }
  for (const [index] of amounts.entries()) {
    await database.custodyConditionalKeysets.put({
      schemaVersion: 1,
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      keysetId: conditionalKeysetIdFor(index),
      denominationPublicKeys: KEYS,
      inputFeePpk: index,
      conditionId: CONDITION,
      outcomeCollection: OUTCOME,
      outcomeCollectionId: OUTCOME_ID,
      registeredAtUnixSeconds: 0,
      finalExpiryUnixSeconds: null,
      curve: "secp256k1",
    });
  }
  const adapter = new BrowserDurableCustodyAdapter(database);
  const owner = await adapter.claimScope(scope, {
    incarnationId: "ctf-redeem-test",
    observedAtMs: 3,
    leaseExpiresAtMs: 100_000,
  });
  const legs: BrowserCtfRedeemLeg[] = [];
  for await (const leg of readBrowserCanonicalCtfRedeemLegs({
    scopeId: scope.scopeId,
    mintUrl: MINT,
    conditionId: CONDITION,
    outcomeCollection: OUTCOME,
    database,
  })) {
    legs.push(leg);
  }
  if (legs.length === 0) throw new Error("CTF redeem test leg is missing");
  let nextCounter = 0;
  const counters: CounterSource = {
    reserve: async (_keysetId, count) => {
      const start = nextCounter;
      nextCounter += count;
      return { start, count };
    },
    advanceToAtLeast: async (_keysetId, minimum) => {
      nextCounter = Math.max(nextCounter, minimum);
    },
  };
  const bindInput = (leg: BrowserCtfRedeemLeg): BrowserCanonicalCtfRedeemBindingInput => ({
    seed: SEED,
    mintUrl: MINT,
    conditionId: CONDITION,
    outcomeCollection: OUTCOME,
    oracleWitness: '{"oracle_sig":"test"}',
    leg,
    regularKeyset: REGULAR_KEYSET,
    counterSource: counters,
    database,
    adapter,
    owner,
    lockManager: immediateLockManager,
  });
  return {
    database,
    adapter,
    scope,
    proof: proofs[0]!,
    proofs,
    legs,
    counters,
    owner,
    bind: () => bindBrowserCanonicalCtfRedeemLeg(bindInput(legs[0]!)),
    bindLeg: (leg) => bindBrowserCanonicalCtfRedeemLeg(bindInput(leg)),
  };
}

export async function signedPayout(
  adapter: BrowserDurableCustodyAdapter,
  scope: ReturnType<typeof browserWalletScope>,
  operationId: string,
): Promise<Proof[]> {
  const snapshot = await adapter.readOperationSnapshot(scope, operationId);
  if (!snapshot) throw new Error("CTF redeem test operation is missing");
  const exactAuthority = snapshot.artifacts.find(
    ({ reference }) =>
      reference.artifactId ===
      snapshot.record.operation.privateMaterial.exactPrivateMaterial.artifactId,
  )?.artifact;
  if (!exactAuthority) throw new Error("CTF redeem test authority is missing");
  const authority = assertDurableCustodyMintOperationAuthority(snapshot.record, exactAuthority);
  return readPreparedDurableCtfRedeemRequest({
    operation: authority.operation,
    seed: SEED,
    regularKeyset: REGULAR_KEYSET,
  }).outputs.map(signOutput);
}

export function signOutputs(outputs: readonly OutputData[]): Proof[] {
  return outputs.map(signOutput);
}

function signOutput(output: OutputData): Proof {
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    MINT_PRIVATE_KEY,
    output.blindedMessage.id,
  );
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), MINT_PRIVATE_KEY);
  return output.toProof(
    {
      id: signature.id,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    REGULAR_KEYSET,
  );
}

export async function disposeFixtures(): Promise<void> {
  // Fixture databases use unique names and remain isolated for the test run.
}
