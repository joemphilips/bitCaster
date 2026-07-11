import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CheckStateEnum,
  Wallet as CashuWallet,
  type ProofState,
} from "@cashu/cashu-ts";
import {
  DURABLE_TRADE_SESSION_SCHEMA_VERSION,
  createDurableTradeProofOperationLink,
  type DurableTradeSession,
} from "@bitcaster-market/client-sdk/durableTradeRecovery";
import { recoverDaemonDurableTradeSessions } from "../src/durableTradeRecovery.ts";
import {
  emptyDaemonState,
  prepareProofOperation,
  readState,
  updateState,
  writeState,
} from "../src/state.ts";

test("daemon durable recovery resumes only the retained persisted operation after restart", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "bitcaster-daemon-durable-recovery-"),
  );
  const previousHome = process.env.BITCASTER_DAEMON_HOME;
  process.env.BITCASTER_DAEMON_HOME = home;
  const originalLoadMint = CashuWallet.prototype.loadMint;
  const originalCheckProofsStates = CashuWallet.prototype.checkProofsStates;
  try {
    const operationKey = "trade-durable/seller-lock";
    const operation = createDurableTradeProofOperationLink({
      tradeId: "trade-durable",
      role: "seller",
      stage: "proof-reservation",
      state: "prepared",
      operationKey,
      kind: "cashu-atomic",
    });
    const session: DurableTradeSession = {
      schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
      revision: 0,
      tradeId: operation.tradeId,
      role: operation.role,
      localProtocolPubkey: "a".repeat(64),
      counterpartyProtocolPubkey: "b".repeat(64),
      mintUrl: "https://mint.example",
      sellerLocktimeSecs: 120,
      buyerLocktimeSecs: 100,
      ephemeralKeyHandle: {
        keyId: "ephemeral-durable",
        tradeId: operation.tradeId,
        role: operation.role,
        localProtocolPubkey: "a".repeat(64),
        counterpartyProtocolPubkey: "b".repeat(64),
        mintUrl: "https://mint.example",
        sellerLocktimeSecs: 120,
        buyerLocktimeSecs: 100,
      },
      stage: "proof-reserved",
      proofOperations: [operation],
      receivedCiphers: {},
      outboundCiphers: {},
    };
    const state = emptyDaemonState();
    state.durableTradeSessions[session.tradeId] = session;
    state.proofOperations[operationKey] = {
      operationId: operationKey,
      durableTradeRecovery: operation,
      kind: "swap-lock",
      state: "prepared",
      mintUrl: session.mintUrl,
      inputs: [
        {
          id: "keyset-1",
          amount: 1,
          secret: "persisted-input",
          C: "02".padEnd(66, "1"),
        },
      ],
      outputs: {},
      metadata: { unit: "sat" },
      createdAt: 1,
      updatedAt: 1,
    };
    await writeState(state);
    CashuWallet.prototype.loadMint = async () => undefined;
    CashuWallet.prototype.checkProofsStates = async () =>
      [{ state: CheckStateEnum.UNSPENT }] as ProofState[];
    const resumed: string[] = [];

    const recovery = await recoverDaemonDurableTradeSessions({
      executor: {
        async resumeDurableProofOperation(key: string) {
          resumed.push(key);
          await updateState((current) => {
            current.proofOperations[key]!.state = "completed";
          });
        },
      } as never,
      connection: {
        async joinTrade() {},
        async sendSwapMessage() {},
      } as never,
    });

    assert.deepEqual(resumed, [operationKey]);
    assert.deepEqual(recovery.sessions, [
      { kind: "ready", tradeId: operation.tradeId },
    ]);
    const persisted = await readState();
    assert.equal(
      persisted?.proofOperations[operationKey]?.durableTradeRecovery?.state,
      "reconciled",
    );
    assert.equal(
      persisted?.durableTradeSessions[session.tradeId]?.stage,
      "reconciliation-complete",
    );
    assert.equal(
      persisted?.durableTradeSessions[session.tradeId]?.proofOperations[0]?.state,
      "reconciled",
    );
    assert.equal(
      persisted?.durableTradeSessions[session.tradeId]?.revision,
      2,
    );
  } finally {
    CashuWallet.prototype.loadMint = originalLoadMint;
    CashuWallet.prototype.checkProofsStates = originalCheckProofsStates;
    await rm(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME;
    else process.env.BITCASTER_DAEMON_HOME = previousHome;
  }
});

test("daemon durable recovery fails an invalid link before it can resume or send", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "bitcaster-daemon-invalid-durable-recovery-"),
  );
  const previousHome = process.env.BITCASTER_DAEMON_HOME;
  process.env.BITCASTER_DAEMON_HOME = home;
  try {
    const valid = createDurableTradeProofOperationLink({
      tradeId: "trade-invalid",
      role: "seller",
      stage: "proof-reservation",
      state: "prepared",
      operationKey: "trade-invalid/seller-lock",
      kind: "cashu-atomic",
    });
    const state = emptyDaemonState();
    state.proofOperations[valid.operationKey!] = {
      operationId: valid.operationKey!,
      durableTradeRecovery: {
        ...valid,
        state: "not-a-durable-state",
      } as typeof valid,
      kind: "swap-lock",
      state: "prepared",
      mintUrl: "https://mint.example",
      inputs: [],
      outputs: {},
      metadata: { unit: "sat" },
      createdAt: 1,
      updatedAt: 1,
    };
    await writeState(state);
    let exactResumes = 0;
    let sentMessages = 0;

    const recovery = await recoverDaemonDurableTradeSessions({
      executor: {
        async resumeDurableProofOperation() {
          exactResumes += 1;
        },
      } as never,
      connection: {
        async joinTrade() {
          sentMessages += 1;
        },
        async sendSwapMessage() {
          sentMessages += 1;
        },
      } as never,
    });

    assert.deepEqual(recovery.sessions, []);
    assert.deepEqual(recovery.orphans, [{
      kind: "failed-closed",
      operationId: valid.operationId,
      reason: "invalid-operation",
    }]);
    assert.equal(exactResumes, 0);
    assert.equal(sentMessages, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME;
    else process.env.BITCASTER_DAEMON_HOME = previousHome;
  }
});

test("daemon refuses a durable proof link before its TradeCreated session exists", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "bitcaster-daemon-unbound-durable-operation-"),
  );
  const previousHome = process.env.BITCASTER_DAEMON_HOME;
  process.env.BITCASTER_DAEMON_HOME = home;
  try {
    const operation = createDurableTradeProofOperationLink({
      tradeId: "trade-unbound",
      role: "seller",
      stage: "proof-reservation",
      state: "prepared",
      operationKey: "trade-unbound/seller-lock",
      kind: "cashu-atomic",
    });

    await assert.rejects(
      () => prepareProofOperation({
        operationId: operation.operationKey!,
        durableTradeRecovery: operation,
        kind: "swap-lock",
        mintUrl: "https://mint.example",
        inputs: [],
        outputs: {},
      }),
      /has no durable trade session/,
    );
    assert.equal(await readState(), null);
  } finally {
    await rm(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME;
    else process.env.BITCASTER_DAEMON_HOME = previousHome;
  }
});
