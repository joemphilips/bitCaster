// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/curves/utils.js";
import {
  CheckStateEnum,
  deriveConditionalKeysetId,
  deriveKeysetId,
  createBlindSignature,
  createDLEQProof,
  hashToCurve,
  pointFromHex,
  type CounterSource,
  type MintKeys,
  type OutputData,
  type Proof,
} from "@cashu/cashu-ts";
import { readPreparedDurableCtfRedeemRequest } from "@bitcaster/client-sdk/ctfRedeem";
import { assertDurableCustodyMintOperationAuthority } from "@bitcaster/client-sdk/durableCustodyMintResult";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import { createBrowserProofBackupAuthorityRow } from "../../stores/browser-proof-backup-authority";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
} from "../../stores/durable-custody-db";
import { BitcasterDB } from "../../stores/proof-db";
import { browserWalletScope } from "../browserCtfRangeOrderSource";
import {
  bindBrowserCanonicalCtfRedeemLeg,
  commitBrowserCanonicalCtfRedeemResult,
  markBrowserCanonicalCtfRedeemTransportAttempted,
  recoverBrowserCanonicalCtfRedeemOperation,
} from "../browserCtfRedeemCoordinator";
import { readBrowserCanonicalCtfRedeemLegs } from "../browserCtfRedeemSelection";

const MINT = "https://mint.example";
const CONDITION = "aa".repeat(32);
const OUTCOME = "Alpha";
const OUTCOME_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION,
  outcomeCollection: OUTCOME,
});
const SEED = new Uint8Array(64).fill(7);
const INPUT_Y = hashToCurve(new TextEncoder().encode("ctf-input")).toHex(true);
const MINT_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 1]);
const MINT_PUBLIC_KEY = bytesToHex(secp256k1.getPublicKey(MINT_PRIVATE_KEY, true));
const KEYS = { "1": MINT_PUBLIC_KEY };
const CONDITIONAL_KEYSET_ID = deriveConditionalKeysetId({
  keys: KEYS,
  unit: "msat",
  input_fee_ppk: 0,
  conditionId: CONDITION,
  outcomeCollectionId: OUTCOME_ID,
});
const REGULAR_KEYSET: MintKeys = {
  id: deriveKeysetId(KEYS, { unit: "msat", input_fee_ppk: 0, versionByte: 1 }),
  unit: "msat",
  active: true,
  keys: KEYS,
  input_fee_ppk: 0,
};
const databases: BitcasterDB[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

async function fixture() {
  const database = new BitcasterDB(`ctf-redeem-bind-${crypto.randomUUID()}`);
  databases.push(database);
  const scope = browserWalletScope(SEED);
  const proof = createBrowserCustodyProofRow({
    scopeId: scope.scopeId,
    normalizedMint: MINT,
    unit: "msat",
    proof: {
      id: CONDITIONAL_KEYSET_ID,
      amount: 1 as never,
      secret: "ctf-input",
      C: MINT_PUBLIC_KEY,
    },
    asset: { kind: "conditional", conditionId: CONDITION, outcomeCollection: OUTCOME },
    receivedAtMs: 1,
  });
  await database.custodyProofs.put(proof);
  await database.custodyProofBackupAuthorities.put(
    createBrowserProofBackupAuthorityRow(proof, 2, null, "ctf-receive"),
  );
  await database.custodyConditionalKeysets.put({
    schemaVersion: 1,
    scopeId: scope.scopeId,
    normalizedMint: MINT,
    unit: "msat",
    keysetId: CONDITIONAL_KEYSET_ID,
    denominationPublicKeys: KEYS,
    inputFeePpk: 0,
    conditionId: CONDITION,
    outcomeCollection: OUTCOME,
    outcomeCollectionId: OUTCOME_ID,
    registeredAtUnixSeconds: 0,
    finalExpiryUnixSeconds: null,
    curve: "secp256k1",
  });
  const adapter = new BrowserDurableCustodyAdapter(database);
  const owner = await adapter.claimScope(scope, {
    incarnationId: "ctf-redeem-test",
    observedAtMs: 3,
    leaseExpiresAtMs: 100_000,
  });
  const { value: leg } = await readBrowserCanonicalCtfRedeemLegs({
    scopeId: scope.scopeId,
    mintUrl: MINT,
    conditionId: CONDITION,
    outcomeCollection: OUTCOME,
    database,
  }).next();
  if (!leg) throw new Error("CTF redeem test leg is missing");
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
  const bind = () =>
    bindBrowserCanonicalCtfRedeemLeg({
      seed: SEED,
      mintUrl: MINT,
      conditionId: CONDITION,
      outcomeCollection: OUTCOME,
      oracleWitness: '{"oracle_sig":"test"}',
      leg,
      regularKeyset: REGULAR_KEYSET,
      counterSource: counters,
      adapter,
      owner,
    });
  return { database, adapter, scope, proof, counters, owner, bind };
}

describe("browser canonical CTF redeem binding", () => {
  it("binds the exact selected predecessor and request before mint submission", async () => {
    const { adapter, database, scope, proof, counters, bind } = await fixture();

    const record = await bind();

    expect(record.operation.semanticKind).toBe("ctf-redeem");
    expect(record.operation.exactRequest.path).toBe("/v1/redeem_outcome");
    expect((await adapter.readProof(scope.scopeId, proof.proofId))?.selectability).toBe("locked");
    expect(
      (await adapter.readOperation(scope, record.operation.operationId))?.operation.state,
    ).toBe("dispatch-intent");
    expect(await database.custodyReservations.count()).toBe(1);
    expect((await counters.reserve(REGULAR_KEYSET.id, 0)).start).toBe(1);
  });

  it("refuses a disappeared canonical predecessor without leaving an operation", async () => {
    const { database, proof, bind } = await fixture();
    await database.custodyProofs.delete([proof.scopeId, proof.proofId]);
    await database.custodyProofBackupAuthorities.delete([proof.scopeId, proof.proofId]);

    const refused = await bind().then(
      () => false,
      (error: unknown) =>
        error instanceof Error && /predecessor proof is not persisted/.test(error.message),
    );

    expect(refused).toBe(true);
    expect(await database.custodyOperations.count()).toBe(0);
    expect(await database.custodyReservations.count()).toBe(0);
  });

  it("refuses a second preparation for a bound operation without new counters", async () => {
    const { bind, counters } = await fixture();
    await bind();

    const refused = await bind().then(
      () => false,
      (error: unknown) =>
        error instanceof Error && /requires persisted recovery/.test(error.message),
    );

    expect(refused).toBe(true);
    expect((await counters.reserve(REGULAR_KEYSET.id, 0)).start).toBe(1);
  });

  it("commits a verified winning payout with the exact canonical predecessor", async () => {
    const { bind, adapter, database, scope, proof, owner } = await fixture();
    const record = await bind();
    const payout = await signedPayout(adapter, scope, record.operation.operationId);
    const authorization = { ...owner, observedAtMs: 4 };
    await markBrowserCanonicalCtfRedeemTransportAttempted({
      seed: SEED,
      operationId: record.operation.operationId,
      adapter,
      owner: authorization,
    });

    const admitted = await commitBrowserCanonicalCtfRedeemResult({
      seed: SEED,
      operationId: record.operation.operationId,
      proofs: payout,
      adapter,
      owner: authorization,
      observedAtMs: 4,
    });

    expect(admitted.map(({ secret }) => secret)).toEqual(payout.map(({ secret }) => secret));
    expect((await adapter.readProof(scope.scopeId, proof.proofId))?.selectability).toBe("spent");
    expect(
      (await database.custodyProofs.toArray()).filter(
        ({ selectability }) => selectability === "selectable",
      ),
    ).toHaveLength(1);
    expect((await database.proofs.toArray()).map(({ secret }) => secret)).toEqual([
      payout[0]!.secret,
    ]);
    expect(
      (await adapter.readOperation(scope, record.operation.operationId))?.operation.result.state,
    ).toBe("applied");
  });

  it("refuses a payout before the mint attempt is durably recorded", async () => {
    const { bind, adapter, database, scope, proof } = await fixture();
    const record = await bind();
    const payout = await signedPayout(adapter, scope, record.operation.operationId);

    await expect(
      commitBrowserCanonicalCtfRedeemResult({
        seed: SEED,
        operationId: record.operation.operationId,
        proofs: payout,
        adapter,
        owner: {
          incarnationId: "ctf-redeem-test",
          fencingEpoch: 1,
          observedAtMs: 4,
        },
        observedAtMs: 4,
      }),
    ).rejects.toThrow(/transport attempt/);

    expect((await adapter.readProof(scope.scopeId, proof.proofId))?.selectability).toBe("locked");
    expect(
      (await adapter.readOperation(scope, record.operation.operationId))?.operation.state,
    ).toBe("dispatch-intent");
    expect(await database.proofs.count()).toBe(0);
  });

  it.each<{ name: string; change: (proof: Proof) => Proof }>([
    { name: "secret", change: (proof) => ({ ...proof, secret: `${proof.secret}-foreign` }) },
    { name: "signature", change: (proof) => ({ ...proof, C: MINT_PUBLIC_KEY }) },
    { name: "keyset", change: (proof) => ({ ...proof, id: CONDITIONAL_KEYSET_ID }) },
    { name: "amount", change: (proof) => ({ ...proof, amount: 2 as never }) },
    {
      name: "DLEQ",
      change: (proof) => ({
        ...proof,
        dleq: { ...proof.dleq!, e: "00".repeat(32) },
      }),
    },
  ])("rejects a mint result with the wrong $name before custody admission", async ({ change }) => {
    const { bind, adapter, database, scope, proof, owner } = await fixture();
    const record = await bind();
    const payout = await signedPayout(adapter, scope, record.operation.operationId);
    const authorization = { ...owner, observedAtMs: 4 };
    await markBrowserCanonicalCtfRedeemTransportAttempted({
      seed: SEED,
      operationId: record.operation.operationId,
      adapter,
      owner: authorization,
    });

    const refused = await commitBrowserCanonicalCtfRedeemResult({
      seed: SEED,
      operationId: record.operation.operationId,
      proofs: [change(payout[0]!)],
      adapter,
      owner: authorization,
      observedAtMs: 4,
    }).then(
      () => false,
      (error: unknown) => error instanceof Error,
    );

    expect(refused).toBe(true);
    expect((await adapter.readProof(scope.scopeId, proof.proofId))?.selectability).toBe("locked");
    expect(
      (await adapter.readOperation(scope, record.operation.operationId))?.operation.result.state,
    ).toBe("none");
    expect(await database.proofs.count()).toBe(0);
  });

  it("restores the exact payout after complete spent-input evidence", async () => {
    const entry = await fixture();
    const record = await entry.bind();
    const payout = await signedPayout(entry.adapter, entry.scope, record.operation.operationId);
    await markBrowserCanonicalCtfRedeemTransportAttempted({
      seed: SEED,
      operationId: record.operation.operationId,
      adapter: entry.adapter,
      owner: { ...entry.owner, observedAtMs: 4 },
    });
    let restoreCalls = 0;

    const result = await recover(
      entry,
      record.operation.operationId,
      {
        loadMint: async () => undefined,
        redeemOutcomeProofs: async () => {
          throw new Error("spent inputs must not be resubmitted");
        },
        checkProofsStates: async () => [{ Y: INPUT_Y, state: CheckStateEnum.SPENT, witness: null }],
      },
      async (_mintUrl, outputs, keyset) => {
        restoreCalls += 1;
        expect(outputs.regular).toHaveLength(1);
        expect(keyset.id).toBe(REGULAR_KEYSET.id);
        return { regular: payout };
      },
    );

    expect(result.kind).toBe("redeemed");
    expect(restoreCalls).toBe(1);
    expect(
      (await entry.adapter.readProof(entry.scope.scopeId, entry.proof.proofId))?.selectability,
    ).toBe("spent");
    expect(await entry.database.proofs.count()).toBe(1);
    const replay = await recover(
      entry,
      record.operation.operationId,
      {
        loadMint: async () => {
          throw new Error("completed replay must not contact mint");
        },
        redeemOutcomeProofs: async () => {
          throw new Error("completed replay must not redeem");
        },
      },
      async () => {
        throw new Error("completed replay must not restore");
      },
    );
    expect(replay).toEqual({ kind: "already-completed" });
    expect(await entry.database.proofs.count()).toBe(1);
  });

  it("leaves exact inputs reserved when mint-state evidence is incomplete", async () => {
    const entry = await fixture();
    const record = await entry.bind();
    await markBrowserCanonicalCtfRedeemTransportAttempted({
      seed: SEED,
      operationId: record.operation.operationId,
      adapter: entry.adapter,
      owner: { ...entry.owner, observedAtMs: 4 },
    });

    const result = await recover(
      entry,
      record.operation.operationId,
      {
        loadMint: async () => undefined,
        redeemOutcomeProofs: async () => {
          throw new Error("pending inputs must not redeem");
        },
        checkProofsStates: async () => [],
      },
      async () => {
        throw new Error("pending inputs must not restore");
      },
    );

    expect(result).toEqual({ kind: "pending" });
    expect(
      (await entry.adapter.readProof(entry.scope.scopeId, entry.proof.proofId))?.selectability,
    ).toBe("locked");
    expect(await entry.database.proofs.count()).toBe(0);
  });

  it("retries an exact prepared request when every input remains unspent", async () => {
    const entry = await fixture();
    const record = await entry.bind();
    const payout = await signedPayout(entry.adapter, entry.scope, record.operation.operationId);
    await markBrowserCanonicalCtfRedeemTransportAttempted({
      seed: SEED,
      operationId: record.operation.operationId,
      adapter: entry.adapter,
      owner: { ...entry.owner, observedAtMs: 4 },
    });
    let redeemCalls = 0;

    const result = await recover(
      entry,
      record.operation.operationId,
      {
        loadMint: async () => undefined,
        checkProofsStates: async () => [
          { Y: INPUT_Y, state: CheckStateEnum.UNSPENT, witness: null },
        ],
        redeemOutcomeProofs: async ({ inputs, outputs }) => {
          redeemCalls += 1;
          expect(inputs[0]?.witness).toBe('{"oracle_sig":"test"}');
          expect(outputs).toHaveLength(1);
          return payout;
        },
      },
      async () => {
        throw new Error("unspent inputs must not restore");
      },
    );

    expect(result.kind).toBe("redeemed");
    expect(redeemCalls).toBe(1);
    expect(
      (await entry.adapter.readProof(entry.scope.scopeId, entry.proof.proofId))?.selectability,
    ).toBe("spent");
  });

  it("submits the persisted request after a crash before the transport attempt", async () => {
    const entry = await fixture();
    const record = await entry.bind();
    const payout = await signedPayout(entry.adapter, entry.scope, record.operation.operationId);
    let observedState: string | undefined;

    const result = await recover(
      entry,
      record.operation.operationId,
      {
        loadMint: async () => undefined,
        checkProofsStates: async () => {
          throw new Error("unsubmitted inputs need no mint-state check");
        },
        redeemOutcomeProofs: async () => {
          observedState = (
            await entry.adapter.readOperation(entry.scope, record.operation.operationId)
          )?.operation.state;
          return payout;
        },
      },
      async () => {
        throw new Error("unsubmitted inputs must not restore");
      },
    );

    expect(observedState).toBe("transport-attempted");
    expect(result.kind).toBe("redeemed");
    expect(await entry.database.proofs.count()).toBe(1);
  });
});

function recover(
  entry: Awaited<ReturnType<typeof fixture>>,
  operationId: string,
  wallet: Parameters<typeof recoverBrowserCanonicalCtfRedeemOperation>[0]["wallet"],
  restoreOutputs: Parameters<typeof recoverBrowserCanonicalCtfRedeemOperation>[0]["restoreOutputs"],
) {
  return recoverBrowserCanonicalCtfRedeemOperation({
    seed: SEED,
    mintUrl: MINT,
    conditionId: CONDITION,
    outcomeCollection: OUTCOME,
    operationId,
    wallet,
    restoreOutputs,
    adapter: entry.adapter,
    owner: { ...entry.owner, observedAtMs: 5 },
    observedAtMs: 5,
  });
}

async function signedPayout(
  adapter: BrowserDurableCustodyAdapter,
  scope: ReturnType<typeof browserWalletScope>,
  operationId: string,
) {
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

function signOutput(output: OutputData) {
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
