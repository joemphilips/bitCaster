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
  } finally {
    CashuWallet.prototype.loadMint = originalLoadMint;
    CashuWallet.prototype.checkProofsStates = originalCheckProofsStates;
    await rm(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME;
    else process.env.BITCASTER_DAEMON_HOME = previousHome;
  }
});
