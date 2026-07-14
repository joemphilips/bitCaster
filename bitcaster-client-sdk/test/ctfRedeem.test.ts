import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CheckStateEnum,
  hashToCurve,
  hashToCurveBls,
  isBlsKeyset,
  type MintKeys,
  type Proof,
  type ProofState,
} from "@cashu/cashu-ts";
import {
  buildKeysetRedeemOperationId,
  isLosingLegError,
  ORACLE_NOT_ATTESTED_OUTCOME_CODE,
  readVerifiedCtfLosingOutcomeEvidence,
  redeemOutcomeLegWithOperation,
  requireVerifiedCtfLosingOutcomeEvidence,
  type RedeemWallet,
} from "../src/ctfRedeem.ts";
import type {
  CtfPrepareProofOperationInput,
  CtfProofOperationRecord,
  CtfProofOperationStore,
} from "../src/ctfSplit.ts";

test("isLosingLegError recognizes the mint oracle-not-attested error code", () => {
  assert.equal(
    isLosingLegError({ code: ORACLE_NOT_ATTESTED_OUTCOME_CODE }),
    true,
  );
  assert.equal(isLosingLegError({ code: 13014 }), false);
  assert.equal(
    isLosingLegError(new Error("oracle not attested outcome")),
    false,
  );
  assert.equal(isLosingLegError(null), false);
});

test("buildKeysetRedeemOperationId is stable across proof ordering", () => {
  const left = buildKeysetRedeemOperationId("ABCDEF", "keyset", ["b", "a"]);
  const right = buildKeysetRedeemOperationId("abcdef", "keyset", ["a", "b"]);
  assert.equal(left, "ctf-redeem:abcdef:keyset:a|b");
  assert.equal(left, right);
});

test("redeemOutcomeLegWithOperation prepares, redeems, and marks completed", async () => {
  const store = new MemoryProofOperationStore();
  const inputProofs = [proof("ctf-keyset", "input-a", 7)];
  const settledProofs = [proof("regular-keyset", "regular-a", 7)];
  const wallet = new FakeRedeemWallet({ settledProofs });

  const result = await redeemOutcomeLegWithOperation({
    mintUrl: "https://mint.example",
    operationId: "redeem:success",
    wallet,
    proofOperationStore: store,
    conditionId: "condition",
    outcome: "YES",
    unit: "sat",
    oracleWitness: '{"attested":true}',
    proofs: inputProofs,
    regularKeyset: regularKeyset(),
    restoreOutputGroups: async () => {
      throw new Error("restore should not be called");
    },
  });

  assert.deepEqual(result, { proofs: settledProofs, losing: false });
  assert.equal(wallet.loadMintCalls, 1);
  assert.equal(wallet.redeemCalls.length, 1);
  assert.deepEqual(
    wallet.redeemCalls[0]?.inputs.map((input) => input.witness),
    ['{"attested":true}'],
  );
  const entry = await store.getProofOperation("redeem:success");
  assert.equal(entry?.kind, "ctf-redeem");
  assert.equal(entry?.state, "completed");
  assert.deepEqual(entry?.resultProofs?.regular, settledProofs);
  assert.equal(entry?.metadata.redeemRequestVersion, 1);
  assert.equal(entry?.metadata.oracleWitness, '{"attested":true}');
  assert.match(String(entry?.metadata.redeemRequestDigest), /^[0-9a-f]{64}$/);
});

test("redeemOutcomeLegWithOperation terminally records losing legs", async () => {
  const store = new MemoryProofOperationStore();
  const wallet = new FakeRedeemWallet({
    error: { code: ORACLE_NOT_ATTESTED_OUTCOME_CODE },
  });

  const result = await redeemOutcomeLegWithOperation({
    mintUrl: "https://mint.example",
    operationId: "redeem:losing",
    wallet,
    proofOperationStore: store,
    conditionId: "condition",
    outcome: "NO",
    unit: "sat",
    oracleWitness: "replacement-witness-must-not-be-used",
    proofs: [proof("ctf-keyset", "loser", 3)],
    regularKeyset: regularKeyset(),
    restoreOutputGroups: async () => ({}),
  });

  assert.deepEqual(result, { proofs: [], losing: true });
  const entry = await store.getProofOperation("redeem:losing");
  assert.equal(entry?.state, "failed");
  assert.equal(entry?.failureCode, ORACLE_NOT_ATTESTED_OUTCOME_CODE);
  const losingProof = proof("ctf-keyset", "loser", 3);
  const evidence = await readVerifiedCtfLosingOutcomeEvidence({
    store,
    operationId: "redeem:losing",
    proof: losingProof,
  });
  assert.equal(evidence.failureCode, ORACLE_NOT_ATTESTED_OUTCOME_CODE);
  assert.match(evidence.operationIdDigest, /^[0-9a-f]{64}$/);
  assert.equal(
    requireVerifiedCtfLosingOutcomeEvidence({
      evidence,
      operationId: "redeem:losing",
      mintUrl: "https://mint.example",
      conditionId: "condition",
      outcome: "NO",
      keysetId: "ctf-keyset",
      proof: losingProof,
    }),
    evidence,
  );
  assert.throws(
    () =>
      requireVerifiedCtfLosingOutcomeEvidence({
        evidence: { ...evidence },
        operationId: "redeem:losing",
        mintUrl: "https://mint.example",
        conditionId: "condition",
        outcome: "NO",
        keysetId: "ctf-keyset",
        proof: losingProof,
      }),
    /does not match proof/,
  );
});

test("terminal losing evidence rehydrates only from one exact committed callback", async () => {
  const store = new MemoryProofOperationStore();
  const losingProof = proof("ctf-keyset", "restart-loser", 3);
  await redeemOutcomeLegWithOperation({
    mintUrl: "https://mint.example",
    operationId: "redeem:restart-loser",
    wallet: new FakeRedeemWallet({
      error: { code: ORACLE_NOT_ATTESTED_OUTCOME_CODE },
    }),
    proofOperationStore: store,
    conditionId: "condition",
    outcome: "NO",
    unit: "sat",
    oracleWitness: "witness",
    proofs: [losingProof],
    regularKeyset: regularKeyset(),
  });
  const first = await readVerifiedCtfLosingOutcomeEvidence({
    store,
    operationId: "redeem:restart-loser",
    proof: losingProof,
  });
  const restarted = new MemoryProofOperationStore();
  restarted.records.set(
    "redeem:restart-loser",
    structuredClone(store.records.get("redeem:restart-loser")!),
  );
  const rehydrated = await readVerifiedCtfLosingOutcomeEvidence({
    store: restarted,
    operationId: "redeem:restart-loser",
    proof: losingProof,
  });
  assert.notEqual(rehydrated, first);
  assert.deepEqual(rehydrated, first);

  const corrupt = new MemoryProofOperationStore();
  const corruptRecord = structuredClone(
    store.records.get("redeem:restart-loser")!,
  );
  delete corruptRecord.metadata.redeemMintSubmissionRequestDigest;
  corrupt.records.set("redeem:restart-loser", corruptRecord);
  await assert.rejects(
    () =>
      readVerifiedCtfLosingOutcomeEvidence({
        store: corrupt,
        operationId: "redeem:restart-loser",
        proof: losingProof,
      }),
    /mint submission binding/,
  );

  const operation = structuredClone(
    store.records.get("redeem:restart-loser")!,
  );
  await assert.rejects(
    () =>
      readVerifiedCtfLosingOutcomeEvidence({
        store: {
          async withCommittedProofOperation(_operationId, read) {
            return structuredClone(read(operation));
          },
        },
        operationId: "redeem:restart-loser",
        proof: losingProof,
      }),
    /synchronous and exact/,
  );
  await assert.rejects(
    () =>
      readVerifiedCtfLosingOutcomeEvidence({
        store: {
          async withCommittedProofOperation(_operationId, read) {
            const result = read(operation);
            read(operation);
            return result;
          },
        },
        operationId: "redeem:restart-loser",
        proof: losingProof,
      }),
    /callback is invalid/,
  );
  let lateRead:
    | ((operation: CtfProofOperationRecord) => unknown)
    | undefined;
  await readVerifiedCtfLosingOutcomeEvidence({
    store: {
      async withCommittedProofOperation(_operationId, read) {
        lateRead = read;
        return read(operation);
      },
    },
    operationId: "redeem:restart-loser",
    proof: losingProof,
  });
  assert.throws(() => lateRead!(operation), /callback is invalid/);
});

test("redeemOutcomeLegWithOperation resumes a terminal losing callback after callback failure", async () => {
  const store = new MemoryProofOperationStore();
  const inputs = [proof("ctf-keyset", "losing-callback", 3)];
  let callbackCalls = 0;

  await assert.rejects(
    () =>
      redeemOutcomeLegWithOperation({
        mintUrl: "https://mint.example",
        operationId: "redeem:losing-callback",
        wallet: new FakeRedeemWallet({
          error: { code: ORACLE_NOT_ATTESTED_OUTCOME_CODE },
        }),
        proofOperationStore: store,
        conditionId: "condition",
        outcome: "NO",
        unit: "sat",
        oracleWitness: "exact-witness",
        proofs: inputs,
        regularKeyset: regularKeyset(),
        onLosingLeg: async () => {
          callbackCalls += 1;
          throw new Error("crash after durable terminal classification");
        },
      }),
    /crash after durable terminal classification/,
  );
  assert.equal(
    (await store.getProofOperation("redeem:losing-callback"))?.failureCode,
    ORACLE_NOT_ATTESTED_OUTCOME_CODE,
  );

  const offlineWallet = new FakeRedeemWallet({
    loadError: new Error("mint unavailable"),
  });
  const result = await redeemOutcomeLegWithOperation({
    mintUrl: "https://mint.example",
    operationId: "redeem:losing-callback",
    wallet: offlineWallet,
    proofOperationStore: store,
    conditionId: "condition",
    outcome: "NO",
    unit: "sat",
    oracleWitness: "replacement-witness-must-not-be-used",
    proofs: inputs,
    regularKeyset: regularKeyset(),
    onLosingLeg: async () => {
      callbackCalls += 1;
    },
  });

  assert.deepEqual(result, { proofs: [], losing: true });
  assert.equal(callbackCalls, 2);
  assert.equal(offlineWallet.loadMintCalls, 0);
});

test("local submission failure code 13015 cannot condemn a CTF proof", async () => {
  const store = new MemoryProofOperationStore();
  store.markProofOperationMintSubmitted = async () => {
    throw { code: ORACLE_NOT_ATTESTED_OUTCOME_CODE };
  };
  const wallet = new FakeRedeemWallet();
  let losingCalls = 0;
  await assert.rejects(
    () =>
      redeemOutcomeLegWithOperation({
        mintUrl: "https://mint.example",
        operationId: "redeem:local-submit-error",
        wallet,
        proofOperationStore: store,
        conditionId: "condition",
        outcome: "NO",
        unit: "sat",
        oracleWitness: "witness",
        proofs: [proof("ctf-keyset", "local-submit-error", 3)],
        regularKeyset: regularKeyset(),
        onLosingLeg: async () => {
          losingCalls += 1;
        },
      }),
    (error) => isLosingLegError(error),
  );
  assert.equal(wallet.redeemCalls.length, 0);
  assert.equal(losingCalls, 0);
  assert.equal(
    (await store.getProofOperation("redeem:local-submit-error"))?.state,
    "prepared",
  );
});

test("CTF redeem does not call the mint when storage drops the submission binding", async () => {
  const store = new MemoryProofOperationStore();
  const persistWithoutBinding =
    store.markProofOperationMintSubmitted.bind(store);
  store.markProofOperationMintSubmitted = async (operationId) =>
    persistWithoutBinding(operationId);
  const wallet = new FakeRedeemWallet();
  await assert.rejects(
    () =>
      redeemOutcomeLegWithOperation({
        mintUrl: "https://mint.example",
        operationId: "redeem:dropped-submission-binding",
        wallet,
        proofOperationStore: store,
        conditionId: "condition",
        outcome: "YES",
        unit: "sat",
        oracleWitness: "witness",
        proofs: [proof("ctf-keyset", "dropped-submission-binding", 3)],
        regularKeyset: regularKeyset(),
      }),
    /mint submission was not committed exactly/,
  );
  assert.equal(wallet.redeemCalls.length, 0);
});

test("CTF redeem does not condemn proofs when storage drops the terminal failure", async () => {
  const store = new MemoryProofOperationStore();
  store.markProofOperationFailed = async (operationId) => {
    const operation = await store.getProofOperation(operationId);
    if (!operation) throw new Error(`missing operation ${operationId}`);
    return operation;
  };
  const wallet = new FakeRedeemWallet({
    error: { code: ORACLE_NOT_ATTESTED_OUTCOME_CODE },
  });
  let losingCalls = 0;
  await assert.rejects(
    () =>
      redeemOutcomeLegWithOperation({
        mintUrl: "https://mint.example",
        operationId: "redeem:dropped-terminal-failure",
        wallet,
        proofOperationStore: store,
        conditionId: "condition",
        outcome: "NO",
        unit: "sat",
        oracleWitness: "witness",
        proofs: [proof("ctf-keyset", "dropped-terminal-failure", 3)],
        regularKeyset: regularKeyset(),
        onLosingLeg: async () => {
          losingCalls += 1;
        },
      }),
    /terminal failure was not committed exactly/,
  );
  assert.equal(wallet.redeemCalls.length, 1);
  assert.equal(losingCalls, 0);
  assert.equal(
    (await store.getProofOperation("redeem:dropped-terminal-failure"))?.state,
    "mint-submitted",
  );
});

test("CTF redeem does not report success when storage drops the completion", async () => {
  const store = new MemoryProofOperationStore();
  store.markProofOperationCompleted = async (operationId) => {
    const operation = await store.getProofOperation(operationId);
    if (!operation) throw new Error(`missing operation ${operationId}`);
    return operation;
  };
  await assert.rejects(
    () =>
      redeemOutcomeLegWithOperation({
        mintUrl: "https://mint.example",
        operationId: "redeem:dropped-completion",
        wallet: new FakeRedeemWallet({
          settledProofs: [proof("regular-keyset", "successor", 3)],
        }),
        proofOperationStore: store,
        conditionId: "condition",
        outcome: "YES",
        unit: "sat",
        oracleWitness: "witness",
        proofs: [proof("ctf-keyset", "dropped-completion", 3)],
        regularKeyset: regularKeyset(),
      }),
    /completion was not committed exactly/,
  );
  assert.equal(
    (await store.getProofOperation("redeem:dropped-completion"))?.state,
    "mint-submitted",
  );
});

test("local completion failure code 13015 preserves mint-submitted recovery", async () => {
  const store = new MemoryProofOperationStore();
  store.markProofOperationCompleted = async () => {
    throw { code: ORACLE_NOT_ATTESTED_OUTCOME_CODE };
  };
  let losingCalls = 0;
  await assert.rejects(
    () =>
      redeemOutcomeLegWithOperation({
        mintUrl: "https://mint.example",
        operationId: "redeem:local-completion-error",
        wallet: new FakeRedeemWallet({
          settledProofs: [proof("regular-keyset", "successor", 3)],
        }),
        proofOperationStore: store,
        conditionId: "condition",
        outcome: "YES",
        unit: "sat",
        oracleWitness: "witness",
        proofs: [proof("ctf-keyset", "local-completion-error", 3)],
        regularKeyset: regularKeyset(),
        onLosingLeg: async () => {
          losingCalls += 1;
        },
      }),
    (error) => isLosingLegError(error),
  );
  const operation = await store.getProofOperation(
    "redeem:local-completion-error",
  );
  assert.equal(operation?.state, "mint-submitted");
  assert.equal(operation?.failureCode, undefined);
  assert.equal(losingCalls, 0);
});

test("persisted losing CTF rows require the exact mint-submission binding", async () => {
  const store = new MemoryProofOperationStore();
  const inputs = [proof("ctf-keyset", "invalid-terminal-binding", 3)];
  await redeemOutcomeLegWithOperation({
    mintUrl: "https://mint.example",
    operationId: "redeem:invalid-terminal-binding",
    wallet: new FakeRedeemWallet({
      error: { code: ORACLE_NOT_ATTESTED_OUTCOME_CODE },
    }),
    proofOperationStore: store,
    conditionId: "condition",
    outcome: "NO",
    unit: "sat",
    oracleWitness: "witness",
    proofs: inputs,
    regularKeyset: regularKeyset(),
  });
  const corrupt = structuredClone(
    store.records.get("redeem:invalid-terminal-binding")!,
  );
  delete corrupt.metadata.redeemMintSubmissionRequestDigest;
  store.records.set(corrupt.operationId, corrupt);
  let losingCalls = 0;
  const wallet = new FakeRedeemWallet({
    loadError: new Error("mint must not be loaded"),
  });
  await assert.rejects(
    () =>
      redeemOutcomeLegWithOperation({
        mintUrl: "https://mint.example",
        operationId: corrupt.operationId,
        wallet,
        proofOperationStore: store,
        conditionId: "condition",
        outcome: "NO",
        unit: "sat",
        oracleWitness: "replacement",
        proofs: inputs,
        regularKeyset: regularKeyset(),
        onLosingLeg: async () => {
          losingCalls += 1;
        },
      }),
    /terminal failure was not committed exactly/,
  );
  assert.equal(losingCalls, 0);
  assert.equal(wallet.loadMintCalls, 0);
});

test("redeemOutcomeLegWithOperation restores outputs when prepared inputs are spent", async () => {
  const store = new MemoryProofOperationStore();
  const inputs = [proof("ctf-keyset", "spent-input", 5)];
  const restored = [proof("regular-keyset", "restored", 5)];
  const wallet = new FakeRedeemWallet({
    states: [state(CheckStateEnum.SPENT)],
  });

  await redeemOutcomeLegWithOperation({
    mintUrl: "https://mint.example",
    operationId: "redeem:restore",
    wallet: new FakeRedeemWallet({ error: new Error("crash after mint") }),
    proofOperationStore: store,
    conditionId: "condition",
    outcome: "YES",
    unit: "sat",
    oracleWitness: "witness",
    proofs: inputs,
    regularKeyset: regularKeyset(),
    restoreOutputGroups: async () => ({}),
  }).catch(() => undefined);

  const result = await redeemOutcomeLegWithOperation({
    mintUrl: "https://mint.example",
    operationId: "redeem:restore",
    wallet,
    proofOperationStore: store,
    conditionId: "condition",
    outcome: "YES",
    unit: "sat",
    oracleWitness: "witness",
    proofs: inputs,
    regularKeyset: regularKeyset(),
    restoreOutputGroups: async () => ({ regular: restored }),
  });

  assert.deepEqual(result, { proofs: restored, losing: false });
  assert.equal(wallet.redeemCalls.length, 0);
  assert.equal(
    (await store.getProofOperation("redeem:restore"))?.state,
    "completed",
  );
});

test("spent-input recovery does not report success when completion is not committed", async () => {
  const store = new MemoryProofOperationStore();
  const inputs = [proof("ctf-keyset", "spent-without-completion", 5)];
  await redeemOutcomeLegWithOperation({
    mintUrl: "https://mint.example",
    operationId: "redeem:spent-without-completion",
    wallet: new FakeRedeemWallet({ error: new Error("crash after mint") }),
    proofOperationStore: store,
    conditionId: "condition",
    outcome: "YES",
    unit: "sat",
    oracleWitness: "witness",
    proofs: inputs,
    regularKeyset: regularKeyset(),
  }).catch(() => undefined);
  store.markProofOperationCompleted = async (operationId) => {
    const operation = await store.getProofOperation(operationId);
    if (!operation) throw new Error(`missing operation ${operationId}`);
    return operation;
  };
  await assert.rejects(
    () =>
      redeemOutcomeLegWithOperation({
        mintUrl: "https://mint.example",
        operationId: "redeem:spent-without-completion",
        wallet: new FakeRedeemWallet({
          states: [state(CheckStateEnum.SPENT)],
        }),
        proofOperationStore: store,
        conditionId: "condition",
        outcome: "YES",
        unit: "sat",
        oracleWitness: "replacement",
        proofs: inputs,
        regularKeyset: regularKeyset(),
        restoreOutputGroups: async () => ({
          regular: [proof("regular-keyset", "restored-successor", 5)],
        }),
      }),
    /completion was not committed exactly/,
  );
});

test("CTF redeem recovery rejects unknown persisted states before external ports", async () => {
  const store = new MemoryProofOperationStore();
  const inputs = [proof("ctf-keyset", "unknown-operation-state", 5)];
  await redeemOutcomeLegWithOperation({
    mintUrl: "https://mint.example",
    operationId: "redeem:unknown-operation-state",
    wallet: new FakeRedeemWallet({ error: new Error("transient") }),
    proofOperationStore: store,
    conditionId: "condition",
    outcome: "YES",
    unit: "sat",
    oracleWitness: "witness",
    proofs: inputs,
    regularKeyset: regularKeyset(),
  }).catch(() => undefined);
  const corrupt = store.records.get("redeem:unknown-operation-state")!;
  store.records.set(corrupt.operationId, {
    ...corrupt,
    state: "unknown" as CtfProofOperationRecord["state"],
  });
  const wallet = new FakeRedeemWallet({
    loadError: new Error("mint must not be loaded"),
  });
  await assert.rejects(
    () =>
      redeemOutcomeLegWithOperation({
        mintUrl: "https://mint.example",
        operationId: corrupt.operationId,
        wallet,
        proofOperationStore: store,
        conditionId: "condition",
        outcome: "YES",
        unit: "sat",
        oracleWitness: "replacement",
        proofs: inputs,
        regularKeyset: regularKeyset(),
      }),
    /operation state is invalid/,
  );
  assert.equal(wallet.loadMintCalls, 0);
  assert.equal(wallet.redeemCalls.length, 0);
});

test("CTF redeem recovery requires one exact proof-state row per input", async (t) => {
  const inputs = [
    proof("ctf-keyset", "proof-state-a", 2),
    proof("ctf-keyset", "proof-state-b", 3),
  ];
  const firstY = proofStateY(inputs[0]!);
  const cases: ReadonlyArray<Readonly<{ name: string; states: ProofState[] }>> = [
    {
      name: "partial",
      states: [state(CheckStateEnum.SPENT)],
    },
    {
      name: "duplicate",
      states: [
        { ...state(CheckStateEnum.SPENT), Y: firstY },
        { ...state(CheckStateEnum.SPENT), Y: firstY },
      ],
    },
    {
      name: "foreign",
      states: [
        { ...state(CheckStateEnum.SPENT), Y: firstY },
        { ...state(CheckStateEnum.SPENT), Y: "foreign-proof-state" },
      ],
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const store = new MemoryProofOperationStore();
      const operationId = `redeem:proof-state-${scenario.name}`;
      await redeemOutcomeLegWithOperation({
        mintUrl: "https://mint.example",
        operationId,
        wallet: new FakeRedeemWallet({ error: new Error("transient") }),
        proofOperationStore: store,
        conditionId: "condition",
        outcome: "YES",
        unit: "sat",
        oracleWitness: "witness",
        proofs: inputs,
        regularKeyset: regularKeyset(),
      }).catch(() => undefined);
      const wallet = new FakeRedeemWallet({ states: scenario.states });
      let restoreCalls = 0;
      await assert.rejects(
        () =>
          redeemOutcomeLegWithOperation({
            mintUrl: "https://mint.example",
            operationId,
            wallet,
            proofOperationStore: store,
            conditionId: "condition",
            outcome: "YES",
            unit: "sat",
            oracleWitness: "replacement",
            proofs: inputs,
            regularKeyset: regularKeyset(),
            restoreOutputGroups: async () => {
              restoreCalls += 1;
              return {};
            },
          }),
        /proof-state response is invalid/,
      );
      assert.equal(restoreCalls, 0);
      assert.equal(wallet.redeemCalls.length, 0);
    });
  }
});

test("completed CTF redeem replays locally while the mint is unavailable", async () => {
  const store = new MemoryProofOperationStore();
  const inputs = [proof("ctf-keyset", "completed-offline", 5)];
  const settled = [proof("regular-keyset", "completed-successor", 5)];
  await redeemOutcomeLegWithOperation({
    mintUrl: "https://mint.example",
    operationId: "redeem:completed-offline",
    wallet: new FakeRedeemWallet({ settledProofs: settled }),
    proofOperationStore: store,
    conditionId: "condition",
    outcome: "YES",
    unit: "sat",
    oracleWitness: "witness",
    proofs: inputs,
    regularKeyset: regularKeyset(),
  });
  const offlineWallet = new FakeRedeemWallet({
    loadError: new Error("mint unavailable"),
  });
  const result = await redeemOutcomeLegWithOperation({
    mintUrl: "https://mint.example",
    operationId: "redeem:completed-offline",
    wallet: offlineWallet,
    proofOperationStore: store,
    conditionId: "condition",
    outcome: "YES",
    unit: "sat",
    oracleWitness: "replacement-witness-must-not-be-used",
    proofs: inputs,
    regularKeyset: regularKeyset(),
  });
  assert.deepEqual(result, { proofs: settled, losing: false });
  assert.equal(offlineWallet.loadMintCalls, 0);
});

test("redeemOutcomeLegWithOperation re-executes prepared operations when inputs remain unspent", async () => {
  const store = new MemoryProofOperationStore();
  const inputs = [proof("ctf-keyset", "unspent-input", 5)];

  await redeemOutcomeLegWithOperation({
    mintUrl: "https://mint.example",
    operationId: "redeem:retry",
    wallet: new FakeRedeemWallet({ error: new Error("transient") }),
    proofOperationStore: store,
    conditionId: "condition",
    outcome: "YES",
    unit: "sat",
    oracleWitness: "witness",
    proofs: inputs,
    regularKeyset: regularKeyset(),
    restoreOutputGroups: async () => ({}),
  }).catch(() => undefined);

  const settledProofs = [proof("regular-keyset", "retried", 5)];
  const wallet = new FakeRedeemWallet({
    states: [state(CheckStateEnum.UNSPENT)],
    settledProofs,
  });
  const result = await redeemOutcomeLegWithOperation({
    mintUrl: "https://mint.example",
    operationId: "redeem:retry",
    wallet,
    proofOperationStore: store,
    conditionId: "condition",
    outcome: "YES",
    unit: "sat",
    oracleWitness: "replacement-witness-must-not-be-used",
    proofs: inputs,
    regularKeyset: regularKeyset(),
    restoreOutputGroups: async () => ({}),
  });

  assert.deepEqual(result, { proofs: settledProofs, losing: false });
  assert.equal(wallet.redeemCalls.length, 1);
  assert.deepEqual(
    wallet.redeemCalls[0]?.inputs.map((input) => input.witness),
    ["witness"],
  );
});

test("redeemOutcomeLegWithOperation rejects a restart on a different mint transport", async () => {
  const store = new MemoryProofOperationStore();
  const inputs = [proof("ctf-keyset", "mint-bound", 5)];
  await redeemOutcomeLegWithOperation({
    mintUrl: "https://mint.example",
    operationId: "redeem:mint-bound",
    wallet: new FakeRedeemWallet({ error: new Error("transient") }),
    proofOperationStore: store,
    conditionId: "condition",
    outcome: "YES",
    unit: "sat",
    oracleWitness: "witness",
    proofs: inputs,
    regularKeyset: regularKeyset(),
  }).catch(() => undefined);
  const wrongWallet = new FakeRedeemWallet({
    mintUrl: "https://other-mint.example",
    states: [state(CheckStateEnum.UNSPENT)],
  });

  await assert.rejects(
    () =>
      redeemOutcomeLegWithOperation({
        mintUrl: "https://other-mint.example",
        operationId: "redeem:mint-bound",
        wallet: wrongWallet,
        proofOperationStore: store,
        conditionId: "condition",
        outcome: "YES",
        unit: "sat",
        oracleWitness: "witness",
        proofs: inputs,
        regularKeyset: regularKeyset(),
      }),
    /mint does not match persisted operation/,
  );
  assert.equal(wrongWallet.loadMintCalls, 0);
  assert.equal(wrongWallet.redeemCalls.length, 0);
});

test("redeemOutcomeLegWithOperation rejects a corrupted persisted request binding", async () => {
  const store = new MemoryProofOperationStore();
  const inputs = [proof("ctf-keyset", "bound-input", 5)];
  await redeemOutcomeLegWithOperation({
    mintUrl: "https://mint.example",
    operationId: "redeem:corrupt-binding",
    wallet: new FakeRedeemWallet({ error: new Error("transient") }),
    proofOperationStore: store,
    conditionId: "condition",
    outcome: "YES",
    unit: "sat",
    oracleWitness: "exact-witness",
    proofs: inputs,
    regularKeyset: regularKeyset(),
  }).catch(() => undefined);
  const row = store.records.get("redeem:corrupt-binding")!;
  store.records.set("redeem:corrupt-binding", {
    ...row,
    metadata: { ...row.metadata, redeemRequestDigest: "00".repeat(32) },
  });
  const wallet = new FakeRedeemWallet({
    states: [state(CheckStateEnum.UNSPENT)],
  });
  await assert.rejects(
    () =>
      redeemOutcomeLegWithOperation({
        mintUrl: "https://mint.example",
        operationId: "redeem:corrupt-binding",
        wallet,
        proofOperationStore: store,
        conditionId: "condition",
        outcome: "YES",
        unit: "sat",
        oracleWitness: "exact-witness",
        proofs: inputs,
        regularKeyset: regularKeyset(),
      }),
    /request binding/,
  );
  assert.equal(wallet.redeemCalls.length, 0);
});

test("redeemOutcomeLegWithOperation refuses non-losing failed records", async () => {
  const store = new MemoryProofOperationStore();
  await redeemOutcomeLegWithOperation({
    mintUrl: "https://mint.example",
    operationId: "redeem:failed",
    wallet: new FakeRedeemWallet({ error: new Error("transient") }),
    proofOperationStore: store,
    conditionId: "condition",
    outcome: "YES",
    unit: "sat",
    oracleWitness: "witness",
    proofs: [proof("ctf-keyset", "input", 1)],
    regularKeyset: regularKeyset(),
  }).catch(() => undefined);
  await store.markProofOperationFailed?.("redeem:failed", "boom", 999);

  await assert.rejects(
    () =>
      redeemOutcomeLegWithOperation({
        mintUrl: "https://mint.example",
        operationId: "redeem:failed",
        wallet: new FakeRedeemWallet(),
        proofOperationStore: store,
        conditionId: "condition",
        outcome: "YES",
        unit: "sat",
        oracleWitness: "witness",
        proofs: [proof("ctf-keyset", "input", 1)],
        regularKeyset: regularKeyset(),
        restoreOutputGroups: async () => ({}),
      }),
    /non-losing failure code 999/,
  );
});

function proof(id: string, secret: string, amount: number): Proof {
  return { id, secret, amount, C: `C-${secret}` } as Proof;
}

function state(value: CheckStateEnum): ProofState {
  return { Y: "", state: value, witness: null };
}

function proofStateY(input: Pick<Proof, "id" | "secret">): string {
  const secret = new TextEncoder().encode(input.secret);
  return isBlsKeyset(input.id)
    ? hashToCurveBls(secret).toHex(true)
    : hashToCurve(secret).toHex(true);
}

function regularKeyset(): MintKeys {
  return {
    id: "regular-keyset",
    unit: "sat",
    active: true,
    input_fee_ppk: 0,
    keys: { 1: "02".repeat(33), 2: "03".repeat(33), 4: "04".repeat(33) },
  } as unknown as MintKeys;
}

class FakeRedeemWallet implements RedeemWallet {
  readonly mint: RedeemWallet["mint"];
  loadMintCalls = 0;
  redeemCalls: Array<{ inputs: Proof[]; outputs: unknown[] }> = [];
  private readonly script: {
    settledProofs?: Proof[];
    states?: ProofState[];
    error?: unknown;
    loadError?: unknown;
  };

  constructor(
    script: {
      settledProofs?: Proof[];
      states?: ProofState[];
      error?: unknown;
      mintUrl?: string;
      loadError?: unknown;
    } = {},
  ) {
    this.script = script;
    this.mint = {
      mintUrl: script.mintUrl ?? "https://mint.example",
      async getKeys() {
        return { keysets: [regularKeyset()] };
      },
    };
  }

  async loadMint(): Promise<void> {
    this.loadMintCalls += 1;
    if (this.script.loadError) throw this.script.loadError;
  }

  async redeemOutcomeProofs(options: {
    inputs: Proof[];
    outputs: unknown[];
  }): Promise<Proof[]> {
    this.redeemCalls.push(options);
    if (this.script.error) throw this.script.error;
    return this.script.settledProofs ?? [];
  }

  async checkProofsStates(
    proofs: Array<Pick<Proof, "id" | "secret">>,
  ): Promise<ProofState[]> {
    return (this.script.states ?? []).map((state, index) =>
      state.Y === "" && proofs[index] !== undefined
        ? { ...state, Y: proofStateY(proofs[index]!) }
        : state,
    );
  }
}

class MemoryProofOperationStore implements CtfProofOperationStore {
  readonly records = new Map<string, CtfProofOperationRecord>();

  async getProofOperation(
    operationId: string,
  ): Promise<CtfProofOperationRecord | null> {
    return this.records.get(operationId) ?? null;
  }

  async prepareProofOperation(
    input: CtfPrepareProofOperationInput,
  ): Promise<CtfProofOperationRecord> {
    const record: CtfProofOperationRecord = {
      ...input,
      state: "prepared",
      createdAt: 1,
      updatedAt: 1,
    };
    this.records.set(input.operationId, record);
    return record;
  }

  async markProofOperationMintSubmitted(
    operationId: string,
    redeemBinding?: { schemaVersion: 1; requestDigest: string },
  ): Promise<CtfProofOperationRecord> {
    const existing = this.records.get(operationId);
    if (!existing) throw new Error(`missing operation ${operationId}`);
    const submitted: CtfProofOperationRecord = {
      ...existing,
      state: "mint-submitted",
      metadata:
        redeemBinding === undefined
          ? existing.metadata
          : {
              ...existing.metadata,
              redeemMintSubmissionVersion: redeemBinding.schemaVersion,
              redeemMintSubmissionRequestDigest: redeemBinding.requestDigest,
            },
      updatedAt: existing.updatedAt + 1,
    };
    this.records.set(operationId, submitted);
    return submitted;
  }

  async markProofOperationCompleted(
    operationId: string,
    resultProofs: Record<string, Proof[]>,
  ): Promise<CtfProofOperationRecord> {
    const existing = this.records.get(operationId);
    if (!existing) throw new Error(`missing operation ${operationId}`);
    const completed: CtfProofOperationRecord = {
      ...existing,
      state: "completed",
      resultProofs,
      updatedAt: existing.updatedAt + 1,
    };
    this.records.set(operationId, completed);
    return completed;
  }

  async markProofOperationFailed(
    operationId: string,
    message: string,
    failureCode?: number,
  ): Promise<CtfProofOperationRecord> {
    const existing = this.records.get(operationId);
    if (!existing) throw new Error(`missing operation ${operationId}`);
    const failed: CtfProofOperationRecord = {
      ...existing,
      state: "failed",
      lastError: message,
      failureCode,
      updatedAt: existing.updatedAt + 1,
    };
    this.records.set(operationId, failed);
    return failed;
  }

  async withCommittedProofOperation<T>(
    operationId: string,
    read: (operation: CtfProofOperationRecord) => T,
  ): Promise<T> {
    const operation = this.records.get(operationId);
    if (!operation) throw new Error(`missing operation ${operationId}`);
    return read(structuredClone(operation));
  }
}
